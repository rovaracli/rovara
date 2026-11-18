// L4-EVC: the fake Rovara Code serves the setup flow's eval card (read, one approval, a decision, the opt-in health check) with Code's rules in small: a manager acts, a reader reads, the dollars an approval
// echoes must be the ones the read showed, and each answer is dollars-only. Browser specs stage it through /__fake/eval-card.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalCardViewSchema, EvalApproveReplySchema, EvalDecideReplySchema, EvalHealthReplySchema } from "../../packages/contracts/src/setup-agent-web.js";
import { PRIYA, SAM, startFakeCode, type FakeCode } from "../support/fake-code.js";

let fake: FakeCode;
beforeAll(async () => { fake = await startFakeCode(); });
afterAll(async () => { await fake.close(); });

async function tokenFor(person: typeof PRIYA): Promise<string> {
  fake.setPerson(person);
  const verifier = randomBytes(32).toString("base64url"), redirect = "http://127.0.0.1:8787/callback";
  const authorize = new URL(`${fake.url}/v1/auth/authorize`);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: "rovara-cloud", redirect_uri: redirect, state: "s1", scope: "projects:members", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location") ?? "");
  const token = await fetch(`${fake.url}/v1/auth/token`, {
    method: "POST", headers: { authorization: `Basic ${Buffer.from("rovara-cloud:fake-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", code_verifier: verifier, redirect_uri: redirect }),
  });
  return ((await token.json()) as { access_token: string }).access_token;
}
const call = async (path: string, token: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${fake.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
};
const stage = (state: string, health?: string) => fetch(`${fake.url}/__fake/eval-card`, { method: "POST", body: JSON.stringify({ project: "web", state, ...(health === undefined ? {} : { health }) }) });
const BASE = "/v1/app/projects/web/setup-agent";

describe("the fake eval card", () => {
  it("reads in the app's schema; a manager approves with the dollars the read showed, a different figure is refused, a reader cannot act", async () => {
    const priya = await tokenFor(PRIYA);
    await stage("propose");
    const read = await call(`${BASE}/eval`, priya);
    const card = EvalCardViewSchema.parse(read.body);
    expect(card).toMatchObject({ state: "propose", canApprove: true });
    const suite = card.suites[0]!;
    const body = { taskId: card.report!.taskId, reportDigest: card.report!.reportDigest, selection: suite.selection, paths: suite.files, approve: true, seen: suite.seen };
    const sam = await tokenFor(SAM);
    expect(EvalCardViewSchema.parse((await call(`${BASE}/eval`, sam)).body).canApprove).toBe(false);
    expect((await call(`${BASE}/eval-approve`, sam, { method: "POST", body })).status).toBe(403);
    expect((await call(`${BASE}/eval-approve`, priya, { method: "POST", body: { ...body, seen: { ...suite.seen, perCheckHighMicros: 5 } } })).status).toBe(409);
    const done = await call(`${BASE}/eval-approve`, priya, { method: "POST", body });
    expect(done.status).toBe(200);
    expect(EvalApproveReplySchema.parse(done.body)).toMatchObject({ state: "approved" });
    const after = EvalCardViewSchema.parse((await call(`${BASE}/eval`, priya)).body);
    expect(after).toMatchObject({ state: "approved", spend: { perPr: "$0.50-$1.20" }, health: { state: "none" } });
  });

  it("a waiting item is decided with the offer the read carried; the health check is a person's yes and nothing runs without it", async () => {
    const priya = await tokenFor(PRIYA);
    await stage("waiting");
    const waiting = EvalCardViewSchema.parse((await call(`${BASE}/eval`, priya)).body);
    const offer = waiting.spend!.approval!;
    const decided = await call(`${BASE}/eval-decide`, priya, { method: "POST", body: { requestId: offer.requestId, outcome: "approve", seen: { revision: offer.revision, artifactDigest: offer.artifactDigest } } });
    expect(decided.status).toBe(200);
    expect(EvalDecideReplySchema.parse(decided.body)).toMatchObject({ project: "web", decision: "approved" });
    const approved = EvalCardViewSchema.parse((await call(`${BASE}/eval`, priya)).body);
    expect(approved.health).toMatchObject({ state: "none", label: "Check my evals now (about $2.40)" });
    const asked = await call(`${BASE}/eval-health`, priya, { method: "POST", body: { requestId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", seenCostMicros: approved.health!.seenCostMicros } });
    expect(EvalHealthReplySchema.parse(asked.body)).toMatchObject({ requested: true });
    expect(EvalCardViewSchema.parse((await call(`${BASE}/eval`, priya)).body).health?.state).toBe("requested");
  });
});
