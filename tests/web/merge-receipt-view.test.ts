// @vitest-environment jsdom
// Lifecycle UI, per-PR merge receipt (boards 3h, 9a/9b, 15j/18u; CONTRACTS R1a). The receipt reader and producer are held, so the view is tested on the contract's own literal fixtures and overlays: initial, prepared,
// witnessed-then-failed-refresh, external partial, stopped before the host, legacy and empty legacy. The view is not mounted in the product yet.
import { expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { MergeReceiptView, needsCheck, rowOutcome, type JournalFacts, type JournalRow, type LegacyFacts } from "../../packages/ui/src/screens/session/MergeReceiptView.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";

const ID = "11111111-1111-4111-8111-111111111111", A = "a".repeat(40), B = "b".repeat(40);
const T0 = "2026-11-20T01:00:00.000Z", T1 = "2026-11-20T01:00:01.000Z", T2 = "2026-11-20T01:00:02.000Z", T3 = "2026-11-20T01:00:03.000Z";
const row = (over: Partial<JournalRow> = {}): JournalRow => ({ repositoryId: "org/repo", number: 7, expectedHead: A, attempt: "not_started", observed: "unknown", ...over });
const journal = (over: Partial<JournalFacts> & { rows?: JournalRow[] } = {}): JournalFacts => { const { rows = [row()], ...rest } = over; return { kind: "journal", requestId: ID, updatedAt: T0, execution: "active", status: "pending", intent: { expectedHeads: rows.map(r => ({ repositoryId: r.repositoryId, number: r.number, headSha: r.expectedHead })), risk: "low" }, pullRequests: rows, ...rest }; };
const prepared = { workflowRevision: 4, mergeMethod: "squash" as const, order: [{ repositoryId: "org/repo", number: 7 }] };
const show = (facts: JournalFacts | LegacyFacts, onCheck?: () => void) => renderUi(h(MergeReceiptView, { facts, onCheck }));
const headline = () => screen.getByRole("region", { name: "Merge receipt" }).querySelector(".rv-merge-state")!.textContent;
const text = () => screen.getByRole("region", { name: "Merge receipt" }).textContent;

it("initial accepted request: in progress, nothing observed, nothing said about GitHub, no Check offered", async () => {
  const ui = show(journal());
  expect(headline()).toBe("Merge in progress");
  expect(text()).toContain("Not read from GitHub yet.");
  expect(text()).toContain("Waiting");
  expect(screen.queryByRole("button")).toBeNull();
  await expectNoAxeViolations(ui.container);
  ui.unmount();
});

it("prepared and in flight: the open reading does not finish the attempt; Check is the only action and it is a callback, never a merge", async () => {
  const onCheck = vi.fn();
  const facts = journal({ updatedAt: T2, intent: { expectedHeads: [{ repositoryId: "org/repo", number: 7, headSha: A }], risk: "low", prepared }, rows: [row({ url: "https://github.com/org/repo/pull/7", attempt: "in_flight", observed: "open", observedHead: A, checkedAt: T2, check: { outcome: "ok", attemptedAt: T1 } })] });
  expect(needsCheck(facts)).toBe(true);
  const ui = show(facts, onCheck);
  expect(text()).toContain("GitHub showed it open");
  expect(text()).toContain("will not send another merge for this request");
  expect(screen.getAllByRole("button").map(b => b.textContent)).toEqual(["Check GitHub now"]);
  fireEvent.click(screen.getByRole("button", { name: "Check GitHub now" }));
  expect(onCheck).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("link", { name: "Open on GitHub: org/repo #7" }).getAttribute("href")).toBe("https://github.com/org/repo/pull/7");
  await expectNoAxeViolations(ui.container);
  ui.unmount();
});

it("without a Check owner there is no button, only the safe words", () => {
  const ui = show(journal({ status: "unknown", execution: "uncertain", rows: [row({ attempt: "unknown" })] }));
  expect(screen.queryByRole("button")).toBeNull();
  expect(headline()).toBe("The result isn't confirmed yet");
  for (const words of ["What happened", "What is safe", "What to do", "Reload this page in a moment"]) expect(text()).toContain(words);
  ui.unmount();
});

it("witnessed success then a failed refresh: merged by the attempt, the earlier reading stays and is labelled", async () => {
  const facts = journal({ updatedAt: T3, execution: "complete", status: "merged", intent: { expectedHeads: [{ repositoryId: "org/repo", number: 7, headSha: A }], risk: "low", prepared }, rows: [row({ attempt: "merged", observed: "open", observedHead: A, checkedAt: T2, check: { outcome: "failed", attemptedAt: T3 } })] });
  const ui = show(facts);
  expect(headline()).toBe("org/repo #7 is merged");
  expect(text()).toContain("accepted by GitHub");
  expect(text()).toContain("failed; this is the earlier reading");
  expect(screen.queryByRole("button")).toBeNull();
  await expectNoAxeViolations(ui.container);
  ui.unmount();
});

it("external merge at a different head with an unresolved attempt: an observation, not this request's merge, and the moved head is called out", async () => {
  const other: JournalRow = row({ number: 8, expectedHead: B, attempt: "unknown" });
  const facts = journal({ updatedAt: T2, execution: "uncertain", status: "partial", intent: { expectedHeads: [{ repositoryId: "org/repo", number: 7, headSha: A }, { repositoryId: "org/repo", number: 8, headSha: B }], risk: "medium", prepared: { ...prepared, order: [{ repositoryId: "org/repo", number: 7 }, { repositoryId: "org/repo", number: 8 }] } },
   rows: [row({ attempt: "unknown", observed: "merged", observedHead: B, checkedAt: T2, check: { outcome: "ok", attemptedAt: T2 } }), other] });
  const ui = show(facts, () => undefined);
  expect(headline()).toBe("1 of 2 pull requests merged");
  const rows = within(screen.getByRole("list", { name: "Pull requests" })).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain("Merged on GitHub");
  expect(rows[0]!.textContent).toContain("Rovara can't say whether its merge or something else did it");
  expect(rows[0]!.textContent).toContain("Head moved");
  expect(rows[0]!.textContent).not.toMatch(/accepted by GitHub|merged by/iu);
  expect(rows[1]!.textContent).toContain("didn't hear back");
  await expectNoAxeViolations(ui.container);
  ui.unmount();
});

it("an observation alone is never worded as this request's merge (row outcome)", () => {
  for (const attempt of ["not_started", "unknown", "in_flight"] as const) {
    const outcome = rowOutcome(row({ attempt, observed: "merged", observedHead: A, checkedAt: T2 }), "uncertain");
    expect(outcome.chip).toBe("Merged on GitHub");
    expect(outcome.words).not.toContain("accepted by GitHub");
    expect(outcome.tone).toBe("idle");
  }
  expect(rowOutcome(row({ attempt: "merged" }), "complete").chip).toBe("Merged");
});

it("stopped before the host: nothing merged, nothing sent, no Check, and the refusal text is only the reviewed neutral sentence", () => {
  const ui = show(journal({ execution: "stopped", status: "not_merged", rows: [row()] }));
  expect(headline()).toBe("Nothing was merged by this request");
  expect(text()).toContain("Nothing was sent.");
  expect(needsCheck(journal({ execution: "stopped", status: "not_merged" }))).toBe(false);
  ui.unmount();
  const refused = show(journal({ execution: "complete", status: "not_merged", rows: [row({ attempt: "refused", refusal: "The merge was refused.", observed: "open", observedHead: A, checkedAt: T1 })] }));
  expect(text()).toContain("The merge was refused.");
  refused.unmount();
});

it("two pull requests are listed in the plan's order with a number each, each with its own answer", () => {
  const second = row({ number: 8, expectedHead: B, attempt: "merged" });
  const first = row({ attempt: "refused", refusal: "The merge was refused." });
  const ui = show(journal({ execution: "stopped", status: "partial", intent: { expectedHeads: [{ repositoryId: "org/repo", number: 8, headSha: B }, { repositoryId: "org/repo", number: 7, headSha: A }], risk: "low", prepared: { ...prepared, order: [{ repositoryId: "org/repo", number: 7 }, { repositoryId: "org/repo", number: 8 }] } }, rows: [second, first] }));
  const items = within(screen.getByRole("list", { name: "Pull requests" })).getAllByRole("listitem");
  expect(items.map(item => within(item).getByRole("heading").textContent)).toEqual(["org/repo #7", "org/repo #8"]);
  expect(items[0]!.textContent).toContain("Refused");
  expect(items[1]!.textContent).toContain("Merged");
  ui.unmount();
});

it("legacy success: historical, no invented heads, order or attribution; an empty list says details are unavailable", async () => {
  const legacy: LegacyFacts = { kind: "legacy_success", requestId: ID, status: "merged", updatedAt: T0, pullRequests: [{ repositoryId: "org/repo", number: 7 }] };
  const a = show(legacy);
  expect(headline()).toBe("Merged");
  expect(text()).toContain("org/repo #7");
  expect(text()).toContain("heads, order and who pressed Merge are not shown");
  expect(text()).not.toMatch(/head [0-9a-f]{7}/u);
  await expectNoAxeViolations(a.container);
  a.unmount();
  const b = show({ ...legacy, pullRequests: [] });
  expect(text()).toContain("so none are shown");
  b.unmount();
});

it("provider-looking text and unsafe links are never shown as links or markup", () => {
  const ui = show(journal({ rows: [row({ url: "https://evil.example/org/repo/pull/7", attempt: "refused", refusal: "The merge was refused.", repositoryId: "org/<b>repo</b>" })] }));
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByRole("region", { name: "Merge receipt" }).querySelector("b")).toBeNull();
  ui.unmount();
});
