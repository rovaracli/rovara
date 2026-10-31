// Service mocks (E8): the HTTP server a mocked service is served by, in the sandbox. The app is pointed at it with `AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME` (or the service's own address variable), so the customer's
// code is not changed. It answers from a recorded fixture set pinned by digest and nothing else:
//   - a request with a recording gets the recorded answer;
//   - a request with none gets 500 and "mock had no recording" (`fail`, the default), which fails the case that asked, or, for a less-safe `schema_synth` mock, a deterministic answer that satisfies the response
//     schema when the request satisfies the request schema (and `fail` otherwise). Either is COUNTED, so the evidence can say "mock answered 3 unrecorded requests";
//   - a named fault (timeout, 5xx, throttle) is armed by the scenario through the control path and used up by the next requests.
// Fail closed and bounded: a set that is unreadable or does not hash to its pinned digest is not served; a body over 64 KiB is refused; headers and bodies have a time limit; the server listens on loopback only.
// The control paths (`/__rovara/...`) need the run's control token, which the app is never given.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SERVICE_MOCK_NO_RECORDING_MESSAGE,
  SERVICE_MOCK_UNMATCHED_STATUS,
  type ServiceMockEntry,
  type ServiceMockFault,
  type ServiceMockUsage,
  type TestEnvProdDeny,
} from "@agentx/contracts";
import { verifyAdditionSet } from "./additions.js";
import { createSyntheticGenerator } from "../data-guard.js";
import { FixtureSetRefused, MOCK_BODY_MAX_BYTES, hashOfRequest, indexEntries, loadFixtureSet, sagemakerEndpointOfPath } from "./fixture-set.js";
import { schemaAccepts, synthesizeFromSchema } from "./schema.js";

export interface ServiceMockOptions {
  /** The fixture set as stored (untrusted until `loadFixtureSet` has checked it against the pinned digest). */
  fixtureSet: unknown;
  /** `mock.fixtureSetRef` of the approved environment. */
  expectedDigest: string;
  unmatched: "fail" | "schema_synth";
  host?: string;
  port?: number;
  /** The task's new answers (owner decision Q9), served only when the pinned set has no recording. They must extend exactly this set (`baseFixtureDigest`). */
  additions?: unknown;
  /** The digest of the additions the BROKER pinned, and the production deny list the additions are scanned against. Both are required with `additions`: an unpinned set is never served. */
  expectedAdditionsDigest?: string;
  deny?: TestEnvProdDeny;
  /** Wait for the recorded latency before answering (off by default: a mock should be quick). */
  replayLatency?: boolean;
  controlToken?: string;
}

/** What the mock reports: the contract's usage plus how many answers came from the task's additions (listed in the evidence by the additions listing). */
export type ServiceMockReport = ServiceMockUsage & { additionsServed: number };

export interface RunningServiceMock {
  url: string;
  /** The token the control paths need; given to the scenario runner, never to the app. */
  controlToken: string;
  usage(): ServiceMockReport;
  close(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const CONTROL_PREFIX = "/__rovara/";
const text = (response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers });
  response.end(body);
};

class BodyTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MOCK_BODY_MAX_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startServiceMock(options: ServiceMockOptions): Promise<RunningServiceMock> {
  const set = loadFixtureSet(options.fixtureSet, options.expectedDigest);
  const entries = indexEntries(set);
  const additions = new Map<string, ServiceMockEntry>();
  if (options.additions !== undefined) {
    if (options.expectedAdditionsDigest === undefined || options.deny === undefined) throw new FixtureSetRefused("additions_unpinned");
    const verified = verifyAdditionSet(set, options.additions, options.expectedAdditionsDigest, options.deny);
    for (const addition of verified.additions) if (!entries.has(addition.entry.requestHash)) additions.set(addition.entry.requestHash, addition.entry);
  }
  const controlToken = options.controlToken ?? randomBytes(24).toString("hex");
  const armed = new Map<string, number>();
  const counts = { matched: 0, unmatchedFailed: 0, synthesized: 0 };
  let additionsServed = 0;
  const faultsInjected = new Map<string, number>();
  const faultByName = new Map<string, ServiceMockFault>(set.faults.map((fault) => [fault.name, fault]));

  const authorised = (request: IncomingMessage): boolean => {
    const given = Buffer.from(String(request.headers["x-rovara-control"] ?? ""));
    const wanted = Buffer.from(controlToken);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };
  const usage = (): ServiceMockReport => ({ service: set.service.name, ...counts, faultsInjected: [...faultsInjected].map(([name, count]) => ({ name, count })), additionsServed });

  const control = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    if (!authorised(request)) return text(response, 403, "control token required");
    if (request.method === "GET" && path === `${CONTROL_PREFIX}usage`) {
      const body = JSON.stringify(usage());
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (request.method === "POST" && path === `${CONTROL_PREFIX}fault`) {
      let parsed: { name?: unknown; count?: unknown };
      try {
        parsed = JSON.parse(await readBody(request)) as { name?: unknown; count?: unknown };
      } catch {
        return text(response, 400, "a fault is JSON with a name and a count");
      }
      const count = typeof parsed.count === "number" && Number.isInteger(parsed.count) && parsed.count >= 1 && parsed.count <= 1_000 ? parsed.count : 1;
      if (typeof parsed.name !== "string" || !faultByName.has(parsed.name)) return text(response, 404, "no such fault in this fixture set");
      armed.set(parsed.name, (armed.get(parsed.name) ?? 0) + count);
      return text(response, 204, "");
    }
    return text(response, 404, "no such control path");
  };

  /** The armed fault the next request uses, oldest first, or undefined. */
  const takeFault = (): ServiceMockFault | undefined => {
    for (const [name, remaining] of armed) {
      if (remaining <= 0) { armed.delete(name); continue; }
      armed.set(name, remaining - 1);
      faultsInjected.set(name, (faultsInjected.get(name) ?? 0) + 1);
      return faultByName.get(name);
    }
    return undefined;
  };

  const sendFault = (fault: ServiceMockFault, request: IncomingMessage, response: ServerResponse): void => {
    const finish = () => {
      if (fault.kind === "timeout") { request.socket.destroy(); return; }
      const status = fault.status ?? 500;
      const headers: Record<string, string> = set.service.kind === "sagemaker_runtime" ? { "x-amzn-errortype": fault.kind === "throttle" ? "ThrottlingException" : "InternalFailure" } : {};
      text(response, status, fault.kind === "throttle" ? "throttled" : "service error", headers);
    };
    if (fault.delayMs === 0) finish(); else setTimeout(finish, fault.delayMs).unref();
  };

  const answer = (entry: ServiceMockEntry, response: ServerResponse): void => {
    const send = () => {
      response.writeHead(entry.response.status, { "content-type": entry.response.contentType, "content-length": Buffer.byteLength(entry.response.body), ...(set.service.kind === "sagemaker_runtime" ? { "x-amzn-invoked-production-variant": "AllTraffic" } : {}) });
      response.end(entry.response.body);
    };
    if (options.replayLatency === true && entry.response.latencyMs > 0) setTimeout(send, entry.response.latencyMs).unref(); else send();
  };

  const unmatched = (response: ServerResponse, request: { contentType: string; body: string; hash: string }): void => {
    if (options.unmatched === "schema_synth" && set.responseSchema !== null) {
      let acceptable = set.requestSchema === null;
      if (set.requestSchema !== null) {
        try { acceptable = schemaAccepts(set.requestSchema, JSON.parse(request.body) as unknown); } catch { acceptable = false; }
      }
      if (acceptable) {
        counts.synthesized += 1;
        const body = JSON.stringify(synthesizeFromSchema(set.responseSchema, createSyntheticGenerator(parseInt(request.hash.slice(0, 7), 16))));
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-rovara-mock": "synthesized" });
        response.end(body);
        return;
      }
    }
    counts.unmatchedFailed += 1;
    text(response, SERVICE_MOCK_UNMATCHED_STATUS, SERVICE_MOCK_NO_RECORDING_MESSAGE, { "x-rovara-mock": "no-recording" });
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://mock.invalid");
      if (url.pathname.startsWith(CONTROL_PREFIX)) return control(request, response, url.pathname);
      let body: string;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof BodyTooLarge) { counts.unmatchedFailed += 1; request.resume(); return text(response, 413, "request too large"); }
        throw error;
      }
      const contentType = String(request.headers["content-type"] ?? "");
      const pathAndQuery = `${url.pathname}${url.search}`;
      const endpoint = set.service.kind === "sagemaker_runtime" ? sagemakerEndpointOfPath(url.pathname) : undefined;
      // A SageMaker Runtime request for another endpoint, or any other path, is a request this mock has no recording for.
      const addressed = set.service.kind !== "sagemaker_runtime" || endpoint === set.service.target;
      // An armed fault is for the service's own calls: a stray request does not use it up.
      const fault = addressed ? takeFault() : undefined;
      if (fault !== undefined) return sendFault(fault, request, response);
      const hash = addressed ? hashOfRequest(set, { method: request.method ?? "GET", pathAndQuery, contentType, body }) : "";
      const base = addressed ? entries.get(hash) : undefined;
      const added = addressed && base === undefined ? additions.get(hash) : undefined;
      const entry = base ?? added;
      if (entry === undefined) return unmatched(response, { contentType, body, hash: addressed ? hash : "0".repeat(64) });
      if (added === undefined) counts.matched += 1; else additionsServed += 1;
      answer(entry, response);
    })().catch(() => { if (!response.headersSent) text(response, 500, "mock error"); else response.destroy(); });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 2_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${String(address.port)}`,
    controlToken,
    usage,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
