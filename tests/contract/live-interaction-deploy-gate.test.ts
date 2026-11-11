// Live interaction: the ask switch (`ak`, LIVE_ASK_ENABLED) is gated on two pieces of wiring. Until both exist, adding the switch to any deploy file fails here. Gates are listed in
// LIVE_INTERACTION_DEPLOY_GATES (packages/contracts/src/live-interaction.ts).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { LIVE_INTERACTION_DEPLOY_GATES, LIVE_INTERACTION_FLAGS } from "@rovara-code/contracts";
import { ERASE_STEPS, PERSON_FIELDS, REQUIRED_ERASE_STEPS } from "../../packages/broker/src/team-record/person-fields.js";

const ROOT = process.cwd();

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "cdk.out") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|json|ya?ml)$/u.test(name)) out.push(path);
  }
  return out;
}

/** Whether a file's text names the ask switch as a deploy setting (its variable, its stack parameter or its CLI key). */
export const namesAskSwitch = (text: string): boolean => /LIVE_ASK_ENABLED|LiveAskEnabled|liveAsk\.enabled/u.test(text);
/** Whether a file's text calls the sweep (not a re-export or a mention in a comment). */
export const callsSweep = (text: string): boolean => /(^|[^.\w])sweepExpiredAsks\s*\(/mu.test(text.replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, ""));

const deployFiles = (): string[] => [
  join(ROOT, "packages/contracts/src/broker-names.ts"), join(ROOT, "packages/cli/src/config/keys.ts"), join(ROOT, "packages/cli/src/deploy/parameters.ts"),
  ...sourceFiles(join(ROOT, "infra/lib")),
];
const productionFiles = (): string[] => ["broker", "worker", "cli"].flatMap((pkg) => sourceFiles(join(ROOT, "packages", pkg, "src")))
  .concat(sourceFiles(join(ROOT, "infra/lib")), sourceFiles(join(ROOT, "scripts")).filter((file) => file.endsWith(".ts")))
  .filter((file) => !/agent-sessions\/(ask-erase|ask-store)\.ts$/u.test(file));

describe("the ask switch's hard deploy gates", () => {
  it("names both gates in the switch definition", () => {
    expect(LIVE_INTERACTION_DEPLOY_GATES.ask).toEqual(["asks_erase_step", "daily_ask_sweep"]);
    expect(LIVE_INTERACTION_FLAGS.ask).toEqual({ code: "ak", variable: "LIVE_ASK_ENABLED" });
  });

  it("the helpers see what they should (positive controls)", () => {
    expect(namesAskSwitch('ask: { code: "ak", variable: "LIVE_ASK_ENABLED" }')).toBe(true);
    expect(namesAskSwitch('new CfnParameter(stack, "LiveAskEnabled", {})')).toBe(true);
    expect(namesAskSwitch("nothing here")).toBe(false);
    expect(callsSweep("await sweepExpiredAsks(table, orgId, Date.now());")).toBe(true);
    expect(callsSweep("for (const org of orgs) void sweepExpiredAsks (table, org, now)")).toBe(true);
    expect(callsSweep('export { sweepExpiredAsks } from "./ask-erase.js";')).toBe(false);
    expect(callsSweep("// sweepExpiredAsks(table) is called daily")).toBe(false);
    expect(callsSweep("table.sweepExpiredAsks(x)")).toBe(false);
  });

  it("the erase step gate: the Asks step is registered and required, with a person-field row", () => {
    expect(ERASE_STEPS).toContain("asks");
    expect(REQUIRED_ERASE_STEPS).toContain("asks");
    expect(PERSON_FIELDS.some((field) => field.step === "asks")).toBe(true);
  });

  it("the fix switch's hard gate: the diagnoses erase step is registered and required, with a person-field row, before `fd` may be in any deploy file", () => {
    expect(LIVE_INTERACTION_DEPLOY_GATES.fix).toEqual(["diagnoses_erase_step"]);
    expect(LIVE_INTERACTION_FLAGS.fix).toEqual({ code: "fd", variable: "LIVE_FIX_ENABLED" });
    expect(ERASE_STEPS).toContain("diagnoses");
    expect(REQUIRED_ERASE_STEPS).toContain("diagnoses");
    expect(PERSON_FIELDS.some((field) => field.step === "diagnoses")).toBe(true);
    const names = (text: string): boolean => /LIVE_FIX_ENABLED|LiveFixEnabled|liveFix\.enabled/u.test(text);
    expect(names('fix: { code: "fd", variable: "LIVE_FIX_ENABLED" }')).toBe(true);
    expect(names('new CfnParameter(stack, "LiveFixEnabled", {})')).toBe(true);
    expect(names("nothing here")).toBe(false);
    const inDeploy = deployFiles().some((file) => names(readFileSync(file, "utf8")) && !file.endsWith("live-interaction.ts"));
    const inSettings = (Object.values(BROKER_SETTINGS) as Array<{ variable: string; code: string }>).some((spec) => spec.variable === LIVE_INTERACTION_FLAGS.fix.variable || spec.code === LIVE_INTERACTION_FLAGS.fix.code);
    if (inDeploy || inSettings) expect(REQUIRED_ERASE_STEPS, "the fix switch is in a deploy file").toContain("diagnoses");
  });

  it("the ask switch is in no deploy file yet, or else BOTH gates hold: the erase step is wired and a production file calls the daily sweep", () => {
    const switchFiles = deployFiles().filter((file) => namesAskSwitch(readFileSync(file, "utf8")) && !file.endsWith("live-interaction.ts"));
    const switchInBrokerSettings = (Object.values(BROKER_SETTINGS) as Array<{ variable: string; code: string }>).some((spec) => spec.variable === LIVE_INTERACTION_FLAGS.ask.variable || spec.code === LIVE_INTERACTION_FLAGS.ask.code);
    if (switchFiles.length === 0 && !switchInBrokerSettings) return;
    expect(REQUIRED_ERASE_STEPS, `the ask switch is in ${switchFiles.join(", ")}`).toContain("asks");
    const callers = productionFiles().filter((file) => callsSweep(readFileSync(file, "utf8")));
    expect(callers, "the ask switch needs a scheduled call of sweepExpiredAsks (daily, every org) before it may be deployed").not.toEqual([]);
  });
});
