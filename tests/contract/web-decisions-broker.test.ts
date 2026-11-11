// WEB-1 (owner, 2026-11-02, option A): the decision cards through the browser boundary of the whole broker (`/v1/web/decisions*`: the session cookie, the app's origin and the CSRF token).
// The cards were unreachable from a browser (the path 404ed), so the app showed none and swallowed the error. The kinds that are wired press from a browser exactly as they do from a token.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, testEnvDigest } from "@rovara-code/contracts";
import { OMAR } from "../support/developer-task-broker.js";
import { ENV, NAME, draftBody, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";

const withCards = async <T>(run: () => Promise<T>): Promise<T> => {
  const before = process.env.DECISION_CARDS_ENABLED;
  process.env.DECISION_CARDS_ENABLED = "1";
  try { return await run(); } finally { if (before === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = before; }
};
afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; delete process.env.DECISION_CARDS_ENABLED; });

const view = async (t: Bench) => {
  const reply = await t.web(OMAR, "GET", "/v1/app/decisions");
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const { requestId: _gateway, ...own } = reply.body; void _gateway;
  return DecisionCardsViewSchema.parse(own);
};
async function provedProposal(t: Bench): Promise<string> {
  await t.drafted();
  expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
  const digest = testEnvDigest(draftBody());
  t.candidatePassed(digest);
  expect((await t.dev(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
  return digest;
}

describe("decision cards from a browser", () => {
  it("lists the caller's cards (it was a 404)", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      const digest = await provedProposal(t);
      const list = await view(t);
      expect(list.cards.map((card) => card.id)).toEqual([`approve_test_env:${digest}`]);
    }));
  });

  it("approve_test_env: the browser opens the evidence, then approves, and it is the wizard's own approval", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      const digest = await provedProposal(t);
      const { cards, digests } = await view(t);
      const card = cards[0]!;
      const base = `/v1/app/decisions/approve_test_env/${digest}`;
      expect((await t.web(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card.id] })).status).toBe(409);
      expect((await t.web(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card.id] })).status).toBe(200);
      const approved = await t.web(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")[0]).toMatchObject({ digest, approvedBy: OMAR.developerId, revision: 1 });
      expect((await view(t)).cards).toEqual([]);
    }));
  });

  it("confirm_env_change: a running task's owner moves it to the newer revision from the browser, and 'Not now' keeps it", async () => {
    for (const choice of ["approve", "reject"] as const) {
      const t = await setupWizardBench();
      await withSwitch("1", () => withCards(async () => {
        await t.approveFirst();
        const started = await t.dev(OMAR, "POST", `/v1/app/projects/${NAME}/code`, { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        const taskId = (started.body.task as { taskId: string }).taskId;
        const second = draftBody({ selection: { method: "full", alwaysRun: [], fullSuiteOn: [".github/**", "package.json"] } });
        expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: second })).status).toBe(200);
        const digest = testEnvDigest(second);
        expect((await t.web(OMAR, "POST", `${ENV}/prove`, { digest })).status).toBe(200);
        expect((await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 })).status).toBe(200);
        const { cards, digests } = await view(t);
        const card = cards.find((candidate) => candidate.kind === "confirm_env_change")!;
        const base = `/v1/app/decisions/confirm_env_change/${taskId}`;
        expect((await t.web(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card.id] })).status).toBe(200);
        const body = choice === "approve" ? { requestId: randomUUID(), shownDigest: digests[card.id] } : { requestId: randomUUID(), reason: "not_now" };
        const answered = await t.web(OMAR, "POST", `${base}/${choice}`, body);
        expect(answered.status, JSON.stringify(answered.body)).toBe(200);
        const pin = t.db.find((item) => item.entityType === "TEST_ENV_PIN" && item.taskId === taskId)[0] as { revision: number; declined?: string };
        expect(choice === "approve" ? pin.revision : pin.declined).toBe(choice === "approve" ? 2 : digest);
      }));
    }
  });

  it("nothing else under decisions reaches the broker from a browser: the web rule answers 404 before any card code runs", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", () => withCards(async () => {
      const digest = await provedProposal(t);
      for (const [method, path] of [
        ["POST", "/v1/app/decisions"], ["DELETE", "/v1/app/decisions"], ["GET", `/v1/app/decisions/approve_test_env/${digest}/approve`], ["POST", `/v1/app/decisions/approve_test_env/${digest}`],
        ["POST", `/v1/app/decisions/approve_test_env/${digest}/approve/extra`], ["POST", `/v1/app/decisions/approve_test_env/${digest}/bulk`], ["POST", "/v1/app/decisions/bulk/approve"],
      ] as const) {
        const reply = await t.web(OMAR, method, path, method === "GET" ? undefined : {});
        expect(reply.status, `${method} ${path}`).toBe(404);
      }
      expect(t.db.find((item) => item.entityType === "TEST_ENV_REVISION")).toHaveLength(0);
    }));
  });
});
