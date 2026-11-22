import type { CSSProperties } from "react";

type DraftIdentity = { companyId: string; personId: string };
type DraftSubject = DraftIdentity & { taskId: string };
type DraftState =
  | { kind: "unknown" }
  | (DraftSubject & { kind: "restored"; text: string; operation: "unsent" | "sending" | "sent" | "unknown" });

export type TaskDraftReturnViewProps = {
	identity: DraftIdentity | undefined;
	subject: DraftSubject | undefined;
  state: DraftState;
};

const panel: CSSProperties = {
  display: "grid",
  gap: "var(--rv-space-2, 8px)",
  minWidth: 0,
  padding: "var(--rv-space-4, 16px)",
  border: "1px solid var(--rv-border, #d5d9df)",
  borderRadius: "var(--rv-radius-md, 12px)",
  background: "var(--rv-bg-raised, #fff)",
};

const draftText: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

function isCurrentScope(props: TaskDraftReturnViewProps): props is TaskDraftReturnViewProps & {
	identity: DraftIdentity;
	subject: DraftSubject;
	state: Extract<DraftState, { kind: "restored" }>;
} {
  const { identity, subject, state } = props;
  return identity !== undefined && subject !== undefined &&
    identity.companyId.length > 0 && identity.personId.length > 0 && subject.taskId.length > 0 &&
    identity.companyId === subject.companyId && identity.personId === subject.personId &&
    state.kind === "restored" && state.companyId === subject.companyId &&
    state.personId === subject.personId && state.taskId === subject.taskId;
}

/** Inline draft-return presentation. The owner supplies current identity, subject and authorized display facts. */
export function TaskDraftReturnView(props: TaskDraftReturnViewProps) {
  if (!isCurrentScope(props)) {
    return <section className="rv-task-draft-return" aria-label="Task draft" style={panel}>
      <h3>Draft</h3>
      <p style={draftText}>Draft availability is unknown.</p>
    </section>;
  }

  if (props.state.text === "") return null;

  const operationLabel = props.state.operation === "unsent" ? "Not sent" :
    props.state.operation === "sending" ? "Sending" :
    props.state.operation === "unknown" ? "Not confirmed" : "Sent";

  return <section className="rv-task-draft-return" aria-label="Task draft" data-operation={props.state.operation} style={panel}>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "var(--rv-space-2, 8px)" }}>
      <h3 style={{ margin: 0 }}>Draft</h3>
      <span aria-label="Draft status" style={{ color: "var(--rv-text-muted, #59616e)", fontSize: "var(--rv-font-sm, 14px)" }}>{operationLabel}</span>
    </div>
    <p style={draftText}>{props.state.text}</p>
  </section>;
}
