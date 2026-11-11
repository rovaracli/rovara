// CLOSE-ENV-1 (the review of hotfix 0.5.4, Low 1). The broker's environment arrives packed (AGENTX_NAMES, AGENTX_SETTINGS) and
// broker-environment-init.ts unpacks it. Nothing may read a packed name before that: it would see nothing, and fail only on the Lambda (hotfix 0.5.4).
// So the init import is the first import of broker.ts, and this loads the real broker.ts with only the packed variables set and a process.env that
// records every read of a name that is packed or derived before the unpacking starts.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BROKER_NAMES, BROKER_NAMES_VARIABLE, BROKER_SETTINGS, BROKER_SETTINGS_VARIABLE, DERIVED_BROKER_VARIABLES } from "@agentx/cloud-contracts";
import { requiredEnvironment } from "../../packages/broker/src/aws/lambda.js";
import type * as BrokerEnvironment from "../../packages/broker/src/aws/broker-environment.js";
import { brokerVariables } from "../support/broker-packed-variables.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const REGION = "ap-southeast-4";
const ACCOUNT = "123456789012";

// What hydration is doing, seen from inside: the real function, wrapped. Reads while it runs are its own (it checks each variable before it sets it).
const hydration = vi.hoisted(() => ({ started: false, finished: false, runs: 0 }));
vi.mock("../../packages/broker/src/aws/broker-environment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BrokerEnvironment>();
  return {
    ...actual,
    hydrateBrokerEnvironment: (env: Parameters<typeof actual.hydrateBrokerEnvironment>[0]) => {
      hydration.started = true;
      hydration.runs += 1;
      try {
        return actual.hydrateBrokerEnvironment(env);
      } finally {
        hydration.finished = true;
      }
    },
  };
});

/** Every variable the broker's code reads that the control plane does not pass as such. The two packed variables are not in it: hydration reads those. */
function packedNames(): Set<string> {
  const names = new Set<string>();
  for (const spec of [...Object.values(BROKER_NAMES), ...Object.values(BROKER_SETTINGS)]) names.add(spec.variable);
  for (const derived of DERIVED_BROKER_VARIABLES) names.add(derived.variable);
  names.delete(BROKER_NAMES_VARIABLE);
  names.delete(BROKER_SETTINGS_VARIABLE);
  return names;
}

describe("the broker entry module reads no packed name before it unpacks them", () => {
  it("imports the environment init first, before any other import", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*?["']([^"']+)["'];/gmu)].map((match) => match[1]);
    expect(imports[0]).toBe("./broker-environment-init.js");
  });

  describe("loaded the way the Lambda loads it", () => {
    const saved = process.env;
    const packed = brokerVariables();
    const names = packedNames();
    const readsBefore: string[] = [];
    let readsAfter = 0;

    beforeAll(() => {
      const environment: Record<string, string | undefined> = { ...saved };
      // Only what the control plane passes: the packed variables and the plain ones, and none of the names that are packed.
      for (const name of names) delete environment[name];
      Object.assign(environment, packed, { AWS_REGION: REGION, AGENTX_ACCOUNT_ID: ACCOUNT });
      const record = (key: string | symbol): void => {
        if (typeof key !== "string" || !names.has(key)) return;
        if (!hydration.started) readsBefore.push(key);
        else if (hydration.finished) readsAfter += 1;
      };
      process.env = new Proxy(environment, {
        get(target, key, receiver): unknown {
          record(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
        has(target, key) {
          record(key);
          return Reflect.has(target, key);
        },
      });
    });
    afterAll(() => {
      process.env = saved;
    });

    it("starts from an environment that has the names only packed", () => {
      expect(process.env[BROKER_NAMES_VARIABLE]).toBeDefined();
      expect(process.env[BROKER_SETTINGS_VARIABLE]).toBeDefined();
      expect(Object.keys(process.env).filter((key) => names.has(key))).toEqual([]);
      readsAfter = 0;
      readsBefore.length = 0;
    });

    it("hydrates once, and nothing reads a packed name before that", async () => {
      vi.resetModules();
      hydration.started = false;
      hydration.finished = false;
      hydration.runs = 0;
      await import("../../packages/broker/src/aws/broker.js");
      expect(hydration.runs).toBe(1);
      expect(hydration.finished).toBe(true);
      // The positive control: the proxy does see reads of packed names, so an empty list means none were made.
      expect(readsAfter).toBeGreaterThan(0);
      expect(readsBefore).toEqual([]);
    }, 120_000);
  });
});

describe("requiredEnvironment names where a packed value arrives", () => {
  const saved = { ...process.env };
  afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it("says a packed name arrives in AGENTX_NAMES, with its code", () => {
    delete process.env.DELETER_ARN;
    expect(() => requiredEnvironment("DELETER_ARN")).toThrow(/^DELETER_ARN is required\b.*AGENTX_NAMES.*\bdl\b/u);
  });

  it("says a packed setting arrives in AGENTX_SETTINGS", () => {
    const [setting] = Object.values(BROKER_SETTINGS);
    delete process.env[setting!.variable];
    expect(() => requiredEnvironment(setting!.variable)).toThrow(new RegExp(`^${setting!.variable} is required\\b.*AGENTX_SETTINGS.*\\b${setting!.code}\\b`, "u"));
  });

  it("keeps the plain message for a name that is not packed", () => {
    delete process.env.SOME_PLAIN_NAME;
    expect(() => requiredEnvironment("SOME_PLAIN_NAME")).toThrow(/^SOME_PLAIN_NAME is required$/u);
  });
});
