// tests/contract/config-set-no-terminal-confirm.test.ts
// 2026-11-11 staging: `echo n | agentx config set setupRecipes.enabled 1` printed the change set and APPLIED it,
// because a stdin that is not a terminal chose the --yes prompter, whose confirm answers yes. Without --yes a
// confirmation is never answered yes on its own: a terminal is asked, a pipe is read ("y" or "yes" applies),
// and anything else, an empty line or a closed stdin declines. --preview shows the change set and never applies.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runConfigSet, type ConfigServices } from "../../packages/cli/src/config/commands.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { noTerminalPrompter } from "../../packages/cli/src/setup/command-context.js";
import { stdinConfirmPrompter, unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { configServicesFor, stacks } from "../support/config-services.js";

const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
const CONTROL_PLANE = { SlackThreadTurnsPerMinute: "6", BudgetMonthlyUsd: "100", SetupRecipesEnabled: "0", CallbackSigningKey: "****" };
const NEEDED = "this change needs confirmation: run it in a terminal, or pass --yes";

/** A stdin that is a pipe: `text` is what was piped (nothing for a closed, empty stdin), then the end of input. */
function pipe(text?: string): PassThrough & { isTTY?: boolean } {
  const stream: PassThrough & { isTTY?: boolean } = new PassThrough();
  if (text !== undefined) stream.write(text);
  stream.end();
  return stream;
}

async function session(stdin: PassThrough & { isTTY?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "agentx-config-confirm-"));
  const deploymentFile = join(directory, "deployment.yaml");
  await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
  const cloudFormation = fakeCloudFormation({ parameters: { ...CONTROL_PLANE } });
  const config: Partial<ConfigServices> = await configServicesFor({ cloudFormation, stacks: stacks({ "agentx-staging-control-plane": CONTROL_PLANE }) });
  // The prompter is the command's own (stdin); the services' scripted one and its line log are not passed on.
  delete config.prompter;
  delete (config as { lines?: string[] }).lines;
  let stdout = "";
  let stderr = "";
  const io = {
    tokenStore: new InMemoryTokenStore(),
    stdin,
    config: { ...config, write: (line: string) => { stderr += `${line}\n`; } },
    stdout: { write: (text: string) => { stdout += text; return true; } },
    stderr: { write: (text: string) => { stderr += text; return true; } },
  };
  const run = (...args: string[]) => executeCli(["--env", "staging", "--deployment-file", deploymentFile, "--allow-loopback", "config", "set", "setupRecipes.enabled", "1", ...args], io);
  const executed = () => cloudFormation.calls.filter((call) => call.name === "ExecuteChangeSetCommand").length;
  const created = () => cloudFormation.calls.filter((call) => call.name === "CreateChangeSetCommand").length;
  const deleted = () => cloudFormation.calls.filter((call) => call.name === "DeleteChangeSetCommand").length;
  return { run, executed, created, deleted, stdout: () => stdout, stderr: () => stderr, parameters: cloudFormation.parameters };
}

describe("agentx config set without a terminal and without --yes", () => {
  it("a piped n declines: the change set is shown and deleted, never executed", async () => {
    const s = await session(pipe("n\n"));
    expect(await s.run()).not.toBe(0);
    expect(s.stderr()).toContain("SetupRecipesEnabled 0 -> 1");
    expect(s.stderr()).toContain("was not applied; nothing changed");
    expect(s.created()).toBe(1);
    expect(s.deleted()).toBe(1);
    expect(s.executed()).toBe(0);
    expect(s.parameters.SetupRecipesEnabled).toBe("0");
  });

  it("a piped y applies, and so does yes", async () => {
    for (const answer of ["y\n", "YES\n"]) {
      const s = await session(pipe(answer));
      expect(await s.run()).toBe(0);
      expect(s.executed()).toBe(1);
      expect(s.parameters.SetupRecipesEnabled).toBe("1");
      expect(s.stdout()).toBe("setupRecipes.enabled changed.\n");
    }
  });

  it("an answer that is neither y nor yes declines, whatever it looks like", async () => {
    for (const answer of ["\n", "maybe\n", "yy\n", "y please\n", " \n"]) {
      const s = await session(pipe(answer));
      expect(await s.run()).not.toBe(0);
      expect(s.executed()).toBe(0);
    }
  });

  it("an empty or closed stdin declines and says what is needed", async () => {
    for (const text of [undefined, ""]) {
      const s = await session(pipe(text));
      expect(await s.run()).not.toBe(0);
      expect(s.stderr()).toContain(NEEDED);
      expect(s.created()).toBe(1);
      expect(s.deleted()).toBe(1);
      expect(s.executed()).toBe(0);
    }
  });

  it("--yes applies without reading stdin", async () => {
    const stdin = pipe("n\n");
    const s = await session(stdin);
    expect(await s.run("--yes")).toBe(0);
    expect(s.executed()).toBe(1);
    expect(s.parameters.SetupRecipesEnabled).toBe("1");
  });

  it("--preview prints the change set and never applies, with or without --yes and whatever is piped", async () => {
    for (const args of [["--preview"], ["--preview", "--yes"]]) {
      for (const text of ["y\n", "n\n", undefined]) {
        const s = await session(pipe(text));
        expect(await s.run(...args)).toBe(0);
        expect(s.stderr()).toContain("setupRecipes.enabled: SetupRecipesEnabled 0 -> 1 on agentx-staging-control-plane");
        expect(s.stdout()).toBe("Preview only; nothing was applied.\n");
        expect(s.created()).toBe(1);
        expect(s.deleted()).toBe(1);
        expect(s.executed()).toBe(0);
        expect(s.parameters.SetupRecipesEnabled).toBe("0");
        expect(s.stderr()).not.toContain("[y/N]");
      }
    }
  });

  it("--preview is refused for a setting that has no change set, before anything is touched", async () => {
    for (const [key, value] of [["alerts.address", "ops@example.com"], ["limits.workspacesPerMember", "2"], ["teamRecord.enabled", "1"]] as const) {
      const cloudFormation = fakeCloudFormation({ parameters: { ...CONTROL_PLANE } });
      const services = await configServicesFor({ cloudFormation });
      await expect(runConfigSet(services, "staging", { key, value, yes: true, preview: true })).rejects.toThrow("--preview shows a stack update's change set");
      expect(cloudFormation.calls).toEqual([]);
    }
  });
});

describe("the prompters", () => {
  it("--yes is the only prompter whose confirm answers yes on its own", async () => {
    expect(await unattendedPrompter().confirm("Apply?", { defaultValue: false })).toBe(true);
    for (const make of [() => stdinConfirmPrompter(pipe(), { write: () => undefined }), () => noTerminalPrompter(pipe(), { write: () => undefined })]) {
      expect(await make().confirm("Apply?", { defaultValue: true })).toBe(false);
    }
  });

  it("one pipe answers two confirmations in turn, and the second declines when the pipe has ended", async () => {
    const written: string[] = [];
    const prompter = noTerminalPrompter(pipe("y\nn\n"), { write: (text) => { written.push(text); } });
    expect(await prompter.confirm("First?", { defaultValue: false })).toBe(true);
    expect(await prompter.confirm("Second?", { defaultValue: true })).toBe(false);
    expect(await prompter.confirm("Third?", { defaultValue: true })).toBe(false);
    expect(written.join("")).toContain(NEEDED);
  });

  it("the no-terminal prompter still never guesses a choice among several", async () => {
    const prompter = noTerminalPrompter(pipe("y\n"), { write: () => undefined });
    await expect(prompter.choose("Which?", [{ value: "a", label: "a" }, { value: "b", label: "b" }], { flag: "--which", defaultValue: "a" })).rejects.toThrow("--which");
  });
});
