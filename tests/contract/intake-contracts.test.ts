// Meta repo lane F (F1): the generic intake contracts. A ticket from any tracker is one `IntakeItem`; a tracker item is one `tracker_item` binding beside the Slack thread
// and the Linear issue; a Jira, GitHub Issues or other-tracker intent names its ticket; a work origin exists for each new source.
import { describe, expect, it } from "vitest";
import { IntakeChannelRefSchema, IntakeItemSchema, MetaProjectConfigSchema, SessionBindingSchema, WORK_ORIGINS, intakePollSettingsOf, intakeSystemOf } from "../../packages/contracts/src/index.js";
const MEMBER = "a".repeat(64);
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
});

describe("intents from trackers", () => {

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
