import { Suspense, lazy, useState } from "react";
import type { LoadedKnowledgeItem } from "@agentx/contracts/web";
import { Link } from "react-router";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useLoadedKnowledge, useLoadedKnowledgeText } from "../../api/loaded-knowledge.js";
import { ApiError } from "../../api/errors.js";
import { SKILL_SKIP, STAGE_TITLES, budgetWords, itemWords, kilobytes, modeWords, textRefusal } from "./loaded-knowledge-text.js";

// The lessons list is its own chunk: it is read only when the panel is opened.
const LoadedLessons = lazy(async () => ({ default: (await import("./LoadedLessons.js")).LoadedLessons }));

/** "What the agent loaded": one closed section on the Pipeline tab. It reads nothing until it is opened, and shows references; rule text is fetched per file on request. */
export function LoadedKnowledgePanel({ taskId, project }: { taskId: string; project?: string }) {
 const [open, setOpen] = useState(false);
 return <details className="rv-loaded-knowledge" onToggle={event => { setOpen(event.currentTarget.open); }}><summary>What the agent loaded</summary>{open && <LoadedKnowledgeBody taskId={taskId} project={project} />}</details>;
}

function LoadedKnowledgeBody({ taskId, project }: { taskId: string; project: string | undefined }) {
 return <><RulesBody taskId={taskId} project={project} /><Suspense fallback={null}><LoadedLessons taskId={taskId} /></Suspense></>;
}

/** UX-4b: learning Off for the task's project is said in its own code; the panel explains it and offers to turn it on in the project's Lessons tab, where a maintainer can. */
export function LearningOffNote({ project, locked }: { project: string | undefined; locked: boolean }) {
 return <div role="status"><p className="rv-muted">{locked ? "What the agent loaded isn't recorded for this task: your company keeps learning off for this project." : "What the agent loaded isn't recorded for this task because learning is off for its project. Turn learning on to record what each task loads from now on."}</p>{!locked && project !== undefined && <Link to={"/app/projects/" + encodeURIComponent(project) + "?tab=lessons"}>Turn learning on for this project</Link>}</div>;
}

function RulesBody({ taskId, project }: { taskId: string; project: string | undefined }) {
 const query = useLoadedKnowledge(taskId, true);
 const [target, setTarget] = useState<{ operationId: string; stage: string; index: number } | undefined>();
 if (query.isPending) return <p className="rv-muted" role="status">Loading</p>;
 // 404: the record is not served for this task (the project's learning is off, or the install does not keep it). That is not a failed load, so it is not shown as one.
 if (query.isError && query.error instanceof ApiError && (query.error.code === "LEARNING_OFF" || query.error.code === "LEARNING_LOCKED")) return <LearningOffNote project={project} locked={query.error.code === "LEARNING_LOCKED"} />;
 if (query.isError) return query.error instanceof ApiError && query.error.status === 404
  ? <p className="rv-muted" role="status">{"What the agent loaded is not recorded for this task: this installation doesn't keep it, or learning was off when this task ran."}</p>
  : <p className="rv-muted" role="alert">This could not be loaded right now.</p>;
 const stages = query.data.stages;
 if (stages.length === 0) return <p className="rv-muted">Nothing was recorded for this task. Tasks that ran before loading was recorded, or while it was off, have no record.</p>;
 return <div>
  {stages.map(record => {
   const manifest = record.manifest;
   const loaded = manifest.items.map((item, index) => ({ item, index })).filter(entry => entry.item.status === "loaded");
   const rest = manifest.items.map((item, index) => ({ item, index })).filter(entry => entry.item.status !== "loaded");
   const title = STAGE_TITLES[manifest.stage] + (record.role === undefined ? "" : record.role === "CRITIC" ? " (code review)" : " (security review)");
   return <section key={record.operationId + record.stage + (record.role ?? "")} aria-label={"What " + title + " loaded"}>
    <h4>{"What " + title + " loaded"}{manifest.metaRepo !== undefined && <span className="rv-muted">{" (meta repo "}<VisibleText text={manifest.metaRepo.name} />{" @ " + manifest.metaRepo.knowledgeCommit.slice(0, 7) + ")"}</span>}</h4>
    <ul className="rv-loaded-list" aria-label="Rules loaded">{loaded.map(({ item, index }) => <KnowledgeRow key={index} taskId={taskId} record={record} item={item} index={index} target={target} setTarget={setTarget} />)}</ul>
    {rest.length > 0 && <details><summary>{String(rest.length + manifest.omitted.skipped + manifest.omitted.available) + " found and not loaded"}</summary><ul className="rv-loaded-list" aria-label="Rules not loaded">{rest.map(({ item, index }) => <KnowledgeRow key={index} taskId={taskId} record={record} item={item} index={index} target={target} setTarget={setTarget} />)}</ul></details>}
    {manifest.skills.length > 0 && <p>Skills: {manifest.skills.map(skill => <span key={skill.path}><VisibleText text={skill.path.slice(skill.path.lastIndexOf("/") + 1)} /> <span className="rv-muted">{"(" + skill.digest.slice(0, 8) + ", meta repo, no tools) "}</span></span>)}</p>}
    {manifest.skippedSkills.length > 0 && <p className="rv-muted">{manifest.skippedSkills.map(skill => skill.path + ": " + (SKILL_SKIP[skill.reason] ?? "Left out")).join("; ")}</p>}
    {manifest.sources.length > 0 && <p>Sources used: {manifest.sources.map(source => source.label + " (" + String(source.count) + ")").join(", ")}</p>}
    {manifest.recordTruncated === true && <p className="rv-muted" role="note">This list was shortened to fit. Rules that were loaded are shown first.</p>}
    <p className="rv-muted">{budgetWords(manifest.budget)}</p>
   </section>;
  })}
 </div>;
}

type Target = { operationId: string; stage: string; index: number } | undefined;
function KnowledgeRow({ taskId, record, item, index, target, setTarget }: { taskId: string; record: { operationId: string; stage: string; role?: "CRITIC" | "SECURITY" | undefined }; item: LoadedKnowledgeItem; index: number; target: Target; setTarget: (value: Target) => void }) {
 const stageKey = record.role === undefined ? record.stage : record.stage + "." + record.role;
 const mine = target?.operationId === record.operationId && target.stage === stageKey && target.index === index;
 const label = item.path ?? item.name ?? "Rule";
 const canShow = item.status !== "available" && item.repo !== undefined && item.path !== undefined && item.fileDigest !== undefined;
 return <li>
  <span aria-label={item.status === "loaded" ? "Loaded" : "Not loaded"}>{item.status === "loaded" ? "Loaded" : "Not loaded"}</span>{" "}
  {item.repo !== undefined && <span className="rv-muted"><VisibleText text={item.repo} />{" / "}</span>}<VisibleText text={label} />{" "}
  <span className="rv-muted">{[modeWords(item), item.bytes > 0 ? kilobytes(item.bytes) : "", itemWords(item)].filter(part => part !== "").join(" · ")}</span>
  {canShow && <Button variant="quiet" aria-label={"Show the text of " + label} aria-expanded={mine} onClick={() => { setTarget(mine ? undefined : { operationId: record.operationId, stage: stageKey, index }); }}>{mine ? "Hide text" : "Show text"}</Button>}
  {mine && <RuleText taskId={taskId} target={target} />}
 </li>;
}

function RuleText({ taskId, target }: { taskId: string; target: Target }) {
 const query = useLoadedKnowledgeText(taskId, target);
 if (query.isPending) return <p className="rv-muted" role="status">Loading the text</p>;
 if (query.isError) return <p className="rv-muted" role="alert">{query.error instanceof ApiError && query.error.status === 403 ? query.error.message : "The text could not be loaded right now."}</p>;
 const data = query.data;
 if (!data.available) return <p className="rv-muted">{textRefusal(data.reason)}</p>;
 return <pre className="rv-evidence-text"><VisibleText text={data.text} />{data.truncated ? "\n[Shortened]" : ""}</pre>;
}
