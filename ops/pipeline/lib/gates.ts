// The gate runner (L2-STAGE-CLI-INTERFACE.md 3): discover gate files, run every gate of a phase, write the verdict JSON, stop the step on any failure.
import { pathToFileURL } from "node:url";
import { StageError } from "../types.ts";
import type { PipelineConfig } from "../config.ts";
import type { ChangeSetRecord, Gate, GateInput, GatePhase, GateRecord, Manifest, PipelineEnv, Ports } from "../types.ts";
import { errorText } from "./context.ts";

const PHASES: readonly GatePhase[] = ["preflight", "change-sets", "gateway-live", "proof"];

/** Loads every `<name>.gate.ts` of a directory. A file that does not export a well-formed `gate` named like the file is an error (a broken gate never silently disappears). */
export async function discoverGates(ports: Ports, dir: string, load: (url: string) => Promise<Record<string, unknown>> = (url) => import(url) as Promise<Record<string, unknown>>): Promise<Gate[]> {
  const gates: Gate[] = [];
  for (const file of ports.fs.readdir(dir).filter((name) => name.endsWith(".gate.ts")).sort()) {
    const module = await load(pathToFileURL(`${dir}/${file}`).href);
    const gate = module.gate as Gate | undefined;
    const expected = file.slice(0, -".gate.ts".length);
    if (gate === undefined || typeof gate.run !== "function" || gate.name !== expected || !/^[a-z0-9-]+$/u.test(gate.name)) throw new StageError("FAILED", `${file} must export a gate named ${expected}`);
    if (!Array.isArray(gate.phases) || gate.phases.length === 0 || (gate.phases as readonly unknown[]).some((phase) => !(PHASES as readonly unknown[]).includes(phase))) throw new StageError("FAILED", `gate ${gate.name} names no valid phase`);
    gates.push(gate);
  }
  return gates;
}

export interface PhaseResult { records: GateRecord[]; failed: boolean; missing: string[] }

export interface PhaseArgs {
  env: PipelineEnv;
  phase: GatePhase;
  region: string;
  config: PipelineConfig;
  gates: readonly Gate[];
  required: readonly string[];
  manifest: Manifest;
  changeSets: readonly ChangeSetRecord[];
  dirs: GateInput["dirs"];
  ports: Ports;
  log: (line: string) => void;
  dryRun?: boolean;
}

export async function runPhase(args: PhaseArgs): Promise<PhaseResult> {
  const applicable = args.gates.filter((gate) => gate.phases.includes(args.phase) && (gate.envs === undefined || gate.envs.includes(args.env)));
  const missing = args.required.filter((name) => !applicable.some((gate) => gate.name === name));
  const records: GateRecord[] = [];
  let failed = false;
  for (const gate of applicable) {
    const startedAt = args.ports.clock.now();
    const notes: string[] = [];
    let outcome;
    try {
      outcome = await gate.run({ env: args.env, phase: args.phase, region: args.region, config: args.config, manifest: args.manifest, changeSets: args.changeSets, dirs: args.dirs, ports: args.ports, ...(args.dryRun === true ? { dryRun: true } : {}), log: (line) => { notes.push(line); args.log(`  [${gate.name}] ${line}`); } });
    } catch (error) {
      outcome = { result: "fail" as const, failures: [`the gate threw: ${errorText(error)}`] };
    }
    let result = outcome.result;
    let skippedReason: string | null = outcome.skippedReason !== undefined && outcome.skippedReason !== "" ? outcome.skippedReason : null;
    const failures = [...(outcome.failures ?? [])];
    if (result !== "pass" && result !== "fail" && result !== "skipped") { result = "fail"; failures.push(`the gate returned an unknown result`); }
    if (result === "skipped" && skippedReason === null) { result = "fail"; failures.push("the gate skipped without a reason"); }
    if (result === "fail" && failures.length === 0) failures.push("the gate failed without saying why");
    if (result !== "skipped") skippedReason = null;
    const record: GateRecord = {
      schema: 1, name: gate.name, phase: args.phase, scope: args.changeSets.length === 0 ? null : args.changeSets.map((c) => c.part).join("+"), env: args.env, executionId: args.manifest.executionId, cloudSha: args.manifest.cloud.sha,
      startedAt: startedAt.toISOString(), writtenAt: args.ports.clock.now().toISOString(), result, skippedReason, failures, notes: [...notes, ...(outcome.notes ?? [])], data: outcome.data ?? {},
    };
    records.push(record);
    if (result === "fail") { failed = true; for (const line of failures) args.log(`  [FAIL] ${gate.name}: ${line}`); } else args.log(`  [${result.toUpperCase()}] ${gate.name}${skippedReason === null ? "" : ` (${skippedReason})`}`);
    args.ports.fs.mkdirp(`${args.dirs.out}/gates`);
    args.ports.fs.writeText(`${args.dirs.out}/gates/${args.phase}-${gate.name}.json`, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { records, failed, missing };
}

/** Replaces earlier records of the same phase and gate (a retried step), keeps the rest. */
export function mergeGateRecords(existing: GateRecord[], fresh: readonly GateRecord[]): GateRecord[] {
  const key = (record: GateRecord): string => `${record.phase}/${record.name}/${record.scope ?? ""}`;
  const replaced = new Set(fresh.map(key));
  return [...existing.filter((record) => !replaced.has(key(record))), ...fresh];
}
