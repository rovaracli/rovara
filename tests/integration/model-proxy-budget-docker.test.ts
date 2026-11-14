// The guard's task-budget holds (rovara_guard.py section 4) against the REAL pinned LiteLLM: two replicas sharing one Postgres, the guard written
// next to the config and loaded as a callback exactly as the stack's start command does, and a fake model upstream (no provider key). Checks:
// every route settles to its cost (equal to LiteLLM's own key spend); an upstream 500 is not retried under the held call id; a cut stream is charged its whole hold; an error answer is released; 8 parallel calls over both replicas on a
// budget that fits 2 give 2 x 200 and 6 x 429 budget_held (no overshoot); 429 and 422 bodies keep their error type on all three routes; an orphan
// becomes spent. Runs only where Docker answers and the pinned image is already present (it never pulls), so CI skips it; run it after a LiteLLM bump.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { LITELLM_SOURCE_IMAGE } from "../../infra/lib/bundle-images.js";
import { ROVARA_GUARD_ENV, ROVARA_GUARD_PACKED, litellmConfig, litellmStartCommand } from "../../packages/model-proxy/src/index.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/model-proxy-budget/${name}`, import.meta.url), "utf8");
const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const usable = spawnSync("docker", ["image", "inspect", LITELLM_SOURCE_IMAGE], { stdio: "ignore" }).status === 0
  && spawnSync("docker", ["image", "inspect", "postgres:16"], { stdio: "ignore" }).status === 0
  && spawnSync("python3", ["-I", "-c", "pass"]).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function healthy(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/health/liveliness`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${url} did not become healthy`);
}

describe.skipIf(!usable)("model proxy task budget against the pinned LiteLLM (docker)", () => {
  it("holds, settles and refuses as the guard says, across two replicas", async () => {
    const run = `rovara-budget-${randomBytes(4).toString("hex")}`;
    const network = `${run}-net`;
    const postgres = `${run}-pg`;
    const master = `sk-${randomBytes(24).toString("hex")}`;
    // The stack's own settings (callbacks, cache ttl, LiteLLM's reservation off) after the fake models.
    const settings = litellmConfig({ region: "us-west-2", models: [{ id: "unused" }] }).split("litellm_settings:")[1]!;
    const config = `${fixture("models.yaml")}litellm_settings:${settings}`;
    const ports = [await freePort(), await freePort()];
    try {
      docker(["network", "create", network]);
      docker(["run", "-d", "--name", postgres, "--network", network, "-e", "POSTGRES_USER=litellm", "-e", `POSTGRES_PASSWORD=${randomBytes(12).toString("hex")}`,
        "-e", "POSTGRES_DB=litellm", "postgres:16"]);
      const password = docker(["exec", postgres, "printenv", "POSTGRES_PASSWORD"]);
      docker(["run", "-d", "--name", `${run}-upstream`, "--network", network, "--network-alias", "upstream", "-e", `UP_PY=${fixture("upstream.py")}`,
        "--entrypoint", "sh", LITELLM_SOURCE_IMAGE, "-c", 'printf "%s" "$UP_PY" > /tmp/up.py && exec python /tmp/up.py 9000']);
      ports.forEach((port, index) => {
        docker(["run", "-d", "--name", `${run}-proxy${String(index)}`, "--network", network, "-p", `127.0.0.1:${String(port)}:4000`,
          "-e", `LITELLM_MASTER_KEY=${master}`, "-e", `DATABASE_URL=postgresql://litellm:${password}@${postgres}:5432/litellm`, "-e", `LITELLM_SALT_KEY=${randomBytes(16).toString("hex")}`,
          "-e", "STORE_MODEL_IN_DB=True", "-e", "REQUEST_TIMEOUT=900", "-e", "LITELLM_LOCAL_MODEL_COST_MAP=True",
          "-e", `LITELLM_CONFIG_YAML=${config}`, "-e", `${ROVARA_GUARD_ENV}=${ROVARA_GUARD_PACKED}`,
          "--entrypoint", "sh", LITELLM_SOURCE_IMAGE, "-c",
          litellmStartCommand(4000)]);
      });
      const deadline = Date.now() + 240_000;
      for (const port of ports) await healthy(`http://127.0.0.1:${String(port)}`, deadline);
      const result = spawnSync("python3", ["-I", "-", ...ports.map((port) => `http://127.0.0.1:${String(port)}`), postgres], {
        input: fixture("budget_check.py"), encoding: "utf8", env: { ...process.env, SPIKE_MASTER_KEY: master }, timeout: 240_000,
      });
      const lines = result.stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { check?: string; ok?: boolean; failed?: string[] });
      expect(lines.filter((line) => line.check !== undefined && line.ok !== true), result.stdout + result.stderr).toEqual([]);
      expect(lines.filter((line) => line.check !== undefined).map((line) => line.check)).toEqual([
        "routes_settle_to_cost", "charged_matches_litellm_spend", "upstream_error_not_retried_under_hold", "cut_streams_charged_in_full", "estimated_charge_stamped_in_key_metadata", "error_answer_released", "parallel_no_overshoot", "held_429_every_route", "spent_422_every_route", "max_tokens_hint_every_route", "orphan_becomes_spent", "overrun_orphan_charged_worst_case",
      ]);
      expect(result.status).toBe(0);
    } finally {
      const names = spawnSync("docker", ["ps", "-aq", "--filter", `name=${run}-`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
      if (names.length > 0) spawnSync("docker", ["rm", "-f", "-v", ...names], { stdio: "ignore" });
      spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    }
  }, 600_000);
});
