// Internal addresses a company's tasks may reach (owner decision 123): `/v1/app/org/private-addresses`. `org` is a browser route family, so the app reaches it as `/v1/web/org/private-addresses`.
//   GET     a company owner or admin: the approved list, its revision and digest, and the proposal waiting for a different admin (its entries, what it adds and removes, and whether the reader made it).
//   POST    an owner or admin, from a live browser session only (a token, the CLI or Slack never change it; the entry file refuses them first):
//             { action: "propose", expectedRevision, entries }   only removals: applied at once (200 applied); anything added: a proposal (202 needs_approval);
//             { action: "approve", changeId, expectedDigest }    a DIFFERENT owner or admin, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise); no sole-owner exception;
//             { action: "withdraw", changeId }                   the proposer withdraws, or another admin turns it down.
// No switch: the empty list is the default and opens nothing (decision 116: no opt-in beyond the setting itself). The rules are org/private-addresses.ts; answers are fixed words, counts and the entries an admin reads.
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { PRIVATE_ADDRESSES_MAX, PRIVATE_ADDRESSES_PATH, PrivateAddressesBodySchema, privateAddressListDigest, type PrivateAddressesState } from "@agentx/cloud-contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import {
  PRIVATE_ADDRESS_WORDS, approvePrivateAddresses, listDifference, openPrivateAddressChange, proposePrivateAddresses, readPrivateAddresses, withdrawPrivateAddresses, type PrivateAddressDeps,
} from "../../org/private-addresses.js";
import { privateAddressInstallOf } from "../../org/private-address-install.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export { PRIVATE_ADDRESSES_PATH };
export const PRIVATE_ADDRESSES_BROWSER_MESSAGE = "Use a live browser session to change the internal addresses tasks may reach.";

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

function depsOf(deps: DeveloperRouteDependencies, env: NodeJS.ProcessEnv): PrivateAddressDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "This setting is not available here.");
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    evidence: { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now }, install: privateAddressInstallOf(env), now: () => deps.now(),
  };
}

async function stateOf(deps: PrivateAddressDeps, caller: DeveloperCaller): Promise<PrivateAddressesState> {
  const list = await readPrivateAddresses(deps, caller.orgId).catch(() => { throw agentXError("RUNTIME_UNAVAILABLE", "The internal address list could not be read. Try again."); });
  const open = await openPrivateAddressChange(deps, caller.orgId, deps.now(), list);
  const pending = open === undefined ? undefined : { changeId: open.id, entries: open.entries, digest: privateAddressListDigest(open.entries), ...listDifference(list.entries, open.entries), proposedByYou: open.proposedBy === caller.developerId, expiresAt: new Date(open.expiresAt).toISOString() };
  return { revision: list.revision, entries: list.entries, digest: list.digest, max: PRIVATE_ADDRESSES_MAX, canChange: isAdmin(caller), ...(pending === undefined ? {} : { pending }) };
}

/** The reply, or undefined when the path is not this one. */
export async function routePrivateAddresses(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (url.pathname !== PRIVATE_ADDRESSES_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  // The list names the company's internal servers: owners and admins read it, as they are the ones who change it.
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", PRIVATE_ADDRESS_WORDS.notAdmin);
  const own = depsOf(deps, env);
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
    const result = await proposePrivateAddresses(own, { orgId, actorId: caller.developerId, expectedRevision: body.expectedRevision, entries: body.entries });
    logDeveloperEvent({ event: "developer.private_addresses_proposed", orgId, status: result.status });
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId, ...(await stateOf(own, caller)) });
    return new StatusReply(200, { status: "applied", ...(await stateOf(own, caller)) });
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
