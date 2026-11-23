// "Your GitHub account" (L4-GH, board personal-github / mock 25c): link the GitHub account that is yours, so Rovara knows which commits and pull requests are yours.
// It is not a way to sign in (that is "Sign-in methods" on Account). Connecting sends you to GitHub and back; Cloud's server keeps the state, the browser only gets
// GitHub's address. G5 ship: the read, Connect, Unlink and the landing words are the live Account section's (same handlers, same refusals), on this page.
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
import { PageHeader } from "../../design/PageHeader.js";
import { ReconnectingLine } from "./reconnecting.js";
import { Foot, Mark, Notice, NotOnCode, Pill, ReadFrom, Row, RowBody, Rows, Section, Stamp, VisibleText, type RowTone } from "./parts.js";
import { ReadState } from "./ReadState.js";
import { COULDNT_REFRESH, STALE_REFUSAL, rereadFailed, servedFacts, useNoteWrite, useReadIdentity, useWritable } from "./read-model.js";

const WHILE_LINKED = [
 (name: string) => `A review you leave on GitHub shows on the task as ${name}'s review`,
 () => "Your pull request comments can teach Rovara, as yours, where Sources allows it",
 () => "Commits you push to a task's branch are shown under your name",
];
const IT_IS_NOT = [
 "The Rovara app on your company's GitHub organization. That is in Company, Connections.",
 "A way to sign in. Sign-in methods are a separate list.",
 "Extra access. Rovara reads and writes repos only through the company's app.",
];
const UNLINK: readonly (readonly [RowTone, string, string, (name: string) => string])[] = [
 ["attention", "Reviews and comments you leave on GitHub from then on", "They show as from an unlinked GitHub account. They can't teach Rovara and don't count as your review.", name => `Not recognised as ${name}`],
 ["ok", "What you already did", "Past reviews, decisions and commits keep your name.", () => "Stays yours"],
 ["none", "The company's GitHub connection", "The app on your company's GitHub organization and its repos stay as they are.", () => "Not touched"],
 ["none", "Your sign-in with GitHub", "You stay signed in. To remove the sign-in, use Sign-in methods.", () => "Not touched"],
];
/** Your own GitHub account link, distinct from the company's repository access. Only you can connect or remove your own account. */
export function GithubAccountReadScreen() {
 const me = useReadIdentity();
 const host = useAppHost(), api = createApiClient(host), query = useQueryClient(), [params, setParams] = useSearchParams();
 const connecting = params.get("github") === "connect", [notice, setNotice] = useState(() => githubLinkNotice(params.get("github_link")));
 const [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>(), [unlinking, setUnlinking] = useState(false);
 // The landing word is read once, then the address is cleaned so a reload never says it again.
 useEffect(() => {
  if (params.get("github_link") === null) return;
  const next = new URLSearchParams(params); next.delete("github_link"); setParams(next, { replace: true });
 }, []); // eslint-disable-line react-hooks/exhaustive-deps
 const github = useQuery({ queryKey: ["account", "github"], queryFn: () => api.get(MY_GITHUB_PATH, { parse: readMyGithub }), retry: false, gcTime: 0 });
 // Connect and Unlink follow the one rule (useWritable): offered and sent only while who you are and the GitHub link are fresh reads.
 const writable = useWritable(github), noteWrite = useNoteWrite();
 const close = () => { setProblem(undefined); const next = new URLSearchParams(params); next.delete("github"); setParams(next, { replace: true }); };
 const open = () => { setProblem(undefined); setNotice(undefined); const next = new URLSearchParams(params); next.set("github", "connect"); setParams(next, { replace: true }); };
 function failed(error: unknown, fallback: string) {
  setProblem(error instanceof ApiError && !isNotConnected(error) ? error.message : fallback);
 }
 async function start() {
  if (!writable) { setProblem(STALE_REFUSAL); return; }
  setBusy(true); setProblem(undefined);
  try { const { authorizeUrl } = await api.sendAnswer("POST", MY_GITHUB_LINK_PATH, {}, { parse: readGithubLinkStart }, { retry: "never" }); host.navigate(authorizeUrl); }
  catch (error) { failed(error, "Couldn't start connecting GitHub. Try again."); setBusy(false); }
 }
 async function remove() {
  if (!writable) { setProblem(STALE_REFUSAL); return; }
  setBusy(true); setProblem(undefined);
  try { await api.sendAnswer("DELETE", MY_GITHUB_PATH, undefined, { parse: body => body }, { retry: "never" }); noteWrite(); setUnlinking(false); setNotice({ tone: "ok", text: "Your GitHub account is disconnected." }); const mine = await rereadFailed(query, { queryKey: ["account", "github"] }), others = await rereadFailed(query, { queryKey: ["g5-account-setup"] }); if (mine || others) setNotice({ tone: "ok", text: `Your GitHub account is disconnected. ${COULDNT_REFRESH}` }); }
  catch (error) { failed(error, "Couldn't disconnect your GitHub account. Try again."); }
  finally { setBusy(false); }
 }
 const first = me.developer.name;
 const linkFacts = servedFacts(github).data, state = linkFacts === undefined ? undefined : linkFacts.linked ? `linked as ${linkFacts.login}` : "not linked";
 const description = [me.developer.email, state].filter((part): part is string => part !== undefined).join(" · ");
 return <>
  <PageHeader title="Your GitHub account" breadcrumbs={[{ label: "Account", href: "/app/account" }, { label: "Your GitHub account" }]} {...(description === "" ? {} : { description })} />
  <ReconnectingLine />
  <section className="g5-main g5-stack" aria-label="Your GitHub account">
   <p className="g5-lede" style={{ margin: 0 }}>Linking tells Rovara which GitHub account is you, so your review comments, approvals and commits on {me.org.name}&apos;s pull requests count as yours.</p>
   {notice !== undefined && <Notice tone={notice.tone === "ok" ? "ok" : "bad"} testId="github-link-notice">{notice.text}</Notice>}
   {github.isError && isNotConnected(github.error) ? <Rows label="GitHub link"><NotOnCode what="Your GitHub account" row /></Rows>
    : <ReadState query={github} label="your GitHub link" variant="page" code="PERSONAL-GITHUB-READ-FAILED">{(data, at) => <>
     <Rows label="GitHub link">
      {data.linked
       ? <li className="g5-row" aria-label="Your GitHub account"><RowBody title={<>GitHub · <b data-testid="github-login"><VisibleText text={data.login} /></b></>} detail={<>{data.linkedAt !== undefined && <>Linked <Stamp iso={data.linkedAt} /> · </>}<ReadFrom at={at} /></>} chip={<Pill tone="ok">Linked</Pill>} />{writable && <div className="g5-row-aside"><Button aria-label="Disconnect your GitHub account" onClick={() => { setProblem(undefined); setNotice(undefined); setUnlinking(true); }}>Unlink</Button></div>}</li>
       : <li className="g5-row" aria-label="Your GitHub account"><RowBody title="GitHub" detail={<>No GitHub account connected. <ReadFrom at={at} /></>} />{writable && <div className="g5-row-aside"><Button variant="primary" onClick={open}>Connect your GitHub</Button></div>}</li>}
     </Rows>
     <p className="g5-foot">This does not sign you in with GitHub. It only lets Rovara match your commits and reviews to you. Only you can connect or remove your own account.</p>
     {data.linked && <>
      <div className="g5-two">
       <div><h3>While linked</h3><ul>{WHILE_LINKED.map(text => <li key={text(first)}><Mark tone="ok" /><span><VisibleText text={text(first)} /></span></li>)}</ul></div>
       <div><h3>It is not</h3><ul>{IT_IS_NOT.map(text => <li key={text}><Mark tone="ban" /><span>{text}</span></li>)}</ul></div>
      </div>
      <Section title="If you unlink"><Rows>{UNLINK.map(([tone, title, detail, end]) => <Row key={title} mark={tone} title={title} detail={detail} aside={<VisibleText text={end(first)} />} />)}</Rows></Section>
      <Foot>You can link again at any time.</Foot>
     </>}
    </>}</ReadState>}
  </section>
  <Dialog className="g5-dialog" title="Connect your GitHub?" description="You go to GitHub to prove the account is yours, then come back here." open={connecting} onOpenChange={next => { if (!next) close(); }}>
   <div className="g5-dialog-actions"><Button variant="primary" busy={busy} onClick={() => { void start(); }}>Continue to GitHub</Button></div>
   {problem !== undefined && <p role="alert" className="g5-dialog-alert"><VisibleText text={problem} /></p>}
  </Dialog>
  <Dialog className="g5-dialog" title="Unlink your GitHub account?" description="Rovara will stop matching commits and reviews to you. You can connect it again later." open={unlinking} onOpenChange={next => { if (!next) { setUnlinking(false); setProblem(undefined); } }}>
   <div className="g5-dialog-actions"><Button variant="danger" busy={busy} onClick={() => { void remove(); }}>Unlink GitHub</Button><Button disabled={busy} onClick={() => { setUnlinking(false); setProblem(undefined); }}>Keep it linked</Button></div>
   {problem !== undefined && <p role="alert" className="g5-dialog-alert"><VisibleText text={problem} /></p>}
  </Dialog>
 </>;
}
