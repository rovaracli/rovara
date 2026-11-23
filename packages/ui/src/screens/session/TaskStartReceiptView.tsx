import type { ReactNode } from "react";

export type TaskStartPhase = {
 kind: "accepted" | "waiting-machine" | "ready" | "first-command";
 observedAt?: string;
};

type CurrentTaskStartPhase = TaskStartPhase["kind"];

type ConfirmedStart = {
 kind: "confirmed";
 request: { id: string; text: string; textKind?: "task-title" };
 /** A link to the task, for a receipt shown somewhere else; the task page itself passes none (the person is already there). */
 taskLink?: { href: string; label: string };
 currentPhase: CurrentTaskStartPhase;
 phases: readonly TaskStartPhase[];
 alreadyAccepted?: boolean;
};

type UnknownStart = {
 kind: "unknown";
 check: ReactNode;
};

export interface TaskStartReceiptViewProps {
 outcome: ConfirmedStart | UnknownStart;
}

const surfaceStyle = {
 display: "grid",
 gap: "var(--rv-space-4)",
 minWidth: 0,
 padding: "var(--rv-space-5)",
 border: "1px solid var(--rv-border)",
 borderRadius: "var(--rv-radius-md)",
 background: "var(--rv-bg-raised)",
} as const;

const phaseLabels: Record<TaskStartPhase["kind"], string> = {
 accepted: "Accepted",
 "waiting-machine": "Waiting for a machine",
 ready: "Machine ready",
 "first-command": "First command",
};

const currentLabels: Record<CurrentTaskStartPhase, { chip: string; heading: string }> = {
 accepted: { chip: "Accepted", heading: "Request accepted" },
 "waiting-machine": { chip: "Starting", heading: "Starting: waiting for a machine" },
 ready: { chip: "Ready", heading: "Machine ready" },
 "first-command": { chip: "Running", heading: "First command observed" },
};

const phaseDescriptions: Record<CurrentTaskStartPhase, string> = {
 accepted: "Rovara accepted this request. The next phase hasn't been reported here.",
 "waiting-machine": "Rovara accepted this request. No machine is reported ready yet.",
 ready: "Rovara reported that the machine is ready.",
 "first-command": "Rovara observed the first command.",
};

/** The post-send receipt only. Sending, checking and phase reads stay with the owning parent. */
export function TaskStartReceiptView({ outcome }: TaskStartReceiptViewProps) {
 if (outcome.kind === "unknown") {
  return <section aria-label="Task start receipt" data-testid="task-start-receipt" style={{ ...surfaceStyle, borderColor: "var(--rv-status-needs-you)" }}>
   <div style={{ display: "grid", gap: "var(--rv-space-2)" }}>
    <h2>Rovara didn't confirm this yet</h2>
    <p className="rv-muted">The start request was sent, but we didn't receive a readable confirmation.</p>
   </div>
   <div className="rv-banner rv-banner-warning" role="status">
    <p>No second start is sent from this receipt. Check whether Rovara accepted the first request.</p>
   </div>
   <div className="rv-actions">{outcome.check}</div>
  </section>;
 }

 const current = currentLabels[outcome.currentPhase];
 return <section aria-label="Task start receipt" data-testid="task-start-receipt" style={surfaceStyle}>
  <header style={{ display: "grid", gap: "var(--rv-space-2)", minWidth: 0 }}>
   <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--rv-space-3)", minWidth: 0 }}>
    <span className="rv-status-pill" data-tone={outcome.currentPhase === "first-command" ? "run" : outcome.currentPhase === "ready" ? "ok" : "wait"}>{current.chip}</span>
    <h2 style={{ margin: 0 }}>{current.heading}</h2>
   </div>
   <p className="rv-muted">{outcome.alreadyAccepted ? "This request already started a task." : phaseDescriptions[outcome.currentPhase]}</p>
   {outcome.taskLink !== undefined && <p><a href={outcome.taskLink.href}>{outcome.taskLink.label}</a></p>}
  </header>

  <ol aria-label="Observed task phases" style={{ display: "grid", gap: "var(--rv-space-3)", margin: 0, padding: 0, listStyle: "none" }}>
   {outcome.phases.map((phase, index) => <li key={`${phase.kind}-${index}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "var(--rv-space-3)", minWidth: 0, paddingBottom: "var(--rv-space-3)", borderBottom: "1px solid var(--rv-border)" }}>
    <span aria-hidden="true" style={{ flex: "0 0 auto", width: "0.65rem", height: "0.65rem", borderRadius: "50%", background: phase.kind === "first-command" ? "var(--rv-status-running)" : phase.kind === "ready" ? "var(--rv-status-done)" : "var(--rv-accent)" }} />
    <span style={{ minWidth: 0, fontWeight: 550 }}>{phaseLabels[phase.kind]}</span>
    {phase.observedAt !== undefined && <time style={{ marginLeft: "auto", color: "var(--rv-text-muted)", fontFamily: "var(--rv-font-mono)", fontSize: "var(--rv-font-sm)", whiteSpace: "nowrap" }}>{phase.observedAt}</time>}
    {phase.kind === "first-command" && <span className="rv-muted" style={{ flexBasis: "100%" }}>The task says Running from here.</span>}
   </li>)}
  </ol>

  <div style={{ display: "grid", gap: "var(--rv-space-2)", minWidth: 0 }}>
   <h3>{outcome.request.textKind === "task-title" ? "Recorded task title" : "What you asked for"}</h3>
   <p className="rv-surface rv-markdown" style={{ margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{outcome.request.text}</p>
   <p className="rv-muted" style={{ fontSize: "var(--rv-font-sm)" }}>{outcome.request.textKind === "task-title" ? "Showing the task title." : "This request is fixed after acceptance. Talk to the task or use its plan decision to change the work."}</p>
  </div>
 </section>;
}
