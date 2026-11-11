// Design review stage, DR7 slice B (DR-REVIEW-dr7a m1, security S6): what the capability of a design-review operation may do. An ALLOWLIST: the packet of its own slots and a model key by slot, and nothing else. The ordinary
// plan-check capability would also carry the task's model-fallback authority, a person's ChatGPT token, the E2E, feedback and pull-request actions and the connector and context tools, none of which a reviewer may use (a key by any
// other channel would not be the slot's key, and a tool would let the packet's untrusted text reach for more). The handlers refuse these actions for a design-review operation as well.
import type { DesignReviewBinding } from "@rovara-code/contracts";
import type { CapabilityOptions } from "../aws/cancellation.js";

/** The options for `issueCapability`: the given ones unchanged for an operation without a binding (the plan check as it was), else only the packet and the model key. */
export function designReviewCapability(binding: DesignReviewBinding | undefined, options: CapabilityOptions): CapabilityOptions {
  if (binding === undefined) return options;
  return { modelAccess: options.modelAccess === true, designReviewPacket: true };
}
