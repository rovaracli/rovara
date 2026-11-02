// Lane cr-settings: the mode writer, `review.otherCompany` (off, shadow, on) for the company and, as an override that can only be stricter, for a project. Through the whole broker with a live browser session, behind `cr`.
// Raising applies at once; `on` only for a model whose evidence holds; LOWERING is a proposal a DIFFERENT admin approves (signed in within 10 minutes), with no sole-owner exception; every change is audited in its own transaction.
import { afterEach, describe, expect, it } from "vitest";
import { secondReviewModelKey } from "../../packages/contracts/src/index.js";
import { SecondReviewStateSchema } from "../../packages/contracts/src/app-second-review.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { seedHoldingEvidence, seedTrackRow, replayRun, verdictFor, BASELINE } from "../support/second-review-evidence.js";
import { secondReviewReplayKey, secondReviewVerdictKey } from "../../packages/broker/src/org/second-review-settings.js";
import { openModeChange, openModeChanges, requestSecondReviewMode, type ModeDeps } from "../../packages/broker/src/org/second-review-mode.js";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { orgMetaKey } from "../../packages/contracts/src/index.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.SECOND_REVIEW_ENABLED; });
const PATH = "/v1/app/org/second-review";
const QUERY = `${PATH}?builder=openai:gpt-5.5`;
const on = () => { process.env.SECOND_REVIEW_ENABLED = "1"; };
async function bench(options: { maya?: "admin" | "member"; grant?: "viewer" | "contributor" | "maintainer" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya, options.grant);
  on();
  return { t, audit };
}
const modeEvents = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => event.action.includes("second_review_mode"));
type Ref = { provider: string; modelId: string };
const view = async (t: Bench, who = OMAR, query = QUERY) => (await t.web(who, "GET", query)).body as {
  modes: { company: string; project: string | null; effective: string }; mode: string; pendingLowering: boolean; pending?: Array<{ changeId: string; scope: string; project?: string; from: string; to: string; proposedByYou: boolean }>;
  models: Array<{ model: Ref }>; evidence: { holds: boolean } | null;
};
const setMode = (t: Bench, who: typeof OMAR, mode: string) => t.web(who, "POST", PATH, { action: "mode", scope: "company", mode });
const setProject = (t: Bench, who: typeof OMAR, mode: string) => t.web(who, "POST", PATH, { action: "mode", scope: "project", project: NAME, mode });
/** A company whose chosen reviewer has evidence that holds, so `on` is reachable. */
async function withEvidence(options: Parameters<typeof bench>[0] = { maya: "admin" }) {
  const made = await bench(options);
  const model = (await view(made.t)).models[0]!.model;
  await made.t.web(OMAR, "POST", PATH, { action: "choose", primary: model });
  seedHoldingEvidence(made.t.db, model);
  return { ...made, model };
}

describe("behind cr", () => {
  it("is not found while cr is off, for any value but exactly 1", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.SECOND_REVIEW_ENABLED; else process.env.SECOND_REVIEW_ENABLED = value;
      expect((await setMode(t, OMAR, "shadow")).status, String(value)).toBe(404);
    }
  });
});

describe("who may set the mode", () => {
  it("is refused from a token and from a member in a browser, and writes and audits nothing", async () => {
    const { t, audit } = await bench({ maya: "member" });
    expect((await t.dev(OMAR, "POST", PATH, { action: "mode", scope: "company", mode: "shadow" })).status).toBe(403);
    expect((await setMode(t, MAYA, "shadow")).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "mode", scope: "company", mode: "loud" })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "mode", scope: "company", mode: "shadow", extra: 1 })).status).toBe(400);
    expect((await view(t)).modes.company).toBe("off");
    expect(modeEvents(audit)).toEqual([]);
  });
});

describe("raising", () => {
  it("applies at once for an admin, is audited, and shows in the settings", async () => {
    const { t, audit } = await bench();
    const reply = await setMode(t, OMAR, "shadow");
    expect(reply).toMatchObject({ status: 200, body: { status: "applied", mode: "shadow" } });
    expect(modeEvents(audit)).toHaveLength(1);
    expect(modeEvents(audit)[0]).toMatchObject({ action: "company.second_review_mode_changed", actor: { id: OMAR.developerId }, facts: { scope: "company", from: "off", to: "shadow", mode: "direct" } });
    expect(await view(t)).toMatchObject({ mode: "shadow", modes: { company: "shadow", project: null, effective: "shadow" } });
  });

  it("the change and its audit record are ONE transaction", async () => {
    const { t } = await bench();
    const sent: Array<{ input?: { TransactItems?: Array<{ Update?: unknown; Put?: { Item?: { pk?: string } } }> } }> = [];
    const original = t.db.send.bind(t.db);
    t.db.send = (async (command: never) => { sent.push(command); return original(command); }) as never;
    expect((await setMode(t, OMAR, "shadow")).status).toBe(200);
    t.db.send = original;
    const write = sent.find((command) => command.input?.TransactItems?.some((item) => item.Update !== undefined));
    expect(write?.input?.TransactItems?.some((item) => item.Put?.Item?.pk?.startsWith("AUDIT_PENDING#"))).toBe(true);
  });

  it("with no audit ledger the change is refused and nothing is stored", async () => {
    const t = await setupWizardBench({});
    on();
    expect((await setMode(t, OMAR, "shadow")).status).toBeGreaterThanOrEqual(400);
    expect((await view(t)).modes.company).toBe("off");
  });

  it("setting the mode it already has changes nothing visible and is not a proposal", async () => {
    const { t } = await bench();
    await setMode(t, OMAR, "shadow");
    expect(await setMode(t, OMAR, "shadow")).toMatchObject({ status: 200, body: { status: "applied" } });
  });
});

describe("`on` needs the evidence for the chosen model", () => {
  it("is refused with nobody having chosen a reviewer, and with a choice that has no verdict; it writes nothing", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    const refused = await setMode(t, OMAR, "on");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("Choose the model first");
    const model = (await view(t)).models[0]!.model;
    await t.web(OMAR, "POST", PATH, { action: "choose", primary: model });
    expect((await setMode(t, OMAR, "on")).status).toBe(403);
    expect((await view(t)).modes.company).toBe("off");
    expect(modeEvents(audit)).toEqual([]);
  });

  it("is refused when the stored evidence does not hold now: a replay run that fails the bar, a withdrawn verdict, a window that is too short, a verdict for another model", async () => {
    const { t, model } = await withEvidence();
    const failing = replayRun(model, { cases: replayRun(model).cases.map((entry) => ({ ...entry, candidateCaught: false })) });
    t.db.set({ ...secondReviewReplayKey(TEST_ORG, "run-1"), entityType: "SECOND_REVIEW_REPLAY", run: failing });
    expect((await setMode(t, OMAR, "on")).status).toBe(403);
    t.db.set({ ...secondReviewReplayKey(TEST_ORG, "run-1"), entityType: "SECOND_REVIEW_REPLAY", run: replayRun(model) });
    const key = secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(model));
    t.db.set({ ...key, entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model, { withdrawnAt: "2026-10-22T00:00:00.000Z", withdrawnBy: "d" }) });
    expect((await setMode(t, OMAR, "on")).status).toBe(403);
    t.db.set({ ...key, entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model, { shadow: { startedAt: "2026-10-02T00:00:00.000Z", endedAt: "2026-10-10T00:00:00.000Z", findings: 10, agreed: 5 } }) });
    expect((await setMode(t, OMAR, "on")).status).toBe(403);
    t.db.set({ ...key, entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model, { model: "openrouter:somebody/else" }) });
    expect((await setMode(t, OMAR, "on")).status).toBe(403);
    expect((await view(t)).modes.company).toBe("off");
  });

  it("is allowed once the verdict holds, and the settings say so", async () => {
    const { t, audit } = await withEvidence();
    expect((await view(t)).evidence).toMatchObject({ holds: true });
    expect(await setMode(t, OMAR, "on")).toMatchObject({ status: 200, body: { status: "applied", mode: "on" } });
    expect(modeEvents(audit).at(-1)).toMatchObject({ facts: { from: "off", to: "on", mode: "direct" } });
  });
});

describe("lowering", () => {
  it("is a proposal that changes nothing; its proposer cannot approve it; a different admin approves it, audited", async () => {
    const { t, audit } = await withEvidence();
    await setMode(t, OMAR, "on");
    const asked = await setMode(t, OMAR, "shadow");
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const changeId = (asked.body as { changeId: string }).changeId;
    expect(await view(t)).toMatchObject({ modes: { company: "on" }, pendingLowering: true, pending: [{ changeId, scope: "company", from: "on", to: "shadow", proposedByYou: true }] });
    const self = await t.web(OMAR, "POST", PATH, { action: "approve-mode", changeId });
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toContain("A different admin has to approve");
    expect((await view(t)).modes.company).toBe("on");
    const approved = await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { status: "applied", mode: "shadow" } });
    expect(await view(t)).toMatchObject({ modes: { company: "shadow" }, pendingLowering: false });
    expect(modeEvents(audit).map((event) => event.action)).toEqual(["company.second_review_mode_changed", "company.second_review_mode_proposed", "company.second_review_mode_changed"]);
    expect(modeEvents(audit).at(-1)).toMatchObject({ actor: { id: MAYA.developerId }, facts: { scope: "company", from: "on", to: "shadow", mode: "second_person" } });
  });

  it("every step down needs a second admin, shadow to off included", async () => {
    const { t } = await bench({ maya: "admin" });
    await setMode(t, OMAR, "shadow");
    const asked = await setMode(t, OMAR, "off");
    expect(asked.status).toBe(202);
    expect((await view(t)).modes.company).toBe("shadow");
  });

  it("needs the approving admin to have signed in within the last 10 minutes; an older sign-in is asked to sign in again and nothing changes", async () => {
    const { t } = await withEvidence();
    await setMode(t, OMAR, "on");
    const changeId = ((await setMode(t, OMAR, "off")).body as { changeId: string }).changeId;
    t.ageSignIn(MAYA, 11);
    const stale = await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId });
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("REAUTH_REQUIRED");
    expect((await view(t)).modes.company).toBe("on");
    t.ageSignIn(MAYA, 9);
    expect((await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId })).status).toBe(200);
    expect((await view(t)).modes.company).toBe("off");
  });

  it("a company of one can raise but never lower alone: there is no sole-owner exception", async () => {
    const { t } = await withEvidence({});
    await setMode(t, OMAR, "on");
    const asked = await setMode(t, OMAR, "off");
    expect(asked.status).toBe(202);
    const changeId = (asked.body as { changeId: string }).changeId;
    expect((await t.web(OMAR, "POST", PATH, { action: "approve-mode", changeId })).status).toBe(403);
    expect((await view(t)).modes.company).toBe("on");
  });

  it("a member cannot approve and is told only that something waits; a second proposal for the same scope is refused; the proposer can withdraw it", async () => {
    const { t } = await withEvidence({ maya: "admin" });
    await t.person(MAYA, "member");
    await setMode(t, OMAR, "on");
    const asked = await setMode(t, OMAR, "shadow");
    const changeId = (asked.body as { changeId: string }).changeId;
    const seen = (await view(t, MAYA)) as Record<string, unknown>;
    expect(seen).toMatchObject({ pendingLowering: true });
    expect(seen).not.toHaveProperty("pending");
    expect((await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId })).status).toBe(403);
    expect((await setMode(t, OMAR, "off")).status).toBe(409);
    expect((await t.web(OMAR, "POST", PATH, { action: "cancel-mode", changeId })).status).toBe(200);
    expect((await view(t)).pendingLowering).toBe(false);
    expect((await setMode(t, OMAR, "off")).status).toBe(202);
  });

  it("a proposal goes stale when the mode moved since: approving it changes nothing", async () => {
    const { t } = await withEvidence();
    await setMode(t, OMAR, "shadow");
    const changeId = ((await setMode(t, OMAR, "off")).body as { changeId: string }).changeId;
    await setMode(t, OMAR, "on");
    const approved = await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId });
    expect(approved.status).toBe(409);
    expect((await view(t)).modes.company).toBe("on");
  });
});

describe("a project's override", () => {
  it("can be as strict as the company's mode or stricter, never less strict; a maintainer sets it; a contributor cannot", async () => {
    const { t, audit } = await bench({ maya: "member", grant: "maintainer" });
    await setMode(t, OMAR, "shadow");
    expect((await setProject(t, MAYA, "off")).status).toBe(403);
    expect(await setProject(t, MAYA, "shadow")).toMatchObject({ status: 200, body: { status: "applied", mode: "shadow" } });
    expect(modeEvents(audit).at(-1)).toMatchObject({ target: { kind: "project", name: NAME }, facts: { scope: "project", from: "shadow", to: "shadow", mode: "direct" } });
    await t.person(MAYA, "member", "contributor");
    expect((await setProject(t, MAYA, "shadow")).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "mode", scope: "project", project: "nope", mode: "shadow" })).status).toBe(404);
  });

  it("is judged against the company's mode when it is read: the effective mode is never below the company's", async () => {
    const { t } = await withEvidence();
    await setMode(t, OMAR, "shadow");
    expect(await view(t, OMAR, `${QUERY}&project=${NAME}`)).toMatchObject({ mode: "shadow", modes: { company: "shadow", project: null, effective: "shadow" } });
    await setMode(t, OMAR, "on");
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).mode).toBe("on");
  });

  it("`on` for a project needs the evidence for the model it narrowed to", async () => {
    const { t } = await withEvidence();
    expect((await setProject(t, OMAR, "on")).status).toBe(200);
    t.db.set({ ...secondReviewVerdictKey(TEST_ORG, secondReviewModelKey((await view(t)).models[0]!.model)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor((await view(t)).models[0]!.model, { withdrawnAt: "2026-10-22T00:00:00.000Z", withdrawnBy: "d" }) });
    const other = await setProject(t, OMAR, "shadow");
    expect(other.status).toBe(202);
  });

  it("lowering a project's override, and clearing it when that lowers the project, needs a second person from the project", async () => {
    const { t } = await withEvidence();
    await setProject(t, OMAR, "on");
    const asked = await setProject(t, OMAR, "shadow");
    expect(asked.status).toBe(202);
    const changeId = (asked.body as { changeId: string }).changeId;
    expect((await t.web(OMAR, "POST", PATH, { action: "approve-mode", changeId })).status).toBe(403);
    expect((await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId })).status).toBe(200);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes).toMatchObject({ project: "shadow", effective: "shadow" });
    // Clearing the override falls back to the company's mode (off): a lowering again.
    const cleared = await setProject(t, OMAR, "inherit");
    expect(cleared.status).toBe(202);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes.project).toBe("shadow");
  });

  it("a project name that holds the key separator is refused", async () => {
    const { t } = await bench();
    expect((await t.web(OMAR, "POST", PATH, { action: "mode", scope: "project", project: "a#b", mode: "shadow" })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("what the settings screen reads", () => {
  it("is exactly the shape the app's strict contract describes, with and without the model that writes the code, for a project, with evidence, a pending request and a notice", async () => {
    const { t, model } = await withEvidence();
    const parse = (reply: { body: Record<string, unknown> }) => { const { requestId: _gateway, ...own } = reply.body; void _gateway; return SecondReviewStateSchema.safeParse(own); };
    for (const query of [QUERY, PATH, `${QUERY}&project=${NAME}`]) { const parsed = parse(await t.web(OMAR, "GET", query)); expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true); }
    await setMode(t, OMAR, "on");
    await setMode(t, OMAR, "shadow");
    seedTrackRow(t.db, model, { at: "2026-10-02T12:00:00.000Z", task: "t1", fixed: 1 });
    for (const who of [OMAR, MAYA]) { const parsed = parse(await t.web(who, "GET", QUERY)); expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true); }
    expect(parse(await t.web(OMAR, "GET", QUERY)).data).toMatchObject({ pendingLowering: true, evidence: { holds: true }, trackRecord: { reviews: 1, agreed: 1 } });
  });
});

const pause = () => new Promise<void>((resolve) => { setTimeout(resolve, 5); });
const withdrawn = (t: Bench, model: Ref) => t.db.set({ ...secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(model)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model, { withdrawnAt: "2026-10-22T00:00:00.000Z", withdrawnBy: "d" }) });
const restored = (t: Bench, model: Ref) => t.db.set({ ...secondReviewVerdictKey(TEST_ORG, secondReviewModelKey(model)), entityType: "SECOND_REVIEW_VERDICT", verdict: verdictFor(model) });

describe("a project pinned to `on`", () => {
  it("is an admin's decision: the project's maintainer may pin shadow but is refused `on`, and nothing is written or audited", async () => {
    const { t, audit } = await withEvidence({ maya: "member", grant: "maintainer" });
    await setMode(t, OMAR, "shadow");
    const before = modeEvents(audit).length;
    const refused = await setProject(t, MAYA, "on");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("Only a company owner or admin can turn blocking on for a project");
    expect(modeEvents(audit)).toHaveLength(before);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes.project).toBeNull();
    expect((await setProject(t, MAYA, "shadow")).status).toBe(200);
    expect((await setProject(t, OMAR, "on")).status).toBe(200);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes).toMatchObject({ project: "on", effective: "on" });
  });

  it("needs the evidence for the model even when the company is already `on` and the project would follow it anyway", async () => {
    const { t, model } = await withEvidence();
    await setMode(t, OMAR, "on");
    withdrawn(t, model);
    const refused = await setProject(t, OMAR, "on");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("Choose the model first");
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes.project).toBeNull();
    restored(t, model);
    expect((await setProject(t, OMAR, "on")).status).toBe(200);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes.project).toBe("on");
    // Already pinned `on`: saying it again is no new decision.
    withdrawn(t, model);
    expect((await setProject(t, OMAR, "on")).status).toBe(200);
  });

  it("follows the company down: when two admins lower the company, the pin stops counting, and an admin has to pin the project afresh", async () => {
    const { t } = await withEvidence();
    await setMode(t, OMAR, "shadow");
    expect((await setProject(t, OMAR, "on")).status).toBe(200);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes).toMatchObject({ company: "shadow", project: "on", effective: "on" });
    await pause();
    const changeId = ((await setMode(t, OMAR, "off")).body as { changeId: string }).changeId;
    // Proposing changes nothing: the project still blocks until the second admin approves.
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes.effective).toBe("on");
    expect((await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId })).status).toBe(200);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes).toMatchObject({ company: "off", project: null, effective: "off" });
    // A shadow pin is only stricter than the company and is not touched by the lowering.
    await pause();
    expect((await setProject(t, OMAR, "on")).status).toBe(200);
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes).toMatchObject({ company: "off", project: "on", effective: "on" });
  });
});

describe("the mode writer on its own", () => {
  it("refuses to pin a project to `on` for someone who is not an admin, whatever the route did before it", async () => {
    const { t } = await withEvidence();
    const deps = { table: { documentClient: t.db, tableName: "state" }, evidence: {}, audit: { pending: () => undefined }, now: () => Date.now() } as unknown as ModeDeps;
    const ask = (requesterIsAdmin: boolean) => requestSecondReviewMode(deps, { orgId: TEST_ORG, scope: { kind: "project", project: NAME }, to: "on", requestedBy: "d", onAllowed: true, requesterIsAdmin });
    expect(await ask(false)).toEqual({ ok: false, code: "not_eligible" });
    // An admin gets past that check (and stops at the missing ledger here).
    expect(await ask(true)).toEqual({ ok: false, code: "audit_unavailable" });
  });
});

describe("a waiting proposal that the mode has moved away from", () => {
  it("is cancelled by the next proposal for that scope, in the same transaction and audited; one that still matches blocks a second proposal", async () => {
    const { t, audit } = await withEvidence();
    await setMode(t, OMAR, "shadow");
    const old = ((await setMode(t, OMAR, "off")).body as { changeId: string }).changeId;
    await setMode(t, OMAR, "on");
    const sent: Array<{ input?: { TransactItems?: Array<{ Update?: { ExpressionAttributeValues?: Record<string, unknown> }; Put?: { Item?: { pk?: string; entityType?: string } } }> } }> = [];
    const original = t.db.send.bind(t.db);
    t.db.send = (async (command: never) => { sent.push(command); return original(command); }) as never;
    const fresh = await setMode(t, OMAR, "shadow");
    t.db.send = original;
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(202);
    const changeId = (fresh.body as { changeId: string }).changeId;
    expect(changeId).not.toBe(old);
    const write = sent.find((command) => command.input?.TransactItems?.some((item) => item.Put?.Item?.entityType === "SECOND_REVIEW_MODE_CHANGE"))!;
    expect(write.input!.TransactItems!.some((item) => item.Update?.ExpressionAttributeValues?.[":cancelled"] === "cancelled")).toBe(true);
    expect(write.input!.TransactItems!.filter((item) => item.Put?.Item?.pk?.startsWith("AUDIT_PENDING#"))).toHaveLength(2);
    expect((await view(t)).pending).toMatchObject([{ changeId, from: "on", to: "shadow" }]);
    expect(modeEvents(audit).find((event) => event.action === "company.second_review_mode_cancelled")).toMatchObject({ facts: { scope: "company", from: "shadow", to: "off", reason: "stale" } });
    // The old one can no longer be approved.
    expect((await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId: old })).status).toBe(409);
    // Still matching: a second proposal is refused as before.
    expect((await setMode(t, OMAR, "off")).status).toBe(409);
  });
});

describe("withdrawing a proposal", () => {
  it("is audited in the same transaction as the cancellation", async () => {
    const { t, audit } = await withEvidence();
    await setMode(t, OMAR, "on");
    const changeId = ((await setMode(t, OMAR, "shadow")).body as { changeId: string }).changeId;
    const sent: Array<{ input?: { TransactItems?: Array<{ Update?: unknown; Put?: { Item?: { pk?: string } } }> } }> = [];
    const original = t.db.send.bind(t.db);
    t.db.send = (async (command: never) => { sent.push(command); return original(command); }) as never;
    expect((await t.web(OMAR, "POST", PATH, { action: "cancel-mode", changeId })).status).toBe(200);
    t.db.send = original;
    const write = sent.find((command) => command.input?.TransactItems?.some((item) => item.Update !== undefined))!;
    expect(write.input!.TransactItems!.some((item) => item.Put?.Item?.pk?.startsWith("AUDIT_PENDING#"))).toBe(true);
    expect(modeEvents(audit).at(-1)).toMatchObject({ action: "company.second_review_mode_cancelled", actor: { id: OMAR.developerId }, facts: { scope: "company", from: "on", to: "shadow", reason: "withdrawn" } });
    // Withdrawing it twice is refused and audits nothing more.
    const events = modeEvents(audit).length;
    expect((await t.web(OMAR, "POST", PATH, { action: "cancel-mode", changeId })).status).toBe(409);
    expect(modeEvents(audit)).toHaveLength(events);
  });
});

describe("approving a project's clear", () => {
  it("lands on the company's mode as it is NOW: the audit event and the answer say what the setting becomes, not what it was when asked", async () => {
    const { t, audit } = await withEvidence();
    await setMode(t, OMAR, "shadow");
    expect((await setProject(t, OMAR, "on")).status).toBe(200);
    const asked = await setProject(t, OMAR, "inherit");
    expect(asked.status).toBe(202);
    const changeId = (asked.body as { changeId: string }).changeId;
    expect((await view(t)).pending).toMatchObject([{ scope: "project", from: "on", to: "shadow" }]);
    // Meanwhile the company went up to `on`: clearing the project now means following `on`.
    expect((await setMode(t, OMAR, "on")).status).toBe(200);
    const approved = await t.web(MAYA, "POST", PATH, { action: "approve-mode", changeId });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { status: "applied", mode: "on" } });
    expect(modeEvents(audit).at(-1)).toMatchObject({ actor: { id: MAYA.developerId }, facts: { scope: "project", from: "on", to: "on", mode: "second_person" } });
    expect((await view(t, OMAR, `${QUERY}&project=${NAME}`)).modes).toMatchObject({ project: null, effective: "on" });
  });
});

describe("reading the waiting proposals", () => {
  it("pages through all of them, so a proposal past the first page is still found", async () => {
    const { t } = await bench();
    const pk = orgMetaKey(TEST_ORG).pk;
    const far = Date.now() + 86_400_000;
    for (let n = 0; n < 7; n += 1) {
      t.db.set({ pk, sk: `SECONDREVIEW#MODECHANGE#c${String(n)}`, entityType: "SECOND_REVIEW_MODE_CHANGE", id: `c${String(n)}`, orgId: TEST_ORG, scope: { kind: "project", project: `p${String(n)}` }, from: "on", to: "shadow", proposedBy: "d", at: 1, expiresAt: far, state: n === 5 ? "cancelled" : "pending" });
    }
    const real = t.db;
    const small = { send: (command: unknown) => real.send(command instanceof QueryCommand ? new QueryCommand({ ...command.input, Limit: 2 }) : command as never) };
    const table = { documentClient: small, tableName: "state" };
    expect((await openModeChanges(table, TEST_ORG, Date.now())).map((change) => change.id).sort()).toEqual(["c0", "c1", "c2", "c3", "c4", "c6"]);
    expect((await openModeChange(table, TEST_ORG, { kind: "project", project: "p6" }, Date.now()))?.id).toBe("c6");
    expect(await openModeChange(table, TEST_ORG, { kind: "project", project: "p5" }, Date.now())).toBeUndefined();
  });
});

void BASELINE;
