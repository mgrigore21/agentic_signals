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
  triageReason: string;
  needsAttention: boolean;
  dtw: number | null;
  ruleDipMv: number | null;
  ruleSettleUs: number | null;
  finalErrorMv: number | null;
  wobbleCount: number | null;
  durationActualMs: number | null;
};

export type BatchSnapshot = {
  accounting: { launched: number; analysed: number; failed: number };
  runs: BatchRun[];
};
