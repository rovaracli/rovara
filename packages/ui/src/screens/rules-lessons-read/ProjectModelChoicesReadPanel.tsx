import { EffectiveStageModelSchema } from "@agentx/contracts/web";
import { useAreaRead, useReadContext } from "./ReadEntry.js";
import { ReadState } from "./ReadState.js";
import { Block, Held, readAt } from "./parts.js";
import { Link } from "react-router";
import { DataTable } from "../../design/DataTable.js";
const decided: Record<string, string> = { rovara: "Rovara default", company: "Company default", project: "This project’s rule", person: "A person’s choice" };
/** "claude-opus-5-5" as "Claude Opus 5.5" when the read names no label for the model. */
function plain(modelId: string): string {
 const parts = modelId.split(/[-_.]/).filter(Boolean), numbers = parts.filter(part => /^\d+$/.test(part) && part.length < 3), words = parts.filter(part => !numbers.includes(part) && !/^\d{6,}$/.test(part));
 const name = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
 return numbers.length === 0 ? name : name + " " + numbers.join(".");
}
export function ProjectModelChoicesReadPanel({ project }: { project: string }) {
 const { api } = useReadContext(), read = useAreaRead([project, "models"], () => api.models(project));
 return <Block id="g4-models" title="The model each stage uses" meta={<>In force now, for tasks of {project}. {readAt(read.dataUpdatedAt)}</>} className="g4-models"><ReadState read={read} scope="page" refName="PROJECT-MODELS">{data => {
  if (data.stages.length === 0) return <Held>No stage choices were returned. We can&#8217;t tell yet which models apply.</Held>;
  const order = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"], rank = (stage: string) => order.includes(stage) ? order.indexOf(stage) : order.length;
  const rows = [...data.stages].sort((a, b) => rank(a.stage) - rank(b.stage)).map(row => ({ row, effective: EffectiveStageModelSchema.safeParse(row.effective) }));
  const name = (entry: (typeof rows)[number]) => { if (!entry.effective.success) return ""; const model = entry.effective.data.model, found = entry.row.candidates.find(candidate => candidate.model.provider === model.provider && candidate.model.modelId === model.modelId); return found?.label ?? plain(model.modelId); };
  return <><DataTable caption="Stage models" rows={rows} rowKey={entry => entry.row.stage} columns={[
   { key: "stage", title: "Stage", render: ({ row }) => <strong className="g4-stage">{row.stage.replaceAll("_", " ")}</strong> },
   { key: "model", title: "Model in force", render: entry => entry.effective.success ? <span className="g4-model"><span>{name(entry)}</span>{entry.effective.data.thinkingLevel !== null && <small>Thinking: {entry.effective.data.thinkingLevel}</small>}</span> : entry.row.notApplicable === true ? <span className="g4-na">No model for this step.</span> : <span className="g4-quiet">We can&#8217;t tell yet which model can run this step.</span> },
   { key: "from", title: "Comes from", render: ({ effective }) => effective.success ? <span>{decided[effective.data.decidedBy] ?? "Can’t tell yet"}</span> : <span className="g4-na">Not applicable</span> },
  ]} /><p className="g4-quiet g4-table-note">A project rule replaces the default for this project only. A stage that is off in this project&#8217;s rules is not listed. <Link to="/app/admin/ai-spending#ai-models">AI models for each step</Link> are managed for the company.</p></>;
 }}</ReadState></Block>;
}
