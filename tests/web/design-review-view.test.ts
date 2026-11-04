// @vitest-environment jsdom
// Design review (DR11): the view logic of the Design tab, and hostile model words rendered inert.
import { expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createElement as h } from "react";
import { designReviewDisagreements, inputProofSentence, FILES_READ_LABEL, CODE_CITATION_UNCHECKED } from "@agentx/contracts/web";
import { DesignTabView } from "../../packages/ui/src/screens/session/DesignTab.js";
import { classificationLine, citationLine, designTabModel, readDesignActions, readDesignReview, reviewerLine, usdWords } from "../../packages/ui/src/screens/session/design-review-view.js";
import { cleanApproveReason, openBlockersOnCard } from "../../packages/ui/src/design/design-review-card.js";
import { designReviewFixture, HOSTILE, HOSTILE_PLAIN } from "./support/design-review-fixture.js";

it("shows the classification line in fixed words, and Rovara's reading apart, labelled", () => {
 const review = designReviewFixture(), model = designTabModel(review);
 expect(model.classification).toBe("Design review: needed. Reason: adds a new API; changes the data model (Rovara's reading of the request).");
 expect(model.reading).toBe(HOSTILE_PLAIN);
 expect(model.classification).not.toContain("script");
 expect(classificationLine({ decidedBy: "person", reasons: [], fromQuick: true })).toContain("started from a Quick plan");
 expect(classificationLine({ decidedBy: "person_skip", reasons: [] })).toBe("Design review: skipped by a person.");
});

it("says the status, tier, and the estimate against what was spent", () => {
 const model = designTabModel(designReviewFixture());
 expect(model.statusWords).toBe("Done");
 expect(model.tierWords).toContain("Standard");
 expect(model.cost).toEqual({ estimate: "$1.10", spent: "$0.96", limit: "$10.00" });
 expect(usdWords(undefined)).toBe("not available");
 expect(designTabModel(designReviewFixture({ estimateUsd: undefined })).cost.estimate).toBe("not available");
});

it("words each reviewer's proof with the fixed sentence and never claims the proxy confirmed unless it did", () => {
 const review = designReviewFixture(), [comprehension, critic, codebase] = review.rounds[0]!.reviewers;
 expect(reviewerLine(critic!).proof).toBe(inputProofSentence("digest_only"));
 expect(reviewerLine(critic!).proof).toContain("were not checked");
 expect(reviewerLine(comprehension!).proof).toBe(inputProofSentence("proxy_first_call"));
 // The unverified one says why, says its result does not count, and claims no proof.
 const unverified = reviewerLine(codebase!);
 expect(unverified.verified).toBe(false);
 expect(unverified.proof).toContain("does not count");
 expect(unverified.proof).not.toContain("proxy");
 expect(reviewerLine(critic!).filesRead.label).toContain(FILES_READ_LABEL);
 // Every digest-only run on the whole tab: no sentence that says the proxy confirmed anything.
 const text = JSON.stringify(designTabModel(review));
 expect(text.match(/proxy's first call/gu)?.length).toBe(1);
});

it("groups findings by design section, worst first, with code in the packet plain and any other 'not checked'", () => {
 const round = designTabModel(designReviewFixture()).rounds[0]!;
 expect(round.groups.map(group => group.section)).toEqual(["§1", "§2", "§3"]);
 const blocker = round.groups.find(group => group.section === "§3")!.findings[0]!;
 expect(blocker.severityWords).toBe("Blocker");
 expect(blocker.citations.map(citation => citation.text)).toEqual([
  "design §3",
  "acme/payments:src/retry.ts:10-14",
  "acme/payments:src/never-opened.ts:3 (" + CODE_CITATION_UNCHECKED + ")",
 ]);
 expect(blocker.citations.map(citation => citation.unchecked)).toEqual([false, false, true]);
 expect(blocker.raw).toHaveLength(2);
 expect(blocker.resolution).toMatchObject({ action: "contested", settled: false });
 expect(blocker.resolution?.evidence[0]?.text).toBe("design §4");
 expect(round.unresolved).toBe(1);
});

it("links a code citation only through the encoded path and a base the task's own record gave", () => {
 const citation = { kind: "code" as const, repo: "acme/payments", path: "src/a b/%41/x#y.ts", startLine: 2, endLine: 4, anchor: "x", commit: "1234567" };
 expect(citationLine(citation, []).href).toBeUndefined();
 const linked = citationLine(citation, [], repo => repo === "acme/payments" ? "https://github.com/acme/payments" : undefined);
 expect(linked.href).toBe("https://github.com/acme/payments/blob/1234567/src/a%20b/%2541/x%23y.ts#L2-L4");
 // A path with a dot segment (even a percent-encoded one) gets no link at all, and a repository the task does not have gets none.
 expect(citationLine({ ...citation, path: "a/../b" }, [], () => "https://github.com/acme/payments").href).toBeUndefined();
 expect(citationLine({ ...citation, path: "a/%2e%2e/b" }, [], () => "https://github.com/acme/payments").href).toBeUndefined();
 expect(citationLine(citation, [], () => undefined).href).toBeUndefined();
});

it("lists the disagreements with both sides, from the same function the decision card counts", () => {
 const review = designReviewFixture(), model = designTabModel(review);
 const found = designReviewDisagreements(review);
 expect(model.disagreements.map(item => item.findingId)).toEqual(found.map(item => item.findingId));
 const contested = model.disagreements.find(item => item.findingId === "f1")!;
 expect(contested.kindWords).toBe("The planner contested this blocker with evidence.");
 expect(contested.reviewerSide.text).toBe(HOSTILE);
 expect(contested.plannerSide?.words).toBe("The planner disagrees, and gave evidence.");
 expect(contested.plannerSide?.evidence.map(citation => citation.text)).toEqual(["design §4"]);
 expect(model.disagreements.find(item => item.findingId === "f2")?.kindWords).toBe("The planner says it fixed this, and no reviewer read the fix.");
 expect(designTabModel(designReviewFixture({ status: "running" })).disagreements).toEqual([]);
});

it("labels the paraphrase as the reviewer's words and shows the question with Rovara's recommendation", () => {
 const model = designTabModel(designReviewFixture());
 expect(model.paraphrase?.by).toBe("In the words of the comprehension reviewer (not Rovara's statement)");
 expect(model.paraphrase?.text).toBe(HOSTILE);
 const question = model.questions!.questions[0]!;
 expect(question.options.map(option => [option.id, option.recommended])).toEqual([["a", false], ["b", true]]);
 expect(question.why).toBe("Keeps today's ranking for those rows.");
});

it("says why a review did not run, in plain words", () => {
 for (const [reason, words] of [["no_model_source", "no model source"], ["cost_declined", "cost was not approved"], ["inputs_unverified", "could not verify what the reviewers were given"], ["skipped", "skipped by a person"], ["rearm_limit", "sent back more often"]] as const) {
  const model = designTabModel(designReviewFixture({ status: "not_run", notRunReason: reason, rounds: [] }));
  expect(model.notRun).toContain(words);
 }
 expect(designTabModel(designReviewFixture({ status: "stopped_at_cap" })).notRun).toBe("Design review stopped because it reached the cost limit.");
});

it("reads an unreadable review as unreadable instead of guessing, and the buttons from the broker exactly", () => {
 expect(readDesignReview(undefined)).toBeUndefined();
 expect(readDesignReview({ status: "tomorrow" })).toBe("unreadable");
 expect(readDesignActions({ designFirst: true, skip: { allowed: false, because: "skip_off" } })).toEqual({ designFirst: true, skip: { allowed: false, because: "skip_off" } });
 expect(readDesignActions({ designFirst: true, skip: { allowed: false, because: "unknown" } })).toBeUndefined();
});

it("renders every model word as inert text: no script, image, markdown or link, and a bidirectional mark shows as a code", () => {
 const { container } = render(h(DesignTabView, { model: designTabModel(designReviewFixture()) }));
 expect(container.querySelector("script,img,iframe,object")).toBeNull();
 expect(container.querySelector("a")).toBeNull();
 expect(container.querySelector("strong")?.textContent).not.toBe("bold");
 // The hostile text is on the page as characters; the right-to-left override is shown, not obeyed.
 expect(container.textContent).toContain("<script>window.__pwned=1</script>");
 expect(container.textContent).toContain("[click me](https://evil.example/steal)");
 expect(container.textContent).toContain("[U+202E]");
 expect(container.textContent).not.toMatch(/[‮⁦]/u);
 expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
 const disagreements = within(screen.getByRole("region", { name: "Disagreements" }));
 expect(disagreements.getByText("The planner contested this blocker with evidence.", { exact: false })).toBeTruthy();
 expect(screen.getAllByText(/path at the pinned commit, not checked/u).length).toBeGreaterThan(0);
});

it("cleans the reason for an approve with an open blocker to one plain line, and reads the blocker count from the card chip", () => {
 expect(cleanApproveReason("  Known\n‮ gap,   accepted  ")).toBe("Known gap, accepted");
 expect(cleanApproveReason(" ‮ \n ")).toBeUndefined();
 expect(cleanApproveReason("x".repeat(500))?.length).toBe(200);
 expect(openBlockersOnCard([{ label: "Cost", value: "$1.00" }, { label: "Open blockers", value: "2" }])).toBe(2);
 expect(openBlockersOnCard([{ label: "Open blockers", value: "0" }])).toBe(0);
 expect(openBlockersOnCard([{ label: "Open blockers", value: "many" }])).toBe(0);
 expect(openBlockersOnCard([])).toBe(0);
});
