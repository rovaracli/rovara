// Customer test AWS account, lane TA2: the handler of the SNS callback (customer-test-account.md section 1, "Getting the role ARN back"; decisions 121 and 124). CloudFormation publishes the stack's custom resource request
// to Rovara's topic in the stack's Region; this reads it, decides, records, and answers CloudFormation's response URL.
//
// WHAT AUTHENTICATES A CALLBACK. The topic takes publishes from any AWS account, and everything in the body is the publisher's word. So a callback acts only when ALL of these hold (each is a separate refusal, none is skipped):
//   1. SNS signed it for one of Rovara's own topics (`sns-verify.ts`: topic, certificate host, signature, freshness);
//   2. it parses and is internally consistent (`parseTestAccessCallback`: the stack's account, the role ARNs and AccountId agree; the Region is the topic's);
//   3. its connect token exists, is unused and unexpired, and its record names the organization, project, connection and Region the message names (the external id is made from the token's record, never read from the message);
//   4. the account is not one of Rovara's own and not on the company's production list (read now);
//   5. the connection is still waiting for it (a connection that already reported, or was ended, takes no second stack);
//   6. the token is consumed, the stack recorded and the connection moved in ONE transaction (`store.consumeToken`), so a token buys exactly one stack and two deliveries cannot both win.
// A reported connection is `reported`: nothing assumes the role until an admin has seen the account id, Region and role and said it is theirs (connect.ts#confirmConnection). That is the last line against a leaked link: a stranger who
// holds a token can make a stack in THEIR account, but cannot make Rovara use it.
//
// UPDATE AND DELETE need the stack's own token too. A StackId is not a secret (it is an ARN in the customer's console), so a message that names the recorded StackId changes nothing unless the connect token in its properties hashes to
// the hash stored with the stack when the Create spent it (`StackItem.tokenHash`). CloudFormation sends the template's current properties, the token parameter among them, on every Update and Delete, so the real stack always qualifies; a
// stranger who learned the StackId does not. Such a message is still answered SUCCESS, so a customer's stack never hangs on Rovara. `templateVersion`, whatever an Update says, is a label for the page and for support: it must never gate a
// check, a service or an access decision.
//
// WHAT IT ANSWERS. Create and Update with SUCCESS or a fixed reason (`CALLBACK_FAILURE_REASONS`); a Delete always with SUCCESS. The reason is fixed text, never anything from the request. A forged or refused message gets the same fixed
// refusal as a stale one, and never touches another connection.
//
// FAILURE SPLIT. A refusal is final and is returned, not thrown. A fault that a retry could cure (the store, the certificate fetch, the production list, a response CloudFormation did not take after a successful change) throws, so SNS
// redelivers; a redelivery is safe because a recorded stack is answered SUCCESS without a second change.
import { buildCloudFormationResponse, connectionExternalId, isCloudFormationResponseUrl, parseTestAccessCallback, testAccessCleanupRoleName, testAccessRoleArn, testAccessRoleName, planCallback, sendCloudFormationResponse, type CallbackFailureCode, type CallbackOutcome, type CloudFormationResponse, type RecordedConnection, type SendResponseOptions, type TestAccessCallbackRequest } from "@agentx/cloud-contracts";
import { arnAccountId, prodDenyMatchesArn, type TestEnvProdDeny } from "@rovara-code/contracts";
import { connectionAudit } from "./audit.js";
import type { SnsEventRecord, SnsRefusal, SnsVerdict } from "./sns-verify.js";
import { connectTokenHash } from "./token.js";
import { timingSafeEqual } from "node:crypto";
import type { ConnectionRecord, StackItem, TestAccessStore } from "./store.js";

/** At most this many records of one event are read (SNS sends one; more is not SNS). */
export const CALLBACK_MAX_RECORDS = 10;
const CAS_ATTEMPTS = 3;

export interface CallbackDeps {
  store: TestAccessStore;
  now: () => number;
  /** The `ta` switch, read at every call. Off: a Create or Update is answered "not ready" (the stack rolls back at once); a Delete is still handled. */
  enabled: () => boolean;
  verify: (record: SnsEventRecord) => Promise<SnsVerdict>;
  /** Every AWS account that is Rovara's own: a stack there is refused. */
  rovaraAccountIds: readonly string[];
  /** The company's production list for the project, read now. Throws when it cannot be read (the callback then retries). */
  prodDeny: (orgId: string, projectId: string) => Promise<TestEnvProdDeny>;
  fetch: SendResponseOptions["fetch"];
  log: (entry: Record<string, string | number | boolean>) => void;
}

/** What happened to one record, as a fixed word. Never anything from the request. */
export type CallbackOutcomeWord =
  | `dropped_${SnsRefusal}` | "dropped_malformed_request" | "dropped_response_url" | "dropped_disabled"
  | "connected" | "repeat" | "updated" | "disconnected" | "ignored" | `refused_${CallbackFailureCode}`;

export class CallbackTransientError extends Error {
  constructor(readonly why: "response_not_taken" | "conflict") {
    super(`the callback could not be completed now (${why})`);
    this.name = "CallbackTransientError";
  }
}

/** True when the message carries the very token the stack's Create spent. Compared as hashes, in constant time. */
function carriesStackToken(request: TestAccessCallbackRequest, stack: StackItem): boolean {
  const token = (request.ResourceProperties as { ConnectToken?: unknown } | undefined)?.ConnectToken;
  const hash = typeof token === "string" ? connectTokenHash(token) : undefined;
  if (hash === undefined || hash.length !== stack.tokenHash.length) return false;
  return timingSafeEqual(Buffer.from(hash, "utf8"), Buffer.from(stack.tokenHash, "utf8"));
}

const recordedOf = (stack: StackItem): RecordedConnection => ({ orgId: stack.orgId, connectionId: stack.connectionId, stackId: stack.stackId, accountId: stack.accountId });
const iso = (ms: number): string => new Date(ms).toISOString();

async function answer(deps: CallbackDeps, request: TestAccessCallbackRequest, region: string, outcome: CallbackOutcome, mustDeliver: boolean): Promise<void> {
  const response: CloudFormationResponse = buildCloudFormationResponse(request, outcome);
  const sent = await sendCloudFormationResponse(request.ResponseURL, response, { region, fetch: deps.fetch });
  if (!sent && mustDeliver) throw new CallbackTransientError("response_not_taken");
}

const refusal = (deps: CallbackDeps, code: CallbackFailureCode): { word: CallbackOutcomeWord; outcome: CallbackOutcome } => {
  deps.log({ component: "test-access", event: "callback.refused", code });
  return { word: `refused_${code}`, outcome: { status: "FAILED", code } };
};

export async function handleCallbackEvent(event: { Records?: unknown }, deps: CallbackDeps): Promise<CallbackOutcomeWord[]> {
  const records = Array.isArray(event.Records) ? (event.Records as SnsEventRecord[]).slice(0, CALLBACK_MAX_RECORDS) : [];
  // `verify` refuses a record that is not an object (a null or a number) as malformed, so one bad record never stops the others.
  const words: CallbackOutcomeWord[] = [];
  for (const record of records) words.push(await handleRecord(record, deps));
  return words;
}

async function handleRecord(record: SnsEventRecord, deps: CallbackDeps): Promise<CallbackOutcomeWord> {
  const verdict = await deps.verify(record);
  if (!verdict.ok) {
    deps.log({ component: "test-access", event: "callback.dropped", code: verdict.code });
    return `dropped_${verdict.code}`;
  }
  const parsed = parseTestAccessCallback(verdict.message, verdict.topicRegion);
  if (!parsed.ok) {
    if (parsed.request === undefined) {
      deps.log({ component: "test-access", event: "callback.dropped", code: "malformed_request" });
      return "dropped_malformed_request";
    }
    if (!isCloudFormationResponseUrl(parsed.request.ResponseURL, verdict.topicRegion)) return "dropped_response_url";
    const refused = refusal(deps, parsed.code);
    await answer(deps, parsed.request, verdict.topicRegion, refused.outcome, false);
    return refused.word;
  }
  const request = parsed.request;
  const region = verdict.topicRegion;
  if (!isCloudFormationResponseUrl(request.ResponseURL, region)) {
    deps.log({ component: "test-access", event: "callback.dropped", code: "response_url" });
    return "dropped_response_url";
  }
  if (request.RequestType === "Delete") return handleDelete(request, region, deps);
  if (!deps.enabled()) {
    const refused = refusal(deps, "not_ready");
    await answer(deps, request, region, refused.outcome, false);
    return "dropped_disabled";
  }
  const stack = await deps.store.getStack(request.StackId);
  if (request.RequestType === "Update") return handleUpdate(request, region, deps, stack !== undefined && carriesStackToken(request, stack) ? recordedOf(stack) : undefined);
  return handleCreate(request, region, deps, stack === undefined ? undefined : recordedOf(stack));
}

// ---- Delete

async function handleDelete(request: Extract<TestAccessCallbackRequest, { RequestType: "Delete" }>, region: string, deps: CallbackDeps): Promise<CallbackOutcomeWord> {
  const stack = await deps.store.getStack(request.StackId);
  // Without the stack's own token the recorded stack is treated as unknown: nothing changes (and the answer is still SUCCESS).
  const plan = planCallback(request, { recorded: stack !== undefined && carriesStackToken(request, stack) ? recordedOf(stack) : undefined });
  let word: CallbackOutcomeWord = "ignored";
  if (plan.kind === "disconnect") {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const connection = await deps.store.getConnection(plan.recorded.orgId, plan.recorded.connectionId);
      // Only the connection that recorded this very stack ends with it.
      if (connection === undefined || connection.stackId !== request.StackId || connection.status === "disconnected") break;
      const at = iso(deps.now());
      const next: ConnectionRecord = { ...connection, status: "disconnected", version: connection.version + 1, endedAt: at, endCause: "deleted_stack" };
      delete next.pollAccountId; delete next.pollSubmittedBy; delete next.pollUntil;
      if (await deps.store.commitConnection(next, connection.version, connectionAudit({ record: next, action: "test_access.connection_ended", actor: { kind: "system" }, occurredAt: at, facts: { cause: "deleted_stack" } }))) {
        word = "disconnected";
        break;
      }
      if (attempt === CAS_ATTEMPTS - 1) throw new CallbackTransientError("conflict");
    }
  }
  // A Delete is always answered SUCCESS, whatever happened above (buildCloudFormationResponse enforces it).
  await answer(deps, request, region, { status: "SUCCESS" }, true);
  return word;
}

// ---- Update

async function handleUpdate(request: Extract<TestAccessCallbackRequest, { RequestType: "Update" }>, region: string, deps: CallbackDeps, recorded: RecordedConnection | undefined): Promise<CallbackOutcomeWord> {
  const plan = planCallback(request, { recorded });
  let word: CallbackOutcomeWord = "ignored";
  const followsConvention = recorded !== undefined && plan.kind === "update"
    && plan.connection.roleArn === testAccessRoleArn(plan.connection.accountId, testAccessRoleName(plan.connection.connectionId))
    && plan.connection.cleanupRoleArn === testAccessRoleArn(plan.connection.accountId, testAccessCleanupRoleName(plan.connection.connectionId));
  if (plan.kind === "update" && followsConvention) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const connection = await deps.store.getConnection(plan.connection.orgId, plan.connection.connectionId);
      if (connection === undefined || connection.stackId !== request.StackId || connection.status === "disconnected" || connection.status === "failed" || connection.accountId !== plan.connection.accountId || connection.roleArn !== plan.connection.roleArn) break;
      const at = iso(deps.now());
      // The roles are fixed by the convention, so an update changes only the template version the stack runs.
      const next: ConnectionRecord = { ...connection, version: connection.version + 1, templateVersion: plan.connection.templateVersion };
      if (await deps.store.commitConnection(next, connection.version, connectionAudit({ record: next, action: "test_access.connection_reported", actor: { kind: "system" }, occurredAt: at, facts: { via: "callback", templateVersion: plan.connection.templateVersion } }))) {
        word = "updated";
        break;
      }
      if (attempt === CAS_ATTEMPTS - 1) throw new CallbackTransientError("conflict");
    }
  }
  await answer(deps, request, region, plan.answer, plan.kind === "update");
  return word;
}

// ---- Create

async function handleCreate(request: Extract<TestAccessCallbackRequest, { RequestType: "Create" }>, region: string, deps: CallbackDeps, recorded: RecordedConnection | undefined): Promise<CallbackOutcomeWord> {
  const respond = async (word: CallbackOutcomeWord, outcome: CallbackOutcome, mustDeliver: boolean): Promise<CallbackOutcomeWord> => {
    await answer(deps, request, region, outcome, mustDeliver);
    return word;
  };
  const refuse = (code: CallbackFailureCode): Promise<CallbackOutcomeWord> => {
    const refused = refusal(deps, code);
    return respond(refused.word, refused.outcome, false);
  };
  // A stack already recorded is a repeated delivery: nothing changes, and it is answered again.
  if (recorded !== undefined && recorded.stackId === request.StackId) return respond("repeat", { status: "SUCCESS" }, true);
  const properties = request.ResourceProperties;
  const tokenHash = connectTokenHash(properties.ConnectToken);
  const token = tokenHash === undefined ? undefined : await deps.store.getToken(tokenHash);
  if (tokenHash === undefined || token === undefined || token.usedAtMs !== undefined || token.expiresAtMs <= deps.now()) return refuse("token_refused");
  // The external id the stack carries must be the one made from the token's own record: a token cannot be used for another organization's or connection's id.
  const plan = planCallback(request, { recorded: undefined, consumedToken: { orgId: token.orgId, connectionId: token.connectionId } });
  if (plan.kind !== "connect") return refuse(plan.answer.status === "FAILED" ? plan.answer.code : "token_refused");
  if (token.region !== properties.Region || token.region !== region) return refuse("region_mismatch");
  const connection = await deps.store.getConnection(token.orgId, token.connectionId);
  if (connection === undefined || connection.orgId !== token.orgId || connection.projectId !== token.projectId || connection.region !== token.region || connection.externalId !== connectionExternalId(token.orgId, token.connectionId)) {
    deps.log({ component: "test-access", event: "callback.binding_mismatch" });
    return refuse("token_refused");
  }
  // The roles are the ones the template names for THIS connection, in the stack's account: a callback cannot report some other role of the account.
  if (properties.RoleArn !== testAccessRoleArn(properties.AccountId, testAccessRoleName(token.connectionId)) || properties.CleanupRoleArn !== testAccessRoleArn(properties.AccountId, testAccessCleanupRoleName(token.connectionId))) return refuse("role_mismatch");
  const roleAccount = arnAccountId(properties.RoleArn);
  // An empty list of Rovara's own accounts is a misconfiguration, never "none": nothing is attached until it is set.
  if (deps.rovaraAccountIds.length === 0) return refuse("not_ready");
  if (roleAccount === undefined || deps.rovaraAccountIds.includes(properties.AccountId) || deps.rovaraAccountIds.includes(roleAccount)) return refuse("account_refused");
  const deny = await deps.prodDeny(connection.orgId, connection.projectId);
  if (deny.accountIds.includes(properties.AccountId) || prodDenyMatchesArn(deny, properties.RoleArn) !== undefined || prodDenyMatchesArn(deny, properties.CleanupRoleArn) !== undefined) return refuse("account_refused");

  const nowMs = deps.now();
  const reported = plan.connection;
  let next: ConnectionRecord;
  if (connection.status === "awaiting" || connection.status === "polling") {
    // An admin typed an account id for the poll: the stack must be that account's.
    if (connection.status === "polling" && connection.pollAccountId !== properties.AccountId) return refuse("account_mismatch");
    next = { ...connection, status: "reported", version: connection.version + 1, stackId: request.StackId, accountId: reported.accountId, roleArn: reported.roleArn, cleanupRoleArn: reported.cleanupRoleArn, templateVersion: reported.templateVersion, reportedAt: iso(nowMs), reportedVia: "callback" };
    delete next.pollAccountId; delete next.pollSubmittedBy; delete next.pollUntil;
  } else if ((connection.status === "confirmed" || connection.status === "connected" || connection.status === "needs_attention") && connection.stackId === undefined && connection.accountId === properties.AccountId && connection.roleArn === properties.RoleArn) {
    // The poll found the same role first (an admin typed the account id): the callback only adds the stack, so its deletion is seen.
    next = { ...connection, version: connection.version + 1, stackId: request.StackId, templateVersion: reported.templateVersion, cleanupRoleArn: reported.cleanupRoleArn };
  } else {
    // Another account, or a connection that is over: the token can never be used for it.
    await deps.store.retireToken(tokenHash, nowMs);
    return refuse("token_refused");
  }
  const stack: StackItem = { stackId: request.StackId, orgId: connection.orgId, connectionId: connection.connectionId, accountId: properties.AccountId, tokenHash, recordedAtMs: nowMs };
  const audit = connectionAudit({ record: next, action: "test_access.connection_reported", actor: { kind: "system" }, occurredAt: iso(nowMs), facts: { via: "callback", templateVersion: reported.templateVersion } });
  const result = await deps.store.consumeToken({ tokenHash, nowMs, stack, next, expectedVersion: connection.version, audit });
  if (result === "token_refused") return refuse("token_refused");
  if (result === "stack_taken") {
    const again = await deps.store.getStack(request.StackId);
    return again?.connectionId === connection.connectionId ? respond("repeat", { status: "SUCCESS" }, true) : refuse("token_refused");
  }
  if (result === "connection_changed") throw new CallbackTransientError("conflict");
  deps.log({ component: "test-access", event: "callback.connected", connectionId: connection.connectionId });
  return respond("connected", plan.answer, true);
}
