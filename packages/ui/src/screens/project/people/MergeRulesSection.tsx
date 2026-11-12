import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { isConfirmUrl } from "../../../text/links.js";
import { ApiError } from "../../../api/errors.js";
import { codeSettingsKey, useCodeSettings, useProjectPeopleApi } from "../../../api/project-people.js";
import { WAITING_FOR_ADMIN, WAITING_FOR_ADMIN_BODY, parseReviewers } from "./people-text.js";
import { failureText, useRequestId } from "./people-write.js";

const METHOD_WORDS: Readonly<Record<string, string>> = { squash: "Squash and merge", merge: "Merge commit" };
type Settings = NonNullable<ReturnType<typeof useCodeSettings>["data"]>;
export const STALE_SETTINGS_MESSAGE = "Someone changed these settings. Reload and try again.";

/**
 * The project's merge rules (code settings), where the People tab shows them: who Rovara asks to review, whether a person may approve a pull request Rovara made for them, and the merge method. Anyone who can see the
 * project reads them; the server's `viewer.canEditCodeSettings` decides who may change them. Turning self-approval ON answers 202: it waits for a company owner or admin ("Waiting for an admin"), and nothing changes until one confirms.
 */
export function MergeRulesSection({ project, canEdit, canConfirm }: { project: string; canEdit: boolean; canConfirm: boolean }) {
 const read = useCodeSettings(project, true), [open, setOpen] = useState(false), [waiting, setWaiting] = useState<string | undefined | false>(false);
 const host = useAppHost();
 return <section className="rv-project-section rv-people-merge" aria-labelledby="rv-people-merge-title">
  <h2 id="rv-people-merge-title">Merge rules</h2>
  {read.isPending ? <Skeleton label="Loading the merge rules" /> : read.isError ? <><p role="alert">Couldn't load the merge rules.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>
   : <>
    <dl className="rv-people-facts">
     <div><dt>Reviewers Rovara asks</dt><dd>{read.data.codeReviewers.length === 0 ? "No one is asked by name" : <VisibleText text={read.data.codeReviewers.join(", ")} />}</dd></div>
     <div><dt>Self-approval</dt><dd>{read.data.allowSelfApproval ? "On: a person may approve a pull request Rovara made for them" : "Off: a pull request Rovara made for someone needs a different person's approval"}</dd></div>
     <div><dt>Merge method</dt><dd>{METHOD_WORDS[read.data.mergeMethod] ?? read.data.mergeMethod}</dd></div>
    </dl>
    {waiting !== false && <div role="status" className="rv-people-waiting"><p><strong>{WAITING_FOR_ADMIN}</strong></p><p>{WAITING_FOR_ADMIN_BODY}</p>{canConfirm && waiting !== undefined && <Button onClick={() => { host.openExternal(waiting); }}>Open the confirmation</Button>}</div>}
    {canEdit ? <div className="rv-people-actions"><Button onClick={() => { setOpen(true); }}>Change merge rules</Button></div> : <p className="rv-muted">Only a project maintainer can change these.</p>}
    {open && <MergeRulesDialog project={project} settings={read.data} canConfirm={canConfirm} onOpenChange={setOpen} onWaiting={url => { setWaiting(url ?? undefined); }} />}
   </>}
 </section>;
}

function MergeRulesDialog({ project, settings, canConfirm, onOpenChange, onWaiting }: { project: string; settings: Settings; canConfirm: boolean; onOpenChange: (open: boolean) => void; onWaiting: (confirmUrl: string | null) => void }) {
 const api = useProjectPeopleApi(), query = useQueryClient(), host = useAppHost(), id = useRequestId();
 const [method, setMethod] = useState<string>(settings.mergeMethod === "unknown" ? "" : settings.mergeMethod), [self, setSelf] = useState(settings.allowSelfApproval), [reviewers, setReviewers] = useState(settings.codeReviewers.join("\n"));
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState<{ confirmUrl?: string }>();
 const edit = <T,>(set: (value: T) => void) => (value: T) => { id.reset();set(value); };
 async function save() {
  if (busy) return;
  const parsed = parseReviewers(reviewers);
  if (!parsed.ok) { setError(parsed.message);return; }
  const mergeMethod: "squash" | "merge" | undefined = method === "merge" ? "merge" : method === "squash" ? "squash" : undefined;
  const sameReviewers = parsed.names.length === settings.codeReviewers.length && parsed.names.every((name, index) => name === settings.codeReviewers[index]);
  const body = { requestId: id.get(), expectedRevision: settings.revision, ...(self === settings.allowSelfApproval ? {} : { allowSelfApproval: self }), ...(mergeMethod === undefined || mergeMethod === settings.mergeMethod ? {} : { mergeMethod }), ...(sameReviewers ? {} : { codeReviewers: parsed.names }) };
  if (Object.keys(body).length === 2) { setError("Nothing is changed yet.");return; }
  setBusy(true);setError(undefined);
  try {
   const result = await api.putCodeSettings(project, body);id.reset();
   await query.invalidateQueries({ queryKey: codeSettingsKey(project) });
   if (result.kind === "done") { onOpenChange(false);return; }
   const url = result.kind === "needs_confirmation" && result.confirmUrl !== undefined && isConfirmUrl(result.confirmUrl, host.origin) ? result.confirmUrl : undefined;
   setPending(url === undefined ? {} : { confirmUrl: url });onWaiting(url ?? null);
  } catch (failure) {
   id.settle(failure);
   const stale = failure instanceof ApiError && (failure.message === STALE_SETTINGS_MESSAGE || failure.status === 409);
   if (stale) { setError(STALE_SETTINGS_MESSAGE);await query.invalidateQueries({ queryKey: codeSettingsKey(project) }); } else setError(failureText(failure));
  } finally { setBusy(false); }
 }
 return <Dialog title="Change merge rules" open onOpenChange={next => { if (!busy) onOpenChange(next); }}>
  {pending === undefined ? <form className="rv-people-form" onSubmit={event => { event.preventDefault();void save(); }}>
   <Select label="Merge method" value={method} onValueChange={edit(setMethod)} placeholder="Not set" options={[{ value: "squash", label: METHOD_WORDS["squash"]! }, { value: "merge", label: METHOD_WORDS["merge"]! }]} />
   <TextArea label="Reviewers Rovara asks" hint="A person's login, or organization/team. One per line." rows={3} value={reviewers} onChange={event => { id.reset();setReviewers(event.target.value); }} />
   <Switch label="Let a person approve a pull request Rovara made for them" checked={self} onCheckedChange={edit(setSelf)} />
   {self && !settings.allowSelfApproval && <p className="rv-muted">Turning this on needs a company owner or admin to confirm it.</p>}
   {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   <div className="rv-people-actions"><Button type="submit" variant="primary" busy={busy}>Save</Button><Button disabled={busy} onClick={() => { onOpenChange(false); }}>Cancel</Button></div>
  </form> : <div className="rv-people-form" role="status">
   <p><strong>{WAITING_FOR_ADMIN}</strong></p><p>{WAITING_FOR_ADMIN_BODY}</p>
   {canConfirm && pending.confirmUrl !== undefined && <Button variant="primary" onClick={() => { host.openExternal(pending.confirmUrl!); }}>Open the confirmation</Button>}
   <div className="rv-people-actions"><Button onClick={() => { onOpenChange(false); }}>Close</Button></div>
  </div>}
 </Dialog>;
}
