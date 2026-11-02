// Per-editor rows (lane team-record-links): the pieces that decide whose words a change row holds, and how a reader puts an item back together.
import { describe, expect, it } from "vitest";
import { addedText } from "../../../packages/broker/src/team-record/sources/common.js";
import { assembleItem } from "../../../packages/broker/src/team-record/item-assembly.js";
import { RecordEventSchema } from "@agentx/contracts";
import { ORG_A } from "../../support/team-record-core.js";

describe("addedText: an editor is credited with the lines they added, never the author's", () => {
  it("returns only the new lines, counting a repeated line once per time it was added", () => {
    expect(addedText("a\nb", "a\nb\nc")).toBe("c");
    expect(addedText("a", "a\na")).toBe("a");
    expect(addedText("a\nb", "b\nnew\na")).toBe("new");
  });
  it("fails closed: unknown earlier text, nothing added, or text that does not line up with the earlier text gives nothing", () => {
    expect(addedText(undefined, "x")).toBeUndefined();
    expect(addedText("a", undefined)).toBeUndefined();
    expect(addedText("a\nb", "a")).toBeUndefined();
    expect(addedText("author words", "completely different markup")).toBeUndefined();
  });
  it("an earlier text that was empty makes everything new", () => {
    expect(addedText("", "first words")).toBe("first words");
  });
});

describe("assembleItem: the rows of one item read together, in order", () => {
  const row = (id: string, order: number, text: string | undefined, over: Record<string, unknown> = {}) => RecordEventSchema.parse({
    id, workspaceId: ORG_A, project: "web", source: "linear", sourceRef: { system: "linear", id: "issue:1", version: `v${String(order)}`, order }, scope: "linear:team/t1", kind: order === 1 ? "ticket.created" : "ticket.updated",
    occurredAt: new Date(order * 1000).toISOString(), trust: "member", audience: { kind: "project" }, ...(text === undefined ? {} : { text }), links: [], retention: "C", hotExpiresAt: 1, indexExpiresAt: 1, ...over,
  });
  it("orders by the change's place whatever order they arrive in, joins the words, takes the latest time and the lowest trust", () => {
    const view = assembleItem([row("00000000-0000-4000-8000-000000000003", 3, undefined), row("00000000-0000-4000-8000-000000000002", 2, "second", { trust: "outsider" }), row("00000000-0000-4000-8000-000000000001", 1, "first")]);
    expect(view.text).toBe("first\n\nsecond");
    expect(view.kind).toBe("ticket.created");
    expect(view.occurredAt).toBe(new Date(3000).toISOString());
    expect(view.trust).toBe("outsider");
  });
  it("an item with no words reads with none", () => {
    expect(assembleItem([row("00000000-0000-4000-8000-000000000001", 1, undefined)]).text).toBeUndefined();
  });
});
