// Propose a change: add, edit, delete, reorder and re-rank rules, with live counts, the size limits enforced before sending, a preview of what agents will read, and what changes against the current version.
// The server checks everything again; a refusal is shown in its own words. A rule's priority decides its list (Required first, then Preferred), as the agents read them.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useCompanyRulesApi } from "../../../api/company-rules.js";
import { Button } from "../../../design/Button.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { COMPANY_RULES_NOTE_MAX, COMPANY_RULE_INPUT_MAX } from "@agentx/cloud-contracts/web";
import { T } from "./company-rules-text.js";
import { DiffView, PreviewBlock } from "./parts.js";
import { addRule, canMove, checkRules, deleteRule, diffRules, draftFrom, editRule, foldRuleText, moveRule, PRIORITY_WORDS, sameRules, setPriority, toRules, type DraftRule, type Limits, type Priority } from "./rules-logic.js";
import type { State } from "./types.js";
import { useRulesWrite } from "./use-rules-write.js";

const newId = () => crypto.randomUUID();
const formatCount = (value: number) => value.toLocaleString("en-US");
type Focus = { id: string; prefer: "up" | "down" | "text" };

/** The editor, or the button that opens it. `state` is what the page last read; the draft starts from its current version. */
export function RulesEditor({ state, onStatus }: { state: State; onStatus: (text: string) => void }) {
 const api = useCompanyRulesApi(), write = useRulesWrite(onStatus), root = useRef<HTMLElement>(null), requestId = useRef<{ key: string; id: string } | undefined>(undefined);
 const [draft, setDraft] = useState<DraftRule[]>(), [note, setNote] = useState(""), [base, setBase] = useState(0), [focus, setFocus] = useState<Focus>();
 const current = toRules(state.current?.rules ?? []);
 const limits: Limits = state.limits;
 const currentVersion = state.current?.version ?? 0;
 useEffect(() => {
  if (focus === undefined || root.current === null) return;
  const find = (selector: string) => root.current?.querySelector<HTMLElement>(`[data-rule="${focus.id}"]${selector}`);
  const text = root.current.querySelector<HTMLElement>(`textarea[data-rule="${focus.id}"]`), up = find("[data-action=up]:not(:disabled)"), down = find("[data-action=down]:not(:disabled)");
  const target = (focus.prefer === "text" ? [text, up, down] : focus.prefer === "up" ? [up, down, text] : [down, up, text]).find(node => node !== null && node !== undefined);
  target?.focus();setFocus(undefined);
 }, [focus]);
 if (!state.viewer.canPropose) return null;
 if (state.pending !== null) return <section aria-labelledby="cr-edit" className="rv-cr-card"><h2 id="cr-edit">{T.EDIT_HEADING}</h2><p role="status">{T.PENDING_BLOCKS}</p>{write.view}</section>;
 if (draft === undefined) return <section aria-labelledby="cr-edit" className="rv-cr-card"><h2 id="cr-edit">{T.EDIT_HEADING}</h2><p>{T.EDIT_INTRO}</p>
  <div><Button variant="primary" onClick={() => { setDraft(draftFrom(current, newId));setBase(currentVersion);setNote("");write.clear(); }}>{current.length === 0 ? T.EDIT_START_FIRST : T.EDIT_START}</Button></div>{write.view}</section>;

 const check = checkRules(draft, limits), unchanged = sameRules(draft, current), moved = base !== currentVersion;
 const problems = [...check.problems, ...(unchanged && check.problems.length === 0 ? [T.NOTHING_CHANGED] : [])];
 const blocked = check.problems.length > 0 || unchanged || moved;
 const changes = diffRules(current, draft.map(rule => ({ text: foldRuleText(rule.text), priority: rule.priority })));
 const update = (next: DraftRule[], to?: Focus) => { setDraft(next);if (to !== undefined) setFocus(to); };
 async function submit(event: FormEvent) {
  event.preventDefault();
  if (blocked || draft === undefined) return;
  const rules = draft.map(rule => ({ text: rule.text, priority: rule.priority })), trimmed = note.trim();
  // The same list sent again after a failure keeps its request id, so a repeat can never write twice.
  const key = JSON.stringify([base, rules, trimmed]);
  if (requestId.current?.key !== key) requestId.current = { key, id: newId() };
  const sent = await write.run(() => api.propose({ requestId: requestId.current!.id, baseVersion: base, rules, ...(trimmed === "" ? {} : { note: trimmed }) }), T.PROPOSED);
  if (sent) { setDraft(undefined);setNote("");requestId.current = undefined; }
 }
 const group = (priority: Priority) => {
  const list = draft.filter(rule => rule.priority === priority), first = draft.findIndex(rule => rule.priority === priority);
  const other: Priority = priority === "required" ? "preferred" : "required";
  return <section aria-labelledby={`cr-edit-${priority}`} className="rv-cr-group"><h3 id={`cr-edit-${priority}`}>{priority === "required" ? T.REQUIRED_HEADING : T.PREFERRED_HEADING}</h3>
   {list.length === 0 && <p className="rv-muted">{T.NO_RULES_IN_LIST}</p>}
   {list.length > 0 && <ol start={first + 1} className="rv-cr-edit-list">{list.map(rule => {
    const number = draft.indexOf(rule) + 1, own = check.rules[number - 1]!, tag = `rule ${String(number)}`;
    return <li key={rule.id} className="rv-cr-edit-rule">
     <TextArea label={`Rule ${String(number)}`} hint={`${formatCount(own.length)}/${formatCount(limits.maxRuleCharacters)} characters`} {...(own.problem === undefined ? {} : { error: own.problem })} value={rule.text} maxLength={COMPANY_RULE_INPUT_MAX} data-rule={rule.id} rows={3} className="rv-cr-text"
      onChange={event => { update(editRule(draft, rule.id, event.target.value)); }} />
     <div className="rv-cr-rule-actions">
      <Button data-rule={rule.id} data-action="up" aria-label={`Move up, ${tag}`} disabled={!canMove(draft, rule.id, -1)} onClick={() => { update(moveRule(draft, rule.id, -1), { id: rule.id, prefer: "up" }); }}>Move up</Button>
      <Button data-rule={rule.id} data-action="down" aria-label={`Move down, ${tag}`} disabled={!canMove(draft, rule.id, 1)} onClick={() => { update(moveRule(draft, rule.id, 1), { id: rule.id, prefer: "down" }); }}>Move down</Button>
      <Button aria-label={`Make ${PRIORITY_WORDS[other]}, ${tag}`} onClick={() => { update(setPriority(draft, rule.id, other), { id: rule.id, prefer: "text" }); }}>Make {PRIORITY_WORDS[other]}</Button>
      <Button variant="danger" aria-label={`Delete, ${tag}`} onClick={() => { update(deleteRule(draft, rule.id)); }}>Delete</Button>
     </div>
    </li>;
   })}</ol>}
   <div><Button disabled={draft.length >= limits.maxRules} onClick={() => { const id = newId();update(addRule(draft, priority, id), { id, prefer: "text" }); }}>{priority === "required" ? T.ADD_REQUIRED : T.ADD_PREFERRED}</Button></div>
  </section>;
 };
 return <section ref={root} aria-labelledby="cr-edit" className="rv-cr-card"><h2 id="cr-edit">{T.EDIT_HEADING}</h2><p>{T.EDIT_INTRO}</p>
  <form onSubmit={event => { void submit(event); }} className="rv-cr-form" noValidate aria-busy={write.busy}>
   {moved && <div role="alert" className="rv-cr-alert"><p>{T.STALE_DRAFT}</p></div>}
   <p className="rv-cr-counts" role="status"><strong>Rules {formatCount(check.count)}/{formatCount(limits.maxRules)}</strong>. <strong>Characters {formatCount(check.total)}/{formatCount(limits.maxTotalCharacters)}</strong> in all. At most {formatCount(limits.maxRuleCharacters)} in one rule.</p>
   {group("required")}{group("preferred")}
   <TextField label={T.NOTE_LABEL} hint={`${T.NOTE_HINT} ${String(Array.from(note).length)}/${String(COMPANY_RULES_NOTE_MAX)}.`} value={note} maxLength={COMPANY_RULES_NOTE_MAX} onChange={event => { setNote(event.target.value); }} />
   <div className="rv-cr-changes"><h3>{T.YOUR_CHANGES}</h3>{unchanged ? <p className="rv-muted">{T.NOTHING_CHANGED}</p> : <DiffView diff={changes} label="Your changes against the current rules" />}</div>
   <PreviewBlock rules={draft.filter(rule => foldRuleText(rule.text) !== "")} />
   {draft.length === 0 && <p className="rv-muted">{T.EMPTY_DRAFT}</p>}
   <div role="status" aria-label="Why this can't be proposed yet">{problems.length > 0 && <ul className="rv-cr-problems">{problems.map(problem => <li key={problem} className={problem === T.NOTHING_CHANGED ? "rv-muted" : "rv-error"}><VisibleText text={problem} /></li>)}</ul>}</div>
   <div className="rv-cr-actions">
    <Button type="submit" variant="primary" busy={write.busy} disabled={blocked}>{T.SUBMIT}</Button>
    <Button disabled={write.busy} onClick={() => { setDraft(undefined);setNote("");requestId.current = undefined;write.clear(); }}>{T.DISCARD}</Button>
   </div>
  </form>
  {write.view}
 </section>;
}
