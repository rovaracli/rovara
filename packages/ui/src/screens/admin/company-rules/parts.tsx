// Small pieces of the Company rules page: a numbered list of rules, a comparison of two lists, and the preview of the block agents read.
import { changeKind, numbered, PRIORITY_WORDS, priorityChangedCount, summaryWords, type ChangeKind } from "./rules-logic.js";
import type { CompanyRuleView, CompanyRulesDiff } from "@agentx/contracts/web";
import { VisibleText } from "../../../design/VisibleText.js";
import { previewBlock } from "./rules-logic.js";
import { T } from "./company-rules-text.js";

/** Required, then Preferred, numbered 1 to N across both as the agents are shown them. */
export function RulesList({ rules, label }: { rules: readonly CompanyRuleView[]; label: string }) {
 const groups = numbered(rules);
 const group = (title: string, items: typeof groups.required, id: string) => <section aria-labelledby={id} className="rv-cr-group"><h3 id={id}>{title}</h3>
  {items.length === 0 ? <p className="rv-muted">{T.NO_RULES_IN_LIST}</p> : <ol start={items[0]!.number} className="rv-cr-rules">{items.map(item => <li key={item.number}><VisibleText text={item.rule.text} /></li>)}</ol>}
 </section>;
 return <div className="rv-cr-lists" aria-label={label}>{group(T.REQUIRED_HEADING, groups.required, label.replaceAll(" ", "-") + "-required")}{group(T.PREFERRED_HEADING, groups.preferred, label.replaceAll(" ", "-") + "-preferred")}</div>;
}

const KIND_WORDS: Record<ChangeKind, string> = { added: "Added", removed: "Removed", changed: "Changed", priority: "Priority changed", same: "Unchanged" };
function DiffEntry({ entry }: { entry: CompanyRulesDiff["entries"][number] }) {
 const kind = changeKind(entry);
 return <li className={`rv-cr-diff-entry rv-cr-diff-${kind}`}>
  <strong className="rv-cr-diff-kind">{KIND_WORDS[kind]}</strong>
  {entry.kind === "added" && <p><span className="rv-muted">{PRIORITY_WORDS[entry.after.priority]}.</span> <VisibleText text={entry.after.text} /></p>}
  {entry.kind === "removed" && <p><span className="rv-muted">{PRIORITY_WORDS[entry.before.priority]}.</span> <VisibleText text={entry.before.text} /></p>}
  {entry.kind === "same" && <p><span className="rv-muted">{PRIORITY_WORDS[entry.after.priority]}.</span> <VisibleText text={entry.after.text} /></p>}
  {entry.kind === "changed" && kind === "priority" && <p><VisibleText text={entry.after.text} /><br /><span className="rv-muted">From {PRIORITY_WORDS[entry.before.priority]} to {PRIORITY_WORDS[entry.after.priority]}.</span></p>}
  {entry.kind === "changed" && kind === "changed" && <><p><span className="rv-muted">Was ({PRIORITY_WORDS[entry.before.priority]}):</span> <VisibleText text={entry.before.text} /></p><p><span className="rv-muted">Now ({PRIORITY_WORDS[entry.after.priority]}):</span> <VisibleText text={entry.after.text} /></p></>}
 </li>;
}
/** The rules that differ, each with a word (never colour alone), and the unchanged ones behind a button. `before` and `after` name the two sides in the heading when given. */
export function DiffView({ diff, label }: { diff: CompanyRulesDiff; label: string }) {
 const changes = diff.entries.filter(entry => entry.kind !== "same"), same = diff.entries.filter(entry => entry.kind === "same");
 return <div className="rv-cr-diff" role="group" aria-label={label}>
  <p><strong>{summaryWords(diff.summary, priorityChangedCount(diff))}</strong></p>
  {changes.length === 0 ? <p className="rv-muted">{T.NO_DIFF}</p> : <ul className="rv-cr-diff-list">{changes.map((entry, index) => <DiffEntry key={index} entry={entry} />)}</ul>}
  {same.length > 0 && <details><summary>{T.UNCHANGED_SHOW(same.length)}</summary><ul className="rv-cr-diff-list">{same.map((entry, index) => <DiffEntry key={index} entry={entry} />)}</ul></details>}
 </div>;
}

/** The block agents read, built from the draft. Plain text in a region a keyboard can scroll. */
export function PreviewBlock({ rules }: { rules: ReadonlyArray<{ text: string; priority: CompanyRuleView["priority"] }> }) {
 const text = previewBlock(rules);
 return <div className="rv-cr-preview"><h3>{T.PREVIEW_HEADING}</h3><p className="rv-muted">{T.PREVIEW_HELP}</p>
  {text === undefined ? <p>{T.PREVIEW_NONE}</p> : <pre tabIndex={0} aria-label="The standing instructions block as agents read it" className="rv-cr-block"><VisibleText text={text} /></pre>}
 </div>;
}
