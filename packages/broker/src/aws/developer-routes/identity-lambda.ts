import { logDeveloperEvent } from "../../developer/log.js";
import {
  TaskPersonProofResponseSchema,
  TaskChannelPeopleResponseSchema,
  TaskPeopleDisplayReadResponseSchema,
  agentXError,
  type ChannelByNameRequest,
  type ChannelByNameResponse,
  type ChannelClassRequest,
  type ChannelClassResponse,
  type ChannelListEntry,
  type ChannelListRequest,
  type MemberChannelsRequest,
  type ChannelListResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type EndDeveloperSessionsRequest,
  type EraseDeveloperNameRequest,
  type EraseDeveloperNameResponse,
  type EndDeveloperSessionsResponse,
  type RealtimeTokenAnswer,
  type RealtimeTokenRequest,
  type UnlinkIdentityRequest,
  type UnlinkIdentityResponse,
  type StartIdentityLinkRequest,
  type StartIdentityLinkResponse,
  StartIdentityLinkAppResponseSchema,
  type SlackAuthCheckRequest,
  type SlackAuthCheckResponse,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
  type TaskChannelPeopleRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
} from "@agentx/contracts";
import { methodSince } from "../../developer/store.js";
import type { ChannelMembersInvokeResult } from "./types.js";

export const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
export const SLACK_UNAVAILABLE = { ok: false, error: "slack_unavailable" } as const;
/** A Slack or DeveloperIdentity error code: the only error text that may reach a log or an answer (R9). */
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;
type IdentityRefusal = typeof SLACK_UNAVAILABLE | { ok: false; error: "invalid_request" };

/**
 * One direct invoke of the DeveloperIdentity function, which holds the Slack token (the broker
 * never reads the Slack secret). `readReply` returns the good answer from the decoded reply, or
 * undefined. Every failure fails closed as slack_unavailable with one `<event>_failed` log line;
 * an invalid_request reply is a broker bug, logged as `<event>_invalid_request`. Lines carry only
 * the reason, error name, FunctionError or reply error, never a payload.
 */
async function identityInvoke<T>(
  invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>,
  request: ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | ChannelInfoRequest | ChannelClassRequest | ChannelListRequest | MemberChannelsRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | EraseDeveloperNameRequest | UnlinkIdentityRequest | StartIdentityLinkRequest | ChannelByNameRequest | RealtimeTokenRequest,
  readReply: (reply: Record<string, unknown>) => T | undefined,
  event: string,
): Promise<T | IdentityRefusal> {
  const failed = (entry: Record<string, string>) => {
    logDeveloperEvent({ event: `${event}_failed`, ...entry });
    return SLACK_UNAVAILABLE;
  };
  let response: ChannelMembersInvokeResult;
  try {
    response = await invoke(Buffer.from(JSON.stringify(request)));
  } catch (error) {
    return failed({ reason: "invoke_error", error: errorName(error) });
  }
  if (response.FunctionError !== undefined) return failed({ reason: "function_error", functionError: response.FunctionError });
  if (response.Payload === undefined) return failed({ reason: "empty_reply" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
  } catch {
    return failed({ reason: "unreadable_reply" });
  }
  const reply = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {};
  const good = readReply(reply);
  if (good !== undefined) return good;
  if (reply.ok === false && reply.error === "invalid_request") {
    logDeveloperEvent({ event: `${event}_invalid_request`, reason: "the identity function refused the broker's request; this is a broker bug" });
    return { ok: false, error: "invalid_request" };
  }
  // Only a code-shaped reply error (such as token_revoked) is logged; never free text.
  return failed({ reason: "reply_error", error: reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) ? reply.error : "malformed_reply" });
}

/** The broker's channel-members check (FR-013) through the DeveloperIdentity function. */
export function channelMembersThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.memberOf)
    ? { ok: true as const, memberOf: reply.memberOf.filter((entry): entry is string => typeof entry === "string") }
    : undefined), "developer.channel_members");
}

/** C0: one fresh proof through DeveloperIdentity. Any old or malformed reply fails closed. */
export function taskPersonProofThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskPersonProofResponse | undefined => {
    const parsed = TaskPersonProofResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "ineligible" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    const memberOf = parsed.data.memberOf;
    if (parsed.data.user.id !== request.slackUserId || new Set(memberOf).size !== memberOf.length || memberOf.some((channelId) => !requested.has(channelId))) return undefined;
    return parsed.data;
  }, "developer.task_person_proof");
}

/** E: complete fresh channel identities through DeveloperIdentity. Partial or malformed replies fail closed. */
export function taskChannelPeopleThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskChannelPeopleRequest) => Promise<TaskChannelPeopleResponse> {
  return (request) => identityInvoke(invoke, request, (reply): TaskChannelPeopleResponse | undefined => {
    const parsed = TaskChannelPeopleResponseSchema.safeParse(reply);
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) return parsed.data.error === "capacity_exceeded" ? parsed.data : undefined;
    const requested = new Set(request.channelIds);
    if (new Set(parsed.data.users.map((user) => user.id)).size !== parsed.data.users.length
      || parsed.data.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((channelId) => !requested.has(channelId)))) return undefined;
    return parsed.data;
  }, "developer.task_channel_people");
}

/** E: strict metered display transport. Any missing or malformed usage seals the caller's admission. */
export function taskPeopleDisplayReadThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: TaskPeopleDisplayReadRequest) => Promise<TaskPeopleDisplayReadResponse> {
  return async (request) => {
    const failed = (reason: string): never => {
      logDeveloperEvent({ event: "developer.task_people_display_read_failed", reason });
      throw agentXError("SLACK_UNAVAILABLE", "the complete task People directory is unavailable");
    };
    let response: ChannelMembersInvokeResult;
    try { response = await invoke(Buffer.from(JSON.stringify(request))); }
    catch (error) { return failed(`invoke_${errorName(error)}`); }
    if (response.FunctionError !== undefined) return failed("function_error");
    if (response.Payload === undefined) return failed("empty_reply");
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(response.Payload).toString("utf8")); }
    catch { return failed("unreadable_reply"); }
    const parsed = TaskPeopleDisplayReadResponseSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.operation !== request.operation
      || parsed.data.admission.slackCallsUsed > request.admission.slackCallsLimit) return failed("malformed_reply");
    if (parsed.data.operation === "proof") {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "proof" ? request.request.channelIds : []);
        if (request.operation !== "proof" || result.user.id !== request.request.slackUserId
          || new Set(result.memberOf).size !== result.memberOf.length || result.memberOf.some((id) => !requested.has(id))) return failed("malformed_reply");
      }
    } else {
      const result = parsed.data.result;
      if (result.ok) {
        const requested = new Set(request.operation === "directory" ? request.request.channelIds : []);
        if (request.operation !== "directory" || new Set(result.users.map((user) => user.id)).size !== result.users.length
          || result.users.some((user) => new Set(user.memberOf).size !== user.memberOf.length || user.memberOf.some((id) => !requested.has(id)))) return failed("malformed_reply");
      }
    }
    return parsed.data;
  };
}

type ChannelEntry = { channelId: string; name: string; isPrivate: boolean };
const isChannelEntry = (entry: unknown): entry is ChannelEntry => {
  const candidate = entry as Partial<Record<keyof ChannelEntry, unknown>> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.channelId === "string" && typeof candidate.name === "string" && typeof candidate.isPrivate === "boolean";
};

/** R10: bound channels' names and privacy through the DeveloperIdentity function; keeps only well-formed entries. */
export function channelInfoThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelInfoRequest) => Promise<ChannelInfoResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true && Array.isArray(reply.channels)
    ? { ok: true as const, channels: reply.channels.filter(isChannelEntry).map(({ channelId, name, isPrivate }) => ({ channelId, name, isPrivate })) }
    : undefined), "developer.channel_info");
}

const CLASS_KINDS = new Set(["public", "private", "im", "mpim"]);
/** Team record source rows: what one channel is, read fresh by the DeveloperIdentity function. A reply that is not understood is unavailable (fail closed); `{ ok: true }` alone means Slack does not know the channel. */
export function channelClassThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelClassRequest) => Promise<ChannelClassResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    if (reply.channel === undefined) return { ok: true as const };
    const channel: { kind?: unknown; extShared?: unknown } | null = reply.channel;
    return typeof channel === "object" && channel !== null && typeof channel.kind === "string" && CLASS_KINDS.has(channel.kind) && typeof channel.extShared === "boolean"
      ? { ok: true as const, channel: { kind: channel.kind as "public" | "private" | "im" | "mpim", extShared: channel.extShared } }
      : undefined;
  }, "developer.channel_class");
}

// Public only: a private channel in a reply is left out here too (the directory never asks for one).
const LIST_KINDS = new Set(["public"]);
const MEMBER_KINDS = new Set(["private"]);
const isListEntryOfKinds = (entry: unknown, kinds: ReadonlySet<string>): entry is ChannelListEntry => {
  const candidate = entry as Partial<Record<keyof ChannelListEntry, unknown>> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.id === "string" && typeof candidate.name === "string"
    && typeof candidate.kind === "string" && kinds.has(candidate.kind) && typeof candidate.extShared === "boolean" && typeof candidate.joined === "boolean";
};
const isListEntry = (entry: unknown): entry is ChannelListEntry => isListEntryOfKinds(entry, LIST_KINDS);
/**
 * Team record source pickers: a page of the channels the Slack bot sees, read fresh by the DeveloperIdentity function. Entries without the shape are left out; a reply that is not understood is unavailable
 * (fail closed). `missing_scope` passes through (the Slack app was installed without the listing scopes). An identity function that has no `channel-list` answers invalid_request, which is unavailable here too.
 */
export function channelListThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelListRequest) => Promise<ChannelListResponse> {
  return async (request) => {
    let refusal: "missing_scope" | undefined;
    const answer = await identityInvoke(invoke, request, (reply) => {
      if (reply.ok === false && reply.error === "missing_scope") { refusal = "missing_scope"; return undefined; }
      if (reply.ok !== true || !Array.isArray(reply.channels)) return undefined;
      const channels = reply.channels.filter(isListEntry).map(({ id, name, kind, extShared, joined }) => ({ id, name, kind, extShared, joined }));
      return { ok: true as const, channels, ...(typeof reply.next === "string" && reply.next !== "" ? { next: reply.next } : {}) };
    }, "developer.channel_list");
    if (!answer.ok && refusal !== undefined) return { ok: false, error: refusal };
    return answer;
  };
}

// Private only: "your private channels" lists nothing else, so a public channel or a direct message in a reply is left out here too.
const isMemberEntry = (entry: unknown): entry is ChannelListEntry => isListEntryOfKinds(entry, MEMBER_KINDS);
/**
 * Team record source pickers, "your private channels" (task 11): a page of the private channels the bot and ONE Slack user are both in, read fresh by the DeveloperIdentity function. The user id in the request is chosen by the
 * broker from the editor's linked Slack ids. Entries without the shape, or that are not private, are left out; a reply that is not understood is unavailable (fail closed); `missing_scope` passes through; an identity function that has no
 * `member-channels` answers invalid_request, which is unavailable here too.
 */
export function memberChannelsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: MemberChannelsRequest) => Promise<ChannelListResponse> {
  return async (request) => {
    let refusal: "missing_scope" | undefined;
    const answer = await identityInvoke(invoke, request, (reply) => {
      if (reply.ok === false && reply.error === "missing_scope") { refusal = "missing_scope"; return undefined; }
      if (reply.ok !== true || !Array.isArray(reply.channels)) return undefined;
      const channels = reply.channels.filter(isMemberEntry).map(({ id, name, kind, extShared, joined }) => ({ id, name, kind, extShared, joined }));
      return { ok: true as const, channels, ...(typeof reply.next === "string" && reply.next !== "" ? { next: reply.next } : {}) };
    }, "developer.member_channels");
    if (!answer.ok && refusal !== undefined) return { ok: false, error: refusal };
    return answer;
  };
}

/** A12: who owns a verified email, through DeveloperIdentity; fails closed as slack_unavailable. */
export function slackUserByEmailThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: SlackUserByEmailRequest) => Promise<SlackUserByEmailResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => (reply.ok === true
    ? (typeof reply.userId === "string" ? { ok: true as const, userId: reply.userId } : { ok: true as const })
    : undefined), "developer.slack_user_by_email");
}

/** A13: the bot token's auth.test, through DeveloperIdentity. Slack's refusal code passes through. */
export function slackAuthCheckThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<SlackAuthCheckResponse> {
  return async () => {
    let refusal: string | undefined;
    const answer = await identityInvoke(invoke, { kind: "slack-auth-check" }, (reply) => {
      if (reply.ok === true && typeof reply.teamId === "string") return { ok: true as const, teamId: reply.teamId };
      if (reply.ok === false && typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error) && reply.error !== "invalid_request") refusal = reply.error;
      return undefined;
    }, "developer.slack_auth_check");
    if (answer.ok) return answer;
    return { ok: false, error: refusal ?? answer.error };
  };
}

/**
 * E9: ends a developer's sessions through DeveloperIdentity. A not_found reply is an answer (the
 * developer never signed in), not a failure, so it is neither logged as one nor turned into
 * unavailable (C15). Every other failure is unavailable.
 */
export function endDeveloperSessionsThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EndDeveloperSessionsRequest) => Promise<EndDeveloperSessionsResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): EndDeveloperSessionsResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      return undefined;
    }, "developer.end_sessions");
    if (answer.ok || answer.error === "not_found" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/**
 * ERASE-NAME-1: asks DeveloperIdentity to clear the name a person's sign-in record holds (the broker has no write on that table). A not_found reply is an answer (the person never signed in); every
 * other failure is unavailable, and the erase is repeated.
 */
export function eraseDeveloperNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: EraseDeveloperNameRequest) => Promise<EraseDeveloperNameResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): EraseDeveloperNameResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      return undefined;
    }, "developer.erase_name");
    if (answer.ok || answer.error === "not_found" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** Plan 5 Task 8: asks DeveloperIdentity to sign a realtime token. Any failure is `unavailable` (the route answers that), after one `developer.realtime_token_failed` log line. */
export function realtimeTokenThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: RealtimeTokenRequest) => Promise<RealtimeTokenAnswer> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): RealtimeTokenAnswer | undefined =>
      (reply.ok === true && typeof reply.token === "string" && typeof reply.expiresAt === "string" ? { ok: true, token: reply.token, expiresAt: reply.expiresAt } : undefined), "developer.realtime_token");
    return answer.ok ? answer : { ok: false, error: answer.error === "invalid_request" ? "invalid_request" : "unavailable" };
  };
}

/** The words a refusal of the sign-in function carries to the person: short, and nothing the function did not write for them. */
const refusalMessageOf = (reply: Record<string, unknown>): string | undefined =>
  typeof reply.message === "string" && reply.message.length > 0 && reply.message.length <= 200 ? reply.message : undefined;

/**
 * Plan 2, Task 8 and 8b: unlinks a sign-in method through DeveloperIdentity. A refusal (the only way in, or the first sign-in), a sign-in
 * that is not fresh enough or is the method being removed (`reauth`), and a method that is not linked are answers, passed on in the
 * person's words; every other failure is unavailable.
 */
export function unlinkIdentityThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: UnlinkIdentityRequest) => Promise<UnlinkIdentityResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): UnlinkIdentityResponse | undefined => {
      if (reply.ok === true) return { ok: true };
      if (reply.ok === false && reply.error === "not_found") return { ok: false, error: "not_found" };
      const message = refusalMessageOf(reply);
      if (reply.ok === false && (reply.error === "refused" || reply.error === "reauth") && message !== undefined) return { ok: false, error: reply.error, message };
      return undefined;
    }, "developer.unlink_identity");
    if (answer.ok || answer.error === "not_found" || answer.error === "refused" || answer.error === "reauth" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** Plan 2, Task 8b: starts adding a removed sign-in method back through DeveloperIdentity; its answer is the sign-in link, or why not. */
export function startIdentityLinkThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: StartIdentityLinkRequest) => Promise<StartIdentityLinkResponse> {
  return async (request) => {
    const answer = await identityInvoke(invoke, request, (reply): StartIdentityLinkResponse | undefined => {
      if (reply.ok === true && typeof reply.authorizeUrl === "string" && StartIdentityLinkAppResponseSchema.safeParse({ authorizeUrl: reply.authorizeUrl }).success) return { ok: true, authorizeUrl: reply.authorizeUrl };
      const message = refusalMessageOf(reply);
      if (reply.ok === false && (reply.error === "refused" || reply.error === "reauth") && message !== undefined) return { ok: false, error: reply.error, message };
      return undefined;
    }, "developer.start_identity_link");
    if (answer.ok || answer.error === "refused" || answer.error === "reauth" || answer.error === "invalid_request") return answer;
    return { ok: false, error: "unavailable" };
  };
}

/** E12 (Q8): a public channel by name through DeveloperIdentity; fails closed as slack_unavailable. */
export function channelByNameThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): (request: ChannelByNameRequest) => Promise<ChannelByNameResponse> {
  return (request) => identityInvoke(invoke, request, (reply) => {
    if (reply.ok !== true) return undefined;
    const channel = reply.channel as { channelId?: unknown; name?: unknown } | undefined;
    return typeof channel?.channelId === "string" && typeof channel.name === "string"
      ? { ok: true as const, channel: { channelId: channel.channelId, name: channel.name } }
      : { ok: true as const };
  }, "developer.channel_by_name");
}

/** The broker's copy of each method's enabled-since cutoff (FR-045), from its environment. */
export function developerSinceFromEnvironment(env: NodeJS.ProcessEnv): { slack?: number; oidc?: number } {
  const slack = methodSince(env.DEVELOPER_SIGNIN_SLACK_SINCE);
  const oidc = methodSince(env.DEVELOPER_OIDC_SINCE);
  return { ...(slack === undefined ? {} : { slack }), ...(oidc === undefined ? {} : { oidc }) };
}

/**
 * The sign-in server's public keys, read by invoking the DeveloperIdentity function with its own
 * JWKS route (D17): the broker may not call kms:GetPublicKey, which the key policy keeps to
 * DeveloperIdentity. Any failure throws, and the verifier answers 503 for it.
 */
export function developerKeysThroughLambda(invoke: (payload: Uint8Array) => Promise<ChannelMembersInvokeResult>): () => Promise<unknown[]> {
  const request = { version: "2.0", rawPath: "/v1/auth/.well-known/jwks.json", requestContext: { requestId: "broker-jwks", http: { method: "GET" } } };
  const failed = (reason: string, entry: Record<string, string> = {}) => {
    logDeveloperEvent({ event: "developer.jwks_failed", reason, ...entry });
    return new Error(`the developer sign-in keys could not be read (${reason})`);
  };
  return async () => {
    let response: ChannelMembersInvokeResult;
    try {
      response = await invoke(Buffer.from(JSON.stringify(request)));
    } catch (error) {
      throw failed("invoke_error", { error: errorName(error) });
    }
    if (response.FunctionError !== undefined) throw failed("function_error", { functionError: response.FunctionError });
    if (response.Payload === undefined) throw failed("empty_reply");
    let keys: unknown;
    try {
      const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as { statusCode?: unknown; body?: unknown };
      if (reply.statusCode !== 200 || typeof reply.body !== "string") throw new Error("not 200");
      keys = (JSON.parse(reply.body) as { keys?: unknown }).keys;
    } catch {
      throw failed("unreadable_reply");
    }
    if (!Array.isArray(keys) || keys.length === 0) throw failed("no_keys");
    return keys as unknown[];
  };
}
