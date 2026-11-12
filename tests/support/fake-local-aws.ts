// A fake Rovara local AWS for the slice-2 end-to-end tests: it wraps the fake Docker daemon of fake-services-docker.ts so that the worker's real control calls (the probe container of worker/src/emulator-control.ts: seed, reset, ledger
// summary) are answered here. Nothing is stubbed in the worker: it makes the same `docker run --rm ... --control/--post` calls it makes against a real emulator; this only plays the emulator's side and records what it was asked.
// What the emulator's env file and the control calls held at the moment of the call is read inside the call (the run's files are removed as soon as it returns).
import { readFileSync } from "node:fs";
import type { fakeServicesDocker } from "./fake-services-docker.js";

export interface ControlCall { path: string; method: string; token: string | undefined; body: string | undefined }
export interface FakeLocalAwsOptions {
  /** The image reference of the emulator (the digest the plan pinned), so its start can be told from any other `docker run --detach`. */
  image: string;
  /** What `GET /_rovara/ledger/summary` answers (default: an empty ledger). A function sees the round number (1 for the first ledger read). */
  ledger?: string | ((round: number) => string);
  /** The probe's exit code for the ledger read (2 = the answer was past the probe's limit; any other non-zero = the call failed). */
  ledgerExit?: number;
  /** The exit code of the seed call (non-zero: the emulator refused). */
  seedExit?: number;
  /** A different answer for the seed call (default: every declared resource confirmed). */
  seedAnswer?: (body: string) => string;
  /** A word that, when a `docker exec` carries it, is recorded in `order` as "marked" (the project's own seed command). */
  mark?: string;
}
export interface FakeLocalAws {
  /** The env file of each emulator start, in order. */
  emulatorEnv: string[];
  controls: ControlCall[];
  /** The order things happened in: emulator, seed, reset, ledger, exec. */
  order: string[];
}

export function fakeLocalAws(fake: ReturnType<typeof fakeServicesDocker>, options: FakeLocalAwsOptions): FakeLocalAws {
  const state: FakeLocalAws = { emulatorEnv: [], controls: [], order: [] };
  const original = fake.docker.run.bind(fake.docker);
  let ledgerReads = 0;
  fake.docker.run = (args, runOptions) => {
    const read = (flag: string): string | undefined => { const at = args.indexOf(flag); if (at < 0) return undefined; try { return readFileSync(args[at + 1]!, "utf8"); } catch { return undefined; } };
    if (args[0] === "run" && args.includes("--detach") && args.includes(options.image)) { state.emulatorEnv.push(read("--env-file") ?? ""); state.order.push("emulator"); }
    if (args[0] === "exec") state.order.push(options.mark !== undefined && args.includes(options.mark) ? "marked" : "exec");
    if (args[0] === "run" && args.includes("--rm") && (args.includes("--control") || args.includes("--post"))) {
      const envFile = read("--env-file");
      const mount = args.findIndex((arg) => arg === "-v");
      let body: string | undefined;
      if (mount >= 0) { try { body = readFileSync(args[mount + 1]!.split(":")[0]!, "utf8"); } catch { body = undefined; } }
      const path = args[args.indexOf("--path") + 1]!;
      const method = args.includes("--control") ? args[args.indexOf("--control") + 1]! : "POST";
      state.controls.push({ path, method, token: /^ROVARA_CONTROL_TOKEN=(.+)$/mu.exec(envFile ?? "")?.[1], body });
      const done = (exitCode: number, stdout = ""): Promise<{ exitCode: number; stdout: string; stderr: string }> => Promise.resolve({ exitCode, stdout, stderr: "" });
      state.order.push(path === "/_rovara/seed" ? "seed" : path === "/_rovara/reset" ? "reset" : "ledger");
      if (path === "/_rovara/reset") return done(0);
      if (path === "/_rovara/seed") {
        if ((options.seedExit ?? 0) !== 0) return done(options.seedExit!);
        const document = JSON.parse(body ?? "{}") as { s3?: { buckets: Array<{ name: string }> }; dynamodb?: { tables: Array<{ request: { TableName: string } }> }; sqs?: { queues: Array<{ name: string }> }; sns?: { topics: Array<{ name: string }> } };
        const steps = [
          ...(document.s3?.buckets ?? []).map((bucket) => ({ service: "s3", action: "CreateBucket", name: bucket.name, ok: true })),
          ...(document.dynamodb?.tables ?? []).map((table) => ({ service: "dynamodb", action: "CreateTable", name: table.request.TableName, ok: true })),
          ...(document.sqs?.queues ?? []).map((queue) => ({ service: "sqs", action: "CreateQueue", name: queue.name, ok: true })),
          ...(document.sns?.topics ?? []).map((topic) => ({ service: "sns", action: "CreateTopic", name: topic.name, ok: true })),
        ];
        return done(0, options.seedAnswer?.(body ?? "") ?? JSON.stringify({ ok: true, failed: 0, steps }));
      }
      ledgerReads += 1;
      if ((options.ledgerExit ?? 0) !== 0) return done(options.ledgerExit!);
      const ledger = options.ledger ?? "{}";
      return done(0, typeof ledger === "function" ? ledger(ledgerReads) : ledger);
    }
    return original(args, runOptions);
  };
  return state;
}

/** A ledger as the emulator's summary writes it: `{ service: { calls, unsupported, errors, operations: { op: { calls, unsupported, errors } } } }`. */
export function ledgerOf(services: Record<string, Record<string, { calls: number; unsupported?: number; errors?: number }>>): string {
  const out: Record<string, unknown> = {};
  for (const [service, operations] of Object.entries(services)) {
    const rows = Object.entries(operations).map(([name, row]) => [name, { calls: row.calls, unsupported: row.unsupported ?? 0, errors: row.errors ?? 0 }] as const);
    out[service] = {
      calls: rows.reduce((total, [, row]) => total + row.calls, 0), unsupported: rows.reduce((total, [, row]) => total + row.unsupported, 0), errors: rows.reduce((total, [, row]) => total + row.errors, 0),
      operations: Object.fromEntries(rows),
    };
  }
  return JSON.stringify(out);
}
