import type { WorkRow } from "../../api/work-read.js";
import { HeldState } from "../../design/HeldState.js";
import { StatusChip } from "../../design/StatusChip.js";

/** Status is bounded by the existing read projection. Readiness, a waiting person and runner liveness are not served here. */
export function WorkRowStatus({ row }: { row: WorkRow }) {
 if (row.task.detailUnread === true) return <HeldState />;
 if (row.task.workflow?.stage === "MERGED" || row.task.workflow?.outcome === "MERGED" || row.task.outcome === "MERGED" || row.task.pullRequests.some(pull => pull.state === "merged")) return <StatusChip state="merged" />;

 if (row.task.status === "FAILED") return <StatusChip state="failed" />;
 if (row.task.workflow?.state === "BLOCKED") return <StatusChip state="blocked" />;
 if (row.group === "you") return <StatusChip state="needs_you" />;
 if (row.task.status === "STARTING") return <StatusChip state="queued" />;
 if (row.task.outcome === "ANSWERED" || row.task.workflow?.outcome === "ANSWERED") return <StatusChip state="done" />;
 if (row.tone === "run") return <StatusChip state={row.task.workflow?.stage === "VERIFY" || row.task.workflow?.stage === "REVIEW" ? "checking" : "running"} />;
 return <HeldState />;
}
