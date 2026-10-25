import { projectFixture } from "../../web/support/project-fixture.js";
import { liveFixture } from "../../web/support/live-fixture.js";
import { mockCellOrigin } from "./port.js";
import { workspaceFixture } from "../../web/support/workspace-fixture.js";
import { sessionFixture } from "../../web/support/session-fixture.js";
import type { SessionMessageSchema, SessionShareSchema } from "@agentx/contracts/web";
import { navFixture, meFixture, homeFixture } from "../../web/support/fixtures.js";
export interface Scenario { name: "shell" | "home" | "session" | "workspace" | "live" | "project"; project?: ReturnType<typeof projectFixture>; live?: Array<ReturnType<typeof liveFixture>>; changes?: Array<{ type: "session.updated"; sessionId: string; revision: number; at: string; sk: string }>; session?: ReturnType<typeof sessionFixture>; messages?: Array<ReturnType<typeof SessionMessageSchema.parse>>; shares?: Array<ReturnType<typeof SessionShareSchema.parse>>; nav: ReturnType<typeof navFixture>; me: ReturnType<typeof meFixture>; home: ReturnType<typeof homeFixture> }
export function scenario(name: string): Scenario {
 if (name !== "shell" && name !== "home" && name !== "session" && name !== "workspace" && name !== "live" && name !== "project") throw new Error("Unknown mock scenario.");
 const home = name === "home" ? homeFixture({ cards: [
 { cardId: "plan:refund", kind: "plan", reason: "The plan is ready for your review.", buttons: [{ action: "confirm", label: "Review plan", method: "GET", href: mockCellOrigin() + "/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" }], title: "Review the duplicate-refund fix", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", at: "2026-10-23T12:00:00.000Z" },
 { cardId: "failure:verification", kind: "failure", reason: "Verification failed.", buttons: [], title: "Investigate a failed verification run", at: "2026-10-23T13:00:00.000Z" },
 ] }) : homeFixture();
 return { name, ...(name === "shell" ? { project: projectFixture() } : {}), ...(name === "project" ? { project: projectFixture(), session: sessionFixture({ sessionId: "ses_bbbbbbbbbbbbbbbbbbbb" }), messages: [], shares: [] } : {}), ...(name === "live" ? { live: [liveFixture({ needsYou: true, actions: ["watch", "take_over", "stop", "retry"] })], changes: [] } : {}), nav: navFixture(), me: meFixture(), home, ...(name === "session" ? { session: sessionFixture(), messages: [], shares: [] } : name === "workspace" ? { session: workspaceFixture({ anchors: [{ target: "plan_block", targetId: "p2", revision: "v1" }, { target: "change_file", targetId: "acme/payments:src/refund.ts", revision: "+12-3" }] }), messages: [], shares: [] } : {}) };
}
