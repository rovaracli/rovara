// QA6-09: the Audit page's member names. Display names only (never an email), only for this org's people, "A former member" for an erased person, and a failure leaves a person unnamed.
import { describe, expect, it } from "vitest";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { FORMER_MEMBER, auditActorNamesFor, cutName, auditActorNamesOf } from "../../packages/broker/src/audit/actor-names.js";
import type { AttributionReader } from "../../packages/broker/src/attribution/resolve.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const [priya, erased, outsider, broken, mailer] = ["1", "2", "3", "4", "5"].map((c) => c.repeat(64));

describe("auditActorNamesFor", () => {
  const reader: AttributionReader = {
    memberName: async (_org, id) => {
      if (id === broken) throw new Error("unreadable");
      if (id === outsider) return undefined;
      if (id === mailer) return "ravi@example.com";
      return id === priya ? "Priya Shah" : "Gone";
    },
    isErased: async (_org, id) => id === erased,
  };

  it("names this org's people, says a former member for an erased one, and leaves out strangers, unreadable ids and ids that are not people", async () => {
    const names = await auditActorNamesFor(reader, ORG)([priya!, erased!, outsider!, broken!, "system", "dev_1"]);
    expect(names).toEqual({ [priya!]: "Priya Shah", [erased!]: FORMER_MEMBER });
  });

  it("never shows an email address: a name that is one reads as the placeholder", async () => {
    const names = await auditActorNamesFor(reader, ORG)([mailer!]);
    expect(names[mailer!]).toMatch(/^Member [0-9a-f]{8}$/u);
    expect(JSON.stringify(names)).not.toContain("@");
  });
});

describe("auditActorNamesOf: the install's tables", () => {
  it("reads the org's member row and the chosen or sign-in name, never another org's person, and treats nobody as erased while the team record is off", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...orgMemberKey(ORG, priya!), orgId: ORG, developerId: priya!, role: "admin" });
    db.set({ pk: `DEVELOPER#${priya!}`, sk: "META", developerId: priya!, displayName: "Priya Shah" });
    db.set({ pk: `DEVELOPER#${outsider!}`, sk: "META", developerId: outsider!, displayName: "Not Ours" });
    const names = await auditActorNamesOf({ documentClient: db, stateTable: "state", signInTable: "signin", teamRecordTable: undefined, orgId: ORG })([priya!, outsider!]);
    expect(names).toEqual({ [priya!]: "Priya Shah" });
  });
});

describe("F1 and F5: long names and many lookups", () => {
  it("a name is cut to 80 characters and 100 UTF-16 units, never through an emoji, so the page's own limit always holds", () => {
    const emoji = "\u{1F600}".repeat(200);
    const cut = cutName(emoji);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(Array.from(cut)).toHaveLength(50);
    expect(cut.endsWith("\ud83d")).toBe(false);
    expect(cutName("a".repeat(300))).toHaveLength(80);
    expect(cutName("Priya Shah")).toBe("Priya Shah");
  });

  it("an emoji name comes back within the limit through the resolver", async () => {
    const reader: AttributionReader = { memberName: async () => "\u{1F600}".repeat(80), isErased: async () => false };
    const names = await auditActorNamesFor(reader, ORG)(["1".repeat(64)]);
    expect(names["1".repeat(64)]!.length).toBeLessThanOrEqual(100);
  });

  it("asks about each person once and at most 16 at a time", async () => {
    let running = 0, most = 0;
    const seen: string[] = [];
    const reader: AttributionReader = {
      isErased: async () => false,
      memberName: async (_org, id) => { seen.push(id); running += 1; most = Math.max(most, running); await new Promise((resolve) => setTimeout(resolve, 2)); running -= 1; return "Name"; },
    };
    const ids = Array.from({ length: 60 }, (_, index) => index.toString(16).padStart(2, "0").repeat(32));
    const names = await auditActorNamesFor(reader, ORG)([...ids, ...ids]);
    expect(Object.keys(names)).toHaveLength(60);
    expect(seen).toHaveLength(60);
    expect(most).toBeLessThanOrEqual(16);
    expect(most).toBeGreaterThan(1);
  });
});
