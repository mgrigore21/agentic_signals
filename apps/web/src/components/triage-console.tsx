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

export function TriageConsole({ batch }: { batch: BatchSnapshot }) {
  const [selectedId, setSelectedId] = useState(batch.runs[0]?.id ?? "");
  const [dismissals, setDismissals] = useState<Dismissal[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [explanations, setExplanations] = useState<Record<string, string>>({});
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
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);
  const dismissedIds = useMemo(() => new Set(dismissals.map((dismissal) => dismissal.run_id)), [dismissals]);
  const visibleRuns = showDismissed ? batch.runs : batch.runs.filter((run) => !dismissedIds.has(run.id));

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
      <section className="accounting-banner" aria-label="Batch accounting">
        <strong>{batch.accounting.launched} launched = {batch.accounting.analysed} analysed + {batch.accounting.failed} no result</strong>
      </section>
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
