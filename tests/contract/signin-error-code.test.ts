// A Slack sign-in on a cloud install (staging, 0.4.3): rule 4 of resolveOrgOnSignIn has no single org to join and throws
// CONFIG_INVALID ("Sign in with Rovara on this install ..."). The sign-in server told the CLI only "sign-in failed on the AgentX server"
// and logged only the error's name ("AgentXError"). It must say what the person can do, and the log must carry the error's code.
import { describe, expect, it } from "vitest";
import { agentXError } from "@rovara-code/contracts";
import { identityHarness, type FakeSlackUser } from "../support/developer-fakes.js";

const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };

describe("a Slack sign-in on a cloud install, where there is no single org to join", () => {
  it("is told to sign in with Rovara, as an access_denied, not as a server failure", async () => {
    const h = identityHarness({ cloud: {}, slackUsers: [maya], singleOrg: false });
    const location = await h.signIn("slack", maya.userId);
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toContain("Sign in with Rovara on this install");
    expect(location.searchParams.get("error_description")).not.toContain("CONFIG_INVALID");
    expect(h.logs.filter((entry) => entry.event === "signin.error")).toEqual([]);
    expect(h.logs).toContainEqual({ event: "signin.refused", method: "slack", reason: "no_org_on_install", developerId: expect.any(String) as string });
  });
});

describe("a sign-in that fails with an AgentXError logs its code", () => {
  it("logs signin.error with the error's name and code, never its message", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    h.orgs.orgForDeveloper = async () => { throw agentXError("CONFIG_INVALID", "a secret detail: maya@example.com"); };
    const location = await h.signIn("slack", maya.userId);
    expect(location.searchParams.get("error")).toBe("server_error");
    const errors = h.logs.filter((entry) => entry.event === "signin.error");
    expect(errors).toEqual([{ event: "signin.error", path: "/v1/auth/callback/slack", error: "AgentXError", code: "CONFIG_INVALID" }]);
    expect(JSON.stringify(h.logs)).not.toContain("maya@example.com");
  });

  it("leaves code out for an error that has none", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    h.orgs.orgForDeveloper = async () => { throw new TypeError("boom"); };
    await h.signIn("slack", maya.userId);
    expect(h.logs.filter((entry) => entry.event === "signin.error")).toEqual([{ event: "signin.error", path: "/v1/auth/callback/slack", error: "TypeError" }]);
  });
});
