// Guided onboarding PR 12b (design section 4 "Connections page", section 3 shared rules; DEC 254l item 2): Company settings, Connections. Each integration with
// its account name, who connected it and when, its health, Reconnect and Disconnect. Connect: a company owner or admin. Disconnect: a company OWNER only, with a
// fresh step-up (Cloud checks both before Code is asked; Code checks again). Everything shown is read from Code through Cloud; refusals show Cloud's fixed words.
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOnboardingApi } from "../../api/onboarding.js";
import { useIntegrationsApi } from "../../api/integrations.js";
import { ApiError } from "../../api/errors.js";
import { needsStepUp } from "../../api/admin-company.js";
import { isGithubUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { StatusPill } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { FreshSignIn } from "../admin/parts.js";
import { useSlackInstall } from "./SlackConnect.js";
import { LinearConnectButton } from "./LinearConnect.js";
import { readFailure } from "./read-failure.js";
import "./connect.css";

type Role = "owner" | "admin" | "member";
/** The refusals a disconnect may show: Cloud's fixed sentences for these routes (github-connect.ts, slack-connect.ts, linear-connect.ts). */
const DISCONNECT_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "NOT_FOUND", "NOT_ON_CODE_YET", "RUNTIME_UNAVAILABLE", "GITHUB_IN_USE", "NO_COMPANY", "CONFIG_INVALID"]);
const disconnectWords = (error: unknown, fallback: string) => error instanceof ApiError && DISCONNECT_CODES.has(error.code) ? error.message : fallback;
const when = (at: string) => { const date = new Date(at);return Number.isNaN(date.getTime()) ? "at an unknown time" : `on ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date)}`; };
const byWords = (by: { kind: string; name?: string | undefined } | undefined) => by === undefined ? "" : by.kind === "operator" ? "by a Rovara operator" : by.name === undefined ? "by a teammate" : `by ${by.name}`;

/** One "Disconnect" with its confirm, the owner-only and step-up rules, and the result. */
function Disconnect({ what, effect, role, testId, run }: { what: string; effect: string; role: Role; testId: string; run: () => Promise<ReactNode> }) {
 const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [stepUp, setStepUp] = useState(false), [done, setDone] = useState<ReactNode>();
 if (role !== "owner") return <p className="rv-connect-note" data-testid={`${testId}-owner-only`}>Only a company owner can disconnect {what}.</p>;
 if (done !== undefined) return <div role="status" data-testid={`${testId}-done`}>{done}</div>;
 async function go() {
  setBusy(true);setError(undefined);setStepUp(false);
  try { setDone(await run());setConfirming(false); }
  catch (caught) { if (needsStepUp(caught)) setStepUp(true); else setError(disconnectWords(caught, `${what} could not be disconnected just now; try again.`)); }
  finally { setBusy(false); }
 }
 return <div className="rv-connect-disconnect">
  {!confirming ? <Button data-testid={`${testId}-disconnect`} onClick={() => { setConfirming(true);setError(undefined); }}>Disconnect</Button> : <div data-testid={`${testId}-confirm`}>
   <p><strong>Disconnect {what}?</strong> {effect}</p>
   <div className="rv-connect-actions"><Button variant="danger" busy={busy} data-testid={`${testId}-disconnect-confirm`} onClick={() => { void go(); }}>Disconnect {what}</Button><Button onClick={() => setConfirming(false)}>Cancel</Button></div>
  </div>}
  {stepUp && <FreshSignIn action={`disconnect ${what}`} refused />}
  {error !== undefined && <p role="alert" data-testid={`${testId}-error`}><VisibleText text={error} /></p>}
 </div>;
}

function GithubConnections({ role }: { role: Role }) {
 const api = useOnboardingApi(), query = useQueryClient();
 const read = useQuery({ queryKey: ["github", "connections"], queryFn: api.githubConnections, retry: false });
 const canConnect = role === "owner" || role === "admin";
 return <section className="rv-connect-row" aria-label="GitHub" data-testid="connections-github">
  <h3>GitHub</h3>
  {read.isPending ? <p>Checking GitHub…</p> : read.isError ? <><p data-testid="connections-github-error"><VisibleText text={readFailure(read.error, "The company's GitHub connections could not be read just now; try again.")} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>
   : read.data.installations.length === 0 ? <><p>GitHub isn't connected. Nothing works without code.</p>{canConnect && <Link className="rv-button rv-button-primary" to="/app/onboard?step=github">Connect GitHub</Link>}</>
   : <ul className="rv-connect-list">{read.data.installations.map(item => {
    const health = item.status === "suspended" ? { label: "Suspended on GitHub", tone: "bad" as const } : item.status === "uninstalled" ? { label: "Removed on GitHub", tone: "bad" as const } : item.status === "active" ? { label: "Working", tone: "ok" as const } : { label: "Connected", tone: "idle" as const };
    return <li key={item.installationId} data-testid="connections-github-account">
     <p><strong><VisibleText text={item.accountLogin} /></strong>{item.accountType === undefined ? "" : item.accountType === "Organization" ? " (organization)" : " (personal account)"} <StatusPill tone={health.tone} label={health.label} /></p>
     <p className="rv-connect-note">Connected <VisibleText text={`${byWords(item.connectedBy)} ${when(item.connectedAt)}`.trim()} />.</p>
     {(item.status === "suspended" || item.status === "uninstalled") && <p data-testid="connections-github-broken">GitHub disconnected. Reconnect it so tasks can reach this account's repos.</p>}
     <div className="rv-connect-actions">{canConnect && item.status !== "active" && item.status !== undefined && <Link className="rv-button" to="/app/onboard?step=github">Reconnect</Link>}</div>
     <Disconnect what="GitHub" role={role} testId={`github-${String(item.installationId)}`} effect="Rovara stops using its repos. This is refused while projects use them: remove those repos from the projects first." run={async () => {
      const done = await api.githubDisconnect(item.installationId);
      void query.invalidateQueries({ queryKey: ["github"] });
      const url = done.uninstallUrl !== undefined && isGithubUrl(done.uninstallUrl) ? done.uninstallUrl : undefined;
      return <><p><VisibleText text={`Disconnected ${done.accountLogin}.`} /></p>{url !== undefined && <p>To remove the Rovara app from GitHub too, <a href={url} target="_blank" rel="noreferrer noopener">open GitHub's settings</a>.</p>}</>;
     }} />
    </li>;
   })}</ul>}
 </section>;
}

function SlackConnection({ role }: { role: Role }) {
 const api = useIntegrationsApi(), query = useQueryClient(), install = useSlackInstall();
 const read = useQuery({ queryKey: ["slack", "workspace"], queryFn: api.slackStatus, retry: false });
 const canConnect = role === "owner" || role === "admin", ws = read.data?.workspace ?? undefined;
 return <section className="rv-connect-row" aria-label="Slack" data-testid="connections-slack">
  <h3>Slack <span className="rv-connect-optional">Optional</span></h3>
  {read.isPending ? <p>Checking Slack…</p> : read.isError ? <><p data-testid="connections-slack-error"><VisibleText text={readFailure(read.error, "The company's Slack connection could not be read just now; try again.")} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></> : <>
   {ws === undefined ? <p>Rovara isn't in a Slack workspace.</p> : <>
    <p><strong><VisibleText text={ws.teamName ?? "Your Slack workspace"} /></strong> <StatusPill tone={ws.state === "connected" ? "ok" : "bad"} label={ws.state === "connected" ? "Working" : "Removed in Slack"} /></p>
    <p className="rv-connect-note">Added <VisibleText text={`${byWords(ws.connectedBy)} ${when(ws.connectedAt)}`.trim()} />.</p>
    {ws.state === "disconnected" && <p data-testid="connections-slack-broken">Rovara was removed from Slack. Add it again to reconnect.</p>}
   </>}
   {canConnect && (ws === undefined || ws.state === "disconnected") && <div className="rv-connect-actions"><Button variant="primary" busy={install.busy} data-testid="connections-slack-add" onClick={() => { void install.start(); }}>{ws === undefined ? "Add to Slack" : "Reconnect Slack"}</Button></div>}
   {install.error !== undefined && <p role="alert"><VisibleText text={install.error} /></p>}
   {ws !== undefined && ws.state === "connected" && <Disconnect what="Slack" role={role} testId="slack" effect="Rovara leaves the workspace, its bot token is revoked, and every project loses its linked channel." run={async () => {
    const done = await api.slackDisconnect();
    void query.invalidateQueries({ queryKey: ["slack"] });
    return <><p><VisibleText text={`Rovara was removed from ${done.workspaceName ?? "your Slack workspace"}.`} /></p>{done.projectsLosingChannel.length > 0 && <p>Projects that lost their channel: <VisibleText text={done.projectsLosingChannel.join(", ")} />.</p>}</>;
   }} />}
  </>}
 </section>;
}

function LinearConnection({ role }: { role: Role }) {
 const api = useIntegrationsApi(), query = useQueryClient();
 const read = useQuery({ queryKey: ["linear", "status"], queryFn: api.linearStatus, retry: false });
 const canConnect = role === "owner" || role === "admin", data = read.data;
 return <section className="rv-connect-row" aria-label="Linear" data-testid="connections-linear">
  <h3>Linear <span className="rv-connect-optional">Optional</span></h3>
  {read.isPending ? <p>Checking Linear…</p> : read.isError || data === undefined ? <><p data-testid="connections-linear-error"><VisibleText text={readFailure(read.error, "The company's Linear connection could not be read just now; try again.")} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></> : <>
   {data.workspace === undefined ? <p>Linear isn't connected.</p> : <>
    <p><strong><VisibleText text={data.workspace.name} /></strong> <StatusPill tone={data.status === "connected" ? "ok" : "bad"} label={data.status === "connected" ? "Working" : data.status === "needs_reconnect" ? "Needs reconnecting" : "Disconnected"} /></p>
    {data.connectedAt !== undefined && <p className="rv-connect-note">Connected <VisibleText text={`${data.connectedBy?.name === undefined ? "" : `by ${data.connectedBy.name} `}${when(data.connectedAt)}`} />.</p>}
    {data.status === "needs_reconnect" && <p data-testid="connections-linear-broken">Linear refused Rovara's token. Reconnect Linear.</p>}
   </>}
   {canConnect && data.status !== "connected" && <div className="rv-connect-actions"><LinearConnectButton label={data.workspace === undefined ? "Connect Linear" : "Reconnect Linear"} /></div>}
   {data.workspace !== undefined && data.status !== "disconnected" && <Disconnect what="Linear" role={role} testId="linear" effect="Rovara's Linear token is revoked and every project's Linear team is cleared." run={async () => {
    const done = await api.linearDisconnect();
    void query.invalidateQueries({ queryKey: ["linear"] });
    return <><p><VisibleText text={`Linear workspace ${done.workspaceName} was disconnected.`} /></p>{done.projects.length > 0 && <p>Projects that lost their Linear team: <VisibleText text={done.projects.join(", ")} />.</p>}</>;
   }} />}
  </>}
 </section>;
}

/** The Connections page's own section: GitHub, Slack and Linear for this company. `role` is the person's company role (Code's, via the admin area). */
export function CompanyConnections({ role }: { role: Role }) {
 return <section className="rv-connect-settings" aria-labelledby="rv-company-connections" data-testid="company-connections">
  <h2 id="rv-company-connections">Your company's connections</h2>
  <p>Company owners and admins connect. Only a company owner can disconnect, after confirming it's them.</p>
  <GithubConnections role={role} />
  <SlackConnection role={role} />
  <LinearConnection role={role} />
 </section>;
}
