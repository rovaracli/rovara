// Meta repo lane F (F1): the generic intake contracts. A ticket from any tracker is one `IntakeItem`; a tracker item is one `tracker_item` binding beside the Slack thread
// and the Linear issue; a Jira, GitHub Issues or other-tracker intent names its ticket; a work origin exists for each new source.
import { describe, expect, it } from "vitest";
import { CODE_INTENT_BINDING_OF_SOURCE, CODE_INTENT_SOURCES, CodeIntentRequestSchema, IntakeChannelRefSchema, IntakeItemSchema, MetaProjectConfigSchema, SessionBindingSchema, WORK_ORIGINS, intakePollSettingsOf, intakeSystemOf, sessionSurfaceKey, sessionBindingKey, intakeCallsKey, intakeItemIdOf, intakeItemKey, intakeSourceKey, type OrgId } from "@rovara-code/contracts";

const ORG: OrgId = "org_aaaaaaaaaaaaaaaaaaaa";
const MEMBER = "a".repeat(64);
const REQUEST = "0b1c2d3e-4f50-4162-8374-8495a6b7c8d9";
const ITEM = { kind: "tracker_item" as const, system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" };

describe("the tracker_item binding", () => {
  it("is a session binding with a system, an id and an https link", () => {
    expect(SessionBindingSchema.parse(ITEM)).toEqual(ITEM);
  });

  it.each([
    ["an http link", { ...ITEM, url: "http://acme.atlassian.net/browse/PAY-12" }],
    ["a link with a password", { ...ITEM, url: "https://u:p@acme.atlassian.net/x" }],
    ["a system with capitals", { ...ITEM, system: "Jira" }],
    ["an id with a #", { ...ITEM, id: "owner/repo#1" }],
    ["an id with a space", { ...ITEM, id: "PAY 12" }],
    ["an extra key", { ...ITEM, extra: 1 }],
  ])("refuses %s", (_name, value) => {
    expect(SessionBindingSchema.safeParse(value).success).toBe(false);
  });

  it("has a surface key of its own, per system and id, in the org's partition", () => {
    const key = sessionSurfaceKey(ORG, ITEM);
    expect(key.pk).toContain("SESSION_SURFACE");
    expect(key.sk).toBe("TRACKER#jira#PAY-12");
    expect(sessionSurfaceKey(ORG, { ...ITEM, system: "sim" }).sk).not.toBe(key.sk);
    expect(sessionSurfaceKey(ORG, { ...ITEM, id: "PAY-13" }).sk).not.toBe(key.sk);
  });

  it("has its own binding item per session", () => {
    expect(sessionBindingKey(ORG, "ses_aaaaaaaaaaaaaaaaaaaa", "tracker_item").sk).toBe("BINDING#tracker_item");
  });
});

describe("intents from trackers", () => {
  const base = { requestId: REQUEST, project: "web", input: { text: "Work on PAY-12" } };

  it("adds the jira, github_issue and tracker sources, each bound to a tracker_item", () => {
    expect(CODE_INTENT_SOURCES).toEqual(expect.arrayContaining(["jira", "github_issue", "tracker"]));
    expect(CODE_INTENT_BINDING_OF_SOURCE).toMatchObject({ jira: "tracker_item", github_issue: "tracker_item", tracker: "tracker_item" });
  });

  it("accepts a Jira intent that names a jira ticket", () => {
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "jira", binding: ITEM }).success).toBe(true);
  });

  it("accepts a GitHub Issues intent only for the system github, and a tracker intent for any other system", () => {
    const github = { ...ITEM, system: "github", id: "acme/web/7", url: "https://github.com/acme/web/issues/7" };
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "github_issue", binding: github }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "github_issue", binding: ITEM }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "jira", binding: github }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "tracker", binding: { ...ITEM, system: "sim", id: "T-1" } }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "tracker", binding: ITEM }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "tracker", binding: { ...ITEM, system: "github" } }).success).toBe(false);
  });

  it("refuses a tracker intent with no ticket, and a ticket on an intent from elsewhere", () => {
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "jira" }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "app", binding: ITEM }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "linear", binding: ITEM }).success).toBe(false);
  });

  it("keeps the older sources as they were", () => {
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "app" }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "linear", binding: { kind: "linear_issue", issueId: "ENG-1", url: "https://linear.app/a/issue/ENG-1" } }).success).toBe(true);
  });

  it("has a work origin for each new source, so a run can say where it came from", () => {
    for (const source of ["jira", "github_issue", "tracker"]) expect(WORK_ORIGINS).toContain(source);
  });
});

describe("IntakeItem", () => {
  const item = {
    channel: "jira", externalRef: { system: "jira", id: "PAY-12", url: ITEM.url },
    requester: { display: "Dana", standing: "outsider" }, title: "Refunds fail", fetchedAt: "2026-10-31T10:00:00.000Z",
  };

  it("accepts an outsider's ticket that nobody has started", () => {
    expect(IntakeItemSchema.safeParse(item).success).toBe(true);
  });

  it("names the member whose act started it", () => {
    expect(IntakeItemSchema.safeParse({ ...item, requester: { display: "Dana", standing: "member", developerId: MEMBER }, startedBy: { developerId: MEMBER } }).success).toBe(true);
  });

  it("refuses a member with no id, an outsider with an id, and a tracker ticket with no external reference", () => {
    expect(IntakeItemSchema.safeParse({ ...item, requester: { display: "Dana", standing: "member" } }).success).toBe(false);
    expect(IntakeItemSchema.safeParse({ ...item, requester: { display: "Dana", standing: "outsider", developerId: MEMBER } }).success).toBe(false);
    const without: Record<string, unknown> = { ...item };
    delete without["externalRef"];
    expect(IntakeItemSchema.safeParse(without).success).toBe(false);
    expect(IntakeItemSchema.safeParse({ ...without, channel: "web", requester: { display: "Dana", standing: "member", developerId: MEMBER } }).success).toBe(true);
  });

  it("refuses control and invisible characters in the title and the name", () => {
    expect(IntakeItemSchema.safeParse({ ...item, title: "Refunds​fail" }).success).toBe(false);
    expect(IntakeItemSchema.safeParse({ ...item, requester: { display: "Da\u0000na", standing: "outsider" } }).success).toBe(false);
  });
});

describe("IntakeChannelRef", () => {
  const ref = { channel: "tracker", system: "sim", when: { label: "rovara" } };

  it("names a tracker system, and what asks for work", () => {
    expect(IntakeChannelRefSchema.safeParse(ref).success).toBe(true);
    expect(intakeSystemOf({ channel: "jira" })).toBe("jira");
    expect(intakeSystemOf({ channel: "github_issue" })).toBe("github");
    expect(intakeSystemOf({ channel: "tracker", system: "sim" })).toBe("sim");
  });

  it.each([
    ["a tracker with no system", { channel: "tracker", when: { label: "rovara" } }],
    ["a tracker that is Jira", { channel: "tracker", system: "jira", when: { label: "rovara" } }],
    ["a Jira channel with another system", { channel: "jira", system: "sim", when: { label: "rovara" } }],
    ["nothing that asks for work", { channel: "jira", when: {} }],
    ["an address as the connection", { channel: "jira", connection: "https://evil.example", when: { label: "r" } }],
    ["a poll every 0 minutes", { ...ref, poll: { everyMinutes: 0 } }],
    ["a poll above the ceiling", { ...ref, poll: { maxCallsPerHour: 100000 } }],
    ["an unknown key", { ...ref, token: "x" }],
  ])("refuses %s", (_name, value) => {
    expect(IntakeChannelRefSchema.safeParse(value).success).toBe(false);
  });

  it("defaults a poll to every 2 minutes and 60 reads an hour, and takes the source's own settings inside the limits", () => {
    expect(intakePollSettingsOf(undefined)).toEqual({ everyMinutes: 2, maxCallsPerHour: 60 });
    expect(intakePollSettingsOf({ everyMinutes: 5 })).toEqual({ everyMinutes: 5, maxCallsPerHour: 60 });
    expect(intakePollSettingsOf({ maxCallsPerHour: 10, everyMinutes: 1 })).toEqual({ everyMinutes: 1, maxCallsPerHour: 10 });
  });

  it("is what the meta repo config's intake section holds now, no longer an opaque section", () => {
    expect(MetaProjectConfigSchema.safeParse({ version: 1, intake: [ref] }).success).toBe(true);
    expect(MetaProjectConfigSchema.safeParse({ version: 1, intake: [{ anything: "goes" }] }).success).toBe(false);
  });
});

describe("the keys of intake", () => {
  const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";

  it("gives the same ticket the same item id, and another ticket or another system another one", () => {
    expect(intakeItemIdOf("jira", "PAY-12")).toMatch(/^[a-f0-9]{32}$/);
    expect(intakeItemIdOf("jira", "PAY-12")).toBe(intakeItemIdOf("jira", "PAY-12"));
    expect(intakeItemIdOf("jira", "PAY-12")).not.toBe(intakeItemIdOf("jira", "PAY-13"));
    expect(intakeItemIdOf("jira", "PAY-12")).not.toBe(intakeItemIdOf("sim", "PAY-12"));
    // A boundary that moves does not make two tickets one: ("a", "b-c") is not ("a-b", "c").
    expect(intakeItemIdOf("a", "b-c")).not.toBe(intakeItemIdOf("a-b", "c"));
  });

  it("keeps an item in its org's and project's partition, and refuses an id that is not one", () => {
    const id = intakeItemIdOf("jira", "PAY-12");
    expect(intakeItemKey(ORG, "web", id).pk).not.toBe(intakeItemKey(OTHER_ORG, "web", id).pk);
    expect(intakeItemKey(ORG, "web", id).pk).not.toBe(intakeItemKey(ORG, "api", id).pk);
    expect(() => intakeItemKey(ORG, "web", "PAY-12")).toThrow();
    expect(() => intakeItemKey(ORG, "we#b", id)).toThrow();
  });

  it("keeps a source in the global list with the org and project in the sort key, so a project's sources are one prefix", () => {
    expect(intakeSourceKey(ORG, "web", "abc")).toEqual({ pk: "INTAKE_SOURCES", sk: `${ORG}#web#abc` });
    expect(intakeSourceKey(OTHER_ORG, "web", "abc").sk.startsWith(`${OTHER_ORG}#`)).toBe(true);
  });

  it("counts reads per source per hour in the org's partition", () => {
    expect(intakeCallsKey(ORG, "abc", "2026-10-31T10").sk).toBe("2026-10-31T10");
    expect(intakeCallsKey(ORG, "abc", "2026-10-31T10").pk).not.toBe(intakeCallsKey(OTHER_ORG, "abc", "2026-10-31T10").pk);
    expect(() => intakeCallsKey(ORG, "abc", "2026-10-31")).toThrow();
  });
});
