// Slice 4, lane W1: the docker argument list of a function sandbox and its allow-list re-check, and the agent frame codec. Hostile inputs must never reach an argument as a flag.
import { describe, expect, it, vi } from "vitest";
import { CodecError, lengthPrefixedJsonCodec } from "../../packages/worker/src/function-runner/codec.js";
import {
  controlArgProblems, environmentFileContent, networkInspectArgs, servicesNetworkProblems, inspectIdArgs, killArgs, removeArgs, sandboxArgProblems, sandboxContainerName, functionSandboxRunArgs, SandboxSpecError, validImageReference, type SandboxSpec,
} from "../../packages/worker/src/function-runner/sandbox-spec.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const base = (): SandboxSpec => ({
  environmentId: "11111111-1111-4111-8111-111111111111",
  image: `public.ecr.aws/lambda/python@${DIGEST}`,
  agentHostPath: "/opt/rovara/runner/agent",
  codeHostPath: "/run/rovara/code/abc",
  layersHostPath: "/run/rovara/layers/def",
  environment: { STAGE: "test", _HANDLER: "app.handler" },
  envFile: "/run/rovara/scratch/env/e1.env",
  memoryMb: 512, cpus: 0.5,
  scratch: { kind: "tmpfs", sizeMb: 512 }, tmpExec: true,
  network: { mode: "none" },
  labels: [{ key: "rovara.run", value: "run-1" }],
});

const valueOf = (args: string[], flag: string): string[] => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));

describe("functionSandboxRunArgs", () => {
  it("builds the fixed gVisor profile", () => {
    const args = functionSandboxRunArgs(base());
    expect(args.slice(0, 2)).toEqual(["run", "-i"]);
    expect(valueOf(args, "--runtime")).toEqual(["runsc"]);
    expect(valueOf(args, "--network")).toEqual(["none"]);
    // The agent is root with ONLY CAP_SETUID and CAP_SETGID and starts the runtime as 993 with none (runsc delivers SIGSTOP from a same-uid process to PID 1).
    expect(valueOf(args, "--user")).toEqual(["0:0"]);
    expect(valueOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valueOf(args, "--cap-add").sort()).toEqual(["SETGID", "SETUID"]);
    expect(args.slice(args.indexOf(base().image) + 1)).toEqual(["-uid", "993", "-gid", "993"]);
    expect(valueOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(valueOf(args, "--memory")).toEqual(["512m"]);
    expect(valueOf(args, "--memory-swap")).toEqual(["512m"]);
    expect(valueOf(args, "--pids-limit")).toEqual(["256"]);
    expect(valueOf(args, "--log-driver")).toEqual(["none"]);
    expect(valueOf(args, "--entrypoint")).toEqual(["/rovara/agent"]);
    expect(valueOf(args, "--env-file")).toEqual(["/run/rovara/scratch/env/e1.env"]);
    expect(args).not.toContain("-e");
    expect(args.join(" ")).not.toContain("STAGE");
    expect(valueOf(args, "--tmpfs")).toEqual(["/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m,uid=993,gid=993"]);
    expect(valueOf(args, "--volume")).toEqual(["/run/rovara/code/abc:/var/task:ro", "/run/rovara/layers/def:/opt:ro", "/opt/rovara/runner/agent:/rovara/agent:ro"]);
    expect(args).toContain("--read-only");
    expect(args).toContain("--pull=never");
    for (const forbidden of ["--detach", "-d", "--rm", "--env", "--privileged", "--init", "-v", "--publish", "-p"]) expect(args).not.toContain(forbidden);
    expect(args.at(-5)).toBe(base().image);
    expect(sandboxArgProblems(args, base())).toEqual([]);
    expect(valueOf(args, "--name")).toEqual([sandboxContainerName(base().environmentId)]);
  });

  it("names the container by hash, never by the function", () => {
    expect(sandboxContainerName("11111111-1111-4111-8111-111111111111")).toMatch(/^rovara-fn-[0-9a-f]{16}$/u);
  });

  it("supports a host-dir /tmp, the services network with the run's name files, extra mounts and agent arguments", () => {
    const spec: SandboxSpec = {
      ...base(), scratch: { kind: "host-dir", hostPath: "/run/rovara/scratch/e1" }, tmpExec: false,
      network: { mode: "services", name: "rovara-svc-0123456789ab", ip: "10.20.30.70", hostsFile: "/run/rovara/e1/hosts", resolvConf: "/run/rovara/e1/resolv.conf" },
      extraMounts: [{ hostPath: "/opt/rovara/qemu/qemu-x86_64-static", containerPath: "/rovara/qemu" }],
      agentArgs: ["--emulator=/rovara/qemu", "--", "/var/lang/bin/python3.12", "/var/runtime/bootstrap.py"],
    };
    const args = functionSandboxRunArgs(spec);
    expect(valueOf(args, "--network")).toEqual(["rovara-svc-0123456789ab"]);
    expect(valueOf(args, "--ip")).toEqual(["10.20.30.70"]);
    expect(valueOf(args, "--tmpfs")).toEqual([]);
    expect(valueOf(args, "--volume")).toContain("/run/rovara/scratch/e1:/tmp:rw");
    expect(valueOf(args, "--volume")).toContain("/opt/rovara/qemu/qemu-x86_64-static:/rovara/qemu:ro");
    expect(args.slice(args.indexOf(spec.image) + 1)).toEqual(["-uid", "993", "-gid", "993", ...spec.agentArgs!]);
    expect(sandboxArgProblems(args, spec)).toEqual([]);
    expect(functionSandboxRunArgs({ ...spec, scratch: { kind: "tmpfs", sizeMb: 64 }, tmpExec: false }).join(" ")).toContain("noexec");
  });
});

describe("the allow-list re-check refuses every added or changed flag", () => {
  const good = (): string[] => functionSandboxRunArgs(base());
  const inject = (flags: string[]): string[] => { const args = good(); args.splice(2, 0, ...flags); return args; };
  const cases: Array<[string, string[]]> = [
    ["extra env", inject(["-e", "TOKEN=x"])], ["env swapped for a flag", inject(["-e", "--privileged"])], ["--env long form", inject(["--env", "A=b"])], ["second env file", inject(["--env-file", "/etc/shadow"])],
    ["privileged", inject(["--privileged"])], ["cap-add", inject(["--cap-add", "SYS_ADMIN"])], ["short volume", inject(["-v", "/:/host"])], ["env joined", inject(["-eTOKEN=x"])],
    ["env-file", inject(["--env-file=/etc/shadow"])], ["publish", inject(["-p8080:80"])], ["host network", inject(["--net=host"])], ["pid host", inject(["--pid=host"])], ["device", inject(["--device", "/dev/kvm"])],
    ["mount", inject(["--mount", "type=bind,src=/,dst=/host"])], ["detach", inject(["--detach"])], ["rm", inject(["--rm"])], ["tty", inject(["-t"])], ["extra runtime", inject(["--runtime", "runc"])],
    ["extra user", inject(["--user", "0"])], ["seccomp off", inject(["--security-opt", "seccomp=unconfined"])], ["add-host", inject(["--add-host", "evil:1.2.3.4"])], ["dns", inject(["--dns=1.1.1.1"])],
    ["extra label", inject(["--label", "x=y"])], ["init", inject(["--init"])], ["pull always", inject(["--pull", "always"])], ["sysctl", inject(["--sysctl", "net.ipv4.ip_forward=1"])], ["gpus", inject(["--gpus", "all"])],
    ["volume rw", inject(["--volume", "/etc:/etc:rw"])], ["docker socket", inject(["--volume", "/var/run/docker.sock:/var/run/docker.sock:ro"])], ["oom off", inject(["--oom-kill-disable"])],
    ["unknown flag", inject(["--totally-new-flag"])],
  ];
  for (const [name, args] of cases) it(`refuses: ${name}`, () => expect(sandboxArgProblems(args, base()).length).toBeGreaterThan(0));

  it("refuses a changed value, a missing flag, another image, a different tail", () => {
    const swap = (flag: string, value: string): string[] => { const args = good(); args[args.indexOf(flag) + 1] = value; return args; };
    expect(sandboxArgProblems(swap("--memory", "99999m"), base())).not.toEqual([]);
    expect(sandboxArgProblems(swap("--user", "993:993"), base())).not.toEqual([]);
    expect(sandboxArgProblems(swap("--user", "0"), base())).not.toEqual([]);
    expect(sandboxArgProblems(swap("--network", "host"), base())).not.toEqual([]);
    expect(sandboxArgProblems(swap("--entrypoint", "/bin/sh"), base())).not.toEqual([]);
    expect(sandboxArgProblems(swap("--runtime", "runc"), base())).not.toEqual([]);
    expect(sandboxArgProblems(good().filter((arg) => arg !== "--read-only"), base())).not.toEqual([]);
    expect(sandboxArgProblems(good().filter((arg) => arg !== "-i"), base())).not.toEqual([]);
    expect(sandboxArgProblems([...good().slice(0, -1), "alpine"], base())).not.toEqual([]);
    expect(sandboxArgProblems([...good(), "--privileged"], base())).not.toEqual([]);
    expect(sandboxArgProblems(["exec", ...good().slice(1)], base())).not.toEqual([]);
    // A value-taking flag cannot swallow the next flag: `--name --privileged` leaves the name wrong.
    const swallow = good();
    swallow[swallow.indexOf("--name") + 1] = "--privileged";
    expect(sandboxArgProblems(swallow, base())).not.toEqual([]);
  });

  it("holds exactly CAP_SETUID and CAP_SETGID: no other capability, none missing, none twice", () => {
    const args = good();
    const without = (cap: string): string[] => { const copy = [...args]; const at = copy.findIndex((arg, index) => arg === cap && copy[index - 1] === "--cap-add"); copy.splice(at - 1, 2); return copy; };
    expect(sandboxArgProblems(without("SETUID"), base())).not.toEqual([]);
    expect(sandboxArgProblems(without("SETGID"), base())).not.toEqual([]);
    for (const extra of ["SYS_ADMIN", "NET_RAW", "ALL", "CAP_SETUID", "DAC_OVERRIDE", "SETUID", "CHOWN"]) expect(sandboxArgProblems(inject(["--cap-add", extra]), base()), extra).not.toEqual([]);
    expect(sandboxArgProblems(inject(["--cap-add=SYS_PTRACE"]), base())).not.toEqual([]);
    expect(sandboxArgProblems(args.filter((arg) => arg !== "ALL"), base())).not.toEqual([]);
    const noNnp = [...args];
    noNnp.splice(noNnp.indexOf("no-new-privileges"), 1, "seccomp=unconfined");
    expect(sandboxArgProblems(noNnp, base())).not.toEqual([]);
  });

  it("checks control commands: four fixed shapes on a sandbox name", () => {
    const name = sandboxContainerName(base().environmentId);
    for (const args of [killArgs(name), removeArgs(name), inspectIdArgs(name)]) expect(controlArgProblems(args)).toEqual([]);
    expect(controlArgProblems(["rm", "-f", "--volumes", "somebody-elses-container"])).not.toEqual([]);
    expect(controlArgProblems(["run", "--privileged", name])).not.toEqual([]);
    expect(controlArgProblems(["rm", "--force", "--volumes", "--all", name])).not.toEqual([]);
    expect(() => killArgs("x; rm -rf /")).toThrow(SandboxSpecError);
    expect(() => removeArgs("--all")).toThrow(SandboxSpecError);
  });
});

describe("hostile inputs cannot become flags", () => {
  const throwsSpec = (change: Partial<SandboxSpec>): void => { expect(() => functionSandboxRunArgs({ ...base(), ...change })).toThrow(SandboxSpecError); };

  it("refuses odd image references", () => {
    for (const image of ["--privileged", "-v/:/host", "x --privileged", "img\n--cap-add=ALL", "img\0", "", " ", "a b", "../../etc", "img//x", "IMG:tag@@sha256:" + "a".repeat(64), "img@sha256:short", "img@md5:abc", "a".repeat(300), "img\u202e", "img;rm -rf /", "$(id)", "`id`", "img'x", "img\"x"]) {
      expect(validImageReference(image), JSON.stringify(image)).toBe(false);
      throwsSpec({ image });
    }
    for (const image of ["public.ecr.aws/lambda/python:3.12-arm64", `public.ecr.aws/lambda/python:3.12@${DIGEST}`, DIGEST, "localhost:5000/team/fn:v1", "python"]) expect(validImageReference(image), image).toBe(true);
  });

  it("refuses host paths that split a mount spec or climb out", () => {
    for (const path of ["/a:/b", "/a,b", "/a b", "/a\n/b", "relative/path", "/a/../b", "/a/./b", "/a//b", "", "/", "/x:ro,bind", "/a\0b", "/docker\u202e", `/${"a".repeat(500)}`]) {
      throwsSpec({ codeHostPath: path });
      throwsSpec({ agentHostPath: path });
      throwsSpec({ layersHostPath: path });
      throwsSpec({ scratch: { kind: "host-dir", hostPath: path } });
      throwsSpec({ envFile: path });
    }
  });

  it("refuses extra mounts outside /rovara, onto the agent, repeated, or too many", () => {
    for (const containerPath of ["/etc/passwd", "/rovara/../etc", "/var/run/docker.sock", "/rovara/agent", "/rovara//x", "/rovara/a:b", "relative"]) throwsSpec({ extraMounts: [{ hostPath: "/opt/x", containerPath }] });
    throwsSpec({ extraMounts: [{ hostPath: "/opt/x", containerPath: "/rovara/q" }, { hostPath: "/opt/y", containerPath: "/rovara/q" }] });
    throwsSpec({ extraMounts: Array.from({ length: 9 }, (_v, index) => ({ hostPath: "/opt/x", containerPath: `/rovara/m${String(index)}` })) });
  });

  it("refuses agent arguments that are not plain", () => {
    // The runtime's identity is the spec's, not the caller's: a later -uid would win in the agent's flag parser.
    for (const arg of ["-uid", "-uid=0", "--uid", "--uid=0", "-gid", "--gid=0"]) throwsSpec({ agentArgs: [arg] });
    for (const arg of ["a b", "a\nb", "$(id)", "a;b", "", "-", "--a b", "x".repeat(300), "a\0"]) throwsSpec({ agentArgs: [arg] });
    expect(() => functionSandboxRunArgs({ ...base(), agentArgs: ["--", "/var/lang/bin/python3.12"] })).not.toThrow();
  });

  it("renders the environment as one NAME=VALUE line each, and takes no part of it into the arguments", () => {
    const environment = { FLAG: "--privileged", SOCK: "/var/run/app.pid", BIG: "y".repeat(8_192), EMPTY: "", UNI: "\u202e\u{1F600}", EQ: "a=b=c", ARGS: "-v /:/host --cap-add=ALL" };
    const spec = { ...base(), environment };
    const args = functionSandboxRunArgs(spec);
    expect(environmentFileContent(spec)).toBe(`${Object.keys(environment).sort().map((name) => `${name}=${environment[name as keyof typeof environment]}`).join("\n")}\n`);
    expect(args.filter((arg) => arg.includes("privileged") || arg.includes("cap-add=ALL") || arg.includes("yyyy") || arg.includes("app.pid") || arg.includes("/:/host"))).toEqual([]);
    expect(sandboxArgProblems(args, spec)).toEqual([]);
    // Another env file path is not this spec's.
    expect(sandboxArgProblems(args, { ...spec, envFile: "/run/rovara/scratch/env/other.env" })).not.toEqual([]);
  });

  it("refuses odd variable names and values and too much environment", () => {
    for (const name of ["", "A B", "-x", "A=B", "1A", "A-B", "A\nB", "a".repeat(129), "--privileged", "A\u0000"]) throwsSpec({ environment: { [name]: "v" } });
    for (const value of ["v\0w", "a\nB=c", "a\r", "v".repeat(8_193)]) throwsSpec({ environment: { A: value } });
    throwsSpec({ environment: Object.fromEntries(Array.from({ length: 301 }, (_v, index) => [`K${String(index)}`, "v"])) });
    throwsSpec({ environment: Object.fromEntries(Array.from({ length: 12 }, (_v, index) => [`K${String(index)}`, "v".repeat(8_000)])) });
  });

  it("refuses bad environment ids, labels, networks, sizes", () => {
    for (const environmentId of ["", "--rm", "A".repeat(10), "a b cde", "ab", "a".repeat(80), "x\ny12345"]) throwsSpec({ environmentId });
    for (const label of [{ key: "rovara.function", value: "x" }, { key: "k", value: "v" }, { key: "A.b", value: "v" }, { key: "rovara.run", value: "a=b" }, { key: "rovara.run", value: "x\ny" }, { key: "rovara.run", value: "a,b" }]) throwsSpec({ labels: [label] });
    throwsSpec({ labels: [{ key: "rovara.run", value: "a" }, { key: "rovara.run", value: "b" }] });
    for (const name of ["host", "bridge", "none", "container:abc", "a b", "--x", "", "-n"]) throwsSpec({ network: { mode: "services", name, ip: "10.0.0.2", hostsFile: "/h", resolvConf: "/r" } });
    for (const ip of ["", "10.0.0.256", "::1", "10.0.0.2 --privileged", "evil.example"]) throwsSpec({ network: { mode: "services", name: "rovara-svc-0123456789ab", ip, hostsFile: "/run/h", resolvConf: "/run/r" } });
    for (const memoryMb of [0, -1, 1.5, 10_241, Number.NaN, 5]) throwsSpec({ memoryMb });
    for (const cpus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 17]) throwsSpec({ cpus });
    for (const sizeMb of [0, -1, 1.5, 100_000, Number.NaN]) throwsSpec({ scratch: { kind: "tmpfs", sizeMb } });
  });

  it("never echoes the offending text in the error", () => {
    try {
      functionSandboxRunArgs({ ...base(), image: "--privileged-secret-marker" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-marker");
    }
  });
});

describe("the services network (M2)", () => {
  it("accepts an internal network and an address in .64 to .127 of its subnet", () => {
    for (const ip of ["10.20.30.64", "10.20.30.100", "10.20.30.127"]) expect(servicesNetworkProblems("true 10.20.30.0/24 \n", ip)).toEqual([]);
  });
  it("refuses a network that is not internal, an address outside the subnet, and one outside the sandbox range", () => {
    expect(servicesNetworkProblems("false 10.20.30.0/24 ", "10.20.30.70")).not.toEqual([]);
    expect(servicesNetworkProblems("", "10.20.30.70")).not.toEqual([]);
    expect(servicesNetworkProblems("<no value> 10.20.30.0/24", "10.20.30.70")).not.toEqual([]);
    expect(servicesNetworkProblems("true 10.20.30.0/24 ", "10.20.31.70")).not.toEqual([]);
    expect(servicesNetworkProblems("true 10.20.30.0/24 ", "192.168.1.70")).not.toEqual([]);
    for (const ip of ["10.20.30.1", "10.20.30.2", "10.20.30.63", "10.20.30.128", "10.20.30.255", "10.20.30.0"]) expect(servicesNetworkProblems("true 10.20.30.0/24 ", ip), ip).not.toEqual([]);
    expect(servicesNetworkProblems("true 10.20.30.0/24 ", "10.20.30.70 ")).not.toEqual([]);
    expect(servicesNetworkProblems("true 0.0.0.0/0 ", "10.20.30.70")).not.toEqual([]);
    expect(servicesNetworkProblems("true", "10.20.30.70")).not.toEqual([]);
  });
  it("builds the inspect command only for a plain network name", () => {
    expect(networkInspectArgs("rovara-svc-0123456789ab").slice(0, 2)).toEqual(["network", "inspect"]);
    for (const name of ["host", "bridge", "none", "container:abc", "--all", "a b", ""]) expect(() => networkInspectArgs(name)).toThrow(SandboxSpecError);
  });
});

describe("the agent codec (agent/1, runner/agent/PROTOCOL.md)", () => {
  const frame = (value: unknown): Buffer => { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); };
  const decoder = (max = 16 * 1024 * 1024) => lengthPrefixedJsonCodec.createDecoder({ maxFrameBytes: max });

  it("decodes every agent frame, reassembling frames split across chunks", () => {
    const frames = [
      { type: "hello", proto: "agent/1", agent: "rovara-runner-agent", version: "1", pid: 1, listen: "127.0.0.1:9001", command: ["x"] },
      { type: "ready", initDurationMs: 104.4, logTail: "init\n" },
      { type: "init_error", reason: "exited", errorType: "Runtime.ExitError", errorMessage: "m", payload: "e30=", logTail: "", initDurationMs: 3 },
      { type: "runtime_exit", exitCode: 7, signal: "", message: "x", logTail: "" },
      { type: "result", requestId: "r1", status: "ok", payload: "e30=", logTail: "START\n", logTruncated: false, durationMs: 1.5, billedDurationMs: 2, initDurationMs: 100, maxMemoryUsed: 22_000_000 },
      { type: "result", requestId: "r2", status: "function_error", payload: "e30=", errorType: "ValueError", errorMessage: "bad" },
      { type: "fatal", message: "bad frame" },
    ];
    const bytes = Buffer.concat(frames.map(frame));
    const d = decoder();
    const seen = [];
    for (let at = 0; at < bytes.length; at += 7) seen.push(...d.push(bytes.subarray(at, at + 7)));
    expect(seen.map((f) => f.type)).toEqual(["hello", "ready", "init_error", "runtime_exit", "result", "result", "fatal"]);
    expect(seen[4]).toMatchObject({ requestId: "r1", status: "ok", payload: "e30=", maxMemoryUsed: 22_000_000, billedDurationMs: 2, logTruncated: false });
    expect(seen[1]).toEqual({ type: "ready", initDurationMs: 104.4, logTail: "init\n" });
  });

  it("encodes the worker frames in the agent's field names with a big-endian length", () => {
    const encoded = lengthPrefixedJsonCodec.encode({ type: "invoke", requestId: "r:1", payload: "e30=", timeoutMs: 3000, functionArn: "arn:x", memorySizeMb: 128, logBytes: 4096 });
    expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4);
    expect(JSON.parse(encoded.subarray(4).toString("utf8"))).toEqual({ type: "invoke", requestId: "r:1", payload: "e30=", timeoutMs: 3000, functionArn: "arn:x", memorySizeMb: 128, logBytes: 4096 });
    expect(JSON.parse(lengthPrefixedJsonCodec.encode({ type: "shutdown" }).subarray(4).toString("utf8"))).toEqual({ type: "shutdown" });
    expect(() => lengthPrefixedJsonCodec.encode({ type: "invoke", requestId: "r", payload: "A".repeat(17 * 1024 * 1024), timeoutMs: 1 })).toThrow(RangeError);
  });

  it("treats null fields as absent, and a frame of a type it does not know as a protocol error (H2)", () => {
    expect(decoder().push(frame({ type: "ready", initDurationMs: null }))).toEqual([{ type: "ready" }]);
    expect(() => decoder().push(frame({ type: "future-thing", x: 1 }))).toThrow(CodecError);
    expect(() => decoder().push(frame({ type: "invoke", requestId: "r", payload: "", timeoutMs: 1 }))).toThrow(CodecError);
  });

  it("joins a big frame once, not on every chunk (H2)", () => {
    const body = Buffer.from(JSON.stringify({ type: "result", requestId: "r1", status: "ok", payload: Buffer.alloc(6_000_000, 7).toString("base64") }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const bytes = Buffer.concat([header, body]);
    const spy = vi.spyOn(Buffer, "concat");
    try {
      const d = decoder();
      const seen = [];
      for (let at = 0; at < bytes.length; at += 65_536) seen.push(...d.push(bytes.subarray(at, at + 65_536)));
      expect(seen).toHaveLength(1);
      // Only the single join of the complete frame (the 4-byte header peek copies, it does not concat).
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { spy.mockRestore(); }
  });

  it("decodes many small frames from one chunk without copying the rest each time", () => {
    const many = Buffer.concat(Array.from({ length: 500 }, () => frame({ type: "runtime_exit", exitCode: 1 })));
    const spy = vi.spyOn(Buffer, "concat");
    try {
      expect(decoder().push(many)).toHaveLength(500);
      expect(spy.mock.calls.length).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it("keeps memory proportional to the bytes held when a header is followed by a one-byte trickle", () => {
    const d = decoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(16 * 1024 * 1024);
    d.push(header);
    let most = 0;
    for (let i = 0; i < 300_000; i += 1) { d.push(Buffer.from([65])); most = Math.max(most, d.pending().chunks); }
    expect(d.pending().bytes).toBe(300_004);
    // 300 KB in 4 KiB-and-larger pieces plus a short tail, not 300,000 buffers.
    expect(most).toBeLessThan(300_004 / 4_096 + 80);
    // And the trickle still decodes once complete (a small frame after a trickle of its own).
    const e = decoder();
    const body = Buffer.from(JSON.stringify({ type: "runtime_exit", exitCode: 3 }));
    const h = Buffer.alloc(4);
    h.writeUInt32BE(body.length);
    const all = Buffer.concat([h, body, h, body]);
    const seen = [];
    for (const byte of all) seen.push(...e.push(Buffer.from([byte])));
    expect(seen).toEqual([{ type: "runtime_exit", exitCode: 3 }, { type: "runtime_exit", exitCode: 3 }]);
    expect(e.pending()).toEqual({ bytes: 0, chunks: 0 });
  });

  it("caps and cleans the text of a result, and refuses a payload that is not base64 or is over Lambda's limit (L1)", () => {
    const [clean] = decoder().push(frame({ type: "result", requestId: "r1", status: "function_error", errorType: `Er\u202eror\n${"x".repeat(1_000)}`, errorMessage: `m\u0000${"y".repeat(10_000)}`, logTail: `line1\nline2\t\u001b[31m${"z".repeat(400_000)}`, payload: "e30=" }));
    const result = clean as Extract<typeof clean, { type: "result" }>;
    expect(result.errorType!.length).toBeLessThanOrEqual(256);
    expect(result.errorType).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(result.errorMessage!.length).toBeLessThanOrEqual(4_096);
    expect(result.errorMessage).not.toContain("\u0000");
    expect(result.logTail!.length).toBeLessThanOrEqual(256 * 1024);
    expect(result.logTail).not.toContain("\u001b");
    const lines = decoder().push(frame({ type: "result", requestId: "r1", status: "ok", logTail: "a\nb\tc" }));
    expect((lines[0] as { logTail: string }).logTail).toBe("a\nb\tc");
    for (const payload of ["not base64!", "e30", "====", "e30=\n", Buffer.alloc(6_291_557).toString("base64"), "A".repeat(9_000_000)]) {
      expect(() => decoder().push(frame({ type: "result", requestId: "r1", status: "ok", payload })), payload.slice(0, 12)).toThrow(CodecError);
    }
    expect(decoder().push(frame({ type: "result", requestId: "r1", status: "ok", payload: Buffer.alloc(6_291_556, 1).toString("base64") }))).toHaveLength(1);
    for (const requestId of ["", "a b", "r".repeat(129), "r\n1"]) expect(() => decoder().push(frame({ type: "result", requestId, status: "ok" }))).toThrow(CodecError);
    for (const field of ["durationMs", "billedDurationMs", "maxMemoryUsed"]) for (const bad of [-1, 1e15, "3"]) expect(() => decoder().push(frame({ type: "result", requestId: "r1", status: "ok", [field]: bad }))).toThrow(CodecError);
  });

  it("refuses a hostile length from the header alone, without waiting for the body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffffffff);
    expect(() => decoder().push(header)).toThrow(CodecError);
    header.writeUInt32BE(16 * 1024 * 1024 + 1);
    expect(() => decoder().push(header)).toThrow(CodecError);
    header.writeUInt32BE(2000);
    expect(() => decoder(1024).push(header)).toThrow(CodecError);
    for (const length of [0, 1]) { header.writeUInt32BE(length); expect(() => decoder().push(header)).toThrow(CodecError); }
  });

  it("refuses bad JSON, non-objects, a missing type and wrong field types", () => {
    const raw = Buffer.from("{not json");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(raw.length);
    expect(() => decoder().push(Buffer.concat([header, raw]))).toThrow(CodecError);
    for (const bad of [[], 5, null, {}, { type: 5 }, { type: "hello" }, { type: "result", requestId: 5, status: "ok" }, { type: "result", requestId: "r", status: "weird" }, { type: "result", requestId: "r", status: "ok", payload: 5 }, { type: "result", requestId: "r", status: "ok", durationMs: "3" }, { type: "fatal" }, { type: "ready", initDurationMs: "x" }]) {
      expect(() => decoder().push(frame(bad)), JSON.stringify(bad)).toThrow(CodecError);
    }
  });
});
