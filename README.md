# Signal Anomaly Detection

An overnight triage console for power-converter signal tests. It gives an engineer one accountable view of a test batch: every run is present, the raw trace can be inspected, deterministic measurements remain visible, and an agent writes a concise evidence-based reason for items that may need review.

The project was built from the Agents Everywhere starter kit. Its core workflow is a custom Next.js web application, rather than a standalone chat experience.

## The problem

Power-converter tests record output voltage for 10 ms after a load kick. Existing automated rules only decide whether the initial voltage dip and recovery time are within limits. A run can clear those rules but still be concerning: it may dip again later, settle at the wrong voltage, remain unstable, be a duplicate, stop prematurely, or produce no usable result.

Reviewing all traces manually is slow, while treating a rule verdict as the final answer misses important evidence. Signal Anomaly Detection brings the decision support into the batch-review screen where an engineer already needs it.

## How the console works

1. **Account for the batch.** The always-visible banner reports launched, analysed, and missing-result runs. Nothing silently disappears.
2. **Measure and compare.** Deterministic measurements include dip, recovery time, final-level error, late movement, recording duration, duplicates, and log excerpts. Dynamic Time Warping (DTW), a classical shape-comparison method, provides a distance from a healthy reference; values above `4.8` are far from normal.
3. **Triage with an agent.** When the page loads, the app sends all 150 runs to the model in three parallel 50-run batches. The agent sees measurements, DTW distance/flag, file facts, and logs, but never receives `triage_reason` or `needs_attention`. It returns a structured `{ flag, reason }` result for each run.
4. **Rank for review.** Runs with no usable output come first. Then agent-flagged runs are ordered by DTW distance descending, followed by the remaining runs in the same DTW order. If the model is unavailable, the page falls back to this deterministic DTW ordering and clearly marks reasons as unavailable.
5. **Keep the engineer in control.** Selecting a row displays its original trace image and evidence panel. The engineer can enlarge the trace and dismiss a wrong flag only after supplying a reason; dismissal records persist locally.

This separation is intentional: rules and DTW are repeatable detection signals, the LLM performs mixed-evidence triage, and the engineer makes the final decision.

## Why an agent belongs in this interface

A chatbot would require the engineer to decide what to paste, formulate questions one run at a time, and reconstruct context from separate sources. Here the agent runs automatically when the batch arrives, receives the relevant evidence in a fixed schema, and places one sentence directly beside every run in the ranked list. The user can immediately compare that statement with the actual trace and numeric evidence, then record a human review decision.

The agent is useful because it is embedded in a constrained review workflow, not because it can freely chat. It cannot invent a new ranking input, access evaluation labels, or make the final disposition.

## Architecture

```text
corpus/runtime/ CSV + JSON + trace PNGs
                 |
                 v
Next.js server loader ----> React ranked-review console
                 |                     |
                 |                     +--> selected trace + evidence
                 v
POST /api/triage (3 parallel 50-run OpenRouter calls)
                 |
                 v
strict JSON results: { run_id: { flag, reason } }
                 |
                 v
ranked rows + persistent local dismissals
```

### Data boundaries

- `corpus/runtime/` is the only corpus folder read by the web app. It holds the runtime CSV inputs, accounting data, raw traces, and trace images.
- `corpus/offline_eval_only/` holds ground truth, labelled measurements, DTW evaluation output, and class folders. It is neither served from `public/` nor imported by the application.
- The triage request explicitly maps an allowlist of evidence fields and drops `triage_reason` and `needs_attention` before the model call.
- Dismissals are written atomically to `data/dismissals.json` and never affect the original corpus.
- API keys stay in `.env`, which is ignored by Git.

## Technology

- **Next.js 15**, **React 19**, and **TypeScript** for the web application
- **Next.js route handlers** for batch loading, model triage, trace serving, and dismissal persistence
- **OpenRouter's OpenAI-compatible Chat Completions API** for model access
- **JSON Schema structured output** to require one `{ flag, reason }` object for each run
- **Dynamic Time Warping (DTW)** for deterministic signal-shape comparison
- **CSV and JSON files** for the small, transparent corpus and persistent local review decisions
- **CopilotKit** remains available from the originating Agents Everywhere template; the core signal-triage workflow is implemented directly in the web console

## Run locally

Requirements: Node.js 22 or newer and an OpenRouter API key.

```bash
npm ci
copy .env.example .env
```

Set these values in `.env` (never commit this file):

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=your-openrouter-key
MODEL=openai/gpt-4.1-mini
```

Start the web application:

```bash
npm run dev:web
```

Open [http://127.0.0.1:3100](http://127.0.0.1:3100). The table renders from local corpus data first; agent triage then runs in the background without blocking the page.

## Verification

```bash
npm run typecheck
npm test
```

For a manual check, open the console, select several rows, expand a trace image, and dismiss one row with a short reason. Refresh the page to confirm that the dismissal persists. If the model call cannot complete, confirm that the table remains available with deterministic ordering and an unavailable-reasons notice.

## Key project files

| Path | Purpose |
| --- | --- |
| `apps/web/src/components/triage-console.tsx` | Ranked list, evidence panel, image preview, agent-result display, and dismissal UI |
| `apps/web/src/app/api/triage/route.ts` | Parallel structured-output model triage route |
| `apps/web/src/lib/batch.ts` | Runtime corpus loader and deterministic fallback ordering |
| `apps/web/src/app/api/dismissals/route.ts` | Persistent human-dismissal API |
| `corpus/runtime/` | Inputs used by the application |
| `corpus/offline_eval_only/` | Evaluation-only material, excluded from runtime |
