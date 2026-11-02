// SR-1: `/v1/app/org/second-review`, the picker's preview and the company's choice, through the whole broker with a live browser session. Behind `cr`. GET is open to members; changes are for owners and admins (a project
// narrowing also for its maintainer) from a browser only, audited, and never silent.
import { afterEach, describe, expect, it } from "vitest";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

afterEach(() => { delete process.env.SECOND_REVIEW_ENABLED; });
const PATH = "/v1/app/org/second-review";
const on = () => { process.env.SECOND_REVIEW_ENABLED = "1"; };
async function bench(options: { maya?: "admin" | "member" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  return { t, audit };
}
const events = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => event.action.includes("second_review"));
// With no company model sources, the company can use Rovara's own models: Claude on Bedrock. A builder from another company makes them eligible.
const GPT_BUILDER = "builder=openai:gpt-5.5";
const CLAUDE_BUILDER = "builder=anthropic:claude-sonnet-4-6";
const get = async (t: Bench, query: string, who = OMAR) => t.web(who, "GET", `${PATH}?${query}`);
const bodyOf = (reply: { body: unknown }) => reply.body as { models: Array<{ model: { provider: string; modelId: string }; eligible: boolean; ineligibleWhy?: string; suggested: boolean }>; suggested: Array<{ provider: string; modelId: string }>;
  choice: { models: Array<{ provider: string; modelId: string }> } | null; projectNarrowing: unknown; current: { source: string; models: unknown[]; line?: string; reason?: string; skipped?: unknown[] } };

describe("behind cr", () => {
  it("is not found while cr is off, for any value but exactly 1", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.SECOND_REVIEW_ENABLED; else process.env.SECOND_REVIEW_ENABLED = value;
      expect((await get(t, GPT_BUILDER)).status, String(value)).toBe(404);
      expect((await t.web(OMAR, "POST", PATH, { action: "clear" })).status).toBe(404);
    }
  });
});

describe("the preview", () => {
  it("lists only the company's own models, with suggestions from that list and the default while nobody has chosen", async () => {
    const { t } = await bench({ maya: "member" });
    on();
    const reply = await get(t, GPT_BUILDER, MAYA);
    expect(reply.status).toBe(200);
    const body = bodyOf(reply);
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.every((entry) => entry.model.provider === "amazon-bedrock" && /anthropic\.claude-/u.test(entry.model.modelId))).toBe(true);
    expect(body.models.every((entry) => entry.eligible)).toBe(true);
    expect(body.suggested.length).toBeGreaterThanOrEqual(1);
    for (const suggestion of body.suggested) expect(body.models.some((entry) => entry.model.modelId === suggestion.modelId)).toBe(true);
    expect(body.choice).toBeNull();
    expect(body.current).toMatchObject({ source: "default" });
    expect(body.current.line).toMatch(/^Using default: .+ \(change\)$/u);
  });

  it("greys out a same-company model, and says so when nothing qualifies", async () => {
    const { t } = await bench();
    on();
    const body = bodyOf(await get(t, CLAUDE_BUILDER));
    expect(body.models.every((entry) => !entry.eligible && entry.ineligibleWhy === "same-company" && !entry.suggested)).toBe(true);
    expect(body.suggested).toEqual([]);
    expect(body.current).toMatchObject({ source: "none", models: [], reason: "no-candidate" });
  });

  it("needs to know the model that writes the code", async () => {
    const { t } = await bench();
    on();
    expect((await t.web(OMAR, "GET", PATH)).status).toBe(400);
  });
});

describe("the company's choice", () => {
  it("is refused from a token, from a member in a browser, and for a model the company cannot use; it writes and audits nothing", async () => {
    const { t, audit } = await bench({ maya: "member" });
    on();
    const listed = bodyOf(await get(t, GPT_BUILDER)).models[0]!.model;
    expect((await t.dev(OMAR, "POST", PATH, { action: "choose", primary: listed })).status).toBe(403);
    expect((await t.web(MAYA, "POST", PATH, { action: "choose", primary: listed })).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "choose", primary: { provider: "openrouter", modelId: "x/not-connected" } })).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "choose", primary: listed, backup: listed })).status).toBe(400);
    expect(bodyOf(await get(t, GPT_BUILDER)).choice).toBeNull();
    expect(events(audit)).toEqual([]);
  });

  it("applies at once for an admin (it is not a loosening), is audited with counts only, and replaces the default", async () => {
    const { t, audit } = await bench();
    on();
    const models = bodyOf(await get(t, GPT_BUILDER)).models.map((entry) => entry.model);
    const reply = await t.web(OMAR, "POST", PATH, { action: "choose", primary: models[1], backup: models[0] });
    expect(reply).toMatchObject({ status: 200, body: { status: "applied" } });
    expect(events(audit)).toHaveLength(1);
    expect(events(audit)[0]).toMatchObject({ action: "company.second_review_choice_changed", actor: { id: OMAR.developerId }, facts: { change: "choose", count: 2 } });
    expect(JSON.stringify(events(audit))).not.toContain(models[1]!.modelId);
    const after = bodyOf(await get(t, GPT_BUILDER));
    expect(after.choice!.models).toEqual([models[1], models[0]]);
    expect(after.current.source).toBe("company");
    expect(after.current.models).toEqual([models[1], models[0]]);
  });

  it("a chosen model that stops qualifying is not swapped: the preview says nothing qualifies, naming why", async () => {
    const { t } = await bench();
    on();
    const models = bodyOf(await get(t, GPT_BUILDER)).models.map((entry) => entry.model);
    await t.web(OMAR, "POST", PATH, { action: "choose", primary: models[0] });
    // The builder's company changes to Claude's: the chosen Claude model no longer fits, and no other model is picked in its place.
    const body = bodyOf(await get(t, CLAUDE_BUILDER));
    expect(body.current).toMatchObject({ source: "choice", models: [], reason: "choice-not-qualifying", skipped: [{ why: "same-company" }] });
  });

  it("clearing is audited and brings the default back", async () => {
    const { t, audit } = await bench();
    on();
    const model = bodyOf(await get(t, GPT_BUILDER)).models[0]!.model;
    await t.web(OMAR, "POST", PATH, { action: "choose", primary: model });
    expect((await t.web(OMAR, "POST", PATH, { action: "clear" })).status).toBe(200);
    expect(events(audit).map((event) => event.facts)).toEqual([{ change: "choose", count: 1 }, { change: "clear", count: 0 }]);
    expect(bodyOf(await get(t, GPT_BUILDER)).current.source).toBe("default");
  });
});

describe("a project narrowing", () => {
  it("is a subset of the company's choice and never wider; refused for a contributor; audited", async () => {
    const { t, audit } = await bench({ maya: "member" });
    on();
    const models = bodyOf(await get(t, GPT_BUILDER)).models.map((entry) => entry.model);
    await t.web(OMAR, "POST", PATH, { action: "choose", primary: models[0], backup: models[1] });
    expect((await t.web(MAYA, "POST", PATH, { action: "narrow", project: NAME, models: [models[0]] })).status).toBe(403);
    // Widening: a model the company did not name.
    expect((await t.web(OMAR, "POST", PATH, { action: "narrow", project: NAME, models: [models[0], models[2]] })).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "narrow", project: NAME, models: [models[1]] })).status).toBe(200);
    expect(events(audit).map((event) => event.action)).toEqual(["company.second_review_choice_changed", "project.second_review_narrowed"]);
    expect(events(audit)[1]).toMatchObject({ target: { kind: "project", name: NAME }, facts: { change: "choose", count: 1 } });
    const body = bodyOf(await t.web(OMAR, "GET", `${PATH}?project=${NAME}&${GPT_BUILDER}`));
    expect(body.projectNarrowing).toEqual({ models: [models[1]] });
    expect(body.current.models).toEqual([models[1]]);
  });
});
