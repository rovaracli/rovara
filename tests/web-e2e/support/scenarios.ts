import { sessionFixture } from "../../web/support/session-fixture.js";
import type { SessionMessageSchema, SessionShareSchema } from "@agentx/contracts/web";
import { navFixture, meFixture, homeFixture } from "../../web/support/fixtures.js";
export interface Scenario { name: "shell" | "home" | "session"; session?: ReturnType<typeof sessionFixture>; messages?: Array<ReturnType<typeof SessionMessageSchema.parse>>; shares?: Array<ReturnType<typeof SessionShareSchema.parse>>; nav: ReturnType<typeof navFixture>; me: ReturnType<typeof meFixture>; home: ReturnType<typeof homeFixture> }
export function scenario(name: string): Scenario {
 if (name !== "shell" && name !== "home" && name !== "session") throw new Error("Unknown mock scenario.");
 const home = name === "home" ? homeFixture({ cards: [
 { cardId: "refund", kind: "needs_you", title: "Review the duplicate-refund fix", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", at: "2026-10-23T12:00:00.000Z" },
 { cardId: "verification", kind: "failed", title: "Investigate a failed verification run", at: "2026-10-23T13:00:00.000Z" },
 ] }) : homeFixture();
 return { name, nav: navFixture(), me: meFixture(), home, ...(name === "session" ? { session: sessionFixture(), messages: [], shares: [] } : {}) };
}
