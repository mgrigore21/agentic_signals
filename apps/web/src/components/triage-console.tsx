"use client";

import { useEffect, useMemo, useState } from "react";
import type { BatchRun, BatchSnapshot, Dismissal } from "@/lib/batch-types";

type TriageOutcome = { flag: boolean; reason: string };

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

function compareDtw(left: BatchRun, right: BatchRun) {
  const difference = (right.dtw ?? -Number.MAX_VALUE) - (left.dtw ?? -Number.MAX_VALUE);
  return difference !== 0 ? difference : left.id.localeCompare(right.id);
}

export function TriageConsole({ batch }: { batch: BatchSnapshot }) {
  const [selectedId, setSelectedId] = useState(batch.runs[0]?.id ?? "");
  const [dismissals, setDismissals] = useState<Dismissal[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [isTraceExpanded, setIsTraceExpanded] = useState(false);
  const [triage, setTriage] = useState<Record<string, TriageOutcome>>({});
  const [triageState, setTriageState] = useState<"loading" | "ready" | "unavailable">("loading");
  useEffect(() => {
    void fetch("/api/dismissals").then((response) => response.ok ? response.json() : []).then(setDismissals).catch(() => setNotice("Dismissals could not be loaded."));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 95_000);
    void fetch("/api/triage", { method: "POST", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Triage unavailable.");
        return response.json() as Promise<unknown>;
      })
      .then((result) => {
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Triage unavailable.");
        setTriage(result as Record<string, TriageOutcome>); setTriageState("ready");
      })
      .catch(() => setTriageState("unavailable"))
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);
  const dismissedIds = useMemo(() => new Set(dismissals.map((dismissal) => dismissal.run_id)), [dismissals]);
  const rankedRuns = useMemo(() => [...batch.runs].sort((left, right) => {
    if (left.measurable !== right.measurable) return left.measurable ? 1 : -1;
    if (triageState === "ready" && triage[left.id]?.flag !== triage[right.id]?.flag) return triage[left.id]?.flag ? -1 : 1;
    return compareDtw(left, right);
  }), [batch.runs, triage, triageState]);
  const visibleRuns = showDismissed ? rankedRuns : rankedRuns.filter((run) => !dismissedIds.has(run.id));
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
        <p>{showDismissed ? `Showing all ${batch.runs.length} runs.` : `${visibleRuns.length} active runs shown.`} The order is: no measurable result, then agent flags by DTW distance, then the remainder by DTW distance.</p>
      </header>
      <details className="explainer" open>
        <summary>What am I looking at?</summary>
        <div className="explainer-content">
          <div>
            <p>Every night, tests kick a power converter and record how its output voltage responds for 10 ms. A healthy response dips, recovers, and holds steady. Two automated rules check every test: how far it dipped, and how fast it recovered. Everything that clears both is normally never looked at again.</p>
            <p>How this console works, in order:</p>
            <ol>
              <li><strong>Measure.</strong> Every trace is turned into numbers: dip, recovery time, final level, movements after 3 ms, recorded length. Plain arithmetic, same answer every time.</li>
              <li><strong>Compare shapes.</strong> Each trace is matched against a reference built from the healthy ones (dynamic time warping) and gets a distance score. Above 4.8 is far from normal. This catches every hidden shape problem — a second dip, a settle to the wrong voltage, a flat line where the test never ran. The six traces below all cleared both rules and all score far from the reference.</li>
              <li><strong>Look beyond the shape.</strong> Shape comparison cannot see a duplicate (it's a perfectly healthy shape), a dead run (there's no shape at all), or the difference between a run that stopped early after settling and one whose solver aborted mid-test. That evidence comes from the file hash, the recorded length, and the log line — not the curve.</li>
              <li><strong>The agent decides and explains.</strong> For every run it receives the numbers, the shape score, the file facts, and the log line — and nothing else. No labels, no pre-written verdicts. It decides whether an engineer should look, and writes one sentence citing the evidence. It never says a run passed. It never invents a number.</li>
              <li><strong>Ranking.</strong> The list is ordered so the most urgent is first:
                <ul>
                  <li>runs with no usable result come first — a missing result is worse than a bad one, because nothing is known about that test;</li>
                  <li>then every run the agent flagged, ordered by shape distance, largest first;</li>
                  <li>then everything else, same order. Nothing is removed. The list goes all the way to 150.</li>
                </ul>
              </li>
              <li><strong>The engineer decides.</strong> Any flag can be dismissed with a reason. The reason is stored, survives a refresh, and the next person can see it.</li>
            </ol>
            <p>If the agent is unavailable, the list falls back to shape distance alone, and says so.</p>
          </div>
          <img src="/plots/passes_but_wrong.png" alt="Six traces that cleared both rules but still look wrong" />
        </div>
      </details>
      <section className="accounting-banner" aria-label="Batch accounting">
        <strong>{batch.accounting.launched} launched = {batch.accounting.analysed} analysed + {batch.accounting.failed} no result</strong>
      </section>
      {triageState === "loading" ? <p className="explanations-note">Triaging all 150 runs…</p> : null}
      {triageState === "unavailable" ? <p className="explanations-note">reasons unavailable</p> : null}
      <button type="button" className="dismissed-toggle" onClick={() => setShowDismissed((current) => !current)}>{dismissedIds.size} dismissed{showDismissed ? " — hide dismissed" : " — show dismissed"}</button>
      <div className="ranked-layout">
        <div className="ranked-table-wrap">
          <table>
          <thead>
            <tr><th>Rank</th><th>run_id</th><th>rules_pass</th><th>reason</th><th>dtw</th></tr>
          </thead>
          <tbody>
            {visibleRuns.map((run, index) => (
              <tr key={run.id} className={run.id === selectedId ? "is-selected" : ""} tabIndex={0} onClick={() => setSelectedId(run.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId(run.id); }}>
                <td>{index + 1}</td>
                <td><code>{run.id}</code></td>
                <td>{ruleVerdict(run.rulesPass)}</td>
                <td>{triage[run.id]?.reason ?? (triageState === "unavailable" ? "reasons unavailable" : "triaging…")}</td>
                <td>{dtwValue(run.dtw)}</td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
        <aside className="trace-preview" aria-live="polite">
          <p className="ranked-eyebrow">SELECTED RUN</p>
          <h2><code>{selectedId}</code></h2>
          <button type="button" className="trace-image-button" onClick={() => setIsTraceExpanded(true)} aria-label={`Expand voltage trace for ${selectedId}`}>
            <img src={`/plots/runs/${selectedId}.png`} alt={`Voltage trace for ${selectedId}`} />
          </button>
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
      {isTraceExpanded ? <div className="trace-lightbox" role="dialog" aria-modal="true" aria-label={`Expanded voltage trace for ${selectedId}`} onClick={() => setIsTraceExpanded(false)}>
        <button type="button" className="trace-lightbox-close" onClick={() => setIsTraceExpanded(false)} aria-label="Close expanded trace">×</button>
        <img src={`/plots/runs/${selectedId}.png`} alt={`Voltage trace for ${selectedId}`} onClick={(event) => event.stopPropagation()} />
      </div> : null}
    </main>
  );
}
