import { NextResponse } from "next/server";
import { loadBatch } from "@/lib/batch";

const SYSTEM_PROMPT = "You are reviewing overnight power-converter test results for an engineer. For each run, write ONE sentence saying what the numbers show and what the engineer should check. Cite the actual numbers. Never say a run passed or is fine; say 'nothing flagged' if there is nothing to say. Never give a score. Return only JSON.";

export async function POST() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.MODEL;
  if (!apiKey || !model) return NextResponse.json({ error: "Explanations unavailable." }, { status: 503 });

  const { runs } = await loadBatch();
  const topRuns = runs.slice(0, 15).map((run) => ({
    run_id: run.id,
    triage_reason: run.triageReason,
    rules_pass: run.rulesPass,
    dtw: run.dtw,
    rule_dip_mV: run.ruleDipMv,
    rule_settle_us: run.ruleSettleUs,
    final_error_mV: run.finalErrorMv,
    wobble_count: run.wobbleCount,
    duration_actual_ms: run.durationActualMs,
  }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Return exactly one JSON object with each listed run_id as a key and its one-sentence explanation as the string value. Do not wrap the object in another property.\n\n${JSON.stringify(topRuns)}`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });
    if (!response.ok) {
      console.error(`OpenRouter explanations failed with status ${response.status}.`);
      return NextResponse.json({ error: "Explanations unavailable." }, { status: 502 });
    }
    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const parsed: unknown = JSON.parse(result.choices?.[0]?.message?.content ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid explanation response.");
    const explanations = Object.fromEntries(topRuns.flatMap((run) => {
      const sentence = (parsed as Record<string, unknown>)[run.run_id];
      return typeof sentence === "string" ? [[run.run_id, sentence]] : [];
    }));
    if (Object.keys(explanations).length === 0) throw new Error("No explanations matched the requested run IDs.");
    return NextResponse.json(explanations);
  } catch {
    return NextResponse.json({ error: "Explanations unavailable." }, { status: 503 });
  } finally {
    clearTimeout(timeout);
  }
}
