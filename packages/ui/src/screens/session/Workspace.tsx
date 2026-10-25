import { memo, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { Tabs } from "../../design/Tabs.js";
import type { ReadSession } from "./SessionHeader.js";
import { PipelineTab } from "./PipelineTab.js";
import { PlanTab } from "./PlanTab.js";
import { TestsTab } from "./TestsTab.js";
import { ChangesTab } from "./ChangesTab.js";
import { PullRequestTab } from "./PullRequestTab.js";
import { workspaceTask, type ReadTask, type CommentOnPart } from "./workspace-types.js";
interface WorkspaceView { session: ReadSession; task: ReadTask | undefined }
export const SESSION_TABS = [
 { value: "pipeline", label: "Pipeline", available: () => true },
 { value: "plan", label: "Plan", available: (view: WorkspaceView) => view.task?.workflow?.planContent !== undefined },
 { value: "tests", label: "Tests", available: (view: WorkspaceView) => view.task?.e2ePresentation !== undefined || view.task?.workflow?.verification !== undefined },
 { value: "changes", label: "Changes", available: (view: WorkspaceView) => view.task?.changedFiles !== undefined },
 { value: "pull-request", label: "Pull request", available: (view: WorkspaceView) => (view.task?.pullRequests?.length ?? 0) > 0 },
] as const;
export const Workspace = memo(function Workspace({ session, onComment }: { session: ReadSession; onComment?: CommentOnPart | undefined }) {
 const location = useLocation(), navigate = useNavigate(), task = useMemo(() => workspaceTask(session), [session]), view = { session, task };
 const tabs = SESSION_TABS.filter(tab => tab.available(view)), requested = location.hash.slice(1), selected = tabs.find(tab => tab.value === requested)?.value ?? "pipeline";
 const items = tabs.map(tab => ({ ...tab, content: tab.value === "pipeline" ? <PipelineTab session={session} task={task} onComment={onComment} /> : task === undefined ? null : tab.value === "plan" ? <PlanTab session={session} task={task} onComment={onComment} /> : tab.value === "tests" ? <TestsTab task={task} /> : tab.value === "changes" ? <ChangesTab session={session} task={task} onComment={onComment} /> : <PullRequestTab task={task} /> }));
 return <Tabs label="Session workspace" value={selected} onValueChange={value => { if (tabs.some(tab => tab.value === value)) void navigate({ pathname: location.pathname, search: location.search, hash: "#" + value }, { replace: true, preventScrollReset: true }); }} items={items} />;
});
