// The decision gate's own policy as the Cloud root gives it (`policy.reusableMethods`, #582): exactly the methods Cloud's own approvals never spent, and not the step-up. A developer token cannot approve the rig's
// plan (a tool approves low risk only), so a decision cannot show the token's marker; this records what the root hands `createDecisionService`.
import { describe, expect, it, vi } from "vitest";
import type * as Broker from "@rovara-code/broker";

const given: Array<{ policy?: { reusableMethods?: readonly string[] } }> = [];
vi.mock("@rovara-code/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof Broker>();
  return { ...actual, createDecisionService: ((options: { policy?: { reusableMethods?: readonly string[] } }) => { given.push(options); return actual.createDecisionService(options as never); }) as typeof actual.createDecisionService };
});

import { API_TOKEN_METHOD, BROWSER_SESSION_METHOD, BROWSER_STEP_UP_METHOD, CHAT_SLACK_METHOD } from "../../packages/broker/src/cloud/adapters/people/methods.js";
import { PEOPLE_ORG } from "../support/cloud-people-world.js";
import { rig } from "../support/cloud-core-rig.js";

describe("the Cloud root's decision gate policy", () => {
  it("names the browser session, the developer token and the Slack user as reusable, and never the step-up", async () => {
    const r = await rig();
    await r.app.runtimeFor(PEOPLE_ORG);
    expect(given.length).toBeGreaterThan(0);
    for (const options of given) {
      expect([...(options.policy?.reusableMethods ?? [])].sort()).toEqual([API_TOKEN_METHOD, BROWSER_SESSION_METHOD, CHAT_SLACK_METHOD].sort());
      expect(options.policy?.reusableMethods).not.toContain(BROWSER_STEP_UP_METHOD);
    }
  });
});
