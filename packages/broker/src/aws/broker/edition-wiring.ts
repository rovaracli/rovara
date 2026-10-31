// Enterprise foundations E2: the edition of this install, read once at cold start from the deploy stamp (ROVARA_EDITION).
//
// The stamp is set by the CDK synth (infra/lib/edition-env.ts) on every function. It is the ONLY source: never a request, an org setting, the database or the old
// `cloud` flag. An install with no stamp is an existing install (it was deployed before editions): it keeps today's behaviour, which is "no edition gates", and it
// is never treated as Enterprise. A stamp that is present but wrong stops the process from starting.
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { EDITION_ENV_VAR, EditionSchema, agentXError, editionPolicy, resolveEdition, type EditionPolicy } from "@agentx/contracts";

/**
 * @param environment the process environment
 * @param cloud whether this install is the hosted cloud (the org resolver is configured); used only to cross-check the stamp, never to choose the edition
 * @returns the policy for the stamped edition, or undefined for an existing install with no stamp
 * @throws CONFIG_INVALID when the stamp is not exactly "enterprise" or "public" (an empty value included), or when it disagrees with the cloud flag
 */
export function installEditionPolicy(environment: Record<string, string | undefined>, cloud: boolean): EditionPolicy | undefined {
  const configured = environment[EDITION_ENV_VAR];
  if (configured === undefined) return undefined;
  const edition = resolveEdition({ configured, cloud, allowDerivedFromCloud: false });
  // The synth refuses these two combinations already; a process that meets one anyway has been deployed by hand or from another source, and must not run.
  if (edition === "enterprise" && cloud) throw agentXError("CONFIG_INVALID", `${EDITION_ENV_VAR} is "enterprise" but this install is the hosted cloud.`);
  if (edition === "public" && !cloud) throw agentXError("CONFIG_INVALID", `${EDITION_ENV_VAR} is "public" but this install is not the hosted cloud.`);
  return editionPolicy(edition);
}

// ---- the retained edition record (review I-2)

/** The SSM parameter the foundation keeps for an install that has an edition. */
export const editionRecordName = (env: string): string => `/agentx/${env}/edition`;
/** The backup the CLI keeps while it has the record out of the way (an interrupted deploy): while the record is missing it IS the edition on record. */
export const editionBackupName = (env: string): string => `/agentx/${env}/edition-backup`;

export const EDITION_STAMP_MISSING_MESSAGE = "This install has an edition on record, but this process was started without it. It will not serve until it is deployed with its edition.";
export const EDITION_STAMP_DIFFERS_MESSAGE = "This process's edition is not the edition this install has on record. It will not serve until it is deployed with the edition on record.";
export const EDITION_RECORD_UNREADABLE_MESSAGE = "This process could not read the edition this install has on record, so it will not serve.";

/**
 * A check, run before the first request of a process (and again until it has passed), that the process's edition stamp is the install's recorded edition. A raw
 * `cdk deploy` that loses the stamp, or one that names another edition, would otherwise turn an Enterprise install into one with no gates.
 *  - an Enterprise stamp needs a record that says Enterprise (no record, an unreadable record or another value refuses);
 *  - no stamp with a record refuses (the stamp was lost);
 *  - a stamp that differs from the record refuses;
 *  - no stamp and no record (the parameter does not exist) is an install deployed before editions: today's behaviour;
 *  - a record that cannot be READ (an error, not "not found") refuses, whatever the stamp.
 * A pass is remembered; a refusal is not, so a transient read error is tried again on the next request.
 */
export function createEditionGuard(input: {
  stamp: EditionPolicy["edition"] | undefined;
  /** The record's name, or undefined for an install with no named environment (nothing to check). */
  recordName: string | undefined;
  /** The backup's name: a record that is missing while the backup exists is that edition on record, not a legacy install. */
  backupName?: string | undefined;
  /** The record's value, or undefined when there is none. Throws when it cannot be read. */
  read: (name: string) => Promise<string | undefined>;
  log?: (entry: Record<string, unknown>) => void;
}): () => Promise<void> {
  let passed = input.recordName === undefined;
  return async () => {
    if (passed) return;
    const name = input.recordName!;
    let value: string | undefined;
    try {
      value = await input.read(name);
    } catch {
      // A read that FAILED (denied, throttled, down) is not "there is no record": the process cannot tell an install with an edition from one without, so it does not serve.
      // Only a parameter that does not exist (the reader answers undefined) is a legacy install.
      input.log?.({ event: "edition.record_unreadable", level: "error" });
      throw agentXError("RUNTIME_UNAVAILABLE", EDITION_RECORD_UNREADABLE_MESSAGE);
    }
    if (value === undefined && input.backupName !== undefined) {
      try {
        value = await input.read(input.backupName);
      } catch {
        input.log?.({ event: "edition.record_unreadable", level: "error" });
        throw agentXError("RUNTIME_UNAVAILABLE", EDITION_RECORD_UNREADABLE_MESSAGE);
      }
    }
    if (value === undefined) {
      if (input.stamp === "enterprise") throw agentXError("RUNTIME_UNAVAILABLE", EDITION_RECORD_UNREADABLE_MESSAGE);
      passed = true;
      return;
    }
    const parsed = EditionSchema.safeParse(value);
    if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", EDITION_RECORD_UNREADABLE_MESSAGE);
    if (input.stamp === undefined) throw agentXError("RUNTIME_UNAVAILABLE", EDITION_STAMP_MISSING_MESSAGE);
    if (parsed.data !== input.stamp) throw agentXError("RUNTIME_UNAVAILABLE", EDITION_STAMP_DIFFERS_MESSAGE);
    passed = true;
  };
}

/** Reads the record through SSM; a parameter that does not exist is `undefined`, any other failure throws. */
export function ssmEditionRecordReader(client: Pick<SSMClient, "send">): (name: string) => Promise<string | undefined> {
  return async (name) => {
    try {
      return (await client.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
    } catch (error) {
      if (error instanceof Error && error.name === "ParameterNotFound") return undefined;
      throw error;
    }
  };
}
