import { LiveResponseSchema, SessionListSchema } from "@agentx/contracts/web";
import { liveFixture } from "../../web/support/live-fixture.js";
import { finishedFixture } from "../../web/support/finished-fixture.js";
// The Work list journey (`work` scenario): Live answers per filter (mine, team, needs_me, failed) and the ended-sessions list, with times set from the clock when the scenario starts so ages read the same on every run.
const ARJUN = { developerId: "b".repeat(64), name: "Arjun" };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString(), MIN = 60_000, HOUR = 3_600_000;
const ID = (letter: string) => "ses_" + letter.repeat(20);
export function workFixture() {
 const decide = liveFixture({ sessionId: ID("a"), kind: "task", title: "Review the plan for duplicate refunds", status: "needs_person", statusWords: "Needs you: the plan needs your decision", needsYou: true, actions: ["watch", "stop"], updatedAt: ago(3 * HOUR + 5 * MIN) });
 const failed = liveFixture({ sessionId: ID("d"), kind: "task", title: "Add retry to the payout job", status: "failed", statusWords: "Failed: the run stopped with an error", actions: ["watch", "retry"], updatedAt: ago(2 * 24 * HOUR) });
 const building = liveFixture({ sessionId: ID("b"), kind: "task", title: "Speed up the invoice export", status: "running", statusWords: "Building", actions: ["watch"], updatedAt: ago(20 * MIN) });
 const local = liveFixture({ sessionId: ID("c"), kind: "local", title: "Try the new ledger query", status: "running", statusWords: "Building", where: { kind: "mac", label: "Priya's MacBook", offline: false }, actions: ["watch"], updatedAt: ago(45 * MIN) });
 const team = liveFixture({ sessionId: ID("e"), kind: "task", title: "Check refund idempotency", owner: ARJUN, status: "running", statusWords: "Checking", actions: ["watch"], updatedAt: ago(10 * MIN) });
 return {
  mine: [building, decide, local, failed], team: [team], needs_me: [decide, failed], failed: [failed],
  ended: [finishedFixture({ sessionId: ID("f"), title: "Fix the rounding bug in tax totals", endedAt: ago(5 * HOUR), summary: { ...finishedFixture().summary, display: { state: "merged" } } }), finishedFixture({ sessionId: ID("g"), title: "Why were customers refunded twice?", endedAt: ago(26 * HOUR), where: { kind: "mac", deviceId: "dvc_aaaaaaaaaaaaaaaaaaaa", label: "Priya's MacBook" } })],
 };
}
type Work = ReturnType<typeof workFixture>;
/** The answer to `GET /v1/web/live?filter=` or `GET /v1/web/sessions?owner=me|project=&status=ended`. */
export function workAnswer(work: Work, url: URL): unknown {
 const project = url.searchParams.get("project");
 if (url.pathname === "/v1/web/sessions") return SessionListSchema.parse({ sessions: work.ended.filter(tile => project === null || tile.project === project) });
 const filter = url.searchParams.get("filter") ?? "all", tiles = filter === "mine" ? work.mine : filter === "team" ? work.team : filter === "needs_me" ? work.needs_me : filter === "failed" ? work.failed : [...work.mine, ...work.team];
 return LiveResponseSchema.parse({ tiles: tiles.filter(tile => project === null || tile.project === project) });
}
