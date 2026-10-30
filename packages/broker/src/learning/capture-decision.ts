// RED stub: the real module lands in the next commit.
import type { TaskComment } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";

export interface SendBackInput { caller: DeveloperCaller; taskId: string; project: string; requestId: string; reason: string; included: readonly TaskComment[] }
export interface SendBackOutcome { created: string[] }
export const sendBackSourceKey = (taskId: string, requestId: string): string => `decision#${taskId}#${requestId}`;
export async function captureSendBack(_deps: DeveloperTaskRouteDependencies, _input: SendBackInput): Promise<SendBackOutcome> { return { created: [] }; }
export async function captureSendBackQuietly(_deps: DeveloperTaskRouteDependencies, _input: SendBackInput): Promise<void> { return; }
