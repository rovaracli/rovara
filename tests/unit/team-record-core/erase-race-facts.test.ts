// Review item 3: a fact's audience comes from an earlier read of the rows it was distilled from. An erase can finish between that read and the fact's write; for every interleaving
// the stored fact must not name the erased person. (Nothing indexes a fact by the people on its list, so neither erase pass could find one.)
import { describe, expect, it } from "vitest";
import { recordFactKey } from "@agentx/contracts";
import { createTransientDistiller } from "../../../packages/broker/src/team-record/transient-distiller.js";
import { putFactClean } from "../../../packages/broker/src/team-record/fact-write.js";
import { markAccessErased, observeRowAccess } from "../../../packages/broker/src/team-record/access.js";
import { putDerivationLinks } from "../../../packages/broker/src/team-record/store.js";
import { ORG_A, addSource, githubDraft, world, type World } from "../../support/team-record-core.js";
import { dirtyInterleavings } from "../../support/erase-interleave.js";

const T1 = "2026-10-30T09:00:00.000Z";
const SC = "slack:T1/C40";
const acl = (principals: string[]) => ({ kind: "restricted" as const, acl: { source: "slack", scope: SC, principals, capturedAt: T1, liveCheck: "none" as const } });
const FACT = "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0001";
const fact = (principals: string[]) => ({ id: FACT, workspaceId: ORG_A, project: "web", kind: "note" as const, text: "We pin the base image.", links: [], derivedFrom: ["T1:m1"], trust: "member" as const, audience: acl(principals), createdAt: T1 });
const factsNaming = (w: World, id: string): number => w.db.find((item) => item.entityType === "TEAM_RECORD_FACT").filter((item) => JSON.stringify(item.audience).includes(id)).length;

describe("a fact is written with the markers read again", () => {
  it("putFactClean: for every storage call the erase can land after, no fact names the person", async () => {
    // The place already has a row that lists the person (so it has the access record and the person's index item an erase starts from). The op writes the derivation link FIRST and the
    // fact second, the order the distiller uses: the erase finds the fact through its link whenever it lands after the fact exists.
    const op = async (w: World) => {
      await putDerivationLinks(w.table, { orgId: ORG_A, project: "web", factId: FACT, sources: [{ system: "T1", sourceId: "m1", scope: SC }], at: T1 });
      await putFactClean(w.table, ORG_A, fact(["U1", "UX"]), [SC]);
    };
    const seed = async () => {
      const w = world(); await addSource(w, { source: "slack", scope: SC });
      await w.sink.put(githubDraft({ source: "slack", kind: "slack.message", repo: undefined, occurredAt: T1, sourceRef: { system: "T1", id: "m1", version: "1" }, audience: acl(["U1", "UX"]), actor: { sourceId: "U1", trust: "member" }, text: "launch plan", links: [] }));
      return w;
    };
    const result = await dirtyInterleavings({ person: "UX", seed, op, retryOnThrow: true });
    expect(result.dirty).toEqual([]);
  });
  it("a person already erased is left out of the list before the write", async () => {
    const w = world();
    await markAccessErased(w.table, ORG_A, ["UX"], T1);
    await putFactClean(w.table, ORG_A, fact(["U1", "UX"]), [SC]);
    expect(factsNaming(w, "UX")).toBe(0);
    expect(w.db.get(recordFactKey(ORG_A, "web", FACT))).toBeDefined();
  });
  it("the transient distiller writes its notes the same way (every interleaving)", async () => {
    const make = async () => {
      const w = world({ edition: "public" }); await addSource(w, { source: "slack", scope: SC, retention: "B", notesOptIn: true });
      // the place's access record already lists the person (an earlier message of the place): the person's index item exists, which is where an erase starts
      await observeRowAccess(w.table, ORG_A, acl(["U1", "UX"]).acl);
      return w;
    };
    const message = { workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: T1, sourceRef: { system: "T1", id: "C40/1.1", version: "m:1" }, actor: { sourceId: "U1", trust: "member" }, trust: "member", audience: acl(["U1", "UX"]), links: ["https://github.com/acme/api/pull/1"], retention: "B", text: "we pin the base image" };
    const result = await dirtyInterleavings({
      person: "UX", seed: make, retryOnThrow: true,
      op: (w) => createTransientDistiller({ ingest: w.deps, distill: { model: async () => JSON.stringify({ facts: [{ kind: "note", text: "A note.", links: [] }] }), now: () => T1, newId: () => FACT } }).distillTransient(message as never),
    });
    expect(result.dirty).toEqual([]);
  });
  it("the transient distiller really writes a note in this setup (the interleaving test is not vacuous)", async () => {
    const w = world({ edition: "public" }); await addSource(w, { source: "slack", scope: SC, retention: "B", notesOptIn: true });
    const message = { workspaceId: ORG_A, project: "web", source: "slack", kind: "slack.message", occurredAt: T1, sourceRef: { system: "T1", id: "C40/1.1", version: "m:1" }, actor: { sourceId: "U1", trust: "member" }, trust: "member", audience: acl(["U1", "UX"]), links: ["https://github.com/acme/api/pull/1"], retention: "B", text: "we pin the base image" };
    await createTransientDistiller({ ingest: w.deps, distill: { model: async () => JSON.stringify({ facts: [{ kind: "note", text: "A note.", links: [] }] }), now: () => T1, newId: () => FACT } }).distillTransient(message as never);
    expect(w.db.find((item) => item.entityType === "TEAM_RECORD_FACT")).toHaveLength(1);
    expect(factsNaming(w, "UX")).toBe(1);
  });
});
