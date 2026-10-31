import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createContextSourcesApi, type McpServerView } from "../../../api/context-sources.js";

const annotationWords = { read_only: "says it only reads", unannotated: "does not say whether it only reads", unsafe: "says it changes things" } as const;
const statusWords = { awaiting_approval: "Waiting for approval", approved: "Allowed", disabled: "Turned off" } as const;

function Offers({ server }: { server: McpServerView }) {
 return <details><summary>What it offers ({server.probe.tools.length} tools)</summary><ul>{server.probe.tools.map(tool => <li key={tool.name}><code><VisibleText text={tool.name} /></code>: {annotationWords[tool.annotation]}. <VisibleText text={tool.description} /></li>)}</ul></details>;
}

/**
 * "MCP servers on your network" (Enterprise). Paste an address, or a package for a server Rovara runs for you. Rovara tests it and shows what it offers; you allow it,
 * and from then on it is on the install's allow-list. Nothing else to edit. A Public install answers 403 and the section is not shown.
 */
export function McpServers() {
 const host = useAppHost(), api = useMemo(() => createContextSourcesApi(host), [host]);
 const client = useQueryClient(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
 const [kind, setKind] = useState<"http" | "stdio">("http"), [label, setLabel] = useState(""), [address, setAddress] = useState(""), [name, setName] = useState(""), [version, setVersion] = useState(""), [args, setArgs] = useState("");
 const [waiting, setWaiting] = useState<McpServerView>();
 const read = useQuery({ queryKey: ["mcp-servers"], retry: false, gcTime: 0, refetchOnWindowFocus: false, queryFn: async () => (await api.servers()).servers });
 const hidden = read.error instanceof ApiError && (read.error.status === 403 || read.error.status === 404);
 const servers = read.data, loadError = read.isError && !hidden ? (read.error instanceof ApiError ? read.error.message : "Couldn't load MCP servers.") : undefined;
 async function run(action: () => Promise<void>) { setBusy(true);setError(undefined);try { await action();await client.invalidateQueries({ queryKey: ["mcp-servers"] }); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Rovara couldn't do that. Try again."); } finally { setBusy(false); } }
 if (hidden) return null;
 const transport = kind === "http" ? { kind: "http", address: address.trim() } : { kind: "stdio", spec: { registry: "npm", name: name.trim(), version: version.trim(), args: args.split(/\s+/u).filter(Boolean) } };
 return <section aria-labelledby="mcp-servers-title">
  <h2 id="mcp-servers-title">MCP servers on your network</h2>
  <p>Add a server your team already runs, such as an issue tracker or a wiki. Rovara tests it, shows what it offers, and asks you before it uses it. Projects can then read from it in Understand, Plan, Plan check and Review, never in Build.</p>
  {(error ?? loadError) && <p role="alert">{error ?? loadError}</p>}
  {waiting ? <div role="group" aria-label="Tested server">
   <h3>Rovara tested <VisibleText text={waiting.label} /></h3>
   <p>It answered, and it offers these tools. Allow it only if this is the server you meant.</p>
   {waiting.transport.kind === "stdio" && <p>Package fingerprint (the tarball Rovara installed): <code><VisibleText text={waiting.transport.spec.integrity} /></code>. From now on Rovara installs only a package with this fingerprint.</p>}
   <Offers server={waiting} />
   <Button variant="primary" busy={busy} onClick={() => { void run(async () => { await api.approveServer(waiting.serverId);setWaiting(undefined);setLabel("");setAddress("");setName("");setVersion("");setArgs(""); }); }}>Allow this server</Button>
   <Button busy={busy} onClick={() => { void run(async () => { await api.removeServer(waiting.serverId);setWaiting(undefined); }); }}>Cancel</Button>
  </div> : <form onSubmit={event => { event.preventDefault();void run(async () => { setWaiting((await api.addServer({ label: label.trim(), transport })).server); }); }}>
   <h3>Add a server</h3>
   <TextField label="Name" maxLength={60} value={label} onChange={event => setLabel(event.target.value)} required />
   <fieldset><legend>How Rovara reaches it</legend>
    <label><input type="radio" name="mcp-kind" checked={kind === "http"} onChange={() => setKind("http")} /> It has an address</label>{" "}
    <label><input type="radio" name="mcp-kind" checked={kind === "stdio"} onChange={() => setKind("stdio")} /> Rovara runs a package for it</label>
   </fieldset>
   {kind === "http" ? <TextField label="Address" hint="Starts with https:// and uses the server's host name, in the form https://<host name>/<path>" maxLength={2048} value={address} onChange={event => setAddress(event.target.value)} required />
    : <><TextField label="Package" hint="An npm package name, for example @example/tracker-mcp" maxLength={120} value={name} onChange={event => setName(event.target.value)} required /><TextField label="Exact version" hint="For example 1.4.2. A range or a tag such as latest is not accepted." maxLength={50} value={version} onChange={event => setVersion(event.target.value)} required /><TextField label="Arguments" hint="Optional, separated by spaces" maxLength={200} value={args} onChange={event => setArgs(event.target.value)} /></>}
   <Button type="submit" variant="primary" busy={busy}>Test it</Button>
  </form>}
  <h3>Your servers</h3>
  {servers === undefined ? <p role="status">Loading MCP servers.</p> : servers.length === 0 ? <p>No MCP servers added yet.</p> : <ul>{servers.map(server => <li key={server.serverId}>
   <strong><VisibleText text={server.label} /></strong> · {statusWords[server.status]} · {server.transport.kind === "http" ? <VisibleText text={server.transport.address} /> : <VisibleText text={`${server.transport.spec.name}@${server.transport.spec.version}`} />}
   <Offers server={server} />
   {server.status === "awaiting_approval" && <Button disabled={busy} onClick={() => setWaiting(server)}>Review</Button>}
   {server.status === "approved" && <Button disabled={busy} onClick={() => { void run(async () => { await api.disableServer(server.serverId); }); }}>Turn off</Button>}
   {server.status !== "approved" && <Button disabled={busy} onClick={() => { void run(async () => { await api.removeServer(server.serverId); }); }}>Remove</Button>}
  </li>)}</ul>}
 </section>;
}
