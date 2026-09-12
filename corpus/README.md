runtime/            <- the ONLY folder the web app may read
  measurements.csv     26 columns, no labels
  dtw_results.csv      run_id, dtw, dtw_flag
  accounting.json
  raw/                 150 traces
  plots/runs/          150 PNGs, titled by run_id only

offline_eval_only/  <- never served, never imported by the app
  ground_truth.csv
  _measurements_with_labels.csv
  _dtw_results_with_labels.csv
  dtw_score.json
  by_class/
