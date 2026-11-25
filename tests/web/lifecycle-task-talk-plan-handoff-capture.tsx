import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { DecisionCardsViewReaderSchema, SessionMessageReaderSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import { lookV2Css, tokensCss } from "@agentx/design-tokens";
import "../../packages/ui/src/design/design.css";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { TalkPlanChangeHandoffView } from "../../packages/ui/src/screens/session/TalkPlanChangeHandoffView.js";
import { messageFixture, sessionFixture, taskFixture } from "./support/session-fixture.js";

const card = {
 id: "approve_plan:plan2", kind: "approve_plan", taskId: "11111111-1111-4111-8111-111111111111", project: "payments", title: "Retry failed payments",
 question: "Approve this plan and start the build?", recommended: { action: "approve", why: "Every claim has a planned check." }, next: { text: "The plan is ready to review." }, evidence: [], risk: "low", riskReasons: [],
 friction: { expandEvidenceFirst: false, secondPerson: false }, actions: [
  { kind: "approve", label: "Approve", href: "/v1/app/decisions/approve_plan/plan2/approve", method: "POST" },
  { kind: "open", label: "Open", href: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa?decision=approve_plan%3Aplan2", method: "GET" },
 ], rejectReasons: [], status: "pending", createdAt: "2026-11-20T10:00:00.000Z",
};
const decision = readDecisions(DecisionCardsViewReaderSchema.parse({ cards: [card], total: 1, digests: { [card.id]: "a".repeat(64) } }))[0]!;
const anchorRef = { target: "step" as const, targetId: "2", revision: "building" };
const session = SessionViewReaderSchema.parse(sessionFixture({ kind: "task", body: { kind: "task", task: taskFixture() }, anchors: [anchorRef] }));
const instruction = SessionMessageReaderSchema.parse(messageFixture({ kind: "steer", delivery: { state: "delivered", at: "2026-11-20T10:00:00.000Z" } }));
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.setAttribute("data-theme", theme);
document.documentElement.setAttribute("data-look", "v2");
const style = document.createElement("style");
style.textContent = tokensCss() + lookV2Css() + `
 body{padding:24px;background:var(--rv-bg);color:var(--rv-text)}
 .capture{max-width:460px;margin:0 auto;border:1px solid var(--rv-border);border-radius:var(--rv-radius-md);background:var(--rv-bg-raised);padding:20px;display:grid;gap:16px}
 .capture h1{font-size:var(--rv-font-xl)} .capture p{margin:0}
 @media(max-width:639px){body{padding:12px}.capture{padding:16px}}
 `;
document.head.append(style);
const root = document.getElementById("capture-root");
if (root === null) throw new Error("capture root missing");
createRoot(root).render(createElement(MemoryRouter, null, createElement("main", { className: "capture", "aria-label": "Talk to this session", "data-capture-state": "pending-plan-change" },
 createElement("header", null, createElement("h1", null, "Talk to this session"), createElement("p", null, "Add refunds endpoint · Build, plan v3")),
 createElement("section", { className: "rv-message", "aria-label": "Instruction" }, createElement("strong", null, "Instruction · acknowledged"), createElement("p", null, "Also allow refunds on payments that haven't settled yet.")),
 createElement(TalkPlanChangeHandoffView, { session, instruction, decision, origin: location.origin, anchor: { ref: anchorRef, href: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa#step-2", label: "Build, step 2" } }),
)));
requestAnimationFrame(() => { document.body.dataset.captureReady = "true"; });
