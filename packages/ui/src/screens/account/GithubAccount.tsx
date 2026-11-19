// "Your GitHub account" (L4-GH): link the GitHub account that is yours, so Rovara knows which commits and pull requests are yours. It is not a way to sign in (that is "Connected
// sign-ins" above). Connecting sends you to GitHub and back here; Cloud's server keeps the state, the browser only gets GitHub's address.
// The page shows the linked login and an Unlink. Words come from this app, never from GitHub or Code.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isNotConnected } from "../../api/admin-company.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { MY_GITHUB_LINK_PATH, MY_GITHUB_PATH, githubLinkNotice, readGithubLinkStart, readMyGithub } from "../../api/github-link.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { AdminSection, NotConnected } from "../admin/parts.js";

const when = (value: string) => new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

export function GithubAccount() {
 const host = useAppHost(), api = createApiClient(host), query = useQueryClient(), [params, setParams] = useSearchParams();
 const connecting = params.get("github") === "connect", [notice, setNotice] = useState(() => githubLinkNotice(params.get("github_link")));
 const [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>(), [unlinking, setUnlinking] = useState(false);
 // The landing word is read once, then the address is cleaned so a reload never says it again.
 useEffect(() => {
  if (params.get("github_link") === null) return;
  const next = new URLSearchParams(params); next.delete("github_link"); setParams(next, { replace: true });
 }, []); // eslint-disable-line react-hooks/exhaustive-deps
 const link = useQuery({ queryKey: ["account", "github"], queryFn: () => api.get(MY_GITHUB_PATH, { parse: readMyGithub }), retry: false, gcTime: 0 });
 const close = () => { setProblem(undefined); const next = new URLSearchParams(params); next.delete("github"); setParams(next, { replace: true }); };
 const open = () => { setProblem(undefined); setNotice(undefined); const next = new URLSearchParams(params); next.set("github", "connect"); setParams(next, { replace: true }); };
 function failed(error: unknown, fallback: string) {
  setProblem(error instanceof ApiError && !isNotConnected(error) ? error.message : fallback);
 }
 async function start() {
  setBusy(true); setProblem(undefined);
  try { const { authorizeUrl } = await api.sendAnswer("POST", MY_GITHUB_LINK_PATH, {}, { parse: readGithubLinkStart }, { retry: "never" }); host.navigate(authorizeUrl); }
  catch (error) { failed(error, "Couldn't start connecting GitHub. Try again."); setBusy(false); }
 }
 async function remove() {
  setBusy(true); setProblem(undefined);
  try { await api.sendAnswer("DELETE", MY_GITHUB_PATH, undefined, { parse: body => body }, { retry: "never" }); setUnlinking(false); setNotice({ tone: "ok", text: "Your GitHub account is disconnected." }); await query.invalidateQueries({ queryKey: ["account", "github"] }); }
  catch (error) { failed(error, "Couldn't disconnect your GitHub account. Try again."); }
  finally { setBusy(false); }
 }
 return <AdminSection title="Your GitHub account" note="So Rovara knows which commits and pull requests are yours">
  {notice !== undefined && <p role={notice.tone === "ok" ? "status" : "alert"} data-testid="github-link-notice" data-tone={notice.tone}>{notice.text}</p>}
  {link.isPending ? <Skeleton label="Loading your GitHub connection" />
   : link.isError ? (isNotConnected(link.error) ? <NotConnected what="Your GitHub account" /> : <div role="alert" className="rv-banner rv-banner-danger"><span><b>Couldn't load your GitHub connection.</b></span><Button disabled={link.isFetching} onClick={() => { void link.refetch(); }}>Try again</Button></div>)
   : link.data.linked ? <div className="rv-connect-actions"><p><b data-testid="github-login"><VisibleText text={link.data.login} /></b>{link.data.linkedAt === undefined ? "" : ` · connected ${when(link.data.linkedAt)}`}</p><Button aria-label="Disconnect your GitHub account" onClick={() => { setProblem(undefined); setNotice(undefined); setUnlinking(true); }}>Unlink</Button></div>
   : <div className="rv-connect-actions"><p>No GitHub account connected.</p><Button onClick={open}>Connect your GitHub</Button></div>}
  <p className="rv-muted">This does not sign you in with GitHub. It only lets Rovara match your commits and reviews to you. Only you can connect or remove your own account.</p>
  <Dialog title="Connect your GitHub?" description="You go to GitHub to prove the account is yours, then come back here." open={connecting} onOpenChange={next => { if (!next) close(); }}>
   <Button variant="primary" busy={busy} onClick={() => { void start(); }}>Continue to GitHub</Button>
   {problem !== undefined && <p role="alert"><VisibleText text={problem} /></p>}
  </Dialog>
  <Dialog title="Unlink your GitHub account?" description="Rovara will stop matching commits and reviews to you. You can connect it again later." open={unlinking} onOpenChange={next => { if (!next) { setUnlinking(false); setProblem(undefined); } }}>
   <Button variant="danger" busy={busy} onClick={() => { void remove(); }}>Unlink GitHub</Button>
   {problem !== undefined && <p role="alert"><VisibleText text={problem} /></p>}
  </Dialog>
 </AdminSection>;
}
