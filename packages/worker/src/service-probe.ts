// The health probe's program (test services, TS14; service-helpers.ts): one question to one helper, asked from a container of its own on the run's services network. The worker cannot ask it: the boot firewall drops every
// packet that comes in from an `rvi*` bridge to the host, so a TCP answer would never come back. The probe is the worker's own image with no capability, no writable root and no route out, labelled like the run's helpers so
// the sweep finds it. Its only inputs are its own arguments, which the launcher builds from numbers (an address of the run's slot, a port and a path of the catalog entry). Not run by this build (no Docker).
//
// `--host <ipv4> --port <port>` is a TCP connect. With `--path <path>` it is a plain HTTP GET that must answer 2xx. Exit 0 when the helper answered, 1 when not.
import { request } from "node:http";
import { connect, isIP } from "node:net";

export interface ProbeOptions { host: string; port: number; path?: string; timeoutMs?: number }

const DEFAULT_TIMEOUT_MS = 2_000;

/** True when the helper answered: a TCP connection was made, or (with a path) the GET came back 2xx. Never throws. */
export function probeService(options: ProbeOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (isIP(options.host) !== 4 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return Promise.resolve(false);
  if (options.path !== undefined && !/^\/[A-Za-z0-9._~/-]{0,127}$/u.test(options.path)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => { if (!settled) { settled = true; resolve(value); } };
    if (options.path === undefined) {
      const socket = connect({ host: options.host, port: options.port });
      socket.setTimeout(timeoutMs, () => { socket.destroy(); finish(false); });
      socket.on("connect", () => { socket.destroy(); finish(true); });
      socket.on("error", () => { socket.destroy(); finish(false); });
      return;
    }
    const call = request({ host: options.host, port: options.port, path: options.path, method: "GET", timeout: timeoutMs, headers: { connection: "close" } }, (response) => {
      response.resume();
      finish(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    call.on("timeout", () => { call.destroy(); finish(false); });
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
  const ok = host !== undefined && (await probeService({ host, port, ...(path === undefined ? {} : { path }) }));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("service-probe.js")) void main();
