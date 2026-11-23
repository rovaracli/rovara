import { servedReadState } from "../../api/served-read.js";
import { useAreaRead, useReadContext } from "./ReadEntry.js";
import { ReadState } from "./ReadState.js";
import { RuleHistoryRail } from "./RuleHistoryReadPanel.js";
import { Block, Fact, Held, Row, Rows } from "./parts.js";
import { VisibleText } from "../../design/VisibleText.js";
import { Link } from "react-router";
import { stageDomId } from "../project/stage-dom-id.js";
import { LearningSection } from "../project/LearningSection.js";
import { NewerRovaraCodeNotice } from "../project/NewerRovaraCodeNotice.js";
// These are reported playbook values, not inferred company defaults or task receipts.
const designModes: Record<string, string> = { always: "On for new tasks", auto: "When the task needs design decisions", never: "Off for new tasks" };
/** The Design review row of the rules: the current playbook value, or one honest can't-tell-yet line. */
function DesignReviewRow({ project }: { project: string }) {
 const { api } = useReadContext(), read = useAreaRead([project, "playbook"], () => api.playbook(project));
 return <Row label="Design review" summary="Applies to new tasks">
  {servedReadState(read).data === undefined && (read.isError || read.failureCount > 0) && <Held>We can&#8217;t tell yet. The current setting could not be read.</Held>}
  <ReadState read={read} refName="PLAYBOOK">{data => data.designReviewAllowed === false ? <Fact>Not enabled for this company.</Fact> : data.playbook.designReview === undefined ? <Held>We can&#8217;t tell yet. No current setting was returned.</Held> : designModes[data.playbook.designReview.mode] === undefined ? <Held>We can&#8217;t tell yet. This setting is not supported here.</Held> : <Fact>{designModes[data.playbook.designReview.mode]}</Fact>}</ReadState>
  <p className="g4-quiet">Already-started tasks keep the choices they started with.</p>
 </Row>;
}
const sources: Record<string, string> = { rovara: "Rovara default", company: "Company", project: "Project" };
const source = (key: string) => sources[key] ?? "Source: can’t tell yet";
/** Rules: the project's process as rows, with the served rule versions beside them (below them on a phone). */
export function ProjectHowWeWorkReadScreen({ project, repository }: { project: string; repository?: { fullName: string; defaultBranch: string } | undefined }) {
 const { api } = useReadContext(), read = useAreaRead([project, "how"], () => api.how(project));
 return <ReadState read={read} scope="page" refName="PROJECT-HOW">{data => { const notes = new Set<string>();return <div className="g4-split">
  <Block id="g4-rules" title="Rules for every task in this project" meta={<>{data.process.kind === "builtin" ? "Rovara Code defaults" : data.process.kind === "project_process" ? "Project process" : "Process: can’t tell yet"}{data.process.version !== undefined && <> · Version {data.process.version}</>}</>}>
   {data.process.update !== undefined && <div className="g4-newer"><NewerRovaraCodeNotice update={data.process.update} agentId={undefined} canEdit={false} disabled onMoved={async () => undefined} /></div>}
   <Rows>
    <Row label="Project rules" summary={data.rules[0] === undefined ? "No project rules were returned." : data.rules[0].value}>{data.rules.length === 0 ? <Held>No project rules were returned.</Held> : data.rules.map((rule, i) => <Fact key={i} from={source(rule.source)}><VisibleText text={rule.value} /></Fact>)}</Row>
    {data.stages.map((stage, index) => <Row key={stage.id} headingId={stageDomId(stage.id) + "-title"} label={stage.name} {...(index === data.stages.findIndex(one => one.knows.instructions.length + one.checked.items.length + one.evidence.items.length > 0) ? { open: true } : {})} summary={stage.knows.instructions[0]?.value ?? (stage.checked.items[0] !== undefined ? "Check: " + stage.checked.items[0].value : stage.evidence.items[0] !== undefined ? "Evidence: " + stage.evidence.items[0].value : "No instructions returned for this step.")}>
     {stage.knows.instructions.length === 0 ? (stage.checked.items.length + stage.evidence.items.length === 0 && <Held>No instructions returned for this step.</Held>) : stage.knows.instructions.map((entry, i) => <Fact key={i} from={source(entry.source)}><VisibleText text={entry.value} /></Fact>)}
     {stage.knows.note !== undefined && !notes.has(stage.knows.note) && notes.add(stage.knows.note) && <p className="g4-quiet"><VisibleText text={stage.knows.note} /></p>}
     {stage.checked.items.map((item, i) => <Fact key={"check" + i}>Check: <VisibleText text={item.value} /></Fact>)}
     {stage.evidence.items.map((item, i) => <Fact key={"evidence" + i}>Evidence: <VisibleText text={item.value} /></Fact>)}
    </Row>)}
    <DesignReviewRow project={project} />
    <Row label="Plan self-check" summary="Can’t tell yet"><Held>We can&#8217;t tell yet. This read does not report the setting for new tasks.</Held></Row>
    <Row label="Instructions from the repo" summary="Can’t tell yet"><Held>We can&#8217;t tell yet which instruction files or skills were found in this repo.</Held><p className="g4-quiet">The current process read does not report file paths, scopes or scan results.</p></Row>
   </Rows>
   <p className="g4-links"><Link to="/app/admin/ai-spending#ai-models">AI models for each step</Link> are managed for the company. {repository === undefined ? "To change these rules, edit .rovara/playbook.yaml in your repo." : <>To change these rules, <a href={`https://github.com/${repository.fullName}/blob/${encodeURIComponent(repository.defaultBranch)}/.rovara/playbook.yaml`} target="_blank" rel="noopener noreferrer">edit .rovara/playbook.yaml in your repo</a>.</>}</p>
   <p className="g4-quiet g4-foot">Models, spending limits and approvals remain in their existing homes. Company rules apply on top of these and can&#8217;t be loosened here.</p>
  </Block>
  <div className="g4-suggested"><LearningSection project={project} /></div>
  <RuleHistoryRail agentId={data.process.agentId} />
 </div>; }}</ReadState>;
}
