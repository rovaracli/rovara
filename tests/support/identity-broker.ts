// Plan 2, Task 8 and 8b: the broker over a copy of the sign-in harness's tables, for the routes that call the sign-in function
// (unlink a sign-in method, add one back). The function is the harness's own, as the Lambda invoke would be.
import type { StartIdentityLinkRequest, UnlinkIdentityRequest } from "@rovara-code/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker } from "./admin-broker.js";
import { ISSUER, type identityHarness } from "./developer-fakes.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";

type Harness = ReturnType<typeof identityHarness>;

export async function brokerCall(
  h: Harness, method: string, path: string, token: string,
  extra: {
    body?: unknown;
    unlinkIdentity?: DeveloperApiConfiguration["unlinkIdentity"] | null;
    startIdentityLink?: DeveloperApiConfiguration["startIdentityLink"] | null;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const broker: { db?: FakeDynamoDb } = {};
  const copied = new Set<string>();
  // The sign-in function writes the harness's table; the broker's copy of it is brought up to date after the invoke, as the one real table is.
  const invoke = async (request: UnlinkIdentityRequest | StartIdentityLinkRequest) => {
    const answer = await h.handler(request) as never;
    for (const [key, item] of [...h.db.items]) if (JSON.stringify(broker.db?.items.get(key)) !== JSON.stringify(item)) broker.db?.set(structuredClone(item));
    for (const key of copied) if (!h.db.items.has(key)) { const [pk, sk] = key.split("\u0000") as [string, string]; broker.db?.delete(pk, sk); }
    return answer;
  };
  const config: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "staging", methods: { slack: true, oidc: true, cloud: true, github: true }, signInTableName: "signin",
    channelMembers: async () => ({ ok: true as const, memberOf: [] }),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await h.signer.publicJwk()], now: () => Date.now() }),
    ...(extra.unlinkIdentity === null ? {} : { unlinkIdentity: extra.unlinkIdentity ?? invoke }),
    ...(extra.startIdentityLink === null ? {} : { startIdentityLink: extra.startIdentityLink ?? invoke }),
  };
  const { db, handler } = await createAdminBroker({ developer: config });
  broker.db = db;
  for (const source of [h.db, h.state]) for (const item of source.items.values()) db.set(structuredClone(item));
  for (const key of h.db.items.keys()) copied.add(key);
  const response = await handler({
    rawPath: path, headers: { authorization: `Bearer ${token}` }, routeKey: "ANY /v1/app/{proxy+}",
    ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
    requestContext: { requestId: "r", http: { method } },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}
