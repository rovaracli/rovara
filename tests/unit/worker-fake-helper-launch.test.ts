// Test services, slice 3 (s3-fakes-run): the helper launcher starts the fake server from the worker's own image. The arguments that would reach `docker` are checked, not the code that builds them: the image is the worker's
// (by id), node replaces the entrypoint, the program's arguments are numbers and a digest, the round's fake has exactly one caller (the sandbox the phase serves), the set is a read-only file of the run's directory, and the
// same hardening profile holds. No Docker: a fake daemon that answers the few commands the launcher uses.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ServiceCatalogSchema, type CatalogEntry } from "@rovara-code/contracts";
import { runNetworkAddresses, runNetworkBridge, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName, type ServicesNetwork } from "../../packages/worker/src/run-network.js";
import { HelperStartError, startHelpers, type HelperFiles, type HelperRequest } from "../../packages/worker/src/service-helpers.js";
import { fakeServicesDocker } from "../support/fake-services-docker.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const WS = "0123456789abcdef";
const NOW = 1_800_000_000_000;
const SLOT = 153;
const PROBE_IMAGE = `rovara/worker@sha256:${"b".repeat(64)}`;
const SET_DIGEST = "c".repeat(64);
const MARKER = "tomato-ledger-7391";
const FIXTURE_JSON = JSON.stringify({ schemaVersion: 2, note: MARKER });

const catalog = ServiceCatalogSchema.parse(JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as unknown);
const entryOf = (id: string, change: (entry: CatalogEntry) => void = () => undefined): CatalogEntry => {
  const copy = structuredClone(catalog.entries.find((entry) => entry.id === id)!);
  change(copy);
  return copy;
};

function makeNet(): ServicesNetwork {
  const labels = { runId: RUN, workspace: WS, createdAt: NOW, expiresAt: NOW + 1_500_000 };
  return { name: runNetworkName(RUN), bridge: runNetworkBridge(RUN, SLOT), slot: SLOT, ...runNetworkAddresses(SLOT), helperIp: (index: number) => runNetworkHelperIp(SLOT, index), labelArgs: () => runNetworkLabelArgs(labels), stop: () => Promise.resolve() };
}
function files() {
  const written = new Map<string, { content: string; mode: number }>();
  const helper: HelperFiles = {
    write(name, content, mode) { written.set(name, { content, mode }); return Promise.resolve(`/run/rovara-test/${name}`); },
    remove(name) { written.delete(name); return Promise.resolve(); },
  };
  return { helper, written };
}
const fake = (phase: "working" | "check", over: Partial<NonNullable<HelperRequest["fake"]>> = {}): NonNullable<HelperRequest["fake"]> => ({ phase, digest: SET_DIGEST, fixtureJson: FIXTURE_JSON, ...over });
const request = (phase: "working" | "check", extra: Partial<HelperRequest> = {}): HelperRequest => ({ id: "payments", name: "Payments API", entry: entryOf("fake-server@r1"), aliases: ["fake-payments"], fake: fake(phase), ...extra });
async function launch(helpers: HelperRequest[], mount?: (container: string, to: string, content: string | undefined) => void) {
  const daemon = fakeServicesDocker();
  const f = files();
  const started = await startHelpers(daemon.docker, makeNet(), { registry: "registry.example.test/rovara", edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3_072, helpers, files: f.helper });
  void mount;
  return { daemon, files: f, started };
}
const flag = (args: readonly string[], name: string): string[] => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));
const runOf = (daemon: ReturnType<typeof fakeServicesDocker>): string[] => daemon.calls.find((call) => call[0] === "run" && call.includes("--detach"))!;

describe("the fake server is started from the worker's own image", () => {
  it("uses the worker's image by id with node in place of the entrypoint, and the program's arguments are numbers and a digest", async () => {
    const t = await launch([request("check")]);
    const call = runOf(t.daemon);
    expect(flag(call, "--entrypoint")).toEqual(["/usr/local/bin/node"]);
    const at = call.indexOf(PROBE_IMAGE);
    expect(at).toBeGreaterThan(0);
    expect(call.slice(at)).toEqual([
      PROBE_IMAGE, "/opt/agentx/packages/worker/dist/fake-helper.js", "--listen", "172.30.153.16", "--port", "8080", "--caller", "172.30.153.4",
      "--digest", SET_DIGEST, "--unmatched", "fail", "--fixture", "/rovara/fixture.json", "--ledger", "/tmp/fake-ledger.jsonl",
    ]);
    expect(call.join(" ")).not.toContain("registry.example.test");
    expect(t.started.helpers[0]).toMatchObject({ id: "payments", address: "172.30.153.16", aliases: ["fake-payments"], ports: [8080] });
  });
  it("answers the sandbox of its phase and no other: the coding phase's fake the working sandbox, a round's the check sandbox", async () => {
    const working = runOf((await launch([request("working")])).daemon);
    const round = runOf((await launch([request("check")])).daemon);
    expect(flag(working, "--caller")).toEqual(["172.30.153.3"]);
    expect(flag(round, "--caller")).toEqual(["172.30.153.4"]);
    expect(round.join(" ")).not.toContain("172.30.153.3");
    expect(working.join(" ")).not.toContain("172.30.153.4");
  });
  it("puts the set in a read-only file of the run's directory, mounted into that one helper, and not into an argument or an env file", async () => {
    const daemon = fakeServicesDocker();
    const f = files();
    const writes: Array<{ name: string; mode: number }> = [];
    const spy: HelperFiles = { write: (name, content, mode) => { writes.push({ name, mode }); return f.helper.write(name, content, mode); }, remove: (name) => f.helper.remove(name) };
    await startHelpers(daemon.docker, makeNet(), { registry: "registry.example.test/rovara", edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3_072, helpers: [request("check")], files: spy });
    const call = runOf(daemon);
    const mountIndex = call.findIndex((arg, index) => arg === "-v" && /:\/rovara\/fixture\.json:ro$/u.test(call[index + 1] ?? ""));
    expect(mountIndex).toBeGreaterThan(0);
    expect(call[mountIndex + 1]).toMatch(/^\/run\/rovara-test\/[^:]+\.fixture\.json:\/rovara\/fixture\.json:ro$/u);
    expect(daemon.mounts.find((mount) => mount.to === "/rovara/fixture.json")).toBeDefined();
    expect(writes.find((write) => write.name.endsWith(".fixture.json"))).toMatchObject({ mode: 0o644 });
    // no env file at all (the fake holds no secret), and the content is in no argument
    expect(call).not.toContain("--env-file");
    expect(call.join(" ")).not.toContain(MARKER);
    expect(daemon.calls.map((c) => c.join(" ")).join("\n")).not.toContain(MARKER);
  });
  it("keeps the same hardening profile as every helper: no capability, read-only root, a tmpfs, limits, labels, the run's network and address", async () => {
    const call = runOf((await launch([request("check")])).daemon);
    for (const forbidden of ["--privileged", "--cap-add", "--publish", "-p", "-P", "--net", "--pid", "--ipc", "--device", "--volumes-from", "--add-host", "--env", "-e", "--dns"]) expect(call, forbidden).not.toContain(forbidden);
    expect(flag(call, "--cap-drop")).toEqual(["ALL"]);
    expect(flag(call, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(call).toContain("--read-only");
    expect(call).toContain("--pull=never");
    expect(flag(call, "--user")).toEqual(["1000:1000"]);
    expect(flag(call, "--network")).toEqual([runNetworkName(RUN)]);
    expect(flag(call, "--ip")).toEqual(["172.30.153.16"]);
    expect(flag(call, "--memory")).toEqual(["512m"]);
    expect(flag(call, "--memory-swap")).toEqual(["512m"]);
    expect(flag(call, "--tmpfs")[0]).toMatch(/^\/tmp:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000$/u);
    expect(flag(call, "--label").length).toBeGreaterThan(0);
    expect(call.join(" ")).not.toContain("docker.sock");
  });
  it("is asked its health from a probe on the run's network (tcp on its port), like every helper", async () => {
    const t = await launch([request("check")]);
    const probe = t.daemon.calls.find((call) => call[0] === "run" && call.includes("--rm"))!;
    expect(probe.slice(probe.indexOf(PROBE_IMAGE))).toEqual([PROBE_IMAGE, "/opt/agentx/packages/worker/dist/service-probe.js", "--host", "172.30.153.16", "--port", "8080"]);
  });
});

describe("what the launcher refuses before it starts anything", () => {
  const refused = async (helpers: HelperRequest[]): Promise<string> => {
    const daemon = fakeServicesDocker();
    try {
      await startHelpers(daemon.docker, makeNet(), { registry: "registry.example.test/rovara", edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3_072, helpers, files: files().helper });
      return "started";
    } catch (error) {
      expect(daemon.calls.filter((call) => call[0] === "run")).toEqual([]);
      return error instanceof HelperStartError ? error.message : `other:${String(error)}`;
    }
  };
  it("a fake server without its fake request, and a fake request on any other entry", async () => {
    expect(await refused([{ id: "payments", name: "Payments API", entry: entryOf("fake-server@r1"), aliases: ["fake-payments"] }])).toMatch(/cannot be started here/u);
    const postgres = entryOf("postgres@16", (copy) => { copy.image.digest = "a".repeat(64); });
    expect(await refused([{ id: "db", name: "Postgres", entry: postgres, credentials: { user: "rovara", password: "Zk3Lm9QxTbWHd5Pr", database: "app" }, fake: fake("check") }])).toMatch(/cannot be started here/u);
  });
  it("a set digest that is not a digest, a phase that is neither, and a set of more than 4 MiB", async () => {
    expect(await refused([request("check", { fake: fake("check", { digest: "abc" }) })])).toMatch(/cannot be started here/u);
    expect(await refused([request("check", { fake: fake("check", { digest: `${SET_DIGEST} --privileged` }) })])).toMatch(/cannot be started here/u);
    expect(await refused([request("check", { fake: { ...fake("check"), phase: "both" as never } })])).toMatch(/cannot be started here/u);
    expect(await refused([request("check", { fake: fake("check", { fixtureJson: "x".repeat(4 * 1024 * 1024 + 1) }) })])).toMatch(/cannot be started here/u);
  });
  it("a fake server entry that carries an image digest (it would be started from a registry image the catalog does not pin), and one that is not marked as a worker-image helper", async () => {
    const withDigest = entryOf("fake-server@r1") as unknown as Record<string, unknown>;
    (withDigest["image"] as Record<string, unknown>)["digest"] = "d".repeat(64);
    expect(await refused([request("check", { entry: withDigest as unknown as CatalogEntry })])).toMatch(/cannot be started here/u);
    const unmarked = entryOf("fake-server@r1") as unknown as Record<string, unknown>;
    delete unmarked["workerImage"];
    expect(await refused([request("check", { entry: unmarked as unknown as CatalogEntry })])).toMatch(/cannot be started here/u);
  });
  it("a name that could be read as a docker option, and the other helpers of the catalog (they are started by their own code)", async () => {
    expect(await refused([request("check", { aliases: ["fake --privileged"] })])).toMatch(/cannot be started here/u);
    const dns = entryOf("dns-helper@r1");
    expect(await refused([{ id: "dns", name: "dns", entry: dns, fake: fake("check") }])).toMatch(/cannot be started here/u);
  });
  it("the retired fake server, and an edition that does not offer it", async () => {
    expect(await refused([request("check", { entry: entryOf("fake-server@r1", (copy) => { copy.status = "retired"; }) })])).toMatch(/cannot be started here/u);
    expect(await refused([request("check", { entry: entryOf("fake-server@r1", (copy) => { copy.editions = ["enterprise"]; }) })])).toMatch(/cannot be started here/u);
  });
});
