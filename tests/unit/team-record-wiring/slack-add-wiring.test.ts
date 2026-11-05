// Start from inside Slack (task 12), the broker's side of the wiring: the direct-invoke event the ingress sends, the Slack reads the broker hands the service (what a channel is, whether a person is in it), the answer where
// the record is off, and one run over the REAL runtime (the real source route, the State table's company and Slack binding, the sign-in store's Slack link).
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, orgProjectCatalogKey, projectMemberKey, projectMetaKey, slackTeamOrgKey } from "@agentx/contracts";
import { answerSlackAdd, isTeamRecordSlackAddEvent } from "../../../packages/broker/src/aws/broker/team-record-wiring.js";
import { createTeamRecordRuntime, type TeamRecordRuntime } from "../../../packages/broker/src/team-record/runtime.js";
import { LEARN_ADD_ACTION, type SlackAddAskInput, type SlackAddPorts, type SlackAddPressInput } from "../../../packages/broker/src/team-record/slack-add.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B } from "../../support/team-record-core.js";

const TEAM = "T0AAAAAAA", CHANNEL = "C0PUBLIC1", PRIVATE = "C0PRIVATE", MAYA = "U0MAYA0001", OTHER = "U0OTHER001";
const DEV = "a".repeat(64);
const ask = (over: Partial<SlackAddAskInput> = {}) => ({ source: "agentx.slack-ingress" as const, action: "team-record-slack-add" as const, step: "ask" as const, teamId: TEAM, userId: MAYA, channelId: CHANNEL, trigger: "phrase" as const, ...over });
const press = (over: Partial<SlackAddPressInput> = {}) => ({ source: "agentx.slack-ingress" as const, action: "team-record-slack-add" as const, step: "press" as const, teamId: TEAM, userId: MAYA, channelId: CHANNEL, token: "t", interactionId: "1.2", ...over });

describe("the broker's event", () => {
  it("is a direct invoke from the ingress only", () => {
    expect(isTeamRecordSlackAddEvent(ask())).toBe(true);
    expect(isTeamRecordSlackAddEvent({ ...ask(), requestContext: { http: {} } })).toBe(false);
    expect(isTeamRecordSlackAddEvent({ ...ask(), source: "agentx.team-record-slack" })).toBe(false);
  });
});

describe("answerSlackAdd", () => {
  it("answers 'off' and does nothing where the Team record is off", async () => {
    expect(await answerSlackAdd({ teamRecord: undefined }, ask())).toStrictEqual({ skipped: true, reason: "off" });
    expect(await answerSlackAdd({ teamRecord: undefined }, press())).toStrictEqual({ skipped: true, reason: "off" });
  });

  const spyRuntime = () => {
    const calls: Array<{ step: string; ports: SlackAddPorts; input: unknown }> = [];
    const teamRecord = { slackAdd: {
      ask: async (ports: SlackAddPorts, input: unknown) => { calls.push({ step: "ask", ports, input }); return { none: true as const }; },
      press: async (ports: SlackAddPorts, input: unknown) => { calls.push({ step: "press", ports, input }); return { text: "x", final: true }; },
    } } as unknown as TeamRecordRuntime;
    return { calls, teamRecord };
  };

  it("hands the service the identity's reads: the team, what a channel is, whether a person is in it; the audit outbox only where there is one", async () => {
    const { calls, teamRecord } = spyRuntime();
    const memberRequests: unknown[] = [];
    const classRequests: unknown[] = [];
    const developer = {
      slackTeamId: TEAM,
      channelClass: async (request: unknown) => { classRequests.push(request); return request && (request as { channelId: string }).channelId === PRIVATE ? { ok: true as const } : { ok: true as const, channel: { kind: "private" as const, extShared: false } }; },
      channelMembers: async (request: { slackUserId: string; channelIds: string[] }) => { memberRequests.push(request); return request.slackUserId === MAYA ? { ok: true as const, memberOf: [CHANNEL] } : { ok: false as const, error: "slack_unavailable" as const }; },
    } as never;
    const audit = { queueUrl: "q" } as never;
    expect(await answerSlackAdd({ teamRecord, developer, audit }, ask())).toStrictEqual({ none: true });
    const { ports } = calls[0]!;
    expect(ports.teamId).toBe(TEAM);
    expect(ports.audit).toEqual({ audit });
    expect(await ports.channel!(TEAM, CHANNEL)).toEqual({ kind: "private", extShared: false });
    expect(await ports.channel!(TEAM, PRIVATE)).toBe("none");
    expect(classRequests).toEqual([{ kind: "channel-class", teamId: TEAM, channelId: CHANNEL }, { kind: "channel-class", teamId: TEAM, channelId: PRIVATE }]);
    expect(await ports.isMember!(MAYA, CHANNEL)).toBe(true);
    expect(await ports.isMember!(MAYA, PRIVATE)).toBe(false);
    expect(await ports.isMember!(OTHER, CHANNEL)).toBeUndefined();
    expect(memberRequests[0]).toEqual({ kind: "channel-members", slackUserId: MAYA, channelIds: [CHANNEL] });
    // An install with none of these cannot answer those reads: the ports are absent (the service fails closed).
    expect(await answerSlackAdd({ teamRecord, developer: {} as never }, press())).toStrictEqual({ text: "x", final: true });
    expect(calls[1]!.step).toBe("press");
    expect(calls[1]!.ports).toEqual({});
  });
});

describe("over the real runtime", () => {
  const AT = "2026-10-01T00:00:00.000Z";
  function rig(edition: "enterprise" | "public" = "enterprise", extra: { link?: boolean } = {}) {
    const db = new FakeDynamoDb({ indexKeys: { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } } });
    const clock = { ms: Date.parse("2026-10-30T12:00:00.000Z") };
    for (const [orgId, project] of [[ORG_A, "web"], [ORG_B, "billing"]] as const) {
      db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG", createdAt: AT });
      db.set({ ...projectMetaKey(orgId, project), entityType: "PROJECT_META", name: project, status: "active", createdAt: AT, archiveRevision: 0 });
      db.set({ ...orgProjectCatalogKey(orgId, project), entityType: "PROJECT_CATALOG", name: project });
    }
    db.set({ ...orgMemberKey(ORG_A, DEV), orgId: ORG_A, developerId: DEV, role: "member", joinedAt: AT });
    db.set({ ...developerOrgKey(DEV), orgId: ORG_A, role: "member" });
    db.set({ ...projectMemberKey(ORG_A, DEV, "web"), ownerKey: DEV, projectName: "web", role: "developer", projectRole: "maintainer", grantId: "g1" });
    db.set({ ...slackTeamOrgKey(TEAM), orgId: ORG_A });
    const runtime = createTeamRecordRuntime({
      env: { TEAM_RECORD_ENABLED: "1", TEAM_RECORD_TABLE_NAME: "TeamRecord", AWS_REGION: "us-west-2", ROVARA_EDITION: edition }, documentClient: db, stateTableName: "State", now: () => clock.ms,
      developerOfSlackUser: async (id) => (extra.link === false ? undefined : id === MAYA ? DEV : undefined),
    }) as TeamRecordRuntime;
    const developer = {
      slackTeamId: TEAM,
      channelClass: async () => ({ ok: true as const, channel: { kind: "public" as const, extShared: false } }),
      channelMembers: async () => ({ ok: true as const, memberOf: [CHANNEL] }),
    } as never;
    return { db, runtime, developer, clock };
  }
  const tokenOf = (answer: Record<string, unknown>): string => {
    const blocks = (answer.show as { blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }> }).blocks;
    return blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === LEARN_ADD_ACTION)!.value;
  };

  it("a linked maintainer is shown the prompt for their project only, presses Add, and the row is saved by the web route's own code", async () => {
    const { db, runtime, developer } = rig();
    const answer = await answerSlackAdd({ teamRecord: runtime, developer }, ask()) as Record<string, unknown>;
    const blocks = (answer.show as { blocks: Array<{ accessory?: { action_id: string; options?: Array<{ value: string }> } }> }).blocks;
    const project = blocks.flatMap((block) => (block.accessory?.action_id === "rovara_record_project" ? (block.accessory.options ?? []) : []));
    expect(project.map((option) => option.value)).toEqual(["web"]);
    const result = await answerSlackAdd({ teamRecord: runtime, developer }, press({ token: tokenOf(answer), project: "web", retention: "C" }));
    expect(result).toEqual({ text: "Added. Rovara will start recording new messages.", final: true });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_SOURCE")).toMatchObject([{ workspaceId: ORG_A, project: "web", source: "slack", scope: `slack:${TEAM}/${CHANNEL}`, retention: "C", addedBy: DEV }]);
    // A second company's projects are never offered: company B has "billing" and this person is not in it.
    expect(JSON.stringify(answer)).not.toContain("billing");
  });

  it("a Slack user nobody linked is told to link their account; the team a different company bound shows nothing for company A's person", async () => {
    const unlinked = rig("enterprise", { link: false });
    expect(await answerSlackAdd({ teamRecord: unlinked.runtime, developer: unlinked.developer }, ask())).toEqual({ show: { text: "Link your Slack account to Rovara first." } });
    const { runtime, developer, db } = rig();
    db.set({ ...slackTeamOrgKey("T0BBBBBBB"), orgId: ORG_B });
    expect(await answerSlackAdd({ teamRecord: runtime, developer: { ...(developer as object), slackTeamId: "T0BBBBBBB" } as never }, ask({ teamId: "T0BBBBBBB" }))).toEqual({ show: { text: "Only a project maintainer or a company admin can add channels. Ask one of them to add this channel." } });
  });

  it("Public: the Slack-terms note is in the prompt and 'Keep notes with links' saves at B with the opt-in", async () => {
    const { db, runtime, developer } = rig("public");
    // Raising Slack from A to B widens what is kept, so (as on the web) it needs the audit ledger; without one the route refuses.
    const audit = capturingAuditDeps({ db });
    const answer = await answerSlackAdd({ teamRecord: runtime, developer, audit: audit.audit }, ask()) as Record<string, unknown>;
    expect(JSON.stringify(answer)).toContain("Slack's API terms");
    expect(await answerSlackAdd({ teamRecord: runtime, developer }, press({ token: tokenOf(answer), project: "web", retention: "B" }))).toEqual({ text: "This change needs the audit ledger.", final: false });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_SOURCE")).toHaveLength(0);
    expect(await answerSlackAdd({ teamRecord: runtime, developer, audit: audit.audit }, press({ token: tokenOf(answer), project: "web", retention: "B" }))).toEqual({ text: "Added. Rovara will start recording new messages.", final: true });
    expect(db.find((item) => item.entityType === "TEAM_RECORD_SOURCE")).toMatchObject([{ retention: "B", notesOptIn: true }]);
  });
});
