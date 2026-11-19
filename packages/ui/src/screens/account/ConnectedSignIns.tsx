// Connected sign-ins (DEC 254w): the ways to sign in to this account. The first one is how the person first signed in and stays. A second one (Slack or GitHub)
// is connected by going to that provider and coming back (Cloud's server keeps the verifier and state; the browser only gets the provider's address), and removed
// with Unlink. Removing one ends every sign-in of the person, so the page says so and offers to sign in again.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isNotConnected } from "../../api/admin-company.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { LINKABLE_METHODS, MY_SIGN_INS_PATH, SIGN_IN_LINK_PATH, isLinkableMethod, linkNotice, methodName, readLinkStart, readMySignIns, signInMethodPath, type LinkableMethod } from "../../api/sign-ins.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { AdminSection, NotConnected } from "../admin/parts.js";

const when = (value: string) => new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

export function ConnectedSignIns() {
 const host = useAppHost(), api = createApiClient(host), query = useQueryClient(), [params, setParams] = useSearchParams();
 const connecting = params.get("connect"), unlinking = params.get("unlink");
 const connect = isLinkableMethod(connecting) ? connecting : undefined, unlink = isLinkableMethod(unlinking) ? unlinking : undefined;
 const [notice, setNotice] = useState(() => linkNotice(params.get("linked"), params.get("link")));
 const [busy, setBusy] = useState(false), [problem, setProblem] = useState<{ kind: "failed" | "not_connected"; text: string }>(), [signedOut, setSignedOut] = useState(false);
 // The landing words are read once, then the address is cleaned so a reload never says it again.
 useEffect(() => {
  if (params.get("linked") === null && params.get("link") === null) return;
  const next = new URLSearchParams(params); next.delete("linked"); next.delete("link"); setParams(next, { replace: true });
 }, []); // eslint-disable-line react-hooks/exhaustive-deps
 const signIns = useQuery({ queryKey: ["account", "sign-ins"], queryFn: () => api.get(MY_SIGN_INS_PATH, { parse: readMySignIns }), retry: false, gcTime: 0, enabled: !signedOut });
 const close = () => { setProblem(undefined); const next = new URLSearchParams(params); next.delete("connect"); next.delete("unlink"); setParams(next, { replace: true }); };
 const open = (key: "connect" | "unlink", method: LinkableMethod) => { setProblem(undefined); setNotice(undefined); const next = new URLSearchParams(params); next.delete("connect"); next.delete("unlink"); next.set(key, method); setParams(next, { replace: true }); };
 function failed(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.code === "SIGN_IN_NOT_CONNECTED") { setProblem({ kind: "failed", text: "That sign-in is already not connected." }); void query.invalidateQueries({ queryKey: ["account", "sign-ins"] }); }
  else if (isNotConnected(error)) setProblem({ kind: "not_connected", text: "" });
  else setProblem({ kind: "failed", text: error instanceof ApiError ? error.message : fallback });
 }
 async function start() {
  if (connect === undefined) return;
  setBusy(true); setProblem(undefined);
  try { const { authorizeUrl } = await api.sendAnswer("POST", SIGN_IN_LINK_PATH, { method: connect }, { parse: body => readLinkStart(body, connect) }, { retry: "never" }); host.navigate(authorizeUrl); }
  catch (error) { failed(error, "Couldn't start connecting that sign-in. Try again."); setBusy(false); }
 }
 async function remove() {
  if (unlink === undefined) return;
  setBusy(true); setProblem(undefined);
  try { await api.sendAnswer("DELETE", signInMethodPath(unlink), undefined, { parse: body => body }, { retry: "never" }); setSignedOut(true); close(); }
  catch (error) { failed(error, "Couldn't unlink that sign-in. Try again."); }
  finally { setBusy(false); }
 }
 const have = new Set(signIns.data?.signIns.map(entry => entry.method));
 return <AdminSection title="Connected sign-ins" note="Other ways to sign in to this account">
  {notice !== undefined && <p role={notice.tone === "ok" ? "status" : "alert"} data-testid="link-notice" data-tone={notice.tone}>{notice.text}</p>}
  {signedOut && <div role="status" data-testid="unlinked-notice"><p>Sign-in removed. For your safety, every sign-in of yours has ended, here and everywhere else. Sign in again with a method you still have.</p><Button variant="primary" onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></div>}
  {signedOut ? null : signIns.isPending ? <Skeleton label="Loading your connected sign-ins" />
   : signIns.isError ? (isNotConnected(signIns.error) ? <NotConnected what="Connected sign-ins" /> : <div role="alert" className="rv-banner rv-banner-danger"><span><b>Couldn't load your connected sign-ins.</b></span><Button disabled={signIns.isFetching} onClick={() => { void signIns.refetch(); }}>Try again</Button></div>)
   : <>
    <ul className="rv-passkeys" aria-label="Your sign-in methods">{signIns.data.signIns.map(entry => <li key={entry.method}>
     <span>{methodName(entry.method)}<small>{entry.primary ? "how you first signed in" : entry.linkedAt === undefined ? "Connected" : `Connected ${when(entry.linkedAt)}`}</small></span>
     {!entry.primary && isLinkableMethod(entry.method) && <Button aria-label={`Unlink ${methodName(entry.method)}`} onClick={() => { open("unlink", entry.method as LinkableMethod); }}>Unlink</Button>}
    </li>)}</ul>
    <div className="rv-connect-actions">{LINKABLE_METHODS.filter(method => !have.has(method)).map(method => <Button key={method} onClick={() => { open("connect", method); }}>{`Connect ${methodName(method)}`}</Button>)}</div>
    <p className="rv-muted">Connecting one lets you sign in to this same account with it. Your name, role and work stay as they are. Removing one signs you out everywhere.</p>
   </>}
  <Dialog title={connect === undefined ? "Connect a sign-in" : `Connect ${methodName(connect)}?`} description="You go to the other sign-in to prove it's you, then come back here signed in to both." open={connect !== undefined} onOpenChange={next => { if (!next) close(); }}>
   {connect !== undefined && <Button variant="primary" busy={busy} onClick={() => { void start(); }}>{`Continue to ${methodName(connect)}`}</Button>}
   {problem?.kind === "failed" && <p role="alert"><VisibleText text={problem.text} /></p>}
   {problem?.kind === "not_connected" && <NotConnected what="Connected sign-ins" />}
  </Dialog>
  <Dialog title={unlink === undefined ? "Unlink a sign-in" : `Unlink ${methodName(unlink)}?`} description="You won't be able to sign in with it any more. This signs you out everywhere, so you sign in again with a method you still have." open={unlink !== undefined} onOpenChange={next => { if (!next) close(); }}>
   {unlink !== undefined && <Button variant="danger" busy={busy} onClick={() => { void remove(); }}>{`Unlink ${methodName(unlink)}`}</Button>}
   {problem?.kind === "failed" && <p role="alert"><VisibleText text={problem.text} /></p>}
   {problem?.kind === "not_connected" && <NotConnected what="Connected sign-ins" />}
  </Dialog>
 </AdminSection>;
}
