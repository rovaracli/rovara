import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LEARNING_PROJECT_WIDE, LEARNING_TEXT_MAX } from "@agentx/contracts/web";
import { learningKey, useLearning, useLearningApi, type Decision, type DismissedView, type RuleView, type SuggestionView } from "../../api/learning.js";
import { howWeWorkKey, useHowWeWork } from "../../api/how-we-work.js";
import { Banner } from "../../design/Banner.js";
import { Button } from "../../design/Button.js";
import { Card } from "../../design/Card.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextArea } from "../../design/TextArea.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { stageDomId } from "./HowWeWorkCard.js";
import { EDITABLE_KINDS, REVIEWING_KINDS } from "./how-we-work-rows.js";
import { SENT_FOR_CONFIRMATION } from "./PendingConfirmation.js";
import { cleanRuleText } from "./rule-text.js";
import { DISMISSED_MESSAGE, DISMISS_OPTIONS, LEARNING_TEXT as T, REOPENED_MESSAGE, addedMessage, addedToggle, dismissLabel, dismissedToggle, headerText, learningFailure, lessSafeWordsText, overlapText, removedMessage, ruleStatusLabel, sourceKindLabel, stageLabel, standingLabel, taskPageHref, whyText, type Failure } from "./learning-text.js";
import { useAppHost } from "../../host.js";
import "./learning.css";

type Stages = ReadonlyArray<{ id: string; name: string; kind: string }>;
interface Confirmation { confirmUrl?: string; changes: string[]; revision?: number }
interface Shared { project: string; stages: Stages; names: ReadonlyMap<string, string>; canDecide: boolean; confirmations: Record<string, Confirmation>; onConfirm: (id: string, confirmation: Confirmation | undefined) => void; onDone: (message?: string) => Promise<void> | void }
const asArray = <Item,>(value: readonly Item[] | undefined): readonly Item[] => value ?? [];

function FailureText({ failure, onReload }: { failure: Failure; onReload?: () => void }) {
 return <div role="alert">{failure.kind === "fixed" ? <p>{failure.text}{failure.reload && onReload !== undefined && <> <Button onClick={onReload}>{T.RELOAD}</Button></>}</p>
  : failure.kind === "refusals" ? <><p>{T.REFUSALS_HEADING}</p><ul>{failure.items.map((item, index) => <li key={index}><VisibleText text={item.text} />{item.href !== undefined && <> <Link to={item.href}>{T.FIX_LINK}</Link></>}</li>)}</ul></>
  : <p>{failure.parts.map((part, index) => part.href === undefined ? <VisibleText key={index} text={part.text} /> : <Link key={index} to={part.href}><VisibleText text={part.text} /></Link>)}</p>}</div>;
}
/** A change that waits for a second person: what was sent, and the confirmation page when it is this site's. */
function WaitingForConfirmation({ confirmation }: { confirmation: Confirmation | undefined }) {
 const host = useAppHost();
 return <div role="status"><p>{SENT_FOR_CONFIRMATION}</p>{confirmation !== undefined && confirmation.changes.length > 0 && <ul>{confirmation.changes.map((change, index) => <li key={index}><VisibleText text={change} /></li>)}</ul>}{confirmation?.confirmUrl !== undefined && <p><Button onClick={() => host.openExternal(confirmation.confirmUrl!)}>{T.OPEN_CONFIRMATION}</Button></p>}</div>;
}
const awaiting = (decision: Extract<Decision, { kind: "awaiting" }>, revision?: number): Confirmation => ({ changes: decision.changes, ...(decision.confirmUrl === undefined ? {} : { confirmUrl: decision.confirmUrl }), ...(revision === undefined ? {} : { revision }) });

function Sources({ suggestion }: { suggestion: SuggestionView }) {
 const count = suggestion.sourceCount ?? suggestion.sources.length;
 return <div><p><strong>{whyText(count)}</strong></p>{suggestion.sources.length > 0 && <ul className="rv-learning-sources">{suggestion.sources.map((source, index) => {
  const link = taskPageHref(source.href), words = source.label === undefined ? undefined : <VisibleText text={source.label} />, standing = standingLabel(source.standing);
  return <li key={index}><span className="rv-muted">{sourceKindLabel(source.kind)}: </span>{words === undefined ? null : link === undefined ? words : link.kind === "app" ? <Link to={link.href}>{words}</Link> : <a href={link.href}>{words}</a>}{source.at !== undefined && <span className="rv-muted"> · <RelativeTime at={source.at} /></span>}{standing !== undefined && <span className="rv-muted"> · {standing}</span>}</li>;
 })}</ul>}</div>;
}

function DismissForm({ project, suggestion, onDone, onCancel }: { project: string; suggestion: SuggestionView; onDone: Shared["onDone"]; onCancel: () => void }) {
 const api = useLearningApi(), [kind, setKind] = useState<string>(), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure>();
 async function send() {
  if (kind === undefined || busy) return;
  setBusy(true);setFailure(undefined);
  try { await api.dismiss(project, suggestion.id, { expectedRevision: suggestion.revision, dismissKind: kind as "wrong", ...(note.trim() === "" ? {} : { note: note.trim() }) });await onDone(DISMISSED_MESSAGE); }
  catch (error) { setFailure(learningFailure(error, "Couldn't dismiss this suggestion. Try again.")); }
  finally { setBusy(false); }
 }
 return <fieldset className="rv-learning-dismiss" aria-label={T.DISMISS_LEGEND} disabled={busy}><legend>{T.DISMISS_LEGEND}</legend>
  {DISMISS_OPTIONS.map(option => <label key={option.value}><input type="radio" name={"dismiss-" + suggestion.id} value={option.value} checked={kind === option.value} onChange={() => setKind(option.value)} />{option.label}</label>)}
  <TextField label={T.DISMISS_NOTE} maxLength={500} value={note} onChange={event => setNote(event.target.value)} />
  <div className="rv-learning-actions"><Button variant="primary" busy={busy} disabled={kind === undefined} onClick={() => { void send(); }}>{T.DISMISS_SEND}</Button><Button disabled={busy} onClick={onCancel}>{T.CANCEL}</Button></div>
  {failure !== undefined && <FailureText failure={failure} onReload={() => { void onDone(); }} />}
 </fieldset>;
}

function SuggestionCard({ suggestion, shared }: { suggestion: SuggestionView; shared: Shared }) {
 const { project, stages, names, canDecide, confirmations, onConfirm, onDone } = shared, api = useLearningApi();
 const [text, setText] = useState(suggestion.proposedText ?? ""), [stage, setStage] = useState(suggestion.stage), [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure>(), [dismissing, setDismissing] = useState(false);
 const label = stageLabel(suggestion.stage, names), status = suggestion.status, confirmation = confirmations[suggestion.id], waitingHere = confirmation !== undefined && (status === "awaiting_approval" || confirmation.revision === suggestion.revision);
 const kindOf = (id: string) => stages.find(entry => entry.id === id)?.kind ?? "", reviewing = (id: string) => REVIEWING_KINDS.has(kindOf(id));
 const options = [...stages.filter(entry => EDITABLE_KINDS.has(entry.kind) && !REVIEWING_KINDS.has(entry.kind)).map(entry => ({ value: entry.id, label: entry.name })), { value: LEARNING_PROJECT_WIDE, label: T.PROJECT_WIDE }, ...stages.filter(entry => REVIEWING_KINDS.has(entry.kind)).map(entry => ({ value: entry.id, label: `${entry.name} (${T.SECOND_PERSON_MARK})` }))];
 if (!options.some(option => option.value === suggestion.stage)) options.unshift({ value: suggestion.stage, label });
 if (!options.some(option => option.value === stage)) options.unshift({ value: stage, label: stageLabel(stage, names) });
 const cleaned = cleanRuleText(text), tooLong = cleaned.length > LEARNING_TEXT_MAX, needsSecond = suggestion.lessSafe || reviewing(stage);
 async function accept() {
  if (busy || cleaned === "" || tooLong) return;
  setBusy(true);setFailure(undefined);
  try {
   const result = await api.accept(project, suggestion.id, { expectedRevision: suggestion.revision, stage, text: cleaned });
   if (result.kind === "awaiting") { onConfirm(suggestion.id, awaiting(result, suggestion.revision));await onDone(); }
   else await onDone(result.kind === "applied" ? addedMessage(result.version) : T.SAVED);
  } catch (error) { setFailure(learningFailure(error, "Couldn't accept this suggestion. Try again.")); }
  finally { setBusy(false); }
 }
 const readOnlyStatus = status === "accepting" ? T.SAVING : status === "awaiting_approval" ? T.WAITING : undefined, canAccept = suggestion.canDecide === true;
 return <Card className="rv-learning-card" aria-labelledby={"learning-" + suggestion.id}>
  <h3 id={"learning-" + suggestion.id}>Suggested rule for <VisibleText text={label} /></h3>
  <p>Applies to: <strong><VisibleText text={label} /></strong></p>
  {suggestion.allFromOnePerson && <p><span className="rv-hww-marker">{T.ONE_PERSON}</span></p>}
  {suggestion.lessSafe && <Banner title={T.LESS_SAFE} tone="warning">{T.LESS_SAFE_BODY}{suggestion.lessSafeWords.length > 0 && <> <VisibleText text={lessSafeWordsText(suggestion.lessSafeWords)} /></>}</Banner>}
  {suggestion.overlaps.length > 0 && <p><VisibleText text={overlapText(suggestion.overlaps)} /></p>}
  {readOnlyStatus !== undefined && <p><strong>{readOnlyStatus}</strong></p>}
  {readOnlyStatus === undefined && canAccept ? <>
   <TextArea label={T.WORDING_LABEL} hint={T.WORDING_HINT} value={text} maxLength={LEARNING_TEXT_MAX} rows={4} disabled={busy || waitingHere} onChange={event => setText(event.target.value)} />
   <Select label={T.STAGE_LABEL} value={stage} options={options} disabled={busy || waitingHere} onValueChange={setStage} />
  </> : suggestion.proposedText !== undefined && <p className="rv-learning-text"><VisibleText text={suggestion.proposedText} /></p>}
  <Sources suggestion={suggestion} />
  {(waitingHere || (status === "awaiting_approval" && confirmation !== undefined)) && <WaitingForConfirmation confirmation={confirmation} />}
  {readOnlyStatus === undefined && !waitingHere && (canAccept || canDecide ? <div className="rv-learning-actions">
   {canAccept && <Button variant="primary" busy={busy} disabled={cleaned === "" || tooLong} onClick={() => { void accept(); }}>{needsSecond ? T.REQUEST_APPROVAL : T.ACCEPT}</Button>}
   {canDecide && <Button disabled={busy || dismissing} onClick={() => setDismissing(true)}>{T.DISMISS}</Button>}
  </div> : <p className="rv-muted">{T.READ_ONLY}</p>)}
  {failure !== undefined && <FailureText failure={failure} onReload={() => { void onDone(); }} />}
  {dismissing && readOnlyStatus === undefined && !waitingHere && <DismissForm project={project} suggestion={suggestion} onDone={onDone} onCancel={() => setDismissing(false)} />}
 </Card>;
}

function DismissedRow({ item, shared }: { item: DismissedView; shared: Shared }) {
 const api = useLearningApi(), [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure>();
 async function reopen() {
  if (busy) return;
  setBusy(true);setFailure(undefined);
  try { await api.reopen(shared.project, item.id);await shared.onDone(REOPENED_MESSAGE); }
  catch (error) { setFailure(learningFailure(error, "Couldn't reopen this suggestion. Try again.")); }
  finally { setBusy(false); }
 }
 const kind = dismissLabel(item.dismissKind);
 return <li><span><VisibleText text={stageLabel(item.stage, shared.names)} /></span><span className="rv-muted"> · <RelativeTime at={item.dismissedAt} />{kind !== undefined && <> · {kind}</>}</span>{shared.canDecide && <> <Button busy={busy} onClick={() => { void reopen(); }}>{T.REOPEN}</Button></>}{failure !== undefined && <FailureText failure={failure} />}</li>;
}

/** Takes the person to the stage card (or the project rules) where a rule that was edited by hand can be removed. */
function showInEditor(stage: string) {
 if (stage === LEARNING_PROJECT_WIDE) { const rules = document.querySelector('[aria-label="Project rules"]'), box = rules?.querySelector("textarea") ?? undefined;rules?.scrollIntoView({ block: "start" });box?.focus();return; }
 const card = document.getElementById(stageDomId(stage) + "-title");card?.scrollIntoView({ block: "start" });card?.focus();
}
function RuleRow({ rule, shared }: { rule: RuleView; shared: Shared }) {
 const api = useLearningApi(), [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure>(), [byHand, setByHand] = useState(false), waiting = shared.confirmations[rule.id];
 async function remove() {
  if (busy) return;
  setBusy(true);setFailure(undefined);setByHand(false);
  try {
   const result = await api.removeRule(shared.project, rule.id);
   if (result.kind === "needs_editor") { setByHand(true);showInEditor(result.stage); }
   else if (result.kind === "awaiting") { shared.onConfirm(rule.id, awaiting(result));await shared.onDone(); }
   else await shared.onDone(result.kind === "applied" ? removedMessage(result.version) : T.SAVED);
  } catch (error) { setFailure(learningFailure(error, "Couldn't remove this rule. Try again.")); }
  finally { setBusy(false); }
 }
 return <li><p className="rv-learning-text"><VisibleText text={rule.text} /></p><p className="rv-muted"><VisibleText text={stageLabel(rule.stage, shared.names)} />{rule.processVersion !== undefined && <> · Version {rule.processVersion}</>} · {ruleStatusLabel(rule.status)}</p>
  {shared.canDecide && rule.status === "active" && waiting === undefined && <Button busy={busy} onClick={() => { void remove(); }}>{T.REMOVE}</Button>}
  {waiting !== undefined && <WaitingForConfirmation confirmation={waiting} />}
  {byHand && <p role="status">{T.NEEDS_EDITOR}</p>}
  {failure !== undefined && <FailureText failure={failure} onReload={() => { void shared.onDone(); }} />}</li>;
}

/** "Suggested rules": what the team's repeated corrections turned into, to accept, edit, dismiss or remove. Sits above the stage cards of the How we work tab. */
export function LearningSection({ project }: { project: string }) {
 const read = useLearning(project), how = useHowWeWork(project), query = useQueryClient();
 const [show, setShow] = useState<{ dismissed: boolean; rules: boolean }>({ dismissed: false, rules: false }), [notice, setNotice] = useState<string>(), [confirmations, setConfirmations] = useState<Record<string, Confirmation>>({});
 const stages: Stages = how.data?.stages ?? [], names = new Map(stages.map(stage => [stage.id, stage.name])), layerId = how.data === undefined ? undefined : how.data.process.kind === "project_process" ? how.data.process.agentId : how.data.process.draftLayer?.agentId;
 if (read.isPending) return <section className="rv-learning" aria-label="Suggested rules"><Skeleton label={T.LOADING} /></section>;
 if (read.isError || read.data === undefined) return <section className="rv-learning" aria-label="Suggested rules"><p role="alert"><VisibleText text={learningFailureText(read.error)} /></p><Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button></section>;
 const data = read.data, open = data.suggestions.filter(item => item.status === "open" || item.status === "accepting" || item.status === "awaiting_approval"), truncated = asArray(data.truncated);
 /** After a decision, the suggestions and everything How we work shows are read again (the version, the rules, the history). */
 async function done(message?: string) {
  setNotice(message);
  await Promise.all([query.invalidateQueries({ queryKey: learningKey(project) }), query.invalidateQueries({ queryKey: howWeWorkKey(project) }), ...(layerId === undefined ? [] : [query.invalidateQueries({ queryKey: ["agent", layerId] })])]);
 }
 const shared: Shared = { project, stages, names, canDecide: data.canDecide, confirmations, onConfirm: (id, confirmation) => setConfirmations(current => { const rest = { ...current };delete rest[id];return confirmation === undefined ? rest : { ...rest, [id]: confirmation }; }), onDone: done };
 const toggle = (key: "dismissed" | "rules", label: string) => <Button className="rv-learning-toggle" aria-expanded={show[key]} onClick={() => setShow(current => ({ ...current, [key]: !current[key] }))}>{label}</Button>;
 return <section className="rv-learning" aria-label="Suggested rules">
  <div className="rv-learning-head"><h2>{headerText(open.length)}</h2><div className="rv-learning-links">{toggle("dismissed", dismissedToggle(data.dismissed.length))}{toggle("rules", addedToggle(data.rules.length))}</div></div>
  {notice !== undefined && <p role="status">{notice}</p>}
  {open.length === 0 ? <p className="rv-muted">{T.EMPTY}</p> : <ul className="rv-learning-cards" aria-label="Open suggestions">{open.map(item => <li key={item.id}><SuggestionCard suggestion={item} shared={shared} /></li>)}</ul>}
  {show.dismissed && <section aria-label={T.DISMISSED_LIST}>{data.dismissed.length === 0 ? <p className="rv-muted">Nothing has been dismissed.</p> : <ul className="rv-learning-list" aria-label={T.DISMISSED_LIST}>{data.dismissed.map(item => <DismissedRow key={item.id} item={item} shared={shared} />)}</ul>}{truncated.includes("dismissed") && <p className="rv-muted">{T.CUT_SHORT}</p>}</section>}
  {show.rules && <section aria-label={T.RULES_LIST}>{data.rules.length === 0 ? <p className="rv-muted">No rules have been added by suggestions.</p> : <ul className="rv-learning-list" aria-label={T.RULES_LIST}>{data.rules.map(item => <RuleRow key={item.id} rule={item} shared={shared} />)}</ul>}{truncated.includes("rules") && <p className="rv-muted">{T.CUT_SHORT}</p>}</section>}
 </section>;
}
const learningFailureText = (error: unknown): string => { const failure = learningFailure(error, T.LOAD_FAILED);return failure.kind === "fixed" ? failure.text : failure.kind === "message" ? failure.parts.map(part => part.text).join("") : T.LOAD_FAILED; };
