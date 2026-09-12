import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BatchRun, BatchSnapshot } from "./batch-types";

type CsvRow = Record<string, string>;
const corpusRoot = path.resolve(process.cwd(), "../..", "corpus");

function parseCsv(source: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  const [headers, ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function boolean(value: string): boolean | null {
  if (value === "") return null;
  return value === "True";
}

function number(value: string): number | null {
  return value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

export async function loadBatch(): Promise<BatchSnapshot> {
  const [measurementsSource, dtwSource, accountingSource] = await Promise.all([
    readFile(path.join(corpusRoot, "measurements.csv"), "utf8"),
    readFile(path.join(corpusRoot, "dtw_results.csv"), "utf8"),
    readFile(path.join(corpusRoot, "accounting.json"), "utf8"),
  ]);
  const dtwByRun = new Map(parseCsv(dtwSource).map((row) => [row.run_id, row]));
  const runs: BatchRun[] = parseCsv(measurementsSource).map((measurement) => {
    const dtw = dtwByRun.get(measurement.run_id);
    return {
      id: measurement.run_id,
      measurable: boolean(measurement.measurable) === true,
      rulesPass: boolean(measurement.rules_pass),
      triageReason: measurement.triage_reason,
      needsAttention: boolean(measurement.needs_attention) === true,
      dtw: number(dtw?.dtw ?? ""),
      ruleDipMv: number(measurement.rule_dip_mV),
      ruleSettleUs: number(measurement.rule_settle_us),
      finalErrorMv: number(measurement.final_error_mV),
      wobbleCount: number(measurement.wobble_count),
      durationActualMs: number(measurement.duration_actual_ms),
    };
  });
  runs.sort((left, right) => {
    if (left.measurable !== right.measurable) return left.measurable ? 1 : -1;
    if (left.needsAttention !== right.needsAttention) return left.needsAttention ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  const accounting = JSON.parse(accountingSource) as Record<string, number>;
  return {
    accounting: { launched: accounting.launched, analysed: accounting.analysed, failed: accounting.failed },
    runs,
  };
}
