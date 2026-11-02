// TRW-4: tracker author links, and the count of rows skipped for want of one.
import { describe, expect, it } from "vitest";
import { developerOfTrackerAuthor, linkTrackerByVerifiedEmail, linkTrackerIdentity, removeTrackerLinks, trackerLinksOf } from "../../packages/broker/src/team-record/identity-links.js";
import { markPersonErased } from "../../packages/broker/src/team-record/erased.js";
import { needsLinkedAuthor, unlinkedCounter } from "../../packages/broker/src/team-record/unlinked.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ORG_A, ORG_B, T0 } from "../support/team-record-core.js";

const indexKeys = { gsi1: { partition: "gsi1pk" }, gsi2: { partition: "gsi2pk" }, gsi3: { partition: "gsi3pk", sort: "gsi3sk" }, gsi4: { partition: "gsi4pk" }, gsi5: { partition: "gsi5pk", sort: "textDueAt" } };
const world = () => { const db = new FakeDynamoDb({ indexKeys }); return { db, table: { documentClient: db, tableName: "TeamRecord" } }; };
const AT = new Date(T0).toISOString();
/** dev-1 and dev-2 belong to org A; dev-other belongs to org B; dev-gone to none. */
const members = { orgOfDeveloper: async (developerId: string) => (developerId === "dev-1" || developerId === "dev-2" ? ORG_A : developerId === "dev-other" ? ORG_B : undefined) };

describe("tracker links", () => {
  it("links a Linear or Jira author to a person; the link is per org and answers nothing for another org", async () => {
    const { table } = world();
    expect(await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-1", developerId: "dev-1", via: "connect", at: AT }, members)).toBe(true);
    expect(await linkTrackerIdentity(table, ORG_A, { system: "jira:acme.atlassian.net", sourceId: "acc-1", developerId: "dev-1", via: "signin", at: AT }, members)).toBe(true);
    expect(await developerOfTrackerAuthor(table, ORG_A, { system: "linear", sourceId: "u-1" })).toBe("dev-1");
    expect(await developerOfTrackerAuthor(table, ORG_B, { system: "linear", sourceId: "u-1" })).toBeUndefined();
    expect(await developerOfTrackerAuthor(table, ORG_A, { system: "linear", sourceId: "u-2" })).toBeUndefined();
    expect((await trackerLinksOf(table, ORG_A, "dev-1")).map((link) => `${link.system}/${link.sourceId}`).sort()).toStrictEqual(["jira:acme.atlassian.net/acc-1", "linear/u-1"]);
  });

  it("refuses an id or a system that is not well formed, a system that is not a tracker, and a person who has been erased", async () => {
    const { table } = world();
    for (const bad of [{ system: "github", sourceId: "1" }, { system: "linear", sourceId: "" }, { system: "linear", sourceId: "a b" }, { system: "jira:", sourceId: "x" }]) {
      expect(await linkTrackerIdentity(table, ORG_A, { ...bad, developerId: "dev-1", via: "connect", at: AT }, members), JSON.stringify(bad)).toBe(false);
    }
    await markPersonErased(table, ORG_A, { developerId: "dev-1" }, AT);
    expect(await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-9", developerId: "dev-1", via: "connect", at: AT }, members)).toBe(false);
  });

  it("refuses a person who is not a member of THIS org (connect and sign-in), and links nothing for them", async () => {
    const { db, table } = world();
    expect(await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-b", developerId: "dev-other", via: "connect", at: AT }, members)).toBe(false);
    expect(await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-g", developerId: "dev-gone", via: "signin", at: AT }, members)).toBe(false);
    expect(await developerOfTrackerAuthor(table, ORG_A, { system: "linear", sourceId: "u-b" })).toBeUndefined();
    expect(db.find(() => true)).toStrictEqual([]);
  });

  it("an author id moved to another person leaves the first person with no link to it", async () => {
    const { table } = world();
    await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-1", developerId: "dev-1", via: "connect", at: AT }, members);
    await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-1", developerId: "dev-2", via: "connect", at: AT }, members);
    expect(await developerOfTrackerAuthor(table, ORG_A, { system: "linear", sourceId: "u-1" })).toBe("dev-2");
    expect(await trackerLinksOf(table, ORG_A, "dev-1")).toStrictEqual([]);
  });

  it("removes a person's links, both items of each, and no one else's", async () => {
    const { db, table } = world();
    await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-1", developerId: "dev-1", via: "connect", at: AT }, members);
    await linkTrackerIdentity(table, ORG_A, { system: "jira:acme.atlassian.net", sourceId: "acc-1", developerId: "dev-1", via: "connect", at: AT }, members);
    await linkTrackerIdentity(table, ORG_A, { system: "linear", sourceId: "u-2", developerId: "dev-2", via: "connect", at: AT }, members);
    expect(await removeTrackerLinks(table, ORG_A, "dev-1")).toBe(true);
    expect(await developerOfTrackerAuthor(table, ORG_A, { system: "linear", sourceId: "u-1" })).toBeUndefined();
    expect(await trackerLinksOf(table, ORG_A, "dev-1")).toStrictEqual([]);
    expect(await developerOfTrackerAuthor(table, ORG_A, { system: "linear", sourceId: "u-2" })).toBe("dev-2");
    expect(JSON.stringify(db.find(() => true))).not.toContain("acc-1");
  });
});

describe("a link by the tracker's email", () => {
  const deps = { developerForVerifiedEmail: async (email: string) => (email === "ann@acme.test" ? "dev-ann" : undefined), orgOfDeveloper: async (developerId: string) => (developerId === "dev-ann" ? ORG_A : undefined) };

  it("links only when the tracker says the email is verified, to the member that email names, in that member's org", async () => {
    const { table } = world();
    const input = { system: "linear", sourceId: "u-ann", email: "ann@acme.test", at: AT };
    expect(await linkTrackerByVerifiedEmail(table, deps, ORG_A, { ...input, emailVerified: undefined })).toBe(false);
    expect(await linkTrackerByVerifiedEmail(table, deps, ORG_A, { ...input, emailVerified: false })).toBe(false);
    expect(await developerOfTrackerAuthor(table, ORG_A, input)).toBeUndefined();
    expect(await linkTrackerByVerifiedEmail(table, deps, ORG_B, { ...input, emailVerified: true })).toBe(false);
    expect(await linkTrackerByVerifiedEmail(table, deps, ORG_A, { ...input, email: "nobody@acme.test", emailVerified: true })).toBe(false);
    expect(await linkTrackerByVerifiedEmail(table, deps, ORG_A, { ...input, emailVerified: true })).toBe(true);
    expect(await developerOfTrackerAuthor(table, ORG_A, input)).toBe("dev-ann");
  });
});

describe("rows skipped for want of a linked author", () => {
  it("a draft needs a linked author unless it is Rovara's own or a bot's", () => {
    expect(needsLinkedAuthor({ source: "slack", actor: { trust: "outsider" } })).toBe(true);
    expect(needsLinkedAuthor({ source: "linear" })).toBe(true);
    expect(needsLinkedAuthor({ source: "github", actor: { developerId: "dev-1", trust: "member" } })).toBe(false);
    expect(needsLinkedAuthor({ source: "github", actor: { developerId: "dev-1", trust: "outsider" } })).toBe(false);
    expect(needsLinkedAuthor({ source: "github", actor: { trust: "system" } })).toBe(false);
    expect(needsLinkedAuthor({ source: "rovara" })).toBe(false);
  });

  it("counts per org, project and source, and reads back only that project's counts", async () => {
    const { table } = world();
    const counter = unlinkedCounter(table, () => T0);
    await counter.count(ORG_A, "web", "slack");
    await counter.count(ORG_A, "web", "slack");
    await counter.count(ORG_A, "web", "linear");
    await counter.count(ORG_A, "api", "jira");
    await counter.count(ORG_B, "web", "slack");
    expect(await counter.read(ORG_A, "web")).toStrictEqual({ slack: 2, linear: 1 });
    expect(await counter.read(ORG_A, "api")).toStrictEqual({ jira: 1 });
    expect(await counter.read(ORG_B, "api")).toStrictEqual({});
  });
});
