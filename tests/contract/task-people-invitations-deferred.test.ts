// Owner decision 86 (b): automatic Slack invitations of task people are DEFERRED. They need a Slack reinstall with new scopes, so the invite handler is built and tested but not
// wired anywhere, and both invitation switches stay off. This file is the guard: if invitations are ever wired, these fail and say so, instead of a switch quietly doing something.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createDeveloperApiConfiguration } from "../../packages/broker/src/aws/workflow-dependencies-configuration.js";
import { configKey } from "../../packages/cli/src/config/keys.js";

const WIRING_NAMES = ["createTaskPersonInviteHandler", "taskPersonInviteThroughLambda", "createTaskPersonInviteLambdaInvoker"];
const OWNERS = new Set([
  "packages/broker/src/aws/task-person-invite-handler.ts", "packages/broker/src/aws/task-person-invite-transport.ts",
]);

describe("task people invitations are deferred", () => {
  it("nothing in the broker, the infrastructure or the CLI builds or mounts the invite handler or its transport", () => {
    const hits = execFileSync("git", ["grep", "-l", "-E", WIRING_NAMES.join("|"), "--", "packages", "infra", "scripts"], { encoding: "utf8" })
      .split("\n").filter((file) => file !== "" && !OWNERS.has(file));
    expect(hits, "the invite handler is reached from no production code (wire it only with the Slack scope decision)").toEqual([]);
  });

  it("the broker is given no invite port, whatever the invitation settings say", () => {
    for (const value of ["true", "false", undefined]) {
      const config = createDeveloperApiConfiguration({
        DEVELOPER_TOKEN_ISSUER: "https://issuer.example/v1/auth", DEVELOPER_IDENTITY_FUNCTION_NAME: "developer-identity", DEVELOPER_SIGNIN_TABLE_NAME: "sign-ins", AGENTX_ENV: "staging",
        AGENTX_TASK_PEOPLE_CHANGES_ENABLED: "true", AGENTX_TASK_PEOPLE_PUBLIC_INVITATIONS_ENABLED: value, AGENTX_TASK_PEOPLE_PRIVATE_INVITATIONS_ENABLED: value,
      }, () => ({ channelMembers: async () => ({ ok: true as const, memberOf: [] as string[] }), verifyAccessToken: async () => ({}) }));
      expect(config).toBeDefined();
      expect(config).not.toHaveProperty("inviteTaskPerson");
      expect(config?.taskPeopleConfiguration).toEqual({ peopleChangesEnabled: true });
    }
  });

  it("the CLI will not turn either invitation switch on, and says why; turning one off is fine", () => {
    for (const key of ["taskPeople.publicInvitations", "taskPeople.privateInvitations"]) {
      expect(() => configKey(key).parse("true")).toThrow(/not built yet|Slack reinstall/i);
      expect(configKey(key).parse("false")).toBe("false");
      expect(configKey(key).defaultValue).toBe("false");
    }
  });
});
