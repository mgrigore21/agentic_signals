import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
from pathlib import Path

OUT = Path("/home/claude/corpus")
RAW, PLOTS = OUT / "raw", OUT / "plots"
SINGLES = PLOTS / "runs"
SINGLES.mkdir(parents=True, exist_ok=True)

V_NOM, BAND, T_STEP, RULE_W = 5000.0, 50.0, 1e-3, 2e-3
INK, GRID = "#1b1b1f", "#d8d8de"
OK, BAD, WARN = "#2f7d4f", "#c0392b", "#c98a12"

df = pd.read_csv(OUT / "_measurements_with_labels.csv")


def load(run_id):
    p = RAW / f"{run_id}.csv"
    if not p.stat().st_size:
        return None, None
    d = pd.read_csv(p)
    return d["time_s"].values * 1e3, d["v_out_mV"].values


def dress(ax, show_rule=True, xmax=10):
    if show_rule:
        ax.axvspan(T_STEP * 1e3, (T_STEP + RULE_W) * 1e3, color="#eef1f6", zorder=0)
    ax.axhspan(V_NOM - BAND, V_NOM + BAND, color="#e8f0e8", zorder=0)
    ax.axhline(V_NOM, color=GRID, lw=0.8, zorder=1)
    ax.set_xlim(0, xmax)
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    ax.tick_params(labelsize=7, colors="#666")
    for sp in ax.spines.values():
        sp.set_color(GRID)


# ---------------------------------------------------------- per-run thumbnails
for _, r in df.iterrows():
    t, v = load(r["run_id"])
    fig, ax = plt.subplots(figsize=(3.2, 1.9), dpi=110)
    if t is None:
        ax.text(.5, .5, "no output", ha="center", va="center",
                color=BAD, fontsize=11, transform=ax.transAxes)
        ax.set_xticks([]); ax.set_yticks([])
    else:
        flagged = r["triage_reason"] != "nothing flagged"
        col = BAD if r["rules_pass"] is False or r["rules_pass"] == False else (
            WARN if flagged else OK)
        dress(ax)
        ax.plot(t, v, lw=0.9, color=col)
        ax.set_ylim(V_NOM - 480, V_NOM + 360)
    ax.set_title(r['run_id'], fontsize=7.5, color=INK, pad=4)
    fig.tight_layout()
    fig.savefig(SINGLES / f"{r['run_id']}.png", bbox_inches="tight")
    plt.close(fig)

# ------------------------------------------------------------- overview grid
n = len(df)
cols, rows = 15, int(np.ceil(n / 15))
fig, axes = plt.subplots(rows, cols, figsize=(cols * 1.35, rows * 1.0), dpi=140)
for ax, (_, r) in zip(axes.ravel(), df.iterrows()):
    t, v = load(r["run_id"])
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_color(GRID); sp.set_linewidth(0.5)
    if t is None or not bool(r["measurable"]):
        ax.set_facecolor("#fbeaea")
        ax.text(.5, .5, "×", ha="center", va="center", color=BAD, fontsize=13)
        continue
    flagged = r["triage_reason"] != "nothing flagged"
    passes = bool(r["rules_pass"]) if pd.notna(r["rules_pass"]) else False
    col = OK if not flagged else (WARN if passes else BAD)
    if flagged and passes:
        ax.set_facecolor("#fdf6e6")
    ax.axhline(V_NOM, color=GRID, lw=0.4)
    ax.plot(t, v, lw=0.7, color=col)
    ax.set_xlim(0, 10); ax.set_ylim(V_NOM - 480, V_NOM + 360)
for ax in axes.ravel()[n:]:
    ax.axis("off")
fig.suptitle("150 overnight tests  ·  green = nothing flagged   "
             "amber = passes the rules but something is off   red = fails the rules   "
             "× = no result at all",
             fontsize=10, color=INK, y=1.005)
fig.tight_layout()
fig.savefig(PLOTS / "overview_grid.png", bbox_inches="tight")
plt.close(fig)

# --------------------------------------------------------- the money slide
picks = [
    ("clean", "A normal response — this is what the other 53 look like"),
    ("second dip", "Recovers, then dips again once the rules stop looking"),
    ("wrong level", "Perfect shape, settles to the wrong voltage"),
    ("never stops", "Recovers on time, then wobbles forever"),
    ("flat", "The kick never happened — scores better than every real test"),
    ("late", "Quiet until 7 ms, then starts moving again"),
]
sel = [
    df[df.bucket == "clean"].iloc[3]["run_id"],
    df[df.triage_reason.str.contains("second time")].iloc[0]["run_id"],
    df[df.triage_reason.str.contains("wrong level")].iloc[0]["run_id"],
    df[df.triage_reason.str.contains("wobbles")].iloc[0]["run_id"],
    df[df.triage_reason.str.contains("flat line")].iloc[0]["run_id"],
    df[df.triage_reason.str.contains("late in the window")].iloc[0]["run_id"],
]
fig, axes = plt.subplots(2, 3, figsize=(13, 5.6), dpi=150)
for ax, rid, (tag, cap) in zip(axes.ravel(), sel, picks):
    t, v = load(rid)
    dress(ax)
    ax.plot(t, v, lw=1.2, color=OK if tag == "clean" else WARN)
    ax.set_ylim(V_NOM - 420, V_NOM + 330)
    ax.set_title(cap, fontsize=9.5, color=INK, pad=6, loc="left")
    ax.text(.985, .06, rid, transform=ax.transAxes, ha="right",
            fontsize=7, color="#999")
    ax.set_xlabel("time (ms)", fontsize=7.5, color="#777")
fig.suptitle("Every one of these passes both automated checks",
             fontsize=14, color=INK, y=1.0, x=.5)
fig.text(.5, .955, "shaded band = the 2 ms window the rules look at   ·   "
                   "green band = the acceptable range",
         ha="center", fontsize=8.5, color="#777")
fig.tight_layout(rect=[0, 0, 1, .94])
fig.savefig(PLOTS / "passes_but_wrong.png", bbox_inches="tight")
plt.close(fig)

# ------------------------------------------------- early-stop: same symptom
fig, axes = plt.subplots(1, 2, figsize=(10.5, 3.4), dpi=150)
for ax, (b, cap, col) in zip(axes, [
        ("early_safe", "Stopped early — but after the response finished.\n"
                       "Verdict: keep the result.", OK),
        ("early_unknown", "Stopped early — before it settled. The rules searched a\n"
                          "shortened window and returned a pass by accident.", BAD)]):
    sub = df[df.bucket == b].head(5)
    dress(ax)
    for _, r in sub.iterrows():
        t, v = load(r["run_id"])
        ax.plot(t, v, lw=1.0, color=col, alpha=.75)
    ax.set_ylim(V_NOM - 420, V_NOM + 330)
    ax.set_title(cap, fontsize=9, color=INK, loc="left", pad=6)
    ax.set_xlabel("time (ms)", fontsize=7.5, color="#777")
fig.suptitle("One symptom, two opposite verdicts", fontsize=13, color=INK, y=1.04)
fig.tight_layout()
fig.savefig(PLOTS / "early_stop_two_verdicts.png", bbox_inches="tight")
plt.close(fig)

print("wrote plots")
print(sorted(p.name for p in PLOTS.glob("*.png")))
