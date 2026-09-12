"""
1. Reorganise the corpus into ground-truth folders.
2. Run a DTW-against-reference baseline.
3. Score it: false positives and, importantly, false negatives per class.
"""
import json, shutil
from pathlib import Path
import numpy as np
import pandas as pd

C = Path("/home/claude/corpus")
BY = C / "by_class"
V_NOM, T_STOP, T_STEP = 5000.0, 10e-3, 1e-3
DS = 250          # downsampled length
BAND = 30         # Sakoe-Chiba band

df = pd.read_csv(C / "_measurements_with_labels.csv")

# ---------------------------------------------------------------- 1. folders
CLASS_DOC = {
    "clean":            "Normal response, full length. The reference population.",
    "passes_but_wrong": "Passes both hard rules. Something is still wrong.",
    "marginal_pass":    "Passes, but with almost no margin left.",
    "early_safe":       "Ended early, after the response had finished. Keep.",
    "early_unknown":    "Ended early, before settling. The pass is not trustworthy.",
    "fails_clear":      "Fails the hard rules, unambiguously.",
    "marginal_fail":    "Just over a limit. Re-spec conversation, not a bug.",
    "dead":             "No usable result at all.",
    "duplicate":        "Byte-identical to another run. Silent coverage loss.",
}
if BY.exists():
    shutil.rmtree(BY)
for b, doc in CLASS_DOC.items():
    d = BY / b
    d.mkdir(parents=True)
    (d / "README.txt").write_text(doc + "\n")
for _, r in df.iterrows():
    src = C / r["trace_path"]
    shutil.copy(src, BY / r["bucket"] / f"{r['run_id']}.csv")

# ground-truth label file
gt = df[["run_id", "bucket", "rules_pass", "measurable", "triage_reason",
         "duplicate_of", "note"]].copy()
gt["should_flag"] = df["triage_reason"] != "nothing flagged"
gt["hidden_from_rules"] = gt["should_flag"] & (df["rules_pass"] == True)
gt.to_csv(C / "ground_truth.csv", index=False)

# ---------------------------------------------------------------- 2. DTW
def load(rid):
    p = C / "raw" / f"{rid}.csv"
    if not p.stat().st_size:
        return None
    d = pd.read_csv(p)
    v = d["v_out_mV"].values
    if not np.all(np.isfinite(v)) or v.min() < 1000 or v.max() > 12000:
        return None
    return v

def debias(v):
    """Remove each trace's own pre-kick level. Standard preprocessing; without
    it a constant 20 mV offset costs as much as a real fault."""
    pre = v[: int(T_STEP / 4e-6)]
    return v - (pre.mean() if len(pre) > 10 else V_NOM) + V_NOM

def resample(v, n=DS):
    """Area-preserving downsample. Truncated traces keep their real length
    ratio so DTW sees a genuinely shorter sequence."""
    k = max(int(round(len(v) / (T_STOP / 4e-6) * n)), 8)
    idx = np.linspace(0, len(v), k + 1).astype(int)
    return np.array([v[idx[i]:idx[i+1]].mean() for i in range(k)])

def dtw(a, b, band=BAND):
    n, m = len(a), len(b)
    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0.0
    scale = m / n
    for i in range(1, n + 1):
        c = int(i * scale)
        lo, hi = max(1, c - band), min(m, c + band)
        ai = a[i - 1]
        for j in range(lo, hi + 1):
            d = ai - b[j - 1]
            D[i, j] = d * d + min(D[i-1, j], D[i, j-1], D[i-1, j-1])
    return float(np.sqrt(D[n, m] / max(n, m)))

def dtw_path_cost(a, b, band=BAND):
    """Return per-sample contribution of a to the alignment cost, for
    highlighting where the divergence is."""
    n, m = len(a), len(b)
    D = np.full((n + 1, m + 1), np.inf); D[0, 0] = 0.0
    P = np.zeros((n + 1, m + 1), np.int8)
    scale = m / n
    for i in range(1, n + 1):
        c = int(i * scale); lo, hi = max(1, c - band), min(m, c + band)
        for j in range(lo, hi + 1):
            d = a[i-1] - b[j-1]
            opts = (D[i-1, j-1], D[i-1, j], D[i, j-1])
            k = int(np.argmin(opts))
            D[i, j] = d * d + opts[k]; P[i, j] = k
    contrib = np.zeros(n)
    i, j = n, m
    while i > 0 and j > 0:
        contrib[i-1] = max(contrib[i-1], abs(a[i-1] - b[j-1]))
        k = P[i, j]
        if k == 0: i, j = i-1, j-1
        elif k == 1: i -= 1
        else: j -= 1
    return contrib

# reference = pointwise median of the clean population
clean_ids = df[df.bucket == "clean"]["run_id"].tolist()
clean_rs = [resample(debias(load(r))) for r in clean_ids]
ref = np.median(np.stack([c for c in clean_rs if len(c) == DS]), axis=0)

rows = []
for _, r in df.iterrows():
    v = load(r["run_id"])
    if v is None:
        rows.append(dict(run_id=r["run_id"], dtw=np.nan, dtw_flag=None,
                         dtw_note="DTW cannot run: no usable trace"))
        continue
    a = resample(debias(v))
    rows.append(dict(run_id=r["run_id"], dtw=dtw(a, ref), dtw_flag=None, dtw_note=""))
d = pd.DataFrame(rows)

# threshold from the clean population only (what you'd do with no labels)
cl = d[d.run_id.isin(clean_ids)]["dtw"].dropna()
NAIVE = float(cl.mean() + 3 * cl.std())
med = float(cl.median()); mad = float((cl - med).abs().median())
THRESH = med + 5 * mad
print(f"threshold: naive mean+3sd = {NAIVE:.1f}  (inflated by noisy-but-healthy runs)")
print(f"           robust median+5MAD = {THRESH:.1f}  <- used")
d["dtw_flag"] = d["dtw"] > THRESH
d.loc[d.dtw.isna(), "dtw_flag"] = False        # DTW simply has no opinion
res = gt.merge(d, on="run_id")
res[["run_id", "dtw", "dtw_flag"]].to_csv(C / "dtw_results.csv", index=False)
res.to_csv(C / "_dtw_results_with_labels.csv", index=False)   # offline only

# ---------------------------------------------------------------- 3. scoring
def score(sub, name):
    tp = int((sub.should_flag & sub.dtw_flag).sum())
    fn = int((sub.should_flag & ~sub.dtw_flag).sum())
    fp = int((~sub.should_flag & sub.dtw_flag).sum())
    tn = int((~sub.should_flag & ~sub.dtw_flag).sum())
    rec = tp / (tp + fn) if tp + fn else float("nan")
    prec = tp / (tp + fp) if tp + fp else float("nan")
    return dict(scope=name, n=len(sub), TP=tp, FN=fn, FP=fp, TN=tn,
                recall=round(rec, 3), precision=round(prec, 3))

summary = [score(res, "all 150"),
           score(res[res.rules_pass == True], "only runs the rules passed")]
print()
print(pd.DataFrame(summary).to_string(index=False))

print("\nper class — how many did DTW MISS?")
per = res.groupby("bucket").apply(
    lambda g: pd.Series({
        "n": len(g),
        "should_flag": int(g.should_flag.sum()),
        "dtw_flagged": int(g.dtw_flag.sum()),
        "MISSED": int((g.should_flag & ~g.dtw_flag).sum()),
        "false_alarm": int((~g.should_flag & g.dtw_flag).sum()),
        "median_dtw": round(float(g.dtw.median()), 1) if g.dtw.notna().any() else np.nan,
    }), include_groups=False)
print(per.to_string())

json.dump(dict(threshold_robust=THRESH, threshold_naive=NAIVE, summary=summary),
          open(C / "dtw_score.json", "w"), indent=2)

# highlight plot for a few representative runs
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
picks = []
for b in ["clean", "passes_but_wrong", "early_unknown", "duplicate"]:
    sub = res[res.bucket == b].dropna(subset=["dtw"])
    picks += list(sub.head(2)["run_id"]) if b != "passes_but_wrong" else \
             list(sub.head(4)["run_id"])
fig, axes = plt.subplots(2, 5, figsize=(17, 5.4), dpi=140)
for ax, rid in zip(axes.ravel(), picks[:10]):
    v = load(rid); a = resample(debias(v))
    contrib = dtw_path_cost(a, ref)
    x = np.linspace(0, len(v) * 4e-6 * 1e3, len(a))
    r = res[res.run_id == rid].iloc[0]
    ax.axhline(V_NOM, color="#d8d8de", lw=.8)
    ax.plot(x, a, lw=1.0, color="#444")
    hot = contrib > max(np.percentile(contrib, 92), 40)
    ax.scatter(x[hot], a[hot], s=7, color="#c0392b", zorder=3)
    ax.set_xlim(0, 10); ax.set_ylim(V_NOM - 450, V_NOM + 330)
    verdict = "FLAGGED" if r.dtw_flag else "not flagged"
    bad = r.should_flag and not r.dtw_flag
    ax.set_title(f"{rid} · {r.bucket}\nDTW {r.dtw:.0f} → {verdict}"
                 + ("   ← MISS" if bad else ""),
                 fontsize=7.5, color="#c0392b" if bad else "#1b1b1f", loc="left")
    ax.tick_params(labelsize=6)
fig.suptitle("DTW baseline: red marks where the alignment cost is concentrated",
             fontsize=12, y=1.02)
fig.tight_layout()
fig.savefig(C / "plots" / "dtw_highlight.png", bbox_inches="tight")
print("\nwrote dtw_highlight.png")
