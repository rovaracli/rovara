// Internal addresses a company's tasks may reach (owner decision 123): `/v1/app/org/private-addresses`. `org` is a browser route family, so the app reaches it as `/v1/web/org/private-addresses`.
//   GET     a company owner or admin: the approved list, its revision and digest, and the proposal waiting for a different admin (its entries, what it adds and removes, and whether the reader made it).
//   POST    an owner or admin, from a live browser session only (a token, the CLI or Slack never change it; the entry file refuses them first):
//             { action: "propose", expectedRevision, entries }   only removals: applied at once (200 applied); anything added: a proposal (202 needs_approval);
//             { action: "approve", changeId, expectedDigest }    a DIFFERENT owner or admin, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise); no sole-owner exception;
//             { action: "withdraw", changeId }                   the proposer withdraws, or another admin turns it down.
// No switch: the empty list is the default and opens nothing (decision 116: no opt-in beyond the setting itself). The rules are org/private-addresses.ts; answers are fixed words, counts and the entries an admin reads.
// Offered only where workers can reach a private network (review H1): an Enterprise install with routed ranges (ROVARA_PRIVATE_ADDRESS_CIDRS). Elsewhere (a hosted install) GET is not found, as any unknown path, so the
// screen's link is not shown, and POST is refused in words. Entries must be inside the routed ranges and on a port the worker security group opens there (ROVARA_PRIVATE_ADDRESS_PORTS); a name not on the install's
// allowed websites is accepted with a warning (tasks may not be able to look it up).
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { PRIVATE_ADDRESSES_MAX, PRIVATE_ADDRESSES_PATH, PrivateAddressesBodySchema, privateAddressListDigest, type PrivateAddressesState } from "@agentx/cloud-contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import {
  PRIVATE_ADDRESS_WORDS, approvePrivateAddresses, listDifference, openPrivateAddressChange, proposePrivateAddresses, readPrivateAddressesForChange, withdrawPrivateAddresses, type PrivateAddressDeps,
} from "../../org/private-addresses.js";
import { privateAddressRouteInstallOf } from "../../org/private-address-install.js";
import { approvedUnion } from "../../org/egress-domains.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export { PRIVATE_ADDRESSES_PATH };
export const PRIVATE_ADDRESSES_BROWSER_MESSAGE = "Use a live browser session to change the internal addresses tasks may reach.";
export const PRIVATE_ADDRESSES_UNAVAILABLE_MESSAGE = "This install has no route to a private network, so tasks can't reach internal addresses here. Internal addresses are an Enterprise setting for installs that route to your network.";

/** Whether a name is on the allowed websites the DNS firewall serves (an exact entry, or a `*.` entry it falls under). */
export function onAllowedWebsites(name: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => entry === name || (entry.startsWith("*.") && name.endsWith(entry.slice(1))));
}

/** Warnings for the names a list adds that are not on the allowed websites, by position in the list sent. An unreadable list warns about every added name (never refuses). */
async function nameWarnings(deps: PrivateAddressDeps, sent: readonly string[], added: readonly string[]): Promise<string[]> {
  const names = added.filter((entry) => !/^\d+\.\d+\.\d+\.\d+:/u.test(entry));
  if (names.length === 0) return [];
  const allowed = await approvedUnion(deps).catch(() => [] as string[]);
  const position = (entry: string) => sent.findIndex((text) => text.trim().toLowerCase() === entry) + 1;
  return names.filter((entry) => !onAllowedWebsites(entry.slice(0, entry.lastIndexOf(":")), allowed))
    .map((entry) => `Entry ${String(position(entry))} is a name that is not on this install's allowed websites, so tasks may not be able to look it up. Add the name to a project's Allowed websites, or list the server by its IP address.`);
}

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

function depsOf(deps: DeveloperRouteDependencies, install: NonNullable<ReturnType<typeof privateAddressRouteInstallOf>>): PrivateAddressDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "This setting is not available here.");
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    evidence: { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now }, install, now: () => deps.now(),
  };
}

async function stateOf(deps: PrivateAddressDeps, caller: DeveloperCaller): Promise<PrivateAddressesState> {
  const list = await readPrivateAddressesForChange(deps, caller.orgId).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", "The internal address list could not be read. Try again."); });
  const open = await openPrivateAddressChange(deps, caller.orgId, deps.now(), list);
  const pending = open === undefined ? undefined : { changeId: open.id, entries: open.entries, digest: privateAddressListDigest(open.entries), ...listDifference(list.entries, open.entries), proposedByYou: open.proposedBy === caller.developerId, expiresAt: new Date(open.expiresAt).toISOString() };
  return {
    revision: list.revision, entries: list.entries, digest: list.digest, max: PRIVATE_ADDRESSES_MAX, openPorts: [...(deps.install.openPorts ?? [443])], canChange: isAdmin(caller),
    ...(list.corrupt === true ? { unreadable: true as const } : {}), ...(pending === undefined ? {} : { pending }),
  };
}

/** The reply, or undefined when the path is not this one. */
export async function routePrivateAddresses(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (url.pathname !== PRIVATE_ADDRESSES_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  const install = privateAddressRouteInstallOf(env);
  // No routed private network: the page does not exist here (its link is hidden), and a write says why.
  if (install === undefined) {
    if (request.method === "GET") return undefined;
    throw agentXError("FORBIDDEN", PRIVATE_ADDRESSES_UNAVAILABLE_MESSAGE);
  }
  // The list names the company's internal servers: owners and admins read it, as they are the ones who change it.
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", PRIVATE_ADDRESS_WORDS.notAdmin);
  const own = depsOf(deps, install);
  if (request.method === "GET") return new StatusReply(200, await stateOf(own, caller));
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", PRIVATE_ADDRESSES_BROWSER_MESSAGE);
  const parsed = PrivateAddressesBodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.filter((part) => typeof part === "string").join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const orgId: OrgId = caller.orgId;
  const body = parsed.data;
  if (body.action === "propose") {
    const before = await readPrivateAddressesForChange(own, orgId).catch(() => undefined);
    const result = await proposePrivateAddresses(own, { orgId, actorId: caller.developerId, expectedRevision: body.expectedRevision, entries: body.entries });
    logDeveloperEvent({ event: "developer.private_addresses_proposed", orgId, status: result.status });
    const sent = body.entries.map((entry) => entry.trim().toLowerCase());
    const warnings = await nameWarnings(own, body.entries, listDifference(before?.entries ?? [], sent).added);
    const extra = warnings.length === 0 ? {} : { warnings };
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId, ...(await stateOf(own, caller)), ...extra });
    return new StatusReply(200, { status: "applied", ...(await stateOf(own, caller)), ...extra });
  }
  if (body.action === "approve") {
    // Opening the walls needs the approving admin to have signed in within the last 10 minutes: a left-open browser cannot approve it.
    await requireFreshSignIn(deps, caller);
    await approvePrivateAddresses(own, { orgId, approverId: caller.developerId, changeId: body.changeId, expectedDigest: body.expectedDigest });
    logDeveloperEvent({ event: "developer.private_addresses_approved", orgId });
    return new StatusReply(200, { status: "applied", ...(await stateOf(own, caller)) });
  }
  await withdrawPrivateAddresses(own, { orgId, actorId: caller.developerId, changeId: body.changeId });
  logDeveloperEvent({ event: "developer.private_addresses_withdrawn", orgId });
  return new StatusReply(200, { status: "withdrawn", ...(await stateOf(own, caller)) });
}
