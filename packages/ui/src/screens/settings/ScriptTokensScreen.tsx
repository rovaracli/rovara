// Script tokens (UX5b): the person's tokens for their scripts and CI. List (name, the token's visible start, projects, permissions, expiry, last used), make one (shown once), revoke one.
// An owner or admin also sees the company's other tokens, to revoke them. One column, so it works on a phone.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppNavReaderSchema, SCRIPT_TOKEN_DEFAULT_DAYS, SCRIPT_TOKEN_MAX_DAYS, SCRIPT_TOKEN_NAME_MAX, type ScriptTokenPermission } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { createScriptTokensApi, type ScriptTokenRow } from "../../api/script-tokens.js";
import { Button } from "../../design/Button.js";
import { Checkbox } from "../../design/Checkbox.js";
import { Dialog } from "../../design/Dialog.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";

const PERMISSION_WORDS: Readonly<Record<ScriptTokenPermission, string>> = { read: "Read tasks", start: "Start tasks" };
const STATUS_WORDS: Readonly<Record<string, string>> = { active: "Active", expired: "Expired", revoked: "Revoked" };
const LIFETIMES = [7, SCRIPT_TOKEN_DEFAULT_DAYS, 60, SCRIPT_TOKEN_MAX_DAYS].map(days => ({ value: String(days), label: `${days} days` }));
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }) + " UTC";
const problem = (error: unknown) => error instanceof ApiError ? error.message : "Rovara couldn't complete this. Try again shortly.";

export function ScriptTokensScreen() {
 const host = useAppHost(), api = useMemo(() => createScriptTokensApi(host), [host]), client = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const key = useMemo(() => ["script-tokens"], []);
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => client.get("/v1/app/nav", AppNavReaderSchema) });
 const read = useQuery({ queryKey: key, queryFn: () => api.list(), gcTime: 0, refetchOnWindowFocus: false });
 const [name, setName] = useState(""), [projects, setProjects] = useState<string[]>([]), [permissions, setPermissions] = useState<ScriptTokenPermission[]>(["read"]), [days, setDays] = useState(String(SCRIPT_TOKEN_DEFAULT_DAYS));
 const [busy, setBusy] = useState<string>(), [error, setError] = useState<string>(), [reauth, setReauth] = useState(false), [made, setMade] = useState<{ name: string; secret: string }>(), [revoking, setRevoking] = useState<ScriptTokenRow>(), [copied, setCopied] = useState(false);
 const sending = useRef(false);
 // The token lives only in this screen's state while its dialog is open: closing it, or leaving the screen, forgets it.
 useEffect(() => () => { setMade(undefined);query.removeQueries({ queryKey: key }); }, [query, key]);

 async function run(label: string, work: () => Promise<void>) {
  if (sending.current) return;
  sending.current = true;setBusy(label);setError(undefined);setReauth(false);
  try { await work(); await read.refetch(); }
  catch (caught) { setError(problem(caught));setReauth(caught instanceof ApiError && caught.code === "REAUTH_REQUIRED"); }
  finally { sending.current = false;setBusy(undefined); }
 }
 const toggle = <T extends string>(list: T[], value: T, on: boolean) => on ? [...list.filter(item => item !== value), value] : list.filter(item => item !== value);
 const canCreate = name.trim() !== "" && projects.length > 0 && permissions.length > 0 && busy === undefined;
 const create = () => run("create", async () => {
  const answer = await api.create({ name: name.trim(), projects, permissions, days: Number(days) });
  setMade({ name: answer.token.name, secret: answer.secret });setCopied(false);setName("");setProjects([]);
 });
 const revoke = (tokenId: string) => run("revoke:" + tokenId, async () => { await api.revoke(tokenId);setRevoking(undefined); });
 async function copy(secret: string) { try { await navigator.clipboard.writeText(secret);setCopied(true); } catch { setCopied(false); } }

 const projectNames = nav.data?.projects.map(project => project.name) ?? [];
 return <section aria-busy={read.isFetching} className="rv-script-tokens">
  <PageHeader focusOnMount title="Script tokens" description="A script token lets your own scripts and CI read and start your tasks without signing in. It acts as you, only on the projects and with the permissions you choose, and stops working when it expires, when you revoke it, or when your role changes." />
  <form onSubmit={event => { event.preventDefault();if (canCreate) void create(); }} aria-label="Make a script token">
   <TextField label="Name" hint="What uses it, for example the deploy job." value={name} onChange={event => { setName(event.target.value); }} maxLength={SCRIPT_TOKEN_NAME_MAX} autoComplete="off" />
   <fieldset><legend>Projects</legend>{nav.isPending ? <Skeleton label="Loading your projects" /> : projectNames.length === 0 ? <p className="rv-muted">You have no projects yet.</p> : projectNames.map(project => <Checkbox key={project} label={project} checked={projects.includes(project)} onCheckedChange={checked => { setProjects(list => toggle(list, project, checked === true)); }} />)}</fieldset>
   <fieldset><legend>It may</legend>{(["read", "start"] as const).map(permission => <Checkbox key={permission} label={PERMISSION_WORDS[permission]} checked={permissions.includes(permission)} onCheckedChange={checked => { setPermissions(list => toggle(list, permission, checked === true)); }} />)}</fieldset>
   <Select label="Expires after" value={days} onValueChange={setDays} options={LIFETIMES} />
   <p className="rv-muted">A token can never make tokens, change people, roles, billing, company settings or secrets, or approve or decide anything for you.</p>
   <Button type="submit" variant="primary" busy={busy === "create"} disabled={!canCreate}>Make token</Button>
  </form>
  {error !== undefined && <p role="alert"><VisibleText text={error} />{reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}</p>}
  <h2>Tokens</h2>
  {read.isPending ? <Skeleton label="Loading script tokens" /> : read.isError ? <div><p role="alert"><VisibleText text={problem(read.error)} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div>
   : read.data.tokens.length === 0 ? <p>No script tokens yet.</p> : <ul className="rv-token-list" aria-label="Script tokens">
    {read.data.tokens.map(token => <li key={token.tokenId} aria-label={token.name}>
     <h3><VisibleText text={token.name} /></h3>
     <dl>
      <dt>Starts with</dt><dd><code>{token.hint}</code></dd>
      <dt>Projects</dt><dd><VisibleText text={token.projects.join(", ")} /></dd>
      <dt>May</dt><dd>{token.permissions.map(permission => PERMISSION_WORDS[permission as ScriptTokenPermission] ?? "Unknown").join(", ")}</dd>
      <dt>Status</dt><dd>{STATUS_WORDS[token.status] ?? "Unknown"}{token.status === "active" && <>, expires {day(token.expiresAt)}</>}{token.revokedAt !== undefined && <> {day(token.revokedAt)}</>}</dd>
      <dt>Last used</dt><dd>{token.lastUsedAt === undefined ? "Never" : day(token.lastUsedAt)}</dd>
      {!token.mine && <><dt>Made by</dt><dd><VisibleText text={token.createdBy ?? "Someone in your company"} /></dd></>}
     </dl>
     {token.status === "active" && <div className="rv-actions"><Button variant="danger" disabled={busy !== undefined} onClick={() => { setRevoking(token); }}>Revoke</Button></div>}
    </li>)}
   </ul>}
  <h2>Use it from a script</h2>
  <p>Send the token in the Authorization header. Keep it in your CI's secret store, never in code.</p>
  <pre className="rv-token-example"><code>{`curl -H "Authorization: Bearer $ROVARA_TOKEN" \\\n  "${host.origin}/v1/dev/tasks?project=PROJECT"\n\ncurl -X POST -H "Authorization: Bearer $ROVARA_TOKEN" \\\n  -H "content-type: application/json" \\\n  -d '{"requestId":"'"$(uuidgen)"'","project":"PROJECT","instructions":"Fix the flaky test","client":"ci"}' \\\n  "${host.origin}/v1/dev/tasks"`}</code></pre>
  <Dialog open={made !== undefined} onOpenChange={open => { if (!open) setMade(undefined); }} title="Copy your token now" description="This is the only time Rovara shows it. If you lose it, revoke it and make a new one.">
   {made !== undefined && <><p><VisibleText text={made.name} /></p><TextField label="Token" value={made.secret} readOnly className="rv-token-secret" onFocus={event => { event.currentTarget.select(); }} />
    <div className="rv-actions"><Button variant="primary" onClick={() => { void copy(made.secret); }}>{copied ? "Copied" : "Copy token"}</Button><Button onClick={() => { setMade(undefined); }}>Done</Button></div></>}
  </Dialog>
  <Dialog open={revoking !== undefined} onOpenChange={open => { if (!open) setRevoking(undefined); }} title="Revoke this token?" description="It stops working at once. Anything that uses it will be refused.">
   {revoking !== undefined && <><p><VisibleText text={revoking.name} /></p><div className="rv-actions"><Button onClick={() => { setRevoking(undefined); }}>Cancel</Button><Button variant="danger" busy={busy === "revoke:" + revoking.tokenId} disabled={busy !== undefined} onClick={() => { void revoke(revoking.tokenId); }}>Revoke token</Button></div></>}
  </Dialog>
 </section>;
}
