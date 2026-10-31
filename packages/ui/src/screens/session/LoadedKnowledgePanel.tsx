import { useState } from "react";
import type { LoadedKnowledgeItem } from "@agentx/contracts/web";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useLoadedKnowledge, useLoadedKnowledgeText } from "../../api/loaded-knowledge.js";
import { ApiError } from "../../api/errors.js";
import { SKILL_SKIP, STAGE_TITLES, budgetWords, itemWords, kilobytes, modeWords, textRefusal } from "./loaded-knowledge-text.js";

/** "What the agent loaded": one closed section on the Pipeline tab. It reads nothing until it is opened, and shows references; rule text is fetched per file on request. */
export function LoadedKnowledgePanel({ taskId }: { taskId: string }) {
 const [open, setOpen] = useState(false);
 return <details className="rv-loaded-knowledge" onToggle={event => { setOpen(event.currentTarget.open); }}><summary>What the agent loaded</summary>{open && <LoadedKnowledgeBody taskId={taskId} />}</details>;
}

function LoadedKnowledgeBody({ taskId }: { taskId: string }) {
 const query = useLoadedKnowledge(taskId, true);
 const [target, setTarget] = useState<{ operationId: string; stage: string; index: number } | undefined>();
 if (query.isPending) return <p className="rv-muted" role="status">Loading</p>;
 if (query.isError) return <p className="rv-muted" role="alert">This could not be loaded right now.</p>;
 const stages = query.data.stages;
 if (stages.length === 0) return <p className="rv-muted">Nothing was recorded for this task.</p>;
 return <div>
  {stages.map(record => {
   const manifest = record.manifest;
   const loaded = manifest.items.map((item, index) => ({ item, index })).filter(entry => entry.item.status === "loaded");
   const rest = manifest.items.map((item, index) => ({ item, index })).filter(entry => entry.item.status !== "loaded");
   return <section key={record.operationId + record.stage} aria-label={"What " + STAGE_TITLES[manifest.stage] + " loaded"}>
    <h4>{"What " + STAGE_TITLES[manifest.stage] + " loaded"}{manifest.metaRepo !== undefined && <span className="rv-muted">{" (meta repo "}<VisibleText text={manifest.metaRepo.name} />{" @ " + manifest.metaRepo.knowledgeCommit.slice(0, 7) + ")"}</span>}</h4>
    <ul className="rv-loaded-list" aria-label="Rules loaded">{loaded.map(({ item, index }) => <KnowledgeRow key={index} taskId={taskId} record={record} item={item} index={index} target={target} setTarget={setTarget} />)}</ul>
    {rest.length > 0 && <details><summary>{String(rest.length + manifest.omitted.skipped + manifest.omitted.available) + " found and not loaded"}</summary><ul className="rv-loaded-list" aria-label="Rules not loaded">{rest.map(({ item, index }) => <KnowledgeRow key={index} taskId={taskId} record={record} item={item} index={index} target={target} setTarget={setTarget} />)}</ul></details>}
    {manifest.skills.length > 0 && <p>Skills: {manifest.skills.map(skill => <span key={skill.path}><VisibleText text={skill.path.slice(skill.path.lastIndexOf("/") + 1)} /> <span className="rv-muted">{"(" + skill.digest.slice(0, 8) + ", meta repo, no tools) "}</span></span>)}</p>}
    {manifest.skippedSkills.length > 0 && <p className="rv-muted">{manifest.skippedSkills.map(skill => skill.path + ": " + (SKILL_SKIP[skill.reason] ?? "Left out")).join("; ")}</p>}
    {manifest.sources.length > 0 && <p>Sources used: {manifest.sources.map(source => source.label + " (" + String(source.count) + ")").join(", ")}</p>}
    <p className="rv-muted">{budgetWords(manifest.budget)}</p>
   </section>;
  })}
 </div>;
}

type Target = { operationId: string; stage: string; index: number } | undefined;
function KnowledgeRow({ taskId, record, item, index, target, setTarget }: { taskId: string; record: { operationId: string; stage: string }; item: LoadedKnowledgeItem; index: number; target: Target; setTarget: (value: Target) => void }) {
 const mine = target?.operationId === record.operationId && target.stage === record.stage && target.index === index;
 const label = item.path ?? item.name ?? "Rule";
 const canShow = item.status !== "available" && item.repo !== undefined && item.path !== undefined && item.fileDigest !== undefined;
 return <li>
  <span aria-label={item.status === "loaded" ? "Loaded" : "Not loaded"}>{item.status === "loaded" ? "Loaded" : "Not loaded"}</span>{" "}
  {item.repo !== undefined && <span className="rv-muted"><VisibleText text={item.repo} />{" / "}</span>}<VisibleText text={label} />{" "}
  <span className="rv-muted">{[modeWords(item), item.bytes > 0 ? kilobytes(item.bytes) : "", itemWords(item)].filter(part => part !== "").join(" · ")}</span>
  {canShow && <Button variant="quiet" aria-label={"Show the text of " + label} aria-expanded={mine} onClick={() => { setTarget(mine ? undefined : { operationId: record.operationId, stage: record.stage, index }); }}>{mine ? "Hide text" : "Show text"}</Button>}
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
