import { validClear, type ClearSourceStop, type CustomerSource, type SourceStop } from "./source-stop.js";
interface OperatorClearPorts {
  meter: { sourceStop(iss: string, cid: string, source: CustomerSource): Promise<SourceStop | undefined>; clearSourceStop(input: ClearSourceStop): Promise<boolean> };
  /** Resolved by STS with the SAME credentials as the meter client. Never supplied as a command-line actor string. */
  identity(): Promise<string>;
  interactive: boolean;
  preview(value: unknown): void;
  confirm(exactPhrase: string): Promise<boolean>;
}
/** No server route calls this. Noninteractive callers and workload role identities cannot clear a stop. */
export async function runOperatorClear(input: Pick<ClearSourceStop, "iss" | "cid" | "source" | "reason">, ports: OperatorClearPorts): Promise<boolean> {
  if (!ports.interactive) throw new Error("operator clear requires a terminal");
  const actor = await ports.identity();
  if (!validClear({ ...input, actor, expectedStopId: "preview" })) throw new Error("operator clear refused");
  const stop = await ports.meter.sourceStop(input.iss, input.cid, input.source);
  if (stop?.stopped !== true || stop.stopId === undefined || stop.inFlight !== undefined) return false;
  ports.preview({ ...input, ...stop, actor, changes: "Clear only this source stop; preserve spend, caps and in-flight calls." });
  if (!await ports.confirm(`CLEAR ${input.cid} ${input.source} ${stop.stopId}`)) return false;
  // CAS on the previewed stop; a new overage or in-flight call requires a fresh preview and confirmation.
  return ports.meter.clearSourceStop({ ...input, actor, expectedStopId: stop.stopId });
}
