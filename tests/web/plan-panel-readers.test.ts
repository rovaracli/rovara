// OWNER DECISION 18: what the plan panel reads from the broker is checked field by field: anything malformed is left out (never shown), and a document outside the fixed list is no document.
import { describe, expect, it } from "vitest";
import { readPanelComments, readPanelView } from "../../packages/ui/src/api/plan-panel.js";
import { isPanelDocument, panelDocumentOfCard } from "../../packages/ui/src/screens/session/panel-docs.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("plan panel readers", () => {
  it("opens only the fixed documents, and maps each card to its own", () => {
    for (const ok of ["requirements", "design", "plan"]) expect(isPanelDocument(ok)).toBe(true);
    for (const bad of [null, undefined, "", "coding-plan", "<script>", "plan "]) expect(isPanelDocument(bad)).toBe(false);
    expect([panelDocumentOfCard("approve_plan"), panelDocumentOfCard("approve_design"), panelDocumentOfCard("approve_requirements"), panelDocumentOfCard("approve_requirements", "design"), panelDocumentOfCard("merge")])
      .toEqual(["plan", "design", "requirements", "design", undefined]);
  });

  it("reads a document's view and drops what is malformed; access is only ever what the server said true", () => {
    const view = readPanelView({
      document: "plan", versions: [{ version: 1, current: true, approved: false }, { version: "2" }], checks: [{ id: "unit", label: "Unit" }, { id: 3 }], waiting: true,
      access: { canComment: "yes", canDecide: true }, current: { version: 1, format: "structured", title: "T", why: [{ text: "W" }, {}], claims: [{ id: "1", text: "A", children: [{ id: "1.1" }] }, { text: "no id" }],
        decisions: [{ id: "d1", question: "Q", options: [{ id: "a", label: "A" }, { label: "no id" }] }], risks: ["R", 7], notChanging: [] },
    });
    expect(view).toMatchObject({ document: "plan", versions: [{ version: 1 }], checks: [{ id: "unit" }], waiting: true, access: { canComment: false, canDecide: true, canSuggest: false, canAsk: false } });
    expect(view.current).toMatchObject({ format: "structured", why: [{ text: "W", author: "Someone" }], claims: [{ id: "1", children: [] }], decisions: [{ id: "d1", options: [{ id: "a" }] }], risks: ["R"] });
    expect(readPanelView({ document: "secrets" }).document).toBe("plan");
    expect(readPanelView({ current: { version: 1, format: "html", markdown: "<b>x</b>" } }).current).toBeUndefined();
  });

  it("reads comments and suggestions, leaving out any without a real id or target", () => {
    const read = readPanelComments({ canRemember: true, comments: [
      { id: ID, document: "plan", version: 1, target: { kind: "claim", id: "2" }, author: { kind: "person", name: "Sam", you: true }, text: "Hi", rev: 2, learning: { remembered: false } },
      { id: "not-a-uuid", document: "plan", version: 1, target: { kind: "document" }, author: { kind: "person" }, text: "x" },
      { id: ID, document: "plan", version: 1, target: { kind: "file", id: "x" }, author: { kind: "person" }, text: "x" },
      { id: ID, document: "plan", version: 1, target: { kind: "document" }, author: { kind: "admin" }, text: "x" },
    ], suggestions: [{ document: "plan", decisionId: "d1", optionId: "a", name: "Sam" }, { decisionId: 1 }] });
    expect(read.comments).toEqual([{ id: ID, document: "plan", version: 1, target: { kind: "claim", id: "2" }, author: { kind: "person", name: "Sam", owner: false, you: true }, text: "Hi", edited: false, deleted: false, sent: false, rev: 2, remembered: false }]);
    expect(read.suggestions).toEqual([{ document: "plan", decisionId: "d1", optionId: "a", name: "Sam", you: false }]);
    expect(read.canRemember).toBe(true);
  });
});
