// Lane S1 (register items C98, C99, C106): the agent and chain admin routes hold the person to what they were checked for at the moment the write commits.
//   C98: a chain's owner change looks at its triggers again for the new owner.
//   C99: a new accountable maintainer is checked as a member in the SAME transaction as the write, not only at the route.
//   C106: archive carries the actor fence and the manage snapshot that unarchive already had.
// Each race test changes the world at the moment the broker's own transaction is sent, so a check made earlier cannot see it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentKey, chainKey, developerOrgKey, orgMemberKey, orgMetaKey, orgProjectCatalogKey, projectMemberKey, projectRevisionKey } from "@agentx/contracts";
import { ADA, BEN, CARL, DEB, TRIAGE, ORG_B, person, setup, type World } from "../support/spend-world.js";
import { seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fixtureActor } from "../support/money-authority.js";
import { ChainStore } from "../../packages/broker/src/chains/store.js";
import { TriggerStore } from "../../packages/broker/src/triggers/store.js";
import { TriggerSpecSchema } from "../../packages/contracts/src/agent-recipe.js";
import { ARJUN, DANA, MAX, ORG_A, setupTriggerWorld } from "../support/trigger-world.js";
import { TEST_ORG } from "../support/orgs.js";

/** A maintainer of payments other than Ben: someone the accountable seat can move to. */
const FAY = person("8", "Fay Maintainer");
/** A member with no role on payments at all. */
const EVE = person("7", "Eve Nogrant");
/** A member of the other org only. */
const OUTSIDER = person("9", "Orla Outsider");

type Kind = "agent" | "chain";
const pathOf = (kind: Kind, id: string) => `/v1/app/${kind === "agent" ? "agents" : "chains"}/${id}`;

async function addMember(t: World, who: Developer, role: "owner" | "admin" | "member", grant?: "maintainer" | "contributor") {
  t.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  t.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  await t.orgOf(who);
  seedMembership(t.db, who.developerId, { orgId: TEST_ORG, role });
  if (grant !== undefined) t.grantRole(who, grant);
}

/** A project-owned agent or chain of payments (Ben accountable) with a monthly budget; `archived` leaves it archived. */
async function fixture(kind: Kind, options: { archived?: boolean } = {}) {
  const t = await setup({ decide: true });
  await addMember(t, FAY, "member", "maintainer");
  await addMember(t, EVE, "member");
  let id: string;
  if (kind === "agent") id = await t.agentOf(TRIAGE, { by: BEN, owner: { kind: "project", project: "payments" }, accountable: BEN });
  else {
    const created = await t.api(BEN, "POST", "/v1/app/chains", { name: `Fence ${randomUUID().slice(0, 8)}`, owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = (created.body.chain as { chainId: string }).chainId;
  }
  const path = pathOf(kind, id);
  expect((await t.api(ADA, "PUT", path + "/budget", { monthlyUsd: 10 })).status).toBe(200);
  if (options.archived === true) expect((await t.api(DEB, "POST", path + "/archive", {})).status).toBe(200);
  const key = kind === "agent" ? agentKey(TEST_ORG, id, "META") : chainKey(TEST_ORG, id, "META");
  const events = () => t.db.find(row => row.pk === key.pk && typeof row.sk === "string" && row.sk.startsWith("EVENT#")).map(row => String(row.kind));
  const receipts = () => t.db.find(row => row.entityType === "AGENT_REQUEST").length;
  const store = kind === "agent" ? t.deps().store : new ChainStore({ documentClient: t.db, tableName: "state", now: Date.now, agents: t.deps().store });
  const state = () => ({ resource: t.db.get(key), events: events(), receipts: receipts() });
  /** Runs `mutate` once, just before the first transaction that writes this resource is sent. */
  const raceOnce = (mutate: () => void) => {
    const send = t.db.send.bind(t.db);
    const seen = { raced: false };
    t.db.send = async command => {
      if (!seen.raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => {
        const itemKey = item.Update?.Key ?? item.ConditionCheck?.Key;
        return itemKey?.pk === key.pk && itemKey.sk === key.sk;
      })) { seen.raced = true; mutate(); }
      return send(command);
    };
    return seen;
  };
  return { t, id, path, key, store, state, events, raceOnce };
}

const ACTOR_LOSSES = ["member_removed", "member_role", "pointer_removed", "pointer_moved", "org_closing", "org_closed"] as const;
type ActorLoss = typeof ACTOR_LOSSES[number];
/** Takes `who`'s company access away in the way `loss` names (the actor is Deb, an admin). */
function lose(t: World, loss: ActorLoss, who: Developer = DEB) {
  if (loss === "member_removed") t.db.delete(orgMemberKey(TEST_ORG, who.developerId));
  if (loss === "member_role") t.db.set({ ...t.db.get(orgMemberKey(TEST_ORG, who.developerId)), role: "member" });
  if (loss === "pointer_removed") t.db.delete(developerOrgKey(who.developerId));
  if (loss === "pointer_moved") t.db.set({ ...t.db.get(developerOrgKey(who.developerId)), orgId: ORG_B });
  if (loss === "org_closing") t.db.set({ ...t.db.get(orgMetaKey(TEST_ORG)), closingAt: "now" });
  if (loss === "org_closed") t.db.set({ ...t.db.get(orgMetaKey(TEST_ORG)), closedAt: "now" });
}

// ---- C106: archive

for (const kind of ["agent", "chain"] as const) {
  describe(`C106: ${kind} archive is fenced like unarchive`, () => {
    for (const loss of ACTOR_LOSSES) {
      it(`an active ${kind} refuses an archive by someone who lost access (${loss}) at its actual transaction`, async () => {
        const f = await fixture(kind);
        const before = f.state();
        const race = f.raceOnce(() => lose(f.t, loss));
        const reply = await f.t.api(DEB, "POST", f.path + "/archive", { requestId: randomUUID() });
        expect(race.raced).toBe(true);
        expect(reply.status, JSON.stringify(reply.body)).toBe(403);
        expect(f.state()).toEqual(before);
      });
    }

    // F4: the access is lost in the race window of an archive of something already archived: there is no transaction to race, so the answer is the same 200 and nothing is written.
    for (const loss of ACTOR_LOSSES) {
      it(`an already archived ${kind} answers 200 and writes nothing when the archiving person loses access (${loss}) between the route and the store`, async () => {
        const f = await fixture(kind, { archived: true });
        const before = f.state();
        const send = f.t.db.send.bind(f.t.db);
        let written = 0, lost = false;
        f.t.db.send = async command => {
          // The first read of the resource after the route's own is the store's; the access is lost just before it.
          if (command instanceof TransactWriteCommand) written += 1;
          const reply = await send(command);
          if (!lost && (command as { input?: { Key?: { pk?: string; sk?: string } } }).input?.Key?.pk === f.key.pk && (command as { input?: { Key?: { sk?: string } } }).input?.Key?.sk === f.key.sk) { lost = true; lose(f.t, loss); }
          return reply;
        };
        const reply = await f.t.api(DEB, "POST", f.path + "/archive", { requestId: randomUUID() });
        expect(lost).toBe(true);
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        expect(written).toBe(0);
        expect(f.state()).toEqual(before);
      });
    }

    // L6: an archive of something already archived changes nothing, so it writes nothing: no update, no receipt, no event, and no transaction to refuse.
    it(`an archive of an already archived ${kind} writes nothing at all, with or without a request`, async () => {
      const f = await fixture(kind, { archived: true });
      const before = f.state();
      const sent: string[] = [];
      const send = f.t.db.send.bind(f.t.db);
      f.t.db.send = async command => { if (command instanceof TransactWriteCommand) sent.push("transaction"); return send(command); };
      const reply = await f.t.api(DEB, "POST", f.path + "/archive", { requestId: randomUUID() });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const archived = await f.store.archive(TEST_ORG, f.id, DEB.developerId, undefined, { actor: fixtureActor(f.t.db, TEST_ORG, DEB.developerId) });
      expect(archived.status).toBe("archived");
      expect(sent).toEqual([]);
      expect(f.state()).toEqual(before);
    });

    it(`archives for an allowed actor, and emits its event once`, async () => {
      const f = await fixture(kind);
      const before = f.events();
      const requestId = randomUUID();
      const reply = await f.t.api(DEB, "POST", f.path + "/archive", { requestId });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(f.t.db.get(f.key)?.status).toBe("archived");
      expect(f.events()).toEqual([...before, "archived"]);
      // The same request again is answered from its receipt and writes nothing more.
      expect((await f.t.api(DEB, "POST", f.path + "/archive", { requestId })).status).toBe(200);
      expect(f.events()).toEqual([...before, "archived"]);
    });

    it(`answers an archive of an archived ${kind} for an allowed actor as before`, async () => {
      const f = await fixture(kind, { archived: true });
      const events = f.events();
      expect((await f.t.api(DEB, "POST", f.path + "/archive", {})).status).toBe(200);
      expect(f.events()).toEqual(events);
      expect(f.t.db.get(f.key)?.status).toBe("archived");
    });

    it(`refuses a person without manage access, and a ${kind} of another org, without writing`, async () => {
      const f = await fixture(kind);
      const before = f.state();
      const contributor = await f.t.api(CARL, "POST", f.path + "/archive", {});
      expect([403, 404]).toContain(contributor.status);
      const missing = await f.t.api(DEB, "POST", pathOf(kind, kind === "agent" ? "agt_" + "z".repeat(20) : "chn_" + "z".repeat(20)) + "/archive", {});
      expect(missing.status).toBe(404);
      expect(f.state()).toEqual(before);
    });

    it(`the store refuses an archive that carries a request but no actor, and one whose actor is not the person archiving`, async () => {
      const f = await fixture(kind);
      const mark = { orgId: TEST_ORG, developerId: DEB.developerId, requestId: randomUUID(), fingerprint: "f".repeat(64) };
      await expect(f.store.archive(TEST_ORG, f.id as never, DEB.developerId, mark)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(f.store.archive(TEST_ORG, f.id as never, DEB.developerId, mark, { actor: { developerId: ADA.developerId, role: "owner" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.t.db.get(f.key)?.status).toBe("active");
    });

    it(`the store refuses an archive whose manage snapshot is no longer the ${kind}'s owner, and writes nothing`, async () => {
      const f = await fixture(kind);
      const before = f.state();
      const snapshot = { ...f.t.db.get(f.key)!, owner: { kind: "member", developerId: BEN.developerId } };
      await expect(f.store.archive(TEST_ORG, f.id as never, DEB.developerId, undefined, { actor: { developerId: DEB.developerId, role: "admin" }, manageSnapshot: snapshot as never })).rejects.toMatchObject({ code: expect.stringMatching(/REVISION_CONFLICT$/) as string });
      expect(f.state()).toEqual(before);
    });

    it(`the store refuses an archive with neither a request nor an actor unless Rovara itself (system) asks`, async () => {
      const f = await fixture(kind);
      await expect(f.store.archive(TEST_ORG, f.id as never, DEB.developerId)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.t.db.get(f.key)?.status).toBe("active");
      expect(await f.store.archive(TEST_ORG, f.id as never, "system")).toMatchObject({ status: "archived" });
    });
  });
}

// ---- C99: the destination of an accountable change

const GRANT_LOSSES = ["member_removed", "pointer_removed", "pointer_moved", "grant_demoted", "grant_removed"] as const;
function loseDestination(t: World, loss: typeof GRANT_LOSSES[number], who: Developer = FAY) {
  if (loss === "member_removed") t.db.delete(orgMemberKey(TEST_ORG, who.developerId));
  if (loss === "pointer_removed") t.db.delete(developerOrgKey(who.developerId));
  if (loss === "pointer_moved") t.db.set({ ...t.db.get(developerOrgKey(who.developerId)), orgId: ORG_B });
  if (loss === "grant_demoted") t.db.set({ ...t.db.get(projectMemberKey(TEST_ORG, who.developerId, "payments")), projectRole: "contributor" });
  if (loss === "grant_removed") t.db.delete(projectMemberKey(TEST_ORG, who.developerId, "payments"));
}

for (const kind of ["agent", "chain"] as const) {
  describe(`C99: ${kind} accountable is checked at its own transaction`, () => {
    for (const loss of GRANT_LOSSES) {
      it(`refuses a new accountable maintainer who ${loss.replace("_", " ")} at the commit, and leaves ${kind} as it was`, async () => {
        const f = await fixture(kind);
        const before = f.state();
        const race = f.raceOnce(() => loseDestination(f.t, loss));
        const reply = await f.t.api(ADA, "PUT", f.path + "/accountable", { accountable: { developerId: FAY.developerId } });
        expect(race.raced).toBe(true);
        expect(reply.status, JSON.stringify(reply.body)).toBe(400);
        expect(f.state()).toEqual(before);
        expect((f.t.db.get(f.key)?.accountable as { developerId: string }).developerId).toBe(BEN.developerId);
      });
    }

    it("moves the accountable seat to a current maintainer and emits the owner_changed event", async () => {
      const f = await fixture(kind);
      const before = f.events();
      const reply = await f.t.api(ADA, "PUT", f.path + "/accountable", { accountable: { developerId: FAY.developerId } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect((f.t.db.get(f.key)?.accountable as { developerId: string }).developerId).toBe(FAY.developerId);
      expect(f.events()).toEqual([...before, "owner_changed"]);
    });

    it("lets a maintainer take the seat themselves (the actor is also the destination)", async () => {
      const f = await fixture(kind);
      const reply = await f.t.api(FAY, "PUT", f.path + "/accountable", { accountable: { developerId: FAY.developerId } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect((f.t.db.get(f.key)?.accountable as { developerId: string }).developerId).toBe(FAY.developerId);
    });

    it("lets an admin take the seat themselves without a project grant", async () => {
      const f = await fixture(kind);
      const reply = await f.t.api(DEB, "PUT", f.path + "/accountable", { accountable: { developerId: DEB.developerId } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    });

    it("the store refuses a destination that belongs to another org only, with no race at all", async () => {
      const f = await fixture(kind);
      f.t.db.set({ ...orgMemberKey(ORG_B, OUTSIDER.developerId), entityType: "ORG_MEMBER", orgId: ORG_B, developerId: OUTSIDER.developerId, role: "admin", joinedAt: "x" });
      f.t.db.set({ ...developerOrgKey(OUTSIDER.developerId), entityType: "DEVELOPER_ORG", orgId: ORG_B, role: "admin", joinedAt: "x" });
      const before = f.state();
      const actor = fixtureActor(f.t.db, TEST_ORG, ADA.developerId);
      await expect(f.store.setAccountable(TEST_ORG, f.id as never, { developerId: OUTSIDER.developerId }, ADA.developerId, undefined, { actor })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(f.state()).toEqual(before);
    });

    // L1: an actor who names themselves is held to the role the route checked them as (the actor's own checks pin it), not to the role read again by the store.
    // Deb is an admin when the route checks her, a plain member by the time the store reads: her own refusal (403) answers, and not the destination's (400).
    it("answers an actor who names themselves and lost their admin role between the route and the store's read with the actor's refusal", async () => {
      for (const target of ["accountable", "owner"] as const) {
        const f = await fixture(kind);
        const actor = fixtureActor(f.t.db, TEST_ORG, DEB.developerId);
        expect(actor.role).toBe("admin");
        lose(f.t, "member_role");
        const before = f.state();
        const named = target === "accountable"
          ? f.store.setAccountable(TEST_ORG, f.id, { developerId: DEB.developerId }, DEB.developerId, undefined, { actor })
          : f.store.setOwner(TEST_ORG, f.id, { kind: "member", developerId: DEB.developerId }, DEB.developerId, undefined, undefined, { actor });
        await expect(named, target).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(f.state(), target).toEqual(before);
      }
    });

    it("waits for an org admin (202) when the new owner's agent budgets would pass their cap, and changes nothing", async () => {
      const f = await fixture(kind);
      // Eve already holds $95 of the $100 a person may own; this one is $10.
      await f.t.budgeted(50, EVE);
      await f.t.budgeted(45, EVE);
      const before = f.state();
      const waiting = await f.t.api(ADA, "PUT", f.path + "/owner", { owner: { kind: "member", developerId: EVE.developerId } });
      expect(waiting.status, JSON.stringify(waiting.body)).toBe(202);
      expect(waiting.body).toMatchObject({ status: "NEEDS_ADMIN_APPROVAL" });
      expect(f.t.db.get(f.key)?.owner).toEqual({ kind: "project", project: "payments" });
      expect(f.events()).toEqual(before.events);
    });

    it("moves the owner to a current member", async () => {
      const f = await fixture(kind);
      const reply = await f.t.api(ADA, "PUT", f.path + "/owner", { owner: { kind: "member", developerId: EVE.developerId } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(f.t.db.get(f.key)?.owner).toEqual({ kind: "member", developerId: EVE.developerId });
    });

    for (const loss of ["member_removed", "pointer_removed", "pointer_moved"] as const) {
      it(`refuses an owner change to a member who ${loss.replace("_", " ")} at the commit, and leaves ${kind} as it was`, async () => {
        const f = await fixture(kind);
        const before = f.state();
        const race = f.raceOnce(() => loseDestination(f.t, loss, EVE));
        const reply = await f.t.api(ADA, "PUT", f.path + "/owner", { owner: { kind: "member", developerId: EVE.developerId } });
        expect(race.raced).toBe(true);
        expect(reply.status, JSON.stringify(reply.body)).toBe(400);
        expect(f.state()).toEqual(before);
      });
    }

    for (const loss of GRANT_LOSSES) {
      it(`refuses a project owner change whose new accountable maintainer ${loss.replace("_", " ")} at the commit`, async () => {
        const f = await fixture(kind);
        const before = f.state();
        const race = f.raceOnce(() => loseDestination(f.t, loss));
        const reply = await f.t.api(ADA, "PUT", f.path + "/owner", { owner: { kind: "project", project: "payments" }, accountable: { developerId: FAY.developerId } });
        expect(race.raced).toBe(true);
        expect(reply.status, JSON.stringify(reply.body)).toBe(400);
        expect(f.state()).toEqual(before);
      });
    }

    it("lets an admin or the org owner make themselves the owner (the actor is also the destination)", async () => {
      for (const who of [ADA, DEB]) {
        const f = await fixture(kind);
        const reply = await f.t.api(who, "PUT", f.path + "/owner", { owner: { kind: "member", developerId: who.developerId } });
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        expect(f.t.db.get(f.key)?.owner).toEqual({ kind: "member", developerId: who.developerId });
      }
    });

    it("answers a self-assigning actor who loses access at the commit with the actor's refusal (403), not the destination's", async () => {
      const f = await fixture(kind);
      const before = f.state();
      const race = f.raceOnce(() => loseDestination(f.t, "member_removed", FAY));
      const reply = await f.t.api(FAY, "PUT", f.path + "/accountable", { accountable: { developerId: FAY.developerId } });
      expect(race.raced).toBe(true);
      expect(reply.status, JSON.stringify(reply.body)).toBe(403);
      expect(f.state()).toEqual(before);
    });
  });
}

describe("C99: a built-in agent's accountable person is an owner or admin at the commit", () => {
  it("refuses one who stops being an admin at the commit, and accepts a current admin", async () => {
    const t = await setup({ decide: true });
    const send = t.db.send.bind(t.db);
    let raced = false;
    t.db.send = async command => {
      if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => String(item.Update?.Key?.sk ?? item.Put?.Item?.sk ?? "").includes("code-reviewer") || String(item.Update?.Key?.pk ?? item.Put?.Item?.pk ?? "").includes("code-reviewer"))) {
        raced = true;
        t.db.set({ ...t.db.get(orgMemberKey(TEST_ORG, DEB.developerId)), role: "member" });
      }
      return send(command);
    };
    const refused = await t.api(ADA, "PUT", "/v1/app/agents/code-reviewer/accountable", { accountable: { developerId: DEB.developerId } });
    expect(raced).toBe(true);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    t.db.send = send;
    t.db.set({ ...t.db.get(orgMemberKey(TEST_ORG, DEB.developerId)), role: "admin" });
    const accepted = await t.api(ADA, "PUT", "/v1/app/agents/code-reviewer/accountable", { accountable: { developerId: DEB.developerId } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  });
});

// ---- C98: a chain's owner change looks at its triggers again

const ONE_STEP = { start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] };

async function triggeredChain() {
  const t = await setup({ decide: true });
  await addMember(t, EVE, "member");
  await addMember(t, FAY, "member", "maintainer");
  const created = await t.api(BEN, "POST", "/v1/app/chains", { name: `Triggered ${randomUUID().slice(0, 8)}`, definition: ONE_STEP });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const chainId = (created.body.chain as { chainId: string }).chainId;
  const path = `/v1/app/chains/${chainId}`;
  const draft = await t.api(BEN, "GET", `${path}/draft`);
  expect((await t.api(BEN, "POST", `${path}/publish`, { expectedDraftRevision: (draft.body.draft as { revision: number }).revision })).status).toBe(200);
  expect((await t.api(BEN, "PUT", `${path}/budget`, { monthlyUsd: 20 })).status).toBe(200);
  const triggers = new TriggerStore({ documentClient: t.db, tableName: "state", now: Date.now });
  const triggerId = `ctr_${"a".repeat(20)}`;
  await triggers.create({ record: { orgId: TEST_ORG, triggerId, target: { kind: "chain", chainId }, project: "payments", spec: { kind: "event", source: "github", type: "pull_request.opened" }, enabled: true, maxRunsPerHour: 30, createdBy: BEN.developerId } });
  const events = () => t.db.find(row => row.pk === chainKey(TEST_ORG, chainId, "META").pk && typeof row.sk === "string" && row.sk.startsWith("EVENT#")).map(row => String(row.kind));
  return { t, chainId, path, triggers, triggerId, events };
}

describe("C98: a chain's owner change re-checks its triggers under the new owner", () => {
  it("turns off a trigger the new owner cannot run, says which in the answer, and still makes the change", async () => {
    const { t, chainId, path, triggers, triggerId, events } = await triggeredChain();
    expect((await triggers.get(TEST_ORG, triggerId))?.enabled).toBe(true);
    const moved = await t.api(ADA, "PUT", `${path}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(t.db.get(chainKey(TEST_ORG, chainId, "META"))?.owner).toEqual({ kind: "member", developerId: EVE.developerId });
    const disabled = moved.body.disabledTriggers as Array<{ triggerId: string; problems: Array<{ message: string }> }>;
    expect(disabled.map(entry => entry.triggerId)).toEqual([triggerId]);
    expect(disabled[0]!.problems[0]!.message).toContain("can no longer start tasks on payments");
    const after = await triggers.get(TEST_ORG, triggerId);
    expect(after?.enabled).toBe(false);
    expect(after?.disabledReason).toContain("can no longer start tasks on payments");
    // The owner change is still audited, and the trigger's own turn-off is recorded on the chain.
    expect(events()).toEqual(expect.arrayContaining(["owner_changed", "trigger_disabled"]));
    expect((await triggers.listActivity(TEST_ORG, triggerId)).map(row => row.outcome)).toEqual(["disabled"]);
  });

  it("leaves a trigger on when the new owner can run it", async () => {
    const { t, path, triggers, triggerId } = await triggeredChain();
    const moved = await t.api(ADA, "PUT", `${path}/owner`, { owner: { kind: "member", developerId: FAY.developerId } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.disabledTriggers).toEqual([]);
    expect((await triggers.get(TEST_ORG, triggerId))?.enabled).toBe(true);
  });

  it("turns nothing off when the change waits for an admin, or is refused", async () => {
    const { t, path, triggers, triggerId } = await triggeredChain();
    // A person who does not manage the chain is refused before anything is written.
    const refused = await t.api(CARL, "PUT", `${path}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect([403, 404]).toContain(refused.status);
    expect((await triggers.get(TEST_ORG, triggerId))?.enabled).toBe(true);
  });

  it("does not reach a chain of another org", async () => {
    const { t, triggers, triggerId } = await triggeredChain();
    const missing = await t.api(ADA, "PUT", `/v1/app/chains/chn_${"y".repeat(20)}/owner`, { owner: { kind: "member", developerId: EVE.developerId } });
    expect(missing.status).toBe(404);
    expect((await triggers.get(TEST_ORG, triggerId))?.enabled).toBe(true);
  });
});

// ---- M3: an agent's owner change re-checks its triggers too

describe("an agent's owner change re-checks its triggers under the new owner", () => {
  const ISSUE = { kind: "event" as const, source: "github" as const, type: "issues.opened" };
  it("turns off a trigger the new owner cannot run, says which, and leaves one the new owner can run", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20 });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: TriggerSpecSchema.parse(ISSUE) as never });
    for (const who of [DANA, ARJUN, MAX]) fixtureActor(v.db, ORG_A, who);
    const base = `/v1/app/agents/${agent.agentId}`;
    const fine = await v.agentCall(DANA, "PUT", `${base}/owner`, { owner: { kind: "member", developerId: MAX } });
    expect(fine.status, JSON.stringify(fine.body)).toBe(200);
    expect(fine.body["disabledTriggers"]).toBeUndefined();
    expect((await v.triggers.get(ORG_A, trigger.triggerId))?.enabled).toBe(true);
    const moved = await v.agentCall(DANA, "PUT", `${base}/owner`, { owner: { kind: "member", developerId: ARJUN } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((moved.body["disabledTriggers"] as Array<{ triggerId: string }>).map(entry => entry.triggerId)).toEqual([trigger.triggerId]);
    expect((await v.triggers.get(ORG_A, trigger.triggerId))?.enabled).toBe(false);
  });
});

// ---- S1-M2: a maintainer's grant is pinned by the write that rests on it

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Every write on an agent or chain that rests on a project maintainer's manage access: the route call, and the same write straight on the store. */
function grantWrites(kind: Kind): Array<{ name: string; archived?: true; call: [string, string, Record<string, unknown>]; store: (f: Fixture, actor: ReturnType<typeof fixtureActor>, by?: string) => Promise<unknown> }> {
  const by = FAY.developerId;
  return [
    { name: "archive", call: ["POST", "/archive", {}], store: (f, actor, who = by) => f.store.archive(TEST_ORG, f.id, who, undefined, { actor }) },
    { name: "unarchive", archived: true, call: ["POST", "/unarchive", {}], store: (f, actor, who = by) => f.store.unarchive(TEST_ORG, f.id, who, undefined, { actor }) },
    { name: "budget", call: ["PUT", "/budget", { monthlyUsd: 12 }],
      store: (f, actor, who = by) => (kind === "agent" ? (f.store as never as { setBudget(...args: unknown[]): Promise<unknown> }).setBudget(TEST_ORG, f.id, { monthlyUsd: 12 }, who, undefined, { actor }) : (f.store as never as { setBudget(...args: unknown[]): Promise<unknown> }).setBudget(TEST_ORG, f.id, 12, who, undefined, { actor })) },
    // Only an org admin may hand a thing to another member, so a maintainer's owner change keeps the project as owner and names another accountable maintainer.
    { name: "owner change", call: ["PUT", "/owner", { owner: { kind: "project", project: "payments" }, accountable: { developerId: DEB.developerId } }], store: (f, actor, who = by) => f.store.setOwner(TEST_ORG, f.id, { kind: "project", project: "payments" }, who, { developerId: DEB.developerId }, undefined, { actor }) },
    { name: "accountable change", call: ["PUT", "/accountable", { accountable: { developerId: DEB.developerId } }], store: (f, actor, who = by) => f.store.setAccountable(TEST_ORG, f.id, { developerId: DEB.developerId }, who, undefined, { actor }) },
  ];
}
const GRANT_ACTOR_LOSSES = ["grant_removed", "grant_demoted"] as const;
/** How many times, across the transactions sent while `run` runs, `who`'s grant on payments appears as a condition item. DynamoDB rejects a transaction that names an item twice, so 1 means pinned once. */
async function grantChecksSeen(t: World, who: Developer, run: () => Promise<unknown>): Promise<number> {
  const send = t.db.send.bind(t.db);
  const grant = projectMemberKey(TEST_ORG, who.developerId, "payments");
  let seen = 0;
  t.db.send = async command => {
    if (command instanceof TransactWriteCommand) seen += (command.input.TransactItems ?? []).filter(item => item.ConditionCheck?.Key?.pk === grant.pk && item.ConditionCheck.Key.sk === grant.sk).length;
    return send(command);
  };
  try { await run(); } finally { t.db.send = send; }
  return seen;
}

for (const kind of ["agent", "chain"] as const) {
  describe(`S1-M2: a ${kind} write by a project maintainer pins the maintainer's own grant`, () => {
    for (const write of grantWrites(kind)) {
      for (const loss of GRANT_ACTOR_LOSSES) {
        it(`${write.name}: refuses a maintainer whose grant is ${loss.replace("grant_", "")} between the route's read and the commit (403), and writes nothing`, async () => {
          const f = await fixture(kind, write.archived === true ? { archived: true } : {});
          const before = f.state();
          const race = f.raceOnce(() => loseDestination(f.t, loss, FAY));
          const reply = await f.t.api(FAY, write.call[0], f.path + write.call[1], { ...write.call[2], requestId: randomUUID() });
          expect(race.raced).toBe(true);
          expect(reply.status, JSON.stringify(reply.body)).toBe(403);
          expect(f.state()).toEqual(before);
        });

        it(`${write.name}: the store refuses an actor whose grant is already ${loss.replace("grant_", "")} when it reads it, and writes nothing`, async () => {
          const f = await fixture(kind, write.archived === true ? { archived: true } : {});
          const actor = fixtureActor(f.t.db, TEST_ORG, FAY.developerId);
          loseDestination(f.t, loss, FAY);
          const before = f.state();
          await expect(write.store(f, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
          expect(f.state()).toEqual(before);
        });
      }

      it(`${write.name}: a maintainer with a current grant succeeds, and the commit carries a condition on that grant (positive control)`, async () => {
        const f = await fixture(kind, write.archived === true ? { archived: true } : {});
        let reply: { status: number; body: Record<string, unknown> } | undefined;
        const seen = await grantChecksSeen(f.t, FAY, async () => { reply = await f.t.api(FAY, write.call[0], f.path + write.call[1], { ...write.call[2], requestId: randomUUID() }); });
        expect(reply!.status, JSON.stringify(reply!.body)).toBe(200);
        expect(seen).toBe(1);
        expect(f.events().length).toBeGreaterThan(0);
      });

      it(`${write.name}: an org admin with no grant succeeds and adds no grant condition`, async () => {
        const f = await fixture(kind, write.archived === true ? { archived: true } : {});
        let reply: { status: number; body: Record<string, unknown> } | undefined;
        const seen = await grantChecksSeen(f.t, DEB, async () => { reply = await f.t.api(DEB, write.call[0], f.path + write.call[1], { ...write.call[2], requestId: randomUUID() }); });
        expect(reply!.status, JSON.stringify(reply!.body)).toBe(200);
        expect(seen).toBe(0);
      });

      it(`${write.name}: the store refuses a plain member with no grant, and an auditor, on a project's ${kind}, and writes nothing`, async () => {
        const f = await fixture(kind, write.archived === true ? { archived: true } : {});
        const before = f.state();
        const eve = fixtureActor(f.t.db, TEST_ORG, EVE.developerId);
        await expect(write.store(f, eve, EVE.developerId)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(write.store(f, { developerId: FAY.developerId, role: "auditor" })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(f.state()).toEqual(before);
      });
    }

    it(`a person's own member-owned ${kind} rests on their org role alone: no grant is needed or pinned`, async () => {
      const t = await setup({ decide: true });
      await addMember(t, EVE, "member");
      let id: string;
      if (kind === "agent") id = await t.agentOf(TRIAGE, { by: EVE });
      else {
        const created = await t.api(EVE, "POST", "/v1/app/chains", { name: `Mine ${randomUUID().slice(0, 8)}` });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        id = (created.body.chain as { chainId: string }).chainId;
      }
      const key = kind === "agent" ? agentKey(TEST_ORG, id, "META") : chainKey(TEST_ORG, id, "META");
      expect(t.db.get(key)?.owner).toEqual({ kind: "member", developerId: EVE.developerId });
      let reply: { status: number; body: Record<string, unknown> } | undefined;
      const anyGrant = projectMemberKey(TEST_ORG, EVE.developerId, "payments");
      expect(t.db.get(anyGrant)).toBeUndefined();
      const seen = await grantChecksSeen(t, EVE, async () => { reply = await t.api(EVE, "POST", pathOf(kind, id) + "/archive", { requestId: randomUUID() }); });
      expect(reply!.status, JSON.stringify(reply!.body)).toBe(200);
      expect(seen).toBe(0);
      expect(t.db.get(key)?.status).toBe("archived");
    });

    it(`a maintainer who takes the accountable seat themselves still has their grant pinned once (the actor is also the destination)`, async () => {
      const f = await fixture(kind);
      let reply: { status: number; body: Record<string, unknown> } | undefined;
      const seen = await grantChecksSeen(f.t, FAY, async () => { reply = await f.t.api(FAY, "PUT", f.path + "/accountable", { accountable: { developerId: FAY.developerId } }); });
      expect(reply!.status, JSON.stringify(reply!.body)).toBe(200);
      expect(seen).toBe(1);
    });
  });
}

// ---- S1-M2 (I1): moving a thing into a project holds the actor to a maintainer grant on THAT project too

/** Makes `billing` a second project of the org, and Fay (and, if asked, Eve) a maintainer of it. */
function addBilling(t: World, maintainers: Developer[]) {
  const revision = t.db.get(projectRevisionKey(TEST_ORG, "payments", 1));
  expect(revision, "the world registers payments at revision 1").toBeDefined();
  t.db.set({ ...revision!, ...projectRevisionKey(TEST_ORG, "billing", 1), name: "billing", definition: { ...(revision!["definition"] as Record<string, unknown>), name: "billing" } });
  t.db.set({ ...orgProjectCatalogKey(TEST_ORG, "billing"), entityType: "PROJECT_CATALOG", name: "billing", latestRevision: 1 });
  for (const who of maintainers) t.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "billing"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "billing", grantId: randomUUID(), role: "developer", projectRole: "maintainer" });
}
const intoBilling = { owner: { kind: "project", project: "billing" }, accountable: { developerId: DEB.developerId } };

for (const kind of ["agent", "chain"] as const) {
  describe(`S1-M2 (I1): a ${kind} moved into another project pins the actor's grant on the destination`, () => {
    for (const loss of GRANT_ACTOR_LOSSES) {
      it(`a cross-project move (payments to billing) is refused when the actor's billing grant is ${loss.replace("grant_", "")} between the route and the commit, and nothing is written`, async () => {
        const f = await fixture(kind);
        addBilling(f.t, [FAY]);
        const before = f.state();
        const race = f.raceOnce(() => {
          if (loss === "grant_removed") f.t.db.delete(projectMemberKey(TEST_ORG, FAY.developerId, "billing"));
          else f.t.db.set({ ...f.t.db.get(projectMemberKey(TEST_ORG, FAY.developerId, "billing")), projectRole: "contributor" });
        });
        const reply = await f.t.api(FAY, "PUT", f.path + "/owner", intoBilling);
        expect(race.raced).toBe(true);
        expect(reply.status, JSON.stringify(reply.body)).toBe(403);
        expect(f.state()).toEqual(before);
        expect(f.t.db.get(f.key)?.owner).toEqual({ kind: "project", project: "payments" });
      });

      it(`a member's own ${kind} moved into a project is refused when the actor's grant there is ${loss.replace("grant_", "")} between the route and the commit, and nothing is written`, async () => {
        const t = await setup({ decide: true });
        await addMember(t, EVE, "member");
        addBilling(t, [EVE]);
        let id: string;
        if (kind === "agent") id = await t.agentOf(TRIAGE, { by: EVE });
        else {
          const created = await t.api(EVE, "POST", "/v1/app/chains", { name: `Mine ${randomUUID().slice(0, 8)}` });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
          id = (created.body.chain as { chainId: string }).chainId;
        }
        const key = kind === "agent" ? agentKey(TEST_ORG, id, "META") : chainKey(TEST_ORG, id, "META");
        const own = () => ({ rows: t.db.find(row => row.pk === key.pk), receipts: t.db.find(row => row.entityType === "AGENT_REQUEST").length });
        const before = own();
        const send = t.db.send.bind(t.db);
        let raced = false;
        t.db.send = async command => {
          if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Update?.Key?.pk === key.pk && item.Update.Key.sk === key.sk)) {
            raced = true;
            if (loss === "grant_removed") t.db.delete(projectMemberKey(TEST_ORG, EVE.developerId, "billing"));
            else t.db.set({ ...t.db.get(projectMemberKey(TEST_ORG, EVE.developerId, "billing")), projectRole: "contributor" });
          }
          return send(command);
        };
        const reply = await t.api(EVE, "PUT", pathOf(kind, id) + "/owner", intoBilling);
        expect(raced).toBe(true);
        expect(reply.status, JSON.stringify(reply.body)).toBe(403);
        expect(own()).toEqual(before);
        expect(t.db.get(key)?.owner).toEqual({ kind: "member", developerId: EVE.developerId });
      });
    }

    it("a maintainer of both projects moves it across, and the commit pins exactly the source and the destination grants (positive control)", async () => {
      const f = await fixture(kind);
      addBilling(f.t, [FAY]);
      const send = f.t.db.send.bind(f.t.db);
      const pinned: string[] = [];
      f.t.db.send = async command => {
        if (command instanceof TransactWriteCommand) {
          const items = (command.input.TransactItems ?? []).filter(item => String(item.ConditionCheck?.Key?.["pk"]).includes(FAY.developerId) && String(item.ConditionCheck?.Key?.["sk"]).includes("PROJECT"));
          // Item occurrences, not transactions: a transaction that named one grant twice would be rejected by DynamoDB, so each key is counted here.
          pinned.push(...items.map(item => `${String(item.ConditionCheck?.Key?.["pk"])}|${String(item.ConditionCheck?.Key?.["sk"])}`));
        }
        return send(command);
      };
      const reply = await f.t.api(FAY, "PUT", f.path + "/owner", intoBilling);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(f.t.db.get(f.key)?.owner).toEqual({ kind: "project", project: "billing" });
      const expected = ["payments", "billing"].map(project => { const k = projectMemberKey(TEST_ORG, FAY.developerId, project); return `${k.pk}|${k.sk}`; });
      expect(pinned.sort()).toEqual(expected.sort());
    });

    it("an actor who maintains only the source project is refused the move at the route, and nothing is written", async () => {
      const f = await fixture(kind);
      addBilling(f.t, []);
      const before = f.state();
      const reply = await f.t.api(FAY, "PUT", f.path + "/owner", intoBilling);
      expect(reply.status, JSON.stringify(reply.body)).toBe(403);
      expect(f.state()).toEqual(before);
    });

    it("the store refuses the move for an actor with no destination grant even when the route's check is skipped, and an admin needs none", async () => {
      const f = await fixture(kind);
      addBilling(f.t, []);
      const before = f.state();
      const fay = fixtureActor(f.t.db, TEST_ORG, FAY.developerId);
      await expect(f.store.setOwner(TEST_ORG, f.id as never, { kind: "project", project: "billing" }, FAY.developerId, { developerId: DEB.developerId }, undefined, { actor: fay })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.state()).toEqual(before);
      const deb = fixtureActor(f.t.db, TEST_ORG, DEB.developerId);
      await f.store.setOwner(TEST_ORG, f.id, { kind: "project", project: "billing" }, DEB.developerId, { developerId: DEB.developerId }, undefined, { actor: deb });
      expect(f.t.db.get(f.key)?.owner).toEqual({ kind: "project", project: "billing" });
    });
  });
}

// ---- Cross-org, with a real resource on each side

for (const kind of ["agent", "chain"] as const) {
  describe(`${kind}: a person of another org cannot reach it, and cannot be named on it`, () => {
    /** Orla is an admin of ORG_B only; Ben and Ada belong to the install's org. */
    async function twoOrgs() {
      const t = await setup({ decide: true, orgResolver: async session => (session.developerId === OUTSIDER.developerId ? ORG_B : TEST_ORG) });
      t.db.set({ pk: `SESSION#${OUTSIDER.sessionId}`, sk: "META", sessionId: OUTSIDER.sessionId, developerId: OUTSIDER.developerId, amr: OUTSIDER.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
      t.db.set({ pk: `DEVELOPER#${OUTSIDER.developerId}`, sk: "META", developerId: OUTSIDER.developerId, provider: OUTSIDER.provider, displayName: OUTSIDER.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
      await t.orgOf(OUTSIDER);
      seedMembership(t.db, OUTSIDER.developerId, { orgId: ORG_B, role: "admin" });
      return t;
    }
    const calls = (outsider: string): Array<[string, string, Record<string, unknown>]> => [
      ["POST", "/archive", {}], ["POST", "/unarchive", {}],
      ["PUT", "/owner", { owner: { kind: "member", developerId: outsider } }],
      ["PUT", "/owner", { owner: { kind: "project", project: "payments" }, accountable: { developerId: outsider } }],
      ["PUT", "/accountable", { accountable: { developerId: outsider } }],
      ["PUT", "/budget", { monthlyUsd: 1 }],
    ];
    const rows = (t: World) => t.db.find(() => true).length;
    const metaOf = (t: World, id: string, org: typeof TEST_ORG) => JSON.stringify(t.db.get(kind === "agent" ? agentKey(org, id, "META") : chainKey(org, id, "META")));

    it("refuses an admin of the other org on a real resource, and writes nothing", async () => {
      const t = await twoOrgs();
      let id: string;
      if (kind === "agent") id = await t.agentOf(TRIAGE, { by: BEN, owner: { kind: "project", project: "payments" }, accountable: BEN });
      else {
        const created = await t.api(BEN, "POST", "/v1/app/chains", { name: `Mine ${randomUUID().slice(0, 8)}`, owner: { kind: "project", project: "payments" }, accountable: { developerId: BEN.developerId } });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        id = (created.body.chain as { chainId: string }).chainId;
      }
      const before = metaOf(t, id, TEST_ORG), count = rows(t);
      for (const [method, suffix, body] of calls(OUTSIDER.developerId)) {
        const reply = await t.api(OUTSIDER, method, pathOf(kind, id) + suffix, body);
        expect([403, 404], `${method} ${suffix}: ${JSON.stringify(reply.body)}`).toContain(reply.status);
      }
      // An admin of this org cannot name that person as an owner or accountable maintainer either.
      for (const [method, suffix, body] of calls(OUTSIDER.developerId).slice(2, 5)) {
        const reply = await t.api(ADA, method, pathOf(kind, id) + suffix, body);
        expect([400, 403, 404], `${method} ${suffix}: ${JSON.stringify(reply.body)}`).toContain(reply.status);
      }
      expect(metaOf(t, id, TEST_ORG)).toBe(before);
      expect(rows(t)).toBe(count);
    });

    it("answers an admin of this org who asks about the other org's real resource with not found, and leaves it as it was", async () => {
      const t = await twoOrgs();
      const created = await t.api(OUTSIDER, "POST", kind === "agent" ? "/v1/app/agents" : "/v1/app/chains", kind === "agent"
        ? { name: `Theirs ${randomUUID().slice(0, 8)}`, overlay: TRIAGE }
        : { name: `Theirs ${randomUUID().slice(0, 8)}` });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = kind === "agent" ? (created.body.agent as { agentId: string }).agentId : (created.body.chain as { chainId: string }).chainId;
      expect(t.db.get(kind === "agent" ? agentKey(ORG_B, id as never, "META") : chainKey(ORG_B, id as never, "META"))).toBeDefined();
      const before = metaOf(t, id, ORG_B), count = rows(t);
      for (const [method, suffix, body] of calls(BEN.developerId)) {
        const reply = await t.api(ADA, method, pathOf(kind, id) + suffix, body);
        expect(reply.status, `${method} ${suffix}: ${JSON.stringify(reply.body)}`).toBe(404);
      }
      expect(metaOf(t, id, ORG_B)).toBe(before);
      expect(rows(t)).toBe(count);
    });
  });
}

describe("an agent's trigger check that fails after the change was made (L5)", () => {
  it("answers the change that was made, not a 500, and logs a fixed event through the route dependencies' logger, without the error's text", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, { kind: "event" as const, source: "github" as const, type: "issues.opened" }], { budgetUsd: 20 });
    for (const who of [DANA, MAX]) fixtureActor(v.db, ORG_A, who);
    vi.spyOn(v.routeDeps.triggerHooks!, "recheckTriggersForTarget").mockRejectedValue(Object.assign(new Error("secret detail the log must not carry"), { name: "ThrottlingException" }));
    const logged: Array<{ event: string; detail: Record<string, unknown> }> = [];
    v.routeDeps.log = (event, detail) => { logged.push({ event, detail }); };
    try {
      const moved = await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/owner`, { owner: { kind: "member", developerId: MAX } });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body["disabledTriggers"]).toBeUndefined();
      expect((await v.routeDeps.store.get(ORG_A, agent.agentId))?.owner).toEqual({ kind: "member", developerId: MAX });
      const failed = logged.filter(entry => entry.event === "trigger_recheck.failed");
      expect(failed).toEqual([{ event: "trigger_recheck.failed", detail: { targetKind: "agent", targetId: agent.agentId, error: "ThrottlingException" } }]);
      expect(JSON.stringify(logged)).not.toContain("secret detail");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
