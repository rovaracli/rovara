import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENVIRONMENT,
  EnvironmentNameSchema,
  STACK_PARTS,
  environmentConnectorSecretPrefix,
  environmentSettingsPrefix,
  environmentStackName,
} from "@agentx/contracts";

describe("environment names", () => {
  it.each(["production", "staging", "dev-2", "a", "a1", "abcdefghijklmn"])("accepts %s", (name) => {
    expect(EnvironmentNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(["", "Prod", "prod-", "-prod", "1prod", "pro_d", "pro.d", "a--b", "abcdefghijklmno", "prod/x", "connectors"])(
    "refuses %j",
    (name) => {
      expect(EnvironmentNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it("defaults to production", () => {
    expect(DEFAULT_ENVIRONMENT).toBe("production");
  });

  it("names stacks, settings and connector secrets with the environment", () => {
    expect(STACK_PARTS).toEqual(["access", "foundation", "identity", "runtime", "control-plane", "slack"]);
    expect(environmentStackName("staging", "control-plane")).toBe("rovara-cloud-staging-control-plane");
    expect(environmentStackName("staging", "identity")).toBe("rovara-cloud-staging-identity");
    expect(environmentStackName("staging", "access")).toBe("rovara-cloud-staging-access");
    expect(environmentSettingsPrefix("staging")).toBe("/rovara-cloud/staging/");
    expect(environmentConnectorSecretPrefix("staging")).toBe("rovara-cloud/staging/connectors/");
  });

  it("refuses to build a name from an invalid environment", () => {
    expect(() => environmentStackName("Bad", "slack")).toThrow(/environment name/);
    expect(() => environmentSettingsPrefix("a--b")).toThrow(/environment name/);
  });
});
