// Slice p1-ux-connections: the form that adds a cloud or monitoring connection (Sentry, Datadog, Amazon CloudWatch, Grafana, Vercel or PagerDuty) from the Connections page.
// It sends the same `POST /v1/app/connections` the other connections use, and the broker checks the settings and the secret with the same schemas as everywhere else (this form only
// helps with plain words and the fixed choices). A key is write-only: typed into a password field, sent once, cleared from the page whatever the answer, never shown back.
// These connections are read only, so there is no access choice. Amazon CloudWatch has no key: Rovara assumes a role in the customer's account, so after it is added the page shows
// the external id and the trust policy to put on that role.
import { useState } from "react";
import { z } from "zod";
import { AWS_REGIONS, CLOUDWATCH_MAX_REGIONS, DATADOG_SITES } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../../host.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { TextField } from "../../../design/TextField.js";
import { causeText } from "./connection-state.js";

export type MonitoringKind = "sentry" | "datadog" | "cloudwatch" | "grafana" | "vercel" | "pagerduty";
interface Field { key: string; label: string; hint?: string; secret?: boolean; optional?: boolean; options?: ReadonlyArray<{ value: string; label: string }>; initial?: string }
interface Built { connection: Record<string, unknown>; secret?: Record<string, unknown> }
interface Tool { name: string; fields: readonly Field[]; build: (values: Readonly<Record<string, string>>) => Built | string }

const Created = z.object({ connection: z.object({ connectionId: z.string().max(100) }).passthrough() }).passthrough();
const Setup = z.object({ connection: z.object({ setup: z.object({ externalId: z.string().max(200), trustPolicy: z.unknown() }).optional() }).passthrough() }).passthrough();
const setupReader = { parse: (value: unknown) => Setup.parse(value) };

/** The regions as typed ("us-east-1, eu-west-1"): known region codes, none twice, at most the connection allows; otherwise the sentence that says what is wrong. */
export function parseRegions(text: string): string[] | string {
  const regions = text.split(/[\s,]+/).filter(region => region !== "");
  if (regions.length === 0) return "Name at least one region, such as us-east-1.";
  const known: readonly string[] = AWS_REGIONS;
  const unknown = regions.find(region => !known.includes(region));
  if (unknown !== undefined) return "One of the regions is not an AWS region code. Use codes such as us-east-1.";
  if (new Set(regions).size !== regions.length) return "A region is named twice.";
  if (regions.length > CLOUDWATCH_MAX_REGIONS) return `Name at most ${String(CLOUDWATCH_MAX_REGIONS)} regions.`;
  return regions;
}
const KEY_HINT = "Sent once to be stored securely. Rovara never shows it again.";
export const MONITORING_TOOLS: Readonly<Record<MonitoringKind, Tool>> = {
  sentry: {
    name: "Sentry",
    fields: [
      { key: "region", label: "Where your Sentry is hosted", options: [{ value: "us", label: "United States (sentry.io)" }, { value: "de", label: "Germany (de.sentry.io)" }], initial: "us" },
      { key: "orgSlug", label: "Sentry organization", hint: "The short name in your Sentry address, in lower case." },
      { key: "authToken", label: "Auth token", hint: `${KEY_HINT} Give it read access only.`, secret: true },
    ],
    build: v => ({ connection: { region: v.region, orgSlug: v.orgSlug }, secret: { authToken: v.authToken } }),
  },
  datadog: {
    name: "Datadog",
    fields: [
      { key: "site", label: "Datadog site", options: DATADOG_SITES.map(site => ({ value: site, label: site })), initial: "datadoghq.com" },
      { key: "apiKey", label: "API key", hint: KEY_HINT, secret: true },
      { key: "appKey", label: "Application key", hint: "A read-only application key. Sent once, never shown again.", secret: true },
    ],
    build: v => ({ connection: { site: v.site }, secret: { apiKey: v.apiKey, appKey: v.appKey } }),
  },
  cloudwatch: {
    name: "Amazon CloudWatch",
    fields: [
      { key: "roleArn", label: "IAM role Rovara may assume", hint: "For example arn:aws:iam::123456789012:role/RovaraReadOnly. You make the role after adding this; Rovara then shows what to put on it." },
      { key: "regions", label: "Regions", hint: `Up to ${String(CLOUDWATCH_MAX_REGIONS)}, separated by commas. For example us-east-1, eu-west-1.`, initial: "us-east-1" },
    ],
    build: v => { const regions = parseRegions(v.regions ?? "");return typeof regions === "string" ? regions : { connection: { roleArn: v.roleArn, regions } }; },
  },
  grafana: {
    name: "Grafana",
    fields: [
      { key: "baseUrl", label: "Grafana address", hint: "Your Grafana's https address, for example https://grafana.acme.dev. It must be reachable from the internet on the standard https port." },
      { key: "serviceAccountToken", label: "Service account token", hint: `${KEY_HINT} Give it a Viewer role.`, secret: true },
    ],
    build: v => ({ connection: { baseUrl: v.baseUrl }, secret: { serviceAccountToken: v.serviceAccountToken } }),
  },
  vercel: {
    name: "Vercel",
    fields: [
      { key: "teamId", label: "Team id (optional)", hint: "Starts with team_. Leave it empty for a personal account.", optional: true },
      { key: "token", label: "Access token", hint: KEY_HINT, secret: true },
    ],
    build: v => ({ connection: { ...(v.teamId === undefined || v.teamId.trim() === "" ? {} : { teamId: v.teamId.trim() }) }, secret: { token: v.token } }),
  },
  pagerduty: {
    name: "PagerDuty",
    fields: [
      { key: "region", label: "Where your PagerDuty is hosted", options: [{ value: "us", label: "United States" }, { value: "eu", label: "Europe" }], initial: "us" },
      { key: "apiKey", label: "API key", hint: `${KEY_HINT} Use a read-only key.`, secret: true },
    ],
    build: v => ({ connection: { region: v.region }, secret: { apiKey: v.apiKey } }),
  },
};
const KINDS = Object.keys(MONITORING_TOOLS) as MonitoringKind[];
const initialOf = (kind: MonitoringKind): Record<string, string> => Object.fromEntries(MONITORING_TOOLS[kind].fields.map(field => [field.key, field.initial ?? ""]));

/** `needsRoleSetup`: the connection added is Amazon CloudWatch, which can only be checked once the role exists (the parent should not check it at once). */
export function AddMonitoring({ onAdded }: { onAdded: (connectionId: string, needsRoleSetup: boolean) => void }) {
  const host = useAppHost();
  const [kind, setKind] = useState<MonitoringKind>("sentry"), [label, setLabel] = useState(MONITORING_TOOLS.sentry.name), [values, setValues] = useState(() => initialOf("sentry"));
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [role, setRole] = useState<{ externalId?: string; policy?: string; unavailable?: boolean }>();
  const tool = MONITORING_TOOLS[kind];
  const ready = label.trim() !== "" && tool.fields.every(field => field.optional === true || (values[field.key] ?? "").trim() !== "");
  const edit = (key: string, value: string) => { setValues(current => ({ ...current, [key]: value }));setRequestId(crypto.randomUUID()); };
  function pick(next: string) {
    if (!KINDS.includes(next as MonitoringKind)) return;
    const chosen = next as MonitoringKind;
    setKind(chosen);setLabel(MONITORING_TOOLS[chosen].name);setValues(initialOf(chosen));setError(undefined);setRole(undefined);setRequestId(crypto.randomUUID());
  }
  async function showRoleSetup(connectionId: string) {
    try {
      const setup = (await createApiClient(host).get(`/v1/app/connections/${encodeURIComponent(connectionId)}`, setupReader)).connection.setup;
      setRole(setup === undefined ? { unavailable: true } : { externalId: setup.externalId, policy: JSON.stringify(setup.trustPolicy, null, 2).slice(0, 4000) });
    } catch { setRole({ unavailable: true }); }
  }
  async function add() {
    if (!ready || busy) return;
    const trimmed = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
    const built = tool.build(trimmed);
    if (typeof built === "string") { setError(built);return; }
    setBusy(true);setError(undefined);setRole(undefined);
    try {
      const result = await createApiClient(host).send("POST", "/v1/app/connections", { requestId, connection: { type: kind, label: label.trim(), access: "read", ...built.connection }, ...(built.secret === undefined ? {} : { secret: built.secret }) }, Created, { retry: "never" });
      if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Rovara couldn't confirm the connection was added. Refresh before trying again.");
      const id = result.value.connection.connectionId;
      setRequestId(crypto.randomUUID());setValues(initialOf(kind));setLabel(tool.name);
      onAdded(id, kind === "cloudwatch");
      if (kind === "cloudwatch") await showRoleSetup(id);
    } catch (failure) { setError(failure instanceof ApiError ? causeText(failure.message) : "Couldn't add the connection. Try again."); }
    finally { setValues(current => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, tool.fields.find(field => field.key === key)?.secret === true ? "" : value])));setBusy(false); }
  }
  return <form className="rv-conn-add" onSubmit={event => { event.preventDefault();void add(); }}><h3>Add a cloud or monitoring tool</h3>
    <Select label="Which tool" value={kind} disabled={busy} onValueChange={pick} options={KINDS.map(value => ({ value, label: MONITORING_TOOLS[value].name }))} />
    <TextField label="Name" hint="What your team sees." value={label} maxLength={64} onChange={event => { setLabel(event.target.value);setRequestId(crypto.randomUUID()); }} />
    {tool.fields.map(field => field.options !== undefined
      ? <Select key={`${kind}-${field.key}`} label={field.label} value={values[field.key] ?? ""} onValueChange={value => { edit(field.key, value); }} options={field.options} />
      : <TextField key={`${kind}-${field.key}`} label={field.label} {...(field.hint === undefined ? {} : { hint: field.hint })} type={field.secret === true ? "password" : "text"} value={values[field.key] ?? ""} autoComplete={field.secret === true ? "new-password" : "off"} spellCheck={false} onChange={event => { if (field.secret === true) setValues(current => ({ ...current, [field.key]: event.target.value }));else edit(field.key, event.target.value); }} />)}
    <p className="rv-muted">Rovara only reads from this tool. It never changes anything in it.</p>
    <Button type="submit" variant="primary" busy={busy} disabled={!ready}>{kind === "cloudwatch" ? "Add Amazon CloudWatch" : "Add and check it works"}</Button>{error !== undefined && <p role="alert">{error}</p>}
    {role !== undefined && <div role="status"><h4>Next: make the role in your AWS account</h4>
      {role.unavailable === true ? <p>The connection was added. Rovara can't show the role setup here. Ask your Rovara operator for the external id and trust policy, then press Check it works.</p>
        : <><p>Create an IAM role with read-only CloudWatch access. Give it this trust policy, with external id <code>{role.externalId}</code>, so only your Rovara can use it. Then press Check it works on the connection.</p><pre>{role.policy}</pre></>}</div>}</form>;
}
