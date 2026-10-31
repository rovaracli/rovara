// Enterprise foundations, task I3: builds the attribution (`contracts/attribution.ts`) for a task from the broker's own records, and nothing else.
//
// Who is named in the DESCRIPTION: the person who asked for the work (the task's requester) and the person who approved its plan. Each is read now, not copied from when the task
// started, so a person who has since been ERASED is never named: the description says "a former member". A person who merely left keeps their name (owner ruling,
// 2026-10-31). A person who was never one of this org's people, or whose record cannot be read, is "a former member" too: when in doubt the person is not named. The name is the display name the company already shows (never an email address), cut down to
// the characters a git trailer and a description can carry without any markup, mention or second line.
import { randomBytes } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  ATTRIBUTION_NAME_MAX, ATTRIBUTION_REF_LENGTH, ActingAttributionSchema, AttributionPersonSchema, erasedPersonKey, orgMemberKey, orgRemovedKey,
  type ActingAttribution, type AttributionPerson, type OrgId,
} from "@agentx/contracts";
import { readChosenName } from "../developer/chosen-name.js";
import { safeDisplayName } from "../developer/person-name.js";
import type { AttributionLinkStore } from "./links.js";

const DEVELOPER_ID = /^[a-f0-9]{64}$/u;

export interface AttributionReader {
  /**
   * The display name of a person who is, or was, a member of THIS org (owner ruling, 2026-10-31: a member who left but was not erased keeps their name in the description; only
   * erasure replaces it). Undefined for someone who never was one of this org's people. Throws when it cannot tell.
   */
  memberName(orgId: OrgId, developerId: string): Promise<string | undefined>;
  /** Whether the person has been erased. Throws when it cannot tell. */
  isErased(orgId: OrgId, developerId: string): Promise<boolean>;
}

export interface ResolvedAttribution {
  attribution: ActingAttribution;
  /** The full person ids of those named, for the audit event's `related`: the link from the host's change request to the Rovara people. Includes people shown as "a former member". */
  relatedIds: string[];
}

/** A display name cut to what the trailer and description can carry: letters, marks, digits, spaces and . , ' - . Whatever else it held is dropped; nothing left is no name. */
export function attributionNameOf(displayName: string, developerId: string): string {
  const safe = safeDisplayName(displayName, developerId);
  const plain = safe.normalize("NFC").replace(/[^\p{L}\p{M}\p{N} .,'’-]/gu, "").replace(/ {2,}/gu, " ").trim().replace(/^[^\p{L}\p{M}\p{N}]+/u, "");
  const cut = Array.from(plain).slice(0, ATTRIBUTION_NAME_MAX).join("").trim();
  const ended = cut.replace(/[^\p{L}\p{M}\p{N}.]+$/u, "");
  return ended === "" ? "Member" : ended;
}

/** A fresh random reference: 8 random bytes. It is not derived from anything about the person; the link row is the only thing that connects it to them. */
export const randomAttributionRef = (): string => randomBytes(ATTRIBUTION_REF_LENGTH / 2).toString("hex");

interface Naming { person: AttributionPerson; named: boolean }

async function personOf(reader: AttributionReader, orgId: OrgId, developerId: string | undefined): Promise<Naming | undefined> {
  if (developerId === undefined) return undefined;
  // An id that is not a person id is no one: the line is left out rather than naming something unchecked.
  if (!DEVELOPER_ID.test(developerId)) return undefined;
  const former: Naming = { person: { state: "former" }, named: false };
  try {
    if (await reader.isErased(orgId, developerId)) return former;
    const name = await reader.memberName(orgId, developerId);
    if (name === undefined) return former;
    // The reference is made later, when the link row is stored; this placeholder only has to pass the schema.
    const person = { state: "named", name: attributionNameOf(name, developerId), ref: "0".repeat(ATTRIBUTION_REF_LENGTH) } as const;
    return AttributionPersonSchema.safeParse(person).success ? { person, named: true } : former;
  } catch {
    // Unreadable is not "named": a person who may have been erased is never written to a host because a read failed.
    return former;
  }
}

/**
 * The attribution of a task. `requesterId` is who asked (absent for an automatic run); `approverId` is who approved the plan (absent when none did). The audit link is only set when the
 * caller has one. A named person gets a fresh random reference whose link row is stored BEFORE the attribution is returned (a failure to store it throws: the commit is not written with a
 * reference that leads nowhere to an erasable row, and the publication retries). The result always parses as `ActingAttributionSchema`.
 */
export async function resolveActingAttribution(
  reader: AttributionReader,
  links: AttributionLinkStore,
  input: { orgId: OrgId; taskId: string; requesterId?: string | undefined; approverId?: string | undefined; auditUrl?: string | undefined; now?: () => number; randomRef?: () => string },
): Promise<ResolvedAttribution> {
  const [requester, approver] = await Promise.all([personOf(reader, input.orgId, input.requesterId), personOf(reader, input.orgId, input.approverId)]);
  const makeRef = input.randomRef ?? randomAttributionRef;
  const createdAt = new Date((input.now ?? Date.now)()).toISOString();
  const stamp = async (naming: Naming | undefined, developerId: string | undefined, role: "requester" | "approver"): Promise<AttributionPerson | undefined> => {
    if (naming === undefined) return undefined;
    if (!naming.named || naming.person.state !== "named" || developerId === undefined) return naming.person;
    const ref = makeRef();
    await links.put(input.orgId, { ref, developerId, role, taskId: input.taskId, createdAt });
    return { ...naming.person, ref };
  };
  const [requesterPerson, approverPerson] = [await stamp(requester, input.requesterId, "requester"), await stamp(approver, input.approverId, "approver")];
  const draft = {
    ...(requesterPerson === undefined ? {} : { requester: requesterPerson }),
    ...(approverPerson === undefined ? {} : { approver: approverPerson }),
    ...(input.auditUrl === undefined ? {} : { auditUrl: input.auditUrl }),
  };
  const parsed = ActingAttributionSchema.safeParse(draft);
  // A bad audit link must not cost the change its attribution: the names stand and the link is left out.
  const attribution = parsed.success ? parsed.data : ActingAttributionSchema.parse({ ...draft, auditUrl: undefined });
  const relatedIds = [...new Set([input.requesterId, input.approverId].filter((id): id is string => id !== undefined && DEVELOPER_ID.test(id)))];
  return { attribution, relatedIds };
}

type DocumentClient = { send(command: unknown): Promise<unknown> };

/**
 * The reader over the install's tables: the org's member record (State table), the name the person chose (State table) or the name their sign-in record holds (sign-in table),
 * and the Team record's permanent erased markers.
 */
export function dynamoAttributionReader(input: { documentClient: DocumentClient; stateTable: string; signInTable: string; teamRecordTable: string }): AttributionReader {
  const get = async (tableName: string, key: { pk: string; sk: string }) =>
    (await input.documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  return {
    async memberName(orgId, developerId) {
      const member = await get(input.stateTable, orgMemberKey(orgId, developerId));
      const current = member?.orgId === orgId && member.developerId === developerId;
      // A person who left or was removed has the removal's tombstone in this org (the one the task paths read, R60); a person of another org, or of none, has neither.
      const departed = !current && (await get(input.stateTable, orgRemovedKey(orgId, developerId)))?.orgId === orgId;
      if (!current && !departed) return undefined;
      const chosen = await readChosenName(input.documentClient, input.stateTable, developerId);
      if (chosen !== undefined) return chosen;
      const record = await get(input.signInTable, { pk: `DEVELOPER#${developerId}`, sk: "META" });
      return typeof record?.displayName === "string" ? record.displayName : "";
    },
    async isErased(orgId, developerId) {
      return (await get(input.teamRecordTable, erasedPersonKey(orgId, { developerId }))) !== undefined;
    },
  };
}
