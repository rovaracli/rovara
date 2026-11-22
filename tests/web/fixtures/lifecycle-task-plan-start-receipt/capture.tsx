import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppMeResponseSchema } from "@agentx/contracts/web";
import { WorkflowArtifactSchema, WorkflowDecisionSchema, WorkflowStateSchema } from "../../../../packages/contracts/src/task-workflow.js";
import { lookV2Css, tokensCss } from "@agentx/design-tokens";
import "../../../../packages/ui/src/design/design.css";
import "../../../../packages/ui/src/shell/shell.css";
import { PlanStartReceiptView } from "../../../../packages/ui/src/screens/session/PlanStartReceiptView.js";

const actorId = "a".repeat(64);
const me = AppMeResponseSchema.parse({
 developer: { id: actorId, name: "Ana", orgRole: "owner" },
 org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [],
});
const plan = WorkflowArtifactSchema.parse({
 id: "plan-v3", type: "plan", version: 3, sha256: "b".repeat(64), producer: "planner",
 objectKey: "plans/v3.md", createdAt: "2026-11-20T14:10:00.000Z",
});
const decision = WorkflowDecisionSchema.parse({
 requestId: "11111111-1111-4111-8111-111111111111", workflowRevision: 8, decision: "APPROVE",
 actorId: me.developer.id, actorRole: "TASK_OWNER", reason: "Approve plan v3", artifactDigest: plan.sha256,
 at: "2026-11-20T14:12:04.000Z",
});
const state = WorkflowStateSchema.parse("RUNNING");
if (decision.decision !== "APPROVE" || decision.artifactDigest !== plan.sha256 || state !== "RUNNING") throw new Error("Receipt capture fixture did not describe the approved running workflow.");

const style = document.createElement("style");
style.textContent = tokensCss() + lookV2Css();
document.head.append(style);
const captureLayout = document.createElement("style");
captureLayout.textContent = ".rv-receipt-phone-nav{display:none}@media(max-width:639px){.rv-app-shell{grid-template-columns:minmax(0,1fr);grid-template-rows:var(--rv-shell-header) minmax(0,1fr)}.rv-shell-sidebar{display:none}.rv-shell-main{padding-bottom:92px}.rv-receipt-phone-nav{position:fixed;z-index:2;left:0;right:0;bottom:0;display:flex;justify-content:space-around;padding:12px 8px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--rv-border);background:var(--rv-bg-raised)}.rv-receipt-phone-nav a{color:var(--rv-text);text-decoration:none}}";
document.head.append(captureLayout);
document.documentElement.dataset.look = "v2";
document.documentElement.dataset.density = "comfortable";
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

const receipt = createElement(PlanStartReceiptView, {
 currentVersion: plan.version,
 currentRevision: decision.workflowRevision,
 decision: { kind: "confirmed", version: plan.version, actor: me.developer.name, actorRole: "owner", revision: decision.workflowRevision, at: decision.at },
 build: { state: "starting" },
});
const root = document.getElementById("root");
if (root === null) throw new Error("Capture root is missing.");
createRoot(root).render(createElement("div", { className: "rv-app-shell" },
 createElement("header", { className: "rv-shell-header" }, createElement("strong", null, "Rovara"), createElement("span", null, "Acme")),
 createElement("aside", { className: "rv-shell-sidebar", "aria-label": "Workspace navigation" }, createElement("nav", null,
  createElement("a", { href: "#inbox" }, "Inbox"), createElement("a", { href: "#work" }, "Work"), createElement("a", { href: "#projects" }, "Projects"))),
 createElement("main", { className: "rv-shell-main", id: "main" },
  createElement("header", { className: "rv-page-header" }, createElement("div", null,
   createElement("p", { className: "rv-muted" }, "payments · Task"), createElement("h1", null, "Add refunds endpoint"))),
  receipt,
 ),
 createElement("nav", { className: "rv-receipt-phone-nav", "aria-label": "Primary navigation" },
  createElement("a", { href: "#inbox" }, "Inbox"), createElement("a", { href: "#work" }, "Work"), createElement("a", { href: "#projects" }, "Projects"))));
