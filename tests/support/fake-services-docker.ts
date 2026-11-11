// A fake Docker daemon for the test-services orchestrator's tests (worker/src/test-services-run.ts). It keeps the little state the orchestrator reads back: which containers exist and which networks each is on (`docker
// inspect`, `network connect` and `disconnect`), the services networks, and the env files at the moment of each `docker exec` (the run's files are removed as soon as the exec returns, so they are read inside the call).
import { readFileSync } from "node:fs";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

export interface FakeServicesDockerOptions {
  /** The pinned image is already on the host (`image inspect` answers). Default: yes (root pulls at boot; the worker never pulls). False: the image was not pre-pulled. */
  imagePresent?: boolean;
  pullFails?: boolean;
  /** `docker run` of a container whose name ends with this suffix fails (`-dns`, `-check`, or a helper's hash is not known: use `helper`). */
  failRun?: "helper" | "dns" | "check";
  /** `docker network connect` fails (the working sandbox cannot join). */
  failConnect?: boolean;
  /** Rows the listing commands (`ps`, `network ls`) answer, tab separated: id, family, created, workspace, expires. */
  listing?: readonly string[];
  /** The exit code of a `docker exec` (default 0): lets a test fail the command that runs in one container. */
  execExit?: (args: readonly string[]) => number;
  /** Slice 3: what a `docker exec` prints (a fake server's ledger summary). Default: nothing. */
  execStdout?: (args: readonly string[]) => string | undefined;
  /** TS-UX-1 item 9: answer byte-exact `docker exec -i` calls (a seed file's load). Off by default: the sandbox then runs commands as before, so the golden call lists stay as they were. */
  byteExec?: boolean;
  /** The exit code of a byte-exact exec, default 0. */
  execBytesExit?: (args: readonly string[]) => number;
  /** Slice 3: the state `docker inspect --format {{.State.Status}}` answers for a container (default `running`). */
  stateOf?: (container: string) => string;
  /** Company-approved images (switch `pj`): the references (`<registry>/rovara-env/...@sha256:...`) already on the host. A pull with a login adds the reference it pulled. */
  companyPresent?: readonly string[];
  /** A company image pull exits non-zero. */
  companyPullFails?: boolean;
  /** After a company pull, `RepoDigests` names this instead of the reference that was pulled (a registry that served other bytes). */
  companyPullServesOther?: boolean;
  /** The volumes a company image declares (`{{json .Config.Volumes}}`), by reference. Default: none. */
  companyVolumes?: (reference: string) => string[];
}

export interface RecordedExec {
  args: string[];
  /** The content of the `--env-file` at the time of the call, when the call had one. */
  envFile?: string;
}

export function fakeServicesDocker(options: FakeServicesDockerOptions = {}) {
  const calls: string[][] = [];
  const containers = new Map<string, { networks: Set<string>; ips: Map<string, string> }>();
  const networks = new Set<string>();
  const removedNetworks: string[] = [];
  const execs: RecordedExec[] = [];
  const pulls: string[] = [];
  /** Company image pulls: the reference, the config directory's `config.json` read AT THE TIME of the call (it is removed afterwards), and whether the call had `--config`. */
  const companyPulls: Array<{ reference: string; config: string | undefined; configDirectory: string | undefined }> = [];
  const companyPresent = new Set(options.companyPresent ?? []);
  const removedImages: string[] = [];
  const isCompany = (reference: string | undefined): boolean => reference !== undefined && reference.includes("/rovara-env/");
  /** The read-only file mounts of each `docker run`, with the file's content AT THE TIME of the run (the run's files are removed later). */
  const mounts: Array<{ container: string; to: string; content: string | undefined }> = [];
  /** Every byte-exact exec (a seed file's load), with what it was given on stdin. */
  const byteExecs: Array<{ args: string[]; stdin: string }> = [];
  const answer = (exitCode = 0, stdout = "", stderr = ""): Promise<{ exitCode: number; stdout: string; stderr: string }> => Promise.resolve({ exitCode, stdout, stderr });
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      const [verb, second] = args;
      if (verb === "network" && second === "inspect" && args.includes("{{json .Containers}}")) {
        const network = args[args.length - 1]!;
        const members: Record<string, { Name: string; IPv4Address: string }> = {};
        for (const [name, found] of containers) if (found.networks.has(network)) members[`id-${name}`] = { Name: name, IPv4Address: `${found.ips.get(network) ?? "0.0.0.0"}/24` };
        return answer(0, JSON.stringify(members));
      }
      if (verb === "network" && second === "inspect") return answer(0, "bridge {} false");
      if (verb === "network" && second === "create") { networks.add(args[args.length - 1]!); return answer(); }
      if (verb === "network" && second === "rm") { removedNetworks.push(args[2]!); networks.delete(args[2]!); return answer(); }
      if (verb === "network" && second === "connect") {
        if (options.failConnect === true) return answer(1, "", "no");
        const container = args[args.length - 1]!;
        const network = args[args.length - 2]!;
        const found = containers.get(container) ?? { networks: new Set<string>(), ips: new Map<string, string>() };
        found.networks.add(network);
        if (args.includes("--ip")) found.ips.set(network, args[args.indexOf("--ip") + 1]!);
        containers.set(container, found);
        return answer();
      }
      if (verb === "network" && second === "disconnect") {
        containers.get(args[args.length - 1]!)?.networks.delete(args[args.length - 2]!);
        return answer();
      }
      if (verb === "network" && second === "ls") return answer(0, (options.listing ?? []).join("\n"));
      if (verb === "ps") return answer(0, (options.listing ?? []).join("\n"));
      if (verb === "inspect" && args.includes("{{.State.Status}}")) return answer(0, `${options.stateOf?.(args[args.length - 1]!) ?? "running"}\n`);
      if (verb === "inspect") {
        const found = containers.get(args[args.length - 1]!);
        return found === undefined ? answer(1, "", "No such object") : answer(0, JSON.stringify(Object.fromEntries([...found.networks].map((name) => [name, {}]))));
      }
      if (verb === "container" && second === "inspect") return containers.has(args[args.length - 1]!) ? answer(0, "id") : answer(1, "", "No such container");
      if (verb === "image" && second === "inspect" && args.includes("{{json .Config.Volumes}}")) {
        const volumes = isCompany(args[args.length - 1]) ? options.companyVolumes?.(args[args.length - 1]!) : undefined;
        return answer(0, volumes === undefined || volumes.length === 0 ? "null\n" : `${JSON.stringify(Object.fromEntries(volumes.map((path) => [path, {}])))}\n`);
      }
      if (verb === "image" && second === "inspect" && isCompany(args[args.length - 1])) {
        const reference = args[args.length - 1]!;
        if (!companyPresent.has(reference)) return answer(1, "", "No such image");
        return answer(0, args.includes("{{json .RepoDigests}}") ? JSON.stringify(options.companyPullServesOther === true && companyPulls.length > 0 ? [`${reference.split("@")[0]!}@sha256:${"9".repeat(64)}`] : [reference]) : "id");
      }
      if (verb === "image" && second === "inspect") return answer(options.imagePresent === false ? 1 : 0);
      if (verb === "image" && second === "rm") { removedImages.push(args[args.length - 1]!); companyPresent.delete(args[args.length - 1]!); return answer(); }
      if (verb === "--config" && args[2] === "pull") {
        let config: string | undefined;
        try { config = readFileSync(`${args[1]!}/config.json`, "utf8"); } catch { config = undefined; }
        companyPulls.push({ reference: args[3]!, config, configDirectory: args[1] });
        if (options.companyPullFails === true) return answer(1, "", "denied");
        companyPresent.add(args[3]!);
        return answer();
      }
      if (verb === "pull") { pulls.push(args[1]!); return answer(options.pullFails === true ? 1 : 0); }
      if (verb === "run" && args.includes("--detach")) {
        const name = args[args.indexOf("--name") + 1]!;
        const network = args[args.indexOf("--network") + 1]!;
        const kind = name.endsWith("-dns") ? "dns" : name.endsWith("-check") ? "check" : /-h[0-9a-f]{10}$/u.test(name) ? "helper" : "other";
        for (const [index, arg] of args.entries()) {
          const mount = arg === "-v" ? /^(\/[^:]+):([^:]+):ro$/u.exec(args[index + 1] ?? "") : null;
          if (mount !== null && mount[1] !== undefined && mount[2] !== undefined) {
            let content: string | undefined;
            try { content = readFileSync(mount[1], "utf8"); } catch { content = undefined; }
            mounts.push({ container: name, to: mount[2], content });
          }
        }
        if (options.failRun === kind) return answer(1, "", "boom");
        containers.set(name, { networks: new Set([network]), ips: new Map(args.includes("--ip") ? [[network, args[args.indexOf("--ip") + 1]!]] : []) });
        return answer(0, `${name}-id`);
      }
      if (verb === "run" && args.includes("--rm")) return answer();
      if (verb === "rm") {
        for (const name of args.slice(1).filter((arg) => !arg.startsWith("-"))) containers.delete(name);
        return answer();
      }
      if (verb === "exec") {
        const file = args.indexOf("--env-file");
        const recorded: RecordedExec = { args: [...args] };
        if (file >= 0) {
          try { recorded.envFile = readFileSync(args[file + 1]!, "utf8"); } catch { /* the file is already gone */ }
        }
        execs.push(recorded);
        return answer(options.execExit?.(args) ?? 0, options.execStdout?.(args) ?? "");
      }
      return answer();
    },
  };
  if (options.byteExec === true) {
    docker.execBytes = (args, execOptions) => {
      calls.push([...args]);
      byteExecs.push({ args: [...args], stdin: execOptions.stdin?.toString("utf8") ?? "" });
      return Promise.resolve({ exitCode: options.execBytesExit?.(args) ?? 0, stdout: Buffer.alloc(0), stderr: "" });
    };
  }
  /** Every container and service network still there, by name (the working sandbox included). */
  const left = (): { containers: string[]; networks: string[] } => ({ containers: [...containers.keys()], networks: [...networks] });
  return { docker, calls, containers, networks, removedNetworks, execs, byteExecs, pulls, companyPulls, companyPresent, removedImages, mounts, left, verbs: (verb: string) => calls.filter((call) => call[0] === verb) };
}
