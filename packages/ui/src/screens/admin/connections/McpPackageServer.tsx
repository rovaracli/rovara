import { useEffect, useState } from "react";
import { Button } from "../../../design/Button.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import type { McpServerView } from "../../../api/context-sources.js";

// "Rovara runs a package for it": the form and the card of a server Rovara runs from an npm package. This file is its own chunk (McpServers.tsx imports it lazily), so none of it is in the
// startup JavaScript. Nothing here holds a secret longer than the form: values are sent once and the form is cleared.

type StdioServer = McpServerView & { transport: Extract<McpServerView["transport"], { kind: "stdio" }> };

/** What the form starts with (McpServers.tsx makes it: empty, or carried over from a server that is already there). */
export interface PackageDraft { name: string; version: string; args: string; addresses: string; secretNames: string[] }

/** `host:port` per line; the port is required. Returns the first line that is not one. */
export function parseAddresses(text: string): { ok: true; destinations: Array<{ host: string; port: number }> } | { ok: false; line: string } {
 const destinations: Array<{ host: string; port: number }> = [];
 for (const line of text.split(/\r?\n/u).map(item => item.trim()).filter(Boolean)) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/u.exec(line), port = match === null ? 0 : Number(match[2]);
  if (match === null || port < 1 || port > 65_535) return { ok: false, line };
  destinations.push({ host: match[1]!.toLowerCase(), port });
 }
 return { ok: true, destinations };
}

const megabytes = (bytes: number) => bytes < 1_048_576 ? "under 1 MB" : `${Math.round(bytes / 1_048_576)} MB`;

/** What Rovara shows before an admin allows a package-run server: what it is, what it can reach, what it is given, and the fingerprint the approval is tied to. */
export function PackageCard({ server }: { server: StdioServer }) {
 const spec = server.transport.spec;
 return <div role="group" aria-label="What Rovara will run">
  <ul>
   <li>Package: <code><VisibleText text={`${spec.name}@${spec.version}`} /></code></li>
   {server.install !== undefined && <li>{server.install.packageCount} packages, {megabytes(server.install.unpackedBytes)} once unpacked. Rovara does not run install steps; a package that needs them is refused.</li>}
   <li>{spec.destinations.length === 0 ? "It may not reach any address." : <>It may reach only: {spec.destinations.map(item => <code key={`${item.host}:${item.port}`}><VisibleText text={`${item.host}:${item.port}`} />{" "}</code>)}</>}</li>
   <li>{spec.secretEnv.length === 0 ? "It is given no secrets." : <>It is given these secrets (values are never shown again): {spec.secretEnv.map(name => <code key={name}><VisibleText text={name} />{" "}</code>)}</>}</li>
   <li>Fingerprint: <code><VisibleText text={spec.integrity} /></code>{spec.bundleHash !== undefined && <> · files <code>{spec.bundleHash.slice(0, 12)}</code></>}. From now on Rovara runs only these exact files; a different version or different files is a new server to look at.</li>
  </ul>
  <p>A package with an unscoped name (no @scope/) can be confused with a lookalike on a mirror of the public registry. Check the name.</p>
 </div>;
}

const PHASES = [{ after: 0, words: "Installing the package (about 1 to 2 minutes)." }, { after: 75, words: "Testing it: Rovara starts it and asks what it offers." }];

/** Words for the wait, by seconds waited. The test is one request that takes a minute or two; this says honestly which part is probably running. */
export function progressWords(seconds: number): string {
 return [...PHASES].reverse().find(item => seconds >= item.after)!.words;
}
function Progress() {
 const [seconds, setSeconds] = useState(0);
 useEffect(() => { const timer = setInterval(() => setSeconds(value => value + 1), 1_000); return () => clearInterval(timer); }, []);
 return <p role="status">{progressWords(seconds)} Waited {seconds} s.</p>;
}

export interface PackageSubmit { transport: { kind: "stdio"; spec: Record<string, unknown> }; secrets?: Record<string, string> }

/** The form. `onSubmit` rejects with the broker's own sentence, which the parent shows; the values typed here are cleared whether it works or not. */
export function PackageForm({ initial, busy, onSubmit }: { initial: PackageDraft; busy: boolean; onSubmit: (body: PackageSubmit) => void }) {
 const [draft, setDraft] = useState(initial), [values, setValues] = useState<Record<string, string>>({}), [newName, setNewName] = useState(""), [problem, setProblem] = useState<string>();
 const set = (patch: Partial<PackageDraft>) => setDraft(current => ({ ...current, ...patch }));
 function addName() {
  const name = newName.trim();
  if (name === "" || draft.secretNames.includes(name) || draft.secretNames.length >= 8) return;
  set({ secretNames: [...draft.secretNames, name] });setNewName("");
 }
 function submit() {
  const parsed = parseAddresses(draft.addresses);
  if (!parsed.ok) { setProblem("Each address is a host name and a port, one per line, for example jira.corp.example:443."); return; }
  const missing = draft.secretNames.filter(name => (values[name] ?? "") === "");
  if (missing.length > 0) { setProblem("Give a value for each secret name, or remove the name."); return; }
  setProblem(undefined);
  const spec: Record<string, unknown> = { registry: "npm", name: draft.name.trim(), version: draft.version.trim(), args: draft.args.split(/\s+/u).filter(Boolean) };
  if (parsed.destinations.length > 0) spec.destinations = parsed.destinations;
  if (draft.secretNames.length > 0) spec.secretEnv = draft.secretNames;
  onSubmit({ transport: { kind: "stdio", spec }, ...(draft.secretNames.length === 0 ? {} : { secrets: Object.fromEntries(draft.secretNames.map(name => [name, values[name]!])) }) });
  setValues({});
 }
 return <div>
  <TextField label="Package" hint="An npm package name, for example @example/tracker-mcp. A name with an @scope/ is safer." maxLength={120} value={draft.name} onChange={event => set({ name: event.target.value })} required />
  <TextField label="Exact version" hint="For example 1.4.2. A range or a tag such as latest is not accepted." maxLength={50} value={draft.version} onChange={event => set({ version: event.target.value })} required />
  <TextField label="Arguments" hint="Optional, separated by spaces" maxLength={200} value={draft.args} onChange={event => set({ args: event.target.value })} />
  <TextArea label="Addresses it talks to" hint="Optional. One host and port per line, such as jira.corp.example:443. It can reach these and nothing else, and each must be inside the ranges your install allows." rows={3} maxLength={2000} value={draft.addresses} onChange={event => set({ addresses: event.target.value })} />
  <fieldset><legend>Secrets it is given</legend>
   <p className="rv-muted">Each secret is a name the package reads from its environment and a value. Rovara keeps the values for this server only and never shows them again.</p>
   {draft.secretNames.map(name => <TextField key={name} label={`Value of ${name}`} type="password" autoComplete="off" maxLength={4096} value={values[name] ?? ""} onChange={event => setValues(current => ({ ...current, [name]: event.target.value }))} />)}
   {draft.secretNames.length > 0 && <Button onClick={() => { set({ secretNames: draft.secretNames.slice(0, -1) }); }}>Remove the last secret</Button>}
   <TextField label="Add a secret name" hint="Capital letters, digits and underscores, for example JIRA_TOKEN" maxLength={64} value={newName} onChange={event => setNewName(event.target.value.toUpperCase())} />
   <Button onClick={addName} disabled={newName.trim() === "" || draft.secretNames.length >= 8}>Add this secret</Button>
  </fieldset>
  {problem !== undefined && <p role="alert">{problem}</p>}
  {busy ? <Progress /> : <Button variant="primary" onClick={submit}>Test it</Button>}
 </div>;
}
