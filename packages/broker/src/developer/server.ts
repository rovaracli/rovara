import { SERVER_PAGE_ICON, serverPageCss } from "@agentx/design-tokens";
import { withDecideIsolation } from "./confirm-page.js";
import { AdminCreateUserCommand, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SAML_SIGN_IN_REFUSED_MESSAGE, type SignedOutReason } from "@agentx/cloud-contracts";
import { SessionIdSchema, agentXError, normalizeEmail } from "@rovara-code/contracts";
import { APP_CSRF_HEADER, appCsrfMatches } from "./app-csrf.js";
// packages/broker/src/developer/server.ts
// Spec 025 FR-001 to FR-008: the control plane as the developers' sign-in server. Behind
// ANY /v1/auth/{proxy+} with no authorizer, plus direct-invoke operations for the broker
// (channel members, channel names for R10, 25d's email lookup and bot token check, and 25e's
// admin-ended sessions and channel by name).
// Nothing here logs or echoes a secret, a code, a token or a caught error's message.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AGENTX_CLI_CLIENT_ID, ChannelClassRequestSchema, ChannelListRequestSchema, MemberChannelsRequestSchema, ChannelInfoRequestSchema, ChannelByNameRequestSchema, ChannelMembersRequestSchema, TaskPersonProofRequestSchema, TaskChannelPeopleRequestSchema, TaskPeopleDisplayReadRequestSchema, ADMIN_API_VERSION, DEVELOPER_API_VERSION, EndDeveloperSessionsRequestSchema, EraseDeveloperNameRequestSchema, UnlinkIdentityRequestSchema, StartIdentityLinkRequestSchema, type UnlinkIdentityRequest, type UnlinkIdentityResponse, type StartIdentityLinkRequest, type StartIdentityLinkResponse, SlackAuthCheckRequestSchema, SlackUserByEmailRequestSchema, isLoopbackRedirectUri, type AgentXConfigurationConfirm, type ChannelByNameRequest, type ChannelByNameResponse, type ChannelClassRequest, type ChannelClassResponse, type ChannelListRequest, type MemberChannelsRequest, type ChannelListResponse, type ChannelInfoRequest, type ChannelInfoResponse, type ChannelMembersRequest, type ChannelMembersResponse, type TaskPersonProofRequest, type TaskPersonProofResponse, type TaskChannelPeopleRequest, type TaskChannelPeopleResponse, type TaskPeopleDisplayReadRequest, type TaskPeopleDisplayReadResponse, type OrgId, type EndDeveloperSessionsRequest, type EraseDeveloperNameRequest, type EndDeveloperSessionsResponse, type EraseDeveloperNameResponse, type SlackAuthCheckRequest, type SlackAuthCheckResponse, type SlackUserByEmailRequest, type SlackUserByEmailResponse } from "@rovara-code/contracts";
import { RealtimeTokenRequestSchema, type DeveloperSignInMethod, type EditionPolicy, type RealtimeTokenAnswer, type RealtimeTokenRequest } from "@agentx/cloud-contracts";
import { adaptHttpApiEvent, ownerKeyForSubject, type HttpApiV2Event } from "../aws/lambda.js";
import { SESSION_MAX_AGE_SECONDS } from "../aws/web-session.js";
import { INVITE_TOKEN_PATTERN, inviteTokenHash } from "../org/invite-url.js";
import type { OrgStore } from "../org/store.js";
import { MERGED_AWAY_MESSAGE } from "../org/store.js";
import { ALREADY_SIGNED_UP_MESSAGE, INVITATION_ONLY_MESSAGE, NO_ORG_ON_INSTALL_MESSAGE, resolveOrgOnSignIn, sameEmail, type ResolveOrgOnSignInDependencies, type SignInNoOrg, type SignInOrg } from "../org/sign-in.js";
import { REMOVAL_CHECK_UNAVAILABLE_MESSAGE, UNTRACEABLE_IDENTITY_MESSAGE } from "../org/former-developers.js";
import { resolveSignInDeveloper, type ResolveSignInDeveloperDependencies } from "./identities.js";
import {
  expiredInvitePage, joinDonePage, joinExpiredPage, maskEmail, openInvitePage, otherBrowserPage, unknownInvitePage, usedInvitePage, type PageSpec,
} from "./join-page.js";
import { ProviderNotConfiguredError, ProviderUnavailableError, type ProviderIdentity, type ProviderResult, type SamlSignInProvider, type SignInProvider } from "./providers.js";
import type { SlackDirectory } from "./slack-directory.js";
import { GITHUB_LINK_HAS_ONE, SLACK_LINK_HAS_ONE, SLACK_NO_WORKSPACE_MESSAGE, endedByAdmin, endedByUnlink, isFreshSignIn, samlSessionEnded, startedBeforeMethodOn, type AuthRequestRecord, type DeveloperSignInStore, type JoinOutcome, type SessionRecord } from "./store.js";
import { sendDecideSignInAddedNotice, sendIdentityLinkedNotice, type IdentityNoticeDependencies } from "./identity-notice.js";
import { methodAllowedByEdition, sessionWithinEditionCap } from "./edition-methods.js";
import { companySignInRefusalEvent, decideCompanySignIn, type CompanySignIn, type SsoStores } from "./sso-sign-in.js";
import { recordAuditEventDurably, recordAuditRead } from "../audit/flush.js";
import type { AuditRuntime } from "../audit/outbox.js";
import { createDecideSignIn, type DecideSignInDependencies } from "./decide-signin.js";
import type { DecideStore } from "./decide-session.js";
import { issueAccessToken, pkceChallengeMatches, sha256Hex, type TokenSigner } from "./tokens.js";
import { issueRealtimeToken } from "../realtime/token.js";

/** `since` (epoch seconds, FR-045): when the method was last turned on. A session started before it
 * was ended by the disable in between, so it never comes back when the method is on again. */
export interface DeveloperIdentityConfig { env: string; issuer: string;
  /** 0.5.7: with a custom domain `issuer` is its address and this is the API's own, which still answers: requests that arrive on that host are served as that issuer (its redirect URIs, its tokens' `iss`, its cookies' host). */
  legacyIssuer?: string; slack: { enabled: boolean; teamId?: string; since?: number }; oidc?: { displayName: string; since?: number }; cloud?: { displayName: string };
  /** Sign up and sign in with GitHub; set only on a cloud install with a GitHub OAuth app (DEVELOPER_GITHUB_*). */
  github?: { displayName: string }; confirmElicitation?: boolean }
export interface DeveloperIdentityDependencies {
  config: DeveloperIdentityConfig;
  store: DeveloperSignInStore;
  signer: TokenSigner;
  providers: Partial<Record<DeveloperSignInMethod, SignInProvider>>;
  /**
   * Enterprise foundations I4: the SAML sign-in, when the edition has company sign-in (`sso`). It is also `providers.saml`; this is the same object with the parts only SAML needs (the identity
   * provider's POST, our metadata). Absent: `/v1/auth/callback/saml` and `/v1/auth/saml/metadata` answer not found.
   */
  saml?: SamlSignInProvider;
  directory: SlackDirectory;
  /** The org store: a sign-in puts the developer in an org, and the tokens carry it. */
  orgs: ResolveOrgOnSignInDependencies["orgs"] & Pick<OrgStore, "developerForVerifiedEmail" | "describeInviteByHash" | "describeInvite" | "getOrg" | "setRole" | "orgForDeveloper" | "orgForSlackTeam" | "hasSlackTeam">;
  /** The install's single org (ruling R3), which a Slack or company sign-in joins as a member. */
  singleOrgId?: OrgId;
  /** Told when a sign-in created or joined an org, so the model proxy can be told its budgets (see ResolveOrgOnSignInDependencies.onOrgJoined). */
  onOrgJoined?: ResolveOrgOnSignInDependencies["onOrgJoined"];
  /** "New companies by invitation only" (the hosted cloud's install setting): a cloud or GitHub sign-in never creates a company. Absent: as always. See ResolveOrgOnSignInDependencies. */
  newOrgsByInvitationOnly?: boolean;
  /**
   * The cloud user pool's admin API, for invitations where new companies are by invitation only: that pool then allows only AdminCreateUser (no self sign-up), so an invited person
   * with no pool user yet gets one when they open the invite (`ensureInvitedPoolUser`). Absent: nothing is created (a pool that still allows sign-up needs none).
   */
  invitedUsers?: { client: { send(command: unknown): Promise<unknown> }; userPoolId: string; limits: Pick<DecideStore, "takeInviteUserSlot" | "releaseInviteUserSlot"> };
  /**
   * Called after a GitHub sign-in resolved the org, with the GitHub account that signed in, so a trial org's trial unlocks (unlockTrial).
   * Best effort: TRIAL_GITHUB_USED (that account already unlocked another org) and any other failure are logged and never fail the sign-in.
   */
  onGithubSignIn?: (input: { orgId: OrgId; githubUserId: string; developerId: string }) => Promise<void>;
  /** Plan 6 Task 14: told after a person unlinked their GitHub sign-in, with the org they belong to, so the org stops reading their approvals on GitHub as theirs. Best effort. */
  onGithubUnlinked?: (input: { orgId: OrgId; developerId: string }) => Promise<void>;
  /** Merges a duplicate member of the same person into the member their verified email names, on the duplicate's next sign-in (see resolveSignInDeveloper, rule 1b), only within one company. Without it duplicates are left alone. */
  mergeDuplicate?: ResolveSignInDeveloperDependencies["mergeDuplicate"];
  /**
   * Plan 2, Task 8: tells an account's address when a new sign-in method was linked to it. `from` is the SES sender (empty: no notice is
   * sent) and `cellUrl` the page where the person removes a method. Absent in tests that do not send.
   */
  notice?: { ses: IdentityNoticeDependencies["ses"]; from: string | undefined; cellUrl: string };
  /**
   * Plan 3, Task 21a-presence (R66, R67): what the decide flow (`/v1/auth/decide/*`) needs: the ticket, state and session store, the kinds of
   * approval (who may decide now), and Cognito's admin API on the cloud pool. Absent, the decide routes answer not found.
   */
  decide?: DecideSignInDependencies;
  /**
   * Enterprise foundations E3: the edition's feature table. Where the edition has no `publicSignInMethods` (Enterprise) the only way in is the company's own sign-in
   * (`oidc`), so a person taken out of the provider's groups cannot come back through a linked Slack, Google, GitHub or email-code account. Absent: an install deployed
   * before editions, which keeps today's methods.
   */
  editionPolicy?: EditionPolicy;
  /** Enterprise foundations I1: the group mapping and the break-glass list, built once. Where the edition has `sso` and these are absent, every company sign-in is refused. */
  sso?: SsoStores;
  /** The Audit Ledger's outbox. A break-glass sign-in is recorded durably before it is let through; the other sign-in events are best effort. Absent on a legacy install. */
  audit?: AuditRuntime;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }
/** The invoke's answer: the broker's contract, plus a refusal for a request that is not one. */
export type ChannelMembersResult = ChannelMembersResponse | { ok: false; error: "invalid_request" };

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
// The PR-feedback review page, or the read-only task page, which may name one document and the earlier version it came from.
/** A session's link (Plan 5): a person who followed `/s/<id>` signed out comes back to it. Only a real session id shape, no query. */
const SESSION_RETURN_TO = { test: (value: string) => value.startsWith("/s/") && SessionIdSchema.safeParse(value.slice(3)).success };
const REVIEW_RETURN_TO_PATH = /^\/review\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/task(?:\?doc=(?:requirements|design|coding-plan)(?:&from=[1-9][0-9]{0,2})?)?)?$/i;
const APP_RETURN_TO_PATH = /^\/app(?:\/[A-Za-z0-9._~%/-]*)?(?:\?[A-Za-z0-9._~%=&-]*)?$/;
export const BROWSER_RETURN_TO = { test: (value: string) => {
  if (REVIEW_RETURN_TO_PATH.test(value)) return true;
  if (value.startsWith("/s/")) return SESSION_RETURN_TO.test(value);
  return APP_RETURN_TO_PATH.test(value) && !value.includes("..") && !value.includes("//") && !/%2e|%2f|%5c/i.test(value) && !value.split("?", 1)[0]!.split("/").includes(".");
} };
const REVIEW_PKCE_COOKIE = "__Host-agentx_review_pkce";
const REVIEW_SESSION_COOKIE = "__Host-agentx_review_session";
/** The join page's own PKCE cookie: the browser that opened an invite is the only one that may read how its join ended. */
const JOIN_PKCE_COOKIE = "__Host-rovara_join_pkce";
/** An auth request id: 32 random bytes in base64url. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" };
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
/** AWS errors that mean "try again": the store rethrows these instead of deciding reuse. */
const RETRYABLE_AWS_ERRORS = new Set([
  "TransactionCanceledException", "TransactionConflictException", "TransactionInProgressException", "ThrottlingException",
  "ProvisionedThroughputExceededException", "RequestLimitExceeded", "InternalServerError", "ServiceUnavailable", "TimeoutError",
]);

export { methodAllowedByEdition };

export function enabledMethods(deps: Pick<DeveloperIdentityDependencies, "config" | "providers" | "editionPolicy">): DeveloperSignInMethod[] {
  const methods: DeveloperSignInMethod[] = [];
  if (deps.config.slack.enabled && deps.config.slack.teamId !== undefined && deps.providers.slack !== undefined) methods.push("slack");
  if (deps.config.oidc !== undefined && deps.providers.oidc !== undefined) methods.push("oidc");
  if (deps.providers.saml !== undefined) methods.push("saml");
  if (deps.config.cloud !== undefined && deps.providers.cloud !== undefined) methods.push("cloud");
  // GitHub makes accounts the way the cloud method does, so it exists only where cloud does.
  if (deps.config.cloud !== undefined && deps.config.github !== undefined && deps.providers.github !== undefined) methods.push("github");
  return methods.filter((method) => methodAllowedByEdition(deps.editionPolicy, method));
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** A one-field POST form (an email address) that a page may carry; the invite page's way for a person with no account to ask for a sign-in code. */
interface PageForm { action: string; hidden: Record<string, string>; prompt: string; field: string; button: string }

function page(statusCode: number, title: string, paragraphs: string[], links: Array<{ href: string; label: string }> = [], refreshTo?: string, form?: PageForm): HttpResult {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>${SERVER_PAGE_ICON}`
    + (refreshTo === undefined ? "" : `<meta http-equiv="refresh" content="0;url=${escape(refreshTo)}">`)
    + `<style>${serverPageCss()}h1{line-height:1.2;margin:0 0 1.5rem}.rv-wordmark{font-weight:650;margin:0 0 1.5rem}.rv-server-card{padding:clamp(1rem,4vw,2rem);border:1px solid var(--rv-border);border-radius:var(--rv-radius-lg);background:var(--rv-bg-raised)}p{overflow-wrap:anywhere}a.method{display:flex;align-items:center;min-height:44px;margin:1rem 0;padding:.75rem 1rem;border:1px solid var(--rv-border-strong);border-radius:var(--rv-radius-sm);text-decoration:none;color:var(--rv-accent-text)}form{margin:1.5rem 0 0}label{display:block;margin:0 0 .5rem}input,button{font:inherit;min-height:44px;padding:.5rem .75rem;border:1px solid var(--rv-border-strong);border-radius:var(--rv-radius-sm);background:var(--rv-bg-raised);color:inherit;max-width:100%}button{color:var(--rv-accent-text);cursor:pointer;margin:.5rem 0 0}</style></head>`
    + `<body><main><p class="rv-wordmark">Rovara</p><section class="rv-server-card"><h1>${escape(title)}</h1>${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}`
    + `${links.map((link) => `<a class="method" href="${escape(link.href)}">${escape(link.label)}</a>`).join("")}`
    + (form === undefined ? "" : `<form method="post" action="${escape(form.action)}">${Object.entries(form.hidden).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("")}`
      + `<label for="rv-email">${escape(form.prompt)}</label><input id="rv-email" type="email" name="${escape(form.field)}" required maxlength="254" autocomplete="email" spellcheck="false"><br><button type="submit">${escape(form.button)}</button></form>`)
    + `</section></main></body></html>`;
  // A form submits only to this server's own address; every other page keeps form-action 'none'.
  // The form page also sends `referrer-policy: same-origin`: under `no-referrer` a browser sends `Origin: null` with the form's POST. Nothing leaves this server's origin from it (the next hop is a different page).
  const headers = form === undefined ? { ...HTML_HEADERS } : { ...HTML_HEADERS, "referrer-policy": "same-origin", "content-security-policy": HTML_HEADERS["content-security-policy"].replace("form-action 'none'", "form-action 'self'") };
  return { statusCode, headers, body };
}

const render = (spec: PageSpec): HttpResult => page(spec.statusCode, spec.title, spec.paragraphs, spec.links, undefined, spec.form);
const cookieValue = (header: string | undefined, name: string): string | undefined =>
  (header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);

const jsonResult = (statusCode: number, body: unknown): HttpResult => ({ statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) });
/** Public, cacheable documents (discovery, keys): no pragma, which belongs only beside no-store. */
const publicJson = (body: unknown): HttpResult =>
  ({ statusCode: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" }, body: JSON.stringify(body) });
/** Equal text, compared in constant time. */
const sameText = (left: string, right: string): boolean => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const redirect = (location: string): HttpResult => ({ statusCode: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" });
const oauthError = (status: number, error: string, description: string) => jsonResult(status, { error, error_description: description });
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
/** An AgentXError's code (a fixed upper-case word like CONFIG_INVALID), as a log field; nothing for any other error. Never the message, which may hold a person's details. */
const errorCode = (error: unknown): { code?: string } => {
  const code = error instanceof Error && error.name === "AgentXError" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? { code } : {};
};
const isCode = (error: unknown, code: string) => (error as { code?: unknown } | null)?.code === code;
/** An AgentXError's own words, without its `CODE: ` prefix. */
const refusalWords = (error: unknown) => (error instanceof Error ? error.message : "").replace(/^[A-Z_]+: /, "");
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith(".") ? "" : ".");

function isRetryableAwsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = error as { $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  return RETRYABLE_AWS_ERRORS.has(error.name) || meta.$retryable !== undefined || (meta.$metadata?.httpStatusCode ?? 0) >= 500;
}

function toClient(redirectUri: string, params: Record<string, string>): HttpResult {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return redirect(url.toString());
}

/**
 * A-31: where a person who joined lands: the welcome page, told the project the invite also made them a member of (`project`), or why it did not (`projectNote`).
 * The name is a project name (letters, digits and dashes), encoded all the same.
 */
export const joinedQuery = (result: { projectName?: string; projectNote?: string }): string => {
  const query = new URLSearchParams({ joined: "1" });
  if (result.projectName !== undefined) query.set("project", result.projectName);
  if (result.projectNote !== undefined) query.set("projectNote", result.projectNote);
  return query.toString();
};

const expired = () => page(400, "This sign-in link has expired", ["Run agentx login again."]);
/** One answer for every code failure (unknown, used, expired, wrong verifier, wrong redirect URI). */
const INVALID_CODE = ["invalid_grant", "the sign-in code is invalid, used or expired; run agentx login again"] as const;
const SIGN_IN_ENDED = ["invalid_grant", "your AgentX sign-in has ended; run agentx login again"] as const;

/** The sign-in server. With a `legacyIssuer` it is two servers over the same stores, told apart by the host a request came to. */
export function createDeveloperIdentityHandler(deps: DeveloperIdentityDependencies) {
  const primary = createIssuerHandler(deps);
  const legacy = deps.config.legacyIssuer;
  if (legacy === undefined) return primary;
  const legacyHost = new URL(legacy).host.toLowerCase();
  const { legacyIssuer: _unused, ...rest } = deps.config;
  void _unused;
  const own = createIssuerHandler({ ...deps, config: { ...rest, issuer: legacy } });
  const hostOf = (event: object): string | undefined => {
    const headers = (event as { headers?: Record<string, string | undefined> }).headers;
    return headers === undefined ? undefined : Object.entries(headers).find(([name]) => name.toLowerCase() === "host")?.[1]?.toLowerCase();
  };
  const primaryOrigin = new URL(deps.config.issuer).origin;
  // Direct invokes (the broker's questions to this function) have no host and are the canonical server's; so is any host that is not the API's own.
  // UX1: an invite opened on the API's own address moves to the custom domain before it signs anyone in, so the join's sign-in cookie lands on the host the app is served from.
  const handler: typeof primary = async (event) => {
    if ("kind" in event || hostOf(event) !== legacyHost) return primary(event);
    const http = event as { rawPath?: string; rawQueryString?: string; headers?: Record<string, string | undefined>; requestContext?: { http?: { method?: string } } };
    const accept = Object.entries(http.headers ?? {}).find(([name]) => name.toLowerCase() === "accept")?.[1] ?? "";
    const browserPage = !(/application\/json/i.test(accept) && !/text\/html/i.test(accept));
    if (http.requestContext?.http?.method === "GET" && (http.rawPath === "/v1/auth/join" || http.rawPath === "/v1/auth/join/start") && browserPage) {
      // Only the invite rides along: an address is never read from a query string, and none is copied into the address the browser is sent to.
      const forwarded = new URLSearchParams(http.rawQueryString ?? "");
      forwarded.delete("email");
      const query = forwarded.toString();
      return redirect(`${primaryOrigin}${http.rawPath}${query === "" ? "" : `?${query}`}`);
    }
    return own(event);
  };
  return handler;
}

function createIssuerHandler(deps: DeveloperIdentityDependencies) {
  const { config, store } = deps;
  const endpoint = (path: string) => `${config.issuer}${path}`;
  const methodLabel = (method: DeveloperSignInMethod) =>
    method === "slack" ? "Slack" : method === "cloud" ? config.cloud?.displayName ?? "cloud sign-in" : method === "github" ? config.github?.displayName ?? "GitHub" : method === "saml" ? "SAML single sign-on" : config.oidc?.displayName ?? "company sign-in";
  /** The enabled methods, minus SAML until an administrator has saved and enabled the identity provider (the sign-in page shows only what can work). */
  const availableMethods = async (): Promise<DeveloperSignInMethod[]> => {
    const methods = enabledMethods(deps);
    if (!methods.includes("saml")) return methods;
    let configured = false;
    try {
      configured = deps.saml !== undefined && await deps.saml.configured();
    } catch (error) {
      deps.log({ event: "signin.saml_config_unreadable", error: errorName(error) });
    }
    return configured ? methods : methods.filter((method) => method !== "saml");
  };
  /**
   * UX1: the methods the browser sign-in page offers. On Rovara Cloud (no single org) a company sign-in can neither create nor join a company
   * (NO_ORG_ON_INSTALL_MESSAGE), so the page leaves it out. Slack stays (OWNER DECISION 13, SLACK-SIGNIN-KEEP): it signs in a person whose Slack account is
   * linked to an account with a company; anyone else gets `method_unavailable`.
   */
  const browserSignInMethods = (methods: DeveloperSignInMethod[]): DeveloperSignInMethod[] =>
    deps.singleOrgId === undefined && config.cloud !== undefined ? methods.filter((method) => method !== "oidc") : methods;
  const provider = (method: DeveloperSignInMethod): SignInProvider => {
    // Every flow that talks to a provider (sign-in, join, link, decide) comes through here: an edition that has no such method never reaches it.
    if (!methodAllowedByEdition(deps.editionPolicy, method)) throw new ProviderNotConfiguredError(`${methodLabel(method)} sign-in is not available in this edition`);
    const found = deps.providers[method];
    if (found === undefined) throw new ProviderNotConfiguredError(`${methodLabel(method)} sign-in is not set up in this environment`);
    return found;
  };

  /** The session's access token, carrying the org the developer belongs to now; none while they belong to no org. */
  async function accessToken(session: SessionRecord): Promise<{ token: string; expiresIn: number } | undefined> {
    const membership = await deps.orgs.orgForDeveloper(session.developerId);
    if (membership === undefined) return undefined;
    return issueAccessToken(deps.signer, {
      issuer: config.issuer, subject: session.developerId, amr: session.amr, env: config.env, sessionId: session.sessionId, now: deps.now(),
      orgId: membership.orgId, orgRole: membership.role,
      // The access token never outlives its session (the edition's cap included).
      notAfter: session.endsAt,
    });
  }
  const tokens = (access: { token: string; expiresIn: number }, refreshToken: string): HttpResult =>
    jsonResult(200, { access_token: access.token, token_type: "Bearer", expires_in: access.expiresIn, refresh_token: refreshToken });

  async function revoke(sessionId: string, reason: string): Promise<void> {
    await store.revokeSession(sessionId, reason);
    deps.log({ event: "signin.session_revoked", sessionId, reason });
  }

  async function authorize(query: URLSearchParams): Promise<HttpResult> {
    const methods = await availableMethods();
    const requestId = query.get("request");
    if (requestId !== null) {
      const chosen = query.get("method");
      const method = methods.find((enabled) => enabled === chosen);
      if (method === undefined) return page(400, "Sign-in method not available", ["Run agentx login again."]);
      // A request that adds a removed sign-in method back is for that one method, whatever the link in the browser says.
      const pending = await store.getAuthRequest(requestId);
      if (pending?.linkMethod !== undefined && pending.linkMethod !== method) return page(400, "Sign-in method not available", ["This link is for a different sign-in method. Run agentx signin link again."]);
      const request = await store.chooseMethod(requestId, method);
      if (request === undefined) return expired();
      if (request.purpose === "join") return joinToProvider(request.id, request.nonce, method);
      if (request.purpose === "decide_identify" && decideFlow !== undefined) return decideFlow.identifyToProvider(request.id, request.nonce, method);
      if (request.linkDeveloperId !== undefined) return linkToProvider(request.id, request.nonce, method);
      try {
        return await toProvider(request.id, request.nonce, method, request.clientRedirectUri, request.clientState, request.fresh === true);
      } catch (error) {
        return serverError(error, "/v1/auth/authorize", request.clientRedirectUri, request.clientState);
      }
    }
    const redirectUri = query.get("redirect_uri") ?? "";
    if (query.get("client_id") !== AGENTX_CLI_CLIENT_ID || !isLoopbackRedirectUri(redirectUri)) {
      return page(400, "This sign-in link is not from the AgentX CLI", ["Start signing in from your terminal with agentx login <url>."]);
    }
    const clientState = query.get("state") ?? "";
    const challenge = query.get("code_challenge") ?? "";
    const invalid = (description: string) => toClient(redirectUri, { error: "invalid_request", error_description: description, ...(clientState === "" ? {} : { state: clientState }) });
    if (query.get("response_type") !== "code") return invalid("response_type must be code; update the AgentX CLI and run agentx login again");
    if (query.get("code_challenge_method") !== "S256" || !CHALLENGE.test(challenge)) return invalid("PKCE with S256 is required; update the AgentX CLI and run agentx login again");
    if (clientState.length < 1 || clientState.length > 512) return invalid("state is required; update the AgentX CLI and run agentx login again");
    // An invite link's token rides the sign-in to its end; the token is never logged, and a malformed one is refused now.
    const invite = query.get("invite");
    if (invite !== null && !INVITE_TOKEN_PATTERN.test(invite)) return invalid("invite is not a valid invite token; ask for a new invite link");
    // Invitation only: an invite written for an address makes that person's pool user before the sign-in page needs it (the cloud pool has no self sign-up); `agentx login --invite` is the same invite as the browser's.
    // A link anyone may use names no address, so the CLI tells such a person to open it in a browser (the JSON of the join page says so: inBrowserOnly).
    if (invite !== null && poolUsersMade) {
      const described = await deps.orgs.describeInvite(invite);
      if (described?.state === "open" && described.email !== undefined && await ensureInvitedPoolUser(described.email) !== "ok") {
        return toClient(redirectUri, { error: "temporarily_unavailable", state: clientState, error_description: "Rovara could not set up your sign-in right now; run agentx login again in a minute" });
      }
    }
    if (methods.length === 0) {
      return toClient(redirectUri, { error: "access_denied", state: clientState, error_description: "developer sign-in is not enabled in this AgentX environment; ask an admin to run agentx signin enable slack" });
    }
    // Plan 2, Task 8b: the CLI's fresh sign-in for removing a method leaves that method out of the choices (the server refuses it as proof anyway).
    const excluded = query.get("exclude_method");
    const fresh = query.get("fresh") === "1";
    const offered = methods.filter((method) => method !== excluded);
    const choices = offered.length > 0 ? offered : methods;
    let request: AuthRequestRecord;
    try {
      request = await store.createAuthRequest({ clientRedirectUri: redirectUri, clientState, codeChallenge: challenge, nonce: randomBytes(32).toString("base64url"), ...(invite === null ? {} : { inviteTokenHash: inviteTokenHash(invite) }), ...(fresh ? { fresh } : {}) });
      if (choices.length === 1) {
        const method = choices[0]!;
        if (await store.chooseMethod(request.id, method) === undefined) return expired();
        return await toProvider(request.id, request.nonce, method, redirectUri, clientState, fresh);
      }
    } catch (error) {
      return serverError(error, "/v1/auth/authorize", redirectUri, clientState);
    }
    return page(200, "Sign in to Rovara", [`Environment: ${config.env}`], choices.map((method) => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(request.id)}&method=${method}`,
      label: `Sign in with ${methodLabel(method)}`,
    })));
  }

  async function authorizeBrowser(query: URLSearchParams): Promise<HttpResult> {
    const returnTo = query.get("return_to") ?? "";
    if (!BROWSER_RETURN_TO.test(returnTo)) return page(400, "Invalid review link", ["Open the review from Slack and sign in again."]);
    const methods = browserSignInMethods(await availableMethods());
    if (methods.length === 0) return page(503, "Sign-in is unavailable", ["Ask an AgentX administrator to enable a sign-in method."]);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    // UX1 (OWNER DECISION 5): only "Create a company" on the sign-up screen asks for a company; any other browser sign-in of a new person creates nothing.
    const createCompany = query.get("intent") === "create";
    const auth = await store.createAuthRequest({
      clientRedirectUri: endpoint("/browser/callback"), clientState: randomBytes(24).toString("base64url"),
      codeChallenge: challenge, nonce: randomBytes(32).toString("base64url"), browserReturnTo: returnTo, ...(createCompany ? { createCompany: true as const } : {}),
    });
    const cookie = `${REVIEW_PKCE_COOKIE}=${verifier}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
    if (methods.length === 1) {
      const selected = await store.chooseMethod(auth.id, methods[0]!);
      if (selected === undefined) return page(400, "This sign-in link expired", ["Open the review from Slack and try again."]);
      try {
        const target = await provider(methods[0]!).authorizeUrl({ state: auth.id, nonce: auth.nonce, redirectUri: endpoint(`/callback/${methods[0]}`) });
        return { ...redirect(target), cookies: [cookie] };
      } catch (error) {
        deps.log({ event: "signin.browser_authorize_failed", method: methods[0], error: errorName(error) });
        return { ...page(503, "Sign-in is unavailable", ["Try opening the review again in a moment."]), cookies: [cookie] };
      }
    }
    return { ...page(200, "Sign in to Rovara", [`Environment: ${config.env}`], methods.map(method => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(auth.id)}&method=${method}`,
      label: `Sign in with ${methodLabel(method)}`,
    }))), cookies: [cookie] };
  }

  /** Plan 3, Task 21a-presence: the decide flow, over this server's own pages, providers and sign-in resolution. */
  const decideFlow = deps.decide === undefined ? undefined : createDecideSignIn({
    deps: deps.decide, signIn: store, orgs: deps.orgs, endpoint, methods: () => enabledMethods(deps), methodLabel, provider,
    resolveDeveloper: (method, identity) => resolveSignInDeveloper({ store, orgs: deps.orgs, log: deps.log,
      ...(deps.mergeDuplicate === undefined ? {} : { mergeDuplicate: deps.mergeDuplicate }) }, { method, identity }),
    noticeDecideSignIn: async (to) => {
      try {
        await sendDecideSignInAddedNotice({ ses: deps.notice?.ses, from: deps.notice?.from, log: deps.log }, { to, cellUrl: deps.notice?.cellUrl ?? new URL(config.issuer).origin });
      } catch (error) {
        deps.log({ event: "signin.decide_notice_failed", error: errorName(error) });
      }
    },
    page, redirect, now: deps.now, log: deps.log,
  });
  const inviterNameOf = async (developerId: string): Promise<string> => {
    const name = (await store.getDeveloper(developerId))?.displayName;
    return name === undefined || name === "" ? "Someone" : name;
  };
  /** The invite token in a join URL, when it has the shape of one. */
  const inviteTokenIn = (query: URLSearchParams): string | undefined => {
    const token = query.get("invite") ?? "";
    return INVITE_TOKEN_PATTERN.test(token) ? token : undefined;
  };
  const joinUnavailable = (cookies: string[] = []): HttpResult =>
    ({ ...page(503, "Sign-in is unavailable", ["Try opening the invite link again in a moment."]), ...(cookies.length === 0 ? {} : { cookies }) });

  /** Whether opening an invite makes the invitee's pool user: new companies are by invitation only and the cloud pool's admin API is wired (otherwise the pool still allows sign-up, or nothing can be made). */
  const poolUsersMade = deps.newOrgsByInvitationOnly === true && deps.invitedUsers !== undefined;

  /**
   * Invitation only: the cloud pool allows only AdminCreateUser, so a person with no pool user cannot sign up on the managed login page. An invite is what lets them in, so opening
   * one makes their pool user: the address the invite is written for, or the one the person typed for a link anyone may use. The user is verified and no email is sent (Rovara sends its
   * own); the person signs in with the emailed code, which proves the mailbox every time, and rule 2 (an email-targeted invite grants only to that verified address) still decides who joins.
   * A native user that already exists is left as it is. A Google-federated user is a different pool user (`Google_...`), which `AdminGetUser` by address does not find, so a native one is
   * made next to it; it is harmless, because that person keeps signing in with Google. Only an ASCII address is used, as everywhere else an address keys something.
   * With `limit` (an address a person typed) a user that does not exist yet takes one of the invite's slots, and "limited" answers when they are gone; the log names the invite by a hash
   * prefix and how many it has made, never the address.
   */
  async function ensureInvitedPoolUser(raw: string, limit?: { inviteHash: string; sourceHash?: string }): Promise<"ok" | "invalid" | "failed" | "limited"> {
    const { email, ascii } = normalizeEmail(raw);
    if (!ascii || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "invalid";
    const { client, userPoolId, limits } = deps.invitedUsers!;
    let taken: number | undefined;
    try {
      try {
        await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
        return "ok";
      } catch (error) {
        if (errorName(error) !== "UserNotFoundException") throw error;
      }
      if (limit !== undefined) {
        try {
          taken = await limits.takeInviteUserSlot(limit.inviteHash, limit.sourceHash);
        } catch (error) {
          if (!isCode(error, "TOO_MANY_REQUESTS")) throw error;
          deps.log({ event: "signin.join_pool_user_limited", invite: limit.inviteHash.slice(0, 12) });
          return "limited";
        }
      }
      try {
        await client.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId, Username: email, UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }], MessageAction: "SUPPRESS",
        }));
      } catch (error) {
        // Created by a concurrent open of the same invite: it is there, and this open made nothing.
        if (errorName(error) !== "UsernameExistsException" && errorName(error) !== "AliasExistsException") throw error;
        if (limit !== undefined && taken !== undefined) await limits.releaseInviteUserSlot(limit.inviteHash, limit.sourceHash).catch(() => undefined);
        return "ok";
      }
      deps.log({ event: "signin.join_pool_user_created", ...(limit === undefined ? {} : { invite: limit.inviteHash.slice(0, 12), count: taken ?? 0 }) });
      return "ok";
    } catch (error) {
      if (limit !== undefined && taken !== undefined) await limits.releaseInviteUserSlot(limit.inviteHash, limit.sourceHash).catch(() => undefined);
      deps.log({ event: "signin.join_pool_user_failed", error: errorName(error) });
      return "failed";
    }
  }

  /** The page for an invite that cannot be used (expired, used or unknown), or undefined for an open one. */
  async function joinInvite(query: URLSearchParams): Promise<{ page: HttpResult } | { token: string; invite: NonNullable<Awaited<ReturnType<typeof deps.orgs.describeInvite>>>; inviterName: string }> {
    const token = inviteTokenIn(query);
    const invite = token === undefined ? undefined : await deps.orgs.describeInvite(token);
    if (token === undefined || invite === undefined) return { page: render(unknownInvitePage()) };
    const inviterName = await inviterNameOf(invite.createdBy);
    if (invite.state === "expired") return { page: render(expiredInvitePage(inviterName)) };
    if (invite.state === "used") return { page: render(usedInvitePage(inviterName)) };
    return { token, invite, inviterName };
  }

  /**
   * The JSON form of the join page, for `agentx login --invite` (Plan 2, Task 6), which shows the person what they are about to join before
   * a browser opens. It says no more than the HTML page: the organization and role of an open invite, and only the state of any other
   * (no inviter, no address, not even masked, and no token). Reads only, like the page.
   */
  async function joinJson(query: URLSearchParams): Promise<HttpResult> {
    const token = inviteTokenIn(query);
    const invite = token === undefined ? undefined : await deps.orgs.describeInvite(token);
    const answer = (statusCode: number, body: unknown): HttpResult => ({ ...jsonResult(statusCode, body), headers: { ...JSON_HEADERS, vary: "accept", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
    if (invite === undefined) return answer(404, { state: "unknown" });
    if (invite.state === "expired" || invite.state === "used") return answer(410, { state: invite.state });
    // A link anyone may use names no address for the pool user a new person needs when sign-up is off: the CLI tells such a person to open it in a browser, which asks for the address.
    return answer(200, { orgName: invite.orgName, role: invite.role, state: "open", ...(poolUsersMade && invite.email === undefined ? { inBrowserOnly: true } : {}) });
  }

  /** `GET /v1/auth/join?invite=`: the invite, or why it cannot be used. Reads only; creates nothing. */
  async function joinPage(query: URLSearchParams, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const accept = headers.accept ?? "";
    if (/application\/json/i.test(accept) && !/text\/html/i.test(accept)) return joinJson(query);
    const found = await joinInvite(query);
    if ("page" in found) return found.page;
    const { token, invite, inviterName } = found;
    // Where new companies are by invitation only the cloud pool has no self sign-up: a link anyone may use names no address to make the pool user for, so a person with no account asks for a code here.
    const asksEmail = invite.email === undefined && poolUsersMade;
    return render(openInvitePage(
      { orgName: invite.orgName, role: invite.role, inviterName, ...(invite.email === undefined ? {} : { maskedEmail: maskEmail(invite.email) }) },
      endpoint(`/join/start?invite=${token}`),
      asksEmail ? { action: endpoint("/join/start"), invite: token } : undefined,
    ));
  }

  /**
   * `GET /v1/auth/join/start?invite=`: like authorizeBrowser, with the join cookie, the invite's hash and `purpose: "join"`. An email address is never read from the query string.
   * `POST /v1/auth/join/start` (the link invite's email form, `joinStartForm`) comes to the same place with the address from its body.
   */
  async function joinStart(query: URLSearchParams): Promise<HttpResult> {
    return startJoin(query, undefined, undefined);
  }

  /** `POST /v1/auth/join/start`: the email form of a link invite. The address is in the body, so it is in no URL, log or history; the form's own page is the only one that may submit it. */
  async function joinStartForm(body: string | undefined, headers: Record<string, string | undefined>, sourceIp: string | undefined): Promise<HttpResult> {
    // A browser that sends no Referer (or Origin) sends `Origin: null`, which names no site: it is treated as no Origin at all. A real foreign origin is refused.
    const origin = headers.origin;
    if (origin !== undefined && origin !== "null" && origin !== new URL(config.issuer).origin) return page(403, "That didn't come from Rovara", ["Open the invite link again and use the form on its page."]);
    const form = new URLSearchParams(body ?? "");
    return startJoin(new URLSearchParams({ invite: form.get("invite") ?? "" }), form.get("email") ?? "", sourceIp);
  }

  async function startJoin(query: URLSearchParams, typed: string | undefined, sourceIp: string | undefined): Promise<HttpResult> {
    const found = await joinInvite(query);
    if ("page" in found) return found.page;
    // Where the cloud pool allows only AdminCreateUser, the person's pool user is made now, before the sign-in page needs it (see ensureInvitedPoolUser).
    const viaForm = poolUsersMade && found.invite.email === undefined && typed !== undefined;
    const address = found.invite.email ?? (poolUsersMade ? typed : undefined);
    if (address !== undefined && poolUsersMade) {
      // Without a source address (API Gateway always sets one) only the per-invite cap applies: never one bucket shared by every request that lacks it.
      const limit = found.invite.email === undefined ? { inviteHash: inviteTokenHash(found.token), ...(sourceIp === undefined || sourceIp === "" ? {} : { sourceHash: sha256Hex(sourceIp) }) } : undefined;
      const ensured = await ensureInvitedPoolUser(address, limit);
      const back = [{ href: endpoint(`/join?invite=${found.token}`), label: "Go back to the invite" }];
      if (ensured === "invalid") return page(400, "Check your email address", ["That doesn't look like an email address."], back);
      if (ensured === "limited") return page(429, "Too many tries", ["Rovara can't set up another sign-in from this invite right now. Try again in an hour, or ask the person who invited you for a new invite."], back);
      if (ensured === "failed") return joinUnavailable();
    }
    const methods = await availableMethods();
    if (methods.length === 0) return page(503, "Sign-in is unavailable", ["Ask a Rovara administrator to enable a sign-in method."]);
    const verifier = randomBytes(32).toString("base64url");
    const auth = await store.createAuthRequest({
      clientRedirectUri: endpoint("/join/done"), clientState: randomBytes(24).toString("base64url"),
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"), nonce: randomBytes(32).toString("base64url"),
      inviteTokenHash: inviteTokenHash(found.token), purpose: "join",
    });
    const cookie = `${JOIN_PKCE_COOKIE}=${verifier}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
    if (methods.length === 1) {
      if (await store.chooseMethod(auth.id, methods[0]!) === undefined) return joinUnavailable([cookie]);
      const toProvider = await joinToProvider(auth.id, auth.nonce, methods[0]!);
      // The email form's own page allows form submissions only to this server, and a browser may refuse a redirect off it after one: go on by a page that moves the browser itself.
      const target = toProvider.headers.location;
      if (viaForm && toProvider.statusCode === 302 && target !== undefined) return { ...page(200, "Taking you to sign in", ["One moment."], [{ href: target, label: "Continue" }], target), cookies: [cookie] };
      return { ...toProvider, cookies: [cookie] };
    }
    return { ...page(200, "Sign in to Rovara", [], methods.map((method) => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(auth.id)}&method=${method}`,
      label: `Sign in with ${methodLabel(method)}`,
    }))), cookies: [cookie] };
  }

  /** Off to the provider for a join; a provider that cannot be reached is a page here, not a redirect to the CLI. */
  async function joinToProvider(requestId: string, nonce: string, method: DeveloperSignInMethod): Promise<HttpResult> {
    try {
      return redirect(await provider(method).authorizeUrl({ state: requestId, nonce, redirectUri: endpoint(`/callback/${method}`) }));
    } catch (error) {
      deps.log({ event: "signin.join_authorize_failed", method, error: errorName(error) });
      return joinUnavailable();
    }
  }

  /** The callback of a join: only the browser that started it may finish it, and the end of it is a stored result, never a session or a code. */
  async function joinCallback(method: DeveloperSignInMethod, request: AuthRequestRecord, code: string | null, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const verifier = cookieValue(headers.cookie, JOIN_PKCE_COOKIE);
    if (verifier === undefined || !pkceChallengeMatches(verifier, request.codeChallenge)) return render(joinExpiredPage());
    try {
      return await completeSignIn(method, request, code);
    } catch (error) {
      deps.log({ event: "signin.join_error", method, error: errorName(error) });
      if (error instanceof ProviderUnavailableError || error instanceof ProviderNotConfiguredError) return joinUnavailable();
      // A-31 review L1: the invite's project (or the account) changed while the join ran; nothing was written and the invite is unused.
      if (isCode(error, "CHANGE_STALE")) return page(409, "Open the invite link again", ["Something changed while you were joining, so nothing was changed. Open the invite link again to finish joining."]);
      return page(500, "Sign-in failed", ["Something went wrong on the Rovara server. Open the invite link again."]);
    }
  }

  /** What a join leaves behind: the outcome and the facts the done page shows, kept ten minutes. Nothing else, whatever the outcome. */
  async function finishJoin(request: AuthRequestRecord, org: SignInOrg | SignInNoOrg, described: Awaited<ReturnType<typeof deps.orgs.describeInviteByHash>>, method: DeveloperSignInMethod): Promise<JoinOutcome> {
    const outcome: JoinOutcome = org.orgId === undefined ? org.inviteError ?? "INVITE_INVALID" : org.inviteError ?? "joined";
    const invitedOrgName = described?.orgName ?? "";
    const joinedOrg = outcome === "joined" || outcome === "ALREADY_IN_ORG" ? await deps.orgs.getOrg(org.orgId!) : undefined;
    await store.putJoinResult(request.id, {
      outcome,
      orgName: outcome === "joined" ? joinedOrg?.name ?? invitedOrgName : invitedOrgName,
      role: outcome === "joined" ? (org.role === "admin" ? "admin" : "member") : described?.role ?? "member",
      ...(outcome === "ALREADY_IN_ORG" ? { currentOrgName: joinedOrg?.name ?? "your organization" } : {}),
      invitedOrgName,
      ...(described?.email === undefined ? {} : { maskedEmail: maskEmail(described.email) }),
      inviterName: described === undefined ? "Someone" : await inviterNameOf(described.createdBy),
      codeChallenge: request.codeChallenge,
      // A-31: only a join that happened carries its project (or why the project was left out).
      ...(outcome === "joined" && org.orgId !== undefined && org.project !== undefined ? { projectName: org.project.name } : {}),
      ...(outcome === "joined" && org.orgId !== undefined && org.projectNote !== undefined ? { projectNote: org.projectNote } : {}),
    });
    deps.log({ event: "signin.join_completed", method, outcome });
    return outcome;
  }

  /** `GET /v1/auth/join/done?request=`: how the join ended, for the browser whose cookie started it and nobody else. */
  async function joinDone(query: URLSearchParams, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const id = query.get("request") ?? "";
    const verifier = cookieValue(headers.cookie, JOIN_PKCE_COOKIE);
    const result = verifier === undefined || !REQUEST_ID_PATTERN.test(id) ? undefined : await store.getJoinResult(id);
    // One answer for a missing result, an old one and another browser's, so a request id tells a stranger nothing.
    if (result === undefined || verifier === undefined || !pkceChallengeMatches(verifier, result.codeChallenge)) return render(otherBrowserPage());
    // UX1: a person who joined lands in the app at once, on this same origin, where the join's sign-in cookie was set (the join cookie is spent).
    if (result.outcome === "joined") {
      return { ...redirect(`${new URL(config.issuer).origin}/app/welcome?${joinedQuery(result)}`), cookies: [`${JOIN_PKCE_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`] };
    }
    return render(joinDonePage(result, new URL(config.issuer).origin));
  }

  /** Once the CLI's redirect URI and state are known, any failure goes back to the CLI, so it never
   * waits out its timeout behind a 500 page. Only the error's name and, for an AgentXError, its code are logged: never its message. */
  function serverError(error: unknown, path: string, clientRedirect: string, clientState: string): HttpResult {
    deps.log({ event: "signin.error", path, error: errorName(error), ...errorCode(error) });
    return toClient(clientRedirect, { error: "server_error", error_description: "sign-in failed on the AgentX server; run agentx login again", state: clientState });
  }

  async function toProvider(requestId: string, nonce: string, method: DeveloperSignInMethod, clientRedirect: string, clientState: string, fresh = false): Promise<HttpResult> {
    try {
      return redirect(await provider(method).authorizeUrl({ state: requestId, nonce, redirectUri: endpoint(`/callback/${method}`), ...(fresh ? { freshSignIn: true } : {}) }));
    } catch (error) {
      return providerFailure(error, method, clientRedirect, clientState);
    }
  }

  function providerFailure(error: unknown, method: DeveloperSignInMethod, clientRedirect: string, clientState: string): HttpResult {
    if (error instanceof ProviderUnavailableError) {
      deps.log({ event: "signin.provider_unavailable", method });
      return toClient(clientRedirect, { error: "temporarily_unavailable", state: clientState, error_description: `${methodLabel(method)} could not be reached; run agentx login again in a minute` });
    }
    if (error instanceof ProviderNotConfiguredError) {
      // These messages are written by the providers and the Lambda entry, never copied from a
      // secret or a remote answer, so they are safe to show and log.
      deps.log({ event: "signin.not_configured", method, detail: error.message });
      return toClient(clientRedirect, { error: "access_denied", state: clientState, error_description: `${methodLabel(method)} sign-in is not finished: ${error.message}` });
    }
    throw error;
  }

  const browserReturn = (returnTo: string, signedIn: boolean, sessionId?: string, reason: SignedOutReason = "failed"): HttpResult => ({
    statusCode: 302,
    headers: { location: !signedIn && (returnTo === "/app" || returnTo.startsWith("/app/") || returnTo.startsWith("/app?") || returnTo.startsWith("/s/")) ? `/app/signed-out?reason=${reason}` : returnTo, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    body: "",
    cookies: [
      `${REVIEW_PKCE_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      ...(signedIn && sessionId !== undefined ? [`${REVIEW_SESSION_COOKIE}=${sessionId}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`] : []),
    ],
  });

  const NO_SAML = (): HttpResult => jsonResult(404, { error: "not_found" });

  /** `GET /v1/auth/saml/metadata`: our service provider metadata, for the administrator to give the identity provider. Public; no secret in it. */
  function samlMetadata(): HttpResult {
    if (deps.saml === undefined || !methodAllowedByEdition(deps.editionPolicy, "saml")) return NO_SAML();
    return { statusCode: 200, headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: deps.saml.metadata() };
  }

  /**
   * `POST /v1/auth/callback/saml`: the identity provider's POST of the response, made from its site. A browser sends no SameSite=Lax cookie on a cross-site POST, so the response is not read
   * here: it is kept for two minutes under a single-use handle, and the browser is sent on to the GET callback (which carries the cookies). Only a response for a sign-in that is waiting for SAML
   * is kept, so a stranger's POST writes nothing.
   */
  async function samlPost(body: string | undefined): Promise<HttpResult> {
    if (deps.saml === undefined || !methodAllowedByEdition(deps.editionPolicy, "saml")) return NO_SAML();
    const refused = () => page(400, "Sign-in could not be completed", [SAML_SIGN_IN_REFUSED_MESSAGE]);
    if (body === undefined || body.length > 400_000) return refused();
    const form = new URLSearchParams(body);
    const relay = form.get("RelayState") ?? "";
    const response = form.get("SAMLResponse") ?? "";
    if (!REQUEST_ID_PATTERN.test(relay) || response === "") return refused();
    const pending = await store.getAuthRequest(relay);
    if (pending === undefined || pending.method !== "saml" || pending.consumedAt !== undefined) return refused();
    let handle: string | undefined;
    try {
      handle = await deps.saml.accept(relay, response);
    } catch (error) {
      deps.log({ event: "signin.saml_post_failed", error: errorName(error) });
      return refused();
    }
    if (handle === undefined) return refused();
    // The relay state is the auth request id and the handle is single use; neither is a secret by itself (the request is consumed, with its nonce and PKCE checks, at the callback).
    return { statusCode: 303, headers: { location: endpoint(`/callback/saml?state=${encodeURIComponent(relay)}&code=${encodeURIComponent(handle)}`), "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" };
  }

  async function callback(method: DeveloperSignInMethod, query: URLSearchParams, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const state = query.get("state") ?? "";
    const pending = state === "" ? undefined : await store.getAuthRequest(state);
    if (pending === undefined && method === "cloud" && decideFlow !== undefined && state !== "") {
      // Plan 3, Task 21a-presence: the fresh sign-in of a decision keeps its state in its own record. Only the cloud (Cognito) callback
      // can finish it; a GitHub callback bearing the state finds no request and leaves it alone.
      const decide = await deps.decide!.store.consumeState(state);
      if (decide !== undefined) {
        try {
          return await decideFlow.callback(decide, query.get("code"), headers);
        } catch (error) {
          deps.log({ event: "signin.decide_error", error: errorName(error) });
          return withDecideIsolation(page(500, "Confirmation failed", ["Something went wrong on the Rovara server. Open the approval again from Rovara."]));
        }
      }
    }
    if (pending === undefined || pending.method !== method) return expired();
    // Single use: the state (and with it the nonce) is consumed before anything else happens.
    const request = await store.consumeAuthRequest(state, method);
    if (request === undefined) return page(400, "This sign-in link was already used", ["Run agentx login again."]);
    if (request.purpose === "join") return joinCallback(method, request, query.get("code"), headers);
    if (request.purpose === "decide_identify" && decideFlow !== undefined) {
      try {
        return await decideFlow.identifyCallback(method, request, query.get("code"), headers);
      } catch (error) {
        deps.log({ event: "signin.decide_error", method, error: errorName(error) });
        return page(500, "Confirmation failed", ["Something went wrong on the Rovara server. Open the approval again from Rovara."]);
      }
    }
    if (request.linkDeveloperId !== undefined) {
      if (request.linkMethod === "slack") return slackLinkCallback(request, query.get("code"), headers);
      if (request.linkMethod === "github" && request.linkBrowser === true) return githubLinkCallback(request, query.get("code"), headers);
      return linkCallback(method, request, query.get("code"));
    }
    if (request.browserReturnTo !== undefined) {
      const verifier = (headers.cookie ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${REVIEW_PKCE_COOKIE}=`))?.slice(REVIEW_PKCE_COOKIE.length + 1);
      if (!BROWSER_RETURN_TO.test(request.browserReturnTo) || verifier === undefined || !pkceChallengeMatches(verifier, request.codeChallenge)) {
        return page(400, "This review sign-in link expired", ["Open the review from Slack and sign in again."]);
      }
    }
    try {
      return await completeSignIn(method, request, query.get("code"));
    } catch (error) {
      // The state is spent, so tell the CLI now rather than leave it waiting for its timeout.
      if (request.browserReturnTo !== undefined) {
        deps.log({ event: "signin.browser_error", method, error: errorName(error) });
        return browserReturn(request.browserReturnTo, false, undefined, error instanceof ProviderUnavailableError || error instanceof ProviderNotConfiguredError ? "unavailable" : "failed");
      }
      return serverError(error, `/v1/auth/callback/${method}`, request.clientRedirectUri, request.clientState);
    }
  }

  /**
   * The company sign-in's decision (developer/sso-sign-in.ts), with its audit event recorded: a refusal and an ordinary sign-in are recorded best effort, and a
   * break-glass sign-in durably BEFORE it is let through (a record that cannot be made refuses it). Anything but the company's own sign-in is refused: the edition's
   * other methods are not offered, and a flow that reaches here by another method gets no access.
   */
  /** Removes the Slack allowance of a person whose company sign-in was refused, by the Slack user their developer record names. */
  async function revokeSlackAllowance(developerId: string): Promise<void> {
    if (deps.sso === undefined || deps.singleOrgId === undefined) return;
    const slackUserId = (await store.getDeveloper(developerId))?.slackUserId;
    if (slackUserId !== undefined) await deps.sso.slack.revoke(deps.singleOrgId, slackUserId);
  }

  /**
   * Whether the person is banned from the install's org and the sign-in carries no way back. An invite is the way back (accepting it clears the ban), so a sign-in with an invite
   * that accepting would take is not refused here: it is one that exists, is not revoked, used or expired, is for this org, and (when written for an address) for this verified
   * address, as resolveOrgOnSignIn judges it. Anything else, a forged or other-org invite included, leaves the person refused.
   */
  async function bannedWithoutInvite(identity: ProviderIdentity, developerId: string, inviteTokenHash: string | undefined, formerDevelopers?: () => Promise<readonly string[]>): Promise<boolean> {
    const singleOrgId = deps.singleOrgId;
    if (singleOrgId === undefined) return false;
    // The ban of the developer, or of any developer this identity was unlinked from: unlinking before a removal must not leave a way back in (resolveOrgOnSignIn judges the same set).
    // The developer's own ban is read first; the walk is made only for a person not banned themselves.
    let banned = await deps.orgs.isBanned(singleOrgId, developerId);
    if (!banned && formerDevelopers !== undefined) banned = (await Promise.all((await formerDevelopers()).map((id) => deps.orgs.isBanned(singleOrgId, id)))).some(Boolean);
    if (!banned) return false;
    if (inviteTokenHash === undefined) return true;
    const invite = await deps.orgs.describeInviteByHash(inviteTokenHash);
    const forThem = invite?.email === undefined || (identity.emailVerified === true && identity.email !== undefined && sameEmail(invite.email, identity.email));
    // A project maintainer's invite never lifts a ban (A-31; the store refuses it too), so it is not a way back here.
    return !(invite !== undefined && invite.state === "open" && invite.orgId === singleOrgId && forThem && invite.projectInviter !== "maintainer");
  }

  async function decideCompanySignInFor(method: DeveloperSignInMethod, identity: ProviderIdentity, developerId: string, occurrence: string, inviteTokenHash?: string, formerDevelopers?: () => Promise<readonly string[]>): Promise<CompanySignIn> {
    const current = await deps.orgs.orgForDeveloper(developerId);
    const audit = deps.audit === undefined ? {} : { audit: deps.audit };
    const outcome = await decideCompanySignIn({
      policy: deps.editionPolicy!, stores: deps.sso, method, orgId: deps.singleOrgId, identity, developerId, currentRole: current?.role, occurrence,
      auditAvailable: deps.audit !== undefined, nowMs: deps.now(),
      // A banned person is refused here, before an allowance or an "allowed" record is made for them; resolveOrgOnSignIn refuses the same person later for the other methods.
      // A person who already has an org is judged by their own ban only (rule 1 of resolveOrgOnSignIn keeps them); the developers an identity was unlinked from count for one with none.
      banned: await bannedWithoutInvite(identity, developerId, inviteTokenHash, current === undefined ? formerDevelopers : undefined),
    });
    if (outcome.allow && outcome.breakGlass) {
      await recordAuditEventDurably(audit, outcome.event);
      deps.log({ event: "signin.break_glass_used", level: "alert", developerId });
    } else if (outcome.event !== undefined && !outcome.allow) {
      // A refusal is recorded now. An allowed sign-in is recorded by the caller once the sign-in has gone through (the person's org was resolved), not before.
      await recordAuditRead(audit, outcome.event);
    }
    return outcome;
  }

  async function completeSignIn(method: DeveloperSignInMethod, request: AuthRequestRecord, code: string | null): Promise<HttpResult> {
    const client = (params: Record<string, string>) => toClient(request.clientRedirectUri, { ...params, state: request.clientState });
    // A join (the invite page's sign-in) ends on a page and a stored result, never in a session, a code or a redirect to the CLI.
    const join = request.purpose === "join";
    if (request.browserReturnTo !== undefined && !BROWSER_RETURN_TO.test(request.browserReturnTo)) return page(400, "Invalid review link", ["Open the review from Slack and sign in again."]);
    if (code === null && join) return page(400, "Sign-in was cancelled", ["Open the invite link again to try again."]);
    if (code === null) return request.browserReturnTo === undefined
      ? client({ error: "access_denied", error_description: `the sign-in was cancelled at ${methodLabel(method)}; run agentx login again` })
      : browserReturn(request.browserReturnTo, false, undefined, "cancelled");
    let result: ProviderResult;
    try {
      result = await provider(method).complete({ code, nonce: request.nonce, redirectUri: endpoint(`/callback/${method}`), state: request.id });
    } catch (error) {
      if (request.browserReturnTo !== undefined || join) throw error;
      return providerFailure(error, method, request.clientRedirectUri, request.clientState);
    }
    if (!result.ok) {
      deps.log({ event: "signin.refused", method, reason: result.code ?? result.reason });
      if (join) return page(403, "Sign-in was refused", [result.reason, "Open the invite link again to try another account."]);
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "refused");
      // A provider may quietly reuse the refused account's session on the next try, so say how to switch.
      const hint = result.wrongAccount === true ? `. If you signed in with the wrong account, sign out of ${methodLabel(method)} or use a private window, then try again.` : "";
      return client({ error: "access_denied", error_description: `${result.reason}${hint}` });
    }
    const identity = result.identity;
    // On a single-org install, the developers this identity was unlinked from (through any chain): a ban on one of them covers it (see resolveOrgOnSignIn `formerDevelopers`). Looked up
    // only when a check needs it, so a person who already belongs (rule 1) is never held up by a chain that cannot be read. Fails closed, with its own words and log reason.
    let traced: Promise<readonly string[]> | undefined;
    const formerDevelopers = deps.singleOrgId === undefined ? undefined : (): Promise<readonly string[]> => (traced ??= (async () => {
      try {
        return await store.formerDevelopersOf(ownerKeyForSubject(identity.issuer, identity.subject));
      } catch (error) {
        if (isCode(error, "FORBIDDEN") && refusalWords(error) === UNTRACEABLE_IDENTITY_MESSAGE) throw error;
        deps.log({ event: "signin.former_developers_unreadable", method, errorName: errorName(error) });
        throw agentXError("FORBIDDEN", REMOVAL_CHECK_UNAVAILABLE_MESSAGE);
      }
    })());
    /** A sign-in refused because the removal check could not be made: told why, with its own log reason (not "Something went wrong"). */
    const traceRefusal = (error: unknown, developerId: string): HttpResult | undefined => {
      const reason = !isCode(error, "FORBIDDEN") ? undefined : refusalWords(error) === UNTRACEABLE_IDENTITY_MESSAGE ? "untraceable_identity" : refusalWords(error) === REMOVAL_CHECK_UNAVAILABLE_MESSAGE ? "removal_check_unavailable" : undefined;
      if (reason === undefined) return undefined;
      deps.log({ event: "signin.refused", method, reason, developerId });
      const words = refusalWords(error);
      if (join) return page(403, "Sign-in was refused", [capitalized(words), "Ask your administrator."]);
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "refused");
      return client({ error: "access_denied", error_description: words });
    };
    // Enterprise foundations I1: where the edition has company group sign-in, the person's groups decide whether they come in, as what, and for how long.
    // This is before anything else is written or looked up about them: the identity link and any merge, the Slack lookup, the developer record, the org, a session or a code.
    // The developer a company sign-in resolves to is read, not written: its identity's link if it has one, else its own key (a merge or a join of another route is for the cloud and GitHub methods).
    let companySignIn: Extract<CompanySignIn, { allow: true }> | undefined;
    let decidedFor: string | undefined;
    if (deps.editionPolicy?.features.sso === true) {
      const key = ownerKeyForSubject(identity.issuer, identity.subject);
      const link = await store.getIdentityLink(key);
      const decisionId = link !== undefined && (link.unlinkedFrom === undefined || link.developerId === key) ? link.developerId : key;
      decidedFor = decisionId;
      const developerId = decisionId;
      let decided: CompanySignIn;
      try {
        decided = await decideCompanySignInFor(method, identity, decisionId, request.id, request.inviteTokenHash, formerDevelopers);
      } catch (error) {
        const refused = traceRefusal(error, developerId);
        if (refused === undefined) throw error;
        return refused;
      }
      if (!decided.allow) {
        deps.log({ event: "signin.refused", method, reason: decided.reason, developerId });
        // A person the mapping no longer lets in loses their Slack access too (Enterprise foundations I-6).
        await revokeSlackAllowance(developerId);
        if (join) return page(403, "Sign-in was refused", [decided.message, "Ask your administrator."]);
        if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "refused");
        return client({ error: "access_denied", error_description: decided.message });
      }
      companySignIn = decided;
    }
    // One developer per person: a second sign-in route for the same verified email is linked to the first route's developer.
    const resolved = await resolveSignInDeveloper({ store, orgs: deps.orgs, log: deps.log, ...(deps.mergeDuplicate === undefined ? {} : { mergeDuplicate: deps.mergeDuplicate }) }, { method, identity });
    const { developerId, identityKey } = resolved;
    // The decision was made for a developer read before the link was written; a race that resolves to another developer gets no access from it.
    if (decidedFor !== undefined && developerId !== decidedFor) throw agentXError("CHANGE_STALE", "the sign-in changed while it was being decided; run it again");
    const existing = await store.getDeveloper(developerId);
    if (existing?.revoked === true) {
      deps.log({ event: "signin.refused", method, reason: "developer_revoked", developerId });
      if (join) return page(403, "Your sign-in was turned off", ["Contact a Rovara administrator."]);
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "ended");
      return client({ error: "access_denied", error_description: "your AgentX sign-in was turned off by an admin; contact an admin" });
    }
    /** The earliest end this sign-in may have: the edition's session cap, and for SAML the provider's own SessionNotOnOrAfter (review N2). */
    const endsCap = (): number | undefined => {
      const ends = [companySignIn?.sessionEndsAt, identity.sessionNotOnOrAfter].filter((value): value is number => value !== undefined);
      return ends.length === 0 ? undefined : Math.min(...ends);
    };
    /** What a company sign-in leaves on its session for a later mapping change to check itself against (Enterprise foundations N-2). */
    const sessionClaims = (): { groupClaims?: Record<string, unknown>; ssoBreakGlass?: true } => companySignIn === undefined ? {}
      : { groupClaims: identity.claims ?? {}, ...(companySignIn.breakGlass ? { ssoBreakGlass: true as const } : {}) };
    let slackUserId = identity.slackUserId;
    // ProviderIdentity.email is set only for a verified email (providers.ts), so only a verified
    // email is ever looked up in Slack.
    if (slackUserId === undefined && identity.email !== undefined) {
      const link = await deps.directory.lookupByEmail(identity.email);
      slackUserId = link === "unavailable" ? existing?.slackUserId : link === "none" ? undefined : link.userId;
    }
    // The developer record keeps the first identity's issuer and subject (ownerKeyForSubject(issuer, subject) === developerId, which
    // task-person-identity.ts relies on), so a linked sign-in only records that it happened.
    if (resolved.link === "new-self" || (resolved.link === "existing" && developerId === identityKey)) {
      await store.upsertDeveloper({
        developerId, provider: method, issuer: identity.issuer, subject: identity.subject, displayName: identity.displayName,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        ...(slackUserId === undefined ? {} : { slackUserId }),
      });
    }
    // A link written just now already carries this sign-in's time. The provider's own `auth_time`, when it sends one, is kept beside it (it is what a recent sign-in for approvals counts for a company sign-in), for a new link too.
    if (resolved.link === "existing" || identity.authTime !== undefined) await store.touchIdentity(identityKey, identity.authTime);
    // A method newly linked to an existing account tells that account's address, so a person who did not do it can remove it at once.
    if (resolved.link === "new-linked") await noticeNewMethod(method, identity, existing?.email);
    // A first sign-in puts the person in an org (ruling R2); the tokens and the browser session carry it from here. A join read the
    // invite first (it is used up if the person joins), to have the names its page shows.
    const described = join && request.inviteTokenHash !== undefined ? await deps.orgs.describeInviteByHash(request.inviteTokenHash) : undefined;
    const orgDependencies = { orgs: deps.orgs, ...(deps.singleOrgId === undefined ? {} : { singleOrgId: deps.singleOrgId }), singleOrgName: config.env, log: deps.log,
      ...(deps.onOrgJoined === undefined ? {} : { onOrgJoined: deps.onOrgJoined }), ...(deps.newOrgsByInvitationOnly === true ? { newOrgsByInvitationOnly: true } : {}) };
    const orgInput = { method, developerId, displayName: identity.displayName, ...(identity.email === undefined ? {} : { email: identity.email }), emailVerified: identity.emailVerified === true,
      ...(request.inviteTokenHash === undefined ? {} : { inviteTokenHash: request.inviteTokenHash }), ...(resolved.separatedFrom === undefined ? {} : { separatedFrom: resolved.separatedFrom }),
      ...(formerDevelopers === undefined ? {} : { formerDevelopers }) };
    let org: SignInOrg | SignInNoOrg;
    // UX1 (OWNER DECISION 5): a browser sign-in creates a company only when the person chose "Create a company". For the cloud and GitHub methods
    // `allowCreate: false` skips only that (rule 3); a person who already has a company, or brings an invite, is unaffected.
    const askedToCreate = request.browserReturnTo === undefined || request.createCompany === true || (method !== "cloud" && method !== "github");
    try {
      org = join || !askedToCreate ? await resolveOrgOnSignIn(orgDependencies, { ...orgInput, allowCreate: false }) : await resolveOrgOnSignIn(orgDependencies, orgInput);
    } catch (error) {
      const untraced = traceRefusal(error, developerId);
      if (untraced !== undefined) return untraced;
      if (join) throw error;
      // Invitation only: no company is made for a person who has none and brings no usable invite. Nothing was written for the org; the person is told how to get in.
      if (isCode(error, "CONFIG_INVALID") && refusalWords(error) === INVITATION_ONLY_MESSAGE) {
        deps.log({ event: "signin.refused", method, reason: "invitation_only", developerId });
        if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "invitation_only");
        return client({ error: "access_denied", error_description: INVITATION_ONLY_MESSAGE });
      }
      // A Slack or company sign-in on a cloud install has no org to join (R51): told to sign in with Rovara, not shown an internal error.
      if (isCode(error, "CONFIG_INVALID") && refusalWords(error) === NO_ORG_ON_INSTALL_MESSAGE) {
        deps.log({ event: "signin.refused", method, reason: "no_org_on_install", developerId });
        if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "method_unavailable");
        return client({ error: "access_denied", error_description: `${NO_ORG_ON_INSTALL_MESSAGE}; run agentx login again and choose Sign in with Rovara` });
      }
      // SLACK-LINK-1: this account was linked into another one (a Slack or GitHub link in another tab) just as the sign-in was creating or joining a company. Nothing was
      // written; a fresh sign-in resolves to the account it was linked into. Told "sign in again", not shown an internal error.
      if (isCode(error, "CHANGE_STALE") && refusalWords(error) === MERGED_AWAY_MESSAGE) {
        deps.log({ event: "signin.refused", method, reason: "linked_elsewhere", developerId });
        if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "ended");
        return client({ error: "access_denied", error_description: `${MERGED_AWAY_MESSAGE}; run agentx login again` });
      }
      // IDENTITY-HEALING-CROSS-ORG: another sign-in route of this person holds the email and its company was made a moment ago (two first sign-ins at once).
      // No second company is made; the person signs in the other way and adds this method in Settings. The browser shows the generic "refused" page for now.
      if (isCode(error, "CHANGE_STALE") && refusalWords(error) === ALREADY_SIGNED_UP_MESSAGE) {
        deps.log({ event: "signin.refused", method, reason: "already_signed_up", developerId });
        if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "refused");
        return client({ error: "access_denied", error_description: ALREADY_SIGNED_UP_MESSAGE });
      }
      // A removed member (single-org ban) is told so, not shown an internal error.
      if ((error as { code?: unknown } | null)?.code !== "REMOVED_FROM_ORG") throw error;
      deps.log({ event: "signin.refused", method, reason: "removed_from_org", developerId });
      // The mapping allowed this sign-in but nothing of it was recorded as allowed: the refusal is what goes on record.
      if (companySignIn !== undefined && deps.singleOrgId !== undefined) {
        await recordAuditRead(deps.audit === undefined ? {} : { audit: deps.audit }, companySignInRefusalEvent({ orgId: deps.singleOrgId, developerId, occurrence: request.id, nowMs: deps.now(), reason: "removed_from_org" }));
      }
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false, undefined, "removed");
      return client({ error: "access_denied", error_description: (error as Error).message.replace(/^REMOVED_FROM_ORG: /, "") });
    }
    // The sign-in is through: now its "allowed" record and the Slack user's allowance are made (a sign-in refused above, such as a ban whose invite went stale, leaves neither).
    // Enterprise foundations I-6: the Slack user this person is, allowed until their session ends. Without a Slack account there is nothing for Slack to act as.
    if (companySignIn !== undefined) {
      if (!companySignIn.breakGlass && companySignIn.event !== undefined) await recordAuditRead(deps.audit === undefined ? {} : { audit: deps.audit }, companySignIn.event);
      if (slackUserId !== undefined && deps.sso !== undefined && deps.singleOrgId !== undefined) await deps.sso.slack.record(deps.singleOrgId, slackUserId, developerId, companySignIn.sessionEndsAt, method);
    }
    // The mapped role replaces the person's role at every sign-in (an owner is never changed by a mapping): leaving a group takes the access away at the next sign-in.
    if (companySignIn !== undefined && org.orgId !== undefined && org.role !== companySignIn.orgRole) {
      await deps.orgs.setRole({ orgId: org.orgId, developerId, role: companySignIn.orgRole, by: { kind: "system", id: "rovara" }, requestId: request.id });
    }
    if (join) {
      const outcome = await finishJoin(request, org, described, method);
      // Joining an org with a GitHub sign-in unlocks that org's trial as any GitHub sign-in does; no other outcome touches an org.
      if (outcome === "joined" && method === "github" && identity.githubUserId !== undefined && deps.onGithubSignIn !== undefined && org.orgId !== undefined) {
        await unlockTrialBestEffort(org.orgId, identity.githubUserId, developerId);
      }
      if (outcome === "joined") {
        const endsAt = Math.min(Math.floor(deps.now() / 1000) + SESSION_MAX_AGE_SECONDS, endsCap() ?? Number.MAX_SAFE_INTEGER);
        const { session } = await store.createSession({ developerId, amr: method, identityKey, authTime: signInTime(identity.authTime), ...sessionClaims(),
          ...(slackUserId === undefined ? {} : { slackUserId }), reviewExpiresAt: endsAt, endsAt });
        return browserReturn(endpoint(`/join/done?request=${request.id}`), true, session.sessionId);
      }
      return redirect(endpoint(`/join/done?request=${request.id}`));
    }
    // A browser sign-in of a new person who did not ask for a company ends here: nothing was created, and the app explains the two ways in.
    if (org.orgId === undefined && !askedToCreate && request.browserReturnTo !== undefined) {
      // Where new companies are by invitation only, "Create a company" is not offered, so the page says invitation only instead.
      const noAccount = deps.newOrgsByInvitationOnly === true ? "invitation_only" : "no_account";
      deps.log({ event: "signin.refused", method, reason: noAccount, developerId });
      return browserReturn(request.browserReturnTo, false, undefined, noAccount);
    }
    // Only a join (or the case above) answers without an org; this sign-in created or joined one.
    if (org.orgId === undefined) throw new Error("sign-in resolved no organization");
    if (method === "github" && identity.githubUserId !== undefined && deps.onGithubSignIn !== undefined) await unlockTrialBestEffort(org.orgId, identity.githubUserId, developerId);
    // When the person signed in: the callback's time, or the provider's own `auth_time` when that is earlier (a provider that reused its browser
    // session says so here). A stale one makes the session not fresh, so it cannot be used to change sign-in methods.
    const authTime = signInTime(identity.authTime);
    if (request.fresh === true && !isFreshSignIn({ authTime }, deps.now())) deps.log({ event: "signin.fresh_sign_in_not_fresh", method });
    if (request.browserReturnTo !== undefined) {
      // A fixed 30 days from sign-in, with no renewal (an edition's sign-in cap, when it has one, comes sooner): the session record ends then, whatever the cookie says.
      const endsAt = Math.min(Math.floor(deps.now() / 1000) + SESSION_MAX_AGE_SECONDS, endsCap() ?? Number.MAX_SAFE_INTEGER);
      const { session } = await store.createSession({ developerId, amr: method, identityKey, authTime, ...sessionClaims(),
        ...(slackUserId === undefined ? {} : { slackUserId }),
        reviewExpiresAt: endsAt, endsAt,
      });
      deps.log({ event: "signin.browser_succeeded", method, developerId });
      return browserReturn(request.browserReturnTo, true, session.sessionId);
    }
    const agentxCode = await store.issueCode({ developerId, amr: method, identityKey, authTime, ...sessionClaims(), ...(endsCap() === undefined ? {} : { sessionEndsAt: endsCap()! }), ...(slackUserId === undefined ? {} : { slackUserId }), codeChallenge: request.codeChallenge, redirectUri: request.clientRedirectUri });
    deps.log({ event: "signin.succeeded", method, developerId, linkedToSlack: slackUserId !== undefined });
    // An invite that was not used (the person is already in an org, or it is unknown, used, expired or for another email) is reported, not hidden.
    return client({ code: agentxCode, ...(org.inviteError === undefined ? {} : { inviteError: org.inviteError }) });
  }

  /** Off to the provider for adding a removed method back; a provider that cannot be reached is a page, not a redirect to the CLI. */
  async function linkToProvider(requestId: string, nonce: string, method: DeveloperSignInMethod): Promise<HttpResult> {
    try {
      return redirect(await provider(method).authorizeUrl({ state: requestId, nonce, redirectUri: endpoint(`/callback/${method}`), chooseAccount: true }));
    } catch (error) {
      deps.log({ event: "signin.link_authorize_failed", method, error: errorName(error) });
      return page(503, "Sign-in is unavailable", ["Nothing was added. Try again in a moment."]);
    }
  }

  /**
   * The end of the Slack link, started by a signed-in web user (owner decision, 2026-11-05). Four things must hold, and the answer is always a redirect back to the web app with a short outcome code
   * (`slack_link`), never a page that carries a name, an ID or a reason from Slack:
   *  - the callback comes from the browser that holds the web session that started it (its session cookie is the request's `linkSessionId`), so a link started by someone else cannot be finished by this person's Slack sign-in;
   *  - the state was issued for this request, is spent here, and the ID token's nonce matches (the provider checks it);
   *  - the Slack workspace is the company's bound team, and the account's session is still a fresh one;
   *  - the Slack account is not already someone else's (linked to another account, or its own developer holds a company): nothing is merged then.
   * The link itself is the sign-in table's identity link (`linkSlackIdentity`); no email lookup takes part, only the Slack user who signed in at Slack just now.
   */
  async function slackLinkCallback(request: AuthRequestRecord, code: string | null, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const developerId = request.linkDeveloperId!;
    const back = (outcome: string) => redirect(`${new URL(config.issuer).origin}/app?slack_link=${outcome}`);
    const held = (headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("__Host-agentx_review_session="))?.slice("__Host-agentx_review_session=".length);
    if (request.linkSessionId === undefined || request.linkBrowser !== true || held === undefined || !sameText(held, request.linkSessionId)) {
      deps.log({ event: "signin.slack_link_wrong_browser", developerId });
      return back("wrong_browser");
    }
    if (code === null) return back("cancelled");
    let result: ProviderResult;
    try {
      result = await provider("slack").complete({ code, nonce: request.nonce, redirectUri: endpoint("/callback/slack") });
    } catch (error) {
      deps.log({ event: "signin.slack_link_error", error: errorName(error) });
      return back("error");
    }
    if (!result.ok) {
      deps.log({ event: "signin.slack_link_refused", wrongAccount: result.wrongAccount === true });
      return back(result.wrongAccount === true ? "wrong_team" : "refused");
    }
    const identity = result.identity;
    let session: SessionRecord;
    try {
      session = await store.freshSessionFor({ developerId, sessionId: request.linkSessionId });
    } catch (error) {
      if (!isCode(error, "REAUTH_REQUIRED")) throw error;
      return back("reauth");
    }
    // The Slack workspace the person signed in to must be the one this account's company has bound.
    const own = await deps.orgs.orgForDeveloper(developerId);
    // UX1: a company with no Slack workspace connected at all is told that, not "wrong workspace".
    if (own !== undefined && !await deps.orgs.hasSlackTeam(own.orgId)) {
      deps.log({ event: "signin.slack_link_no_workspace", developerId });
      return back("no_workspace");
    }
    const bound = identity.slackTeamId === undefined ? undefined : await deps.orgs.orgForSlackTeam(identity.slackTeamId);
    if (own === undefined || bound === undefined || bound !== own.orgId) {
      deps.log({ event: "signin.slack_link_wrong_team", developerId });
      return back("wrong_team");
    }
    const identityKey = ownerKeyForSubject(identity.issuer, identity.subject);
    const outcome = await store.linkSlackIdentity({
      developerId, identityKey, subject: identity.subject, issuer: identity.issuer, ...(identity.email === undefined ? {} : { email: identity.email }),
      by: { method: session.amr }, belongsToCompany: await deps.orgs.orgForDeveloper(identityKey) !== undefined,
    });
    if (!outcome.ok) {
      deps.log({ event: "signin.slack_link_refused_link", developerId, reason: outcome.reason });
      return back(outcome.reason === "taken" ? "taken" : outcome.reason === "has_one" ? "has_one" : "error");
    }
    deps.log({ event: "signin.slack_linked", developerId });
    return back("linked");
  }

  /**
   * UX1: the end of a GitHub link started by a signed-in web user, whatever method they signed in with. The same four rules as the Slack link: the
   * callback comes from the browser holding the session that started it; the state is spent and the provider checked the code; the account's session
   * is still fresh; the GitHub account is not someone else's (linked to another account, or its own account holds a company). It never creates a
   * company, a trial, a session or a code: it only links the identity to this account. The answer is a redirect back to the app with an outcome code.
   */
  async function githubLinkCallback(request: AuthRequestRecord, code: string | null, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const developerId = request.linkDeveloperId!;
    const back = (outcome: string) => redirect(`${new URL(config.issuer).origin}${request.linkReturnTo === "/app/onboard" || request.linkReturnTo === "/app/admin/connections" ? request.linkReturnTo : "/app"}?github_link=${outcome}`);
    const held = cookieValue(headers.cookie, REVIEW_SESSION_COOKIE);
    if (request.linkSessionId === undefined || held === undefined || !sameText(held, request.linkSessionId)) {
      deps.log({ event: "signin.github_link_wrong_browser", developerId });
      return back("wrong_browser");
    }
    if (code === null) return back("cancelled");
    let result: ProviderResult;
    try {
      result = await provider("github").complete({ code, nonce: request.nonce, redirectUri: endpoint("/callback/github"), state: request.id });
    } catch (error) {
      deps.log({ event: "signin.github_link_error", error: errorName(error) });
      return back("error");
    }
    if (!result.ok) {
      deps.log({ event: "signin.github_link_refused", reason: result.code ?? "refused" });
      return back("refused");
    }
    const identity = result.identity;
    let session: SessionRecord;
    try {
      session = await store.freshSessionFor({ developerId, sessionId: request.linkSessionId });
    } catch (error) {
      if (!isCode(error, "REAUTH_REQUIRED")) throw error;
      return back("reauth");
    }
    const identityKey = ownerKeyForSubject(identity.issuer, identity.subject);
    const outcome = await store.linkGithubIdentity({
      developerId, identityKey, subject: identity.subject, issuer: identity.issuer, ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(identity.login === undefined ? {} : { login: identity.login }),
      by: { method: session.amr }, belongsToCompany: await deps.orgs.orgForDeveloper(identityKey) !== undefined,
    });
    if (!outcome.ok) {
      deps.log({ event: "signin.github_link_refused_link", developerId, reason: outcome.reason });
      return back(outcome.reason === "taken" ? "taken" : outcome.reason === "has_one" ? "has_one" : "error");
    }
    deps.log({ event: "signin.github_linked", developerId });
    // The same notice as any new sign-in method: a person who did not do this can remove it at once.
    if (outcome.created) await noticeNewMethod("github", identity, await accountEmail(developerId));
    return back("linked");
  }

  /**
   * The end of the flow that adds a removed sign-in method back (Plan 2, Task 8b). The identity that signed in at the provider is linked to
   * the one developer the request names, and only when it was unlinked from them and nobody has linked it since (`relinkIdentity`); the
   * developer's session must still be fresh. It never starts a developer, a session or a code, and it never looks for another account by
   * email: an identity signing in on its own is not this flow. The answer is a page.
   */
  async function linkCallback(method: DeveloperSignInMethod, request: AuthRequestRecord, code: string | null): Promise<HttpResult> {
    const developerId = request.linkDeveloperId!;
    const again = `Run agentx signin link ${method} again.`;
    if (request.linkSessionId === undefined || request.linkMethod !== method) return page(400, "This link is not valid", [again]);
    if (code === null) return page(400, "Sign-in was cancelled", ["Nothing was added.", again]);
    let result: ProviderResult;
    try {
      result = await provider(method).complete({ code, nonce: request.nonce, redirectUri: endpoint(`/callback/${method}`) });
    } catch (error) {
      deps.log({ event: "signin.link_error", method, error: errorName(error) });
      return page(503, "Sign-in is unavailable", ["Nothing was added. Try again in a moment."]);
    }
    if (!result.ok) {
      deps.log({ event: "signin.refused", method, reason: result.reason });
      return page(403, "Sign-in was refused", [result.reason, again]);
    }
    const identity = result.identity;
    let session: SessionRecord;
    try {
      session = await store.freshSessionFor({ developerId, sessionId: request.linkSessionId });
    } catch (error) {
      if (!isCode(error, "REAUTH_REQUIRED")) throw error;
      deps.log({ event: "signin.identity_link_needs_fresh_sign_in", developerId, provider: method });
      return page(403, "Sign in again first", [`Your last sign-in is too old to change your sign-in methods, so nothing was added. ${again} If it asks, sign in again first.`]);
    }
    try {
      await store.relinkIdentity({
        identityKey: ownerKeyForSubject(identity.issuer, identity.subject), developerId, provider: method, issuer: identity.issuer, subject: identity.subject,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        ...(identity.login === undefined ? {} : { login: identity.login }),
        by: { method: session.amr },
      });
    } catch (error) {
      if (!isCode(error, "CONFIG_INVALID")) throw error;
      deps.log({ event: "signin.identity_relink_refused", developerId, provider: method });
      return page(403, "That sign-in was not added", [capitalized(refusalWords(error)), "Nothing was changed."]);
    }
    deps.log({ event: "signin.identity_relinked", developerId, provider: method });
    // The same notice as for any new method: if the person did not do this, they can remove it at once. The method is already added, so
    // nothing here may turn the page into an error: the account's address is read twice, then the sign-in's own verified one is used.
    await noticeNewMethod(method, identity, await accountEmail(developerId));
    return page(200, "Sign-in method added back", [`${methodLabel(method)} can sign in to your Rovara account again.`, "You can close this tab and go back to your terminal."]);
  }

  /** The developer record's address; a read that fails twice answers nothing (the notice then goes to the sign-in's own verified address). */
  async function accountEmail(developerId: string): Promise<string | undefined> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return (await store.getDeveloper(developerId))?.email;
      } catch (error) {
        deps.log({ event: "signin.identity_link_account_read_failed", attempt, error: errorName(error) });
      }
    }
    return undefined;
  }

  /** An ISO time for a sign-in whose provider may say it happened earlier (`auth_time`, in seconds). Never later than now. */
  function signInTime(providerAuthTime: number | undefined): string {
    const now = deps.now();
    return new Date(providerAuthTime === undefined ? now : Math.min(now, Math.round(providerAuthTime * 1000))).toISOString();
  }

  /**
   * Emails the account's address that `method` can now sign in to it (Plan 2, Task 8): the developer record's address, else this
   * sign-in's own verified one (the link was made by that address). A send that fails is logged by provider and error name, never by
   * address, and never fails the sign-in.
   */
  async function noticeNewMethod(method: DeveloperSignInMethod, identity: { email?: string; login?: string }, accountEmail: string | undefined): Promise<void> {
    const to = accountEmail ?? identity.email;
    if (to === undefined) {
      deps.log({ event: "signin.identity_link_notice_skipped", provider: method, reason: "no_address" });
      return;
    }
    try {
      await sendIdentityLinkedNotice(
        { ses: deps.notice?.ses, from: deps.notice?.from, log: deps.log },
        { to, provider: method, cellUrl: deps.notice?.cellUrl ?? new URL(config.issuer).origin, ...(identity.login === undefined ? {} : { login: identity.login }) },
      );
    } catch (error) {
      deps.log({ event: "signin.identity_link_notice_failed", provider: method, error: errorName(error) });
    }
  }

  /** A trial org opens when a GitHub account connects (unlockTrial is a no-op for any other plan or an already open org); a failure never fails the sign-in. */
  async function unlockTrialBestEffort(orgId: OrgId, githubUserId: string, developerId: string): Promise<void> {
    try {
      await deps.onGithubSignIn!({ orgId, githubUserId, developerId });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // Only the error's code or name is logged, never its message.
      if (code === "TRIAL_GITHUB_USED") deps.log({ event: "signin.trial_unlock_skipped", reason: code, orgId });
      else deps.log({ event: "signin.trial_unlock_failed", orgId, error: errorName(error) });
    }
  }

  async function authorizationCodeGrant(form: URLSearchParams, methods: DeveloperSignInMethod[]): Promise<HttpResult> {
    const redeemed = await store.redeemCode({ code: form.get("code") ?? "", verifier: form.get("code_verifier") ?? "", redirectUri: form.get("redirect_uri") ?? "" });
    if (redeemed === undefined) return oauthError(400, ...INVALID_CODE);
    if (!methods.includes(redeemed.amr)) return oauthError(400, "invalid_grant", `${methodLabel(redeemed.amr)} sign-in was turned off in this environment; run agentx login again`);
    const developer = await store.getDeveloper(redeemed.developerId);
    if (developer === undefined || developer.revoked) return oauthError(400, "invalid_grant", "your AgentX sign-in was turned off by an admin; contact an admin");
    // A code issued just before the person unlinked its identity must not start a session afterwards.
    if (redeemed.identityKey !== undefined && !await store.identityBelongsTo(redeemed.identityKey, redeemed.developerId)) return oauthError(400, ...SIGN_IN_ENDED);
    // A SAML code made from an assertion that is older than the settings' cutoff (the certificate was rotated, or SAML turned off, after the person authenticated) starts no session.
    if (redeemed.amr === "saml") {
      let validFrom = Number.MAX_SAFE_INTEGER;
      try {
        validFrom = deps.saml === undefined ? validFrom : await deps.saml.sessionsValidFrom();
      } catch (error) {
        deps.log({ event: "signin.saml_config_unreadable", error: errorName(error) });
      }
      if (samlSessionEnded({ startedAt: new Date(deps.now()).toISOString(), ...(redeemed.authTime === undefined ? {} : { authTime: redeemed.authTime }) }, validFrom)) {
        return oauthError(400, "invalid_grant", "your sign-in ended when SAML single sign-on was changed; sign in again with agentx login");
      }
    }
    // The edition's sign-in cap (Enterprise foundations I1) rides on the code: the session ends then, and a refresh never moves it.
    const { sessionEndsAt, ...started } = redeemed;
    if (sessionEndsAt !== undefined && sessionEndsAt <= Math.floor(deps.now() / 1000)) return oauthError(400, ...SIGN_IN_ENDED);
    const { session, refreshToken } = await store.createSession({ ...started, ...(sessionEndsAt === undefined ? {} : { endsAt: sessionEndsAt }) });
    deps.log({ event: "signin.session_started", method: redeemed.amr, developerId: redeemed.developerId, sessionId: session.sessionId });
    const access = await accessToken(session);
    if (access === undefined) {
      await revoke(session.sessionId, "no_org");
      return oauthError(400, "invalid_grant", "your AgentX sign-in belongs to no organization; run agentx login again");
    }
    return tokens(access, refreshToken);
  }

  async function refreshTokenGrant(form: URLSearchParams, methods: DeveloperSignInMethod[]): Promise<HttpResult> {
    const lookup = await store.lookupRefresh(form.get("refresh_token") ?? "");
    const ended = oauthError(400, ...SIGN_IN_ENDED);
    if (lookup.kind === "unknown" || lookup.kind === "ended") return ended;
    if (lookup.kind === "reused") {
      await revoke(lookup.sessionId, "refresh_token_reused");
      return ended;
    }
    // "active", or "recently_rotated": the same token presented again inside the grace window.
    const { session } = lookup;
    // The edition's session cap holds for every session, old ones included.
    if (!sessionWithinEditionCap(deps.editionPolicy, session.startedAt, deps.now())) {
      await revoke(session.sessionId, "session_cap");
      return ended;
    }
    if (!methods.includes(session.amr)) {
      await revoke(session.sessionId, "method_disabled");
      return oauthError(400, "invalid_grant", `${methodLabel(session.amr)} sign-in was turned off in this environment; sign in another way with agentx login`);
    }
    if (startedBeforeMethodOn(session.startedAt, session.amr === "slack" ? config.slack.since : session.amr === "oidc" ? config.oidc?.since : undefined)) {
      await revoke(session.sessionId, "method_disabled");
      return oauthError(400, "invalid_grant", `your sign-in ended when ${methodLabel(session.amr)} was turned off; sign in again with agentx login`);
    }
    // SAML is switched off, or its certificate rotated, by the saved settings, not by the environment: their cutoff ends the sessions that started before it (review S3).
    if (session.amr === "saml") {
      let validFrom = Number.MAX_SAFE_INTEGER;
      try {
        validFrom = deps.saml === undefined ? validFrom : await deps.saml.sessionsValidFrom();
      } catch (error) {
        deps.log({ event: "signin.saml_config_unreadable", error: errorName(error) });
      }
      if (samlSessionEnded(session, validFrom)) {
        await revoke(session.sessionId, "method_disabled");
        return oauthError(400, "invalid_grant", "your sign-in ended when SAML single sign-on was changed; sign in again with agentx login");
      }
    }
    const developer = await store.getDeveloper(session.developerId);
    if (developer === undefined || developer.revoked) {
      await revoke(session.sessionId, "developer_revoked");
      return ended;
    }
    if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
      await revoke(session.sessionId, "ended_by_admin");
      return oauthError(400, "invalid_grant", "an AgentX admin ended your sign-in; sign in again with agentx login");
    }
    if (endedByUnlink(session, developer)) {
      await revoke(session.sessionId, "identity_unlinked");
      return oauthError(400, "invalid_grant", "this sign-in method was removed from your account; sign in again with agentx login");
    }
    if (session.amr === "slack" && session.slackUserId !== undefined) {
      const status = await deps.directory.userStatus(session.slackUserId);
      if (status === "unavailable") return oauthError(503, "temporarily_unavailable", "Slack could not be reached to check your account; your sign-in is kept, try again in a few minutes");
      if (status === "gone") {
        await revoke(session.sessionId, "slack_user_inactive");
        return oauthError(400, "invalid_grant", "your Slack account is no longer active in this workspace; contact an admin");
      }
    }
    // Signed before the rotation: a signing failure then leaves the presented token untouched.
    const access = await accessToken(session);
    if (access === undefined) {
      await revoke(session.sessionId, "no_org");
      return ended;
    }
    const rotated = lookup.kind === "active" ? await store.rotateRefresh(lookup) : await store.rotateRecentlyUsed(lookup);
    if ("reused" in rotated) {
      await revoke(session.sessionId, "refresh_token_reused");
      return ended;
    }
    if ("ended" in rotated) return ended;
    if (lookup.kind === "recently_rotated") deps.log({ event: "signin.refresh_grace", sessionId: session.sessionId });
    return tokens(access, rotated.refreshToken);
  }

  async function token(form: URLSearchParams): Promise<HttpResult> {
    if (form.get("client_id") !== AGENTX_CLI_CLIENT_ID) return oauthError(401, "invalid_client", "unknown client; use the AgentX CLI");
    const methods = enabledMethods(deps);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") return authorizationCodeGrant(form, methods);
    if (grant === "refresh_token") return retryable("token", () => refreshTokenGrant(form, methods));
    return oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  /** A retryable AWS error anywhere in fn answers 503 and changes nothing more; others propagate. */
  async function retryable(operation: string, fn: () => Promise<HttpResult>): Promise<HttpResult> {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableAwsError(error)) throw error;
      deps.log({ event: "signin.retry", operation, error: errorName(error) });
      return oauthError(503, "temporarily_unavailable", "AgentX could not finish this just now; your sign-in is kept, try again in a moment");
    }
  }

  /** RFC 7009. A public client, so no client authentication; a known refresh token ends its session. */
  async function revokeToken(form: URLSearchParams): Promise<HttpResult> {
    const clientId = form.get("client_id");
    if (clientId !== null && clientId !== AGENTX_CLI_CLIENT_ID) return oauthError(401, "invalid_client", "unknown client; use the AgentX CLI");
    const presented = form.get("token");
    if (presented === null || presented === "") return oauthError(400, "invalid_request", "token is required");
    return retryable("revoke", async () => {
      const lookup = await store.lookupRefresh(presented);
      if (lookup.kind === "active" || lookup.kind === "recently_rotated") await revoke(lookup.session.sessionId, "signed_out");
      if (lookup.kind === "reused") await revoke(lookup.sessionId, "signed_out");
      return jsonResult(200, {});
    });
  }

  const configuration = async () => {
    const methods = await availableMethods();
    return {
      env: config.env,
      apiVersion: DEVELOPER_API_VERSION,
      adminApiVersion: ADMIN_API_VERSION,
      issuer: config.issuer,
      authorizationEndpoint: endpoint("/authorize"),
      tokenEndpoint: endpoint("/token"),
      revocationEndpoint: endpoint("/revoke"),
      clientId: AGENTX_CLI_CLIENT_ID,
      methods: {
        slack: methods.includes("slack"),
        oidc: methods.includes("oidc") && config.oidc !== undefined ? { displayName: config.oidc.displayName } : null,
        // Absent (not null) until an administrator has turned SAML on, so the document of an install without it reads as it always did.
        ...(methods.includes("saml") ? { saml: { displayName: methodLabel("saml") } } : {}),
        cloud: methods.includes("cloud") && config.cloud !== undefined ? { displayName: config.cloud.displayName } : null,
        github: methods.includes("github") && config.github !== undefined ? { displayName: config.github.displayName } : null,
      },
      // FR-041, E16: the methods this environment allows; the MCP server adds the client's and the admin's own.
      // Slack needs the team set up, not Slack sign-in (controller ruling R5): each change checks the admin's own link.
      confirm: { elicitation: config.confirmElicitation !== false, slack: config.slack.teamId !== undefined } satisfies AgentXConfigurationConfirm,
    };
  };

  const discovery = () => ({
    issuer: config.issuer, authorization_endpoint: endpoint("/authorize"), token_endpoint: endpoint("/token"), revocation_endpoint: endpoint("/revoke"),
    jwks_uri: endpoint("/.well-known/jwks.json"), response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
    subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], scopes_supported: ["openid"],
  });

  async function browserSignOut(headers: Record<string, string | undefined>): Promise<HttpResult> {
    const sessionId = cookieValue(headers.cookie, REVIEW_SESSION_COOKIE);
    const refused = () => jsonResult(403, { error: "request_refused" });
    const ended = (): HttpResult => ({ statusCode: 204, headers: { "cache-control": "no-store" }, body: "", cookies: [`${REVIEW_SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`] });
    if (headers.origin !== new URL(config.issuer).origin) return refused();
    if (sessionId === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return refused();
    const session = await store.getSession(sessionId);
    const now = Math.floor(deps.now() / 1000);
    if (session === undefined || session.revokedAt !== undefined || session.endsAt <= now || session.reviewExpiresAt === undefined || session.reviewExpiresAt <= now) return ended();
    if (!appCsrfMatches(sessionId, headers[APP_CSRF_HEADER])) return refused();
    // Revoke in DeveloperIdentity, which already owns this grant. Never log the cookie or its session id.
    await store.revokeSession(sessionId, "browser_sign_out");
    deps.log({ event: "signin.browser_signed_out" });
    return ended();
  }

  async function route(method: string, pathname: string, url: URL, body: string | undefined, headers: Record<string, string | undefined>, sourceIp?: string): Promise<HttpResult> {
    if (method === "GET") {
      switch (pathname) {
        case "/v1/auth/.well-known/openid-configuration":
          return publicJson(discovery());
        case "/v1/auth/.well-known/jwks.json":
          return publicJson({ keys: [await deps.signer.publicJwk()] });
        case "/v1/auth/.well-known/agentx-configuration":
          return jsonResult(200, await configuration());
        case "/v1/auth/authorize":
          return authorize(url.searchParams);
        case "/v1/auth/browser/authorize":
          return authorizeBrowser(url.searchParams);
        case "/v1/auth/join":
          return joinPage(url.searchParams, headers);
        case "/v1/auth/join/start":
          return joinStart(url.searchParams);
        case "/v1/auth/join/done":
          return joinDone(url.searchParams, headers);
        case "/v1/auth/decide/identify":
          return decideFlow === undefined ? jsonResult(404, { error: "not_found" }) : decideFlow.identify(url.searchParams);
        case "/v1/auth/decide/start":
          return decideFlow === undefined ? jsonResult(404, { error: "not_found" }) : decideFlow.start(url.searchParams);
        case "/v1/auth/callback/slack":
          return callback("slack", url.searchParams, headers);
        case "/v1/auth/callback/oidc":
          return callback("oidc", url.searchParams, headers);
        case "/v1/auth/callback/cloud":
          return callback("cloud", url.searchParams, headers);
        case "/v1/auth/callback/github":
          return callback("github", url.searchParams, headers);
        case "/v1/auth/callback/saml":
          return deps.saml === undefined ? jsonResult(404, { error: "not_found" }) : callback("saml", url.searchParams, headers);
        case "/v1/auth/saml/metadata":
          return samlMetadata();
      }
    }
    if (method === "POST" && pathname === "/v1/auth/callback/saml") return samlPost(body);
    if (method === "POST" && pathname === "/v1/auth/join/start") return joinStartForm(body, headers, sourceIp);
    if (method === "POST" && pathname === "/v1/auth/browser/sign-out") return browserSignOut(headers);
    if (method === "POST" && pathname === "/v1/auth/token") return token(new URLSearchParams(body ?? ""));
    if (method === "POST" && pathname === "/v1/auth/revoke") return revokeToken(new URLSearchParams(body ?? ""));
    return jsonResult(404, { error: "not_found" });
  }

  /**
   * Plan 2, Task 8: unlinks one method from the caller's own developer, which the broker names from its verified token. The refusals
   * are the store's fixed words; nothing else about the account leaves this function.
   */
  async function unlinkIdentity(event: unknown): Promise<UnlinkIdentityResponse> {
    const parsed = UnlinkIdentityRequestSchema.safeParse(event);
    if (!parsed.success) return { ok: false, error: "invalid_request" };
    const { developerId, sessionId, provider } = parsed.data;
    try {
      await store.unlinkIdentity({ developerId, sessionId, provider });
    } catch (error) {
      if (isCode(error, "NOT_FOUND")) return { ok: false, error: "not_found" };
      if (isCode(error, "REAUTH_REQUIRED")) {
        deps.log({ event: "signin.identity_unlink_needs_fresh_sign_in", developerId, provider });
        return { ok: false, error: "reauth", message: refusalWords(error) };
      }
      if (isCode(error, "CONFIG_INVALID")) {
        deps.log({ event: "signin.identity_unlink_refused", developerId, provider });
        return { ok: false, error: "refused", message: refusalWords(error) };
      }
      throw error;
    }
    deps.log({ event: "signin.identity_unlinked", developerId, provider });
    // The member's GitHub account is no longer theirs to approve with (best effort: the approval check reads the link again).
    if (provider === "github" && deps.onGithubUnlinked !== undefined) {
      try {
        const org = await deps.orgs.orgForDeveloper(developerId);
        if (org !== undefined) await deps.onGithubUnlinked({ orgId: org.orgId, developerId });
      } catch (error) {
        deps.log({ event: "signin.github_member_unlink_failed", developerId, error: errorName(error) });
      }
    }
    return { ok: true };
  }

  /**
   * Plan 2, Task 8b: starts adding a removed sign-in method back to the caller's own developer, whom and whose session the broker names from
   * its verified token. The caller's session must be fresh now (and is checked again when the person finishes at the provider). The
   * answer is the sign-in link to open; the request it makes can link only to this developer, and only the one method.
   */
  async function startIdentityLink(event: unknown): Promise<StartIdentityLinkResponse> {
    const parsed = StartIdentityLinkRequestSchema.safeParse(event);
    if (!parsed.success) return { ok: false, error: "invalid_request" };
    const { developerId, sessionId, provider: method } = parsed.data;
    try {
      await store.freshSessionFor({ developerId, sessionId });
    } catch (error) {
      if (!isCode(error, "REAUTH_REQUIRED")) throw error;
      deps.log({ event: "signin.identity_link_needs_fresh_sign_in", developerId, provider: method });
      return { ok: false, error: "reauth", message: refusalWords(error) };
    }
    if (!enabledMethods(deps).includes(method)) return { ok: false, error: "refused", message: "that sign-in method is not available here" };
    // The Slack link is made only from the web app: the callback has to prove the browser holds the session that started it.
    if (method === "slack") {
      if (parsed.data.browser !== true) return { ok: false, error: "refused", message: "link your Slack account from the Rovara web app" };
      if ((await store.slackUserIdsOf(developerId)).length > 0) return { ok: false, error: "refused", message: SLACK_LINK_HAS_ONE };
      // UX1: nothing to link to until a Slack workspace is connected to the company; say so before sending the person to Slack.
      const own = await deps.orgs.orgForDeveloper(developerId);
      if (own === undefined || !await deps.orgs.hasSlackTeam(own.orgId)) return { ok: false, error: "refused", message: SLACK_NO_WORKSPACE_MESSAGE };
    }
    // UX1: a GitHub account linked from the web app (any sign-in method), finished in the browser that holds this session, for this account only.
    const browserGithub = method === "github" && parsed.data.browser === true;
    if (browserGithub && (await store.identitiesOf(developerId)).some((identity) => identity.provider === "github")) {
      return { ok: false, error: "refused", message: GITHUB_LINK_HAS_ONE };
    }
    const request = await store.createAuthRequest({
      clientRedirectUri: endpoint("/link/done"), clientState: randomBytes(24).toString("base64url"), codeChallenge: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"), linkDeveloperId: developerId, linkSessionId: sessionId, linkMethod: method,
      ...(method === "slack" || browserGithub ? { linkBrowser: true as const } : {}),
      ...(browserGithub ? { linkReturnTo: parsed.data.returnTo ?? "/app" } : {}),
    });
    if (await store.chooseMethod(request.id, method) === undefined) return { ok: false, error: "unavailable" };
    deps.log({ event: "signin.identity_link_started", developerId, provider: method });
    return { ok: true, authorizeUrl: `${endpoint("/authorize")}?request=${encodeURIComponent(request.id)}&method=${method}` };
  }

  const isPage = (pathname: string) => pathname === "/v1/auth/authorize" || pathname === "/v1/auth/browser/authorize" || pathname.startsWith("/v1/auth/callback/") || pathname.startsWith("/v1/auth/join") || pathname.startsWith("/v1/auth/decide/");

  return async (
    event: HttpApiV2Event | ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | TaskPeopleDisplayReadRequest | ChannelInfoRequest | ChannelClassRequest | ChannelListRequest | MemberChannelsRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | EraseDeveloperNameRequest | UnlinkIdentityRequest | StartIdentityLinkRequest | ChannelByNameRequest | RealtimeTokenRequest,
  ): Promise<HttpResult | ChannelMembersResult | TaskPersonProofResponse | TaskChannelPeopleResponse | TaskPeopleDisplayReadResponse | ChannelInfoResponse | ChannelClassResponse | ChannelListResponse | SlackUserByEmailResponse | SlackAuthCheckResponse | EndDeveloperSessionsResponse | EraseDeveloperNameResponse | UnlinkIdentityResponse | StartIdentityLinkResponse | ChannelByNameResponse | RealtimeTokenAnswer> => {
    if ("kind" in event) {
      if (event.kind === "end-developer-sessions") {
        const parsed = EndDeveloperSessionsRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const result = await store.endSessions(parsed.data.developerId, parsed.data.at);
        deps.log({ event: "signin.sessions_ended_by_admin", developerId: parsed.data.developerId, result });
        return result === "ended" ? { ok: true } : { ok: false, error: "not_found" };
      }
      if (event.kind === "erase-developer-name") {
        // ERASE-NAME-1: a person's erase clears the name this record holds. Nothing but the id and the result is logged.
        const parsed = EraseDeveloperNameRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const result = await store.eraseDisplayName(parsed.data.developerId, parsed.data.at);
        deps.log({ event: "signin.name_erased", developerId: parsed.data.developerId, result });
        return result === "erased" ? { ok: true } : { ok: false, error: "not_found" };
      }
      if (event.kind === "realtime-token") {
        // Plan 5 Task 8: the broker holds no signing right, so it asks here for the token of a person it has already signed in.
        const parsed = RealtimeTokenRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        try {
          return { ok: true, ...await issueRealtimeToken(deps.signer, { orgId: parsed.data.orgId, developerId: parsed.data.developerId, projects: parsed.data.projects, now: deps.now() }) };
        } catch (error) {
          deps.log({ event: "signin.realtime_token_failed", error: error instanceof Error ? error.name : "unknown" });
          return { ok: false, error: "unavailable" };
        }
      }
      if (event.kind === "unlink-identity") return unlinkIdentity(event);
      if (event.kind === "start-identity-link") return startIdentityLink(event);
      if (event.kind === "channel-by-name") {
        const parsed = ChannelByNameRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelByName(parsed.data.name);
      }
      if (event.kind === "slack-user-by-email") {
        const parsed = SlackUserByEmailRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const found = await deps.directory.lookupByEmail(parsed.data.email);
        if (found === "unavailable") return { ok: false, error: "slack_unavailable" };
        return found === "none" ? { ok: true } : { ok: true, userId: found.userId };
      }
      if (event.kind === "slack-auth-check") {
        if (!SlackAuthCheckRequestSchema.safeParse(event).success) return { ok: false, error: "invalid_request" };
        return deps.directory.authTest();
      }
      if (event.kind === "channel-info") {
        const parsed = ChannelInfoRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelInfo(parsed.data.channelIds);
      }
      if (event.kind === "channel-class") {
        const parsed = ChannelClassRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelClass(parsed.data.teamId, parsed.data.channelId);
      }
      if (event.kind === "channel-list") {
        const parsed = ChannelListRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelList(parsed.data.teamId, parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor });
      }
      if (event.kind === "member-channels") {
        const parsed = MemberChannelsRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.memberChannels(parsed.data.teamId, parsed.data.userId, parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor });
      }
      if (event.kind === "task-person-proof") {
        const parsed = TaskPersonProofRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.taskPersonProof(parsed.data.slackUserId, parsed.data.channelIds);
      }
      if (event.kind === "task-channel-people") {
        const parsed = TaskChannelPeopleRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.taskChannelPeople(parsed.data.channelIds);
      }
      if (event.kind === "task-people-display-read") {
        const parsed = TaskPeopleDisplayReadRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.taskPeopleDisplayRead({
          ...parsed.data,
          admission: { ...parsed.data.admission, deadlineAt: Math.min(parsed.data.admission.deadlineAt, deps.now() + 20_000) },
        });
      }
      const parsed = ChannelMembersRequestSchema.safeParse(event);
      if (!parsed.success) return { ok: false, error: "invalid_request" };
      return deps.directory.channelMembers(parsed.data.slackUserId, parsed.data.channelIds);
    }
    const request = adaptHttpApiEvent(event);
    const url = new URL(request.path, "https://agentx.invalid");
    try {
      const response = await route(request.method, url.pathname, url, request.body, request.headers, event.requestContext?.http?.sourceIp);
      return url.pathname.startsWith("/v1/auth/decide/") ? withDecideIsolation(response) : response;
    } catch (error) {
      // Only the error's name: a KMS or AWS message can carry a key ARN or other detail.
      deps.log({ event: "signin.error", path: url.pathname, error: errorName(error) });
      const response = isPage(url.pathname)
        ? page(500, "Sign-in failed", ["Something went wrong on the AgentX server. Run agentx login again."])
        : oauthError(500, "server_error", "sign-in failed on the server; try again");
      return url.pathname.startsWith("/v1/auth/decide/") ? withDecideIsolation(response) : response;
    }
  };
}
