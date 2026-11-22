import "../../design/parts/shell-gallery.css";

export type TaskMarkKind = "done" | "running" | "next" | "attention" | "chat" | "chevron" | "lock" | "pause";
/** The shared shell's small state marks (done tick, running arc, next ring, attention, chat, chevron, lock); decorative, the row's words carry the state. */
export function TaskMark({ kind }: { kind: TaskMarkKind }) {
 return <svg className={`rv-ds-mark rv-ds-mark-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">{kind === "done" ? <path d="m5 12 4 4 10-10" /> : kind === "running" ? <path d="M12 4a8 8 0 1 1-8 8" /> : kind === "next" ? <circle cx="12" cy="12" r="8" /> : kind === "attention" ? <><circle cx="12" cy="12" r="9" /><path d="M12 6v8m0 2v2" /></> : kind === "pause" ? <path d="M9 6v12M15 6v12" /> : kind === "lock" ? <><rect x="6" y="10" width="12" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></> : kind === "chat" ? <path d="M4 4h16v12H9l-5 5V4Z" /> : <path d="m9 5 7 7-7 7" />}</svg>;
}
