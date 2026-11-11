// srv/automations: who may read and change automations (chains and their triggers), per experience review decision 16 (final-experience-proposal.md, 2026-11-10) and owner decision 92, and what keeps an automation from
// starting. Over the trigger world (real chain, trigger, approval and run stores; a recording stand-in for Plan 3's task start), the routes called
// directly with each kind of caller. The switch that hides the routes, and the Auditor's refusal, are tested through the broker in automations-gate.test.ts.
import "../support/automations-on.js";
import { fixtureActor, seedMaintainerGrant } from "../support/money-authority.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentXError, type OrgId, type TriggerEvent } from "@rovara-code/contracts";
import {
  AutomationChainResponseReaderSchema, AutomationChainResponseSchema, AutomationTriggerListResponseSchema, AutomationTriggerWriteResponseSchema, ProjectAutomationsResponseReaderSchema,
  ProjectAutomationsResponseSchema, orgMemberKey,
} from "@agentx/cloud-contracts";
import { ChainRunListSchema } from "@rovara-code/contracts";
import type { OrgRole } from "../../packages/cloud-contracts/src/org.js";
import { getApproverRule, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { listProjectAutomations } from "../../packages/broker/src/chains/project-automations.js";
import { routeChainRequest } from "../../packages/broker/src/chains/routes.js";
import { dispatchTriggerEvent, startChainFor, type TriggerDispatchDependencies } from "../../packages/broker/src/triggers/dispatch.js";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { CARL, DANA, MAX, ORG_A, ORG_B, OWNER, PRIYA, STRANGER, VIV, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const CELL = "https://cell.example.com";
const API_MAINTAINER = "8".repeat(64); // a member, maintainer of api only
const NO_ROLE = "9".repeat(64); // a member with no project role
const AUDITOR = "0".repeat(64); // the company's Auditor
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const PR_OPENED = { kind: "event" as const, source: "github" as const, type: "pull_request.opened" };
const ID = (letter: string) => `ctr_${letter.repeat(20)}`;

const caller = (developerId: string, orgRole: OrgRole, orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole });
const WHO = {
  owner: caller(OWNER, "owner"), admin: caller(DANA, "admin"), maintainer: caller(MAX, "member"), otherMaintainer: caller(API_MAINTAINER, "member"),
  contributor: caller(CARL, "member"), viewer: caller(VIV, "member"), member: caller(NO_ROLE, "member"), auditor: caller(AUDITOR, "auditor"), otherOrg: caller(STRANGER, "member", ORG_B),
} as const;
type Who = keyof typeof WHO;

interface Called { status: number; body: Record<string, unknown> }

async function world(options: { admission?: boolean } = {}) {
  const v = setupTriggerWorld(options);
  for (const [developerId, role] of [[OWNER, "owner"], [API_MAINTAINER, "member"], [NO_ROLE, "member"], [AUDITOR, "auditor"]] as const) {
    v.db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    v.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId });
    v.projectMembers.setOrgRole(ORG_A, developerId, role);
  }
  v.projectMembers.grant(ORG_A, "api", API_MAINTAINER, "maintainer");
  // The money writes re-read the actor's membership and a member maintainer's stored grant row (S1-M2), as the real writer stores them.
  for (const developerId of [OWNER, DANA, MAX, API_MAINTAINER, NO_ROLE, AUDITOR]) fixtureActor(v.db, ORG_A, developerId);
  seedMaintainerGrant(v.db, ORG_A, MAX, "web");
  seedMaintainerGrant(v.db, ORG_A, API_MAINTAINER, "api");
  // A project's chain on web, published with a run limit and a monthly budget: what experience review decision 16 is about.
  const chain = await v.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA, budgetUsd: 50 });
  const call = async (who: AgentCaller, method: string, path: string, body?: Record<string, unknown>, options: { safetyOnly?: boolean } = {}): Promise<Called> => {
    const request = { method, path, requestId: "r", headers: {}, ...(body === undefined ? {} : { body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) }) };
    try {
      const result = await routeChainRequest(v.routeDeps, who, request, new URL(`${CELL}${path}`), options);
      return result instanceof StatusReply ? { status: result.statusCode, body: result.body as Record<string, unknown> } : { status: 200, body: (result ?? {}) as Record<string, unknown> };
    } catch (error) {
      if (error instanceof AgentXError) return { status: error.statusCode, body: { code: error.code, message: error.message } };
      throw error;
    }
  };
  const automations = async (who: AgentCaller, project = "web"): Promise<Called> => {
    try {
      return { status: 200, body: await listProjectAutomations(v.routeDeps, who, project) as unknown as Record<string, unknown> };
    } catch (error) {
      if (error instanceof AgentXError) return { status: error.statusCode, body: { code: error.code } };
      throw error;
    }
  };
  const fresh = async () => (await v.chains.get(ORG_A, chain.chainId))!;
  const companyShare = async () => {
    await v.chains.replaceShares({ orgId: ORG_A, chainId: chain.chainId, upsert: [{ principal: { kind: "org" }, level: "view" }], remove: [], expectedSharesRevision: (await fresh()).sharesRevision ?? 0, by: DANA });
  };
  return { v, chain, call, automations, fresh, companyShare, path: (rest = "") => `/v1/app/chains/${chain.chainId}${rest}` };
}

const READERS: Who[] = ["owner", "admin", "maintainer", "contributor", "viewer"];
const HIDDEN: Who[] = ["otherMaintainer", "member", "auditor", "otherOrg"];
const EDITORS: Who[] = ["owner", "admin", "maintainer"];
const SEE_ONLY: Who[] = ["contributor", "viewer"];

describe("experience review decision 16: an automation is visible to everyone in its project", () => {
  it("lets every project role read the chain, its triggers and the project's automations list; a caller with no role there, the Auditor and another org get 404", async () => {
    const w = await world();
    await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId }, enabled: false });
    for (const who of READERS) {
      const shown = await w.call(WHO[who], "GET", w.path());
      expect(shown.status, `${who}: ${JSON.stringify(shown.body)}`).toBe(200);
      AutomationChainResponseSchema.parse(shown.body);
      const triggers = await w.call(WHO[who], "GET", w.path("/triggers"));
      expect(triggers.status, who).toBe(200);
      expect(AutomationTriggerListResponseSchema.parse(triggers.body).triggers).toHaveLength(1);
      const listed = await w.automations(WHO[who]);
      expect(listed.status, who).toBe(200);
      const parsed = ProjectAutomationsResponseSchema.parse(listed.body);
      expect(parsed.chains.map((row) => row.chainId), who).toEqual([w.chain.chainId]);
      expect(parsed.triggers, who).toHaveLength(1);
      expect(parsed.triggers[0]!.targetName, who).toBe(w.chain.name);
      expect(parsed.canEdit, who).toBe(EDITORS.includes(who));
    }
    for (const who of HIDDEN) {
      expect((await w.call(WHO[who], "GET", w.path())).status, who).toBe(404);
      expect((await w.call(WHO[who], "GET", w.path("/triggers"))).status, who).toBe(404);
      expect((await w.automations(WHO[who])).status, who).toBe(404);
    }
  });

  it("shows a project viewer the chain's runs and a run's view, and hides them from someone with no role", async () => {
    const w = await world();
    const started = await w.call(WHO.contributor, "POST", w.path("/runs"), { project: "web" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = String((started.body["run"] as { runId: string }).runId);
    const listed = await w.call(WHO.viewer, "GET", "/v1/app/chain-runs?project=web");
    expect(listed.status).toBe(200);
    expect(ChainRunListSchema.parse(listed.body).runs.map((run) => run.sessionId)).toEqual([runId]);
    expect((await w.call(WHO.viewer, "GET", `/v1/app/chain-runs/${runId}`)).status).toBe(200);
    expect((await w.call(WHO.member, "GET", `/v1/app/chain-runs/${runId}`)).status).toBe(404);
    expect((await w.call(WHO.otherMaintainer, "GET", "/v1/app/chain-runs?project=web")).body).toMatchObject({ runs: [] });
    // A viewer reads; they don't start one.
    expect((await w.call(WHO.viewer, "POST", w.path("/runs"), { project: "web" })).status).toBe(403);
  });

  it("names a trigger's target only for someone who can see it: a member's own chain triggered on web shows its id, not its name, to a viewer", async () => {
    const w = await world();
    const personal = await w.v.publish(ONE_STEP, { budgetUsd: 50, name: "Priya private" });
    await w.v.seed({ target: { kind: "chain", chainId: personal.chainId }, enabled: false });
    const forViewer = ProjectAutomationsResponseSchema.parse((await w.automations(WHO.viewer)).body);
    expect(forViewer.triggers).toHaveLength(1);
    expect(forViewer.triggers[0]!.target).toEqual({ kind: "chain", chainId: personal.chainId });
    expect(forViewer.triggers[0]!.targetName).toBeUndefined();
    expect(JSON.stringify(forViewer)).not.toContain("Priya private");
    expect(forViewer.chains.map((row) => row.chainId)).toEqual([w.chain.chainId]);
    // Its owner, and an admin, see the name (the positive control).
    expect(ProjectAutomationsResponseSchema.parse((await w.automations(caller(PRIYA, "member"))).body).triggers[0]!.targetName).toBe("Priya private");
    expect(ProjectAutomationsResponseSchema.parse((await w.automations(WHO.admin)).body).triggers[0]!.targetName).toBe("Priya private");
  });

  it("parses the project's list with the browser reader, and answers 404 for a project name that is not one", async () => {
    const w = await world();
    const listed = await w.automations(WHO.viewer);
    expect(ProjectAutomationsResponseReaderSchema.safeParse(listed.body).success).toBe(true);
    expect(AutomationChainResponseReaderSchema.safeParse((await w.call(WHO.viewer, "GET", w.path())).body).success).toBe(true);
    expect((await w.automations(WHO.admin, "Not A Project")).status).toBe(404);
    // A name that is not a project name is refused before any key is built from it: the role store is never asked about it.
    expect(w.v.projectMembers.calls).not.toContain("roleOf Not A Project");
    expect((await w.automations(WHO.admin, "nowhere")).status).toBe(404);
  });
});

describe("experience review decision 16: an automation is changed by its project's maintainers, org owners and admins", () => {
  it("lets a maintainer, the org owner and an admin save the draft, set the budget, archive and unarchive; refuses a contributor and a viewer (403), and hides it from the rest (404)", async () => {
    const w = await world();
    for (const who of EDITORS) {
      const draft = await w.call(WHO[who], "PUT", w.path("/draft"), { expectedRevision: (await w.fresh()).draftRevision, definition: ONE_STEP });
      expect(draft.status, `${who}: ${JSON.stringify(draft.body)}`).toBe(200);
      const budget = await w.call(WHO[who], "PUT", w.path("/budget"), { monthlyUsd: 40 });
      expect(budget.status, `${who}: ${JSON.stringify(budget.body)}`).toBe(200);
      expect((await w.call(WHO[who], "POST", w.path("/archive"), {})).status, who).toBe(200);
      expect((await w.call(WHO[who], "POST", w.path("/unarchive"), {})).status, who).toBe(200);
    }
    for (const who of [...SEE_ONLY, ...HIDDEN]) {
      const expected = SEE_ONLY.includes(who) ? 403 : 404;
      const before = await w.fresh();
      expect((await w.call(WHO[who], "PUT", w.path("/draft"), { expectedRevision: before.draftRevision, definition: ONE_STEP })).status, who).toBe(expected);
      expect((await w.call(WHO[who], "PUT", w.path("/budget"), { monthlyUsd: 1 })).status, who).toBe(expected);
      expect((await w.call(WHO[who], "POST", w.path("/archive"), {})).status, who).toBe(expected);
      expect((await w.call(WHO[who], "POST", w.path("/publish"), { expectedDraftRevision: before.draftRevision })).status, who).toBe(expected);
      // Nothing moved.
      expect(await w.fresh()).toMatchObject({ draftRevision: before.draftRevision, status: "active", monthlyBudgetUsd: before.monthlyBudgetUsd });
    }
  });

  it("lets a maintainer create, pause (turn off) and delete a trigger, and refuses everyone else's", async () => {
    const w = await world();
    for (const [index, who] of EDITORS.entries()) {
      const id = ID(String.fromCharCode(97 + index));
      const created = await w.call(WHO[who], "PUT", w.path(`/triggers/${id}`), { project: "web", spec: PR_OPENED, enabled: false });
      expect(created.status, `${who}: ${JSON.stringify(created.body)}`).toBe(201);
      AutomationTriggerWriteResponseSchema.parse(created.body);
      expect((await w.call(WHO[who], "DELETE", w.path(`/triggers/${id}`), {})).status, who).toBe(200);
    }
    const kept = await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId } });
    for (const who of [...SEE_ONLY, ...HIDDEN]) {
      const expected = SEE_ONLY.includes(who) ? 403 : 404;
      expect((await w.call(WHO[who], "PUT", w.path(`/triggers/${ID("z")}`), { project: "web", spec: PR_OPENED, enabled: false })).status, who).toBe(expected);
      expect((await w.call(WHO[who], "PUT", w.path(`/triggers/${kept.triggerId}`), { project: "web", spec: PR_OPENED, enabled: false })).status, who).toBe(expected);
      expect((await w.call(WHO[who], "DELETE", w.path(`/triggers/${kept.triggerId}`), {})).status, who).toBe(expected);
    }
    expect(await w.v.triggers.get(ORG_A, ID("z"))).toBeUndefined();
    expect(await w.v.triggers.get(ORG_A, kept.triggerId)).toMatchObject({ enabled: true });
  });

  it("never lets a share lift someone who is not a maintainer of the owning project above use: an edit share to a contributor, or to another project, changes nothing", async () => {
    const w = await world();
    const shared = await w.call(WHO.admin, "PUT", w.path("/shares"), { shares: [{ principal: { kind: "member", developerId: CARL }, level: "edit" }, { principal: { kind: "project", project: "api" }, level: "edit" }] });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    for (const who of ["contributor", "otherMaintainer"] as const) {
      const shown = await w.call(WHO[who], "GET", w.path());
      expect(shown.status, who).toBe(200);
      expect((shown.body["chain"] as { access: string }).access, who).toBe("use");
      const draft = await w.call(WHO[who], "PUT", w.path("/draft"), { expectedRevision: (await w.fresh()).draftRevision, definition: ONE_STEP });
      expect(draft.status, `${who}: ${JSON.stringify(draft.body)}`).toBe(403);
    }
    // A maintainer of web still holds manage, an admin too.
    expect(((await w.call(WHO.maintainer, "GET", w.path())).body["chain"] as { access: string }).access).toBe("manage");
  });

  it("reads the role live: a maintainer demoted to viewer loses edit at once, and one removed from the project no longer sees the chain", async () => {
    const w = await world();
    expect((await w.call(WHO.maintainer, "PUT", w.path("/budget"), { monthlyUsd: 30 })).status).toBe(200);
    w.v.projectMembers.grant(ORG_A, "web", MAX, "viewer");
    expect((await w.call(WHO.maintainer, "PUT", w.path("/budget"), { monthlyUsd: 31 })).status).toBe(403);
    expect((await w.call(WHO.maintainer, "GET", w.path())).status).toBe(200);
    w.v.projectMembers.revoke(ORG_A, "web", MAX);
    expect((await w.call(WHO.maintainer, "GET", w.path())).status).toBe(404);
  });
});

describe("decision 92: a company-shared automation", () => {
  it("changes owner or accountable maintainer only by an org owner or admin", async () => {
    const w = await world();
    // Not shared: the maintainer may hand it to another maintainer of web.
    expect((await w.call(WHO.maintainer, "PUT", w.path("/accountable"), { accountable: { developerId: MAX } })).status).toBe(200);
    await w.companyShare();
    const before = await w.fresh();
    const refused = await w.call(WHO.maintainer, "PUT", w.path("/accountable"), { accountable: { developerId: MAX } });
    expect(refused).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(String(refused.body["message"])).toContain("shared with your whole company");
    expect((await w.call(WHO.maintainer, "PUT", w.path("/owner"), { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } })).status).toBe(403);
    expect(await w.fresh()).toMatchObject({ owner: before.owner, accountable: before.accountable });
    expect((await w.call(WHO.admin, "PUT", w.path("/accountable"), { accountable: { developerId: MAX } })).status).toBe(200);
    expect((await w.call(WHO.owner, "PUT", w.path("/owner"), { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } })).status).toBe(200);
  });

  it("turns a trigger on only when an org owner or admin confirms it: the request asks them alone, and a maintainer's say-so is refused", async () => {
    const w = await world();
    await w.companyShare();
    const asked = await w.call(WHO.maintainer, "PUT", w.path(`/triggers/${ID("a")}`), { project: "web", spec: PR_OPENED });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const approvalId = String(asked.body["confirmUrl"]).split("/").pop()!;
    const record = await w.v.approval(approvalId) as ApprovalRecord;
    expect(record.approvers).toMatchObject({ kind: "rule", rule: "trigger_enable" });
    const candidates = record.approvers.kind === "rule" ? record.approvers.candidates : [];
    expect(candidates).toContain(DANA);
    expect(candidates).not.toContain(MAX);
    const rule = getApproverRule("trigger_enable")!;
    expect(await rule(w.v.deps, record, WHO.maintainer)).toBe(false);
    expect(await rule(w.v.deps, record, WHO.admin)).toBe(true);
    expect(await rule(w.v.deps, record, WHO.owner)).toBe(true);
    expect((await w.v.triggers.get(ORG_A, ID("a")))?.enabled).toBe(false);
  });

  it("lets the project's maintainer confirm the same turn-on while the chain is not company-shared (the positive control)", async () => {
    const w = await world();
    const asked = await w.call(WHO.maintainer, "PUT", w.path(`/triggers/${ID("a")}`), { project: "web", spec: PR_OPENED });
    expect(asked.status).toBe(202);
    const record = await w.v.approval(String(asked.body["confirmUrl"]).split("/").pop()!) as ApprovalRecord;
    expect(await getApproverRule("trigger_enable")!(w.v.deps, record, WHO.maintainer)).toBe(true);
  });
});

describe("what keeps an automation from starting", () => {
  let counter = 0;
  const prEvent = (): TriggerEvent => {
    counter += 1;
    return {
      source: "github", type: "pull_request.opened", eventKey: `gh:pr:9:${String(counter)}:opened`, occurredAt: "2026-10-22T08:59:00.000Z", project: "web",
      subject: { kind: "pull_request", id: `9${String(counter)}`, title: "Fix it", url: `https://github.com/acme/web/pull/9${String(counter)}` },
      fields: { authorAssociation: ["MEMBER"] }, actor: { kind: "external", id: "alice" },
    };
  };
  const dispatch = (v: TriggerWorld, event: TriggerEvent) => dispatchTriggerEvent(v.routeDeps as unknown as TriggerDispatchDependencies, ORG_A, event);
  const runs = (v: TriggerWorld) => v.db.find((item) => item["entityType"] === "CHAIN_RUN");

  it("starts an enabled trigger's chain (the positive control)", async () => {
    const w = await world();
    const trigger = await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId }, spec: PR_OPENED, createdBy: MAX });
    const outcomes = await dispatch(w.v, prEvent());
    expect(outcomes.map((entry) => [entry.triggerId, entry.outcome])).toEqual([[trigger.triggerId, "started"]]);
    expect(runs(w.v)).toHaveLength(1);
  });

  it("never starts a paused trigger: one turned off is not matched, and one turned off after the match is refused at the start", async () => {
    const w = await world();
    const paused = await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId }, spec: PR_OPENED, createdBy: MAX, enabled: false });
    expect(await dispatch(w.v, prEvent())).toEqual([]);
    expect(await w.v.triggers.listActivity(ORG_A, paused.triggerId)).toEqual([]);
    // The match read the trigger while it was on; it was turned off before the start.
    const racing = await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId }, spec: PR_OPENED, createdBy: MAX });
    await w.v.triggers.update({ trigger: racing, patch: { enabled: false } });
    const refused = await startChainFor(w.v.routeDeps as unknown as TriggerDispatchDependencies, ORG_A, racing, "identity-1", { origin: "event", project: "web", startedBy: { kind: "event", triggerId: racing.triggerId, eventKey: "k" } as never, agentText: "x" })
      .then(() => "started", (error: { code?: string }) => error.code);
    expect(refused).toBe("CHAIN_UNAVAILABLE");
    expect(runs(w.v)).toEqual([]);
  });

  it("never starts an archived (paused) chain from its trigger", async () => {
    const w = await world();
    const trigger = await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId }, spec: PR_OPENED, createdBy: MAX });
    expect((await w.call(WHO.maintainer, "POST", w.path("/archive"), {})).status).toBe(200);
    // Archiving turns the chain's triggers off; even one left on (a write that was lost) starts nothing.
    await w.v.triggers.update({ trigger: (await w.v.triggers.get(ORG_A, trigger.triggerId))!, patch: { enabled: true } });
    const outcomes = await dispatch(w.v, prEvent());
    expect(outcomes.map((entry) => entry.outcome)).not.toContain("started");
    expect(runs(w.v)).toEqual([]);
  });

  it("starts no unattended run where no dollar cap is enforced (no spend admission): the trigger's activity says why", async () => {
    const w = await world({ admission: false });
    const trigger = await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId }, spec: PR_OPENED, createdBy: MAX });
    const outcomes = await dispatch(w.v, prEvent());
    expect(outcomes).toMatchObject([{ triggerId: trigger.triggerId, outcome: "failed", reason: "CHAIN_BUDGET_REQUIRED" }]);
    expect(runs(w.v)).toEqual([]);
    expect(w.v.starts).toEqual([]);
    // A person may still start it by hand: their run is admitted on their own and the project's budget.
    expect((await w.call(WHO.contributor, "POST", w.path("/runs"), { project: "web" })).status).toBe(202);
  });

  it("starts no unattended run of a chain without a monthly budget, even with admission (dispatch's own re-check turns the trigger away first)", async () => {
    const w = await world();
    const unbudgeted = await w.v.publish(ONE_STEP, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, by: DANA, name: "No budget" });
    const trigger = await w.v.seed({ target: { kind: "chain", chainId: unbudgeted.chainId }, spec: PR_OPENED, createdBy: MAX });
    const outcomes = await dispatch(w.v, prEvent());
    expect(outcomes).toMatchObject([{ triggerId: trigger.triggerId, outcome: "failed", reason: "trigger_invalid" }]);
    expect(runs(w.v)).toEqual([]);
    expect(w.v.starts).toEqual([]);
  });
});

describe("with the automations switch off, the people who may stop an automation still can (the safety paths)", () => {
  let counter = 0;
  const prEvent = (): TriggerEvent => {
    counter += 1;
    return {
      source: "github", type: "pull_request.opened", eventKey: `gh:pr:7:${String(counter)}:opened`, occurredAt: "2026-10-22T08:59:00.000Z", project: "web",
      subject: { kind: "pull_request", id: `7${String(counter)}`, title: "Fix it", url: `https://github.com/acme/web/pull/7${String(counter)}` },
      fields: { authorAssociation: ["MEMBER"] }, actor: { kind: "external", id: "alice" },
    };
  };
  const OFF = { safetyOnly: true } as const;
  /** A running trigger on the world's chain, and the body that turns exactly it off. */
  async function running() {
    const w = await world();
    const trigger = await w.v.seed({ target: { kind: "chain", chainId: w.chain.chainId }, spec: PR_OPENED, createdBy: MAX });
    const offBody = { project: "web", spec: PR_OPENED, enabled: false };
    const dispatch = () => dispatchTriggerEvent(w.v.routeDeps as unknown as TriggerDispatchDependencies, ORG_A, prEvent());
    return { w, trigger, offBody, dispatch, triggerPath: w.path(`/triggers/${trigger.triggerId}`) };
  }

  for (const who of ["owner", "maintainer"] as const) {
    it(`lets the ${who} turn a running trigger off, after which dispatch starts nothing; delete it; and archive its chain`, async () => {
      const { w, trigger, offBody, dispatch, triggerPath } = await running();
      expect((await dispatch()).map((entry) => entry.outcome)).toEqual(["started"]);
      const off = await w.call(WHO[who], "PUT", triggerPath, offBody, OFF);
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(await w.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false });
      expect(await dispatch()).toEqual([]);
      expect((await w.call(WHO[who], "DELETE", triggerPath, {}, OFF)).status).toBe(200);
      expect(await w.v.triggers.get(ORG_A, trigger.triggerId)).toBeUndefined();
      expect((await w.call(WHO[who], "POST", w.path("/archive"), {}, OFF)).status).toBe(200);
      expect((await w.fresh()).status).toBe("archived");
    });
  }

  it("refuses a viewer and a contributor all of it, and hides it from someone with no role", async () => {
    const { w, trigger, offBody, triggerPath } = await running();
    for (const who of ["viewer", "contributor", "member", "otherOrg"] as const) {
      const expected = who === "viewer" || who === "contributor" ? 403 : 404;
      expect((await w.call(WHO[who], "PUT", triggerPath, offBody, OFF)).status, who).toBe(expected);
      expect((await w.call(WHO[who], "DELETE", triggerPath, {}, OFF)).status, who).toBe(expected);
      expect((await w.call(WHO[who], "POST", w.path("/archive"), {}, OFF)).status, who).toBe(expected);
    }
    expect(await w.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: true });
    expect((await w.fresh()).status).toBe("active");
  });

  it("keeps every other write the unknown path's 404 while off, for an admin too: a create, a turn-on, a change of what the trigger is, a publish, an unarchive, a draft", async () => {
    const { w, trigger, offBody, triggerPath } = await running();
    await w.v.triggers.update({ trigger, patch: { enabled: false } });
    const notFound = { status: 404, body: { code: "NOT_FOUND", message: "NOT_FOUND: route not found" } };
    const tries: Array<[string, string, Record<string, unknown>]> = [
      ["PUT", w.path(`/triggers/${ID("n")}`), { project: "web", spec: PR_OPENED, enabled: false }],
      ["PUT", triggerPath, { ...offBody, enabled: true }],
      ["PUT", triggerPath, { project: "web", spec: PR_OPENED }],
      ["PUT", triggerPath, { ...offBody, spec: { ...PR_OPENED, type: "pull_request.ready_for_review" } }],
      ["PUT", triggerPath, { ...offBody, maxRunsPerHour: 59 }],
      ["PUT", triggerPath, { ...offBody, project: "api" }],
      ["POST", w.path("/publish"), { expectedDraftRevision: (await w.fresh()).draftRevision }],
      ["POST", w.path("/unarchive"), {}],
      ["PUT", w.path("/draft"), { expectedRevision: (await w.fresh()).draftRevision, definition: ONE_STEP }],
      ["PUT", w.path("/budget"), { monthlyUsd: 10 }],
      ["POST", w.path("/runs"), { project: "web" }],
      ["GET", w.path(), {}],
      ["GET", w.path("/triggers"), {}],
      ["GET", triggerPath, {}],
      ["POST", triggerPath, offBody],
      ["GET", `${triggerPath}/activity`, {}],
      ["POST", "/v1/app/chains", { name: "New" }],
    ];
    for (const who of ["admin", "owner"] as const) {
      for (const [method, path, body] of tries) expect(await w.call(WHO[who], method, path, method === "GET" ? undefined : body, OFF), `${who} ${method} ${path} ${JSON.stringify(body)}`).toEqual(notFound);
    }
    expect(await w.v.triggers.get(ORG_A, ID("n"))).toBeUndefined();
    expect(await w.v.triggers.get(ORG_A, trigger.triggerId)).toMatchObject({ enabled: false, spec: PR_OPENED, maxRunsPerHour: trigger.maxRunsPerHour });
    // The same turn-on with the switch on is a real request (the positive control).
    expect((await w.call(WHO.admin, "PUT", triggerPath, { ...offBody, enabled: true })).status).toBe(202);
  });

  it("records a trigger that was turned off before its start as skipped, not failed", async () => {
    const { w, trigger } = await running();
    const deps = w.v.routeDeps as unknown as TriggerDispatchDependencies;
    // The match read it on; it is turned off before the start: the refusal is a pause.
    let turnedOff = false;
    const realGet = w.v.triggers.get.bind(w.v.triggers);
    w.v.triggers.get = async (orgId, triggerId) => {
      const found = await realGet(orgId, triggerId);
      if (!turnedOff && found !== undefined && triggerId === trigger.triggerId) {
        turnedOff = true;
        await w.v.triggers.update({ trigger: found, patch: { enabled: false } });
        return realGet(orgId, triggerId);
      }
      return found;
    };
    const outcomes = await dispatchTriggerEvent(deps, ORG_A, prEvent());
    expect(turnedOff).toBe(true);
    expect(outcomes).toMatchObject([{ triggerId: trigger.triggerId, outcome: "skipped", reason: "trigger_turned_off" }]);
    expect((await w.v.triggers.listActivity(ORG_A, trigger.triggerId)).map((entry) => [entry.outcome, entry.reason])).toEqual([["skipped", "trigger_turned_off"]]);
    expect(w.v.db.find((item) => item["entityType"] === "CHAIN_RUN")).toEqual([]);
  });
});
