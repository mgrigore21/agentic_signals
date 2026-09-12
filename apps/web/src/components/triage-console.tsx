"use client";

import { useEffect, useMemo, useState } from "react";
import type { BatchSnapshot, Dismissal } from "@/lib/batch-types";

function ruleVerdict(value: boolean | null) {
  if (value === null) return "—";
  return value ? "pass" : "fail";
}

function dtwValue(value: number | null) {
  return value === null ? "—" : value.toFixed(3);
}

function evidenceValue(value: number | null, unit = "", limit?: number) {
  if (value === null) return "—";
  return `${value}${unit ? ` ${unit}` : ""}${limit === undefined ? "" : ` (limit ${limit})`}`;
}

export function TriageConsole({ batch }: { batch: BatchSnapshot }) {
  const [selectedId, setSelectedId] = useState(batch.runs[0]?.id ?? "");
  const [dismissals, setDismissals] = useState<Dismissal[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [explanationsLoading, setExplanationsLoading] = useState(true);
  const [explanationsUnavailable, setExplanationsUnavailable] = useState(false);
  useEffect(() => {
    void fetch("/api/dismissals").then((response) => response.ok ? response.json() : []).then(setDismissals).catch(() => setNotice("Dismissals could not be loaded."));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void fetch("/api/explain", { method: "POST", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Explanations unavailable.");
        return response.json() as Promise<unknown>;
      })
      .then((result) => {
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Explanations unavailable.");
        setExplanations(result as Record<string, string>);
      })
      .catch(() => setExplanationsUnavailable(true))
      .finally(() => { setExplanationsLoading(false); window.clearTimeout(timeout); });
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);
  const dismissedIds = useMemo(() => new Set(dismissals.map((dismissal) => dismissal.run_id)), [dismissals]);
  const visibleRuns = showDismissed ? batch.runs : batch.runs.filter((run) => !dismissedIds.has(run.id));
  const selectedRun = batch.runs.find((run) => run.id === selectedId);

  async function dismiss() {
    if (!selectedId || !reason.trim()) { setNotice("A one-line reason is required."); return; }
    setSaving(true); setNotice("");
    try {
      const response = await fetch("/api/dismissals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run_id: selectedId, reason: reason.trim() }) });
      const result: unknown = await response.json();
      if (!response.ok || !Array.isArray(result)) throw new Error("Could not save dismissal.");
      const next = result as Dismissal[];
      setDismissals(next); setReason(""); setNotice(`${selectedId} marked wrong.`);
      if (!showDismissed) setSelectedId(batch.runs.find((run) => run.id !== selectedId && !new Set(next.map((dismissal) => dismissal.run_id)).has(run.id))?.id ?? "");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save dismissal."); }
    finally { setSaving(false); }
  }
  return (
    <main className="ranked-shell">
      <header>
        <p className="ranked-eyebrow">OVERNIGHT TEST TRIAGE</p>
        <h1>Ranked runs</h1>
        <p>{showDismissed ? `Showing all ${batch.runs.length} runs.` : `${visibleRuns.length} active runs shown.`} The order is: no measurable result, then needs attention, then the remainder.</p>
      </header>
      <details className="explainer" open>
        <summary>What am I looking at?</summary>
        <div className="explainer-content">
          <div>
            <p>Every night, tests kick a power converter and record how its output voltage responds for 10 ms. A healthy response dips, recovers, and holds steady. Two automated rules check every test: how far it dipped, and how fast it recovered. Everything that clears both is normally never looked at again.</p>
            <p>How this console works, in order:</p>
            <ol>
              <li><strong>Measure.</strong> Every trace is turned into numbers: dip, recovery time, final level, movements after 3 ms, recorded length. Plain arithmetic, same answer every time.</li>
              <li><strong>Compare shapes.</strong> Each trace is matched against a reference built from the healthy ones (dynamic time warping). Anything far from the reference is flagged. This catches every hidden shape problem — a second dip, a settle to the wrong voltage, a flat line where the test never ran. The six traces below all cleared both rules and were all caught here.</li>
              <li><strong>Look beyond the shape.</strong> Shape comparison cannot see a duplicate (it's a perfectly healthy shape), a dead run (there's no shape at all), or the difference between a run that stopped early after settling and one whose solver aborted mid-test. Those come from the file hash, the recorded length, and the log line — not the curve.</li>
              <li><strong>The agent writes the reason.</strong> It reads the numbers, the shape score, and the log, and writes one sentence per flagged run saying what the evidence shows. It never says a run passed. It never invents a number.</li>
              <li><strong>The engineer decides.</strong> Every run stays in the list, ranked, never hidden. Any flag can be dismissed with a reason, and that reason is remembered.</li>
            </ol>
          </div>
          <img src="/plots/passes_but_wrong.png" alt="Six traces that cleared both rules but still look wrong" />
        </div>
      </details>
      <section className="accounting-banner" aria-label="Batch accounting">
        <strong>{batch.accounting.launched} launched = {batch.accounting.analysed} analysed + {batch.accounting.failed} no result</strong>
      </section>
      {explanationsLoading ? <p className="explanations-note">Generating explanations…</p> : null}
      {explanationsUnavailable ? <p className="explanations-note">explanations unavailable</p> : null}
      <button type="button" className="dismissed-toggle" onClick={() => setShowDismissed((current) => !current)}>{dismissedIds.size} dismissed{showDismissed ? " — hide dismissed" : " — show dismissed"}</button>
      <div className="ranked-layout">
        <div className="ranked-table-wrap">
          <table>
          <thead>
            <tr><th>Rank</th><th>run_id</th><th>rules_pass</th><th>triage_reason</th><th>dtw</th></tr>
          </thead>
          <tbody>
            {visibleRuns.map((run, index) => (
              <tr key={run.id} className={run.id === selectedId ? "is-selected" : ""} tabIndex={0} onClick={() => setSelectedId(run.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId(run.id); }}>
                <td>{index + 1}</td>
                <td><code>{run.id}</code></td>
                <td>{ruleVerdict(run.rulesPass)}</td>
                <td>{run.triageReason || "—"}{explanations[run.id] ? <p className="run-explanation">{explanations[run.id]}</p> : null}</td>
                <td>{dtwValue(run.dtw)}</td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
        <aside className="trace-preview" aria-live="polite">
          <p className="ranked-eyebrow">SELECTED RUN</p>
          <h2><code>{selectedId}</code></h2>
          <img src={`/plots/runs/${selectedId}.png`} alt={`Voltage trace for ${selectedId}`} />
          <div className="evidence-panel" aria-label="Selected run evidence">
            <p><strong>rules verdict:</strong> {selectedRun ? selectedRun.rulesPass === null ? "—" : selectedRun.rulesPass ? "cleared the rules" : "failed the rules" : "—"}</p>
            <p><strong>dip:</strong> {evidenceValue(selectedRun?.ruleDipMv ?? null, "mV", 150)}</p>
            <p><strong>recovered in:</strong> {evidenceValue(selectedRun?.ruleSettleUs ?? null, "µs", 2000)}</p>
            <p><strong>final level error:</strong> {evidenceValue(selectedRun?.finalErrorMv ?? null, "mV")}</p>
            <p><strong>movements after 3ms:</strong> {evidenceValue(selectedRun?.wobbleCount ?? null)}</p>
            <p><strong>recorded:</strong> {selectedRun?.durationActualMs === null || selectedRun?.durationActualMs === undefined || selectedRun?.durationRequestedMs === null || selectedRun?.durationRequestedMs === undefined ? "—" : `${selectedRun.durationActualMs} of ${selectedRun.durationRequestedMs} ms`}</p>
            <p><strong>DTW distance:</strong> {selectedRun?.dtw === null || selectedRun?.dtw === undefined ? "—" : `${dtwValue(selectedRun.dtw)} (threshold 4.8)`}</p>
          </div>
          <div className="dismissal-form">
            <label htmlFor="dismissal-reason">Why is this flag wrong?</label>
            <input id="dismissal-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="One-line reason" />
            <button type="button" onClick={() => void dismiss()} disabled={saving || !selectedId}>Mark wrong</button>
            {notice ? <p role="status">{notice}</p> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
