import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import { webApiAppStartGuardArgs } from "../../packages/verifier/src/host/web-api-probe-plan.js";
import { e2eRunNetworks } from "../../packages/verifier/src/host/docker-application-host.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/web-api-probe-runner.js";
import { ensureLocalImage } from "../support/ci-images.js";
import { APP_NODE_IMAGE, createLinuxHost, linuxRunInput, removeProbeDirs, runProbe } from "../support/linux-runtime.js";
import { runIsolatedE2EApplication } from "../../packages/verifier/src/application-runtime.js";
import { assertFirewallInstalled, docker, listenOnAllAddresses, reachScript, runNodeIn, runProgram, startRoutedPrivateServer, sudo } from "../support/linux-network-walls.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces, tmpdir } from "node:os";
import { TASK_SANDBOX_BRIDGE, TASK_SANDBOX_NETWORK, ensureTaskNetwork } from "../../packages/worker/src/task-network.js";
import { createDockerCli } from "../../packages/worker/src/swebench/containers.js";

// Real Docker, with the container firewall the CI `linux-runtime` job installs from packages/worker/ec2/boot.sh (the very heredoc the EC2 boot runs).
// Each wall is shown against a control: the same connection from a container that is not behind the wall succeeds, so a timeout is the firewall, not a broken test.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("network walls around untrusted containers", () => {
  let host: { port: number; server: Server };
  const networks: string[] = [];
  beforeAll(async () => {
    await assertFirewallInstalled();
    // The CI job already pulled the build image from the GHCR mirror; only a machine without it pulls (with a bounded retry), and the digest is checked either way.
    await ensureLocalImage(APP_NODE_IMAGE, WEB_API_BUILD_IMAGE);
    host = await listenOnAllAddresses();
  }, 300_000);
  afterAll(async () => {
    host?.server.close();
    for (const name of networks.splice(0)) await docker("network", "rm", name);
    await removeProbeDirs();
  }, 120_000);

  const buildStep = (script: string) => [{ program: "node", args: ["-e", script], cwd: ".", timeoutMs: 120_000, env: {} }];
  async function buildWith(script: string) {
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1", recipeBuild: buildStep(script) });
    const { host: dockerHost } = await createLinuxHost(fixture);
    const run = await runIsolatedE2EApplication({ input: linuxRunInput(fixture) as never, compiled: fixture.compiled, ports: dockerHost, signal: AbortSignal.timeout(280_000) });
    const label = `label=rovara.run=${fixture.plan.runId}`;
    return { fixture, run, log: dockerHost.readDiagnostics(fixture.plan.runId).buildLogTail,
      leftovers: { containers: (await docker("ps", "-a", "--filter", label, "--format", "{{.Names}}")).stdout.trim(), networks: (await docker("network", "ls", "--filter", label, "--format", "{{.Name}}")).stdout.trim() } };
  }

  it("the build container cannot reach a server the host listens on, though a container on the default bridge can", async () => {
    const script = reachScript([["gateway", host.port]]);
    const control = await runNodeIn("bridge", script);
    expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
    const built = await buildWith(script);
    expect(built.run.unavailableReason, built.log).toBe("build-failed");
    expect(built.log).toMatch(/\["timeout"\]/);
    expect(built.log).toMatch(/exit code 7/);
    expect(built.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("the build container cannot reach a private address that is routed beyond the host, though a container on the default bridge can", async () => {
    const routed = await startRoutedPrivateServer(host.port);
    try {
      const script = reachScript([[routed.address, host.port]]);
      const control = await runNodeIn("bridge", script);
      expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
      const built = await buildWith(script);
      expect(built.run.unavailableReason, built.log).toBe("build-failed");
      expect(built.log).toMatch(/\["timeout"\]/);
      expect(built.log).toMatch(/exit code 7/);
    } finally { await routed.stop(); }
  }, 300_000);

  it("the build container still resolves names and fetches the package registry over the internet", async () => {
    const fetchRegistry = "fetch('https://registry.npmjs.org/').then(r=>{console.log('registry status '+r.status);process.exit(r.status===200?0:1)},e=>{console.log('registry error '+String(e.cause&&e.cause.code||e));process.exit(1)})";
    const built = await buildWith(fetchRegistry);
    // A build that succeeds goes on to run the app and the executor, so the CSV positive passing also shows app and executor still talk on the internal network.
    expect(built.run.unavailableReason, built.log).toBeNull();
    expect(built.log).toContain("registry status 200");
    expect(built.leftovers).toEqual({ containers: "", networks: "" });
  }, 300_000);

  it("the app container cannot reach a server the host listens on, though a container on an ordinary internal network can", async () => {
    // A bridge the firewall does not know by name is the control: same kind of network, same address, no wall.
    const control = `rovara-wall-control-${Date.now()}`;
    networks.push(control);
    expect((await docker("network", "create", "--internal", control)).code).toBe(0);
    const open = await runNodeIn(control, reachScript([["bridge", host.port]]));
    expect(open.stdout.trim(), `control: ${open.stderr}`).toBe('["open"]');
    // The production guard, pointed at this test's port: the app starts only if the connection times out.
    const guard = webApiAppStartGuardArgs().map((arg) => arg.replace("port:8080", `port:${host.port}`));
    expect(guard.join(" ")).toContain(`port:${host.port}`);
    const r = await runProbe("api-state-positive-v1", { defect: null, appArgs: guard });
    expect(r.run.unavailableReason, JSON.stringify(r.host.readDiagnostics(r.fixture.plan.runId))).toBeNull();
    expect(r.exitCode).toBe(0);
    // Direct proof from the run's own bridge name too: it is an rvi bridge, so the wall applies by name.
    expect(e2eRunNetworks(r.fixture.plan.runId).internalBridge).toMatch(/^rvi[0-9a-f]{8}$/);
  }, 300_000);

  it("an internal network's containers reach each other, and not the containers of another internal network", async () => {
    const ids = [`${Date.now()}a`, `${Date.now()}b`].map((value) => ({ value, ...e2eRunNetworks(`wall-${value}`) }));
    for (const net of ids) {
      networks.push(net.internal);
      const created = await docker("network", "create", "--internal", "-o", `com.docker.network.bridge.name=${net.internalBridge}`, net.internal);
      expect(created.code, created.stderr).toBe(0);
    }
    const [first, second] = ids as [typeof ids[number], typeof ids[number]];
    const serve = "require('net').createServer(s=>{s.on('error',()=>{});s.end('app\\n')}).listen(4317,'0.0.0.0')";
    const started = await docker("run", "-d", "--rm", "--pull=never", "--name", `rovara-wall-server-${first.value}`, "--network", first.internal, "--cap-drop=ALL", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", serve);
    expect(started.code, started.stderr).toBe(0);
    try {
      const address = (await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${first.internal}").IPAddress}}`, `rovara-wall-server-${first.value}`)).stdout.trim();
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const same = await runNodeIn(first.internal, reachScript([[address, 4317]]));
      expect(same.stdout.trim(), same.stderr).toBe('["open"]');
      const across = await runNodeIn(second.internal, reachScript([[address, 4317]]));
      // Internal bridges have no route to another bridge's subnet, so this fails at once (ENETUNREACH) or by DROP (timeout); either way it never connects.
      expect(across.stdout.trim()).not.toContain("open");
      expect(across.code).not.toBe(0);
    } finally { await docker("rm", "-f", `rovara-wall-server-${first.value}`); }
  }, 300_000);
  // TASK-BRIDGE-UNWALLED (0.5.15): the task sandbox network used to be a plain `docker network create`, whose bridge Docker names br-<hex>; no rule matched it, so a task's commands could reach VPC addresses and the host's
  // ports. It is now created by the worker's own code (ensureTaskNetwork) with the fixed `rvbtask` interface, and dev containers join it through the worker's docker wrapper.
  describe("the task sandbox network (agentx-task)", () => {
    let taskNetworkWasMade = false;
    beforeAll(async () => {
      // Whatever an earlier run left under this name is replaced by the real thing, exactly as the worker does.
      await ensureTaskNetwork(createDockerCli());
      taskNetworkWasMade = true;
    }, 120_000);
    afterAll(async () => { if (taskNetworkWasMade) await docker("network", "rm", TASK_SANDBOX_NETWORK); }, 60_000);

    it("is created with the rvbtask host interface, which the firewall's rvb+ rules match", async () => {
      const inspected = await docker("network", "inspect", "-f", '{{index .Options "com.docker.network.bridge.name"}}', TASK_SANDBOX_NETWORK);
      expect(inspected.stdout.trim()).toBe(TASK_SANDBOX_BRIDGE);
      expect(existsSync(`/sys/class/net/${TASK_SANDBOX_BRIDGE}`)).toBe(true);
      const icc = await docker("network", "inspect", "-f", '{{index .Options "com.docker.network.bridge.enable_icc"}}', TASK_SANDBOX_NETWORK);
      expect(icc.stdout.trim()).toBe("false");
    });

    it("keeps one task's container from connecting to another's on the shared bridge (inter-container traffic is off), though two containers on an ordinary network connect", async () => {
      const serve = "require('net').createServer(s=>{s.on('error',()=>{});s.end('neighbour\\n')}).listen(4317,'0.0.0.0')";
      const control = `rovara-wall-icc-control-${Date.now()}`;
      networks.push(control);
      expect((await docker("network", "create", control)).code).toBe(0);
      const servers: string[] = [];
      try {
        for (const network of [control, TASK_SANDBOX_NETWORK]) {
          const name = `rovara-wall-icc-${network === control ? "control" : "task"}-${Date.now()}`;
          servers.push(name);
          const started = await docker("run", "-d", "--rm", "--pull=never", "--name", name, "--network", network, "--cap-drop=ALL", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", serve);
          expect(started.code, started.stderr).toBe(0);
          const address = (await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name)).stdout.trim();
          expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
          const reached = await runNodeIn(network, reachScript([[address, 4317]]));
          if (network === control) expect(reached.stdout.trim(), `control: ${reached.stderr}`).toBe('["open"]');
          else {
            expect(reached.stdout.trim(), reached.stderr).toBe('["timeout"]');
            expect(reached.code).toBe(7);
          }
        }
      } finally { for (const name of servers) await docker("rm", "-f", name); }
    }, 180_000);

    it("cannot reach a server the host listens on (its gateway address), though a container on the default bridge can", async () => {
      const script = reachScript([["gateway", host.port]]);
      const control = await runNodeIn("bridge", script);
      expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
      const walled = await runNodeIn(TASK_SANDBOX_NETWORK, script);
      expect(walled.stdout.trim(), walled.stderr).toBe('["timeout"]');
      expect(walled.code).toBe(7);
    }, 120_000);

    it("cannot reach a private (10.x) address routed beyond the host, though a container on the default bridge can", async () => {
      const routed = await startRoutedPrivateServer(host.port);
      try {
        const script = reachScript([[routed.address, host.port]]);
        const control = await runNodeIn("bridge", script);
        expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
        const walled = await runNodeIn(TASK_SANDBOX_NETWORK, script);
        expect(walled.stdout.trim(), walled.stderr).toBe('["timeout"]');
        expect(walled.code).toBe(7);
      } finally { await routed.stop(); }
    }, 120_000);

    it("cannot reach a port the host publishes for a container (the worker's :8080 is published like this), though a container on an ordinary network can", async () => {
      const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
      expect(address, "a non-loopback IPv4 address of this host").toBeDefined();
      const name = `rovara-wall-published-${Date.now()}`;
      const serve = "require('net').createServer(s=>{s.on('error',()=>{});s.end('published\\n')}).listen(8080,'0.0.0.0')";
      const started = await docker("run", "-d", "--rm", "--pull=never", "--name", name, "-p", "0:8080", "--cap-drop=ALL", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e", serve);
      expect(started.code, started.stderr).toBe(0);
      const control = `rovara-wall-control-pub-${Date.now()}`;
      networks.push(control);
      try {
        const published = Number((await docker("port", name, "8080/tcp")).stdout.trim().split("\n")[0]?.split(":").pop());
        expect(published).toBeGreaterThan(0);
        const script = reachScript([[address!, published]]);
        expect((await docker("network", "create", control)).code).toBe(0);
        const open = await runNodeIn(control, script);
        expect(open.stdout.trim(), `control: ${open.stderr}`).toBe('["open"]');
        const walled = await runNodeIn(TASK_SANDBOX_NETWORK, script);
        expect(walled.stdout.trim(), walled.stderr).toBe('["timeout"]');
        expect(walled.code).toBe(7);
      } finally { await docker("rm", "-f", name); }
    }, 120_000);

    it("cannot reach a link-local address the host itself holds, though a container on the default bridge can (the control for the probe), nor the instance metadata or link-local resolver addresses", async () => {
      const local = "169.254.77.1";
      expect((await sudo("ip", "addr", "add", `${local}/32`, "dev", "lo")).code).toBe(0);
      try {
        const script = reachScript([[local, host.port]]);
        const control = await runNodeIn("bridge", script);
        expect(control.stdout.trim(), `control: ${control.stderr}`).toBe('["open"]');
        const walled = await runNodeIn(TASK_SANDBOX_NETWORK, script);
        expect(walled.stdout.trim(), walled.stderr).toBe('["timeout"]');
      } finally { await sudo("ip", "addr", "del", `${local}/32`, "dev", "lo"); }
      // The metadata address cannot be held by a runner, so there is no control for it: its drop is asserted as a rule (assertFirewallInstalled) and, from here, as a connection that never opens.
      const metadata = await runNodeIn(TASK_SANDBOX_NETWORK, reachScript([["169.254.169.254", 80], ["169.254.169.253", 53]]));
      expect(metadata.stdout, metadata.stderr).not.toContain("open");
      expect(metadata.code).not.toBe(0);
    }, 120_000);

    it("still resolves names and fetches the package registry over the internet", async () => {
      const fetchRegistry = "fetch('https://registry.npmjs.org/').then(r=>{console.log('registry status '+r.status);process.exit(r.status===200?0:1)},e=>{console.log('registry error '+String(e.cause&&e.cause.code||e));process.exit(1)})";
      const walled = await runNodeIn(TASK_SANDBOX_NETWORK, fetchRegistry);
      expect(walled.stdout, walled.stderr).toContain("registry status 200");
      expect(walled.code).toBe(0);
    }, 120_000);

    it("is the network a container started through the dev container wrapper joins, with the same walls", async () => {
      const wrapper = new URL("../../packages/worker/ec2/docker-walled.sh", import.meta.url).pathname;
      const hardened = ["--rm", "--pull=never", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", APP_NODE_IMAGE, "node", "-e"];
      const gateway = await runProgram(wrapper, "run", ...hardened, reachScript([["gateway", host.port]]));
      expect(gateway.stdout.trim(), gateway.stderr).toBe('["timeout"]');
      const registry = await runProgram(wrapper, "run", ...hardened, "fetch('https://registry.npmjs.org/').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))");
      expect(registry.code, registry.stderr).toBe(0);
      const joined = await runProgram(wrapper, "run", "-d", "--name", "rovara-wall-wrapper-check", "--pull=never", APP_NODE_IMAGE, "sleep", "30");
      try {
        expect(joined.code, joined.stderr).toBe(0);
        expect((await docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", "rovara-wall-wrapper-check")).stdout.trim()).toBe(TASK_SANDBOX_NETWORK);
        expect((await docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", "rovara-wall-wrapper-check")).stdout.trim()).toMatch(/^\{"agentx-task":/u);
        expect((await docker("inspect", "-f", "{{json .HostConfig.CapDrop}}", "rovara-wall-wrapper-check")).stdout).toMatch(/NET_RAW/u);
      } finally { await docker("rm", "-f", "rovara-wall-wrapper-check"); }
    }, 180_000);

    // The Dockerfile's RUN steps and a feature's install scripts run in build containers, which were on docker0 (VPC addresses, the host's ports, the worker's own container) until the wrapper put them on the network.
    describe("a dev container build, through the wrapper", () => {
      const wrapper = new URL("../../packages/worker/ec2/docker-walled.sh", import.meta.url).pathname;
      const tags: string[] = [];
      afterAll(async () => { for (const tag of tags.splice(0)) await docker("rmi", "-f", tag); }, 60_000);

      /** A build whose single RUN step runs `probe` (a node script) and passes only when it exits `expected`. `command` is the docker program and its leading arguments. */
      async function build(command: string[], probe: string, expected: number) {
        const directory = await mkdtemp(join(tmpdir(), "rovara-wall-build-"));
        const tag = `rovara-wall-build:${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        tags.push(tag);
        await writeFile(join(directory, "probe.js"), probe);
        await writeFile(join(directory, "Dockerfile"), `FROM ${APP_NODE_IMAGE}\nCOPY probe.js /probe.js\nRUN node /probe.js; code=$?; echo "probe exit $code"; test "$code" -eq ${String(expected)}\n`);
        try {
          const [program, ...leading] = command as [string, ...string[]];
          return await runProgram(program, ...leading, "-t", tag, "--no-cache", directory);
        } finally { await rm(directory, { recursive: true, force: true }); }
      }

      it("cannot reach the host's gateway port or a private address routed beyond the host from a RUN step, though the same build on the default network can", async () => {
        const routed = await startRoutedPrivateServer(host.port);
        try {
          const probe = reachScript([["gateway", host.port], [routed.address, host.port]]);
          // The control: the classic builder on its default network (docker0), where both are open (the probe exits 9 when any target connects).
          const control = await build(["env", "DOCKER_BUILDKIT=0", "docker", "build"], probe, 9);
          expect(control.code, `control: ${control.stdout}${control.stderr}`).toBe(0);
          // Through the wrapper: both time out (exit 7), so the RUN step passes only if the build container is walled.
          const walled = await build([wrapper, "build"], probe, 7);
          expect(walled.code, `${walled.stdout}${walled.stderr}`).toBe(0);
        } finally { await routed.stop(); }
      }, 300_000);

      it("still fetches the package registry from a RUN step", async () => {
        const fetched = await build([wrapper, "build"], "fetch('https://registry.npmjs.org/').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))", 0);
        expect(fetched.code, `${fetched.stdout}${fetched.stderr}`).toBe(0);
      }, 300_000);

      it("is refused for buildx, which would build on docker0", async () => {
        const refused = await runProgram(wrapper, "buildx", "build", ".");
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("not available on this worker");
      });
    });
  });
});
