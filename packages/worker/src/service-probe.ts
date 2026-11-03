// The health probe's program (test services, TS14; service-helpers.ts): one question to one helper, asked from a container of its own on the run's services network. The worker cannot ask it: the boot firewall drops every
// packet that comes in from an `rvi*` bridge to the host, so a TCP answer would never come back. The probe is the worker's own image with no capability, no writable root and no route out, labelled like the run's helpers so
// the sweep finds it. Its only inputs are its own arguments, which the launcher builds from numbers (an address of the run's slot, a port and a path of the catalog entry). Not run by this build (no Docker).
//
// `--host <ipv4> --port <port>` is a TCP connect. With `--path <path>` it is a plain HTTP GET that must answer 2xx. With `--post` (and a path) it is a control call: a POST with the token from the environment (`ROVARA_CONTROL_TOKEN`) in a header, for a helper's reset (service-reset.ts). Exit 0 when the helper answered, 1 when not. The whole question has one hard wall-clock limit (default 2 s): a helper that trickles bytes cannot keep the probe alive.
import { request } from "node:http";
import { connect, isIP } from "node:net";

export interface ProbeOptions {
  host: string;
  port: number;
  path?: string;
  timeoutMs?: number;
  /** A control call: POST (no body) with this token in the `x-rovara-control-token` header, which must answer 2xx. Needs a path. The token is plain letters and digits, 8 to 64. */
  post?: { token: string };
}

const DEFAULT_TIMEOUT_MS = 2_000;

/** True when the helper answered: a TCP connection was made, or (with a path) the GET came back 2xx. Never throws. */
export function probeService(options: ProbeOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (isIP(options.host) !== 4 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return Promise.resolve(false);
  if (options.path !== undefined && !/^\/[A-Za-z0-9._~/-]{0,127}$/u.test(options.path)) return Promise.resolve(false);
  if (options.post !== undefined && (options.path === undefined || !/^[A-Za-z0-9]{8,64}$/u.test(options.post.token))) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let destroy: () => void = () => undefined;
    // A hard wall-clock limit for the whole question. The socket's own timeouts restart whenever a byte arrives, so a helper that trickles headers (or a byte at a time) would keep the probe, and the container it runs in, alive for ever.
    const hard = setTimeout(() => { destroy(); finish(false); }, timeoutMs);
    function finish(value: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      destroy();
      resolve(value);
    }
    if (options.path === undefined) {
      const socket = connect({ host: options.host, port: options.port });
      destroy = () => socket.destroy();
      socket.on("connect", () => finish(true));
      socket.on("error", () => finish(false));
      return;
    }
    const call = request({ host: options.host, port: options.port, path: options.path, method: options.post === undefined ? "GET" : "POST", headers: options.post === undefined ? { connection: "close" } : { connection: "close", "content-length": "0", "x-rovara-control-token": options.post.token } }, (response) => {
      response.resume();
      finish(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    destroy = () => call.destroy();
    call.on("error", () => finish(false));
    call.end();
  });
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export async function main(): Promise<void> {
  const host = argument("host");
  const port = Number(argument("port"));
  const path = argument("path");
  // A control call: the token comes from the environment (an env file the launcher mounted), never from an argument.
  const post = process.argv.includes("--post") ? { token: process.env["ROVARA_CONTROL_TOKEN"] ?? "" } : undefined;
  const ok = host !== undefined && (await probeService({ host, port, ...(path === undefined ? {} : { path }), ...(post === undefined ? {} : { post }) }));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("service-probe.js")) void main();
