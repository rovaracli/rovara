// agentx github oauth set (Plan 2, Task 12): the App's OAuth client id and client secret, stored in the App secret on a Rovara Cloud install.
import { describe, expect, it } from "vitest";
import type { EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { runGithubOauthSet, type GithubOauthServices } from "../../packages/cli/src/github/oauth.js";
import { githubAppSecretName } from "../../packages/cli/src/init/github-app.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { fakeGitHubApi, memoryInitSecrets, scriptedPrompter, T0, TEST_PRIVATE_KEY, type ScriptedAnswer } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const SECRET_ID = githubAppSecretName("staging");
const CLIENT_ID = "Iv23liCLIENTidValue";
const CLIENT_SECRET = "github-oauth-client-secret-".padEnd(40, "c");
const WEBHOOK_SECRET = "github-made-webhook-secret-".padEnd(40, "g");
const CALLBACK = "https://abc.execute-api.us-east-1.amazonaws.com/v1/github/install/callback";
const STORED = { appId: "424242", slug: "agentx-acme-staging", account: "acme", privateKey: TEST_PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET };
const cloud: EnvironmentSettings = { ...stagingSettings, cloud: true };

async function harness(options: { settings?: EnvironmentSettings | null; stored?: string | null; script?: ScriptedAnswer[]; stdin?: string; ownerType?: string } = {}) {
  const store = new MemoryParameterStore();
  if (options.settings !== null) await writeEnvironmentSettings(store, options.settings ?? cloud);
  const secrets = memoryInitSecrets(options.stored === null ? {} : { [SECRET_ID]: options.stored ?? JSON.stringify(STORED) });
  const prompter = scriptedPrompter(options.script ?? [CLIENT_SECRET]);
  const lines: string[] = [];
  const events: string[] = [];
  const put = secrets.put.bind(secrets);
  secrets.put = async (name, value) => { events.push("store"); await put(name, value); };
  const ask = prompter.secret.bind(prompter);
  prompter.secret = async (question, secretOptions) => { events.push("prompt"); return ask(question, secretOptions); };
  const services: GithubOauthServices = {
    store, secrets, github: fakeGitHubApi({ ...(options.ownerType === undefined ? {} : { ownerType: options.ownerType }) }),
    prompter, processEnv: {}, now: () => T0,
    write: (line) => { lines.push(line); events.push("write"); },
    readStdin: async () => options.stdin ?? "",
  };
  return { services, store, secrets, prompter, lines, events };
}

const CHECKLIST = (url: string) => [
  `In the GitHub App settings (${url}):`,
  "1. Make it public (Advanced, Make public).",
  `2. Set the Callback URL to ${CALLBACK}.`,
  "3. Tick Request user authorization (OAuth) during installation, and Redirect on update.",
  "4. Under Permissions, Organization permissions, set Members to Read-only.",
  "5. Generate a client secret, and paste it here.",
];

describe("agentx github oauth set", () => {
  it("merges the client id and secret into the stored App secret, keeping the key and the webhook secret", async () => {
    const h = await harness();
    await runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID });
    expect(JSON.parse(h.secrets.values.get(SECRET_ID)!)).toEqual({ ...STORED, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(h.prompter.asked).toEqual(["GitHub App client secret"]);
  });

  it("prints the five-line checklist before it asks for the secret, and never the secret", async () => {
    const h = await harness();
    await runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID });
    expect(h.lines).toEqual(CHECKLIST("https://github.com/organizations/acme/settings/apps/agentx-acme-staging"));
    expect(h.events.indexOf("prompt")).toBeGreaterThan(h.events.lastIndexOf("write"));
    expect(h.events.indexOf("store")).toBeGreaterThan(h.events.indexOf("prompt"));
    expect(h.lines.join("\n")).not.toContain(CLIENT_SECRET);
  });

  it("points a personal account's App at its own settings page", async () => {
    const h = await harness({ ownerType: "User" });
    await runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID });
    expect(h.lines[0]).toBe("In the GitHub App settings (https://github.com/settings/apps/agentx-acme-staging):");
  });

  it("replaces an earlier client id and secret", async () => {
    const h = await harness({ stored: JSON.stringify({ ...STORED, clientId: "Iv1.old", clientSecret: "old-secret", futureKey: { nested: true } }) });
    await runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID });
    expect(JSON.parse(h.secrets.values.get(SECRET_ID)!) as unknown).toEqual({ ...STORED, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, futureKey: { nested: true } });
  });

  it("reads the client secret from stdin with --client-secret-stdin, asking nothing", async () => {
    const h = await harness({ script: [], stdin: `${CLIENT_SECRET}\n` });
    await runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID, clientSecretStdin: true });
    expect(JSON.parse(h.secrets.values.get(SECRET_ID)!)).toMatchObject({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(h.prompter.asked).toEqual([]);
  });

  it("refuses an install that is not Rovara Cloud, changing nothing and asking nothing", async () => {
    const h = await harness({ settings: stagingSettings, script: [] });
    const failure = await runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "CONFIG_INVALID" });
    expect((failure as Error).message).toContain("only a Rovara Cloud install connects GitHub per organization");
    expect(JSON.parse(h.secrets.values.get(SECRET_ID)!)).toEqual(STORED);
    expect(h.lines).toEqual([]);
    expect(h.prompter.asked).toEqual([]);
  });

  it("refuses an environment that is not installed", async () => {
    const h = await harness({ settings: null, script: [] });
    await expect(runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID })).rejects.toThrow("environment staging is not installed");
  });

  it("refuses when the App has not been created yet, and when the stored secret is not an App secret, without echoing it", async () => {
    await expect(runGithubOauthSet((await harness({ stored: null, script: [] })).services, "staging", { clientId: CLIENT_ID })).rejects.toThrow(`secret ${SECRET_ID} does not exist`);
    const bad = await harness({ stored: "not-json-private-text", script: [] });
    const failure = await runGithubOauthSet(bad.services, "staging", { clientId: CLIENT_ID }).catch((error: unknown) => error);
    expect(String(failure)).toContain(SECRET_ID);
    expect(String(failure)).not.toContain("private-text");
  });

  it("refuses an empty or malformed client id", async () => {
    for (const clientId of ["", "  ", "has space", "x".repeat(101)]) {
      const h = await harness({ script: [] });
      await expect(runGithubOauthSet(h.services, "staging", { clientId })).rejects.toThrow("--client-id");
      expect(JSON.parse(h.secrets.values.get(SECRET_ID)!)).toEqual(STORED);
    }
  });

  it("refuses an empty client secret", async () => {
    const h = await harness({ script: ["   "] });
    await expect(runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID })).rejects.toThrow();
    expect(JSON.parse(h.secrets.values.get(SECRET_ID)!)).toEqual(STORED);
  });

  it("does not echo a failed write of the App secret", async () => {
    const h = await harness();
    let written = "";
    h.secrets.put = async (_name, value) => { written = value; throw Object.assign(new Error(`access denied for ${value}`), { name: "AccessDeniedException" }); };
    const failure = await runGithubOauthSet(h.services, "staging", { clientId: CLIENT_ID }).catch((error: unknown) => error);
    expect(written).toContain(CLIENT_SECRET);
    expect(String(failure)).toContain(`could not store the client secret in ${SECRET_ID} (AccessDeniedException)`);
    expect(String(failure)).not.toContain(CLIENT_SECRET);
    expect(String(failure)).not.toContain("PRIVATE KEY");
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it("is a command: agentx github oauth set --client-id ... --client-secret-stdin", async () => {
    const h = await harness({ script: [], stdin: CLIENT_SECRET });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await executeCli(["--env", "staging", "github", "oauth", "set", "--client-id", CLIENT_ID, "--client-secret-stdin"], {
      stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) }, githubOauth: h.services,
    });
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(h.secrets.values.get(SECRET_ID)!)).toMatchObject({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(stdout.join("")).not.toContain(CLIENT_SECRET);
    expect(stdout.join("")).toContain("GitHub App client id and secret saved");
  });

  it("exits nonzero on a private install", async () => {
    const h = await harness({ settings: stagingSettings, script: [] });
    const stderr: string[] = [];
    const code = await executeCli(["--env", "staging", "github", "oauth", "set", "--client-id", CLIENT_ID], {
      stdout: { write: () => true }, stderr: { write: (text: string) => stderr.push(text) }, githubOauth: h.services,
    });
    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("only a Rovara Cloud install connects GitHub per organization");
  });
});
