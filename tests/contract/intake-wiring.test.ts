// Meta repo lane F: the broker's ports under the intake engine, and the maintainers' notice. Who a tracker account is comes only from a link the org holds (GitHub: the account-to-member
// link), read in the org asked about and again live; the role on the project is read now; the notice is fixed words and ids.
import { describe, expect, it } from "vitest";
import { intakeNoticeKey, intakeItemIdOf, type OrgId } from "@rovara-code/contracts";
import { bindSessionSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { linkGithubMember } from "../../packages/broker/src/rovara-code/github-members.js";
import { intakePortsOf, type IntakeWiring } from "../../packages/broker/src/intake/wiring.js";
import { INTAKE_NOTICE_RECIPIENTS_MAX, intakeNoticeText, writeIntakeNotice } from "../../packages/broker/src/intake/notices.js";
import { ARJUN, MIA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

const notice = (over: Record<string, unknown> = {}) => ({ code: "source_failing" as const, orgId: ORG_A, project: "web", sourceId: "abc123", system: "sim", failingMinutes: 75, lastError: "SEARCH_FAILED", ...over });

function ports(options: { removed?: Set<string>; resolvers?: IntakeWiring["accountResolvers"] } = {}) {
  const w = sessionWorld();
  const starts: Array<{ developerId: string }> = [];
  const wiring: IntakeWiring = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now,
    starter: {
      callerFor: async (orgId: OrgId, developerId: string) => (options.removed?.has(developerId) === true || orgId !== ORG_A ? undefined : { developerId, orgId, orgRole: "member", name: "x", sessionId: "s", amr: "oidc" }),
      projectMembers: w.members, documentClient: w.db, tableName: "state",
    } as never,
    intentDependenciesFor: () => { starts.push({ developerId: "built" }); throw new Error("not under test"); },
    ...(options.resolvers === undefined ? {} : { accountResolvers: options.resolvers }),
  };
  return { w, wiring, ports: intakePortsOf(wiring), starts };
}

describe("who a tracker account is", () => {
  it("is the member the org linked the GitHub account to, read in the org asked about", async () => {
    const { w, ports: p } = ports();
    await linkGithubMember({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, ORG_A, PRIYA, "12345");
    expect(await p.memberOfAccount(ORG_A, "github", "12345")).toBe(PRIYA);
    expect(await p.memberOfAccount(ORG_A, "github", "99999")).toBeUndefined();
    // The same account id in another org is nobody there.
    expect(await p.memberOfAccount(ORG_B, "github", "12345")).toBeUndefined();
  });

  it("is nobody when the linked member has since been removed or revoked", async () => {
    const { w, ports: p } = ports({ removed: new Set([PRIYA]) });
    await linkGithubMember({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, ORG_A, PRIYA, "12345");
    expect(await p.memberOfAccount(ORG_A, "github", "12345")).toBeUndefined();
  });

  it("is nobody for a tracker that has no resolver, and the member its resolver names (read live) for one that has", async () => {
    expect(await ports().ports.memberOfAccount(ORG_A, "jira", "acct-1")).toBeUndefined();
    const withResolver = ports({ resolvers: { sim: async (_org, account) => (account === "u1" ? ARJUN : undefined) } });
    expect(await withResolver.ports.memberOfAccount(ORG_A, "sim", "u1")).toBe(ARJUN);
    expect(await withResolver.ports.memberOfAccount(ORG_A, "sim", "u2")).toBeUndefined();
    const gone = ports({ removed: new Set([ARJUN]), resolvers: { sim: async () => ARJUN } });
    expect(await gone.ports.memberOfAccount(ORG_A, "sim", "u1")).toBeUndefined();
  });

  it("does not let a GitHub resolver be named for the github system (the org's own links are the only truth)", async () => {
    const { ports: p } = ports({ resolvers: { github: async () => ARJUN } });
    expect(await p.memberOfAccount(ORG_A, "github", "12345")).toBeUndefined();
  });
});

describe("who may start work on a project", () => {
  it("is a member whose role on the project starts tasks, read now", async () => {
    const { ports: p } = ports();
    expect(await p.mayStart(ORG_A, PRIYA, "web")).toBe(true);
    // A viewer, a member with no role, a project that isn't there, and someone who isn't a member now.
    expect(await p.mayStart(ORG_A, MIA, "web")).toBe(false);
    expect(await p.mayStart(ORG_A, ZED, "web")).toBe(false);
    expect(await p.mayStart(ORG_A, PRIYA, "ghost")).toBe(false);
    expect(await ports({ removed: new Set([PRIYA]) }).ports.mayStart(ORG_A, PRIYA, "web")).toBe(false);
  });

  it("does not start work for someone who isn't a member", async () => {
    const { ports: p } = ports({ removed: new Set([PRIYA]) });
    await expect(p.start(ORG_A, PRIYA, { requestId: "0b1c2d3e-4f50-4162-8374-8495a6b7c8d9", project: "web", input: { text: "x" }, source: "app" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the session a ticket already follows", () => {
  it("is found through the ticket's binding, in the org asked about", async () => {
    const { w, ports: p } = ports();
    const { sessionId } = w.seedSession();
    const binding = { kind: "tracker_item" as const, system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };
    expect(await p.sessionOfTicket(ORG_A, binding)).toBeUndefined();
    await bindSessionSurface({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { orgId: ORG_A, sessionId: sessionId, binding });
    expect(await p.sessionOfTicket(ORG_A, binding)).toEqual({ sessionId, ended: false });
    expect(await p.sessionOfTicket(ORG_B, binding)).toBeUndefined();
    expect(await p.sessionOfTicket(ORG_A, { ...binding, id: "PAY-13" })).toBeUndefined();
  });
});

/** The task ended after the ticket was bound to it (a session cannot be bound once it has ended). */
function endSession(w: ReturnType<typeof sessionWorld>, sessionId: string) {
  const meta = w.db.find((item) => item["sessionId"] === sessionId && item["sk"] === "META")[0]!;
  w.db.set({ ...meta, endedAt: "2026-10-22T08:30:00.000Z" });
}

describe("a ticket asked for again after its session ended", () => {
  const binding = { kind: "tracker_item" as const, system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };

  it("says whether the ticket's session ended, lets go of the ticket when asked, and links the new session to the old one once", async () => {
    const { w, ports: p } = ports();
    const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now } as never;
    const old = w.seedSession().sessionId;
    const running = w.seedSession().sessionId;
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: old, binding });
    endSession(w, old);
    expect(await p.sessionOfTicket(ORG_A, binding)).toEqual({ sessionId: old, ended: true });
    await p.freeTicket!(ORG_A, old);
    expect(await p.sessionOfTicket(ORG_A, binding)).toBeUndefined();
    // The ticket can be bound again, to the new session, which then points back.
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: running, binding });
    expect(await p.sessionOfTicket(ORG_A, binding)).toEqual({ sessionId: running, ended: false });
    await p.linkPrevious!(ORG_A, running, old);
    const meta = () => w.db.find((item) => item["sessionId"] === running && item["sk"] === "META")[0];
    expect(meta()?.["retryOf"]).toBe(old);
    // A link already there is not overwritten, and asking again is not an error.
    await p.linkPrevious!(ORG_A, running, w.seedSession().sessionId);
    expect(meta()?.["retryOf"]).toBe(old);
  });

  it("does not let go of a session of another org", async () => {
    const { w, ports: p } = ports();
    const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now } as never;
    const old = w.seedSession().sessionId;
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: old, binding });
    endSession(w, old);
    await p.freeTicket!(ORG_B, old);
    expect(await p.sessionOfTicket(ORG_A, binding)).toEqual({ sessionId: old, ended: true });
  });
});

describe("the maintainers' notice", () => {
  it("is fixed words with the system, the project and the minutes, and nothing a tracker said", () => {
    const text = intakeNoticeText(notice());
    expect(text).toContain("sim tickets for web");
    expect(text).toContain("75 minutes");
    expect(text).not.toContain("SEARCH_FAILED");
  });

  it("is written for each maintainer in their own partition, once per source and instant", async () => {
    const w = sessionWorld();
    const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
    expect(await writeIntakeNotice(table, [PRIYA, ARJUN], notice())).toBe(2);
    const at = new Date(w.clock.now).toISOString();
    expect(w.db.get(intakeNoticeKey(ORG_A, PRIYA, at, "abc123"))).toMatchObject({ entityType: "INTAKE_NOTICE", orgId: ORG_A, project: "web", developerId: PRIYA, code: "source_failing" });
    expect(w.db.get(intakeNoticeKey(ORG_A, ARJUN, at, "abc123"))).toBeDefined();
    expect(w.db.get(intakeNoticeKey(ORG_B, PRIYA, at, "abc123"))).toBeUndefined();
  });

  it("goes to at most the first twenty maintainers", async () => {
    const w = sessionWorld();
    const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
    const many = Array.from({ length: 30 }, (_, index) => String(index).padStart(64, "0"));
    expect(await writeIntakeNotice(table, many, notice())).toBe(INTAKE_NOTICE_RECIPIENTS_MAX);
  });

  it("uses the ticket id's hash for a stable item id", () => {
    expect(intakeItemIdOf("sim", "T-1")).toMatch(/^[a-f0-9]{32}$/);
  });
});
