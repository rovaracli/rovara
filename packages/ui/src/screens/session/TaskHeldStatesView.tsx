import { Button } from "../../design/Button.js";
import { HeldState } from "../../design/HeldState.js";
import { useTaskPagePolicy } from "./task-page-policy.js";

/** Unsupported observations stay quiet. The owning callback only re-reads recorded facts. */
export function TaskHeldStatesView({ page, onCheck, label }: { page: "session" | "running" | "talk" | "plan" | "proof"; onCheck: () => void; /** Names what is unknown, so the chip never stands alone. */ label?: string }) {
 const compact = useTaskPagePolicy() !== undefined;
 return <div className="rv-task-held" data-testid={"held-" + page} aria-label={page + " unavailable observations"}>
  {label !== undefined && <span className="rv-task-held-label">{label}</span>}<HeldState /><Button variant="quiet" onClick={onCheck} {...(compact ? { "aria-label": "Check recorded facts" } : {})}>{compact ? "Check" : "Check recorded facts"}</Button>
 </div>;
}
