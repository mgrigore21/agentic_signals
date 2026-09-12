# Project idea

## One-sentence idea

A triage agent that reviews a whole overnight batch of test results, accounts
for every single one, and tells the engineer which handful to look at first and
why — including the results that never produced a number at all.

## Who it is for

Engineers who validate power converter designs. Every night a batch of
simulated tests runs. Each test kicks the circuit with a sudden load change and
records how the output voltage responds over 10 milliseconds. A healthy response
dips, recovers, and holds steady.

In the morning there are hundreds of traces and nobody has time to open them.
Automated rules check two things — how far it dipped and how fast it recovered —
and everything that passes both is assumed fine and never looked at again.

## The problem

We have a ground-truth set of 150 signals with known labels:

| Bucket | n | The existing rules say |
|---|---|---|
| Clean, full length | 54 | pass |
| **Passes but wrong** | **20** | **pass** — 8 dip a second time, 4 settle at the wrong level, 3 never stop moving, 3 are flat, 2 wake up late |
| Marginal pass | 12 | pass, with 0–8% margin left |
| Stopped early, safe | 8 | pass, correctly |
| Stopped early, unknown | 7 | pass, **by accident** |
| Fails clearly | 25 | fail |
| Fails marginally | 12 | fail |
| Dead / garbage | 6 | no result |
| Duplicates | 6 | pass, hidden inside the clean set |

**107 of 150 pass both automated checks. 53 of those require an explicit review
disposition that the current process has no way to give** — some are defects,
some are safe early stops, some are passes with no margin left. Today all 53
receive the same disposition: silence.

Three separate failure modes, and only the first is a "signal" problem:

1. **The rules only look at the first 2 ms.** Anything that goes wrong later —
   a second dip, a slow drift to the wrong voltage, activity waking up at 7 ms —
   is invisible to them by construction.
2. **A flat line scores perfectly.** If the test never actually kicked the
   circuit, it dipped zero and settled instantly. It outscores every real test
   in the batch while containing no information at all.
3. **Failures disappear silently.** When a test crashes or produces garbage, the
   analysis script errors out and the row vanishes from the summary. Nobody
   notices that 144 results came back from 150 launches.

The last one is the worst, because a missing result is not even in the list to
be missed, while the coverage report still claims that configuration was tested.

## Where the agent lives

**A web review console**, built on the CopilotKit React template.

Reasoning: the whole job is looking at shapes, so the agent has to live
somewhere it can draw them. The web template also gives page context — the agent
knows which test the engineer currently has open — and ships a built-in approval
step that maps directly onto the triage actions we need. Slack was the
alternative, but getting plots into Slack cards is a detour, and the review
itself is not a conversation.

## Main workflow

### Step 1 — Baseline: DTW, measured

We compare every trace against a reference built from the clean population and
score it by dynamic time warping distance, highlighting where the alignment cost
concentrates. Each trace has its own pre-kick level subtracted first (standard
preprocessing). The threshold is set from the clean runs alone, using no labels.

The clean set deliberately includes 10 traces that are healthy but noisy, with
small offsets and drift — because that is what real clean data looks like, and
a baseline that only sees tidy data is a strawman.

Measured result on the 150-signal ground truth:

| Scope | Recall | Precision | Missed | False alarms |
|---|---|---|---|---|
| All 150 | 0.69 | 0.97 | 30 | 2 |
| Only the 107 the rules passed | 0.56 | 0.94 | 24 | 2 |

DTW is **good at what it does**, and the pitch says so. It caught all 20 hidden
shape problems and all 37 rule failures. Its two false alarms are both
healthy-but-noisy traces — the kind of thing that makes an engineer stop
trusting a tool by day three unless someone can explain *why* it fired.

Where it fails is specific:

| Class | Missed | Why |
|---|---|---|
| Duplicates | 6 of 6 | It *is* a normal signal. Nothing in the shape to detect. |
| Dead / garbage | 6 of 6 | No trace to align. DTW cannot run at all. |
| Marginal pass | 12 of 12 | They look normal, because they are — nearly. Not a shape problem. |
| Stopped early, safe | 6 of 8 | Fine, arguably. These should be kept, not flagged. |

Two findings that matter more than the totals:

**DTW appeared to catch all 7 dangerous truncated runs, for the wrong reason.**
Within truncated runs its distance correlates about −0.9 with duration. It
measures length, not anomaly. A genuinely bad run truncated late would slip
through.

**The baseline got fragile as soon as the data got realistic.** With only
tidy clean traces, raw-voltage DTW with a mean + 3sd threshold gave recall
0.81. Adding 10 noisy-but-healthy traces broke it two ways at once: their
small constant offsets cost as much as real faults, and their spread inflated
the threshold. Recall fell to 0.30. Subtracting each trace's own pre-kick level
fixed most of it (recall 0.57); switching to a robust threshold, median +
5·MAD, took it to 0.69. Both fixes are standard. The point is that neither is
free, and a threshold-based tool in the field needs exactly this kind of
tuning — which is why the engineer has to see *evidence*, not a score.

Conclusion: DTW is a strong shape detector that cannot see anything which is not
a shape, and its verdicts need a human who can tell a noisy-healthy trace from
a faulty one. That is a category boundary, not a bug to fix.

### Step 2 — The agent, on top of the same detector

The agent does not replace DTW. It reads the DTW score as one input and handles
everything the detector has no opinion about.

What it needs that DTW does not have:

- **The file, not just the array** — size, hash, sample count, whether it is
  empty. This alone resolves duplicates and dead runs: 12 of the 30 misses.
- **Requested vs actual duration** — turns DTW's length artifact into an
  explicit judgment. Short *and* already settled → keep the result. Short
  *before* settling → the pass verdict is not trustworthy.
- **The log text** — "solver aborted at 2.4 ms" is the difference between a data
  problem and a finding.
- **The batch metadata** — so 6 failures with the same error are reported as one
  problem, not six rows.

### Step 3 — Is it actually better?

Stated precisely, because this is the claim that has to survive questioning:

- On shape anomalies: **no**. DTW gets 20 out of 20 and the agent will not beat
  that.
- On the DTW misses: **yes**, because the ones that matter are file and
  metadata problems rather than curve problems.
- On the DTW false alarms: **yes** — the agent can say *this one is noisy, not
  wrong: dip 118, settled fast, level correct*, and let the engineer dismiss it
  in one click with the reason stored.

The agent is not a better detector. It is the layer that knows what to do when
the detector has no opinion — and on this data that is 12% of the entire batch,
every single case of which is invisible today.

## Context the agent should use

- `measurements.csv` — one row per test with all extracted numbers
- `raw/run_XXX.csv` — the 150 raw traces
- `dtw_results.csv` — baseline distance and flag per test
- `ground_truth.csv` — labels, used for scoring only, never shown to the agent
- `plots/runs/*.png` — per-test images, for the engineer and optionally for
  visual inspection by the agent
- simulator log excerpts, carried per run

## Actions and approvals

Read-only over the corpus. Every action that changes anything is proposed and
requires a click:

| Action | Effect |
|---|---|
| Acknowledge | Marks as seen, stays in the list |
| Mark wrong | Dismisses the flag, **requires a one-line reason**, never returns |
| File for review | Adds to a shortlist for a second engineer |
| Rerun this group | **Drafts** the command. Never executes it. |

Dismissals are stored server-side with the reason and survive a refresh, so the
next person sees why something was waved off instead of re-litigating it.

## Data and integrations

Files only. No external services, no simulator in the request path — the corpus
is generated offline ahead of time and the agent reads it from disk. Nothing
simulates during the demo.

## What a successful demo shows

The complete arc, in four beats:

1. **Accounting.** 150 launched = 144 analysed + 6 with no usable result. The
   arithmetic is on screen. Today those 6 are invisible.
2. **The hidden 53.** Six traces that pass both automated checks and are all
   clearly wrong. The flat one is the punchline: the test that never ran scores
   better than every test that did.
3. **DTW vs the agent, side by side.** Two duplicate traces with DTW scores
   around 2, indistinguishable from clean, next to the agent flagging them
   instantly because the file hashes match. Then one DTW false alarm — a noisy
   but healthy trace — and the agent explaining why the detector fired and why
   it does not matter.
4. **The engineer overrules the agent, and it sticks.**

Beat 4 is the actual climax, not beat 2. Anyone can demo a tool that finds
things. Showing a tool that accepts being wrong, records why, and does not raise
the same flag again is what says *this is a tool, not an oracle* — and it is the
thing that decides whether a real engineer would use it past the first week.

## Constraints or preferences

**Design rules, non-negotiable:**

1. **Rank, never filter.** Every test stays in the list, ordered, reason visible.
   This engineer is accountable for anything nobody looked at, so hiding rows is
   not a feature — it is a transfer of risk onto him.
2. **Never say something passed.** The agent says "nothing flagged", never "this
   is fine". Only the engineer certifies.
3. **Evidence, not scores.** Show *this one moved 17 times, the other 54 moved
   twice*. Never lead with a number out of 100. A score cannot be argued with,
   so it does not get trusted.
4. **Disagreement is cheap and permanent.**
5. **State the blind spots unprompted.**

**Technical:**

- The detector is ordinary statistics plus DTW — deterministic, same answer
  tomorrow. **No language model in the detection path.** If the agent were
  removed, a working detector would remain.
- No simulation at demo time.

**Honesty:**

The 150 signals are synthetic, generated from a second-order model with
deliberately injected problems. This is stated openly. It is the right call for
a two-day build because it gives exact ground truth, and the measured DTW
numbers above are only meaningful *because* the labels are known. The clean
population includes deliberately noisy traces so the baseline has something to
get wrong; even so, it is tidier than real data, and we say so.
