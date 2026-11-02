// Decisions D4: Slack cards come from the same card view and follow its friction; a press goes through the same server routes as the web.
import { describe, expect, it, vi } from "vitest";
import type { DecisionCard } from "@agentx/contracts";
import { cardOfItem, projectDecisionCards, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import { slackCardMessage, DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_OPEN_ACTION, DECISION_SLACK_REJECT_ACTION } from "../../packages/broker/src/decisions/slack-card.js";
import { DECISION_SLACK_TEXT, decisionSlackHandler, pressRequestId, pressToRequest, refusalText, resolveSlackDecisionCaller, type SlackPersonLookups } from "../../packages/broker/src/decisions/slack-actions.js";
import { routeDecisionCards, type DecisionCaller, type PerformOutcome } from "../../packages/broker/src/decisions/routes.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/decisions/store.js";

const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1", openPath: `/app/sessions/ses_${"a".repeat(20)}`, ...extra });
const lowItem: DecisionItem = { ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0, cost: { lowUsd: 1.2, highUsd: 3.1, minutes: { low: 12, high: 25 } } };
const mediumItem: DecisionItem = { ...base("dep1"), kind: "approve_dependency", packages: 2, newInstallScripts: false };
const highItem: DecisionItem = { ...base("set1"), kind: "approve_setting", settingLabel: "Allow video", secondPerson: false };
const card = (item: DecisionItem): DecisionCard => { const made = cardOfItem(item); if (made === undefined) throw new Error("no card"); return made.card; };
const DIGEST = "ab".repeat(32);
const URL_ = "https://app.example.com/s/ses_aaaaaaaaaaaaaaaaaaaa";
const elementsOf = (message: ReturnType<typeof slackCardMessage>) => (message.blocks.find((block) => block["type"] === "actions") as { elements: Array<Record<string, unknown>> } | undefined)?.elements ?? [];

describe("the Slack card follows the card's friction", () => {
  it("low: Approve in one tap, Not now, and a Details link", () => {
    const elements = elementsOf(slackCardMessage(card(lowItem), { cardUrl: URL_, digest: DIGEST }));
    expect(elements.map((element) => [element["action_id"], (element["text"] as { text: string }).text, element["url"]])).toEqual([
      [DECISION_SLACK_APPROVE_ACTION, "Approve", undefined], [DECISION_SLACK_REJECT_ACTION, "Not now", undefined], [DECISION_SLACK_OPEN_ACTION, "Details", URL_],
    ]);
    expect(elements[0]?.["value"]).toBe(`approve_plan:plan1|${DIGEST}`);
  });
  it("medium: no approve button; the evidence is reviewed on the web", () => {
    const message = slackCardMessage(card(mediumItem), { cardUrl: URL_, digest: DIGEST });
    const elements = elementsOf(message);
    expect(elements.some((element) => element["action_id"] === DECISION_SLACK_APPROVE_ACTION)).toBe(false);
    expect(elements[0]).toMatchObject({ action_id: DECISION_SLACK_OPEN_ACTION, url: URL_ });
    expect(JSON.stringify(message)).toContain("Medium risk");
  });
  it("high: one link, Open to decide; nothing to press that decides", () => {
    const elements = elementsOf(slackCardMessage(card(highItem), { cardUrl: URL_, digest: DIGEST }));
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ action_id: DECISION_SLACK_OPEN_ACTION, url: URL_ });
    expect((elements[0]?.["text"] as { text: string }).text).toBe("Open to decide");
  });
  it("never claims a fresh sign-in for a high card without a confirmation page; says it only for one that opens it", () => {
    const without = JSON.stringify(slackCardMessage(card(highItem), { cardUrl: URL_, digest: DIGEST }).blocks);
    expect(without).toContain("decided on its own page");
    expect(without).not.toContain("sign in again");
    const withPage = JSON.stringify(slackCardMessage(card({ ...highItem, confirmPath: "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }), { cardUrl: URL_, digest: DIGEST }).blocks);
    expect(withPage).toContain("after you sign in again");
  });
  it("a question is answered on its page, never approved in Slack", () => {
    const question = card({ ...base("q1"), kind: "answer_question", question: "Which gateway?", index: 1, of: 1 });
    expect(elementsOf(slackCardMessage(question, { cardUrl: URL_, digest: DIGEST })).some((element) => element["action_id"] === DECISION_SLACK_APPROVE_ACTION)).toBe(false);
  });
  it("an answered card has no buttons and says what became of it", () => {
    const message = slackCardMessage(card({ ...lowItem, outcome: "approved" }), { cardUrl: URL_, digest: DIGEST });
    expect(elementsOf(message)).toEqual([]);
    expect(JSON.stringify(message.blocks)).toContain("Approved.");
  });
  it("names the two approvals of a Full pair", () => {
    const projection = projectDecisionCards([{ ...base("req1", { taskId: "11111111-1111-4111-8111-111111111111" }), kind: "approve_requirements", claims: 2 }, { ...base("des1", { taskId: "11111111-1111-4111-8111-111111111111" }), kind: "approve_design", files: [] }]);
    const [pair] = projection.cards;
    const message = slackCardMessage(pair as DecisionCard, { cardUrl: URL_, digest: DIGEST, tabs: projection.tabs[pair?.id ?? ""] });
    expect(JSON.stringify(message.blocks)).toContain("Two approvals: Requirements and Design.");
  });
  it("escapes Slack markup in anything a person wrote, and stays inside Slack's limits", () => {
    const hostile = card({ ...lowItem, title: "<!channel> <@U123> &amp; <https://evil.example|click>" });
    const text = JSON.stringify(slackCardMessage(hostile, { cardUrl: URL_, digest: DIGEST }).blocks);
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U123>");
    expect(text).toContain("&lt;!channel&gt;");
    for (const block of slackCardMessage(hostile, { cardUrl: URL_, digest: DIGEST }).blocks) {
      const section = block["text"] as { text: string } | undefined;
      if (section !== undefined) expect([...section.text].length).toBeLessThanOrEqual(3000);
    }
  });
});

describe("a press becomes the same request the web sends", () => {
  it("approve and not-now map to the card routes with a stable request id", () => {
    const approve = pressToRequest({ actionId: DECISION_SLACK_APPROVE_ACTION, value: `approve_plan:plan1|${DIGEST}`, actionTs: "1700000000.0001" });
    expect(approve).toMatchObject({ method: "POST", pathname: "/v1/app/decisions/approve_plan/plan1/approve" });
    expect((approve?.body as { requestId: string }).requestId).toBe(pressRequestId("approve_plan:plan1", "1700000000.0001"));
    expect((approve?.body as { requestId: string }).requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(pressRequestId("approve_plan:plan1", "1700000000.0002")).not.toBe(pressRequestId("approve_plan:plan1", "1700000000.0001"));
    expect(pressToRequest({ actionId: DECISION_SLACK_REJECT_ACTION, value: `approve_plan:plan1|${DIGEST}`, actionTs: "1" })?.body).toMatchObject({ reason: "not_now" });
  });
  it("refuses a value that is not a card id and a link button", () => {
    expect(pressToRequest({ actionId: DECISION_SLACK_APPROVE_ACTION, value: `../../x|${DIGEST}`, actionTs: "1" })).toBeUndefined();
    expect(pressToRequest({ actionId: DECISION_SLACK_OPEN_ACTION, value: `approve_plan:plan1|${DIGEST}`, actionTs: "1" })).toBeUndefined();
  });
  it("says a refusal in fixed words only", () => {
    expect(refusalText({ code: "CHANGE_STALE", message: "secret detail" })).toBe(DECISION_SLACK_TEXT.changed);
    expect(refusalText({ code: "CHANGE_STALE", message: "Open the evidence first. It has changed or has not been opened." })).toBe(DECISION_SLACK_TEXT.openFirst);
    expect(refusalText({ code: "NOT_FOUND" })).toBe(DECISION_SLACK_TEXT.gone);
    expect(refusalText(new Error("boom with <details>"))).toBe(DECISION_SLACK_TEXT.failed);
  });
});

const PRESS = { userTeamId: "T1", workspaceTeamId: "T1", enterpriseId: "", userEnterpriseId: "" };

describe("the Slack handler goes through the server's friction and says what happened", () => {
  const ME: DecisionCaller = { orgId: "org1", developerId: "dev1" };
  function setup(items: DecisionItem[], outcome: PerformOutcome = { kind: "done" }) {
    const performer = { approve: vi.fn(async (): Promise<PerformOutcome> => outcome), reject: vi.fn(async (): Promise<PerformOutcome> => outcome) };
    const deps = { sources: { list: async () => items, locks: async () => ({}) }, performer, store: inMemoryDecisionStore(() => Date.parse("2026-10-30T10:05:00.000Z")), now: () => Date.parse("2026-10-30T10:05:00.000Z") };
    const said: string[] = [];
    const handler = decisionSlackHandler({ resolveCaller: async (press) => (press.userId === "U1" ? ME : undefined), route: (caller, request) => routeDecisionCards(deps, caller, request), respondEphemeral: async (_url, text) => { said.push(text); } });
    const press = (actionId: string, value: string, userId = "U1", digest?: string) => handler.handle({ actionId, value: `${value}|${digest ?? projectDecisionCards(items).digests[value] ?? DIGEST}`, userId, actionTs: "1.1", messageTs: "1.0", responseUrl: "https://hooks.slack.com/x", ...PRESS });
    return { performer, said, press, handler };
  }
  it("approves a low card once", async () => {
    const t = setup([lowItem]);
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_plan:plan1");
    expect(t.performer.approve).toHaveBeenCalledTimes(1);
    expect(t.said).toEqual([DECISION_SLACK_TEXT.approved]);
  });
  it("I7: when the endpoint wants the confirmation page, Slack never says Approved: it links the page", async () => {
    const url = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
    const t = setup([lowItem], { kind: "needs_confirmation", confirmUrl: url });
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_plan:plan1");
    expect(t.said).toEqual([`${DECISION_SLACK_TEXT.notDecided} ${url}`]);
    expect(t.said.join(" ")).not.toContain("Approved");
  });
  it("WEB-1: a merge outcome that names what is being merged says the same Slack words and link as before (the app's question never reaches Slack)", async () => {
    const url = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
    const t = setup([lowItem], { kind: "needs_confirmation", confirmUrl: url, merging: [{ repositoryId: "payments", number: 7, baseBranch: "main" }] });
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_plan:plan1");
    expect(t.said).toEqual([`${DECISION_SLACK_TEXT.notDecided} ${url}`]);
  });
  it("says a refusal in fixed words, never the endpoint's text", async () => {
    const t = setup([lowItem], { kind: "refused", reason: "forbidden" });
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_plan:plan1");
    expect(t.said).toEqual([DECISION_SLACK_TEXT.forbidden]);
  });
  it("a forged approve press on a medium card (evidence not opened) and a high card is refused", async () => {
    const t = setup([mediumItem, highItem]);
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_dependency:dep1");
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_setting:set1");
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.said).toEqual([DECISION_SLACK_TEXT.openFirst, DECISION_SLACK_TEXT.gone]);
  });
  it("a press on a message whose card changed since it was posted is refused as changed, and nothing is decided", async () => {
    const t = setup([lowItem]);
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_plan:plan1", "U1", "cd".repeat(32));
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.said).toEqual([DECISION_SLACK_TEXT.changed]);
  });
  it("does nothing for a person it cannot place, and ignores a link press", async () => {
    const t = setup([lowItem]);
    await t.press(DECISION_SLACK_APPROVE_ACTION, "approve_plan:plan1", "U9");
    await t.press(DECISION_SLACK_OPEN_ACTION, "approve_plan:plan1");
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.said).toEqual([DECISION_SLACK_TEXT.unknownPerson]);
    expect(t.handler.matches(DECISION_SLACK_APPROVE_ACTION)).toBe(true);
    expect(t.handler.matches("agentx_workflow_approve")).toBe(false);
  });
});

describe("I8: who pressed is the linked Rovara person, never a stand-in", () => {
  const MEMBER = { orgId: "org1", developerId: "dev-real", orgRole: "member" };
  const lookups = (over: Partial<SlackPersonLookups> = {}): SlackPersonLookups => ({
    orgOfSlackInstall: async ({ teamId }) => (teamId === "T1" ? "org1" : undefined),
    linkedDeveloper: async ({ userId }) => (userId === "U1" ? "dev-real" : undefined),
    memberRole: async (orgId, developerId) => (orgId === "org1" && developerId === "dev-real" ? MEMBER : undefined),
    ...over,
  });
  const press = { userId: "U1", ...PRESS };
  it("maps (workspace, user) to the linked member of the org that installed the app", async () => {
    expect(await resolveSlackDecisionCaller(lookups(), press)).toEqual(MEMBER);
  });
  it("refuses a press from another workspace, a Slack Connect guest, an unlinked user, a non-member and a mismatched grid", async () => {
    expect(await resolveSlackDecisionCaller(lookups(), { ...press, userTeamId: "T2", workspaceTeamId: "T2" })).toBeUndefined();
    expect(await resolveSlackDecisionCaller(lookups(), { ...press, userTeamId: "T9" })).toBeUndefined();
    expect(await resolveSlackDecisionCaller(lookups(), { ...press, userId: "U2" })).toBeUndefined();
    expect(await resolveSlackDecisionCaller(lookups({ memberRole: async () => undefined }), press)).toBeUndefined();
    expect(await resolveSlackDecisionCaller(lookups(), { ...press, enterpriseId: "E1", userEnterpriseId: "E2" })).toBeUndefined();
    expect(await resolveSlackDecisionCaller(lookups(), { ...press, userId: "" })).toBeUndefined();
    expect(await resolveSlackDecisionCaller(lookups(), { ...press, workspaceTeamId: "", userTeamId: "" })).toBeUndefined();
  });
  it("refuses a member record of another org or person (the lookup is checked, not trusted)", async () => {
    expect(await resolveSlackDecisionCaller(lookups({ memberRole: async () => ({ orgId: "org2", developerId: "dev-real", orgRole: "member" }) }), press)).toBeUndefined();
    expect(await resolveSlackDecisionCaller(lookups({ memberRole: async () => ({ orgId: "org1", developerId: "someone-else", orgRole: "member" }) }), press)).toBeUndefined();
  });
  it("never asks for a member before the install and the link are known", async () => {
    const memberRole = vi.fn(async () => MEMBER);
    await resolveSlackDecisionCaller(lookups({ orgOfSlackInstall: async () => undefined, memberRole }), press);
    await resolveSlackDecisionCaller(lookups({ linkedDeveloper: async () => undefined, memberRole }), press);
    expect(memberRole).not.toHaveBeenCalled();
  });
});
