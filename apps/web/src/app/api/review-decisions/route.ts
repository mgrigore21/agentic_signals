import { NextResponse } from "next/server";
import { z } from "zod";
import { readReviewDecisions, saveReviewDecision } from "@/lib/server/review-decisions";

const decisionSchema = z.object({
  runId: z.string().regex(/^run_\d{3}$/),
  action: z.enum(["acknowledged", "dismissed", "filed_for_review", "rerun_drafted"]),
  reason: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  if (value.action === "dismissed" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "A dismissal needs a one-line reason." });
  }
});

export async function GET() {
  return NextResponse.json(await readReviewDecisions());
}

export async function POST(request: Request) {
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid decision." }, { status: 400 });
  }
  const decisions = await saveReviewDecision({ ...parsed.data, updatedAt: new Date().toISOString() });
  return NextResponse.json(decisions);
}
