// Review of one-click Merge (2026-10-27), minor 4: through the real broker handler, a bearer token (the CLI, the API, an AI tool) is never a browser session. Its press answers 202 with the
// confirmation link and GitHub is not asked to merge; the web boundary refuses a bearer outright.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, mergeButtonBroker, type MergeButtonBroker } from "../support/merge-button-broker.js";

async function post(broker: MergeButtonBroker, path: string, headers: Record<string, string>, body: unknown) {
  const response = await broker.handler({
    version: "2.0", rawPath: path, rawQueryString: "", headers, body: JSON.stringify(body), requestContext: { requestId: randomUUID(), http: { method: "POST" } },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

describe("a bearer caller through the real handler", () => {
  it("gets the confirmation link and no merge, with or without the risk level in the body", async () => {
    const broker = await mergeButtonBroker();
    const authorization = await broker.bearer(MAYA);
    for (const extra of [{}, { risk: "low" }]) {
      const reply = await post(broker, `/v1/app/sessions/${broker.sessionId}/merge`, { authorization }, { requestId: randomUUID(), ...extra });
      expect(reply.status).toBe(202);
      expect(reply.body).toMatchObject({ status: "NEEDS_CONFIRMATION" });
    }
    expect(broker.github.mergeCalls).toEqual([]);
  });

  it("is refused on the web boundary, which takes a cookie and no bearer", async () => {
    const broker = await mergeButtonBroker();
    const reply = await post(broker, `/v1/web/sessions/${broker.sessionId}/merge`, { authorization: await broker.bearer(MAYA) }, { requestId: randomUUID(), risk: "low" });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(broker.github.mergeCalls).toEqual([]);
  });

  it("cannot make itself a browser with a body field", async () => {
    const broker = await mergeButtonBroker();
    const reply = await post(broker, `/v1/app/sessions/${broker.sessionId}/merge`, { authorization: await broker.bearer(MAYA) }, { requestId: randomUUID(), browserSession: true });
    expect(reply.status).toBe(400);
    expect(broker.github.mergeCalls).toEqual([]);
  });
});
