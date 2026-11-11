// Convergence W0-3 review H1: Rovara Code's default registry login schema also takes a registry on the machine itself (`localhost:<port>`, `127.0.0.1:<port>`) and the user `rovara-local`. Cloud's old schema took
// an ECR host and the user `AWS` only, and a worker that is told to log in to a loopback address would hand the agent's sandbox a registry it can bind. Every place Cloud reads a registry login uses the hosted
// schema. This file covers the premise and the preparation's pull (login.ts and use.ts); the push build (build.ts), the rebuild (rebuild.ts) and the broker's session (saved-env-session.ts) have their loopback cases
// beside their other refusals (worker-saved-env-build, worker-saved-env-rebuild, broker-saved-env-session).
import { describe, expect, it } from "vitest";
import { HostedSavedEnvRegistryAuthSchema, savedEnvRepositoryName } from "@rovara-code/contracts";
import { SavedEnvRegistryAuthSchema } from "@agentx/cloud-contracts";
import { createSavedEnvLoginProvider } from "../../packages/worker/src/saved-env/login.js";
import { savedEnvMaterializer } from "../../packages/worker/src/saved-env/use.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
const PASSWORD = ["login", "-", "p".repeat(30)].join("");
const loopbackLogins = [
  { registry: "127.0.0.1:5000", username: "rovara-local" },
  { registry: "localhost:5001", username: "rovara-local" },
  { registry: "127.0.0.1:5000", username: "AWS" },
].map((over) => ({ ...over, repository: REPOSITORY, password: PASSWORD, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }));

describe("the schemas", () => {
  it("Code's default takes a loopback login and the hosted one refuses every one of them (the premise of the other tests)", () => {
    for (const login of loopbackLogins.slice(0, 2)) {
      expect(SavedEnvRegistryAuthSchema.safeParse(login).success, login.registry).toBe(true);
      expect(HostedSavedEnvRegistryAuthSchema.safeParse(login).success, login.registry).toBe(false);
    }
    expect(HostedSavedEnvRegistryAuthSchema.safeParse(loopbackLogins[2]).success).toBe(false);
  });
});

describe("the worker refuses a loopback login", () => {
  const invocation = { kind: "prepare", workspaceId: "ws-1", operationId: "op-1", payload: { repositoryGrant: "grant-1" } } as never;

  it("when it asks the broker for the pull login (login.ts)", async () => {
    for (const login of loopbackLogins) {
      const provider = createSavedEnvLoginProvider({ controlPlaneUrl: "https://cp.example.test", invocation, fetchImplementation: async () => new Response(JSON.stringify({ login }), { status: 200 }) });
      await expect(provider()).rejects.toThrow("Rovara could not get a login for the saved environment");
    }
  });

  it("when the preparation is about to pull with it (use.ts): it falls back to a fresh clone and runs no Docker command", async () => {
    for (const login of loopbackLogins) {
      const calls: string[] = [];
      const docker: DockerCli = { async run(args) { calls.push([...args].join(" ")); return { exitCode: 0, stdout: "", stderr: "" }; } };
      const fallbacks: string[] = [];
      const cloned: string[] = [];
      const repository = { name: "svc", url: "https://github.com/acme/svc.git", path: "repo/svc", defaultBranch: "main" } as never;
      const materialize = savedEnvMaterializer(
        { ref: { repository: REPOSITORY, digest: `sha256:${"d".repeat(64)}`, testEnvRevision: 4, environmentKey: "a".repeat(64), taskTestEnvRevision: 4 }, login: async () => login as never, docker, onFallback: (step) => fallbacks.push(step) },
        [repository],
        async () => { cloned.push("fresh"); },
      );
      await materialize(repository, "/nonexistent-destination", {});
      expect(fallbacks, login.registry).toEqual(["login"]);
      expect(cloned, login.registry).toEqual(["fresh"]);
      expect(calls, login.registry).toEqual([]);
    }
  });
});
