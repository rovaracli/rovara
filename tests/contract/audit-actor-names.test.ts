// QA6-09: the Audit page's member names. Display names only (never an email), only for this org's people, "A former member" for an erased person, and a failure leaves a person unnamed.
import { describe, expect, it } from "vitest";
import { orgMemberKey } from "@agentx/contracts";
import { FORMER_MEMBER, auditActorNamesFor, auditActorNamesOf } from "../../packages/broker/src/audit/actor-names.js";
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
