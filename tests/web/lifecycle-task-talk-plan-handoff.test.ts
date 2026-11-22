// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router";
import { DecisionCardsViewReaderSchema, SessionMessageReaderSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { TalkPlanChangeHandoffView } from "../../packages/ui/src/screens/session/TalkPlanChangeHandoffView.js";
import { h } from "./support/h.js";
import { messageFixture, sessionFixture, taskFixture } from "./support/session-fixture.js";

afterEach(cleanup);

const raw = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, { cards: Array<Record<string, unknown>> }> };
const card = structuredClone(raw.views.approve_plan_with_choices!.cards[0]!);
delete card.runLimit;
delete card.planFeature;
card.evidence = [];
card.next = { text: "The plan is ready to review." };
const decision = readDecisions(DecisionCardsViewReaderSchema.parse({ cards: [card], total: 1, digests: { [String(card.id)]: "a".repeat(64) } }))[0]!;
const ref = { target: "step" as const, targetId: "2", revision: "building" };
const session = SessionViewReaderSchema.parse(sessionFixture({ kind: "task", body: { kind: "task", task: taskFixture() }, anchors: [ref] }));
const instruction = SessionMessageReaderSchema.parse(messageFixture({ kind: "steer", delivery: { state: "delivered", at: "2026-11-20T10:00:00.000Z" } }));
const props = { session, instruction, decision, origin: "https://cloud.example", anchor: { ref, href: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa#step-2", label: "Build, step 2" } };

it("links only to the pending plan decision's validated current destination and returns to the same session anchor", () => {
 render(h(MemoryRouter, null, h(TalkPlanChangeHandoffView, props)));
 expect(screen.getByRole("region", { name: "Plan change handoff" })).toBeTruthy();
 expect(screen.getByRole("link", { name: "Review plan" }).getAttribute("href")).toBe("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa?decision=approve_plan%3Aplan2");
 expect(screen.getByRole("link", { name: "Back to Build, step 2" }).getAttribute("href")).toBe(props.anchor.href);
 expect(screen.getByText(/A reply in Talk or Slack does not approve a plan/)).toBeTruthy();
 expect(screen.queryByText(/\$|test|file|proof/i)).toBeNull();
 expect(screen.queryByRole("button", { name: /approve|send|reply/i })).toBeNull();
});

it("does not present an answered or withdrawn decision as a current approval handoff", () => {
 const answeredCard = { ...card, status: "cancelled", actions: [] };
 const answered = readDecisions(DecisionCardsViewReaderSchema.parse({ cards: [answeredCard], total: 1, digests: { [String(card.id)]: "b".repeat(64) } }))[0]!;
 render(h(MemoryRouter, null, h(TalkPlanChangeHandoffView, { ...props, decision: answered })));
 expect(screen.queryByRole("region", { name: "Plan change handoff" })).toBeNull();
});

it("does not equate a queued or unrelated instruction with an acknowledged change", () => {
 const queued = SessionMessageReaderSchema.parse(messageFixture({ kind: "steer", delivery: { state: "queued", at: "2026-11-20T10:00:00.000Z" } }));
 render(h(MemoryRouter, null, h(TalkPlanChangeHandoffView, { ...props, instruction: queued })));
 expect(screen.queryByRole("region", { name: "Plan change handoff" })).toBeNull();
});

it("requires the exact anchor to be one the current session serves", () => {
 const other = { ...props.anchor, ref: { ...props.anchor.ref, revision: "older" } };
 render(h(MemoryRouter, null, h(TalkPlanChangeHandoffView, { ...props, anchor: other })));
 expect(screen.queryByRole("region", { name: "Plan change handoff" })).toBeNull();
});

it("does not invent a handoff for an ordinary comment card", () => {
 const commentCard = structuredClone(raw.views.approve_design!.cards[0]!);
 const comment = readDecisions(DecisionCardsViewReaderSchema.parse({ cards: [commentCard], total: 1, digests: { [String(commentCard.id)]: "c".repeat(64) } }))[0]!;
 render(h(MemoryRouter, null, h(TalkPlanChangeHandoffView, { ...props, decision: comment })));
 expect(screen.queryByRole("region", { name: "Plan change handoff" })).toBeNull();
});
