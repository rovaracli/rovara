// One runner link per local-aws helper (slice 4, lane W3): dials the helper's front with `docker exec -i ... runner-pipe`, serves the runner/2 client on it, and, when the pipe breaks while the round is still on, dials again.
// A connection is the unit of state: every dial gets a NEW session (a fresh sandbox controller and a fresh code area of the run), because a closed pipe means stop everything and a stopped controller refuses new work. The front forgets what it
// registered on a connection that closed and registers again on the next one, so nothing of an old connection is worth keeping. Dials are bounded: a helper whose front never answers ends the link as failed.
import type { RunCode } from "./code-store.js";
import type { SandboxController } from "./controller.js";
import { createRunnerClient, type RunnerClient, type RunnerClientOptions, type RunnerEnd, type RunnerFunctionSettings } from "./runner-client.js";
import { pipeArgProblems, pipeArgs, type PipeLauncher, type PipeSpec } from "./runner-pipe.js";
import type { WheelIndex } from "./wheel-index.js";

/** What one connection runs on. The link calls `close` once the connection is over and every sandbox is stopped (close the code area, remove the connection's scratch). */
export interface RunnerSession {
  controller: SandboxController;
  code: RunCode;
  settings: RunnerFunctionSettings;
  wheelIndex?: WheelIndex;
  close(): Promise<void>;
}

export interface RunnerLinkOptions extends PipeSpec {
  launcher: PipeLauncher;
  /** Makes the session for one connection. */
  openSession(): Promise<RunnerSession>;
  workerVersion?: string;
  runtimes?: readonly string[];
  limits?: RunnerClientOptions["limits"];
  log?: RunnerClientOptions["log"];
  onRegistered?: RunnerClientOptions["onRegistered"];
  /** Consecutive dials that never got a hello before the link gives up (default 5). A connection that got its hello resets the count. */
  maxFailedDials?: number;
  /** The wait before a dial after a failure: base, doubling, capped (defaults 250 ms, 4 s). */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export type RunnerLinkState = "connecting" | "connected" | "stopped" | "failed";

export interface RunnerLink {
  readonly state: RunnerLinkState;
  /** Dials made so far (the first included). */
  readonly dials: number;
  /** Resolves when the link has ended (closed or failed) and its last session is closed. Never rejects. */
  readonly ended: Promise<RunnerLinkState>;
  /** The round is over: ends the connection, stops everything, closes the session. */
  close(): Promise<void>;
}

export function startRunnerLink(options: RunnerLinkOptions): RunnerLink {
  const spec: PipeSpec = { helperContainer: options.helperContainer };
  const args = pipeArgs(spec);
  if (pipeArgProblems(args, spec).length > 0) throw new RangeError("the runner pipe command is not sound");
  const maxFailed = options.maxFailedDials ?? 5;
  const retryBase = options.retryBaseMs ?? 250;
  const retryMax = options.retryMaxMs ?? 4_000;
  let state: RunnerLinkState = "connecting";
  let dials = 0;
  let closing = false;
  let current: RunnerClient | undefined;
  let wake: (() => void) | undefined;

  const loop = async (): Promise<RunnerLinkState> => {
    let failed = 0;
    while (!closing) {
      dials += 1;
      state = "connecting";
      let session: RunnerSession | undefined;
      let end: RunnerEnd | undefined;
      try {
        session = await options.openSession();
        if (closing) break;
        const pipe = options.launcher.start(args);
        const client = createRunnerClient({
          pipe, controller: session.controller, code: session.code, settings: session.settings,
          ...(session.wheelIndex === undefined ? {} : { wheelIndex: session.wheelIndex }),
          ...(options.workerVersion === undefined ? {} : { workerVersion: options.workerVersion }), ...(options.runtimes === undefined ? {} : { runtimes: options.runtimes }),
          ...(options.limits === undefined ? {} : { limits: options.limits }), log: (event) => { if (event.event === "connected" && current !== undefined) state = "connected"; options.log?.(event); }, ...(options.onRegistered === undefined ? {} : { onRegistered: options.onRegistered }),
        });
        current = client;
        end = await client.ended;
      } catch {
        // A session that would not open, or a launcher that would not start: counted as a failed dial.
      } finally {
        current = undefined;
        if (session !== undefined) await session.close().catch(() => undefined);
      }
      if (closing) break;
      failed = end?.handshaken === true ? 0 : failed + 1;
      if (end?.reason === "protocol_error" && end.handshaken) failed += 1;
      if (failed >= maxFailed) { state = "failed"; return state; }
      const delay = Math.min(retryMax, retryBase * 2 ** Math.max(0, failed - 1));
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, delay).unref(); });
      wake = undefined;
    }
    state = "stopped";
    return state;
  };
  const ended = loop().catch((): RunnerLinkState => "failed").then((final) => { state = final === "failed" ? "failed" : "stopped"; return state; });

  return {
    get state() { return state; },
    get dials() { return dials; },
    ended,
    async close() {
      closing = true;
      wake?.();
      await current?.close();
      await ended;
    },
  };
}
