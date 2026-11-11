// Enterprise foundations E2: the edition of an install, as `rovara init`, `rovara deploy` and `rovara upgrade` carry it into the CDK synth.
//
// The foundation stack records an Enterprise install's edition in `/agentx/<env>/edition` (infra/lib/production-foundation.ts). An install's edition is set once:
//  - a deploy that asks for another edition than the recorded one is refused (`assertEditionUnchanged`);
//  - a deploy that asks for none but finds a record uses the recorded one, so a redeploy never drops the stamp from the functions (that would turn an Enterprise
//    install into one with no edition gates, silently);
//  - an unreadable record is refused, never read as "no record".
import { EditionSchema, agentXError, type Edition } from "@rovara-code/contracts";
import { assertEditionUnchanged, editionAtSynth } from "@agentx/cloud-contracts";
import { CLOUD_NEEDS_CDK_MESSAGE } from "./answer-schemas.js";
import type { ParameterStore } from "../environments/parameter-store.js";

export const editionRecordName = (env: string): string => `/agentx/${env}/edition`;

export const EDITION_NEEDS_CDK_MESSAGE = "The prebuilt templates carry no edition. An install with an edition (Enterprise) must be synthesized from source: use --engine cdk with --source.";

/** The backup of the record, written before the record is ever taken out of the way (see `adoptOrphanedEditionRecord`). No stack owns it. */
export const editionBackupName = (env: string): string => `/agentx/${env}/edition-backup`;

const parsedEdition = (value: string, name: string, env: string): Edition => {
  const parsed = EditionSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `The edition recorded for environment ${env} (${name}) is not "enterprise" or "public"; fix or remove that parameter before deploying.`);
  return parsed.data;
};

/**
 * The edition the install has on record: the foundation's record, or its backup while the record is out of the way (an interrupted deploy). Both present must agree,
 * and a value that is not an edition refuses: while either exists the edition cannot be steered to another.
 */
export async function readRecordedEdition(store: ParameterStore, env: string): Promise<Edition | undefined> {
  const [record, backup] = await Promise.all([store.get(editionRecordName(env)), store.get(editionBackupName(env))]);
  const recorded = record === undefined ? undefined : parsedEdition(record.value, editionRecordName(env), env);
  const backedUp = backup === undefined ? undefined : parsedEdition(backup.value, editionBackupName(env), env);
  if (recorded !== undefined && backedUp !== undefined && recorded !== backedUp) throw agentXError("CONFIG_INVALID", `The edition record and its backup for environment ${env} disagree; fix them before deploying.`);
  return recorded ?? backedUp;
}

/**
 * The edition a deploy of `env` synthesizes with: the explicit request, else the recorded one, else none (today's behaviour). Refuses a changed edition,
 * an edition that disagrees with the hosted cloud, and an edition on the prebuilt-templates engine (which cannot carry one).
 */
export async function resolveDeployEdition(input: { store: ParameterStore; env: string; engine: "templates" | "cdk"; cloud: boolean; requested?: Edition | undefined }): Promise<Edition | undefined> {
  const recorded = await readRecordedEdition(input.store, input.env);
  if (input.requested !== undefined) assertEditionUnchanged(recorded, input.requested);
  const effective = input.requested ?? recorded;
  // The same cross-checks the synth makes (Enterprise inside the hosted cloud, Public outside it), before anything is built or deployed.
  editionAtSynth({ explicit: effective, cloud: input.cloud });
  if (effective !== undefined && input.engine === "templates") throw agentXError("CONFIG_INVALID", effective === "enterprise" ? EDITION_NEEDS_CDK_MESSAGE : CLOUD_NEEDS_CDK_MESSAGE);
  return effective;
}

/**
 * Fix round 2 (N-1). The edition record is retained when its stack goes (or when a raw deploy without the edition drops it from the template). A later deploy that names the
 * edition again would then meet a parameter of that name that its stack no longer owns, and CloudFormation refuses to create it. Just before the foundation deploys,
 * a record the foundation stack does not own is removed so that the deploy re-creates it with the same value (the edition is Enterprise either way: `resolveDeployEdition`
 * has already refused any other). While it is gone the broker and the sign-in server refuse to serve (an Enterprise stamp needs its record), which is the safe side.
 * [verify] CloudFormation's create-time behaviour for an existing named SSM parameter, and the window above, in the install proof (N10).
 */
export async function adoptOrphanedEditionRecord(input: {
  store: ParameterStore;
  env: string;
  edition: Edition | undefined;
  /** The physical ids of the foundation stack's resources, or undefined when the stack does not exist. */
  foundationResources: () => Promise<readonly string[] | undefined>;
}): Promise<"owned" | "adopted" | "none"> {
  if (input.edition !== "enterprise") return "none";
  const name = editionRecordName(input.env);
  const record = await input.store.get(name);
  if (record === undefined) return "none";
  const owned = await input.foundationResources();
  if (owned?.includes(name) === true) return "owned";
  // The backup first, then the removal: whatever happens next the edition is on record in one of the two, and nothing can steer the install to another.
  await input.store.put(editionBackupName(input.env), record.value);
  await input.store.delete(name);
  return "adopted";
}

/**
 * After the foundation deploy that followed an adoption. Completed: the stack owns the record again, so the backup is removed (only when the record is back and says the
 * same). Not completed: the record is put back from the backup, so a failed deploy leaves the install as it was. A process that is killed does neither; the backup stays and
 * is read as the record by the next deploy and by the broker.
 */
export async function settleEditionRecord(input: { store: ParameterStore; env: string; completed: boolean }): Promise<void> {
  const backup = await input.store.get(editionBackupName(input.env));
  if (backup === undefined) return;
  const record = await input.store.get(editionRecordName(input.env));
  if (input.completed) {
    if (record?.value === backup.value) await input.store.delete(editionBackupName(input.env));
    return;
  }
  if (record === undefined) await input.store.put(editionRecordName(input.env), backup.value);
}
