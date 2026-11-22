import { expect, it } from "vitest";
import { createSessionActions } from "../../packages/ui/src/api/session-actions.js";
import { createSessionApi } from "../../packages/ui/src/api/sessions.js";
import { fakeHost } from "./support/fake-host.js";
import { sessionFixture, messageFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

for (const operation of ["stop", "close", "follow", "message"] as const) it(`R6a: a canonical-looking 202 ${operation} body remains unknown`, async () => {
 const f = fakeHost(async () => ({ status: 202, body: operation === "close" ? { session: sessionFixture(), closed: true } : operation === "follow" ? { following: true, followers: 2 } : operation === "message" ? messageFixture() : { session: sessionFixture() } }));
 const actions = createSessionActions(f.host), session = createSessionApi(f.host);
 const sent = operation === "stop" ? actions.stop(SESSION_FIXTURE_ID) : operation === "close" ? actions.close(SESSION_FIXTURE_ID, { requestId: crypto.randomUUID() }) : operation === "follow" ? actions.follow(SESSION_FIXTURE_ID) : session.sendMessage(SESSION_FIXTURE_ID, { kind: "comment", text: "Kept text" });
 await expect(sent).rejects.toMatchObject({ code: "PENDING" });expect(f.request).toHaveBeenCalledTimes(1);
});
