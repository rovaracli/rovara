import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import type { ChangeSetChange, DeployRequest, StackDeployer } from "../../packages/cli/src/deploy/deployer.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import type { DoctorReport } from "../../packages/cli/src/doctor/checks.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { writeTeamRecordRecord } from "../../packages/cli/src/deploy/team-record-switch.js";
import { writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import { agentXError } from "@rovara-code/contracts";
import { writeCustomDomain } from "../../packages/cli/src/environments/custom-domain.js";
import { accessChanged, runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { DECISION_CARDS_ON_LINE, forcedOperatorValues } from "../../packages/cli/src/upgrade/forced-values.js";
import { assertRollbackFloorsDeclaredFor, compareVersions, rollbackDirection, ROLLBACK_FLOORS, ROLLBACK_FLOORS_DECLARED_THROUGH, upgradeDirection, type RollbackFloor } from "../../packages/cli/src/upgrade/target.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeGitHubApi, fakeRelease, memoryInitSecrets, scriptedDeployer, T0, TEST_PRIVATE_KEY } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import type { DeployPart } from "../../packages/cli/src/deploy/parameters.js";
import { declaredFromTemplate } from "../../packages/cli/src/deploy/declared-parameters.js";
import { parameterProblems } from "../../packages/cli/src/deploy/deploy-environment.js";
import { raiseReleaseHighWater, readReleaseHighWater, releaseHighWaterParameter } from "../../packages/cli/src/environments/release-high-water.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
/** A bundle path in a fresh temporary directory, removed after each test. */
async function bundleDir(prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(parent);
  return join(parent, "bundle");
}

const ADMIN = "arn:aws:sts::123456789012:assumed-role/Admin/alice";
const OPERATOR = "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice";
const ACCESS_TEMPLATE = JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" } } });
const CHANGED_ACCESS_TEMPLATE = JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" }, NewRole: { Type: "AWS::IAM::Role" } } });
const CALLBACK_KEY = "k".repeat(43);
const INSTALLED = {
  ...SETTINGS, version: "1.2.3",
  access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
};

function release(version = "1.3.0", declared: string[] = ["BudgetMonthlyUsd", "BudgetScope", "SlackThreadTurnsPerMinute"], accessTemplate = ACCESS_TEMPLATE): LoadedRelease {
  return { ...fakeRelease(version), template: (part) => (part === "access" ? accessTemplate : JSON.stringify({ Parameters: Object.fromEntries(declared.map((name) => [name, {}])) })) };
}

/** The templates engine's contract, faked: it asks request.confirm, and declines the way the engine does. */
function confirmingDeployer(changes: Record<string, ChangeSetChange[]> = {}): StackDeployer & { deployed: string[]; requests: DeployRequest[] } {
  const inner = scriptedDeployer(allStackOutputs(), Object.keys(allStackOutputs()));
  return {
    get deployed() { return inner.requests.map((request) => request.stackName); },
    get requests() { return inner.requests; },
    async deploy(request) {
      if (request.confirm !== undefined && !(await request.confirm({ stackName: request.stackName, changes: changes[request.stackName] ?? [] }))) {
        throw new Error(`deploy of ${request.stackName} not executed; confirmation declined`);
      }
      return inner.deploy(request);
    },
    outputs: (name) => inner.outputs(name),
  };
}

const healthy: DoctorReport = { env: "staging", region: "us-east-1", version: "1.3.0", engine: "templates", checks: [], failed: 0, warned: 0, passed: 25 };

const GITHUB_APP_SECRET = "agentx/staging/github-app";
const HAND_SET_WEBHOOK_SECRET = "hand-set-webhook-secret-".padEnd(40, "h");
const GITHUB_WEBHOOK_URL = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/github/webhooks";

async function harness(overrides: Partial<UpgradeDependencies> & { caller?: string; deployer?: StackDeployer; changes?: Record<string, ChangeSetChange[]>; controlPlane?: Record<string, string>; github?: Parameters<typeof fakeGitHubApi>[0]; githubSecret?: string | null } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, INSTALLED);
  const deployer = overrides.deployer ?? confirmingDeployer(overrides.changes);
  const lines: string[] = [];
  const doctorRuns: string[] = [];
  const prepared: string[] = [];
  const github = fakeGitHubApi(overrides.github);
  const githubSecrets = memoryInitSecrets(overrides.githubSecret === null ? {} : { [GITHUB_APP_SECRET]: overrides.githubSecret ?? JSON.stringify({ appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY, webhookSecret: HAND_SET_WEBHOOK_SECRET }) });
  const controlPlane = overrides.controlPlane ?? { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****" };
  const deps: UpgradeDependencies = {
    store,
    stacks: { describe: async (name): Promise<StackDescription | undefined> => ({ status: "UPDATE_COMPLETE", outputs: allStackOutputs()[name] ?? {}, parameters: name === "agentx-staging-control-plane" ? controlPlane : {} }) },
    cloudFormation: { async send(command: unknown) { if (command instanceof GetTemplateCommand) return { TemplateBody: ACCESS_TEMPLATE }; throw new Error("unexpected"); } },
    identity: { get: async () => ({ account: "123456789012", arn: overrides.caller ?? ADMIN }) },
    loadRelease: async () => release(),
    sourceRelease: async () => { throw new Error("test setup: no source release expected"); },
    notes: async () => ({ text: "Fixes.", url: "https://example.test" }),
    prepare: async (input) => {
      prepared.push(input.settings.env);
      return { deployer, store, secrets: memoryInitSecrets({ "agentx/staging/callback-signing-key": CALLBACK_KEY }), holder: overrides.caller ?? ADMIN, partition: "aws", cleanup: async () => undefined };
    },
    cdkDiff: async (request) => `Stack ${request.stackName}\nThere were no differences`,
    ask: async () => "y",
    isInteractive: () => true,
    githubWebhook: () => ({ secrets: githubSecrets, github }),
    doctor: async (env) => { doctorRuns.push(env); return healthy; },
    write: (line) => lines.push(line),
    now: () => T0,
    cliVersion: "1.3.0",
    ...overrides,
  };
  return { deps, store, lines, doctorRuns, prepared, github, githubSecrets, deployer: deployer as ReturnType<typeof confirmingDeployer> };
}

const options = { env: "staging", yes: true, allowReplace: [] as string[] };

describe("agentx upgrade (FR-042 to FR-044)", () => {
  it("shows the notes, deploys in upgrade order, records the new version, keeps the budget and runs doctor", async () => {
    const h = await harness();
    const result = await runUpgrade(options, h.deps);
    expect(h.lines).toContain("Upgrading staging from 1.2.3 to 1.3.0 (templates engine)");
    expect(h.lines).toContain("Release notes for 1.3.0:\n  Fixes.");
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-control-plane", "agentx-staging-slack"]);
    // Ruling F7: the operator's budget survives the upgrade.
    expect(h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")?.parameters.BudgetMonthlyUsd).toBe("250");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.3.0", doctor: { failed: 0 } });
  });

  describe("the GitHub webhook", () => {
    it("sets the hook URL, keeps the stored secret, and says so before doctor runs", async () => {
      const h = await harness();
      await runUpgrade(options, h.deps);
      expect(h.lines).toContain("GitHub webhook: configured");
      expect(h.lines.indexOf("GitHub webhook: configured")).toBeLessThan(h.lines.indexOf("Checking the environment with agentx doctor"));
      expect(h.github.hookWrites).toEqual([{ url: GITHUB_WEBHOOK_URL, secret: HAND_SET_WEBHOOK_SECRET }]);
      expect((JSON.parse(h.githubSecrets.values.get(GITHUB_APP_SECRET)!) as { webhookSecret: string }).webhookSecret).toBe(HAND_SET_WEBHOOK_SECRET);
    });

    it("asks for Active to be turned on when the App's hook had no URL or another one", async () => {
      const h = await harness();
      await runUpgrade(options, h.deps);
      expect(h.lines).toContain("GitHub webhook: turn on Active at https://github.com/organizations/acme/settings/apps/agentx-acme-staging if it is off");
      const same = await harness({ github: { hookUrl: GITHUB_WEBHOOK_URL } });
      await runUpgrade(options, same.deps);
      expect(same.lines.some((line) => line.includes("turn on Active"))).toBe(false);
    });

    it("says unchanged when the hook already points at the control plane", async () => {
      const h = await harness({ github: { hookUrl: GITHUB_WEBHOOK_URL } });
      await runUpgrade(options, h.deps);
      expect(h.lines).toContain("GitHub webhook: unchanged");
      // The stored secret is sent again: GitHub masks its own copy, so a mismatch could not be seen.
      expect(h.github.hookWrites).toEqual([{ url: GITHUB_WEBHOOK_URL, secret: HAND_SET_WEBHOOK_SECRET }]);
    });

    it("tells the owner which events to tick and where", async () => {
      const h = await harness({ github: { hookUrl: GITHUB_WEBHOOK_URL, events: ["pull_request"] } });
      await runUpgrade(options, h.deps);
      expect(h.lines).toContain("GitHub webhook: tick these events on https://github.com/organizations/acme/settings/apps/agentx-acme-staging/permissions: pull_request_review, pull_request_review_comment, issue_comment, deployment_status, workflow_run, issues, check_suite, check_run, status, push, repository");
    });

    it("never prints the webhook secret, stored or generated", async () => {
      const kept = await harness();
      await runUpgrade(options, kept.deps);
      expect(kept.lines.join("\n")).not.toContain(HAND_SET_WEBHOOK_SECRET);

      const generated = await harness({ githubSecret: JSON.stringify({ appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
      const result = await runUpgrade(options, generated.deps);
      const stored = JSON.parse(generated.githubSecrets.values.get(GITHUB_APP_SECRET)!) as { webhookSecret: string };
      expect(stored.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(generated.lines.join("\n")).not.toContain(stored.webhookSecret);
      expect(JSON.stringify(result)).not.toContain(stored.webhookSecret);
    });

    it("carries on to doctor, and says what failed, when GitHub cannot be set up", async () => {
      const h = await harness();
      h.github.setHookConfig = async () => { throw agentXError("RUNTIME_UNAVAILABLE", "GitHub webhook update failed with HTTP 503"); };
      await runUpgrade(options, h.deps);
      expect(h.lines.some((line) => line.startsWith("GitHub webhook: could not be set up") && line.includes("HTTP 503"))).toBe(true);
      expect(h.doctorRuns).toEqual(["staging"]);
    });

    it("does not print the secret when storing it fails", async () => {
      const h = await harness({ githubSecret: JSON.stringify({ appId: "123", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
      let written = "";
      h.githubSecrets.put = async (_name, value) => { written = value; throw Object.assign(new Error(`access denied for ${value}`), { name: "AccessDeniedException" }); };
      await runUpgrade(options, h.deps);
      const generated = (JSON.parse(written) as { webhookSecret: string }).webhookSecret;
      expect(h.lines.some((line) => line.startsWith("GitHub webhook: could not be set up") && line.includes("AccessDeniedException"))).toBe(true);
      expect(h.lines.join("\n")).not.toContain(generated);
      expect(h.lines.join("\n")).not.toContain("PRIVATE KEY");
    });

    it("skips an environment that has no GitHub App yet", async () => {
      const h = await harness({ githubSecret: null });
      await runUpgrade(options, h.deps);
      expect(h.lines.some((line) => line.startsWith("GitHub webhook: skipped"))).toBe(true);
      expect(h.github.hookWrites).toEqual([]);
    });
  });

  it("never prints the callback signing key", async () => {
    const h = await harness();
    const result = await runUpgrade(options, h.deps);
    expect(h.lines.join("\n")).not.toContain(CALLBACK_KEY);
    expect(JSON.stringify(result)).not.toContain(CALLBACK_KEY);
  });

  it("refuses an older release before anything else happens", async () => {
    const h = await harness({ loadRelease: async () => release("1.1.0") });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.1.0 is older than 1.2.3");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("re-checks the version under the environment lock, so a concurrent upgrade is never undone (question 3)", async () => {
    const h = await harness();
    h.deps.loadRelease = async () => {
      // Another upgrade finishes while this one loads its release.
      await writeEnvironmentSettings(h.store, { ...INSTALLED, version: "1.4.0" });
      return release("1.3.0");
    };
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.3.0 is older than 1.4.0");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("holds the environment lock while it deploys, and releases it after", async () => {
    const h = await harness();
    const holders: Array<string | undefined> = [];
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => {
      holders.push(h.store.values.get(lockParameterName("staging")));
      return prepare(input);
    };
    await runUpgrade(options, h.deps);
    expect(holders).toHaveLength(1);
    expect(JSON.parse(holders[0] ?? "{}")).toMatchObject({ holder: ADMIN, command: "upgrade" });
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("refuses while another command holds the environment lock, deploying nothing", async () => {
    const h = await harness();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: "arn:aws:sts::123456789012:assumed-role/Admin/bob", command: "config set", acquiredAt: new Date(T0).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow(`locked by arn:aws:sts::123456789012:assumed-role/Admin/bob running "config set" since ${new Date(T0).toISOString()}; wait for it to finish, then run the same agentx command again`);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("offers to take over a stale lock a killed upgrade left, and upgrades once confirmed", async () => {
    const asked: string[] = [];
    const h = await harness({ ask: async (prompt) => { asked.push(prompt); return "y"; } });
    const stale = new Date(T0 - 3 * 60 * 60 * 1000).toISOString();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: stale }));
    await runUpgrade(options, h.deps);
    expect(asked[0]).toBe(`Environment staging is locked by ${ADMIN} running "upgrade" since ${stale}. Take the lock over? Say yes only if that command is no longer running. [y/N] `);
    expect(h.deployer.deployed).toHaveLength(6);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("keeps a stale lock when the takeover is declined, deploying nothing", async () => {
    const h = await harness({ ask: async () => "n" });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: new Date(T0 - 3 * 60 * 60 * 1000).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("older than 2 hours");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("offers the same caller its own cut-off upgrade's lock at once, and upgrades once confirmed", async () => {
    const asked: string[] = [];
    const h = await harness({ ask: async (prompt) => { asked.push(prompt); return "y"; } });
    const fresh = new Date(T0).toISOString();
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: fresh }));
    await runUpgrade(options, h.deps);
    expect(asked[0]).toBe(`Environment staging is locked by ${ADMIN} running "upgrade" since ${fresh}. Take the lock over? Say yes only if that command is no longer running. [y/N] `);
    expect(h.deployer.deployed).toHaveLength(6);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("still refuses a fresh upgrade lock another caller holds, asking nothing", async () => {
    const asked: string[] = [];
    const h = await harness({ ask: async (prompt) => { asked.push(prompt); return "y"; } });
    const bob = "arn:aws:sts::123456789012:assumed-role/Admin/bob";
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: bob, command: "upgrade", acquiredAt: new Date(T0).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow(`locked by ${bob} running "upgrade"`);
    expect(asked).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("never takes over its own lock without a terminal to ask at", async () => {
    const h = await harness({ isInteractive: () => false });
    h.store.values.set(lockParameterName("staging"), JSON.stringify({ holder: ADMIN, command: "upgrade", acquiredAt: new Date(T0).toISOString() }));
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("your own earlier \"upgrade\"");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("allows the same release, so a re-run finishes an upgrade that stopped (question 3)", async () => {
    const h = await harness({ loadRelease: async () => release("1.2.3") });
    await runUpgrade(options, h.deps);
    expect(h.lines).toContain("Environment staging already runs 1.2.3; checking that every stack is on it");
    expect(h.deployer.deployed).toHaveLength(6);
  });

  it("refuses a prerelease target right after loading it, deploying nothing (ruling F31)", async () => {
    const h = await harness({ loadRelease: async () => release("1.3.0-rc.1") });
    await expect(runUpgrade({ ...options, releaseDir: "/releases/rc" }, h.deps)).rejects.toThrow("release 1.3.0-rc.1 is a prerelease");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("needs a version when this agentx was built from source", async () => {
    const h = await harness({ cliVersion: undefined });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("this agentx was built from source, so it has no release of its own; pass --to <version> or --release <dir>");
  });

  it("refuses --to that does not match the release directory", async () => {
    const h = await harness();
    await expect(runUpgrade({ ...options, to: "1.4.0", releaseDir: "/releases/1.3.0" }, h.deps)).rejects.toThrow("--release holds release 1.3.0, not 1.4.0");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("refuses the legacy deployment and an environment that is not installed", async () => {
    const h = await harness();
    await writeEnvironmentSettings(h.store, { ...INSTALLED, naming: "legacy" });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("agentx upgrade works on environments installed with agentx init; staging uses the legacy stack names");
    await expect(runUpgrade({ ...options, env: "other" }, h.deps)).rejects.toThrow("environment other is not installed in this account and region");
  });

  it("under the operator role, skips an unchanged access stack", async () => {
    const h = await harness({ caller: OPERATOR });
    await runUpgrade(options, h.deps);
    expect(h.deployer.deployed[0]).toBe("agentx-staging-foundation");
  });

  it("under the operator role, stops before deploying when the release changes the access stack (question 9)", async () => {
    const h = await harness({ caller: OPERATOR, loadRelease: async () => release("1.3.0", [], CHANGED_ACCESS_TEMPLATE) });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.3.0 changes the access stack, which only admin credentials can deploy");
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("agentx --env staging upgrade --export <dir>");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("with admin credentials, deploys a changed access stack first without comparing it (question 9)", async () => {
    const sent: unknown[] = [];
    const h = await harness({ loadRelease: async () => release("1.3.0", ["BudgetMonthlyUsd"], CHANGED_ACCESS_TEMPLATE), cloudFormation: { send: async (command) => { sent.push(command); throw new Error("unexpected"); } } });
    await runUpgrade(options, h.deps);
    expect(h.deployer.deployed[0]).toBe("agentx-staging-access");
    expect(sent).toEqual([]);
  });

  it("stops on a data replacement under --yes, deleting nothing, and continues with --allow-replace", async () => {
    const changes = { "agentx-staging-control-plane": [{ action: "Modify", logicalId: "State", type: "AWS::DynamoDB::Table", replacement: "True" }] };
    const stopped = await harness({ changes });
    await expect(runUpgrade(options, stopped.deps)).rejects.toThrow("upgrade stopped: agentx-staging-control-plane would replace State (AWS::DynamoDB::Table)");
    expect(stopped.deployer.deployed).not.toContain("agentx-staging-control-plane");
    const allowed = await harness({ changes });
    await runUpgrade({ ...options, allowReplace: ["State"] }, allowed.deps);
    expect(allowed.deployer.deployed).toContain("agentx-staging-control-plane");
  });

  it("stops when the operator declines a stack's changes, naming how to continue", async () => {
    const h = await harness({ ask: async () => "n" });
    await expect(runUpgrade({ ...options, yes: false }, h.deps)).rejects.toThrow("upgrade stopped before agentx-staging-access: nothing in it changed");
    expect(h.doctorRuns).toEqual([]);
  });

  it("lists a config key the new release drops, before deploying", async () => {
    const h = await harness({ loadRelease: async () => release("1.3.0", ["BudgetScope"]) });
    await runUpgrade(options, h.deps);
    const warning = h.lines.findIndex((line) => line === "config key budget.monthlyUsd (250) is not in release 1.3.0, so the upgrade drops it; nothing replaces it");
    const firstDeploy = h.lines.findIndex((line) => line.startsWith("deployed "));
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(firstDeploy);
  });

  it("fails when doctor finds a problem after the upgrade (FR-044)", async () => {
    const h = await harness({ doctor: async () => ({ ...healthy, failed: 2 }) });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("upgraded staging to 1.3.0, but 2 doctor checks failed; fix what each one names, then run agentx doctor again");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
    expect(h.deployer.deployed).toHaveLength(6);
  });

  it("says the upgrade finished when doctor itself cannot run", async () => {
    const h = await harness({ doctor: async () => { throw new Error("connect ETIMEDOUT 140.82.112.3:443"); } });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("upgraded staging to 1.3.0, but doctor could not run: connect ETIMEDOUT 140.82.112.3:443; run agentx doctor");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
  });

  it("keeps a release's own refusal for a region it does not cover", async () => {
    const uncovered: LoadedRelease = { ...release(), template: (part) => { if (part === "access") throw agentXError("CONFIG_INVALID", "release 1.3.0 does not cover region us-east-1; use a region it lists"); return "{}"; } };
    const h = await harness({ caller: OPERATOR, loadRelease: async () => uncovered });
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.3.0 does not cover region us-east-1; use a region it lists");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("puts no secret in a refusal", async () => {
    const refusals: string[] = [];
    const changes = { "agentx-staging-control-plane": [{ action: "Modify", logicalId: "State", type: "AWS::DynamoDB::Table", replacement: "True" }] };
    for (const h of [
      await harness({ changes }),
      await harness({ caller: OPERATOR, loadRelease: async () => release("1.3.0", [], CHANGED_ACCESS_TEMPLATE) }),
      await harness({ doctor: async () => ({ ...healthy, failed: 1 }) }),
    ]) {
      const error = await runUpgrade(options, h.deps).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      refusals.push((error as Error).message, ...h.lines);
    }
    for (const text of refusals) expect(text).not.toContain(CALLBACK_KEY);
  });

  it("needs --yes when stdin is not a terminal", async () => {
    const h = await harness({ isInteractive: () => false });
    await expect(runUpgrade({ ...options, yes: false }, h.deps)).rejects.toThrow("agentx upgrade needs --yes when stdin is not a terminal");
  });

  it("with --export, writes the bundle and deploys nothing", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness();
    const result = await runUpgrade({ ...options, exportDir: out }, h.deps);
    expect(result.exported).toBe(out);
    expect(h.deployer.deployed).toEqual([]);
    expect(h.prepared).toEqual([]);
    expect(h.doctorRuns).toEqual([]);
    // No AWS write: the settings keep the old version, and no lock is taken.
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
    expect(await readdir(out)).toEqual(expect.arrayContaining(["README.md", "parameters", "templates", "packages"]));
    expect(h.lines).toContain("Writing the upgrade of staging from 1.2.3 to 1.3.0 (templates engine) to a bundle");
  });

  it("with --export under the operator role, carries a changed access stack instead of refusing (question 9)", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness({ caller: OPERATOR, isInteractive: () => false, loadRelease: async () => release("1.3.0", [], CHANGED_ACCESS_TEMPLATE) });
    const result = await runUpgrade({ ...options, yes: false, exportDir: out }, h.deps);
    expect(result.parts[0]).toBe("access");
    expect(await readFile(join(out, "README.md"), "utf8")).toContain("create-change-set --stack-name agentx-staging-access ");
  });

  it("with --export, leaves out an unchanged access stack", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness();
    const result = await runUpgrade({ ...options, exportDir: out }, h.deps);
    expect(result.parts).not.toContain("access");
    expect(await readFile(join(out, "README.md"), "utf8")).not.toContain("--stack-name agentx-staging-access ");
  });

  it("with --export, describes each stack once", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    const h = await harness();
    const described: string[] = [];
    const stacks = h.deps.stacks;
    h.deps.stacks = { describe: async (name) => { described.push(name); return stacks.describe(name); } };
    await runUpgrade({ ...options, exportDir: out }, h.deps);
    expect(described.length).toBeGreaterThan(0);
    expect(new Set(described).size).toBe(described.length);
  });

  it("applies the same sign-in values as agentx upgrade when SSM and the stack disagree (ruling F29)", async () => {
    const declared = ["BudgetMonthlyUsd", "SlackTeamId", "DeveloperSignInSlack"];
    const controlPlane = { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****", SlackTeamId: "T0OLD", DeveloperSignInSlack: "enabled" };
    const upgraded = await harness({ controlPlane, loadRelease: async () => release("1.3.0", declared) });
    await writeSlackTeamId(upgraded.store, "staging", "T0NEW");
    await runUpgrade(options, upgraded.deps);
    const sent = upgraded.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")!.parameters;

    const out = await bundleDir("agentx-upgrade-run-export-");
    const exported = await harness({ controlPlane, loadRelease: async () => release("1.3.0", declared) });
    await writeSlackTeamId(exported.store, "staging", "T0NEW");
    await runUpgrade({ ...options, exportDir: out }, exported.deps);
    const file = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<{ ParameterKey: string; ParameterValue?: string }>;
    const written = Object.fromEntries(file.map((entry) => [entry.ParameterKey, entry.ParameterValue]));

    expect({ SlackTeamId: sent.SlackTeamId, DeveloperSignInSlack: sent.DeveloperSignInSlack }).toEqual({ SlackTeamId: "T0NEW", DeveloperSignInSlack: "disabled" });
    expect({ SlackTeamId: written.SlackTeamId, DeveloperSignInSlack: written.DeveloperSignInSlack }).toEqual({ SlackTeamId: sent.SlackTeamId, DeveloperSignInSlack: sent.DeveloperSignInSlack });
  });

  it("with --export, still refuses an older release and a prerelease", async () => {
    const out = await bundleDir("agentx-upgrade-run-export-");
    await expect(runUpgrade({ ...options, exportDir: out }, (await harness({ loadRelease: async () => release("1.1.0") })).deps)).rejects.toThrow("release 1.1.0 is older than 1.2.3");
    await expect(runUpgrade({ ...options, exportDir: out }, (await harness({ loadRelease: async () => release("1.3.0-rc.1") })).deps)).rejects.toThrow("release 1.3.0-rc.1 is a prerelease");
    expect(await readdir(dirname(out))).toEqual([]);
  });
});

describe("agentx upgrade with the cdk engine", () => {
  const cdk = async (overrides: Parameters<typeof harness>[0] = {}) => {
    const h = await harness(overrides);
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    return h;
  };

  it("reviews each stack's cdk diff before deploying it", async () => {
    const h = await cdk({ cdkDiff: async (request) => (request.part === "control-plane" ? "Stack agentx-staging-control-plane\nResources\n[-] AWS::S3::Bucket Artifacts Artifacts9F8E7D destroy" : `Stack ${request.stackName}\nThere were no differences`) });
    await expect(runUpgrade({ ...options, source: "/src" }, h.deps)).rejects.toThrow("upgrade stopped: agentx-staging-control-plane would delete Artifacts9F8E7D (AWS::S3::Bucket)");
    expect(h.deployer.deployed).toContain("agentx-staging-runtime");
    expect(h.deployer.deployed).not.toContain("agentx-staging-control-plane");
  });

  it("upgrades every stack with admin credentials and runs doctor, which must pass (ruling F4)", async () => {
    const h = await cdk();
    const result = await runUpgrade({ ...options, source: "/src" }, h.deps);
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-control-plane", "agentx-staging-slack"]);
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result.doctor).toEqual({ failed: 0, warned: 0 });
  });

  // The Public install's embedder image copy (Lambda cannot pull from the pull-through cache): `prepare` returns the copy, and runUpgrade must hand it to deployEnvironment, which runs it right after
  // the access stack. Deleting the wiring in run.ts leaves the control plane naming an image nothing copied.
  it("runs the prepared embedder image copy right after the access stack and before every other stack, only on the cdk engine, and stops there when it refuses", async () => {
    const order: string[] = [];
    const h = await cdk();
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => ({ ...(await prepare(input)), publishEmbedderImage: async () => { order.push(`copy after ${h.deployer.deployed.join(",")}`); } });
    await runUpgrade({ ...options, source: "/src" }, h.deps);
    expect(order).toEqual(["copy after agentx-staging-access"]);
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-control-plane", "agentx-staging-slack"]);
    // a refusal stops the upgrade before any other stack changes
    const refused = await cdk();
    const refusedPrepare = refused.deps.prepare.bind(refused.deps);
    refused.deps.prepare = async (input) => ({ ...(await refusedPrepare(input)), publishEmbedderImage: async () => { throw new Error("the copy refused"); } });
    await expect(runUpgrade({ ...options, source: "/src" }, refused.deps)).rejects.toThrow("the copy refused");
    expect(refused.deployer.deployed).toEqual(["agentx-staging-access"]);
    // nothing prepared: nothing runs
    const plain = await cdk();
    await runUpgrade({ ...options, source: "/src" }, plain.deps);
    expect(order).toHaveLength(1);
  });

  // Issue 152 replaces live check L7's refusal: a source-built CLI takes the version from the tag.
  it("with a source-built CLI and no --release or --to, builds the release from --source: the tag's version", async () => {
    const built: Array<{ source: string; images?: { worker?: string; slack?: string; bootStage2Sha256?: string } }> = [];
    const h = await cdk({
      cliVersion: undefined,
      loadRelease: async () => { throw new Error("test setup: no release directory or download expected"); },
      sourceRelease: async (input) => { built.push(input); return release("1.3.0"); },
    });
    const images = { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"d".repeat(64)}`, bootStage2Sha256: "5a".repeat(32) };
    const result = await runUpgrade({ ...options, source: "/src", images }, h.deps);
    expect(built).toEqual([{ source: "/src", images }]);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.3.0" });
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.3.0");
  });

  // Task 10: the image and the hash of the boot script it carries are written together, so a hand-supplied worker image brings its hash.
  it("refuses a hand-supplied worker image without --boot-stage2-sha256, before it reads or deploys anything", async () => {
    const h = await cdk({ cliVersion: undefined, loadRelease: async () => { throw new Error("test setup: nothing may be loaded"); } });
    const images = { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/w@sha256:${"d".repeat(64)}` };
    await expect(runUpgrade({ ...options, source: "/src", images }, h.deps)).rejects.toThrow("--worker-image needs --boot-stage2-sha256");
    await expect(runUpgrade({ ...options, source: "/src", images: { ...images, bootStage2Sha256: "nope" } }, h.deps)).rejects.toThrow("--boot-stage2-sha256 must be 64 lower-case hex digits");
    expect(h.deployer.deployed).toEqual([]);
    expect(h.prepared).toEqual([]);
  });

  // Review R7: a source or override upgrade has a release with no embedder image; the image the stack runs is handed on, and --embedder-image names one.
  it("hands prepare the embedder image the control plane runs now (not `none`) and the --embedder-image flag", async () => {
    const running = `123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara/embedder@sha256:${"a".repeat(64)}`;
    const named = `123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara/embedder@sha256:${"b".repeat(64)}`;
    const base = { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****" };
    for (const [stackValue, images, expected] of [
      [running, undefined, { deployedEmbedderImage: running }],
      ["none", undefined, {}],
      [running, { embedder: named }, { embedderImage: named, deployedEmbedderImage: running }],
    ] as const) {
      const seen: Array<{ embedderImage?: string; deployedEmbedderImage?: string }> = [];
      const h = await cdk({ cliVersion: undefined, controlPlane: { ...base, EmbedderImageUri: stackValue }, sourceRelease: async () => release("1.3.0") });
      const prepare = h.deps.prepare.bind(h.deps);
      h.deps.prepare = async (input) => { seen.push({ ...(input.embedderImage === undefined ? {} : { embedderImage: input.embedderImage }), ...(input.deployedEmbedderImage === undefined ? {} : { deployedEmbedderImage: input.deployedEmbedderImage }) }); return prepare(input); };
      await runUpgrade({ ...options, source: "/src", ...(images === undefined ? {} : { images }) }, h.deps);
      expect(seen, stackValue).toEqual([expected]);
    }
  });

  // Lane fix/0513-embedder-3gb: a table left by a rolled-back Team record build fails the next build on "already exists"; the first build is refused before anything is prepared or changed.
  it("before the first Team record build, stops on a left-over record table and changes nothing; a built record or a clear account is not stopped", async () => {
    const base = { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****" };
    for (const [controlPlane, probeAnswer, expectation] of [
      [base, { exists: true, itemCount: 0, deletionProtected: true }, "refused"],
      [base, { exists: false }, "ran"],
      [{ ...base, TeamRecordEnabled: "1" }, { exists: true, itemCount: 12 }, "ran"],
    ] as const) {
      const asked: string[] = [];
      const h = await cdk({ cliVersion: undefined, controlPlane, sourceRelease: async () => release("1.3.0") });
      await writeTeamRecordRecord(h.store, "staging", { enabled: true, options: {} });
      h.deps.teamRecordProbe = { tableState: async (name) => { asked.push(name); return probeAnswer; } };
      const prepared: string[] = [];
      const prepare = h.deps.prepare.bind(h.deps);
      h.deps.prepare = async (input) => { prepared.push("prepare"); return prepare(input); };
      const run = runUpgrade({ ...options, source: "/src" }, h.deps);
      if (expectation === "refused") {
        await expect(run).rejects.toThrow(/agentx-staging-team-record exists.*left over from an earlier try/s);
        expect(prepared).toEqual([]);
        expect(h.deployer.deployed).toEqual([]);
        expect(asked).toEqual(["agentx-staging-team-record"]);
      } else {
        await run;
        expect(prepared).toEqual(["prepare"]);
        expect(asked).toEqual(controlPlane === base ? ["agentx-staging-team-record"] : []);
      }
    }
  });

  it("with --to or --release, loads that release as before (prepare then checks it is the source's tag)", async () => {
    const loaded: Array<{ releaseDir?: string; version?: string }> = [];
    const h = await cdk({
      cliVersion: undefined,
      loadRelease: async (input) => { loaded.push(input); return release("1.3.0"); },
      sourceRelease: async () => { throw new Error("test setup: no source release expected"); },
    });
    await runUpgrade({ ...options, source: "/src", to: "1.3.0" }, h.deps);
    expect(loaded).toEqual([{ version: "1.3.0" }]);
  });

  it("refuses a --to that is not the source's tag before anything deploys, through the real prepare (review M9)", async () => {
    const h = await cdk({ cliVersion: undefined, loadRelease: async () => release("1.3.0") });
    const tagged = { async run(_command: string, args: string[]) { return { stdout: args[0] === "tag" ? "v1.4.0\n" : "" }; } };
    h.deps.prepare = (input) => prepareDeployment({
      engine: "cdk", env: "staging", region: "us-east-1", account: "123456789012", identityMode: "cognito", release: input.release, source: "/src",
      deps: { identity: h.deps.identity, store: h.store, secrets: memoryInitSecrets({}), commandRunner: tagged }, stderr: { write: () => undefined },
    });
    await expect(runUpgrade({ ...options, source: "/src", to: "1.3.0" }, h.deps)).rejects.toThrow("the cdk engine must run from a checkout of tag v1.3.0; /src is at v1.4.0");
    expect(h.deployer.deployed).toEqual([]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
  });

  it("reports the config keys the synth drops, not the ones the release's templates drop (issue 152)", async () => {
    // The release's template declares the thread limit; the synth of the source no longer does.
    const h = await cdk({
      controlPlane: { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", SlackThreadTurnsPerMinute: "12", CallbackSigningKey: "****" },
      loadRelease: async () => release("1.3.0", ["BudgetScope", "SlackThreadTurnsPerMinute"]),
    });
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => ({ ...(await prepare(input)), declaredParameters: (part) => new Set(part === "control-plane" ? ["BudgetMonthlyUsd"] : []) });
    await runUpgrade({ ...options, source: "/src" }, h.deps);
    // Exactly the synth's drop: the budget, which the release's template does not declare, is kept.
    expect(h.lines.filter((line) => line.startsWith("config key"))).toEqual(["config key limits.threadTurnsPerMinute (12) is not in release 1.3.0, so the upgrade drops it; nothing replaces it"]);
    expect(h.lines).toContain("kept agentx-staging-control-plane: BudgetMonthlyUsd; not in this release, so not sent: SlackThreadTurnsPerMinute");
    const controlPlane = h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")!;
    expect(controlPlane.parameters.BudgetMonthlyUsd).toBe("250");
    expect(controlPlane.parameters).not.toHaveProperty("SlackThreadTurnsPerMinute");
  });

  it("needs --source", async () => {
    const h = await cdk();
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("the cdk engine upgrades from a checkout of the target release's tag; pass --source <dir>");
  });

  it("a hosted cloud with a custom domain recorded is not upgradable with operator credentials either: the access stack (the deploy role's domain grants) is never skipped (0.5.7)", async () => {
    const h = await cdk({ caller: OPERATOR });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk", cloud: true });
    await writeCustomDomain(h.store, "staging", { domainName: "staging.rovara.dev", hostedZoneId: "Z08286002FKUL2VBSO3MO" });
    await expect(runUpgrade({ ...options, source: "/src" }, h.deps)).rejects.toThrow("a cdk environment upgrades with admin credentials");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("refuses the operator role up front, naming admin credentials (ruling F20)", async () => {
    const h = await cdk({ caller: OPERATOR });
    await expect(runUpgrade({ ...options, source: "/src" }, h.deps)).rejects.toThrow("a cdk environment upgrades with admin credentials (the operator role cannot use CDK's bootstrap resources)");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("refuses --export (ruling F19)", async () => {
    const h = await cdk();
    await expect(runUpgrade({ ...options, exportDir: "/tmp/bundle" }, h.deps)).rejects.toThrow("upgrade --export writes the published templates; a cdk environment upgrades with --source");
    expect(h.deployer.deployed).toEqual([]);
  });
});

/** The command's own writer (stderr) replaces the harness's line collector. */
function withoutWrite(deps: UpgradeDependencies): Partial<UpgradeDependencies> {
  const copy: Partial<UpgradeDependencies> = { ...deps };
  delete copy.write;
  // MODEL-PROXY-TLS (0.5.15): the CLI's own default reads the worker URL parameter through real SSM and EC2 clients on every upgrade. These tests run the real command, so they name the read:
  // an install with no model proxy TLS and no worker instances. Left out, the command would reach for AWS from a test.
  copy.modelProxyTlsState ??= async () => ({ deployedUrl: undefined, urlParameter: undefined, workers: [] });
  return copy;
}

describe("the agentx upgrade command", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } };
  }

  it("upgrades and says so, keeping progress on stderr", async () => {
    const h = await harness();
    const io = capture();
    const rest = withoutWrite(h.deps);
    const code = await executeCli(["--env", "staging", "upgrade", "--yes"], { ...io, upgrade: rest });
    expect(code).toBe(0);
    expect(io.out.join("")).toBe("Upgraded staging from 1.2.3 to 1.3.0.\n");
    expect(io.err.join("")).toContain("Upgrading staging from 1.2.3 to 1.3.0 (templates engine)");
    expect(io.out.join("") + io.err.join("")).not.toContain(CALLBACK_KEY);
  });

  describe("--no-reserved-concurrency", () => {
    const cdkHarness = async (overrides: Parameters<typeof harness>[0] = {}) => {
      const h = await harness(overrides);
      await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
      return h;
    };

    it("tells the cdk app to leave Lambda reservations off, for the deploy and for the diff that reviews it", async () => {
      const prepareInputs: Array<{ reservedConcurrency?: false }> = [];
      const diffs: Array<false | undefined> = [];
      const h = await cdkHarness();
      const base = h.deps;
      const io = capture();
      const code = await executeCli(["--env", "staging", "upgrade", "--yes", "--source", "/src", "--no-reserved-concurrency"], {
        ...io,
        upgrade: { ...withoutWrite(base), prepare: async (input) => { prepareInputs.push(input); return base.prepare(input); }, cdkDiff: async (request, settings, source, reservedConcurrency) => { diffs.push(reservedConcurrency); return base.cdkDiff(request, settings, source, reservedConcurrency); } },
      });
      expect(code).toBe(0);
      expect(prepareInputs.map((input) => input.reservedConcurrency)).toEqual([false]);
      expect(diffs.length).toBeGreaterThan(0);
      expect(new Set(diffs)).toEqual(new Set([false]));
    });

    it("leaves reserved concurrency on when the option is not given", async () => {
      const prepareInputs: Array<{ reservedConcurrency?: false }> = [];
      const h = await cdkHarness();
      const base = h.deps;
      const io = capture();
      const code = await executeCli(["--env", "staging", "upgrade", "--yes", "--source", "/src"], { ...io, upgrade: { ...withoutWrite(base), prepare: async (input) => { prepareInputs.push(input); return base.prepare(input); } } });
      expect(code).toBe(0);
      expect(prepareInputs.map((input) => "reservedConcurrency" in input)).toEqual([false]);
    });

    it("refuses an environment on the templates engine, whose templates are built ahead and cannot change a reservation", async () => {
      const h = await harness();
      await expect(runUpgrade({ ...options, reservedConcurrency: false }, h.deps)).rejects.toThrow(/reserved concurrency.*cdk engine/i);
      expect(h.deployer.deployed).toEqual([]);
    });
  });

  it("with --export, says where the bundle is and who it is for", async () => {
    const out = await bundleDir("agentx-upgrade-cli-export-");
    const h = await harness();
    const io = capture();
    const code = await executeCli(["--env", "staging", "upgrade", "--export", out], { ...io, upgrade: withoutWrite(h.deps) });
    expect(code).toBe(0);
    expect(io.out.join("")).toBe(`Wrote the upgrade of staging to 1.3.0 to ${out}; give it to your platform team.\n`);
    expect(h.deployer.deployed).toEqual([]);
  });

  it("passes --to, --release and --allow-replace through, and prints JSON with --json", async () => {
    const loaded: Array<{ releaseDir?: string; version?: string }> = [];
    const changes = { "agentx-staging-control-plane": [{ action: "Modify", logicalId: "State", type: "AWS::DynamoDB::Table", replacement: "True" }] };
    const h = await harness({ changes, loadRelease: async (input) => { loaded.push(input); return release(); } });
    const io = capture();
    const rest = withoutWrite(h.deps);
    const code = await executeCli(["--env", "staging", "--json", "upgrade", "--yes", "--release", "/releases/1.3.0", "--to", "1.3.0", "--allow-replace", "State"], { ...io, upgrade: rest });
    expect(code).toBe(0);
    expect(loaded).toEqual([{ releaseDir: "/releases/1.3.0" }]);
    expect(h.deployer.deployed).toContain("agentx-staging-control-plane");
    expect(JSON.parse(io.out.join(""))).toMatchObject({ ok: true, data: { env: "staging", from: "1.2.3", to: "1.3.0" } });
  });

  it("passes --source and the image flags to the source release of a source-built CLI's cdk upgrade (issue 152)", async () => {
    const built: Array<{ source: string; images?: { worker?: string; slack?: string; bootStage2Sha256?: string } }> = [];
    const h = await harness({ cliVersion: undefined, sourceRelease: async (input) => { built.push(input); return release(); } });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    const io = capture();
    const slack = `123456789012.dkr.ecr.us-east-1.amazonaws.com/s@sha256:${"e".repeat(64)}`;
    const code = await executeCli(["--env", "staging", "upgrade", "--yes", "--source", "/src", "--slack-image", slack], { ...io, upgrade: withoutWrite(h.deps) });
    expect(io.err.join("")).not.toContain("AgentX error");
    expect(code).toBe(0);
    expect(built).toEqual([{ source: "/src", images: { slack } }]);
  });
});

describe("accessChanged (question 9)", () => {
  const input = (templateBody: string | undefined) => ({
    cloudFormation: { send: async () => (templateBody === undefined ? {} : { TemplateBody: templateBody }) },
    stackName: "agentx-staging-access", release: release(), region: "us-east-1", env: "staging",
  });

  it("is false for the same template written differently", async () => {
    expect(await accessChanged(input(JSON.stringify({ Resources: { ArtifactBucket: { Type: "AWS::S3::Bucket" } } }, null, 2)))).toBe(false);
  });

  it("is true when GetTemplate returns no body", async () => {
    expect(await accessChanged(input(undefined))).toBe(true);
  });

  it("is true when the deployed template is not JSON", async () => {
    expect(await accessChanged(input("Resources:\n  ArtifactBucket:\n    Type: AWS::S3::Bucket\n"))).toBe(true);
  });
});

describe("owner decision, 0.5.9: the upgrade turns decision cards on, once", () => {
  const CARDS = ["BudgetMonthlyUsd", "BudgetScope", "SlackThreadTurnsPerMinute", "DecisionCardsEnabled"];
  async function crossing(deployedCards: string, from = "0.5.8", to = "0.5.9") {
    const h = await harness({ controlPlane: { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****", DecisionCardsEnabled: deployedCards }, loadRelease: async () => release(to, CARDS), cliVersion: to });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, version: from });
    return h;
  }
  const sentCards = (h: Awaited<ReturnType<typeof harness>>) => h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")!.parameters.DecisionCardsEnabled;

  it("from a stack with 0, deploys 1 and says so in one line, with how to turn them off", async () => {
    const h = await crossing("0");
    await runUpgrade(options, h.deps);
    expect(sentCards(h)).toBe("1");
    expect(h.lines.filter((line) => line === DECISION_CARDS_ON_LINE)).toHaveLength(1);
    expect(DECISION_CARDS_ON_LINE).toBe("Decision cards are now on (decisionCards.enabled=1). To turn them off again: agentx config set decisionCards.enabled 0");
  });

  it("from a stack with 1, stays 1 with no line", async () => {
    const h = await crossing("1");
    await runUpgrade(options, h.deps);
    expect(sentCards(h)).toBe("1");
    expect(h.lines).not.toContain(DECISION_CARDS_ON_LINE);
  });

  it("an upgrade that starts at or after 0.5.9 never forces it again: an operator's 0 stays 0 (the force is keyed to the release it crosses)", async () => {
    const h = await crossing("0", "0.5.9", "0.5.10");
    await runUpgrade(options, h.deps);
    expect(sentCards(h)).toBe("0");
    expect(h.lines).not.toContain(DECISION_CARDS_ON_LINE);
    expect(forcedOperatorValues("0.5.9", "0.6.0")).toEqual({});
    expect(forcedOperatorValues("0.5.8", "0.6.0"), "an upgrade that jumps over 0.5.9 still crosses it").toEqual({ "control-plane": { DecisionCardsEnabled: "1" } });
  });

  it("--export writes the forced 1 as a value, never as UsePreviousValue, and says the same line", async () => {
    const out = await bundleDir("agentx-upgrade-run-forced-");
    const h = await crossing("0");
    await runUpgrade({ ...options, exportDir: out }, h.deps);
    const file = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: true }>;
    expect(file.filter((entry) => entry.ParameterKey === "DecisionCardsEnabled")).toEqual([{ ParameterKey: "DecisionCardsEnabled", ParameterValue: "1" }]);
    expect(h.lines).toContain(DECISION_CARDS_ON_LINE);
  });
});

/** A template set that declares every name and needs none: the rollback's parameter check passes it. */
class EveryName extends Set<string> { override has(): boolean { return true; } }
/** Every name but these: an older template that no longer declares them. */
function everythingBut(missing: string[]): ReadonlySet<string> {
  const set = new (class extends Set<string> { override has(name: string): boolean { return !missing.includes(name); } })();
  Object.defineProperty(set, "required", { value: new Set<string>() });
  return set;
}
function everything(required: string[] = []): ReadonlySet<string> {
  const set = new EveryName();
  Object.defineProperty(set, "required", { value: new Set(required) });
  return set;
}

// Owner policy 2026-11-12, "undo = redeploy the previous release": `agentx upgrade --rollback-to` is the only way an environment moves back.
describe("agentx upgrade --rollback-to", () => {
  // The installed 1.2.3 is newer than the floors this source ships, so every test names the floors it means.
  const known = { floors: [] as RollbackFloor[], declaredThrough: "1.2.3" };
  // The target's templates as the rollback checks them before the first deploy (deploy-environment.ts parameterProblems): by default they declare
  // every parameter sent and need none; a test names its own.
  const rollback = async (overrides: Parameters<typeof harness>[0] = {}, declared: (part: DeployPart) => ReadonlySet<string> = () => everything()) => {
    const h = await harness({ rollbackFloors: known, loadRelease: async () => release("1.1.0"), ...overrides });
    const prepare = h.deps.prepare.bind(h.deps);
    h.deps.prepare = async (input) => ({ ...(await prepare(input)), declaredParameters: declared });
    return h;
  };

  it("plain upgrade to an older release is still refused, names --rollback-to, and changes nothing", async () => {
    const h = await rollback();
    await expect(runUpgrade(options, h.deps)).rejects.toThrow("release 1.1.0 is older than 1.2.3, which environment staging runs; agentx upgrade never moves an environment back");
    await expect(runUpgrade({ ...options, to: "1.1.0" }, h.deps)).rejects.toThrow("run agentx upgrade --rollback-to 1.1.0");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
  });

  it("an explicit rollback loads that release, deploys every stack in upgrade order, records the rolled-back-to version and runs doctor", async () => {
    const loaded: Array<{ releaseDir?: string; version?: string }> = [];
    const h = await rollback({ loadRelease: async (input) => { loaded.push(input); return release("1.1.0"); } });
    const result = await runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps);
    expect(loaded).toEqual([{ version: "1.1.0" }]);
    expect(h.lines).toContain("Rolling back staging from 1.2.3 to 1.1.0 (templates engine): every change is shown and confirmed as for an upgrade");
    expect(h.deployer.deployed).toEqual(["agentx-staging-access", "agentx-staging-foundation", "agentx-staging-identity", "agentx-staging-runtime", "agentx-staging-control-plane", "agentx-staging-slack"]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.1.0");
    expect(h.doctorRuns).toEqual(["staging"]);
    expect(result).toMatchObject({ from: "1.2.3", to: "1.1.0", rolledBack: true });
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("shows each stack's changes and asks as an upgrade does: a declined stack stops the rollback and the recorded version stays", async () => {
    const changes = { "agentx-staging-access": [{ action: "Modify", logicalId: "ArtifactBucket", type: "AWS::S3::Bucket", replacement: "False" }] };
    const asked: string[] = [];
    const h = await rollback({ changes, ask: async (question) => { asked.push(question); return "n"; } });
    await expect(runUpgrade({ ...options, yes: false, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("rollback stopped before agentx-staging-access: nothing in it changed. Stacks rolled back before it already run 1.1.0; run agentx upgrade --rollback-to 1.1.0 again to continue");
    expect(asked).toEqual(["Apply these changes to agentx-staging-access? [y/N] "]);
    expect(h.lines.join("\n")).toContain("ArtifactBucket");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
    // Without a terminal it needs --yes, as an upgrade does.
    const quiet = await rollback({ isInteractive: () => false });
    await expect(runUpgrade({ ...options, yes: false, rollbackTo: "1.1.0" }, quiet.deps)).rejects.toThrow("agentx upgrade needs --yes when stdin is not a terminal");
    expect(quiet.deployer.deployed).toEqual([]);
  });

  it("stops on a data deletion under --yes unless it is named, as an upgrade does", async () => {
    const changes = { "agentx-staging-control-plane": [{ action: "Remove", logicalId: "LessonsTable", type: "AWS::DynamoDB::Table", replacement: "False" }] };
    const h = await rollback({ changes });
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("LessonsTable");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
  });

  it("refuses a target below a floor a newer release declared, before anything is prepared", async () => {
    const floors = { floors: [{ release: "1.2.0", floor: "1.1.5", reason: "rewrote every lesson row in a new shape" }], declaredThrough: "1.2.3" };
    const h = await rollback({ rollbackFloors: floors });
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("release 1.2.0 rewrote every lesson row in a new shape, so environment staging, which runs 1.2.3, rolls back no lower than 1.1.5; 1.1.0 is below that floor");
    expect(h.prepared).toEqual([]);
    expect(h.deployer.deployed).toEqual([]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
    // At the floor itself the rollback goes ahead.
    const atFloor = await rollback({ rollbackFloors: floors, loadRelease: async () => release("1.1.5") });
    await runUpgrade({ ...options, rollbackTo: "1.1.5" }, atFloor.deps);
    expect((await readEnvironmentSettings(atFloor.store, "staging"))?.version).toBe("1.1.5");
  });

  it("refuses when the installed release is newer than every floor this agentx knows", async () => {
    const h = await rollback({ rollbackFloors: { floors: [], declaredThrough: "1.2.0" } });
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("Run the rollback with release 1.2.3's agentx or a newer one");
    expect(h.prepared).toEqual([]);
  });

  it("refuses the same or a newer release, a version that is not x.y.z, and --to or --export beside it", async () => {
    await expect(runUpgrade({ ...options, rollbackTo: "1.2.3" }, (await rollback({ loadRelease: async () => release("1.2.3") })).deps)).rejects.toThrow("already runs 1.2.3; --rollback-to moves only to an older release");
    await expect(runUpgrade({ ...options, rollbackTo: "1.3.0" }, (await rollback({ loadRelease: async () => release("1.3.0") })).deps)).rejects.toThrow("release 1.3.0 is newer than 1.2.3");
    await expect(runUpgrade({ ...options, rollbackTo: "1.1" }, (await rollback()).deps)).rejects.toThrow("--rollback-to takes a published release version (x.y.z)");
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0", to: "1.1.0" }, (await rollback()).deps)).rejects.toThrow("do not combine it with --to");
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0", exportDir: "/out" }, (await rollback()).deps)).rejects.toThrow("cannot be combined with --export");
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0", releaseDir: "/releases/1.0.0" }, (await rollback({ loadRelease: async () => release("1.0.0") })).deps)).rejects.toThrow("--rollback-to 1.1.0 does not match the release given, which is 1.0.0 (--release)");
  });

  it("re-checks under the environment lock: a rollback that is no longer older changes nothing", async () => {
    const h = await rollback();
    h.deps.loadRelease = async () => {
      // Another command moves the environment to 1.0.0 while this one loads its release.
      await writeEnvironmentSettings(h.store, { ...INSTALLED, version: "1.0.0" });
      return release("1.1.0");
    };
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("release 1.1.0 is newer than 1.0.0");
    expect(h.prepared).toEqual([]);
    expect(h.store.values.has(lockParameterName("staging"))).toBe(false);
  });

  it("on the cdk engine, builds the target from the --source checkout (never a download) and checks its tag against --rollback-to", async () => {
    const built: string[] = [];
    const h = await rollback({ loadRelease: async () => { throw new Error("test setup: no download expected"); }, sourceRelease: async (input) => { built.push(input.source); return release("1.1.0"); } });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    await runUpgrade({ ...options, source: "/src-1.1.0", rollbackTo: "1.1.0" }, h.deps);
    expect(built).toEqual(["/src-1.1.0"]);
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.1.0");
    const wrongTag = await rollback({ sourceRelease: async () => release("1.0.0") });
    await writeEnvironmentSettings(wrongTag.store, { ...INSTALLED, engine: "cdk" });
    await expect(runUpgrade({ ...options, source: "/src", rollbackTo: "1.1.0" }, wrongTag.deps)).rejects.toThrow("does not match the release given, which is 1.0.0 (the --source checkout's tag)");
    expect(wrongTag.deployer.deployed).toEqual([]);
    const noSource = await rollback();
    await writeEnvironmentSettings(noSource.store, { ...INSTALLED, engine: "cdk" });
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, noSource.deps)).rejects.toThrow("pass --source <dir>");
  });

  it("the command takes --rollback-to and says it rolled back; --bundle and --deploy-approved refuse it", async () => {
    const h = await rollback();
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } };
    const code = await executeCli(["--env", "staging", "upgrade", "--yes", "--rollback-to", "1.1.0"], { ...io, upgrade: withoutWrite(h.deps) });
    expect(err.join("")).not.toContain("AgentX error");
    expect(code).toBe(0);
    expect(out.join("")).toBe("Rolled back staging from 1.2.3 to 1.1.0.\n");
    expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.1.0");
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0", bundleDir: "/bundle" }, (await rollback()).deps)).rejects.toThrow("do not combine it with --release, --to, --rollback-to");
    err.length = 0;
    expect(await executeCli(["--env", "staging", "upgrade", "--deploy-approved", "a".repeat(64), "--rollback-to", "1.1.0"], { ...io, upgrade: withoutWrite(h.deps) })).not.toBe(0);
    expect(err.join("")).toContain("--deploy-approved takes a bundle id and nothing else");
  });

  describe("the high-water mark (the highest release the environment ever ran)", () => {
    const floors = { floors: [{ release: "1.2.0", floor: "1.1.5", reason: "rewrote every lesson row in a new shape" }], declaredThrough: "1.2.3" };

    it("a second rollback cannot step under a floor the first one passed: the floors apply from the highest release ever run", async () => {
      const h = await rollback({ rollbackFloors: floors, loadRelease: async () => release("1.1.5") });
      await runUpgrade({ ...options, rollbackTo: "1.1.5" }, h.deps);
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.1.5");
      expect(await readReleaseHighWater(h.store, "staging")).toBe("1.2.3");
      // Now on 1.1.5: release 1.2.0 is above the current version, but the environment ran it, so its floor still holds.
      h.deps.loadRelease = async () => release("1.1.0");
      await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("so environment staging, which has run 1.2.3 (it runs 1.1.5 now), rolls back no lower than 1.1.5; 1.1.0 is below that floor");
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.1.5");
      // Without the mark (an install from before it), only the recorded version counts.
      expect(rollbackDirection("staging", "1.1.5", "1.1.0", floors.floors, "1.2.3")).toBe("older");
    });

    it("an upgrade raises the mark to the release it installed; a rollback never lowers it", async () => {
      const h = await harness();
      await runUpgrade(options, h.deps);
      expect(await readReleaseHighWater(h.store, "staging")).toBe("1.3.0");
      const back = await rollback({ loadRelease: async () => release("1.1.0") });
      await raiseReleaseHighWater(back.store, "staging", "1.2.3");
      await runUpgrade({ ...options, rollbackTo: "1.1.0" }, back.deps);
      expect(await readReleaseHighWater(back.store, "staging")).toBe("1.2.3");
      expect(await raiseReleaseHighWater(back.store, "staging", "1.0.0")).toBe("1.2.3");
    });

    it("a mark above the floors this agentx knows refuses, and a mark that is not x.y.z refuses", async () => {
      const h = await rollback();
      await h.store.put(releaseHighWaterParameter("staging"), "1.4.0");
      await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("environment staging has run 1.4.0 (it runs 1.2.3 now), newer than every release this agentx knows (through 1.2.3)");
      await h.store.put(releaseHighWaterParameter("staging"), "latest");
      await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("not a release version (x.y.z)");
      expect(h.deployer.deployed).toEqual([]);
    });

    it("a rollback that cannot record the mark stops before anything deploys; an upgrade that cannot only warns", async () => {
      const denied = (store: MemoryParameterStore) => {
        const put = store.put.bind(store);
        store.put = async (name, value, putOptions) => { if (name === releaseHighWaterParameter("staging")) throw new Error("AccessDeniedException"); return put(name, value, putOptions); };
      };
      const h = await rollback();
      denied(h.store);
      await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("the rollback could not record 1.2.3 as /agentx/staging/release-high-water");
      expect(h.deployer.deployed).toEqual([]);
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
      const up = await harness();
      denied(up.store);
      await runUpgrade(options, up.deps);
      expect(up.lines.join("\n")).toContain("WARNING: /agentx/staging/release-high-water could not be raised to 1.3.0");
      expect((await readEnvironmentSettings(up.store, "staging"))?.version).toBe("1.3.0");
    });
  });

  describe("every stack's parameters are checked against the target's templates before the first deploy", () => {
    it("refuses a template that needs a parameter this agentx no longer sends, deploying nothing", async () => {
      const h = await rollback({}, (part) => everything(part === "control-plane" ? ["CallbackSigningKey"] : []));
      await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("agentx-staging-control-plane: the target's template needs CallbackSigningKey (no default), which this agentx does not send");
      expect(h.deployer.deployed).toEqual([]);
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.2.3");
    });

    it("refuses a parameter the target's template does not declare, deploying nothing", async () => {
      const h = await rollback({}, (part) => (part === "control-plane" ? declaredFromTemplate({ GitHubAppId: {} }) : everything()));
      await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow(/agentx-staging-control-plane: the target's template does not declare [A-Za-z0-9, ]*OidcIssuer/);
      expect(h.deployer.deployed).toEqual([]);
    });

    it("on the cdk engine, a needed parameter the deployed stack holds passes (cdk deploys with the previous values)", async () => {
      const h = await rollback({ sourceRelease: async () => release("1.1.0") }, (part) => everything(part === "control-plane" ? ["BudgetMonthlyUsd", "GitHubAppId"] : []));
      await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
      await runUpgrade({ ...options, source: "/src", rollbackTo: "1.1.0" }, h.deps);
      expect((await readEnvironmentSettings(h.store, "staging"))?.version).toBe("1.1.0");
      expect(parameterProblems({ part: "control-plane", stackName: "s", parameters: {}, declared: declaredFromTemplate({ Held: {}, Gone: {}, WithDefault: { Default: "1" } }), deployed: { Held: "x" }, engine: "cdk" })).toEqual(["s: the target's template needs Gone (no default), which this agentx does not send and the stack does not hold"]);
      expect(parameterProblems({ part: "control-plane", stackName: "s", parameters: {}, declared: declaredFromTemplate({ Held: {} }), deployed: { Held: "x" }, engine: "templates" })).toEqual(["s: the target's template needs Held (no default), which this agentx does not send"]);
      expect(parameterProblems({ part: "control-plane", stackName: "s", parameters: {}, declared: undefined, deployed: undefined, engine: "templates" })).toEqual(["s: the target's template could not be read, so its parameters cannot be checked"]);
      expect(parameterProblems({ part: "control-plane", stackName: "s", parameters: {}, declared: new Set(["A"]), deployed: undefined, engine: "templates" })[0]).toContain("does not say which parameters have no default");
    });

    it("warns that operator values the older template drops come back only as defaults, naming how to re-apply each", async () => {
      const h = await rollback({ controlPlane: { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf", BudgetMonthlyUsd: "250", CallbackSigningKey: "****", SlackThreadTurnsPerMinute: "12" } }, (part) => (part === "control-plane" ? everythingBut(["SlackThreadTurnsPerMinute"]) : everything()));
      await runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps);
      expect(h.lines.join("\n")).toContain("so the rollback drops it");
      expect(h.lines.join("\n")).toContain("WARNING: rolling back drops this value, and rolling forward again does NOT bring it back");
      expect(h.lines).toContain("  agentx --env staging config set limits.threadTurnsPerMinute 12");
    // Not sent: the older template does not declare it.
    expect(h.deployer.requests.find((request) => request.stackName === "agentx-staging-control-plane")?.parameters).not.toHaveProperty("SlackThreadTurnsPerMinute");
    });
  });

  it("a cdk rollback to a release that names no embedder image needs --embedder-image while the Team record is on", async () => {
    const h = await rollback({ sourceRelease: async () => release("1.1.0") });
    await writeEnvironmentSettings(h.store, { ...INSTALLED, engine: "cdk" });
    await writeTeamRecordRecord(h.store, "staging", { enabled: true, options: {} });
    await expect(runUpgrade({ ...options, source: "/src", rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("release 1.1.0 names no embedder image, and staging records the Team record as on");
    expect(h.deployer.deployed).toEqual([]);
  });

  it("says rollback, not upgrade, when doctor fails after it", async () => {
    const h = await rollback({ doctor: async () => ({ ...healthy, failed: 1 }) });
    await expect(runUpgrade({ ...options, rollbackTo: "1.1.0" }, h.deps)).rejects.toThrow("rolled back staging to 1.1.0, but 1 doctor check failed");
  });
});

describe("rollbackDirection (the direction guard)", () => {
  const floors: RollbackFloor[] = [
    { release: "0.6.0", floor: "0.5.20", reason: "moved approvals to a new table" },
    { release: "0.7.0", floor: "0.6.5", reason: "re-keyed lesson rows" },
  ];
  it("allows only an older target above every floor of a release it rolls back past", () => {
    expect(rollbackDirection("staging", "0.7.2", "0.7.0", floors, "0.7.2")).toBe("older");
    expect(rollbackDirection("staging", "0.7.2", "0.6.5", floors, "0.7.2")).toBe("older");
    expect(() => rollbackDirection("staging", "0.7.2", "0.6.4", floors, "0.7.2")).toThrow("release 0.7.0 re-keyed lesson rows, so environment staging, which runs 0.7.2, rolls back no lower than 0.6.5");
    // The highest floor wins when two releases are rolled back past.
    expect(() => rollbackDirection("staging", "0.7.2", "0.5.19", floors, "0.7.2")).toThrow("rolls back no lower than 0.6.5");
    // A floor declared by a release not yet installed does not apply.
    expect(rollbackDirection("staging", "0.6.9", "0.6.0", floors, "0.7.2")).toBe("older");
    expect(() => rollbackDirection("staging", "0.6.9", "0.5.19", floors, "0.7.2")).toThrow("release 0.6.0 moved approvals to a new table");
  });
  it("refuses the same and a newer target, an unversioned install, and an install newer than the declared floors", () => {
    expect(() => rollbackDirection("staging", "0.5.17", "0.5.17", [], "0.5.17")).toThrow("already runs 0.5.17");
    expect(() => rollbackDirection("staging", "0.5.16", "0.5.17", [], "0.5.17")).toThrow("is newer than 0.5.16");
    expect(() => rollbackDirection("staging", "unversioned", "0.5.16", [], "0.5.17")).toThrow("not a release");
    expect(() => rollbackDirection("staging", "0.5.18", "0.5.17", [], "0.5.17")).toThrow("newer than every release this agentx knows (through 0.5.17)");
  });
  it("this source's floors are declared through a release, and no floor is above the release that declares it", () => {
    expect(ROLLBACK_FLOORS_DECLARED_THROUGH).toMatch(/^\d+\.\d+\.\d+$/);
    for (const entry of ROLLBACK_FLOORS) expect(compareVersions(entry.floor, entry.release)).toBeLessThanOrEqual(0);
    // The 0.5.17 rollback (0.5.17 -> 0.5.16) runs with this agentx; 0.5.14 is under 0.5.15's floor (it dropped CallbackSigningKey).
    expect(rollbackDirection("staging", "0.5.17", "0.5.16")).toBe("older");
    expect(() => rollbackDirection("staging", "0.5.17", "0.5.14")).toThrow("release 0.5.15 removed the control plane's CallbackSigningKey parameter");
  });
  it("the release's own check: a release whose x.y.z is not ROLLBACK_FLOORS_DECLARED_THROUGH is not packed", () => {
    expect(() => assertRollbackFloorsDeclaredFor(ROLLBACK_FLOORS_DECLARED_THROUGH)).not.toThrow();
    expect(() => assertRollbackFloorsDeclaredFor(`${ROLLBACK_FLOORS_DECLARED_THROUGH}-rc.1`)).not.toThrow();
    expect(() => assertRollbackFloorsDeclaredFor("9.9.9")).toThrow(`ROLLBACK_FLOORS_DECLARED_THROUGH in packages/cli/src/upgrade/target.ts is ${ROLLBACK_FLOORS_DECLARED_THROUGH}; set it to 9.9.9`);
    expect(() => assertRollbackFloorsDeclaredFor("0.5.16", "0.5.17")).toThrow("set it to 0.5.16");
  });
  it("leaves the plain upgrade direction unchanged: same and newer only", () => {
    expect(upgradeDirection("staging", "0.5.16", "0.5.17")).toBe("newer");
    expect(upgradeDirection("staging", "0.5.17", "0.5.17")).toBe("same");
    expect(() => upgradeDirection("staging", "0.5.17", "0.5.16")).toThrow("never moves an environment back");
  });
});
