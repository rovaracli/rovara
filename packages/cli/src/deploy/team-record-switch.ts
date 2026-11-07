// UX-4b: the Team record as a normal install setting. Its storage (table, vector and lake buckets, schedules) is built at synth time by the CDK context `agentxTeamRecord=enabled` and its five
// storage options `agentxTeamRecord<Option>` (infra/lib/team-record-wiring.ts, team-record-edition.ts), so the choice AND the options are recorded here, in the environment's own SSM folder, and every
// cdk command (init, upgrade, diff, the declared-parameter synth) passes them back. Before this record existed nothing passed the context, so an `agentx upgrade` synthesized the control plane
// without the record. An older CLI still does: its upgrade's data guard refuses the removal (docs/day-two.md). Once built, `agentx config set teamRecord.enabled 0` PAUSES the record through
// the stack parameter: erasure, removals and expiry keep running, and the data is kept.
import { agentXError, environmentSettingsPrefix } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";

/** The record's own parameter, beside the environment settings (a separate value so an older CLI, whose settings schema is strict, still reads the settings). */
export const teamRecordSwitchName = (env: string): string => `${environmentSettingsPrefix(env)}team-record`;

/** The stack parameter (control plane) that pauses or resumes the built record, keeping its storage either way. */
export const TEAM_RECORD_PARAMETER = "TeamRecordEnabled";

/** The storage options the synth reads (`agentxTeamRecord<Name>`), by the names a person types. Absent means the synth's default. */
export const TEAM_RECORD_OPTIONS = { embeddingModelId: "EmbeddingModelId", kmsKeyArn: "KmsKeyArn", lake: "Lake", athenaUsers: "AthenaUsers", enterpriseWorkspaceId: "EnterpriseWorkspaceId" } as const;
export type TeamRecordOptionName = keyof typeof TEAM_RECORD_OPTIONS;
export type TeamRecordOptions = Partial<Record<TeamRecordOptionName, string>>;

/** What is recorded: whether the record is on, and the options a person confirmed (`default` is an empty set). `options` absent: nobody has confirmed them yet. */
export interface TeamRecordRecord { enabled: boolean; options?: TeamRecordOptions }

const OPTION_VALUE = /^[A-Za-z0-9:/._@,+=-]{1,1000}$/u;
const fixText = (env: string) => `agentx --env ${env} config set teamRecord.options default (Rovara's defaults), or name them: embeddingModelId=<id>;kmsKeyArn=<arn>;lake=true|false;athenaUsers=<arn,arn>;enterpriseWorkspaceId=<id>`;

/** The options as typed: `default`, or `name=value` pairs separated by `;`. A name it does not know, or a value with characters a context value never needs, is refused. */
export function parseTeamRecordOptions(value: string, env: string): TeamRecordOptions {
  const text = value.trim();
  if (text === "default") return {};
  const options: TeamRecordOptions = {};
  for (const part of text.split(";").map((piece) => piece.trim()).filter((piece) => piece !== "")) {
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at).trim();
    const raw = at < 0 ? "" : part.slice(at + 1).trim();
    if (!Object.hasOwn(TEAM_RECORD_OPTIONS, name)) throw agentXError("CONFIG_INVALID", `teamRecord.options: unknown option ${JSON.stringify(name.slice(0, 40))}; use ${fixText(env)}; nothing changed`);
    if (!OPTION_VALUE.test(raw)) throw agentXError("CONFIG_INVALID", `teamRecord.options: ${name} needs a value; nothing changed`);
    if (name === "lake" && raw !== "true" && raw !== "false") throw agentXError("CONFIG_INVALID", "teamRecord.options: lake is true or false; nothing changed");
    options[name as TeamRecordOptionName] = raw;
  }
  if (Object.keys(options).length === 0) throw agentXError("CONFIG_INVALID", `teamRecord.options: give the options, or default; use ${fixText(env)}; nothing changed`);
  return options;
}

/**
 * What the install has on record, or undefined when nothing is recorded. A value that does not read refuses: a typo must never read as off, which would drop the record at the next upgrade. The first
 * form this lane wrote (the bare word `enabled`) carried no options, so it is refused with the fix: the options must be confirmed before a deploy synthesizes the record.
 */
export async function readTeamRecordRecord(store: ParameterStore, env: string): Promise<TeamRecordRecord | undefined> {
  const stored = await store.get(teamRecordSwitchName(env));
  if (stored === undefined) return undefined;
  if (stored.value === "enabled") return { enabled: true };
  let parsed: unknown;
  try { parsed = JSON.parse(stored.value); } catch { parsed = undefined; }
  const record = parsed as { v?: unknown; enabled?: unknown; options?: unknown } | undefined;
  const optionsOk = record?.options === undefined || (typeof record.options === "object" && record.options !== null && Object.entries(record.options).every(([name, value]) => Object.hasOwn(TEAM_RECORD_OPTIONS, name) && typeof value === "string" && OPTION_VALUE.test(value)));
  if (record === undefined || record.v !== 1 || typeof record.enabled !== "boolean" || !optionsOk) throw agentXError("CONFIG_INVALID", `${teamRecordSwitchName(env)} can't be read; fix or delete it before deploying`);
  return { enabled: record.enabled, ...(record.options === undefined ? {} : { options: record.options as TeamRecordOptions }) };
}

export async function writeTeamRecordRecord(store: ParameterStore, env: string, record: TeamRecordRecord): Promise<void> {
  await store.put(teamRecordSwitchName(env), JSON.stringify({ v: 1, enabled: record.enabled, ...(record.options === undefined ? {} : { options: record.options }) }));
}

/**
 * What a deploy synthesizes with: undefined when the record is not on; its confirmed options when it is. A record that is on but whose options nobody confirmed refuses with the fix: synthesizing
 * without them could replace the table or its key.
 */
export async function readTeamRecordSwitch(store: ParameterStore, env: string): Promise<TeamRecordOptions | undefined> {
  const record = await readTeamRecordRecord(store, env);
  if (record === undefined || !record.enabled) return undefined;
  if (record.options === undefined) throw agentXError("CONFIG_INVALID", `The Team record is recorded as on for ${env}, but its storage options are not confirmed, so nothing was deployed. Run ${fixText(env)}, then try again.`);
  return record.options;
}

/** The synth context of the record and its options, as `-c` pairs. */
export function teamRecordContextArguments(options: TeamRecordOptions): string[] {
  const args = ["-c", "agentxTeamRecord=enabled"];
  for (const [name, suffix] of Object.entries(TEAM_RECORD_OPTIONS)) {
    const value = options[name as TeamRecordOptionName];
    if (value !== undefined) args.push("-c", `agentxTeamRecord${suffix}=${value}`);
  }
  return args;
}

/** The hint an upgrade refusal carries when the data it would drop is the Team record's, and only when nothing records the record as on (an install built with the context by hand). */
export function teamRecordRefusalHint(env: string, logicalIds: readonly string[], recordedOn: boolean): string | undefined {
  if (recordedOn || !logicalIds.some((id) => /^TeamRecord/u.test(id))) return undefined;
  return `This install's Team record was built without being recorded as on. Run ${fixText(env)} and agentx --env ${env} config set teamRecord.enabled 1 to keep it, then run agentx upgrade again.`;
}

/** For the upgrade's hint: true when the record is recorded as on, or when the record can't be read (unknown is never "unrecorded", so no hint is shown then). */
export async function teamRecordRecordedOrUnknown(store: ParameterStore, env: string): Promise<boolean> {
  try { return (await readTeamRecordRecord(store, env))?.enabled === true; } catch { return true; }
}
