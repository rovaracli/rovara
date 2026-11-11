// The routes the new Home reads, for the `home` scenario, once a journey asks (POST /__mock/home-v2 { mode: "full" | "empty" | "actions" }): the decision cards, my open work (the live "mine" read), my ended sessions,
// the agent directory and the payments project. Not asked, nothing here answers, so every other journey on the `home` scenario sees the cell exactly as before. The ask belongs to one scenario object:
// the next /__mock/scenario starts clean.
import { DecisionCardsViewSchema, SessionListSchema } from "@agentx/cloud-contracts/web";
import { projectDecisionCards, type DecisionItem } from "../../../packages/broker/src/decisions/project.js";
import { homeFixture } from "../../web/support/fixtures.js";
import { projectFixture } from "../../web/support/project-fixture.js";
import { endedList, openTile, directoryOf, agentId } from "../../web/support/home-fixture.js";
import { liveFixture } from "../../web/support/live-fixture.js";
import { mockCellOrigin } from "./port.js";
import type { MockExchange } from "./how-we-work-mock.js";
let asked: { scenario: unknown; mode: "full" | "empty" | "actions" } | undefined;
const item: DecisionItem = { subjectId: "design1", taskId: "11111111-1111-4111-8111-111111111111", project: "payments", title: "Move refunds to the new ledger API", createdAt: new Date(Date.now() - 40 * 60_000).toISOString(), contentVersion: "v1", openPath: "/app/sessions/ses_bbbbbbbbbbbbbbbbbbbb", kind: "approve_design", files: ["src/refund.ts"] };
const view = (items: DecisionItem[]) => { const p = projectDecisionCards(items);return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };
export async function homeV2Mock({ url, method, body, json, scenario }: MockExchange & { scenario: unknown }): Promise<boolean> {
 if (url.pathname === "/__mock/home-v2" && method === "POST") { const input = await body() as { mode?: unknown };asked = { scenario, mode: input.mode === "empty" ? "empty" : input.mode === "actions" ? "actions" : "full" };json(200, { ok: true });return true; }
 if (asked === undefined || asked.scenario !== scenario || method !== "GET") return false;
 const empty = asked.mode === "empty";
 // "actions": today's Home cards with every kind of action visible (a page to open, an approval page, retry, dismiss), for the before/after picture of the switch-off Home.
 if (asked.mode === "actions") {
  const origin = mockCellOrigin(), session = "ses_aaaaaaaaaaaaaaaaaaaa", failed = "ses_bbbbbbbbbbbbbbbbbbbb", at = "2026-10-23T12:00:00.000Z";
  if (url.pathname === "/v1/web/home") { json(200, homeFixture({ cards: [
   { cardId: "plan:" + session, kind: "plan", title: "Review the duplicate-refund fix", reason: "The plan is ready for your review.", sessionId: session, at, buttons: [{ action: "confirm", label: "Review plan", method: "GET", href: origin + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }, { action: "open", label: "Open the plan", method: "GET", href: origin + "/app/sessions/" + session }] },
   { cardId: "failure:" + failed, kind: "failure", title: "Investigate a failed verification run", reason: "Verification failed.", sessionId: failed, at, buttons: [{ action: "retry", label: "Retry", method: "POST", href: origin + "/v1/app/sessions/" + failed + "/retry" }, { action: "dismiss", label: "Dismiss", method: "POST", href: origin + "/v1/app/home/cards/" + encodeURIComponent("failure:" + failed) + "/dismiss?occurrence=1" }] },
  ] as never }));return true; }
  if (url.pathname === "/v1/web/decisions") { json(200, view([]));return true; }
  return false;
 }
 if (url.pathname === "/v1/web/home") { if (!empty) return false;json(200, homeFixture());return true; }
 if (url.pathname === "/v1/web/decisions") { json(200, view(empty ? [] : [item]));return true; }
 if (url.pathname === "/v1/web/live") { json(200, { tiles: empty ? [] : [openTile(1, { status: "running", agent: { agentId: agentId(3), name: "Dependency updater", version: 1 } }), openTile(2, { status: "waiting", lastRunFailed: true, title: "Remove unused feature flags" }), openTile(3, { title: "Simplify the local dev setup", project: "developer-tools" }), openTile(4), openTile(5), openTile(6), openTile(7)].map(tile => liveFixture(tile)) });return true; }
 if (url.pathname === "/v1/web/sessions") { json(200, empty ? SessionListSchema.parse({ sessions: [] }) : endedList(7));return true; }
 if (url.pathname === "/v1/web/agents") { json(200, empty ? { agents: [] } : directoryOf([{ id: agentId(1), name: "Release notes writer", description: "Writes the weekly release notes from merged pull requests." }, { id: agentId(2), name: "Flaky test hunter", description: "Finds tests that pass and fail on the same code." }, { id: agentId(3), name: "Dependency updater", description: "Keeps dependencies current." }, { id: agentId(4), name: "Incident summary", description: "Summarises an incident from its channel." }, { id: agentId(5), name: "A fifth agent", description: "Not shown: four fit." }]));return true; }
 if (url.pathname === "/v1/web/projects/payments/overview") { json(200, projectFixture());return true; }
 return false;
}
