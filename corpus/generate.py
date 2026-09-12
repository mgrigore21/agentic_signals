"""
Generate a 150-test corpus of power-converter load-step responses.

Each test kicks the circuit at t=1ms and records output voltage for 10ms.
Nominal output 5000 mV. A healthy response dips, recovers, holds steady.

Hard-coded rules (the ones that exist today) only look at the first 2ms
after the kick:
    dip    <= 150 mV
    settle <= 2000 us   (time to stay inside a 1% band, i.e. +/-50 mV)

Everything after 3ms is invisible to those rules. That is by design and is
the whole reason the triage tool exists.
"""

import json
import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

RNG = np.random.default_rng(20260912)

# ---------------------------------------------------------------- constants
V_NOM = 5000.0          # mV
T_STOP = 10e-3          # s, requested duration
T_STEP = 1e-3           # s, when the load kick happens
DT = 4e-6               # s, sample interval
BAND = 50.0             # mV, 1% settling band
RULE_WINDOW = 2e-3      # s, how far the hard rules look after the kick
DIP_LIMIT = 150.0       # mV
SETTLE_LIMIT = 2000.0   # us

OUT = Path("/home/claude/corpus")
RAW = OUT / "raw"
PLOTS = OUT / "plots"
for d in (RAW, PLOTS):
    d.mkdir(parents=True, exist_ok=True)

T = np.arange(0.0, T_STOP, DT)
N = len(T)


# ---------------------------------------------------------------- waveform
def second_order(t, t0, amp, fn, zeta):
    """Underdamped step response deviation, zero before t0, -amp at t0."""
    d = np.zeros_like(t)
    m = t >= t0
    tt = t[m] - t0
    wn = 2 * np.pi * fn
    z = np.clip(zeta, 1e-3, 0.999)
    wd = wn * np.sqrt(1 - z**2)
    env = np.exp(-z * wn * tt)
    d[m] = -amp * env * (np.cos(wd * tt) + (z / np.sqrt(1 - z**2)) * np.sin(wd * tt))
    return d


def noise(scale=1.5):
    return RNG.normal(0, scale, N)


def base_trace(amp, fn, zeta, t0=T_STEP):
    return V_NOM + second_order(T, t0, amp, fn, zeta) + noise()


# ---------------------------------------------------------------- measuring
def measure(t, v):
    """Full-window measurements. Returns dict. Assumes t,v are the trace as
    stored on disk (possibly shortened)."""
    out = {}
    dur = float(t[-1]) if len(t) else 0.0
    out["duration_actual_ms"] = round(dur * 1e3, 3)
    out["duration_requested_ms"] = round(T_STOP * 1e3, 3)
    out["stopped_early"] = bool(dur < T_STOP - 5 * DT)

    if len(t) < 50 or not np.all(np.isfinite(v)):
        return None
    if v.min() < 1000 or v.max() > 12000:      # physically impossible values
        return None

    pre = v[t < T_STEP]
    base = float(np.mean(pre)) if len(pre) else V_NOM

    # --- what the existing hard rules see: first 2 ms after the kick only
    wmask = (t >= T_STEP) & (t <= T_STEP + RULE_WINDOW)
    if wmask.sum() < 10:
        return None
    vw, tw = v[wmask], t[wmask]
    dev_w = vw - V_NOM
    rule_dip = float(np.max(np.abs(dev_w)))
    outside = np.where(np.abs(dev_w) > BAND)[0]
    rule_settle = float((tw[outside[-1]] - T_STEP) * 1e6) if len(outside) else 0.0
    # still outside the band when the window closes => never settled
    tail_n = max(int(len(dev_w) * 0.15), 5)
    not_settled = bool(np.max(np.abs(dev_w[-tail_n:])) > BAND)
    if not_settled:
        rule_settle = RULE_WINDOW * 1e6

    out["rule_dip_mV"] = round(rule_dip, 1)
    out["rule_settle_us"] = round(rule_settle, 1)
    out["never_settled"] = not_settled
    out["rules_pass"] = bool(rule_dip <= DIP_LIMIT
                             and rule_settle <= SETTLE_LIMIT
                             and not not_settled)

    # margin: how close to the nearer limit, as % of limit
    m_dip = (DIP_LIMIT - rule_dip) / DIP_LIMIT * 100
    m_set = (SETTLE_LIMIT - rule_settle) / SETTLE_LIMIT * 100
    out["margin_pct"] = -1.0 if not_settled else round(float(min(m_dip, m_set)), 1)

    # --- what the triage tool sees: the whole recorded window
    post = t >= T_STEP
    dev_all = v[post] - V_NOM
    t_all = t[post]
    out["full_dip_mV"] = round(float(np.max(np.abs(dev_all))), 1)

    tail = v[t >= max(dur - 0.5e-3, T_STEP)]
    final = float(np.mean(tail)) if len(tail) else base
    out["final_level_mV"] = round(final, 1)
    out["final_error_mV"] = round(final - V_NOM, 1)

    # excursions outside the band, grouped into events
    bad = np.abs(dev_all) > BAND
    events = []
    if bad.any():
        idx = np.where(bad)[0]
        splits = np.where(np.diff(idx) > 125)[0]
        groups = np.split(idx, splits + 1)
        for g in groups:
            if len(g) < 3:
                continue
            events.append((float(t_all[g[0]]), float(t_all[g[-1]]),
                           float(np.max(np.abs(dev_all[g])))))
    out["n_excursions"] = len(events)
    out["second_dip"] = bool(any(e[0] > T_STEP + RULE_WINDOW + 5e-4
                                 and e[1] < dur - 3e-4
                                 for e in events[1:]))
    out["late_activity"] = bool(any(e[0] > 5e-3 for e in events))
    out["last_excursion_ms"] = round(events[-1][1] * 1e3, 2) if events else 0.0

    # wobble: sign changes of the deviation after the first 2 ms
    late = t_all > (T_STEP + RULE_WINDOW)
    dl = dev_all[late]
    pre_sd = float(np.std(pre - base)) if len(pre) > 10 else 1.5
    floor = max(8.0, 4.0 * pre_sd)
    dl = dl[np.abs(dl) > floor]      # ignore this trace's own noise
    out["wobble_count"] = int(np.sum(np.diff(np.sign(dl)) != 0)) if len(dl) > 2 else 0

    out["flat"] = bool(np.max(np.abs(v - base)) < max(12.0, 5.0 * pre_sd))
    return out


# ---------------------------------------------------------------- buckets
runs = []
rid = 0


def add(bucket, t, v, status="ok", note="", log=""):
    global rid
    rid += 1
    run_id = f"run_{rid:03d}"
    if len(t):
        df = pd.DataFrame({"time_s": t, "v_out_mV": v})
        df.to_csv(RAW / f"{run_id}.csv", index=False, float_format="%.6g")
    else:
        (RAW / f"{run_id}.csv").write_text("")
    runs.append(dict(run_id=run_id, bucket=bucket, status=status,
                     note=note, log_excerpt=log))
    return run_id


# --- 60 clean, full length -------------------------------------------------
for _ in range(44):
    amp = RNG.uniform(55, 125)
    add("clean", T, base_trace(amp, RNG.uniform(1200, 2600), RNG.uniform(0.45, 0.8)),
        note="well behaved")

# ugly-but-healthy: what real clean data looks like. Noisier, wider variation,
# a small constant offset, a little slow drift that stays inside the band.
for _ in range(10):
    v = V_NOM + second_order(T, T_STEP, RNG.uniform(40, 120),
                             RNG.uniform(900, 3000), RNG.uniform(0.35, 0.9))
    v += RNG.normal(0, RNG.uniform(5, 9), N)
    v += RNG.uniform(-22, 22)
    v += np.where(T > T_STEP, RNG.uniform(-18, 18) * (T - T_STEP) / T_STOP, 0)
    add("clean", T, v, note="healthy but noisy - real data looks like this")

# --- 20 passes the rules but is wrong  (THE CORE DEMO) ---------------------
for _ in range(8):   # second dip, after the rule window
    v = base_trace(RNG.uniform(60, 110), RNG.uniform(1500, 2500), RNG.uniform(0.5, 0.8))
    v += second_order(T, RNG.uniform(3.5e-3, 4.5e-3), RNG.uniform(90, 140),
                      RNG.uniform(1200, 2000), RNG.uniform(0.35, 0.6))
    add("passes_but_wrong", T, v, note="recovers, then dips a second time at ~4 ms")

for _ in range(4):   # settles to the wrong level
    off = RNG.choice([-1, 1]) * RNG.uniform(120, 260)
    v = base_trace(RNG.uniform(60, 110), RNG.uniform(1500, 2500), RNG.uniform(0.55, 0.8))
    ramp = np.clip((T - 3.0e-3) / 2.0e-3, 0, 1) * off
    add("passes_but_wrong", T, v + ramp,
        note=f"settles smoothly to the wrong level ({off:+.0f} mV)")

for _ in range(3):   # never stops moving, but gently
    v = base_trace(RNG.uniform(60, 100), RNG.uniform(1600, 2400), RNG.uniform(0.6, 0.8))
    f = RNG.uniform(700, 1400)
    v += np.where(T > T_STEP, RNG.uniform(18, 34) * np.sin(2 * np.pi * f * T), 0)
    add("passes_but_wrong", T, v, note="never stops wobbling, each wobble under the limit")

for _ in range(3):   # flat, the kick never happened
    add("passes_but_wrong", T, V_NOM + noise(1.2),
        note="the kick never happened - perfect score, zero information")

for _ in range(2):   # wakes up late
    v = base_trace(RNG.uniform(60, 100), RNG.uniform(1800, 2500), RNG.uniform(0.6, 0.8))
    v += second_order(T, RNG.uniform(6.5e-3, 7.5e-3), RNG.uniform(110, 170),
                      RNG.uniform(900, 1600), RNG.uniform(0.25, 0.45))
    add("passes_but_wrong", T, v, note="quiet until ~7 ms, then starts moving again")

# --- 12 marginal pass ------------------------------------------------------
for _ in range(12):
    add("marginal_pass", T, base_trace(RNG.uniform(137, 147),
                                       RNG.uniform(1400, 2400), RNG.uniform(0.5, 0.75)),
        note="passes, but with almost no margin left")

# --- 8 stopped early, safe -------------------------------------------------
for _ in range(8):
    v = base_trace(RNG.uniform(55, 110), RNG.uniform(1800, 2800), RNG.uniform(0.6, 0.85))
    cut = RNG.uniform(4.0e-3, 6.0e-3)
    m = T <= cut
    add("early_safe", T[m], v[m], status="stopped_early",
        note="ended after everything interesting had finished",
        log="writer stopped: output budget reached")

# --- 7 stopped early, unknown ----------------------------------------------
for _ in range(7):
    v = base_trace(RNG.uniform(60, 110), RNG.uniform(1500, 2400), RNG.uniform(0.5, 0.75))
    v += second_order(T, RNG.uniform(3.0e-3, 4.0e-3), RNG.uniform(180, 320),
                      RNG.uniform(1000, 1800), RNG.uniform(0.2, 0.4))
    cut = RNG.uniform(2.2e-3, 2.8e-3)
    m = T <= cut
    add("early_unknown", T[m], v[m], status="stopped_early",
        note="ended BEFORE the trouble that the full run would have shown",
        log="solver aborted at t=%.2f ms" % (cut * 1e3))

# --- 25 fails clearly ------------------------------------------------------
for i in range(25):
    if i % 2 == 0:
        add("fails_clear", T, base_trace(RNG.uniform(210, 420),
                                         RNG.uniform(900, 1800), RNG.uniform(0.25, 0.5)),
            note="dip far beyond the limit")
    else:
        add("fails_clear", T, base_trace(RNG.uniform(120, 148),
                                         RNG.uniform(600, 1000), RNG.uniform(0.015, 0.045)),
            note="rings for far too long")

# --- 12 fails marginally ---------------------------------------------------
for _ in range(12):
    add("marginal_fail", T, base_trace(RNG.uniform(151, 168),
                                       RNG.uniform(1400, 2400), RNG.uniform(0.5, 0.75)),
        note="just over the limit - a re-spec conversation, not a bug")

# --- 6 dead / garbage ------------------------------------------------------
add("dead", np.array([]), np.array([]), status="crashed",
    note="no output file written", log="ERROR: netlist parse failed, line 42")
add("dead", np.array([]), np.array([]), status="crashed",
    note="no output file written", log="ERROR: model card 'SW1' not found")
v = base_trace(90, 2000, 0.6); v[1200:] = np.nan
add("dead", T, v, status="garbage", note="values go missing part way through",
    log="WARNING: timestep too small at t=4.8 ms")
add("dead", T, np.zeros(N), status="garbage", note="all zeros - never powered up")
v = base_trace(90, 2000, 0.6); v[900:1100] = 41000
add("dead", T, v, status="garbage", note="impossible spike, numerical artefact")
add("dead", np.array([]), np.array([]), status="crashed",
    note="job never started", log="ERROR: license checkout timed out")

# --- 6 duplicates, scattered (silent coverage loss) ------------------------
donors = [f"run_{i:03d}" for i in RNG.choice(range(1, 55), 6, replace=False)]
for d in donors:
    src = pd.read_csv(RAW / f"{d}.csv")
    add("duplicate", src["time_s"].values, src["v_out_mV"].values,
        note=f"byte-identical to {d} - the swept setting never applied")

print(f"generated {len(runs)} runs")

# ---------------------------------------------------------------- measure all
rows = []
hashes = {}
for r in runs:
    p = RAW / f"{r['run_id']}.csv"
    txt = p.read_text()
    rec = dict(r)
    rec["trace_path"] = f"raw/{r['run_id']}.csv"
    rec["sha1"] = hashlib.sha1(txt.encode()).hexdigest()[:12] if txt else ""

    if not txt.strip():
        rec.update(duration_actual_ms=0.0, duration_requested_ms=T_STOP * 1e3,
                   measurable=False, triage_reason="no output produced")
        rows.append(rec); continue

    df = pd.read_csv(p)
    t, v = df["time_s"].values, df["v_out_mV"].values
    m = measure(t, v)
    if m is None:
        rec.update(duration_actual_ms=round(float(t[-1]) * 1e3, 3),
                   duration_requested_ms=T_STOP * 1e3,
                   measurable=False, triage_reason="unusable values in trace")
        rows.append(rec); continue

    rec.update(m)
    rec["measurable"] = True
    rows.append(rec)

df = pd.DataFrame(rows)

# duplicate detection
dupe_of = {}
seen = {}
for _, r in df.iterrows():
    h = r["sha1"]
    if not h:
        continue
    if h in seen:
        dupe_of[r["run_id"]] = seen[h]
    else:
        seen[h] = r["run_id"]
df["duplicate_of"] = df["run_id"].map(dupe_of).fillna("")

# ---------------------------------------------------------------- triage reason
def reason(r):
    if isinstance(r.get("triage_reason"), str) and r["triage_reason"]:
        return r["triage_reason"]
    if r["duplicate_of"]:
        return f"identical to {r['duplicate_of']} - setting never applied"
    if r.get("flat"):
        return "flat line - the kick never happened, so this tested nothing"
    if r.get("stopped_early"):
        log = str(r.get("log_excerpt", "")).lower()
        if "abort" in log or "error" in log:
            return "solver aborted before the window ended - the pass verdict is not trustworthy"
        return f"ended early at {r['duration_actual_ms']:.1f} ms, after the response had settled - check the log"
    if r.get("never_settled"):
        return "still moving when the rules stopped looking - never settled"
    if not r.get("rules_pass", True):
        return "fails the existing rules"
    if r.get("late_activity"):
        return "quiet, then started moving again late in the window"
    if r.get("second_dip"):
        return "dipped a second time after the rules stopped looking"
    if abs(r.get("final_error_mV", 0)) > 100:
        return f"settled at the wrong level ({r['final_error_mV']:+.0f} mV off)"
    if r.get("wobble_count", 0) > 12:
        return f"never stopped moving ({int(r['wobble_count'])} wobbles)"
    if 0 <= r.get("margin_pct", 100) < 8:
        return f"passes with only {r['margin_pct']:.0f}% margin"
    return "nothing flagged"

df["triage_reason"] = df.apply(reason, axis=1)
df["needs_attention"] = ~df["triage_reason"].isin(["nothing flagged"])

cols = ["run_id", "bucket", "status", "measurable", "rules_pass", "triage_reason",
        "needs_attention", "rule_dip_mV", "rule_settle_us", "margin_pct",
        "never_settled", "full_dip_mV", "final_level_mV", "final_error_mV", "n_excursions",
        "second_dip", "late_activity", "last_excursion_ms", "wobble_count", "flat",
        "duration_requested_ms", "duration_actual_ms", "stopped_early",
        "duplicate_of", "sha1", "trace_path", "note", "log_excerpt"]
df = df.reindex(columns=cols)
runtime_cols = [c for c in cols if c not in ("bucket", "note")]
df[runtime_cols].to_csv(OUT / "measurements.csv", index=False)
df.to_csv(OUT / "_measurements_with_labels.csv", index=False)   # offline only

# accounting
acc = dict(
    launched=len(df),
    analysed=int(df["measurable"].sum()),
    failed=int((~df["measurable"]).sum()),
    stopped_early=int(df["stopped_early"].fillna(False).sum()),
    duplicates=int((df["duplicate_of"] != "").sum()),
    rules_pass=int(df["rules_pass"].fillna(False).sum()),
    rules_fail=int((df["rules_pass"] == False).sum()),
    pass_but_flagged=int(((df["rules_pass"] == True) & df["needs_attention"]).sum()),
)
(OUT / "accounting.json").write_text(json.dumps(acc, indent=2))
print(json.dumps(acc, indent=2))
