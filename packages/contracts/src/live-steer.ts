// Live steer: a person's message to a RUNNING step, delivered to the step's pi session within seconds (the note stays the durable record and the fallback).
// The broker sends one signed `steer` invocation to the worker that runs the step; the worker answers on the same request. Nothing here can carry a budget, a tool, a permission or an
// approval: the payload is strict, and the worker wraps the text so the model sees who sent it and what authority it has.
import { createHash } from "node:crypto";
import { z } from "zod";

/** A worker that lists this accepts the `steer` invocation; the broker sends it only to such a worker (an older one is never sent it, and the message stays a note). */
export const LIVE_STEER_FEATURE = "task.liveSteer.v1" as const;

/** The steps a message can reach while they run: the ones that read a person's notes at their start (planning and coding). Reviews, plan checks and checks never take one. */
export const LIVE_STEER_STEPS = ["UNDERSTAND", "PLAN", "IMPLEMENT"] as const;
export type LiveSteerStep = (typeof LIVE_STEER_STEPS)[number];

/**
 * What the message is to the agent. `owner_instruction`: it came from the task's owner, so it is an instruction as long as it stays inside the approved plan. `information`: it came from
 * anyone else with "can use", so it is context and never an instruction.
 */
export const LIVE_STEER_AUTHORITIES = ["owner_instruction", "information"] as const;
export type LiveSteerAuthority = (typeof LIVE_STEER_AUTHORITIES)[number];

/** The longest message text a live steer carries (the same bound as a task note). */
export const LIVE_STEER_TEXT_MAX_CHARS = 2_000;

export const LiveSteerPayloadSchema = z.object({
  /** The running operation whose session takes the message; any other operation (an earlier or later step) is `not_running`. */
  targetOperationId: z.string().uuid(),
  messageId: z.string().regex(/^msg_[0-9a-z]{20}$/),
  step: z.enum(LIVE_STEER_STEPS),
  authority: z.enum(LIVE_STEER_AUTHORITIES),
  /** Who sent it, as the model is told: a fixed word and a short id (never the name the person chose). */
  sender: z.string().regex(/^person p_[0-9a-f]{6}$/),
  text: z.string().min(1).max(LIVE_STEER_TEXT_MAX_CHARS),
}).strict();
export type LiveSteerPayload = z.infer<typeof LiveSteerPayloadSchema>;

/** What the worker answers on the same request: it took the message, nothing runs that step now, or the step has not opened its session yet (the broker asks again, a few times). */
export const LIVE_STEER_OUTCOMES = ["steered", "not_running", "not_ready"] as const;
export type LiveSteerOutcome = (typeof LIVE_STEER_OUTCOMES)[number];
export const LiveSteerAnswerSchema = z.object({ accepted: z.literal(true), outcome: z.enum(LIVE_STEER_OUTCOMES) }).passthrough();

/** The operation id of a message's live steer: the same message always gives the same id, so a repeat is one delivery (the worker's journal, the outbox item and the delivery mark all key on it). */
export function liveSteerOperationId(messageId: string): string {
  const bytes = createHash("sha256").update(`live-steer\0${messageId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
