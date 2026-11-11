import { useEffect, useId, useRef, useState } from "react";
import { useLocalTools } from "../../api/lessons-local-tools.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import { VisuallyHidden } from "../../design/VisuallyHidden.js";
import { CLI_PACKAGE, TOOLS, installCommand, lessonsLine, loadPrompt, NO_BRANCH_YET, PUSH_EXPLAINER, LOAD_TOOLS, type ContinueOffer, type ToolKind } from "./continue-in-tool.js";
import "./continue-in-tool.css";

const COPIED_MS = 2500;
/** A copy button: the host's clipboard where it has one, the browser's otherwise. "Copied" shows on the button and is announced; a failure says so and the text stays selectable above. */
function CopyButton({ text, label, what }: { text: string; label: string; what: string }) {
 const host = useAppHost(), [last, setLast] = useState<{ text: string; kind: "copied" | "failed" }>(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 // What was last tried counts only for the text it was tried on: choosing another tool changes the command, and its button starts fresh.
 const state = last?.text === text ? last.kind : "idle";
 useEffect(() => () => { clearTimeout(timer.current); }, []);
 async function copy() {
  try {
   if (host.copyText !== undefined) await host.copyText(text);
   else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) await navigator.clipboard.writeText(text);
   else throw new Error("unavailable");
   setLast({ text, kind: "copied" });clearTimeout(timer.current);timer.current = setTimeout(() => setLast(undefined), COPIED_MS);
  } catch { clearTimeout(timer.current);setLast({ text, kind: "failed" }); }
 }
 return <span className="rv-continue-copy"><Button variant="secondary" className="rv-continue-copy-button" onClick={() => { void copy(); }}>{state === "copied" ? "Copied" : label}</Button>
  <span role="status" aria-live="polite">{state === "copied" && <VisuallyHidden>{"Copied the " + what}</VisuallyHidden>}{state === "failed" && <span className="rv-muted">Couldn't copy. Select the text above and copy it yourself.</span>}</span></span>;
}

/** What the lessons switch says for this project. Shown only where the answer says; any failure (no such setting here, no permission to read it) leaves it out. */
function Lessons({ project }: { project: string }) {
 const read = useLocalTools(project);
 const line = read.isError ? undefined : lessonsLine(read.data);
 return line === undefined ? null : <section aria-label="Lessons in your tool"><h3>Lessons</h3><p>{line}</p></section>;
}

function Panel({ offer }: { offer: ContinueOffer }) {
 const [tool, setTool] = useState<ToolKind>("claude-code"), groupId = useId(), current = TOOLS.find(entry => entry.kind === tool)!;
 const command = installCommand(tool), prompt = loadPrompt(offer);
 return <div className="rv-continue-body">
  <section aria-label="Your tool"><fieldset className="rv-continue-tools"><legend>1. Choose your tool</legend>
   {TOOLS.map(entry => <label key={entry.kind} className="rv-option" htmlFor={groupId + entry.kind}><input id={groupId + entry.kind} type="radio" name={groupId} checked={tool === entry.kind} onChange={() => setTool(entry.kind)} /> {entry.label}</label>)}
  </fieldset></section>
  <section aria-label={"Install for " + current.label}><h3>{"2. Install Rovara in " + current.label}</h3>
   <p className="rv-muted">Once per computer. Sign in first with <code>{"npx " + CLI_PACKAGE + " login <your Rovara address>"}</code> if you haven't.</p>
   <pre className="rv-continue-code" tabIndex={0} aria-label={"Install command for " + current.label}><code>{command}</code></pre>
   <CopyButton text={command} label="Copy install command" what="install command" />
   <p className="rv-muted">{current.where} If your admin gave you an environment name, add <code>--env &lt;name&gt;</code> before <code>mcp</code>.</p>
  </section>
  <section aria-label="Load the task"><h3>3. Ask your tool to load the task</h3>
   <dl className="rv-continue-facts">
    <div><dt>Task</dt><dd><VisibleText text={offer.title} /></dd></div>
    <div><dt>Task id</dt><dd><code>{offer.taskId}</code></dd></div>
    <div><dt>Branch</dt><dd>{offer.branch !== undefined ? <code><VisibleText text={offer.branch} /></code> : offer.pullRequests.length === 0 ? NO_BRANCH_YET : <>Rovara opened {offer.pullRequests.length === 1 ? "a pull request" : "pull requests"}: {offer.pullRequests.map((pr, index) => <span key={pr.url}>{index > 0 && ", "}{/^https:\/\//u.test(pr.url) ? <a href={pr.url} target="_blank" rel="noopener noreferrer"><VisibleText text={pr.repository + " #" + String(pr.number)} /></a> : <VisibleText text={pr.repository + " #" + String(pr.number)} />}</span>)}. Its page names the branch.</>}</dd></div>
    <div><dt>Tool to call</dt><dd>{LOAD_TOOLS.map((name, index) => <span key={name}>{index > 0 && " then "}<code>{name}</code></span>)}</dd></div>
   </dl>
   <pre className="rv-continue-code rv-continue-prompt" tabIndex={0} aria-label="Prompt to paste into your tool"><code>{prompt}</code></pre>
   <CopyButton text={prompt} label="Copy prompt" what="prompt" />
  </section>
  <section aria-label="When you push"><h3>When you push</h3><p>{PUSH_EXPLAINER}</p></section>
  {offer.project !== undefined && <Lessons project={offer.project} />}
 </div>;
}

/**
 * "Continue in your own tool" (switch `rovara.continue`, continue-flags.ts): a button on the task page that opens a sheet with the install command for Claude Code, Codex or Cursor, the prompt that loads this
 * task, the branch (when the task view has one) and what happens when the person pushes. This whole module is a lazy chunk. The sheet is a modal dialog: focus stays inside it, Escape closes it and focus returns to the button.
 */
export default function ContinueInTool({ offer }: { offer: ContinueOffer }) {
 return <Dialog title="Continue in your own tool" description="Pick this task up in Claude Code, Codex or Cursor." className="rv-continue" trigger={<Button>Continue in your own tool</Button>}><Panel offer={offer} /></Dialog>;
}
