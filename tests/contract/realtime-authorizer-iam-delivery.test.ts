import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionChannel } from "@agentx/cloud-contracts";
import { authorizeRealtime, type AuthorizerDependencies } from "../../packages/broker/src/realtime/authorizer.js";
import { issueRealtimeToken } from "../../packages/broker/src/realtime/token.js";
import type { TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { ORG_A, PRIYA, T0, sessionWorld } from "../support/agent-session-world.js";
import { STATE_TABLE_LOGICAL_ID, attributeLimit, enforceRolePolicy, list, roleStatementsOf, statementsOnTable, type Statement } from "../support/notifier-role-policy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// REALTIME-NAME-IAM (found live on staging, 0.5.15): subscribing to a session channel makes the authorizer resolve the session owner's name (resolveSessionAccess to resolveStoredName to replacementNames), which
// reads the DEVELOPER_NAME# rows with ONE BatchGetItem, and the authorizer's role held GetItem and Query on the State table only. DynamoDB refused it, replacementNames (which never throws) logged
// `name_resolver_unavailable where=name_items error=AccessDeniedException` and the owner read "A member". Six times between 20:45Z and the report. This runs the real authorizer code against the authorizer
// role's REAL synthesized State-table policy.

skipLambdaBundling();

const role = roleStatementsOf("RealtimeAuthorizer74F9F06D");
const statements = statementsOnTable(role, STATE_TABLE_LOGICAL_ID);

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = publicKey.export({ format: "der", type: "spki" });
const kid = createHash("sha256").update(spki).digest("base64url").slice(0, 16);
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" as const, use: "sig" as const } as { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256"; use: "sig" };
const signer: TokenSigner = { publicJwk: async () => jwk, sign: async (input) => sign("sha256", input, privateKey) };

async function subscribeToASession(policy: readonly Statement[]) {
  const w = sessionWorld();
  const denied: string[] = [];
  const session = w.seedSession();
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
  const deps: AuthorizerDependencies = { documentClient: enforceRolePolicy(w.db, policy, denied), tableName: "state", now: () => w.clock.now, publicKey: async () => jwk, log: () => undefined };
  const token = (await issueRealtimeToken(signer, { orgId: ORG_A, developerId: PRIYA, projects: [], now: T0 })).token;
  const answer = await authorizeRealtime({ authorizationToken: token, requestContext: { operation: "EVENT_SUBSCRIBE", channel: sessionChannel(ORG_A, session.sessionId) } }, deps);
  return { answer, denied, logs };
}

describe("the realtime authorizer subscribing to a session channel under its real IAM policy", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("reads the owner's name (one BatchGetItem on DEVELOPER_NAME# keys) without being refused, and logs no name failure", async () => {
    const result = await subscribeToASession(statements);
    expect(result.denied).toEqual([]);
    expect(result.answer).toEqual({ isAuthorized: true, ttlOverride: 0 });
    expect(result.logs.filter((line) => line.includes("name_resolver_unavailable"))).toEqual([]);
  });

  it("without the BatchGetItem statement the same subscribe is refused by IAM on the name read (the staging failure)", async () => {
    const v0515 = statements.filter((statement) => !list(statement.Action).includes("dynamodb:BatchGetItem"));
    expect(v0515.length).toBeLessThan(statements.length);
    const result = await subscribeToASession(v0515);
    expect(result.denied.length).toBeGreaterThan(0);
    expect(result.denied.every((entry) => entry.startsWith("BatchGetItem DEVELOPER_NAME#"))).toBe(true);
    expect(result.logs.some((line) => line.includes("name_resolver_unavailable") && line.includes("AccessDeniedException"))).toBe(true);
  });

  it("the BatchGetItem grant is for DEVELOPER_NAME# keys only, guarded by Null, and no other action is widened", () => {
    const batch = statements.filter((statement) => list(statement.Action).includes("dynamodb:BatchGetItem"));
    expect(batch).toHaveLength(1);
    expect(list(batch[0]!.Action)).toEqual(["dynamodb:BatchGetItem"]);
    expect(batch[0]!.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER_NAME#*"] }, Null: { "dynamodb:LeadingKeys": "false" } });
    expect(attributeLimit(batch[0]!)).toBeUndefined();
    const others = statements.filter((statement) => statement !== batch[0]).flatMap((statement) => list(statement.Action));
    expect(others.sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
  });
});
