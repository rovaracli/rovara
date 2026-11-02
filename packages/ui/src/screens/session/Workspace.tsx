import { memo, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { Tabs } from "../../design/Tabs.js";
import type { ReadSession } from "./SessionHeader.js";
import { PipelineTab } from "./PipelineTab.js";
import { PlanTab } from "./PlanTab.js";
import { EvidenceTab } from "./EvidenceTab.js";
import { ChangesTab } from "./ChangesTab.js";
import { PullRequestTab } from "./PullRequestTab.js";
import { MergeSection } from "./MergeSection.js";
import { workspaceTask, type ReadTask, type CommentOnPart } from "./workspace-types.js";
interface WorkspaceView { session: ReadSession; task: ReadTask | undefined }
export const SESSION_TABS = [
 { value: "pipeline", label: "Pipeline", available: () => true },
 { value: "plan", label: "Plan", available: (view: WorkspaceView) => view.task?.workflow?.planContent !== undefined },
 { value: "tests", label: "Evidence", available: (view: WorkspaceView) => view.task?.e2ePresentation !== undefined || view.task?.workflow?.verification !== undefined || view.task?.evidence !== undefined },
 { value: "changes", label: "Changes", available: (view: WorkspaceView) => view.task?.changedFiles !== undefined },
 { value: "pull-request", label: "Pull request", available: (view: WorkspaceView) => (view.task?.pullRequests?.length ?? 0) > 0 },
] as const;
export const Workspace = memo(function Workspace({ session, onComment, section }: { session: ReadSession; onComment?: CommentOnPart | undefined; section?: number }) {
 const location = useLocation(), navigate = useNavigate(), task = useMemo(() => workspaceTask(session), [session]), view = { session, task };
 const prefix = section === undefined ? "" : "step-" + section + "-";
 const tabs = SESSION_TABS.filter(tab => tab.available(view)), requested = location.hash.startsWith("#" + prefix) ? location.hash.slice(1 + prefix.length) : "", selected = tabs.find(tab => tab.value === requested)?.value ?? "pipeline";
 const items = tabs.map(tab => ({ ...tab, content: tab.value === "pipeline" ? <PipelineTab session={session} task={task} onComment={onComment} /> : task === undefined ? null : tab.value === "plan" ? <PlanTab session={session} task={task} onComment={onComment} /> : tab.value === "tests" ? <EvidenceTab task={task} sessionId={session.sessionId} /> : tab.value === "changes" ? <ChangesTab session={session} task={task} onComment={onComment} /> : <PullRequestTab task={task} /> }));
 const merge = section === undefined && task?.merge !== undefined ? <MergeSection session={session} task={{ ...task, merge: task.merge }} /> : null;
 return <>{merge}<Tabs label={section === undefined ? "Session workspace" : "Evidence for step " + section} value={selected} onValueChange={value => { if (tabs.some(tab => tab.value === value)) void navigate({ pathname: location.pathname, search: location.search, hash: "#" + prefix + value }, { replace: true, preventScrollReset: true }); }} items={items} /></>;
});
