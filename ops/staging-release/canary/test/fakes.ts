import type { CanaryInput, CanaryPorts, LedgerEntry } from "../src/types.ts";

export const PREFIX = "/rovara-release/staging";
export const OPERATOR = "arn:aws:sns:us-west-2:111111111111:agentx-staging-alerts";
export const SLACK = "arn:aws:sns:us-west-2:111111111111:rovara-staging-release-alerts";
export const SHA = "a".repeat(40);
export const OTHER = "b".repeat(40);
export const EXEC = "0a1b2c3d-1111-4222-8333-444455556666";
export const EXEC2 = "1a1b2c3d-1111-4222-8333-444455556666";
export const T0 = Date.parse("2026-11-23T12:00:00Z");
export const HOUR = 3_600_000;

export type Event = { type: string; detail: string };

export interface LaneRunPayload {
  runId: string;
  codeSha: string;
  cloudSha: string;
  mode: string;
}

/** An in-memory world: SSM, the ledger, the lane, SNS, the stage's out/ files and a clock that only sleep() moves. */
export class World {
  now = T0;
  params = new Map<string, string>();
  ledger: LedgerEntry[] = [];
  published: { topic: string; subject: string; message: string }[] = [];
  files = new Map<string, string>();
  events: Event[] = [];
  laneCalls: { fn: string; payload: Record<string, unknown> }[] = [];
  lastStart: LaneRunPayload | null = null;
  statusCalls = 0;
  lambdaErrorCount: number | null = 0;
  failHoldWrite = false;
  failPointerWrite = false;
  failLedgerList = false;
  failTopics = new Set<string>();
  /** Called after every ledger put, so a test can inject a competing claim. */
  afterLedgerPut: ((w: World, key: string) => void) | null = null;
  lane: (fn: "start" | "status", payload: Record<string, unknown>, w: World) => unknown = defaultLane;

  constructor() {
    this.params.set(`${PREFIX}/code-installed`, SHA);
    this.params.set(`${PREFIX}/cloud-installed`, OTHER);
  }

  log(type: string, detail: string): void {
    this.events.push({ type, detail });
  }

  fillLedger(count: number, options: { ageMs?: number; kind?: string; rollback?: boolean } = {}): void {
    for (let i = 0; i < count; i++) {
      const at = this.now - (options.ageMs ?? 10 * 60_000) - i * 1000;
      this.ledger.push({ key: `canary-ledger/${options.rollback === true ? "rollback-" : ""}${new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${options.kind ?? "cloud"}-fill-${this.ledger.length}`, lastModifiedMs: at });
    }
  }

  hold(name: string): boolean {
    return this.params.has(`${PREFIX}/${name}`);
  }

  holdNames(): string[] {
    return [...this.params.keys()].filter((k) => k.includes("-hold/"));
  }

  pointerWrites(): string[] {
    return this.events.filter((e) => e.type === "pointer").map((e) => e.detail);
  }

  ports(): CanaryPorts {
    return {
      nowMs: () => this.now,
      sleep: (ms) => {
        this.now += ms;
        return Promise.resolve();
      },
      listLedger: (after) => {
        if (this.failLedgerList) return Promise.reject(new Error("ledger unreadable"));
        return Promise.resolve(this.ledger.filter((e) => after === null || e.key > after).map((e) => ({ ...e })));
      },
      putLedger: (key) => {
        this.log("ledger", key);
        this.ledger.push({ key, lastModifiedMs: this.now });
        this.afterLedgerPut?.(this, key);
        return Promise.resolve();
      },
      getParameter: (name) => Promise.resolve(this.params.get(name) ?? null),
      putPointer: (name, value) => {
        if (this.failPointerWrite) return Promise.reject(new Error("denied"));
        this.log("pointer", `${name.slice(name.lastIndexOf("/") + 1)}=${value}`);
        this.params.set(name, value);
        return Promise.resolve();
      },
      putHold: (name, value) => {
        if (this.failHoldWrite) return Promise.reject(new Error("denied"));
        this.log("hold", name);
        if (!this.params.has(name)) this.params.set(name, value);
        return Promise.resolve();
      },
      invokeLane: (fn, payload) => {
        this.laneCalls.push({ fn, payload });
        try {
          return Promise.resolve(this.lane(fn, payload, this));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error("lane error"));
        }
      },
      lambdaErrors: () => (this.lambdaErrorCount === null ? Promise.reject(new Error("no metrics")) : Promise.resolve(this.lambdaErrorCount)),
      publish: (topic, subject, message) => {
        if (this.failTopics.has(topic)) return Promise.reject(new Error("topic down"));
        this.log("alert", `${topic === OPERATOR ? "operator" : "slack"}:${subject}`);
        this.published.push({ topic, subject, message });
        return Promise.resolve();
      },
      writeFile: (name, text) => {
        this.files.set(name, text);
      },
    };
  }

  alertsTo(topic: string): string[] {
    return this.published.filter((p) => p.topic === topic).map((p) => p.subject);
  }

  result(): Record<string, unknown> {
    return JSON.parse(this.files.get("result.json") ?? "{}") as Record<string, unknown>;
  }
}

export function passReport(run: LaneRunPayload, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId: run.runId, mode: "real", codeSha: run.codeSha, cloudSha: run.cloudSha, result: "PASS", costUsd: 0.52, capUsd: 1, steps: [{ id: "S1", status: "PASS" }, { id: "S8", status: "PASS" }, { id: "S13", status: "PASS" }], ...overrides };
}

/** install-close ok, start answers the run id, status answers running once and then the report. */
export function defaultLane(fn: "start" | "status", payload: Record<string, unknown>, w: World, report: (run: LaneRunPayload) => unknown = passReport): unknown {
  if (fn === "start") {
    if (payload.op === "install-close") return { ok: true };
    w.lastStart = payload as unknown as LaneRunPayload;
    return { runId: payload.runId, executionArn: "arn:aws:states:us-west-2:111111111111:execution:x:y" };
  }
  w.statusCalls++;
  if (w.statusCalls === 1) return { state: "running" };
  return { state: "done", report: report(w.lastStart as LaneRunPayload) };
}

export function withReport(w: World, report: (run: LaneRunPayload) => unknown): void {
  w.lane = (fn, payload, world) => defaultLane(fn, payload, world, report);
}

export function input(overrides: Partial<CanaryInput> = {}): CanaryInput {
  return { kind: "code", executionId: EXEC, executionType: "STANDARD", sha: SHA, parameterPrefix: PREFIX, topics: { operator: OPERATOR, slack: SLACK }, s3Path: "s3://runs/canary/x/", ...overrides };
}
