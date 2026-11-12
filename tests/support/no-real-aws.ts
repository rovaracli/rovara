import { createRequire } from "node:module";
import { afterEach, beforeEach, expect } from "vitest";

/**
 * Vitest setup file, run before every test file (tests/support/vitest-shared-config.ts): no test makes a real AWS call by accident.
 * (DEFERRED SUBAGENT-AWS-DEFAULT-CLIENT-SLIP: a CLI path that defaulted to real SSM/EC2 clients, in a test that forgot to pass a fake, made a real call.)
 *
 * Every AWS SDK v3 client sends through `Client.prototype.send` of the Smithy runtime (`@smithy/core/client`; `@smithy/smithy-client` in older SDKs), and the credential
 * provider chain runs inside that send, so one patch on `send` covers both a real request and a real credential lookup. A client that would reach a real endpoint
 * fails with RealAwsCallBlockedError, naming the test, the client and the command, and the test fails afterwards even when the code under test caught the error
 * (so a try/catch with a fallback cannot hide it). What is not blocked: a client given a fake request handler (not the SDK's own Node, HTTP/2 or fetch handler), a client
 * whose endpoint is this machine (loopback: a fake server a test started), and a test that opts in. Fakes passed as the client itself never reach the SDK at all.
 *
 * Opt-in, for live tests only: set ROVARA_ALLOW_REAL_AWS=1 in the environment (the live-aws CI job does), or wrap the code in `withRealAwsAllowed` below. Do not use either
 * in a test that runs in the normal suite.
 */

export const ALLOW_REAL_AWS_ENV = "ROVARA_ALLOW_REAL_AWS";

export class RealAwsCallBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealAwsCallBlockedError";
  }
}

interface Violation { message: string }
interface GuardState { violations: Violation[]; allowDepth: number }
const STATE_KEY = Symbol.for("rovara.noRealAws.state");
const PATCHED_KEY = Symbol.for("rovara.noRealAws.patched");
const globals = globalThis as unknown as Record<symbol, unknown>;
const state: GuardState = (globals[STATE_KEY] as GuardState | undefined) ?? { violations: [], allowDepth: 0 };
globals[STATE_KEY] = state;

/** Run `fn` with real AWS calls allowed (a live test's own opt-in, narrower than the environment variable). */
export async function withRealAwsAllowed<T>(fn: () => Promise<T>): Promise<T> {
  state.allowDepth += 1;
  try {
    return await fn();
  } finally {
    state.allowDepth -= 1;
  }
}

/** The guard's own tests: returns the blocked calls recorded in this test and clears them (so the hook below does not fail the test that provoked them on purpose). */
export function takeRealAwsViolations(): string[] {
  return state.violations.splice(0).map((violation) => violation.message);
}

function allowed(): boolean {
  return state.allowDepth > 0 || process.env[ALLOW_REAL_AWS_ENV] === "1";
}

const REAL_HANDLERS = new Set(["NodeHttpHandler", "NodeHttp2Handler", "FetchHttpHandler"]);
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|[^.]+\.localhost)$/u;

interface ClientLike {
  constructor: { name?: string };
  config?: { requestHandler?: { constructor?: { name?: string } }; endpoint?: unknown };
}

function describeCall(client: ClientLike, command: unknown): string {
  const clientName = client.constructor?.name ?? "an AWS client";
  const commandName = (command as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? "a command";
  return `${clientName}.send(${commandName})`;
}

function blockedMessage(client: ClientLike, command: unknown): string {
  const state = expect.getState();
  const test = `${state.currentTestName ?? "(outside a test)"} (${state.testPath ?? "unknown file"})`;
  return `Real AWS call blocked in test ${test}: ${describeCall(client, command)} would reach a real endpoint through the SDK's default request handler and credential chain. `
    + `Pass a fake client (or a client with a fake requestHandler) to the code under test. A live test opts in with ${ALLOW_REAL_AWS_ENV}=1 (tests/support/no-real-aws.ts).`;
}

function isLoopback(endpoint: unknown): boolean {
  const value = endpoint as { hostname?: string } | string | undefined;
  const hostname = typeof value === "string" ? safeHostname(value) : value?.hostname;
  return hostname !== undefined && LOOPBACK.test(hostname);
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function fail(client: ClientLike, command: unknown): RealAwsCallBlockedError {
  const message = blockedMessage(client, command);
  state.violations.push({ message });
  return new RealAwsCallBlockedError(message);
}

type Send = (this: ClientLike, command: unknown, optionsOrCb?: unknown, cb?: unknown) => unknown;

function guardedSend(original: Send): Send {
  return function send(this: ClientLike, command, optionsOrCb, cb) {
    if (allowed()) return original.call(this, command, optionsOrCb, cb);
    const handlerName = this.config?.requestHandler?.constructor?.name;
    // A fake request handler never reaches the network.
    if (handlerName !== undefined && !REAL_HANDLERS.has(handlerName)) return original.call(this, command, optionsOrCb, cb);
    const endpoint = this.config?.endpoint;
    if (endpoint === undefined) throw fail(this, command);
    // A client with its own endpoint: loopback is a fake server on this machine; anything else is blocked. The endpoint is a provider, so the check waits for it.
    const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
    const resolved = Promise.resolve(typeof endpoint === "function" ? (endpoint as () => unknown)() : endpoint);
    const run = resolved.then((value) => {
      if (!isLoopback(value)) throw fail(this, command);
      return original.call(this, command, typeof optionsOrCb === "function" ? undefined : optionsOrCb);
    });
    if (typeof callback === "function") {
      run.then((output) => (callback as (error: unknown, output?: unknown) => void)(null, output), (error: unknown) => (callback as (error: unknown) => void)(error));
      return undefined;
    }
    return run;
  };
}

function install(): void {
  const require = createRequire(import.meta.url);
  for (const specifier of ["@smithy/core/client", "@smithy/smithy-client"]) {
    let Client: { prototype: Record<string | symbol, unknown> } | undefined;
    try {
      Client = (require(specifier) as { Client?: { prototype: Record<string | symbol, unknown> } }).Client;
    } catch {
      continue;
    }
    if (Client === undefined || Client.prototype[PATCHED_KEY] === true) continue;
    const original = Client.prototype.send as Send;
    Object.defineProperty(Client.prototype, "send", { value: guardedSend(original), writable: true, configurable: true });
    Object.defineProperty(Client.prototype, PATCHED_KEY, { value: true });
  }
}

install();

beforeEach(() => {
  state.violations.length = 0;
});

// A blocked call fails the test even when the code under test swallowed the error (a probe with a fallback, a `.catch(() => undefined)`).
afterEach(() => {
  const found = takeRealAwsViolations();
  if (found.length > 0) throw new RealAwsCallBlockedError(`${found.length} real AWS call(s) were attempted and blocked, though the code under test may have caught the error:\n${found.join("\n")}`);
});
