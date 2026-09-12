export type ReviewAction = "acknowledged" | "dismissed" | "filed_for_review" | "rerun_drafted";

export type ReviewDecision = {
  runId: string;
  action: ReviewAction;
  reason?: string;
  updatedAt: string;
};

export type Dismissal = {
  run_id: string;
  reason: string;
  timestamp: string;
};

export type BatchRun = {
  id: string;
  measurable: boolean;
  rulesPass: boolean | null;
  dtw: number | null;
  dtwFlag: boolean | null;
  ruleDipMv: number | null;
  ruleSettleUs: number | null;
  finalErrorMv: number | null;
  wobbleCount: number | null;
  secondDip: boolean | null;
  lateActivity: boolean | null;
  flat: boolean | null;
  durationRequestedMs: number | null;
  durationActualMs: number | null;
  duplicateOf: string | null;
  logExcerpt: string | null;
};

export type BatchSnapshot = {
  accounting: { launched: number; analysed: number; failed: number };
  runs: BatchRun[];
};
