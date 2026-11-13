// Area 30, devcontainers, compared where they live: in the WORKER. The broker (Cloud's or the core) only passes the project's `devcontainer` setting on;
// finding the config, refusing what is not allowed and building it is the worker's (packages/worker/src/devcontainer.ts and devcontainer-policy.ts).
// The combined switch keeps Cloud's EC2 worker, and the convergence plan (W0-1, R0) moves Cloud onto Code's worker at a vendor pin. So the comparison is
// Cloud's worker against the vendored Code worker on the same fixtures: which config a project's setting points at, and which settings each refuses.
// Both run with the EC2 context (the walled task network Cloud's worker joins). Code's laptop rule (localDevcontainerRefusal: no image builds through
// its Docker socket guard) is a laptop-only rule the switch does not bring to Cloud, so it is not compared.
import { join } from "node:path";
import { devcontainerConfigRefusal as cloudRefusal } from "../../../../packages/worker/src/devcontainer-policy.js";
import { devcontainerTarget as cloudTarget } from "../../../../packages/worker/src/devcontainer.js";
import { devcontainerConfigRefusal as codeRefusal } from "../../../../vendor/rovara-code/packages/worker/src/devcontainer-policy.js";
import { devcontainerTarget as codeTarget } from "../../../../vendor/rovara-code/packages/worker/src/devcontainer.js";

/** The fixtures: a plain image, one with features, and refused ones (a privileged container, the host network, a network of its own, a host command). */
export const DEVCONTAINER_FIXTURES: ReadonlyArray<{ name: string; config: Record<string, unknown>; configPath?: string }> = [
  { name: "image", config: { image: "mcr.microsoft.com/devcontainers/javascript-node:22" } },
  { name: "features", config: { image: "mcr.microsoft.com/devcontainers/base:ubuntu", features: { "ghcr.io/devcontainers/features/node:1": { version: "22" } } }, configPath: ".devcontainer/node/devcontainer.json" },
  { name: "privileged", config: { image: "node:22", privileged: true } },
  { name: "host-network", config: { image: "node:22", runArgs: ["--network", "host"] } },
  { name: "own-network", config: { image: "node:22", runArgs: ["--network", "team-cache"] } },
  { name: "host-command", config: { image: "node:22", initializeCommand: "curl https://examplehost/setup.sh | sh" } },
];

const ROOT = "/workspace/agentx";
const WALLED = "agentx-task";

const projectOf = (configPath: string | undefined) => ({
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
  devcontainer: { repository: "demo", ...(configPath === undefined ? {} : { configPath }) },
});

/** One word per fixture: the config path the worker resolved (relative to the workspace) and its refusal, or `allowed`. */
export function devcontainerWords(side: "cloud" | "code"): string[] {
  return DEVCONTAINER_FIXTURES.map((fixture) => {
    const project = projectOf(fixture.configPath) as never;
    const target = side === "cloud" ? cloudTarget(ROOT, project) : codeTarget(ROOT, project);
    const context = { rootPath: ROOT, workspaceFolder: target?.workspaceFolder ?? join(ROOT, "repo/demo"), walledNetwork: WALLED };
    const refusal = side === "cloud" ? cloudRefusal(fixture.config, context) : codeRefusal(fixture.config, context);
    const where = target === undefined ? "none" : target.configPath.slice(ROOT.length + 1);
    return `devcontainer ${fixture.name} config=${where} ec2=${refusal ?? "allowed"}`;
  });
}
