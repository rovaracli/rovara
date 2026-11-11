// ENV-ROOM, rollout safety (found in the 0.4.3 staging rollout: two broker cold starts failed at 02:11:06Z with "AGENTX_NAMES has a name nobody sent: rt").
// During a rollout, code can briefly start with the other revision's environment, in either direction. The decoders are safe both ways:
//  - newer environment, older code: a code the running code does not know is ignored, with one log line (not fatal);
//  - older environment, newer code: a name the code needs but the environment lacks is not made up. The variable stays unset, so the reader fails closed, unless the shared
//    naming module can derive it (DERIVED_BROKER_VARIABLES), in which case it is derived.
// A value that is malformed is still fatal in both: only an unknown code is tolerated.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROKER_NAMES_VARIABLE, BROKER_SETTINGS_VARIABLE } from "@agentx/cloud-contracts";
import { brokerNamesFromEnvironment, brokerSettingsFromEnvironment, hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";

const SCOPE = { AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012", AGENTX_ENV: "staging" };

function logged(run: () => void): Array<Record<string, unknown>> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    run();
    return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
  } finally {
    spy.mockRestore();
  }
}
afterEach(() => vi.restoreAllMocks());

describe("a newer environment, older code: an unknown code is ignored with one log line", () => {
  it("skips an unknown name, keeps the known ones, and says so once", () => {
    const env: MutableEnvironment = { ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "table", zz: "x", yy: "y" }) };
    const lines = logged(() => hydrateBrokerEnvironment(env));
    expect(env.DEVELOPER_SIGNIN_TABLE_NAME).toBe("table");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "broker_environment.unknown_codes", variable: BROKER_NAMES_VARIABLE, codes: ["yy", "zz"] });
  });

  it("does the same for an unknown setting", () => {
    const env: MutableEnvironment = { [BROKER_SETTINGS_VARIABLE]: JSON.stringify({ ss: "enabled", zz: "1" }) };
    const lines = logged(() => hydrateBrokerEnvironment(env));
    expect(env.DEVELOPER_SIGNIN_SLACK).toBe("enabled");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "broker_environment.unknown_codes", variable: BROKER_SETTINGS_VARIABLE, codes: ["zz"] });
  });

  it("reads the decoders directly the same way: the old code's view of `aq` (now derived, so no longer a code) is one log line", () => {
    expect(logged(() => brokerNamesFromEnvironment({ [BROKER_NAMES_VARIABLE]: JSON.stringify({ rt: "abcdefghij", aq: "agentx-staging-audit-intake.fifo" }) }))).toHaveLength(1);
    expect(logged(() => brokerSettingsFromEnvironment({ [BROKER_SETTINGS_VARIABLE]: JSON.stringify({ zz: "1" }) }))).toHaveLength(1);
  });

  it("logs nothing when every code is known", () => {
    expect(logged(() => hydrateBrokerEnvironment({ ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "t" }), [BROKER_SETTINGS_VARIABLE]: JSON.stringify({ ss: "enabled" }) }))).toEqual([]);
  });

  it.each([
    ["a known name that is not plain", { [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "a/b", zz: "x" }) }],
    ["a known setting that is not plain", { [BROKER_SETTINGS_VARIABLE]: JSON.stringify({ tm: 'T"1', zz: "x" }) }],
    ["names that are not an object", { [BROKER_NAMES_VARIABLE]: "[1]" }],
  ])("is still fatal for %s", (_label, env) => {
    expect(() => logged(() => hydrateBrokerEnvironment({ ...SCOPE, ...env }))).toThrow(/AGENTX_(NAMES|SETTINGS)/);
  });
});

describe("an older environment, newer code: a missing name is not invented, a derivable one is derived", () => {
  it("leaves a variable unset when its name is missing and nothing derives it, so the reader fails closed", () => {
    // The 0.4.3 environment has no `ts` (the State table moved into the names in this revision) and no STATE_TABLE_NAME of its own here.
    const env: MutableEnvironment = { ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "table" }) };
    hydrateBrokerEnvironment(env);
    expect(env.STATE_TABLE_NAME).toBeUndefined();
    expect(env.MODEL_PROXY_URL).toBeUndefined();
    expect(env.EC2_WORKER_LAUNCH_TEMPLATE_ID).toBeUndefined();
  });

  it("keeps a variable the old environment passed whole (a name that moved into the names is still read from where it was)", () => {
    const env: MutableEnvironment = { ...SCOPE, STATE_TABLE_NAME: "old-state", [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "table" }) };
    hydrateBrokerEnvironment(env);
    expect(env.STATE_TABLE_NAME).toBe("old-state");
  });

  it("derives what the shared naming module can derive, whether or not the old environment sent it (the audit queue was `aq` in 0.4.3)", () => {
    const withoutIt: MutableEnvironment = { ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "table" }) };
    const withIt: MutableEnvironment = { ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "table", aq: "agentx-staging-audit-intake.fifo" }) };
    logged(() => { hydrateBrokerEnvironment(withoutIt); hydrateBrokerEnvironment(withIt); });
    const url = "https://sqs.us-west-2.amazonaws.com/123456789012/agentx-staging-audit-intake.fifo";
    expect(withoutIt.AUDIT_INTAKE_QUEUE_URL).toBe(url);
    expect(withIt.AUDIT_INTAKE_QUEUE_URL).toBe(url);
  });

  it("does not make up a setting the old environment lacks: its variable stays unset (a flag read as unset is off, as before the setting existed)", () => {
    const env: MutableEnvironment = { ...SCOPE, [BROKER_NAMES_VARIABLE]: JSON.stringify({ st: "table" }) };
    hydrateBrokerEnvironment(env);
    expect(env.AGENTX_TASK_PEOPLE_CHANGES_ENABLED).toBeUndefined();
    expect(env.SLACK_TEAM_ID).toBeUndefined();
  });
});
