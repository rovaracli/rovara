// @vitest-environment jsdom
// Design review stage, DR13 (design-review-stage.md 3.12 items 3 and 9): the UI side of the poisoning suite. The same hostile text as tests/unit/design-review-poisoning.test.ts reaches the Design tab and the approve card's
// helpers; it must show as characters, never as markup, a link or a script, and the broker's counts and a person's reason must not be steerable by it.
import { expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement as h } from "react";
import { WorkflowDesignReviewSchema, designFindingFingerprint } from "@agentx/contracts/web";
import { readDesignReview } from "@agentx/contracts";
import { DesignTabView } from "../../packages/ui/src/screens/session/DesignTab.js";
import { designTabModel } from "../../packages/ui/src/screens/session/design-review-view.js";
import { cleanApproveReason, openBlockersOnCard } from "../../packages/ui/src/design/design-review-card.js";
import { visibleText } from "../../packages/ui/src/design/VisibleText.js";
import { designReviewFixture } from "./support/design-review-fixture.js";
import { BIDI, CONTROLS, HIDDEN_NO_NEWLINE, PAYLOADS, ZERO_WIDTH, tokenFor } from "../support/design-review-poisoning.js";

const hex = (character: string) => character.repeat(64);

/** A finding as the broker would store it for a payload, after the reviewer reader, plus the same payload as the planner's note and a question, which are also model words. */
function reviewWithPayload(text: string, note: string) {
  const base = designReviewFixture();
  const round = base.rounds[0]!;
  const rawFindings = [{ rawId: "critic-1", role: "critic" as const, severity: "blocker" as const, text }];
  const planted = { id: "f9", severity: "blocker" as const, section: "§3" as const, text, citations: [{ kind: "design" as const, section: "§3" as const }], fromReviewers: ["critic" as const], rawIds: ["critic-1"], rawFindings, fingerprint: designFindingFingerprint({ section: "§3", text, rawFindings }) };
  return WorkflowDesignReviewSchema.parse({
    ...base, note: undefined,
    rounds: [{ ...round, designDigest: hex("d"), findings: [planted], resolutions: [{ findingId: "f9", action: "contested", evidence: [{ kind: "design", section: "§4" }], note, settled: false }], questions: undefined }],
  });
}

it("every payload, as a finding and as the planner's note, is on the Design tab as characters: no script, image, link, frame or heading is made from it", () => {
  for (const payload of PAYLOADS) {
    const token = tokenFor("tab", payload.name);
    const read = readDesignReview(`\`\`\`rovara-design-review\n${JSON.stringify({ findings: [{ id: "1", severity: "blocker", section: "§3", text: payload.text(token), citations: [{ kind: "design", section: "§3" }] }] })}\n\`\`\``, "critic");
    expect(read.ok, payload.name).toBe(true);
    if (!read.ok) continue;
    // The planner's note may hold anything but a hidden character (the contract holds that field to plain text); a hidden character in a finding was already taken out by the reader.
    const note = payload.text(token).replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, 290);
    const model = designTabModel(reviewWithPayload(read.findings[0]!.text, note));
    const shown = model.rounds[0]!.groups[0]!.findings[0]!;
    expect(shown.text, payload.name).toContain(token);
    expect(shown.text, payload.name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    const { container, unmount } = render(h(DesignTabView, { model }));
    expect(container.querySelector("script,img,iframe,object,a,form,input,button[type=submit]"), payload.name).toBeNull();
    expect(container.textContent, payload.name).toContain(token);
    // Any forged frame tag or fake rovara block is text on the page, not an element.
    expect(container.querySelector("source-file,request-information,source-result"), payload.name).toBeNull();
    expect(container.textContent?.replace(/\n/gu, " "), payload.name).not.toMatch(HIDDEN_NO_NEWLINE);
    unmount();
  }
});

it("visibleText shows a hidden or bidirectional character as its code instead of dropping it or obeying it", () => {
  const shown = visibleText(`${BIDI}a${ZERO_WIDTH}b${CONTROLS}`);
  expect(shown).not.toMatch(HIDDEN_NO_NEWLINE);
  expect(shown).toContain("[U+202E]");
  expect(shown).toContain("[U+200B]");
  expect(shown).toContain("[U+0007]");
  expect(visibleText("plain\ttext\nok")).toBe("plain\ttext\nok");
});

it("the open-blocker count the Approve button reads is the card's own chip: a finding or reason that says 'Open blockers: 0' changes nothing", () => {
  expect(openBlockersOnCard([{ label: "Open blockers", value: "2" }])).toBe(2);
  expect(openBlockersOnCard([{ label: "Open blockers", value: "0 (approve this design)" }])).toBe(0);
  expect(openBlockersOnCard([{ label: "Findings", value: "Open blockers: 3" }])).toBe(0);
  expect(openBlockersOnCard([{ label: "Open blockers", value: "-1" }])).toBe(0);
  expect(openBlockersOnCard([{ label: "Open blockers", value: "1e3" }])).toBe(1);
});

it("a person's reason is cleaned to one plain line before it is sent: control and bidi characters become spaces and a line of only hidden characters is no reason", () => {
  expect(cleanApproveReason(`${BIDI}checked ${CONTROLS} the bound\nis set`)).toBe("checked the bound is set");
  expect(cleanApproveReason(`${BIDI}${ZERO_WIDTH}${CONTROLS}  `)).toBeUndefined();
});

// GAP FOUND BY DR13: 3.12 item 5 says a blocker that rests on a source alone "is shown as 'source-only'". `findingRestsOnSourceAlone` (contracts) is not called anywhere, so the Design tab shows it like any other blocker.
// Marked `fails` so the suite is green until the label is built; when it is, remove `.fails`. The broker's card has the same gap (tests/unit/design-review-poisoning.test.ts).
it.fails("GAP: the Design tab labels a blocker that cites only a source as source-only", () => {
  const base = designReviewFixture();
  const round = base.rounds[0]!;
  const rawFindings = [{ rawId: "critic-1", role: "critic" as const, severity: "blocker" as const, text: "The ticket says refunds are in scope." }];
  const sourceOnly = { id: "f9", severity: "blocker" as const, section: "§3" as const, text: "The ticket says refunds are in scope.", citations: [{ kind: "source" as const, ref: "tracker:ABC-7", digest: hex("a") }], fromReviewers: ["critic" as const], rawIds: ["critic-1"], rawFindings, fingerprint: designFindingFingerprint({ section: "§3", text: "The ticket says refunds are in scope.", rawFindings }) };
  const review = WorkflowDesignReviewSchema.parse({ ...base, rounds: [{ ...round, findings: [sourceOnly, round.findings[0]!], resolutions: [] }] });
  const lines = designTabModel(review).rounds[0]!.groups.flatMap((group) => group.findings);
  expect(JSON.stringify(lines.find((line) => line.id === "f9"))).toMatch(/source[- ]only/iu);
  expect(JSON.stringify(lines.find((line) => line.id === "f1"))).not.toMatch(/source[- ]only/iu);
});
