# Overnight Test Triage — implementation report

## Scope completed

The web app implements the four agreed review-console milestones:

1. A full ranked list of the corpus runs.
2. A batch accounting banner.
3. Static trace images for the selected run.
4. Persistent engineer dismissals with a required reason.

The optional on-load LLM summaries were deliberately not added.

## Data flow

The runtime reads only these corpus inputs:

- `corpus/measurements.csv`
- `corpus/dtw_results.csv`
- `corpus/accounting.json`
- `corpus/plots/runs/*.png`

`measurements.csv` and `dtw_results.csv` are joined on `run_id`. The app displays the source `triage_reason` without generating or recomputing a new reason.

`corpus/ground_truth.csv` is not imported, read, or exposed by the web application.

## Ranked list

The home page renders every run in a single table with no pagination:

| Column | Source |
| --- | --- |
| Rank | Position after the specified sort |
| `run_id` | `measurements.csv` |
| `rules_pass` | `measurements.csv` |
| `triage_reason` | `measurements.csv`, unchanged |
| DTW | `dtw_results.csv` |

The ordering is deterministic:

1. `measurable == False`
2. `needs_attention == True`
3. All remaining runs, ordered by `run_id`

## Accounting

The always-visible banner reads the real values from `corpus/accounting.json`:

> 150 launched = 144 analysed + 6 no result

It is not calculated from a hard-coded UI value.

## Trace review

The 150 existing corpus PNGs are copied into `apps/web/public/plots/runs/` and served as static web assets. Selecting a row shows its existing image beside the table at:

```text
/plots/runs/{run_id}.png
```

No charting component or runtime simulation was added.

## Dismissals

The selected run includes a **Mark wrong** action.

- A one-line reason is required.
- A successful dismissal appends `{ run_id, reason, timestamp }` to `data/dismissals.json`.
- The `data/` directory and JSON file are created on first write.
- Writes are atomic: the server writes a unique temporary file and renames it over `dismissals.json`.
- Dismissed runs are hidden by default after reload.
- A `N dismissed — show dismissed` control exposes them again.

## Validation performed

- `npm run typecheck --workspace web` passes.
- The page renders successfully from the local development server.
- Static run images return `200 image/png`.
- `GET /api/dismissals` returns an empty array before any dismissal.
- An empty-reason dismissal is rejected with HTTP 400 and does not create a dismissal file.

## Manual acceptance check

One manual check remains before demo recording:

1. Open a run in the review console.
2. Enter a non-empty dismissal reason and click **Mark wrong**.
3. Refresh the page and confirm the row is hidden.
4. Click **show dismissed** and confirm the row and its saved reason are visible.

## Deliberate exclusions

- No LLM is in the detection path.
- No live simulator runs during review.
- No external service, database, or Ambiguous integration is required.
- No ground-truth labels enter the runtime.
- The inherited CopilotKit provider was removed from the active layout because it was unused by these milestones and generated an incompatible runtime-transport error.
