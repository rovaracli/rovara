// Start from inside Slack (Team record source-row lane, task 12): "@Rovara learn from this channel" answers the person privately with an "Add to project" prompt, and pressing Add saves through
// the SAME source route as the web (`handleRecordRoute`, here the real one over a fake table). The service is built on plain ports, so the checks are the real ones: the company is the one
// the Slack team is bound to, the person is the one the verified Slack user is linked to, only projects they edit are offered, the press is single-use and expires, and a private channel's
// membership is read again at the press.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, type OrgId } from "@agentx/contracts";
import { recordWriteContextOf } from "../../../packages/broker/src/aws/developer-routes/team-record-source-write.js";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import { dynamoRateLimiter } from "../../../packages/broker/src/team-record/query.js";
import type { SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { createSlackAdd, LEARN_ADD_ACTION, LEARN_PROJECT_ACTION, LEARN_PROJECT_BLOCK, LEARN_RETENTION_ACTION, LEARN_RETENTION_BLOCK, SLACK_ADD_WORDS, type SlackAddAnswer, type SlackAddPorts } from "../../../packages/broker/src/team-record/slack-add.js";
import type { SlackFacts } from "../../../packages/broker/src/team-record/source-places.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import type { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { ORG_A, ORG_B, caller, world, type World } from "../../support/team-record-core.js";

const OWNER = "a".repeat(64), MAINT = "c".repeat(64), CONTRIB = "d".repeat(64), B_MAINT = "1".repeat(64);
const SLACK = { owner: "U0OWNER001", maint: "U0MAINT001", contrib: "U0CONTRIB1", bMaint: "U0BMAINT01", nobody: "U0NOBODY01" } as const;
const LINKS: Record<string, string> = { [SLACK.owner]: OWNER, [SLACK.maint]: MAINT, [SLACK.contrib]: CONTRIB, [SLACK.bMaint]: B_MAINT };
const TEAM_A = "T0AAAAAAA", TEAM_B = "T0BBBBBBB", TEAM_FREE = "T0FREE000";
const CH = { pub: "C0PUBLIC1", priv: "C0PRIVATE", mpim: "G0GROUPDM", connect: "C0CONNECT1", gone: "C0GONE0001", pub2: "C0PUBLIC2" } as const;
const AT = "2026-10-01T00:00:00.000Z";
const MIN = 60_000;

function seedCompany(db: FakeDynamoDb, orgId: OrgId, people: Record<string, string>, grants: Array<{ id: string; project: string; role: "maintainer" | "contributor" }>, projects: Array<[string, string]>): void {
  db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG", createdAt: AT });
  for (const [project, status] of projects) db.set({ ...projectMetaKey(orgId, project), entityType: "PROJECT_META", name: project, status, createdAt: AT, archiveRevision: 0 });
  for (const [id, role] of Object.entries(people)) {
    db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role, joinedAt: AT });
    db.set({ ...developerOrgKey(id), orgId, role });
  }
  for (const { id, project, role } of grants) db.set({ ...projectMemberKey(orgId, id, project), ownerKey: id, projectName: project, role: "developer", projectRole: role, grantId: `grant-${id.slice(0, 4)}-${project}` });
}

interface Harness {
  w: World; audit: ReturnType<typeof capturingAuditDeps>; links: Map<string, string>; teams: Map<string, OrgId>;
  projects: Map<OrgId, string[]>; facts: Map<string, SlackFacts | "none" | "unreadable">; reads: string[];
  members: Map<string, Set<string> | "unreadable">; installTeam: string | undefined; routed: number; contexts: SourceWriteContext[];
}
function harness(options: { edition?: "enterprise" | "public" } = {}): Harness {
  const w = world({ edition: options.edition ?? "enterprise" });
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.ms });
  seedCompany(w.db, ORG_A, { [OWNER]: "owner", [MAINT]: "member", [CONTRIB]: "member" },
    [{ id: MAINT, project: "web", role: "maintainer" }, { id: CONTRIB, project: "web", role: "contributor" }], [["web", "active"], ["api", "active"], ["old", "archived"]]);
  seedCompany(w.db, ORG_B, { [B_MAINT]: "member" }, [{ id: B_MAINT, project: "web", role: "maintainer" }], [["web", "active"], ["billing", "active"]]);
  return {
    w, audit, links: new Map(Object.entries(LINKS)), teams: new Map([[TEAM_A, ORG_A], [TEAM_B, ORG_B]]),
    projects: new Map([[ORG_A, ["api", "old", "web"]], [ORG_B, ["billing", "web"]]]),
    facts: new Map<string, SlackFacts | "none" | "unreadable">([
      [CH.pub, { kind: "public", extShared: false }], [CH.pub2, { kind: "public", extShared: false }], [CH.priv, { kind: "private", extShared: false }],
      [CH.mpim, { kind: "mpim", extShared: false }], [CH.connect, { kind: "public", extShared: true }], [CH.gone, "none"],
    ]),
    reads: [], members: new Map([[CH.priv, new Set([SLACK.owner, SLACK.maint, SLACK.bMaint])], [CH.mpim, new Set([SLACK.owner])]]), installTeam: TEAM_A, routed: 0, contexts: [],
  };
}

const sourcesOf = (h: Harness) => ({
  edition: h.w.deps.edition,
  projectRepositories: async () => [] as number[], pausedSources: async () => [] as string[],
  slackTeamBound: async (orgId: OrgId, teamId: string) => h.teams.get(teamId) === orgId,
});
const routeDeps = (h: Harness) => ({ table: h.w.table, modes: h.w.deps.modes, now: () => h.w.clock.ms, sources: sourcesOf(h) });
function build(h: Harness) {
  return createSlackAdd({
    edition: h.w.deps.edition, table: h.w.table, state: { documentClient: h.w.db, tableName: "State" }, now: () => h.w.clock.ms,
    orgOfSlackTeam: async (teamId) => h.teams.get(teamId),
    developerOfSlackUser: async (id) => h.links.get(id),
    projectsOf: async (orgId) => h.projects.get(orgId) ?? [],
    limiter: dynamoRateLimiter(h.w.table, () => h.w.clock.ms),
    route: async (request) => {
      h.routed += 1;
      h.contexts.push(request.write);
      return await handleRecordRoute(routeDeps(h), { ...request, caller: caller({ orgId: request.caller.orgId, developerId: request.caller.developerId, projectRole: request.caller.projectRole }) });
    },
  });
}
const portsOf = (h: Harness, over: Partial<SlackAddPorts> = {}): SlackAddPorts => ({
  teamId: h.installTeam,
  channel: async (teamId, channelId) => { h.reads.push(`${teamId}/${channelId}`); const answer = h.facts.get(channelId); return answer === "unreadable" ? undefined : answer; },
  isMember: async (userId, channelId) => { const set = h.members.get(channelId); return set === "unreadable" || set === undefined ? undefined : set.has(userId); },
  audit: h.audit.deps,
  ...over,
});

interface Option { text: { text: string }; value: string }
interface Element { type?: string; action_id?: string; value?: string; style?: string; text?: string | { text: string }; options?: Option[]; initial_option?: Option }
interface Block { type?: string; block_id?: string; text?: { text: string }; accessory?: Element; elements?: Element[] }
const shown = (answer: SlackAddAnswer): { text: string; blocks?: Block[] } => { if (!("show" in answer)) throw new Error("no prompt was shown"); return answer.show; };
const everyElement = (blocks: Block[]): Element[] => blocks.flatMap((block) => [...(block.accessory === undefined ? [] : [block.accessory]), ...(block.elements ?? [])]);
const elementOf = (blocks: Block[], actionId: string): Element => { const found = everyElement(blocks).find((element) => element.action_id === actionId); if (found === undefined) throw new Error(`no ${actionId}`); return found; };
const texts = (blocks: Block[]): string => JSON.stringify(blocks.map((block) => [block.text?.text, ...(block.elements ?? []).map((element) => (typeof element.text === "string" ? element.text : element.text?.text))]));
const optionValues = (select: Element): string[] => (select.options ?? []).map((option) => option.value);
const tokenOf = (blocks: Block[]): string => elementOf(blocks, LEARN_ADD_ACTION).value!;
const firstText = (blocks: Block[]): string | undefined => blocks[0]?.text?.text;

interface AskExtra { teamId?: string; trigger?: "phrase" | "invite"; ports?: Partial<SlackAddPorts> }
const ask = (h: Harness, service: ReturnType<typeof build>, who: string, channelId: string = CH.pub, extra: AskExtra = {}) =>
  service.ask(portsOf(h, extra.ports), { teamId: extra.teamId ?? TEAM_A, userId: who, channelId, trigger: extra.trigger ?? "phrase" });
let interaction = 0;
const press = (h: Harness, service: ReturnType<typeof build>, input: { token: string; who: string; project?: string | undefined; retention?: string | undefined; channelId?: string; teamId?: string; interactionId?: string; ports?: Partial<SlackAddPorts> }) =>
  service.press(portsOf(h, input.ports), { teamId: input.teamId ?? TEAM_A, userId: input.who, channelId: input.channelId ?? CH.pub, token: input.token, ...(input.project === undefined ? {} : { project: input.project }), ...(input.retention === undefined ? {} : { retention: input.retention }), interactionId: input.interactionId ?? `trigger-${String(interaction++)}` });
const prompted = async (h: Harness, service: ReturnType<typeof build>, who: string, channelId: string = CH.pub, extra: AskExtra = {}) => tokenOf(shown(await ask(h, service, who, channelId, extra)).blocks!);

const sourceRows = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE");
const prompts = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SLACK_ADD");
const flushed = async (h: Harness) => { await new Promise((resolve) => setTimeout(resolve, 0)); return h.audit.recorded(); };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("the prompt: who sees what", () => {
  it("an editor gets the prompt for this channel: only the projects they edit, retention limited to the edition, and the Add button", async () => {
    const h = harness();
    const service = build(h);
    const prompt = shown(await ask(h, service, SLACK.maint));
    const blocks = prompt.blocks!;
    expect(prompt.text).toContain("team record");
    expect(firstText(blocks)).toBe(`Add <#${CH.pub}> to a project's team record?`);
    // A maintainer of web: web only (api, the archived one and other companies' projects are not offered).
    expect(optionValues(elementOf(blocks, LEARN_PROJECT_ACTION))).toEqual(["web"]);
    expect(elementOf(blocks, LEARN_PROJECT_ACTION).initial_option?.value).toBe("web");
    // Enterprise offers A to D, C first.
    const retention = elementOf(blocks, LEARN_RETENTION_ACTION);
    expect(optionValues(retention)).toEqual(["A", "B", "C", "D"]);
    expect(retention.initial_option?.value).toBe("C");
    expect(elementOf(blocks, LEARN_ADD_ACTION)).toMatchObject({ type: "button", style: "primary" });
    // No Slack-terms note outside Public.
    expect(texts(blocks)).not.toContain("API terms");
    // A company owner edits every active project.
    const owner = shown(await ask(h, service, SLACK.owner, CH.pub2)).blocks!;
    expect(optionValues(elementOf(owner, LEARN_PROJECT_ACTION))).toEqual(["api", "web"]);
    expect(elementOf(owner, LEARN_PROJECT_ACTION).initial_option).toBeUndefined();
    // Asking only ever answers: nothing was saved or routed.
    expect(h.routed).toBe(0);
    expect(sourceRows(h)).toHaveLength(0);
  });

  it("Public offers 'Live only' and 'Keep notes with links' with the Slack-terms note; nothing else", async () => {
    const h = harness({ edition: "public" });
    const blocks = shown(await ask(h, build(h), SLACK.maint)).blocks!;
    const retention = elementOf(blocks, LEARN_RETENTION_ACTION);
    expect(optionValues(retention)).toEqual(["A", "B"]);
    expect((retention.options ?? []).map((option) => option.text.text)).toEqual(["Live only", "Keep notes with links"]);
    expect(retention.initial_option?.value).toBe("A");
    expect(JSON.stringify(blocks)).toContain("Rovara keeps short notes with links to the messages, never the messages themselves. See <https://slack.com/terms-of-service/api|Slack's API terms>.");
  });

  it("a person who edits no project is told who can add the channel; no menu and no button", async () => {
    const h = harness();
    const answer = shown(await ask(h, build(h), SLACK.contrib));
    expect(answer.text).toBe("Only a project maintainer or a company admin can add channels. Ask one of them to add this channel.");
    expect(answer.text).toBe(SLACK_ADD_WORDS.notEditor);
    expect(answer.blocks).toBeUndefined();
    expect(prompts(h)).toHaveLength(0);
  });

  it("a Slack user nobody linked is told to link their account; a company with no projects of theirs gets the editor answer", async () => {
    const h = harness();
    const service = build(h);
    expect(shown(await ask(h, service, SLACK.nobody))).toEqual({ text: "Link your Slack account to Rovara first." });
    h.projects.set(ORG_A, []);
    expect(shown(await ask(h, service, SLACK.owner)).text).toBe(SLACK_ADD_WORDS.notEditor);
    expect(prompts(h)).toHaveLength(0);
  });

  it("the person is the one the verified Slack user is linked to; the company is the one the Slack team is bound to (a second company's team lists only its own projects)", async () => {
    const h = harness();
    const service = build(h);
    h.installTeam = undefined; // this install's own team is not asserted here: the binding decides
    const b = shown(await ask(h, service, SLACK.bMaint, CH.pub, { teamId: TEAM_B })).blocks!;
    expect(optionValues(elementOf(b, LEARN_PROJECT_ACTION))).toEqual(["web"]);
    // Company A's maintainer, speaking in company B's team, edits nothing of B's.
    expect(shown(await ask(h, service, SLACK.maint, CH.pub, { teamId: TEAM_B })).text).toBe(SLACK_ADD_WORDS.notEditor);
    // A team nobody bound: nothing is shown.
    expect(await ask(h, service, SLACK.owner, CH.pub, { teamId: TEAM_FREE })).toEqual({ none: true });
    // A team that is not this install's own: nothing is shown either.
    h.installTeam = TEAM_A;
    expect(await ask(h, service, SLACK.bMaint, CH.pub2, { teamId: TEAM_B })).toEqual({ none: true });
  });

  it("malformed ids are refused before anything is read", async () => {
    const h = harness();
    const service = build(h);
    for (const input of [{ teamId: "x", userId: SLACK.owner, channelId: CH.pub }, { teamId: TEAM_A, userId: "u0lower", channelId: CH.pub }, { teamId: TEAM_A, userId: SLACK.owner, channelId: "D0DIRECT01" }, { teamId: TEAM_A, userId: SLACK.owner, channelId: "general" }]) {
      expect(await service.ask(portsOf(h), { ...input, trigger: "phrase" }), JSON.stringify(input)).toEqual({ none: true });
    }
    expect(h.w.db.find((item) => String(item.sk).startsWith("RATE#"))).toHaveLength(0);
  });
});

describe("one prompt per person per channel per 10 minutes", () => {
  it("a repeat inside the window shows nothing; another channel, another person, or 10 minutes later shows the prompt again", async () => {
    const h = harness();
    const service = build(h);
    expect("show" in await ask(h, service, SLACK.maint)).toBe(true);
    expect(await ask(h, service, SLACK.maint)).toEqual({ none: true });
    expect("show" in await ask(h, service, SLACK.maint, CH.pub2)).toBe(true);
    expect("show" in await ask(h, service, SLACK.owner)).toBe(true);
    h.w.clock.ms += 11 * MIN;
    expect("show" in await ask(h, service, SLACK.maint)).toBe(true);
  });

  it("the rate item holds a hash, never the Slack user id", async () => {
    const h = harness();
    await ask(h, build(h), SLACK.maint);
    const rate = h.w.db.find((item) => String(item.sk).startsWith("RATE#slack-add"));
    expect(rate).toHaveLength(1);
    expect(JSON.stringify(rate)).not.toContain(SLACK.maint);
  });

  it("a limiter that cannot answer shows nothing (fail closed)", async () => {
    const h = harness();
    const service = createSlackAdd({
      edition: "enterprise", table: h.w.table, state: { documentClient: h.w.db, tableName: "State" }, now: () => h.w.clock.ms, orgOfSlackTeam: async (team) => h.teams.get(team), developerOfSlackUser: async (id) => h.links.get(id),
      projectsOf: async () => ["web"], limiter: { take: async () => { throw new Error("down"); } }, route: async () => undefined,
    });
    expect(await ask(h, service, SLACK.maint)).toEqual({ none: true });
  });
});

describe("the invite prompt (Rovara added to a private channel)", () => {
  it("goes to the inviter when they edit a project, once", async () => {
    const h = harness();
    const service = build(h);
    const first = await ask(h, service, SLACK.maint, CH.priv, { trigger: "invite" });
    expect(firstText(shown(first).blocks!)).toBe(`Add <#${CH.priv}> to a project's team record?`);
    // The same event again (Slack retries, or a second join event for the same invite): nothing more.
    expect(await ask(h, service, SLACK.maint, CH.priv, { trigger: "invite" })).toEqual({ none: true });
  });

  it("is only for a PRIVATE channel by Slack's own flags (the real-world shape: a C-prefixed private channel); a public channel, a group message, Slack Connect, an unreadable or unseen channel say nothing and do not use the person's window", async () => {
    const h = harness();
    const service = build(h);
    h.facts.set("C0NEWPRIV01", { kind: "private", extShared: false });
    h.facts.set("C0CONNECTPR", { kind: "private", extShared: true });
    h.facts.set("C0UNREADABL", "unreadable");
    expect(await ask(h, service, SLACK.maint, "C0NEWPRIV01", { trigger: "invite" })).toMatchObject({ show: { text: SLACK_ADD_WORDS.prompt } });
    for (const channel of [CH.pub, CH.mpim, "C0CONNECTPR", "C0UNREADABL", CH.gone, "C0NOTKNOWN1"]) expect(await ask(h, service, SLACK.maint, channel, { trigger: "invite" }), channel).toEqual({ none: true });
    // Positive control: the public channel's silence did not use the person's window, so typing the phrase there right away still shows the prompt.
    expect("show" in await ask(h, service, SLACK.maint, CH.pub)).toBe(true);
    // No Slack read wired: silence.
    expect(await ask(h, service, SLACK.owner, "C0NEWPRIV01", { trigger: "invite", ports: { channel: undefined } })).toEqual({ none: true });
  });

  it("says nothing when the inviter is not linked or edits no project (it never explains in the channel)", async () => {
    const h = harness();
    const service = build(h);
    expect(await ask(h, service, SLACK.nobody, CH.priv, { trigger: "invite" })).toEqual({ none: true });
    expect(await ask(h, service, SLACK.contrib, CH.priv, { trigger: "invite" })).toEqual({ none: true });
    expect(prompts(h)).toHaveLength(0);
  });
});

describe("pressing Add", () => {
  it("saves through the web route: the row, the claim, the audit event, and the sentence", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    const answer = await press(h, service, { token, who: SLACK.maint, project: "web", retention: "C" });
    expect(answer).toEqual({ text: "Added. Rovara will start recording new messages.", final: true });
    expect(sourceRows(h)).toMatchObject([{ workspaceId: ORG_A, project: "web", source: "slack", scope: `slack:${TEAM_A}/${CH.pub}`, retention: "C", enabled: true, audienceDefault: "maintainers", addedBy: MAINT, revision: 1 }]);
    expect(h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_SCOPE")).toHaveLength(1);
    expect(h.reads).toContain(`${TEAM_A}/${CH.pub}`);
    expect((await flushed(h)).find((event) => event.action === "record.source_added")).toMatchObject({ facts: { source: "slack", retention: "C", restricted: false } });
  });

  it("a private channel is audited with widened: private_channel, after membership was read again", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint, CH.priv);
    expect((await press(h, service, { token, who: SLACK.maint, project: "web", retention: "C", channelId: CH.priv })).text).toBe("Added. Rovara will start recording new messages.");
    expect((await flushed(h)).find((event) => event.action === "record.source_added")?.facts).toMatchObject({ restricted: true, widened: "private_channel" });
    expect(sourceRows(h)).toMatchObject([{ scope: `slack:${TEAM_A}/${CH.priv}` }]);
  });

  it("Public: 'Keep notes with links' is saved at B with the notes opt-in; 'Live only' at A", async () => {
    const h = harness({ edition: "public" });
    const service = build(h);
    const notes = await prompted(h, service, SLACK.maint, CH.pub);
    expect((await press(h, service, { token: notes, who: SLACK.maint, project: "web", retention: "B" })).final).toBe(true);
    const live = await prompted(h, service, SLACK.maint, CH.pub2);
    expect((await press(h, service, { token: live, who: SLACK.maint, project: "web", retention: "A", channelId: CH.pub2 })).text).toBe(SLACK_ADD_WORDS.added);
    expect(sourceRows(h).map((row) => [row.scope, row.retention, row.notesOptIn])).toEqual(expect.arrayContaining([[`slack:${TEAM_A}/${CH.pub}`, "B", true], [`slack:${TEAM_A}/${CH.pub2}`, "A", undefined]]));
  });

  it("without a retention choice the edition's default applies (Enterprise C, Public A)", async () => {
    for (const [edition, expected] of [["enterprise", "C"], ["public", "A"]] as const) {
      const h = harness({ edition });
      const service = build(h);
      const token = await prompted(h, service, SLACK.maint);
      expect((await press(h, service, { token, who: SLACK.maint, project: "web" })).text, edition).toBe(SLACK_ADD_WORDS.added);
      expect(sourceRows(h)[0]!.retention).toBe(expected);
    }
  });

  it("replay: the same interaction answers the stored outcome and saves once; the requestId is derived from the interaction id", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    const input = { token, who: SLACK.maint, project: "web", retention: "C", interactionId: "1234.5678.abcd" };
    const first = await press(h, service, input);
    expect(first.final).toBe(true);
    const reads = h.reads.length;
    expect(await press(h, service, input)).toEqual(first);
    // A replay is answered from the stored outcome: Slack is not asked again.
    expect(h.reads).toHaveLength(reads);
    expect(sourceRows(h)).toHaveLength(1);
    expect(h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REQUEST")).toHaveLength(1);
    // A different interaction on the same prompt answers the stored outcome too (see the fix round 1 tests).
    expect(await press(h, service, { ...input, interactionId: "9999.0000.zzzz" })).toEqual({ text: SLACK_ADD_WORDS.added, final: true });
    expect(sourceRows(h)).toHaveLength(1);
    expect(h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REQUEST")).toHaveLength(1);
  });

  it("a prompt expires after 15 minutes: nothing is saved", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    h.w.clock.ms += 16 * MIN;
    expect(await press(h, service, { token, who: SLACK.maint, project: "web" })).toEqual({ text: SLACK_ADD_WORDS.expired, final: true });
    expect(sourceRows(h)).toHaveLength(0);
    expect(h.routed).toBe(0);
    // Positive control: 14 minutes is still fine.
    const h2 = harness();
    const s2 = build(h2);
    const t2 = await prompted(h2, s2, SLACK.maint);
    h2.w.clock.ms += 14 * MIN;
    expect((await press(h2, s2, { token: t2, who: SLACK.maint, project: "web" })).text).toBe(SLACK_ADD_WORDS.added);
  });

  it("an unknown token, and a token of another company's team, are the same as an expired one", async () => {
    const h = harness();
    const service = build(h);
    h.installTeam = undefined;
    const token = await prompted(h, service, SLACK.maint);
    for (const bad of [randomUUID(), "not-a-token", token.toUpperCase()]) expect(await press(h, service, { token: bad, who: SLACK.maint, project: "web" }), bad).toEqual({ text: SLACK_ADD_WORDS.expired, final: true });
    // The prompt of company A, pressed through company B's team by B's own maintainer.
    expect(await press(h, service, { token, who: SLACK.bMaint, project: "web", teamId: TEAM_B })).toEqual({ text: SLACK_ADD_WORDS.expired, final: true });
    expect(sourceRows(h)).toHaveLength(0);
  });

  it("a press from another Slack user, or in another channel, is refused and saves nothing; the person's own prompt stays open", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    expect(await press(h, service, { token, who: SLACK.owner, project: "web" })).toEqual({ text: SLACK_ADD_WORDS.notYours, final: false });
    expect(await press(h, service, { token, who: SLACK.maint, project: "web", channelId: CH.pub2 })).toEqual({ text: SLACK_ADD_WORDS.notYours, final: false });
    expect(sourceRows(h)).toHaveLength(0);
    expect((await press(h, service, { token, who: SLACK.maint, project: "web" })).text).toBe(SLACK_ADD_WORDS.added);
  });

  it("the person must still edit the chosen project: one they never edited, one that does not exist, an archived one, and one demoted since the prompt are refused", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    for (const project of ["api", "nope", "old", "../web", "web/x"]) expect(await press(h, service, { token, who: SLACK.maint, project }), project).toMatchObject({ text: SLACK_ADD_WORDS.notEditor });
    expect(await press(h, service, { token, who: SLACK.maint })).toEqual({ text: SLACK_ADD_WORDS.chooseProject, final: false });
    expect(await press(h, service, { token, who: SLACK.maint, project: "" })).toEqual({ text: SLACK_ADD_WORDS.chooseProject, final: false });
    h.w.db.set({ ...projectMemberKey(ORG_A, MAINT, "web"), ownerKey: MAINT, projectName: "web", role: "developer", projectRole: "contributor", grantId: "g" });
    expect((await press(h, service, { token, who: SLACK.maint, project: "web" })).text).toBe(SLACK_ADD_WORDS.notEditor);
    expect(sourceRows(h)).toHaveLength(0);
    expect(h.routed).toBe(0);
  });

  it("a person whose Slack link was removed since the prompt is told to link again; nothing is saved", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    h.links.delete(SLACK.maint);
    expect(await press(h, service, { token, who: SLACK.maint, project: "web" })).toEqual({ text: SLACK_ADD_WORDS.notLinked, final: false });
    expect(sourceRows(h)).toHaveLength(0);
  });

  it("a second company's person cannot add to this company's prompt or projects", async () => {
    const h = harness();
    const service = build(h);
    h.installTeam = undefined;
    const token = await prompted(h, service, SLACK.bMaint, CH.pub, { teamId: TEAM_B });
    // Company B's prompt, B's own press: saved in B only.
    expect((await press(h, service, { token, who: SLACK.bMaint, project: "web", teamId: TEAM_B })).text).toBe(SLACK_ADD_WORDS.added);
    expect(sourceRows(h).map((row) => row.workspaceId)).toEqual([ORG_B]);
    // Company A's prompt for A's owner, pressed by B's maintainer through A's team: no editor of A.
    const own = await prompted(h, service, SLACK.owner, CH.pub2);
    expect(await press(h, service, { token: own, who: SLACK.bMaint, project: "web", channelId: CH.pub2 })).toMatchObject({ final: false });
    expect(sourceRows(h)).toHaveLength(1);
  });
});

describe("a private channel: membership is read again at the press", () => {
  const setup = async (members: Set<string> | "unreadable" | undefined) => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint, CH.priv);
    if (members === undefined) h.members.delete(CH.priv); else h.members.set(CH.priv, members);
    return { h, service, token };
  };
  const pressIt = (s: Awaited<ReturnType<typeof setup>>, ports: Partial<SlackAddPorts> = {}) => press(s.h, s.service, { token: s.token, who: SLACK.maint, project: "web", channelId: CH.priv, ports });

  it("a person who left the channel after the prompt is refused and nothing is saved", async () => {
    const s = await setup(new Set([SLACK.owner]));
    expect(await pressIt(s)).toEqual({ text: SLACK_ADD_WORDS.leftChannel, final: true });
    expect(sourceRows(s.h)).toHaveLength(0);
    expect(s.h.routed).toBe(0);
  });

  it("an unreadable membership, and an install that cannot read it, fail closed and keep the prompt open", async () => {
    const unreadable = await setup("unreadable");
    expect(await pressIt(unreadable)).toEqual({ text: SLACK_ADD_WORDS.unavailable, final: false });
    expect(await pressIt(unreadable, { isMember: undefined })).toEqual({ text: SLACK_ADD_WORDS.unavailable, final: false });
    expect(sourceRows(unreadable.h)).toHaveLength(0);
    // Once Slack answers, the same prompt saves.
    unreadable.h.members.set(CH.priv, new Set([SLACK.maint]));
    expect((await pressIt(unreadable)).text).toBe(SLACK_ADD_WORDS.added);
  });

  it("a public channel is not checked for membership; a group message is", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    h.members.clear();
    expect((await press(h, service, { token, who: SLACK.maint, project: "web" })).text).toBe(SLACK_ADD_WORDS.added);
    const e = harness();
    const es = build(e);
    const tokenM = await prompted(e, es, SLACK.maint, CH.mpim);
    expect(await press(e, es, { token: tokenM, who: SLACK.maint, project: "web", channelId: CH.mpim })).toEqual({ text: SLACK_ADD_WORDS.leftChannel, final: true });
  });
});

describe("the route's refusals, in their fixed sentences", () => {
  const word = async (h: Harness, channelId: string, retention = "C", ports: Partial<SlackAddPorts> = {}, service = build(h)) => {
    const token = await prompted(h, service, SLACK.owner, channelId);
    return await press(h, service, { token, who: SLACK.owner, project: "web", retention, channelId, ports });
  };
  const webAdd = (h: Harness, project: string, body: unknown, extra: Record<string, unknown> = {}) => handleRecordRoute(routeDeps(h), {
    method: "POST", path: `/v1/app/projects/${project}/record/sources`, query: {}, caller: caller({ orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" }),
    write: { orgRole: "owner", browserSession: true, body: () => body, audit: h.audit.deps, slackTeamId: TEAM_A, slackChannel: async (): Promise<SlackFacts> => ({ kind: "public", extShared: false }), ...extra },
  });

  it("Slack Connect: refused in both editions with the route's sentence", async () => {
    for (const edition of ["enterprise", "public"] as const) {
      const h = harness({ edition });
      expect(await word(h, CH.connect, "A"), edition).toEqual({ text: "Slack Connect channels can't be used as a source.", final: true });
      expect(sourceRows(h)).toHaveLength(0);
    }
  });

  it("a group message: Public refuses it with the route's sentence", async () => {
    const h = harness({ edition: "public" });
    expect(await word(h, CH.mpim, "A")).toEqual({ text: "Direct messages and group messages can't be used as a source in this edition.", final: true });
  });

  it("a channel Slack does not show Rovara: invite it first", async () => {
    const h = harness();
    expect(await word(h, CH.gone)).toEqual({ text: "Rovara isn't in that channel yet. Type /invite @Rovara in the channel, then try again.", final: true });
  });

  it("a channel another project already holds", async () => {
    const h = harness();
    const body = { action: "add", requestId: randomUUID(), source: "slack", scope: `slack:${TEAM_A}/${CH.pub}`, retention: "C", audienceDefault: "maintainers", enabled: true };
    expect((await webAdd(h, "api", body))?.status).toBe(200);
    expect(await word(h, CH.pub)).toEqual({ text: "That channel is already a source of another project.", final: true });
    expect(sourceRows(h)).toHaveLength(1);
  });

  it("a channel already a source of this project; and one just removed, still being cleared", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.owner, CH.pub);
    expect((await press(h, service, { token, who: SLACK.owner, project: "web" })).final).toBe(true);
    h.w.clock.ms += 11 * MIN;
    const second = await prompted(h, service, SLACK.owner, CH.pub);
    expect(await press(h, service, { token: second, who: SLACK.owner, project: "web" })).toEqual({ text: "That channel is already a source of this project.", final: true });
    // Remove it through the web route: its stored data is queued for deletion, and an add of the same place is refused with the route's own words.
    const scope = `slack:${TEAM_A}/${CH.pub}`;
    expect((await webAdd(h, "web", { action: "remove", requestId: randomUUID(), source: "slack", scope, expectedRevision: 1 }))?.status).toBe(200);
    h.w.clock.ms += 11 * MIN;
    const again = await prompted(h, service, SLACK.owner, CH.pub);
    expect(await press(h, service, { token: again, who: SLACK.owner, project: "web" })).toEqual({ text: "This source was just removed and its stored data is still being deleted. You can add it again in about an hour.", final: true });
  });

  it("a retention the edition does not offer for Slack is refused with a fixed sentence (nothing client-supplied is echoed); a write that needs the audit ledger is 'try again later'", async () => {
    const h = harness({ edition: "public" });
    const service = build(h);
    const token = await prompted(h, service, SLACK.owner, CH.pub);
    for (const retention of ["D", "D<script>", "Z"]) {
      const refused = await press(h, service, { token, who: SLACK.owner, project: "web", retention });
      expect(refused, retention).toEqual({ text: "That retention isn't offered for this source.", final: true });
    }
    expect(sourceRows(h)).toHaveLength(0);
    const e = harness();
    const es = build(e);
    const t = await prompted(e, es, SLACK.owner, CH.priv);
    expect(await press(e, es, { token: t, who: SLACK.owner, project: "web", channelId: CH.priv, ports: { audit: {} } })).toEqual({ text: "This change needs the audit ledger.", final: false });
    expect(sourceRows(e)).toHaveLength(0);
  });

  it("Slack unreadable at the press: try again, and the prompt stays open", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    h.facts.set(CH.pub, "unreadable");
    expect(await press(h, service, { token, who: SLACK.maint, project: "web" })).toEqual({ text: SLACK_ADD_WORDS.unavailable, final: false });
    h.facts.set(CH.pub, { kind: "public", extShared: false });
    expect((await press(h, service, { token, who: SLACK.maint, project: "web" })).text).toBe(SLACK_ADD_WORDS.added);
  });

  it("a route that throws something unknown is 'try again' with no detail", async () => {
    const h = harness();
    const service = createSlackAdd({
      edition: "enterprise", table: h.w.table, state: { documentClient: h.w.db, tableName: "State" }, now: () => h.w.clock.ms, orgOfSlackTeam: async (team) => h.teams.get(team), developerOfSlackUser: async (id) => h.links.get(id),
      projectsOf: async () => ["web"], limiter: dynamoRateLimiter(h.w.table, () => h.w.clock.ms),
      route: async () => { throw new Error("secret detail"); },
    });
    const token = await prompted(h, service, SLACK.maint);
    expect(await press(h, service, { token, who: SLACK.maint, project: "web" })).toEqual({ text: SLACK_ADD_WORDS.unavailable, final: false });
  });
});

describe("what is stored", () => {
  it("the prompt item holds the team, the channel, a hash of the person and an expiry; never the Slack user id; the token is a uuid", async () => {
    const h = harness();
    const token = await prompted(h, build(h), SLACK.maint);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const [item] = prompts(h);
    expect(item).toMatchObject({ team: TEAM_A, channel: CH.pub, person: sha(`slack-add\0${ORG_A}\0${SLACK.maint}`), sk: `SLKADD#${token}` });
    expect(Number(item!.indexExpiresAt)).toBeGreaterThan(h.w.clock.ms / 1000);
    expect(JSON.stringify(item)).not.toContain(SLACK.maint);
    expect(JSON.stringify(item)).not.toContain(MAINT);
  });

  it("the project menu is capped to what Slack accepts and the blocks carry no personal ids", async () => {
    const h = harness();
    const names = Array.from({ length: 150 }, (_, index) => `proj-${String(index).padStart(3, "0")}`);
    h.projects.set(ORG_A, names);
    for (const name of names) h.w.db.set({ ...projectMetaKey(ORG_A, name), entityType: "PROJECT_META", name, status: "active", createdAt: AT, archiveRevision: 0 });
    const blocks = shown(await ask(h, build(h), SLACK.owner)).blocks!;
    expect(optionValues(elementOf(blocks, LEARN_PROJECT_ACTION))).toHaveLength(100);
    expect(JSON.stringify(blocks)).not.toContain(OWNER);
    expect(blocks.some((block) => block.accessory?.action_id === LEARN_PROJECT_ACTION && block.block_id === LEARN_PROJECT_BLOCK)).toBe(true);
    expect(blocks.some((block) => block.accessory?.action_id === LEARN_RETENTION_ACTION && block.block_id === LEARN_RETENTION_BLOCK)).toBe(true);
  });
});

describe("fix round 1: rights between the prompt and the press", () => {
  it("a company-role downgrade between the prompt and the press is refused: an admin made a plain member, and a role that no longer writes", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.owner, CH.pub);
    // The owner is made a plain member with no project grant (member row and pointer move together, as the company's role change does).
    h.w.db.set({ ...orgMemberKey(ORG_A, OWNER), orgId: ORG_A, developerId: OWNER, role: "member", joinedAt: AT });
    h.w.db.set({ ...developerOrgKey(OWNER), orgId: ORG_A, role: "member" });
    expect(await press(h, service, { token, who: SLACK.owner, project: "web" })).toEqual({ text: SLACK_ADD_WORDS.notEditor, final: true });
    // A maintainer whose company role became a read-only one (auditor) keeps the project grant but may not write.
    const t2 = await prompted(h, service, SLACK.maint, CH.pub2);
    h.w.db.set({ ...orgMemberKey(ORG_A, MAINT), orgId: ORG_A, developerId: MAINT, role: "auditor", joinedAt: AT });
    h.w.db.set({ ...developerOrgKey(MAINT), orgId: ORG_A, role: "auditor" });
    expect(await press(h, service, { token: t2, who: SLACK.maint, project: "web", channelId: CH.pub2 })).toEqual({ text: SLACK_ADD_WORDS.notEditor, final: true });
    expect(sourceRows(h)).toHaveLength(0);
    expect(h.routed).toBe(0);
  });

  it("a member removed from the company between the prompt and the press is refused (the member row and pointer are gone, the old grant row is ignored)", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    h.w.db.delete(orgMemberKey(ORG_A, MAINT));
    h.w.db.delete(developerOrgKey(MAINT));
    expect(await press(h, service, { token, who: SLACK.maint, project: "web" })).toEqual({ text: SLACK_ADD_WORDS.notEditor, final: true });
    expect(sourceRows(h)).toHaveLength(0);
    // Positive control: the same person, still a member, saves.
    const h2 = harness();
    const s2 = build(h2);
    const t2 = await prompted(h2, s2, SLACK.maint);
    expect((await press(h2, s2, { token: t2, who: SLACK.maint, project: "web" })).text).toBe(SLACK_ADD_WORDS.added);
  });
});

describe("fix round 1: a second press after a save answers the stored outcome", () => {
  it("any later press by the same person on a saved prompt answers 'Added' and closes the prompt (a retry after a timed-out first press carries a new interaction id)", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    expect(await press(h, service, { token, who: SLACK.maint, project: "web", retention: "C", interactionId: "first" })).toEqual({ text: SLACK_ADD_WORDS.added, final: true });
    expect(await press(h, service, { token, who: SLACK.maint, project: "web", retention: "C", interactionId: "second" })).toEqual({ text: SLACK_ADD_WORDS.added, final: true });
    // Even with a different choice in the menus the stored outcome stands: nothing more is saved.
    expect(await press(h, service, { token, who: SLACK.maint, project: "api", retention: "A", interactionId: "third" })).toEqual({ text: SLACK_ADD_WORDS.added, final: true });
    expect(sourceRows(h)).toHaveLength(1);
    expect(h.routed).toBe(1);
    // Another person's press is still not theirs.
    expect(await press(h, service, { token, who: SLACK.owner, project: "web", interactionId: "fourth" })).toEqual({ text: SLACK_ADD_WORDS.notYours, final: false });
  });

  it("the second press can arrive before the first one's used-mark: the route says the row is already there, which for this person's own prompt is 'Added' too", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    expect((await press(h, service, { token, who: SLACK.maint, project: "web", interactionId: "first" })).final).toBe(true);
    // Take the stored outcome away, as if the used-mark had not landed yet.
    for (const item of h.w.db.find((entry) => entry.entityType === "TEAM_RECORD_SLACK_ADD")) h.w.db.set({ ...item, doneBy: undefined, doneOutcome: undefined });
    expect(await press(h, service, { token, who: SLACK.maint, project: "web", interactionId: "second" })).toEqual({ text: SLACK_ADD_WORDS.added, final: true });
    expect(sourceRows(h)).toHaveLength(1);
  });

  it("a refusal is not a stored outcome: the prompt stays usable after one", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint, CH.connect);
    expect((await press(h, service, { token, who: SLACK.maint, project: "web", channelId: CH.connect, interactionId: "a" })).text).toBe("Slack Connect channels can't be used as a source.");
    h.facts.set(CH.connect, { kind: "public", extShared: false });
    expect(await press(h, service, { token, who: SLACK.maint, project: "web", channelId: CH.connect, interactionId: "b" })).toEqual({ text: SLACK_ADD_WORDS.added, final: true });
  });
});

describe("fix round 1: the Slack press is its own actor, not a browser session", () => {
  it("the route is called with browserSession false and actor slack_interaction; the audit event says via: slack, and a web add says nothing of the kind", async () => {
    const h = harness();
    const service = build(h);
    const token = await prompted(h, service, SLACK.maint);
    expect((await press(h, service, { token, who: SLACK.maint, project: "web", retention: "C" })).final).toBe(true);
    expect(h.contexts).toHaveLength(1);
    expect(h.contexts[0]).toMatchObject({ browserSession: false, actor: "slack_interaction" });
    const events = (await flushed(h)).filter((event) => event.action === "record.source_added");
    expect(events[0]?.facts).toMatchObject({ source: "slack", via: "slack" });
    const body = { action: "add", requestId: randomUUID(), source: "slack", scope: `slack:${TEAM_A}/${CH.pub2}`, retention: "C", audienceDefault: "maintainers", enabled: true };
    const web = await handleRecordRoute(routeDeps(h), { method: "POST", path: "/v1/app/projects/web/record/sources", query: {}, caller: caller({ orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" }), write: { orgRole: "owner", browserSession: true, body: () => body, audit: h.audit.deps, slackTeamId: TEAM_A, slackChannel: async (): Promise<SlackFacts> => ({ kind: "public", extShared: false }) } });
    expect(web?.status).toBe(200);
    const all = (await flushed(h)).filter((event) => event.action === "record.source_added");
    expect(all).toHaveLength(2);
    expect(all[1]?.facts).not.toHaveProperty("via");
  });

  const slackActor = (h: Harness, route: string, body: unknown, over: Partial<SourceWriteContext> & { noActor?: true } = {}, method = "POST", query: Record<string, string> = {}) => {
    const { noActor, ...rest } = over;
    const write: SourceWriteContext = {
      orgRole: "owner", browserSession: false, ...(noActor === true ? {} : { actor: "slack_interaction" as const }), body: () => body, audit: h.audit.deps, slackTeamId: TEAM_A, slackChannel: async (): Promise<SlackFacts> => ({ kind: "public", extShared: false }), ...rest,
    };
    return handleRecordRoute(routeDeps(h), { method, path: `/v1/app/projects/web/record/${route}`, query, caller: caller({ orgId: ORG_A, developerId: OWNER, projectRole: "maintainer" }), write });
  };
  const add = (over: Record<string, unknown> = {}) => ({ action: "add", requestId: randomUUID(), source: "slack", scope: `slack:${TEAM_A}/${CH.pub}`, retention: "C", audienceDefault: "maintainers", enabled: true, ...over });

  it("the actor is accepted for adding a Slack place only: not a change, a removal, another kind of source, the pickers or the admin view", async () => {
    const h = harness();
    expect((await slackActor(h, "sources", add()))?.status).toBe(200);
    const forbidden = { status: 403, body: { code: "FORBIDDEN" } };
    expect(await slackActor(h, "sources", { action: "change", requestId: randomUUID(), source: "slack", scope: `slack:${TEAM_A}/${CH.pub}`, expectedRevision: 1, enabled: false })).toMatchObject(forbidden);
    expect(await slackActor(h, "sources", { action: "remove", requestId: randomUUID(), source: "slack", scope: `slack:${TEAM_A}/${CH.pub}`, expectedRevision: 1 })).toMatchObject(forbidden);
    expect(await slackActor(h, "sources", add({ source: "github", scope: "github:repo/9" }))).toMatchObject(forbidden);
    expect(await slackActor(h, "sources/options", undefined, {}, "GET", { kind: "slack" })).toMatchObject(forbidden);
    // The editors' view is for a live browser session: the actor does not open it (it answers the ordinary member view).
    const view = await slackActor(h, "sources", undefined, {}, "GET");
    expect(JSON.stringify(view?.body)).not.toContain("canEdit");
    expect(sourceRows(h)).toHaveLength(1);
  });

  it("without the actor a non-browser caller is still refused, and no request can set the actor: a body that names one is invalid, and the web route's context builder never sets it", async () => {
    const h = harness();
    expect(await slackActor(h, "sources", add(), { noActor: true })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    for (const extra of [{ actor: "slack_interaction" }, { via: "slack" }, { browserSession: true }]) expect(await slackActor(h, "sources", add(extra), { noActor: true, browserSession: true }), JSON.stringify(extra)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    for (const browserSession of [true, false]) {
      const context = recordWriteContextOf({ audit: undefined } as never, { developerId: OWNER, sessionId: "s", amr: "slack", name: "n", orgId: ORG_A, orgRole: "owner", ...(browserSession ? { browserSession: true as const } : {}) } as never, { method: "POST", path: "/", headers: {}, body: JSON.stringify({ actor: "slack_interaction" }), requestId: "r" });
      expect(context.actor).toBeUndefined();
      expect(context).not.toHaveProperty("actor");
      expect(context.browserSession).toBe(browserSession);
    }
    expect(sourceRows(h)).toHaveLength(0);
  });
});
