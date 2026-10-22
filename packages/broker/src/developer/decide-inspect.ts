// Plan 3, Task 21a-wiring: the sign-in function asks the broker whether a member may decide an approval (stub until the implementation commit).
import { z } from "zod";
import type { DecideKinds } from "./decide-kinds.js";

export const DecideInspectRequestSchema = z.object({ kind: z.literal("decide-inspect") }).strict();
export type DecideInspectRequest = { kind: "decide-inspect"; orgId: string; developerId: string; approvalId: string };
export type DecideInspectAnswer = { status: "not_found" } | { status: "forbidden"; who: string } | { status: "decided"; by: string; at: string } | { status: "open" };

export const isDecideInspectEvent = (_event: unknown): _event is DecideInspectRequest => false;
export async function answerDecideInspect(_kinds: DecideKinds, _event: unknown): Promise<{ statusCode: number; body: unknown }> { throw new Error("not implemented"); }
export function brokerDecideKinds(_input: { invoke(request: DecideInspectRequest): Promise<unknown> }): DecideKinds { throw new Error("not implemented"); }
export function lambdaInspectInvoker(_lambda: { send(command: unknown, options?: unknown): Promise<unknown> }, _functionName: string): (request: DecideInspectRequest) => Promise<unknown> { throw new Error("not implemented"); }
