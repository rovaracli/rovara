// Smart intake is Code's since the vendor pin f5a14c386 (code/next, public PR #492 and the thread-continuation lanes): the small-talk check, the classifier's instruction, the decision 134
// auto-start contract and the thread-continuation records all come from @rovara-code/contracts. This file was Cloud's byte-for-byte bridge copy until then (checked against the pinned
// request-intake.ts and slack-routing.ts when the bridge was retired); it stays only so the names Cloud's code already imports from @agentx/cloud-contracts keep resolving.
// `SMART_INTAKE_ROUTER_SYSTEM_PROMPT` is Code's `REQUEST_ROUTER_SYSTEM_PROMPT` under Cloud's older name. tests/contract/smart-intake-bridge.test.ts still pins the cases.
import { REQUEST_ROUTER_SYSTEM_PROMPT } from "@rovara-code/contracts";

export {
  QUICK_AUTO_START_SKIPS,
  QuickAutoStartRequestSchema,
  QuickAutoStartResultSchema,
  SLACK_INTAKE_RECORD_SECONDS,
  SMALL_TALK_MAX_CHARS,
  THREAD_CONTINUATION_KEEP_SECONDS,
  THREAD_CONTINUATION_SECONDS,
  WORKFLOW_STOP_ACTION,
  isThreadContinuation,
  quickAutoStartedMessage,
  smallTalkOf,
  smallTalkReply,
  threadContinuationItems,
  threadContinuationKey,
  threadContinuationOf,
  threadContinuationPersonItem,
  threadContinuationThreadUpdate,
} from "@rovara-code/contracts";
export type { ContinuationThread, QuickAutoStartRequest, QuickAutoStartResult, QuickAutoStartSkip, SmallTalkKind, SmallTalkPlace } from "@rovara-code/contracts";

export const SMART_INTAKE_ROUTER_SYSTEM_PROMPT: string = REQUEST_ROUTER_SYSTEM_PROMPT;
