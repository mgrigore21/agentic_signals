import { NextResponse } from "next/server";
import { loadBatch } from "@/lib/batch";

const SYSTEM_PROMPT = "You are triaging overnight power-converter tests. Flag a run if the evidence suggests an engineer should look at it. Use the DTW distance (threshold 4.8), the measurements, the log line, and the duplicate field. Never say a run passed. Cite actual numbers. Return only JSON.";
const TRIAGE_BATCH_SIZE = 50;

type TriageRow = {
  run_id: string;
  measurable: boolean;
  rules_pass: boolean | null;
  rule_dip_mV: number | null;
  rule_settle_us: number | null;
  final_error_mV: number | null;
  wobble_count: number | null;
  second_dip: boolean | null;
  late_activity: boolean | null;
  flat: boolean | null;
  duration_actual_ms: number | null;
  duration_requested_ms: number | null;
  duplicate_of: string | null;
  log_excerpt: string | null;
  dtw: number | null;
  dtw_flag: boolean | null;
};

type TriageResult = Record<string, { flag: boolean; reason: string }>;
let cachedTriage: TriageResult | null = null;

async function triageRows(rows: TriageRow[], apiKey: string, model: string, signal: AbortSignal): Promise<TriageResult> {
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "triage_batch",
      strict: true,
      schema: {
        type: "object",
        properties: Object.fromEntries(rows.map((row) => [row.run_id, {
          type: "object",
          properties: {
            flag: { type: "boolean" },
            reason: { type: "string", maxLength: 120 },
          },
          required: ["flag", "reason"],
          additionalProperties: false,
        }])),
        required: rows.map((row) => row.run_id),
        additionalProperties: false,
      },
    },
  };
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `This batch has exactly ${rows.length} rows. Return every run_id exactly once. Each reason is one sentence, no more than 120 characters, and cites a number.\n\n${JSON.stringify(rows)}`,
        },
      ],
      response_format: responseFormat,
      temperature: 0,
      max_tokens: 4000,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}.`);

  const result = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = result.choices?.[0]?.message?.content ?? "{}";
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid triage response.");

  const triage = Object.fromEntries(rows.flatMap((row) => {
    const entry = (parsed as Record<string, unknown>)[row.run_id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const { flag, reason } = entry as Record<string, unknown>;
    return typeof flag === "boolean" && typeof reason === "string" ? [[row.run_id, { flag, reason }]] : [];
  })) as TriageResult;
  return triage;
}

export async function POST() {
  if (cachedTriage) return NextResponse.json(cachedTriage);

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.MODEL;
  if (!apiKey || !model) return NextResponse.json({ error: "Triage unavailable." }, { status: 503 });

  const { runs } = await loadBatch();
  const rows: TriageRow[] = runs.map((run) => ({
    run_id: run.id,
    measurable: run.measurable,
    rules_pass: run.rulesPass,
    rule_dip_mV: run.ruleDipMv,
    rule_settle_us: run.ruleSettleUs,
    final_error_mV: run.finalErrorMv,
    wobble_count: run.wobbleCount,
    second_dip: run.secondDip,
    late_activity: run.lateActivity,
    flat: run.flat,
    duration_actual_ms: run.durationActualMs,
    duration_requested_ms: run.durationRequestedMs,
    duplicate_of: run.duplicateOf,
    log_excerpt: run.logExcerpt,
    dtw: run.dtw,
    dtw_flag: run.dtwFlag,
  }));
  const batches = Array.from({ length: Math.ceil(rows.length / TRIAGE_BATCH_SIZE) }, (_, index) => rows.slice(index * TRIAGE_BATCH_SIZE, (index + 1) * TRIAGE_BATCH_SIZE));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const results = await Promise.all(batches.map(async (batch) => {
      try {
        const triage = await triageRows(batch, apiKey, model, controller.signal);
        return Object.fromEntries(batch.map((row) => [row.run_id, triage[row.run_id] ?? { flag: false, reason: "not assessed" }]));
      } catch (error) {
        console.error("OpenRouter triage batch could not be completed.", error instanceof Error ? error.message : "Unknown error.");
        return Object.fromEntries(batch.map((row) => [row.run_id, { flag: false, reason: "not assessed" }]));
      }
    }));
    const triage = Object.assign({}, ...results) as TriageResult;
    cachedTriage = triage;
    return NextResponse.json(triage);
  } catch (error) {
    console.error("OpenRouter triage could not be completed.", error instanceof Error ? error.message : "Unknown error.");
    return NextResponse.json({ error: "Triage unavailable." }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}
