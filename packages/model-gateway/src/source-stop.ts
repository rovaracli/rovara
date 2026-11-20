import type { ChargeReceiptV1 } from "./charge-receipt.js";
import { chargeValue } from "./charge-receipt.js";
import { customerSourceOverage } from "./charge-settlement.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
export type CustomerSource = "bedrock_byo" | "openrouter";
export const validCustomerSource = (source: unknown): source is CustomerSource => source === "bedrock_byo" || source === "openrouter";
export const sourceStopKey = (source: CustomerSource): string => `SOURCESTOP#${source}`;
export interface SourceStop {
  source: CustomerSource; stopped: boolean; stopId?: string; stoppedAt?: number; callId?: string; costMicros?: number; heldMicros?: number; inFlight?: string;
  clearedBy?: string; clearedAt?: number; clearReason?: string;
}
export interface ClearSourceStop { iss: string; cid: string; source: CustomerSource; expectedStopId: string; actor: string; reason: string }
export function validClear(input: ClearSourceStop): boolean {
  return record(input) !== undefined && typeof input.iss === "string" && input.iss.length > 0 && input.iss.length <= 2048 && COMPANY.test(input.cid) && validCustomerSource(input.source) && typeof input.expectedStopId === "string" && input.expectedStopId.length > 0 && input.expectedStopId.length <= 128 && typeof input.actor === "string" && /^arn:aws(?:-us-gov|-cn)?:iam::[0-9]{12}:user\/[A-Za-z0-9+=,.@_/-]{1,128}$/u.test(input.actor) && typeof input.reason === "string" && input.reason.trim().length > 0 && input.reason.length <= 1000 && ![...input.reason].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
export function receiptCustomerSource(r: ChargeReceiptV1 | undefined): CustomerSource | undefined {
  return r?.billing !== "external_provider" ? undefined : r.model.provider === "bedrock" ? "bedrock_byo" : r.model.provider === "openrouter" ? "openrouter" : undefined;
}
export function stoppedBy(r: ChargeReceiptV1 | undefined, now: number): SourceStop | undefined {
  const source = receiptCustomerSource(r);
  if (source === undefined || !customerSourceOverage(r)) return undefined;
  return { source, stopped: true, stopId: `${r!.callId}:${r!.revision}`, stoppedAt: now, callId: r!.callId, costMicros: chargeValue(r!.amountMicros)!, heldMicros: chargeValue(r!.originalReservationMicros)! };
}
/** A malformed source row fails closed; no month or TTL belongs on this record. */
export function readSourceStop(value: unknown, source: CustomerSource): SourceStop | undefined {
  if (value === undefined) return undefined;
  const v = record(value);
  if (v === undefined || v.source !== source || typeof v.stopped !== "boolean" || (v.inFlight !== undefined && typeof v.inFlight !== "string") || (v.stopped && (typeof v.stopId !== "string" || !whole(v.stoppedAt)))) throw new Error("source stop unavailable");
  return v as unknown as SourceStop;
}
