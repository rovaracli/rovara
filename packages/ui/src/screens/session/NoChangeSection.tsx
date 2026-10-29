import { NO_CHANGE_CHOICES_NO_THREAD, NO_CHANGE_CHOICES_PAGE, NO_CHANGE_COMMANDS_HEADER, NO_CHANGE_FOUND_HEADER, NO_CHANGE_NEEDED_LINE, NO_CHANGE_NO_CONCLUSION_LEAD, isNoCodeChangedReason, noChangeHasThread } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import type { ReadTask } from "./workspace-types.js";
// A coding run that ended with no code change: what the agent found (the broker redacted, bounded and filtered it: no output of a command that reads the environment or a secret file, secret-looking values hidden),
// the commands it ran with their output, then what was not done and the two ways on. Plain text only.
export function NoChangeSection({ task }: { task: ReadTask }) {
 const workflow = task.workflow;
 if (workflow === undefined || workflow.state !== "BLOCKED" || !isNoCodeChangedReason(workflow.blockReason)) return null;
 const findings = workflow.noChangeFindings, choices = noChangeHasThread(task.share) ? NO_CHANGE_CHOICES_PAGE : NO_CHANGE_CHOICES_NO_THREAD;
 if (findings === undefined) return <section aria-label="What the agent found"><p><VisibleText text={NO_CHANGE_NEEDED_LINE} /></p><p className="rv-muted"><VisibleText text={choices} /></p></section>;
 const lead = findings.conclusion === undefined ? NO_CHANGE_NO_CONCLUSION_LEAD + " see what it ran below." : NO_CHANGE_FOUND_HEADER + " " + findings.conclusion;
 return <section aria-label="What the agent found"><p className="rv-evidence-text"><VisibleText text={lead} /></p>
  {findings.commands.length > 0 && <><h3>{NO_CHANGE_COMMANDS_HEADER}</h3>{findings.omitted !== undefined && <p className="rv-muted">{String(findings.omitted) + (findings.omitted === 1 ? " earlier command is" : " earlier commands are") + " not listed."}</p>}
   <ul>{findings.commands.map((item, index) => <li key={String(index)}><code><VisibleText text={item.command} /></code>{item.failed === true && " (it failed)"}{item.output !== undefined && <pre className="rv-evidence-text"><VisibleText text={item.output} /></pre>}</li>)}</ul></>}
  <p className="rv-muted"><VisibleText text={choices} /></p></section>;
}
