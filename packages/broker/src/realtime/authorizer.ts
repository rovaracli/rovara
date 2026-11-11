// The events API's Lambda authorizer (Plan 5 Task 8). AppSync Events calls it to connect and to subscribe; publishing is IAM-only and is refused here whatever the
// token says. Connecting needs a good realtime token (token.ts). Subscribing needs a channel this module made (no `*`, no segment outside its shape), in the token's own
// org, and: a user channel only for the token's own person; a project channel only for a segment in the token's list (or, for a token that carries `"lookup"`, a
// project the person has a role on now, read from the catalog and their grant); a session channel only when the person's level on the session, read live on the
// read-only path (no Slack call), is at least `view`. Every answer carries `ttlOverride: 0`, so nothing is cached.
//
// Stated limit: a subscription that already exists outlives a share or membership removal until the client reconnects (at most the token's lifetime for a client that
// reconnects with a new token, at most 24 hours for a connection). A notice carries ids only, and every detail read is checked again.
//
// Accepted limit (Task 8 review): the token's own facts are not checked live, except that the person is still a member of the company (member removal, v1.1: read on connect and on
// every subscribe). The project list in the token is read once, when the token is made, and the authorizer does not look at it again: a person removed from a project can still
// subscribe to that project's channel for as long as their token lives (`REALTIME_TOKEN_SECONDS`, 900 s), and the removal reaches them when they next ask for a token. A subscription
// that already exists outlives a removal until its connection ends. This is acceptable because a notice carries ids only
// (never a title, text, name or cost), and every read of the session behind an id is checked live. A session channel is the exception: its level is read live on each subscribe.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { orgMemberKey, parseRealtimeChannel, projectSegment, userSegment, type RealtimeTokenClaims } from "@agentx/cloud-contracts";
import { orgProjectCatalogPk, projectMemberKey } from "@rovara-code/contracts";
import { NO_SLACK_PROJECT_MEMBERS, resolveSessionAccess, type SessionAccessDependencies } from "../agent-sessions/access.js";
import { grantRoleOf } from "../developer/project-roles.js";
import { kmsTokenSigner, type PublicSigningJwk } from "../developer/tokens.js";
import { verifyRealtimeToken } from "./token.js";

/** What AppSync Events sends a Lambda authorizer. `channel` is null on connect. */
export interface RealtimeAuthorizerEvent {
  authorizationToken?: string | undefined;
  requestContext?: { operation?: string | undefined; channel?: string | null | undefined } | undefined;
}

export interface RealtimeAuthorization { isAuthorized: boolean; ttlOverride: 0 }

export interface AuthorizerDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** The developer token key's public half. */
  publicKey: () => Promise<PublicSigningJwk>;
  /** Plan 4's readers of a chain run; without it a chain session is open only to its owner and its shares. */
  chainReadAccess?: SessionAccessDependencies["chainReadAccess"];
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

type Item = Record<string, unknown>;
const ALLOW: RealtimeAuthorization = { isAuthorized: true, ttlOverride: 0 };
const DENY: RealtimeAuthorization = { isAuthorized: false, ttlOverride: 0 };
const ADMIN_ROLES = new Set(["owner", "admin"]);

const get = async (deps: AuthorizerDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** Whether the person has a role on the project whose segment this is: found in the org's catalog, then an admin's role or their own grant. */
async function lookupProjectRole(deps: AuthorizerDependencies, claims: RealtimeTokenClaims, segment: string): Promise<boolean> {
  const orgId = claims.org;
  const member = await get(deps, orgMemberKey(orgId, claims.sub));
  if (member === undefined) return false;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": orgProjectCatalogPk(orgId), ":prefix": "PROJECT#" },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const name = typeof item["sk"] === "string" ? item["sk"].slice("PROJECT#".length) : "";
      if (projectSegment(orgId, name) !== segment) continue;
      return ADMIN_ROLES.has(String(member["role"])) || grantRoleOf(await get(deps, projectMemberKey(orgId, claims.sub, name))) !== undefined;
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return false;
}

/** `authorizeRealtime(event)`: whether this connect or subscribe is allowed. Never throws: a fault refuses and logs its error's name. */
export async function authorizeRealtime(event: RealtimeAuthorizerEvent, deps: AuthorizerDependencies): Promise<RealtimeAuthorization> {
  const log = deps.log ?? ((line) => console.log(JSON.stringify({ component: "realtime-authorizer", ...line })));
  const refuse = (reason: string): RealtimeAuthorization => {
    log({ event: "realtime.refused", operation: event.requestContext?.operation, reason });
    return DENY;
  };
  try {
    const operation = event.requestContext?.operation;
    if (operation !== "EVENT_CONNECT" && operation !== "EVENT_SUBSCRIBE") return refuse("operation");
    const claims = await verifyRealtimeToken(deps.publicKey, event.authorizationToken, deps.now());
    if (claims === undefined) return refuse("token");
    // The person is read live, on connect and on every subscribe: a token (900 s) and a connection (up to 24 h) of someone removed from the company open nothing new. The rest of the
    // token is not checked live (see the accepted limit above). A member who rejoined passes, and carries only ids; every read behind an id is checked against the live session.
    if (await get(deps, orgMemberKey(claims.org, claims.sub)) === undefined) return refuse("member");
    if (operation === "EVENT_CONNECT") return ALLOW;
    const channel = event.requestContext?.channel;
    const parsed = typeof channel === "string" ? parseRealtimeChannel(channel) : undefined;
    if (parsed === undefined) return refuse("channel");
    if (`org_${parsed.orgBody}` !== claims.org) return refuse("org");
    if (parsed.kind === "user") return parsed.segment === userSegment(claims.sub) ? ALLOW : refuse("user");
    if (parsed.kind === "project") {
      if (Array.isArray(claims.projects)) return claims.projects.includes(parsed.segment) ? ALLOW : refuse("project");
      return await lookupProjectRole(deps, claims, parsed.segment) ? ALLOW : refuse("project");
    }
    const sessionId = `${parsed.segment.startsWith("c-") ? "crn" : "ses"}_${parsed.segment.slice(2)}`;
    const access: SessionAccessDependencies = {
      documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, projectMembers: NO_SLACK_PROJECT_MEMBERS,
      ...(deps.chainReadAccess === undefined ? {} : { chainReadAccess: deps.chainReadAccess }),
    };
    try {
      await resolveSessionAccess(access, { orgId: claims.org, developerId: claims.sub }, sessionId, { readOnlyPath: true });
    } catch (error) {
      if (error instanceof Error && error.name === "AgentXError" && (error as { code?: string }).code === "NOT_FOUND") return refuse("session");
      throw error;
    }
    return ALLOW;
  } catch (error) {
    return refuse(error instanceof Error ? error.name : "unknown");
  }
}

let built: AuthorizerDependencies | undefined;

function build(env: Record<string, string | undefined>): AuthorizerDependencies {
  const region = env["AWS_REGION"];
  const need = (name: string) => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${name} is required`);
    return value;
  };
  const config = region === undefined ? {} : { region };
  const signer = kmsTokenSigner({ kms: new KMSClient(config), keyId: need("DEVELOPER_TOKEN_KEY_ARN") });
  return { documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(config)), tableName: need("STATE_TABLE_NAME"), now: Date.now, publicKey: () => signer.publicJwk() };
}

/** The Lambda entry. The key reader is built once, so the public key is fetched once per container. */
export const handler = async (event: RealtimeAuthorizerEvent): Promise<RealtimeAuthorization> => {
  built ??= build(process.env);
  return authorizeRealtime(event, built);
};
