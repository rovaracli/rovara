// Connected sign-ins (DEC 254w): the ways to sign in to this account. The first one is how the person first signed in and stays. A second one (Slack or GitHub)
// is connected by going to that provider and coming back (Cloud's server keeps the verifier and state; the browser only gets the provider's address), and removed
// with Unlink. Removing one ends every sign-in of the person, so the page says so and offers to sign in again.
// G5 ship: the same handlers and refusals, drawn as the Account page's "Signing in and identities" rows (board 25b / mock 19a). The list itself is read the way the
// rest of Account is (identity checked before and after, a list with an unreadable row is "Can't tell yet", never a shorter list).
import { useContext, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { isNotConnected } from "../../api/admin-company.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { LINKABLE_METHODS, MY_SIGN_INS_PATH, SIGN_IN_LINK_PATH, isLinkableMethod, linkNotice, methodName, readLinkStart, signInMethodPath, type LinkableMethod } from "../../api/sign-ins.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import { IdentityContext, STALE_REFUSAL, readCompleteSignIns, servedFacts, useNoteWrite, useScopedRead, useWritable } from "../account-setup-read/read-model.js";
import { Notice, NotOnCode, Stamp } from "../account-setup-read/parts.js";
import { ReadState } from "../account-setup-read/ReadState.js";

export function ConnectedSignIns() {
 const host = useAppHost(), api = createApiClient(host), query = useQueryClient(), [params, setParams] = useSearchParams();
 const connecting = params.get("connect"), unlinking = params.get("unlink");
 const connect = isLinkableMethod(connecting) ? connecting : undefined, unlink = isLinkableMethod(unlinking) ? unlinking : undefined;
 const [notice, setNotice] = useState(() => linkNotice(params.get("linked"), params.get("link")));
 const [busy, setBusy] = useState(false), [problem, setProblem] = useState<{ kind: "failed" | "not_connected"; text: string }>(), [signedOut, setSignedOut] = useState(false);
 // The one write rule (useWritable), decided where the list is read (SignInRows) and read here at send time: the dialogs are drawn by this parent and may be open from the address.
 const writableRef = useRef(false), noteWrite = useNoteWrite();
 // The landing words are read once, then the address is cleaned so a reload never says it again.
 useEffect(() => {
  if (params.get("linked") === null && params.get("link") === null) return;
  const next = new URLSearchParams(params); next.delete("linked"); next.delete("link"); setParams(next, { replace: true });
 }, []); // eslint-disable-line react-hooks/exhaustive-deps
 const close = () => { setProblem(undefined); const next = new URLSearchParams(params); next.delete("connect"); next.delete("unlink"); setParams(next, { replace: true }); };
 const open = (key: "connect" | "unlink", method: LinkableMethod) => { setProblem(undefined); setNotice(undefined); const next = new URLSearchParams(params); next.delete("connect"); next.delete("unlink"); next.set(key, method); setParams(next, { replace: true }); };
 function failed(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.code === "SIGN_IN_NOT_CONNECTED") { setProblem({ kind: "failed", text: "That sign-in is already not connected." }); void query.invalidateQueries({ predicate: entry => entry.queryKey.includes(MY_SIGN_INS_PATH) }); }
  else if (isNotConnected(error)) setProblem({ kind: "not_connected", text: "" });
  else setProblem({ kind: "failed", text: error instanceof ApiError ? error.message : fallback });
 }
 async function start() {
  if (connect === undefined) return;
  if (!writableRef.current) { setProblem({ kind: "failed", text: STALE_REFUSAL }); return; }
  setBusy(true); setProblem(undefined);
  try { const { authorizeUrl } = await api.sendAnswer("POST", SIGN_IN_LINK_PATH, { method: connect }, { parse: body => readLinkStart(body, connect) }, { retry: "never" }); host.navigate(authorizeUrl); }
  catch (error) { failed(error, "Couldn't start connecting that sign-in. Try again."); setBusy(false); }
 }
 async function remove() {
  if (unlink === undefined) return;
  if (!writableRef.current) { setProblem({ kind: "failed", text: STALE_REFUSAL }); return; }
  setBusy(true); setProblem(undefined);
  try { await api.sendAnswer("DELETE", signInMethodPath(unlink), undefined, { parse: body => body }, { retry: "never" }); noteWrite("signin-removed"); setSignedOut(true); close(); }
  catch (error) { failed(error, "Couldn't unlink that sign-in. Try again."); }
  finally { setBusy(false); }
 }
 const dialogProblem = <>
  {problem?.kind === "failed" && <p role="alert" className="g5-dialog-alert"><VisibleText text={problem.text} /></p>}
  {problem?.kind === "not_connected" && <NotOnCode what="Connected sign-ins" />}
 </>;
 return <div className="g5-signins">
  {notice !== undefined && <Notice tone={notice.tone === "ok" ? "ok" : "bad"} testId="link-notice">{notice.text}</Notice>}
  {signedOut ? <div role="status" data-testid="unlinked-notice" className="g5-notice" data-tone="ok"><p>Sign-in removed. For your safety, every sign-in of yours has ended, here and everywhere else. Sign in again with a method you still have.</p><Button variant="primary" onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></div>
   : <SignInRows open={open} writableRef={writableRef} />}
  <Dialog className="g5-dialog" title={connect === undefined ? "Connect a sign-in" : `Connect ${methodName(connect)}?`} description="You go to the other sign-in to prove it's you, then come back here signed in to both." open={connect !== undefined} onOpenChange={next => { if (!next) close(); }}>
   <div className="g5-dialog-actions">{connect !== undefined && <Button variant="primary" busy={busy} onClick={() => { void start(); }}>{`Continue to ${methodName(connect)}`}</Button>}</div>
   {dialogProblem}
  </Dialog>
  <Dialog className="g5-dialog" title={unlink === undefined ? "Unlink a sign-in" : `Unlink ${methodName(unlink)}?`} description="You won't be able to sign in with it any more. This signs you out everywhere, so you sign in again with a method you still have." open={unlink !== undefined} onOpenChange={next => { if (!next) close(); }}>
   <div className="g5-dialog-actions">{unlink !== undefined && <Button variant="danger" busy={busy} onClick={() => { void remove(); }}>{`Unlink ${methodName(unlink)}`}</Button>}</div>
   {dialogProblem}
  </Dialog>
 </div>;
}

/** The list, its Connect buttons and the read behind them. Unmounted once an unlink has signed the person out, so nothing more is asked. */
function SignInRows({ open, writableRef }: { open: (key: "connect" | "unlink", method: LinkableMethod) => void; writableRef: { current: boolean } }) {
 const me = useContext(IdentityContext);
 const signIns = useScopedRead(MY_SIGN_INS_PATH, { parse: readCompleteSignIns });
 const have = new Set(servedFacts(signIns).data?.signIns.map(entry => entry.method));
 const writable = useWritable(signIns);
 useEffect(() => { writableRef.current = writable; return () => { writableRef.current = false; }; });
 const who = (method: string) => { const seen = me?.identities.find(identity => identity.provider === method); return seen?.login ?? seen?.email; };
 if (signIns.isError && isNotConnected(signIns.error)) return <ul className="g5-rows"><NotOnCode what="Connected sign-ins" row /></ul>;
 return <ReadState query={signIns} label="connected sign-ins" shell={node => <ul className="g5-rows" aria-label="Sign-in methods"><li className="g5-row" aria-label="Connected sign-ins">{node}</li></ul>}>{data => <>
  {data.signIns.length === 0
   ? <ul className="g5-rows" aria-label="Your sign-in methods"><li className="g5-row"><div className="g5-row-main"><h3>Sign-in methods</h3><p className="g5-row-detail">No connected sign-ins returned.</p></div></li></ul>
   : <ul className="g5-rows" aria-label="Your sign-in methods">{data.signIns.map((entry, index) => {
    const login = who(entry.method);
    return <li className="g5-row" key={`${entry.method}:${String(index)}`}>
     <div className="g5-row-main"><h3>{methodName(entry.method)}</h3><p className="g5-row-detail">{login !== undefined && <><VisibleText text={login} /> · </>}{entry.primary ? "how you first signed in" : entry.linkedAt === undefined ? "Connected" : <>Connected <Stamp iso={entry.linkedAt} /></>}</p></div>
     {writable && !entry.primary && isLinkableMethod(entry.method) && <div className="g5-row-aside"><Button aria-label={`Unlink ${methodName(entry.method)}`} onClick={() => { open("unlink", entry.method as LinkableMethod); }}>Unlink</Button></div>}
    </li>;
   })}</ul>}
  {writable && LINKABLE_METHODS.some(method => !have.has(method)) && <div className="g5-actions g5-connect">{LINKABLE_METHODS.filter(method => !have.has(method)).map(method => <Button key={method} onClick={() => { open("connect", method); }}>{`Connect ${methodName(method)}`}</Button>)}</div>}
  <p className="g5-foot">Connecting one lets you sign in to this same account with it. Your name, role and work stay as they are. Removing one signs you out everywhere.</p>
 </>}</ReadState>;
}
