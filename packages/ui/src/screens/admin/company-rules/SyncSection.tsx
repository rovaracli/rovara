// The optional repository file: what the server reports (connected or not, status, last check, the difference, the pull request) and the three things an admin can do: connect, sync now, disconnect. Connecting needs a recent sign-in;
// a refusal comes back in the server's words. Nothing here is guessed: a side that changed is only named when the answer says so.
import { useState, type FormEvent } from "react";
import { COMPANY_RULES_DEFAULT_FILE_PATH, COMPANY_RULES_SYNC_PROBLEM_TEXT, CompanyRulesBodySchema } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { useCompanyRulesApi, useCompanyRulesSync } from "../../../api/company-rules.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisuallyHidden } from "../../../design/VisuallyHidden.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { safeExternalUrl } from "../../../text/links.js";
import { FILE_STATE_WORDS, STATUS_WORDS, T, WRITE_BACK_WORDS } from "./company-rules-text.js";
import { formatWhen, Person } from "./format.js";
import { DiffView } from "./parts.js";
import { toDiff } from "./rules-logic.js";
import type { State } from "./types.js";
import { useRulesWrite } from "./use-rules-write.js";

function ConnectForm({ onStatus }: { onStatus: (text: string) => void }) {
 const api = useCompanyRulesApi(), write = useRulesWrite(onStatus);
 const [repository, setRepository] = useState(""), [path, setPath] = useState(""), [branch, setBranch] = useState(""), [invalid, setInvalid] = useState(false);
 async function submit(event: FormEvent) {
  event.preventDefault();
  const input = { action: "sync-connect" as const, repository: repository.trim(), ...(path.trim() === "" ? {} : { path: path.trim() }), ...(branch.trim() === "" ? {} : { branch: branch.trim() }) };
  // The same check the server makes on the name, so a typo is caught before a sign-in is asked for.
  if (!CompanyRulesBodySchema.safeParse(input).success) { setInvalid(true);return; }
  setInvalid(false);
  await write.run(() => api.syncConnect({ repository: input.repository, ...("path" in input ? { path: input.path } : {}), ...("branch" in input ? { branch: input.branch } : {}) }), T.CONNECTED);
 }
 return <form onSubmit={event => { void submit(event); }} className="rv-cr-form" noValidate aria-busy={write.busy}>
  <p className="rv-muted">{T.CONNECT_NEEDS_SIGN_IN}</p>
  <TextField label={T.REPO_LABEL} hint={T.REPO_HINT} value={repository} autoComplete="off" spellCheck={false} onChange={event => { setRepository(event.target.value);setInvalid(false); }} {...(invalid ? { error: T.REPO_INVALID } : {})} />
  <TextField label={T.PATH_LABEL} hint={T.PATH_HINT} placeholder={COMPANY_RULES_DEFAULT_FILE_PATH} value={path} autoComplete="off" spellCheck={false} onChange={event => { setPath(event.target.value); }} />
  <TextField label={T.BRANCH_LABEL} hint={T.BRANCH_HINT} value={branch} autoComplete="off" spellCheck={false} onChange={event => { setBranch(event.target.value); }} />
  <div className="rv-cr-actions"><Button type="submit" variant="primary" busy={write.busy}>{T.CONNECT}</Button></div>
  {write.view}
 </form>;
}

function Link({ href, children }: { href: string; children: string }) {
 const safe = safeExternalUrl(href);
 return safe === undefined ? <VisibleText text={children} /> : <a href={safe} target="_blank" rel="noopener noreferrer">{children}<VisuallyHidden> (opens in a new tab)</VisuallyHidden></a>;
}

function Connected({ state, onStatus }: { state: State; onStatus: (text: string) => void }) {
 const api = useCompanyRulesApi(), write = useRulesWrite(onStatus), read = useCompanyRulesSync(true), [asking, setAsking] = useState(false);
 const summary = state.sync;
 const detail = read.data !== undefined && read.data.connected === true ? read.data : undefined;
 const problem = detail?.problem ?? null;
 const problemText = problem === null ? undefined : (problem.text !== "" ? problem.text : (COMPANY_RULES_SYNC_PROBLEM_TEXT as Record<string, string>)[problem.code]);
 const writeBack = detail?.writeBack ?? null;
 return <div className="rv-cr-sync" aria-busy={write.busy}>
  {summary !== null && <p><strong><VisibleText text={STATUS_WORDS[summary.status] ?? "Status unknown"} />.</strong> Connected to <VisibleText text={`${summary.repository}, file ${summary.path} on ${summary.branch}`} />.</p>}
  {read.isPending ? <Skeleton label="Loading the file's status" /> : detail === undefined ? <p role="alert">{read.error instanceof ApiError ? read.error.message : T.SYNC_LOAD_FAILED}</p> : <>
   <dl className="rv-cr-facts">
    <div><dt>Repository</dt><dd><Link href={detail.repository.url}>{detail.repository.name}</Link></dd></div>
    <div><dt>File</dt><dd><VisibleText text={`${detail.path} on ${detail.branch}`} /></dd></div>
    <div><dt>Connected by</dt><dd><Person person={detail.connectedBy} />, {formatWhen(detail.connectedAt)}</dd></div>
    <div><dt>{T.LAST_CHECKED}</dt><dd>{detail.lastCheckedAt === null ? T.NEVER_CHECKED : formatWhen(detail.lastCheckedAt)}</dd></div>
   </dl>
   <p>{FILE_STATE_WORDS[detail.fileState] ?? ""}</p>
   {problemText !== undefined && <div role="note" className="rv-cr-alert"><strong>{T.PROBLEM_HEADING}.</strong> <VisibleText text={problemText} /></div>}
   {writeBack !== null && <p><strong>{T.WRITE_BACK_HEADING}.</strong> Version {writeBack.version} is {WRITE_BACK_WORDS[writeBack.state] ?? "in progress"}{writeBack.pullRequest === null ? "" : <>: <Link href={writeBack.pullRequest.url}>{`pull request #${String(writeBack.pullRequest.number)}`}</Link></>}. Updated {formatWhen(writeBack.updatedAt)}.</p>}
   {detail.diff !== null && detail.fileState === "differs" && <><h3>{T.DIFF_HEADING}</h3>{detail.changedSide !== null && <p>{T.SIDE_SENTENCE[detail.changedSide] ?? ""}</p>}<p className="rv-muted">{T.DIFF_LEGEND}</p><DiffView diff={toDiff(detail.diff)} label="Rovara now compared with the file" /></>}
  </>}
  <div className="rv-cr-actions">
   <Button variant="primary" busy={write.busy} onClick={() => { void write.run(() => api.syncNow(), T.SYNCED); }}>{T.SYNC_NOW}</Button>
   {!asking && <Button disabled={write.busy} onClick={() => { setAsking(true); }}>{T.DISCONNECT}</Button>}
  </div>
  {asking && <div role="group" aria-label="Disconnect the file" className="rv-cr-confirm"><p>{T.DISCONNECT_ASK}</p><div className="rv-cr-actions">
   <Button variant="danger" busy={write.busy} onClick={() => { void write.run(() => api.syncDisconnect(), T.DISCONNECTED).then(done => { if (done) setAsking(false); }); }}>{T.DISCONNECT_CONFIRM}</Button>
   <Button disabled={write.busy} onClick={() => { setAsking(false); }}>{T.KEEP}</Button></div></div>}
  {write.view}
 </div>;
}

export function SyncSection({ state, onStatus }: { state: State; onStatus: (text: string) => void }) {
 if (!(state.viewer.role === "owner" || state.viewer.role === "admin")) return null;
 return <section aria-labelledby="cr-sync" className="rv-cr-card"><h2 id="cr-sync">{T.SYNC_HEADING}</h2><p>{T.SYNC_INTRO}</p>
  {state.sync === null ? <><p><strong>{T.SYNC_NOT_CONNECTED}</strong></p><ConnectForm onStatus={onStatus} /></> : <Connected state={state} onStatus={onStatus} />}
 </section>;
}
