// Part of the broker, DR7 slice A: `GET /v1/internal/design-review/packet?slot=<key slot>`, the one route a design-review worker reads a reviewer's packet from.
//
// The worker is not trusted with what it reads or with which reviewer it is. This route therefore (security S1 to S5):
//   - accepts only a callback capability whose actions include `design-review-packet`, a purpose of its own (a `model-access` capability alone is refused);
//   - serves only a live design-review operation: it exists, its fence matches, it is not over, it is the plan-check mode, and it carries the binding the broker stored when it dispatched it;
//   - looks the slot up in the STORED binding's reviewers (the merge step reads no packet; an unknown or malformed slot gets the same fixed refusal);
//   - serves the packet the broker STORED for that slot, byte for byte, after checking it hashes to the digest the binding carries (it never rebuilds one);
//   - answers the contract's delivery fields only, at most 2 MB, never cached, and refuses once the round is recorded on the task.
// One capability can read every reviewer's slot; keeping reviewers apart is a property of the worker's code, proven only by the proxy's first-call record (DR-FU2).
import { DesignReviewBindingSchema, PACKET_DELIVERY_BYTES_MAX, PacketDeliverySchema, agentXError, packetDigestOf, type DesignReviewBinding } from "@agentx/contracts";
import { TERMINAL, getItem, requireOperation, type CallbackClaims, type OperationRecord } from "../cancellation.js";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { readSlotPacket } from "../../design-review/packet-store.js";
import { bindingSlotOf } from "../../design-review/slot-keys.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { verifyCapability } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** The one text every refusal about the slot, the binding or the round carries: it says nothing of which check failed. */
const REFUSED = "this operation cannot read that packet";

/** The binding stored on a live design-review operation, or a refusal. */
export function storedBindingOf(operation: OperationRecord): DesignReviewBinding {
  if (operation.kind !== "task" || operation.workflowMode !== "PLAN_CRITIQUE" || operation.designReview === undefined) throw agentXError("FORBIDDEN", REFUSED);
  const parsed = DesignReviewBindingSchema.safeParse(operation.designReview);
  if (!parsed.success) throw agentXError("FORBIDDEN", REFUSED);
  return parsed.data;
}

/** Whether the task already holds this round's record. A task that cannot be read counts as recorded (fail closed). */
async function roundRecorded(dependencies: AwsBrokerDependencies, operation: OperationRecord, round: number): Promise<boolean> {
  const pointer = await getItem<DeveloperTaskPointerRecord>(dependencies, taskPointerKey(operation.workspaceId));
  if (pointer === undefined) return true;
  const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(pointer.taskId));
  if (task === undefined || task.orgId !== operation.orgId) return true;
  return (task.workflow?.designReview?.rounds ?? []).some((recorded) => recorded.round === round);
}

export async function handleDesignReviewPacket(dependencies: AwsBrokerDependencies, request: AdaptedHttpRequest) {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("AUTH_REQUIRED", "callback capability is required");
  let claims: CallbackClaims;
  try { claims = verifyCapability(dependencies, token, "design-review-packet"); }
  catch { throw agentXError("AUTH_REQUIRED", "invalid callback capability"); }
  const operation = await requireOperation(dependencies, claims.workspaceId, claims.operationId);
  if (operation.fence !== claims.fence || operation.id !== claims.operationId || operation.workspaceId !== claims.workspaceId || operation.entityType !== "OPERATION") throw agentXError("STALE_FENCE", "callback operation binding is stale");
  if (TERMINAL.has(operation.status)) throw agentXError("STALE_FENCE", "terminal operations cannot read a packet");
  const binding = storedBindingOf(operation);
  const orgId = operation.orgId;
  if (orgId === undefined) throw agentXError("FORBIDDEN", REFUSED);
  // Reviewer slots only: the merge step is sent no packet.
  const asked = new URL(request.path, "https://agentx.invalid").searchParams.get("slot");
  const slot = bindingSlotOf(binding, asked);
  const reviewer = slot?.purpose === "reviewer" ? binding.reviewers.find((entry) => entry.keySlot === slot.keySlot) : undefined;
  if (reviewer === undefined) throw agentXError("FORBIDDEN", REFUSED);
  if (await roundRecorded(dependencies, operation, binding.round)) throw agentXError("FORBIDDEN", REFUSED);

  const stored = await readSlotPacket(dependencies, orgId, operation.id, binding.round, reviewer.keySlot);
  if (stored === undefined) throw agentXError("FORBIDDEN", REFUSED);
  // What is served must be the packet the binding names: the stored text parses as the delivery contract, is the reviewer's role, and hashes to the binding's digest.
  let delivery: ReturnType<typeof PacketDeliverySchema.parse>;
  try { delivery = PacketDeliverySchema.parse(JSON.parse(stored.text)); } catch { throw agentXError("FORBIDDEN", REFUSED); }
  if (delivery.role !== reviewer.role || packetDigestOf(delivery) !== reviewer.packetDigest || Buffer.byteLength(stored.text, "utf8") > PACKET_DELIVERY_BYTES_MAX) throw agentXError("FORBIDDEN", REFUSED);

  console.log(JSON.stringify({ component: "broker", event: "design_review.packet_served", operationId: operation.id, slot: reviewer.keySlot, digest: reviewer.packetDigest }));
  // The stored text is the answer, as it is: no wrapper, no request id (the worker reads it with a strict schema).
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: stored.text };
}
