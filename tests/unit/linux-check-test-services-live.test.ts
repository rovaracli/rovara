// Test services slice 1, T4: the live Linux checks' driver (scripts/linux-check-test-services-live.ts), run against fakes. Nothing here starts Docker. The probe program is run for real against a local server.
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ITEMS, LISTEN_JS, PROBE_JS, SSM_CHUNK_CHARS, TSL_WORKSPACE, formatLine, hasDefaultRoute, labelArgsFrom, parseProbeOutput, postgresEntry, pullList, runLiveChecks, ssmCommands, unexpected,
  type RunLayer,
} from "../../scripts/linux-check-test-services-live.js";
import { digestOfId, pinnedCatalog, unpinnedCatalog } from "../support/catalog-pinning.js";

const REGISTRY = "944937319445.dkr.ecr.us-west-2.amazonaws.com";
const IMAGE = `${REGISTRY}/agentx-staging/worker@sha256:${"a".repeat(64)}`;

describe("the live driver's lines and probe output", () => {
  it("formats a line the way the shell script counts it, on one line, with the removed values gone", () => {
    expect(formatLine({ id: "L1.live", status: "PASS", name: "x", detail: "ok" })).toBe("TSL L1.live PASS x | ok");
    const line = formatLine({ id: "L4.live", status: "FAIL", name: "y", detail: `bad\nsecret=hunter2hunter2 and ${"z".repeat(500)}` }, (text) => text.split("hunter2hunter2").join("[removed]"));
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("\n");
    expect(line.split(" | ")[1]!.length).toBeLessThanOrEqual(400);
  });
  it("parses probe lines by label, ignores noise and keeps the first of a repeated label", () => {
    const results = parseProbeOutput("a open\nb timeout\nc error:ECONNRESET\nd resolved 172.30.5.16\nnoise here\ne answer rcode=3 an=0\na refused\nroutes routes v4=\n");
    expect(results.get("a")).toEqual({ status: "open", rest: "" });
    expect(results.get("d")).toEqual({ status: "resolved", rest: "172.30.5.16" });
    expect(results.get("c")?.status).toBe("error:ECONNRESET");
    expect(results.has("noise")).toBe(false);
  });
  it("judges: a missing line is a problem, and so is a status that is not allowed", () => {
    const results = parseProbeOutput("a timeout\nb open\n");
    expect(unexpected(results, ["a"], ["timeout"])).toEqual([]);
    expect(unexpected(results, ["a", "b", "c"], ["timeout"])).toEqual(["b=open", "c=no-result"]);
  });
  it("finds a default route in the kernel's table (destination 00000000) and not a /24 alone", () => {
    expect(hasDefaultRoute("v4=eth0:0000FEAC:00000000:0001 v6routes=0")).toBe(false);
    expect(hasDefaultRoute("v4=eth0:00000000:0100FEAC:0003,eth0:0000FEAC:00000000:0001 v6routes=0")).toBe(true);
    expect(hasDefaultRoute("v4= v6routes=0")).toBe(false);
  });
  it("copies only the run-network labels of a container, and only plain values", () => {
    const labels = JSON.stringify({ "rovara.run-network": "rovara-svc-0123456789ab", "rovara.run-network.expires": "17", "rovara.run-network.workspace": TSL_WORKSPACE, "other": "x", "rovara.run-network.evil": "a b;rm", "com.docker": "1" });
    expect(labelArgsFrom(labels)).toEqual(["--label", "rovara.run-network=rovara-svc-0123456789ab", "--label", "rovara.run-network.expires=17", "--label", `rovara.run-network.workspace=${TSL_WORKSPACE}`]);
    expect(labelArgsFrom("not json")).toEqual([]);
    expect(labelArgsFrom("[]")).toEqual([]);
  });
});

describe("the probe program, run for real against a local server", () => {
  let server: Server;
  const run = async (tests: unknown[]) => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((done) => closed.close(() => done()));
    const config = JSON.stringify({ tests: (tests as Array<Record<string, unknown>>).map((test) => ({ ...test, port: test["label"] === "closed" ? closedPort : test["port"] ?? port })) });
    const ran = await new Promise<string>((resolve) => {
      const child = spawnSync(process.execPath, ["-e", PROBE_JS, config], { encoding: "utf8", timeout: 20_000 });
      resolve(child.stdout);
    });
    await new Promise<void>((done) => server.close(() => done()));
    return parseProbeOutput(ran);
  };
  it("says open for a server that accepts, refused for a closed port, and reads and refuses writes to files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsl-probe-"));
    try {
      const results = await run([
        { label: "open", kind: "conn", host: "127.0.0.1", ms: 3000 }, { label: "closed", kind: "conn", host: "127.0.0.1", ms: 3000 },
        { label: "file", kind: "file", path: "/etc/hosts" }, { label: "gone", kind: "file", path: join(dir, "missing") }, { label: "denied", kind: "write", path: join(dir, "no/such/dir/file") },
        { label: "addrs", kind: "addrs" }, { label: "routes", kind: "routes" }, { label: "look", kind: "lookup", name: "localhost" },
      ]);
      expect(results.get("open")?.status).toBe("open");
      expect(results.get("closed")?.status).toBe("refused");
      expect(results.get("file")?.status).toBe("file");
      expect(results.get("gone")?.status).toMatch(/^error:/u);
      expect(results.get("denied")?.status).toBe("denied");
      expect(results.get("addrs")?.status).toBe("addrs");
      expect(results.get("routes")?.status).toBe("routes");
      expect(results.get("look")?.status).toBe("resolved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);
  it("has a listener program that reports silence when nothing is sent", () => {
    const ran = spawnSync(process.execPath, ["-e", LISTEN_JS, JSON.stringify({ port: 45353, groups: [], ms: 300 })], { encoding: "utf8", timeout: 10_000 });
    expect(ran.stdout.trim()).toBe("silent");
  });
});

describe("the catalog the checks need", () => {
  it("refuses a catalog that is unpinned, or pins everything but Postgres 16", () => {
    expect(() => postgresEntry(unpinnedCatalog())).toThrow(/not pinned/u);
    const without = pinnedCatalog((entries) => { const entry = entries.find((candidate) => candidate["id"] === "postgres@16")!; delete (entry["image"] as { digest?: string }).digest; delete entry["sbomRef"]; delete entry["scan"]; });
    expect(() => postgresEntry(without)).toThrow(/not pinned/u);
  });
  it("lists the one image to pull, by digest, from the environment's catalog repository, and never by tag", () => {
    const list = pullList({ catalog: pinnedCatalog(), registry: REGISTRY, env: "staging" });
    expect(list).toEqual([`${REGISTRY}/rovara-catalog/staging/svc/postgres@sha256:${digestOfId("postgres@16")}`]);
    expect(list.every((reference) => /@sha256:[a-f0-9]{64}$/u.test(reference))).toBe(true);
  });
});

describe("the whole run, with a launcher that fails", () => {
  const fakeLayer = (events: string[]): RunLayer => ({
    helpers: { sweepServicesNetworksAtWorkerStart: async () => { events.push("sweep"); return { containers: 0, networks: 0 }; } },
    env: {
      createRunDirectoryFiles: async (_parent: string, name: string) => ({ directory: `/nowhere/${name}`, write: async () => "/x", remove: async () => undefined }),
      removeRunDirectory: async (directory: string) => { events.push(`remove ${directory}`); },
    },
    reset: { createResetHooks: () => ({}) },
    runner: {
      createDockerServiceRunner: () => ({
        start: (input: { helpers: ReadonlyArray<{ credentials?: { password?: string } }> }) => Promise.reject(new Error(`could not start; env had ${input.helpers[0]?.credentials?.password ?? "?"}`)),
      }),
    },
    runNetwork: {}, check: {}, containers: { createDockerCli: () => ({ run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }) },
  } as unknown as RunLayer);

  it("gives FAIL for every item of a check that cannot run, never a PASS, keeps the password out of every line, and cleans up and sweeps after each item", async () => {
    const events: string[] = [];
    const { lines, redact } = await runLiveChecks({ catalog: pinnedCatalog(), registry: REGISTRY, env: "staging", workerImage: IMAGE, workDir: await mkdtemp(join(tmpdir(), "tsl-run-")), layer: fakeLayer(events) });
    expect(lines.map((line) => line.id)).toEqual([
      "L1.live", "L1.live-other-run", "L2.live", "L3.live", "L3.embedded-resolver", "L3.working-relay", "L3.ipv6", "L3.no-route", "L3.other-run", "L3.multicast", "L3.run-files", "L3.spoofing", "L4.live", "L4.template-db", "L6.live",
    ]);
    expect(lines.every((line) => line.status === "FAIL")).toBe(true);
    const printed = lines.map((line) => formatLine(line, redact)).join("\n");
    expect(printed).toContain("the check could not run");
    expect(printed).not.toMatch(/env had [A-Za-z0-9]{24}/u);
    expect(printed).toContain("[removed]");
    // one sweep before the first item and one after each of the five items
    expect(events.filter((event) => event === "sweep")).toHaveLength(1 + ITEMS.length);
    expect(events.filter((event) => event.startsWith("remove ")).length).toBeGreaterThan(0);
  });
  it("refuses to run at all on a catalog that does not pin Postgres 16", async () => {
    await expect(runLiveChecks({ catalog: unpinnedCatalog(), registry: REGISTRY, env: "staging", workerImage: IMAGE, workDir: "/tmp", layer: fakeLayer([]) })).rejects.toThrow(/not pinned/u);
  });
});

describe("delivery through SSM", () => {
  it("sends each file gzipped in short base64 pieces and runs the script with TSL_DIR, in a root-only directory it removes", () => {
    const files = { script: "#!/bin/bash\necho script\n".repeat(2000), driver: "export const x = 1;\n".repeat(3000), catalog: JSON.stringify({ a: 1 }) };
    const commands = ssmCommands(files);
    expect(commands[0]).toContain("umask 077");
    expect(commands.every((command) => command.length < SSM_CHUNK_CHARS + 200)).toBe(true);
    expect(commands.at(-1)).toBe('TSL_DIR="$d" bash "$d/s.sh"; rc=$?; rm -rf "$d"; exit $rc');
    for (const [name, text] of Object.entries({ "s.sh": files.script, "live.mjs": files.driver, "catalog.json": files.catalog })) {
      const encoded = commands.filter((command) => command.includes(`>> "$d/${name}.b64"`)).map((command) => /printf '%s' '([^']*)'/u.exec(command)![1]!).join("");
      expect(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")).toBe(text);
    }
  });
});

describe("the driver file", () => {
  it("makes no AWS call and reads no secret store", async () => {
    const source = await readFile(new URL("../../scripts/linux-check-test-services-live.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/secretsmanager|get-secret-value|@aws-sdk|aws ecr|process\.env\[?"?(?:AWS_|OPENAI|ANTHROPIC)/u);
  });
});
