import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_CAP_MIN_USD, DESIGN_REVIEW_TIERS, type DesignReviewCompanyLock, type DesignReviewCompanyState } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { designReviewCompanyKey, useDesignReviewCompanyApi } from "../../../api/design-review-company.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import "./how-we-work.css";

const T = {
 HEADING: "Design review",
 HELP: "Before Rovara builds, reviewers that never saw the conversation read the design and raise what it assumes or gets wrong. A person approves the design. Only company owners and admins can change these settings.",
 ALLOWED: "Allow design review in this company",
 ALLOWED_HELP: "Off until an admin turns it on. While it is off, no project runs design review, whatever the project chose. Allowing it needs a different admin to confirm. Turning it off again also withdraws a change that is waiting for confirmation.",
 DESIGN_FIRST_NOTE: "Projects set to Off can still ask for a design review on a single task with Design first.",
 PROJECTS_HELP: "Once design review is allowed, each project's maintainers turn it on (Auto or Always) or off on the project's own How we work page. Projects start Off.",
 RULES_HEADING: "Rules every project must follow",
 RULES_HELP: "A project can be stricter than these, never looser. A rule you set here also applies to projects that already chose something looser. These rules never stop a project's maintainers turning their own project off.",
 MIN_TIER: "Tier at least", NO_SKIP: "Nobody can skip design review", CAP: "Highest cost limit per task (USD)", CAP_HINT: "Leave empty for no ceiling.", GROUP: "Group that approves high-risk designs (Enterprise)",
 SAVE: "Save rules", SAVED: "Saved. New design reviews use these settings; running ones keep theirs.", SAVED_ON: "Design review is allowed in this company.", SAVED_OFF: "Design review is turned off for every project.",
 ASKED: "Waiting for a different admin to confirm.", PENDING_MINE: "You asked to allow design review. A different admin has to confirm it here.", PENDING_OTHER: "An admin asked to allow design review.",
 PENDING_LOCK_MINE: "You asked to loosen the rules. A different admin has to confirm it here.", PENDING_LOCK_OTHER: "An admin asked to loosen the rules below.", APPROVE_LOCK: "Confirm the looser rules", WITHDRAW: "Withdraw the request", WITHDRAWN: "The request is withdrawn.", ASKED_LOCK: "The looser rules wait for a different admin to confirm.", ONE_REQUEST: "Only one request can wait at a time.",
 APPROVE: "Confirm allowing design review", APPROVE_HELP: "You will be asked to sign in again if you have not signed in in the last 10 minutes.", APPROVED: "Design review is allowed in this company.",
 UNREADABLE: "The stored design review settings could not be read, so nothing can be changed here. Ask Rovara support.", LOAD_FAILED: "Couldn't load the design review settings.", RETRY: "Try again", LOADING: "Loading the design review settings",
 CHANGED: "This changed while you were looking. The page has the latest; check it and try again.", FAILED: "Couldn't save. Nothing changed.", SIGN_IN_AGAIN: "Sign in again",
} as const;
const MIN_TIER_OPTIONS = [{ value: "", label: "No rule" }, ...DESIGN_REVIEW_TIERS.map(value => ({ value, label: value === "light" ? "Light or more" : value === "standard" ? "Standard or more" : "Thorough" }))];

type Message = { kind: "status"; text: string } | { kind: "alert"; text: string; signIn?: boolean };
type Draft = { tier: string; noSkip: boolean; cap: string; group: string };
const draftOf = (state: DesignReviewCompanyState): Draft => ({ tier: state.lock.tierAtLeast ?? "", noSkip: state.lock.allowSkip === false, cap: state.lock.capCeilingUsd === undefined ? "" : String(state.lock.capCeilingUsd), group: state.lock.approverGroupId ?? "" });
function lockOf(draft: Draft): { ok: true; lock: DesignReviewCompanyLock } | { ok: false; cap: string } {
 const cap = draft.cap.trim() === "" ? undefined : Number(draft.cap);
 if (cap !== undefined && (!Number.isFinite(cap) || cap < DESIGN_REVIEW_CAP_MIN_USD || cap > DESIGN_REVIEW_CAP_MAX_USD)) return { ok: false, cap: "Use an amount between $0.50 and $100.00." };
 const group = draft.group.trim();
 return { ok: true, lock: {
  ...(draft.tier === "light" || draft.tier === "standard" || draft.tier === "thorough" ? { tierAtLeast: draft.tier } : {}),
  ...(draft.noSkip ? { allowSkip: false as const } : {}), ...(cap === undefined ? {} : { capCeilingUsd: cap }), ...(group === "" ? {} : { approverGroupId: group }),
 } };
}
const sameDraft = (left: Draft, right: Draft): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * The company's design review card (DR-FU4), for a company admin: whether design review is allowed and the stricter-only rules (projects choose Off, Auto or Always themselves). The server decides who may and what a
 * change is; this card shows its answer, sends one press at a time and reads again. Absent (NOT_FOUND or FORBIDDEN) while design review is off in this environment, and for anyone who is not an admin. Loaded lazily with the How we work page.
 */
export default function DesignReviewCompanyRow() {
 const api = useDesignReviewCompanyApi(), client = useQueryClient(), host = useAppHost(), sending = useRef(false);
 const read = useQuery({ queryKey: designReviewCompanyKey, queryFn: () => api.state(), retry: false, refetchOnWindowFocus: false });
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>(), [edit, setEdit] = useState<Draft>();
 if (read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 403)) return null;
 async function run(write: () => Promise<{ status: string }>, done: (status: string) => string) {
  if (sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const answer = await write();
   setMessage({ kind: "status", text: done(answer.status) });setEdit(undefined);
   await client.invalidateQueries({ queryKey: designReviewCompanyKey });
  } catch (error) {
   if (error instanceof ApiError && (error.code === "POLICY_STALE" || error.code === "CHANGE_STALE")) { await client.invalidateQueries({ queryKey: designReviewCompanyKey });setEdit(undefined);setMessage({ kind: "alert", text: error.code === "POLICY_STALE" ? T.CHANGED : error.message }); }
   else if (error instanceof ApiError && error.code === "REAUTH_REQUIRED") setMessage({ kind: "alert", text: error.message, signIn: true });
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : T.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 let body;
 if (read.isPending) body = <Skeleton label={T.LOADING} />;
 else if (read.data === undefined) body = <><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></>;
 // A word this version does not know (a newer server) is not guessed: the card says it cannot read the settings and offers nothing to change.
 else if (read.data.unreadable || read.data.lock.tierAtLeast === "unknown") body = <p role="alert">{T.UNREADABLE}</p>;
 else {
  const state = read.data as DesignReviewCompanyState, pending = state.pending, saved = draftOf(state), current = edit ?? saved, parsed = lockOf(current), changed = !sameDraft(current, saved);
  const patch = (change: Partial<Draft>) => { setMessage(undefined);setEdit({ ...current, ...change }); };
  body = <>
   <p className="rv-muted">{T.HELP}</p>
   <Switch label={T.ALLOWED} checked={state.allowed} disabled={busy || (pending?.kind === "allowed" && !state.allowed)} onCheckedChange={checked => { void run(() => api.allow(state.revision, checked), status => (status === "needs_approval" ? T.ASKED : checked ? T.SAVED_ON : T.SAVED_OFF)); }} />
   <p className="rv-muted">{T.ALLOWED_HELP}</p>
   <p className="rv-muted">{T.DESIGN_FIRST_NOTE}</p>
   {pending !== undefined && <p role="status">{pending.kind === "lock" ? (pending.proposedByYou ? T.PENDING_LOCK_MINE : T.PENDING_LOCK_OTHER) : pending.proposedByYou ? T.PENDING_MINE : T.PENDING_OTHER} <span className="rv-muted">{T.ONE_REQUEST}</span></p>}
   {pending !== undefined && <div className="rv-hww-company-actions">
    {!pending.proposedByYou && <><Button variant="primary" busy={busy} onClick={() => { void run(() => api.approve(pending.changeId), () => T.APPROVED); }}>{pending.kind === "lock" ? T.APPROVE_LOCK : T.APPROVE}</Button><span className="rv-muted">{T.APPROVE_HELP}</span></>}
    <Button disabled={busy} onClick={() => { void run(() => api.cancel(pending.changeId), () => T.WITHDRAWN); }}>{T.WITHDRAW}</Button>
   </div>}
   <p className="rv-muted">{T.PROJECTS_HELP}</p>
   <h3>{T.RULES_HEADING}</h3>
   <p className="rv-muted">{T.RULES_HELP}</p>
   <Select label={T.MIN_TIER} value={current.tier} options={MIN_TIER_OPTIONS} disabled={busy} onValueChange={value => patch({ tier: value })} />
   <Switch label={T.NO_SKIP} checked={current.noSkip} disabled={busy} onCheckedChange={checked => patch({ noSkip: checked })} />
   <TextField label={T.CAP} type="number" inputMode="decimal" min={DESIGN_REVIEW_CAP_MIN_USD} max={DESIGN_REVIEW_CAP_MAX_USD} step={0.5} value={current.cap} hint={T.CAP_HINT} {...(parsed.ok ? {} : { error: parsed.cap })} disabled={busy} onChange={event => patch({ cap: event.target.value })} />
   {state.groups === true && <TextField label={T.GROUP} value={current.group} disabled={busy} onChange={event => patch({ group: event.target.value })} />}
   <div className="rv-hww-company-actions">
    <Button variant="primary" busy={busy} disabled={!changed || !parsed.ok} onClick={() => { if (parsed.ok) void run(() => api.save(state.revision, { lock: parsed.lock }), status => (status === "needs_approval" ? T.ASKED_LOCK : T.SAVED)); }}>{T.SAVE}</Button>
    {edit !== undefined && <Button disabled={busy} onClick={() => { setEdit(undefined); }}>Discard</Button>}
   </div>
  </>;
 }
 return <section aria-label={T.HEADING} className="rv-hww-company-card rv-hww-suggestions" aria-busy={busy}><h2>{T.HEADING}</h2>{body}
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} />{message.signIn === true && <> <Button onClick={() => host.signIn(host.currentPath())}>{T.SIGN_IN_AGAIN}</Button></>}</p>}
 </section>;
}
