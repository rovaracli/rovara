// Internal addresses a company's tasks may reach (owner decision 123): what a worker launch carries. The provisioner's launch step reads the workspace's company, that company's APPROVED list, checks every entry
// again (a rule may have tightened since it was approved), and adds the list to the worker's user data as AGENTX_PRIVATE_ADDRESSES. Nothing else carries it, so:
//   - company isolation: a worker belongs to one workspace, a workspace to one company (its stored `orgId`); the list read is that company's and no other. A workspace that names no company gets no list.
//   - named environments only: the wall that reads the list is stage 2's (boot-stage2.sh). The legacy single-file boot has no such step, and its launch never carries a list.
//   - a launch reads the list once. An addition applies to workers started after it; a removal also recycles the company's running workers (owner decision 128, session-reaper.ts). The worker resolves names again at
//     every start of its worker container (boot-stage2.sh `rovara-private-allow`), and pins what it got until the next one.
//   - the operator's kill switch (review L4): the SSM parameter `<worker settings prefix>private-addresses-off` set to `true` makes every launch carry no list (session-steps.ts). Unset: lists apply.
// The vendored Code boot configuration (`Ec2WorkerBootConfigSchema`) is strict and read-only here, so the setting is added to the rendered script, after its header, in the same `export NAME='value'` form; the value
// is held to PRIVATE_ADDRESSES_BOOT_PATTERN (no quote, space or shell character can be in it).
import { gzipSync } from "node:zlib";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { EC2_USER_DATA_MAX_BYTES, OrgIdSchema, ec2WorkerBootScript, ec2WorkerUserData, type Ec2WorkerBootConfig } from "@rovara-code/contracts";
import {
  PRIVATE_ADDRESSES_BOOT_PATTERN, PRIVATE_ADDRESSES_BOOT_VARIABLE, PRIVATE_ADDRESS_CIDRS_BOOT_PATTERN, PRIVATE_ADDRESS_NOTHING_OPEN, PRIVATE_ADDRESS_RESERVED_BOOT_VARIABLE, PRIVATE_ADDRESS_ROUTED_BOOT_VARIABLE, checkPrivateAddress,
  type PrivateAddressInstall,
} from "@agentx/cloud-contracts";
import { readPrivateAddresses, type PrivateAddressTable } from "../org/private-addresses.js";

/** What a launch carries for the internal address list: the approved entries, the list revision they were read at, and the install's reserved and routed ranges (the worker repeats the range checks with them). */
export interface PrivateAddressLaunch {
  entries: string[];
  /** The revision of the company's list as this launch read it (review L2): recorded for the reaper, which recycles a worker whose revision is older than a removal's. A launch that opens nothing (no list, an empty one) is PRIVATE_ADDRESS_NOTHING_OPEN. */
  revision: number;
  reservedCidrs: string[];
  routedCidrs: string[];
}
/** A launch that carries no list: nothing is opened, so no removal can ever concern this worker. */
export const NO_PRIVATE_ADDRESS_LIST: PrivateAddressLaunch = { entries: [], revision: PRIVATE_ADDRESS_NOTHING_OPEN, reservedCidrs: [], routedCidrs: [] };

/**
 * The approved entries a worker of this workspace is launched with: its company's list, each entry checked again (a rule may have tightened since it was approved, and the install's reserved and routed ranges apply);
 * an entry that no longer passes is left out. An install with no routed private ranges (`install` undefined: a hosted install, or Enterprise without routed ranges) has nowhere private to go: no list is sent and none is read (review L3).
 */
export async function launchPrivateAddresses(table: PrivateAddressTable, workspaceId: string, install: PrivateAddressInstall | undefined): Promise<PrivateAddressLaunch> {
  if (install === undefined || (install.routedCidrs ?? []).length === 0) return NO_PRIVATE_ADDRESS_LIST;
  const workspace = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const org = OrgIdSchema.safeParse(workspace?.orgId);
  if (workspace === undefined || workspace.id !== workspaceId || !org.success) return NO_PRIVATE_ADDRESS_LIST;
  let list: Awaited<ReturnType<typeof readPrivateAddresses>>;
  try {
    list = await readPrivateAddresses(table, org.data);
  } catch (error) {
    // Fail closed, loudly, for this company alone: its launch fails with words an operator can act on (an admin saves the list again), and no worker boots with a list it was not meant to have. Other companies' launches
    // read their own rows and are untouched. Ids and the error's name only.
    console.error(JSON.stringify({ component: "session-steps", event: "private_addresses.list_unreadable", level: "error", orgId: org.data, workspaceId, errorName: error instanceof Error ? error.name : "unknown" }));
    throw error;
  }
  const entries = list.entries.flatMap((entry) => {
    const checked = checkPrivateAddress(entry, install);
    return checked.ok && checked.entry === entry ? [entry] : [];
  });
  return { entries, revision: entries.length === 0 ? PRIVATE_ADDRESS_NOTHING_OPEN : list.revision, reservedCidrs: [...(install.reservedCidrs ?? [])], routedCidrs: [...(install.routedCidrs ?? [])] };
}

/**
 * Review L4 / L1: the operator's kill switch, read from the SSM parameter `name`. True: every launch carries no list. FAIL CLOSED: only a parameter that is not there (ParameterNotFound) or whose value is exactly `false`
 * lets lists apply; `true`, any other value, and a read that fails all mean off (a worker then boots with nothing opened rather than with a list the operator may have turned off). The odd cases are logged, never the value.
 */
export async function readPrivateAddressesOff(ssm: { send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }> }, name: string, log: (line: string) => void = console.error): Promise<boolean> {
  try {
    const value = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
    if (value === "false") return false;
    if (value !== "true") log(JSON.stringify({ component: "session-steps", event: "private_addresses.kill_switch_unreadable", level: "error", reason: "value" }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ParameterNotFound") return false;
    log(JSON.stringify({ component: "session-steps", event: "private_addresses.kill_switch_unreadable", level: "error", errorName: error instanceof Error ? error.name : "unknown" }));
    return true;
  }
}

/** M1 (owner decision): the worker's TS-L self-test is switched on by this launch variable (boot-stage2.sh `tsl_selftest_gate` reads exactly `1`), and only a STAGING launch may carry it. */
export const TSL_SELFTEST_BOOT_VARIABLE = "AGENTX_TSL_SELFTEST";
/** The SSM parameter (under the worker settings prefix) that the operator sets to `true` to turn the self-test on for staging launches. Absent means off. */
export const TSL_SELFTEST_PARAMETER = "tsl-selftest";
/** The only worker settings prefix whose launches may carry the self-test variable. */
export const TSL_SELFTEST_ALLOWED_PREFIX = "/agentx/staging/";

/**
 * M1: the operator's switch for the TS-L worker self-test, read from the SSM parameter `name`. FAIL CLOSED the other way round from the kill switch: ONLY the exact value `true` is on. A parameter that is not there
 * (ParameterNotFound) or says `false` is off without a word; any other value and any failed read are off and logged (an event name and the error's name or the word `value`, never the value).
 */
export async function readTslSelftestOn(ssm: { send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }> }, name: string, log: (line: string) => void = console.error): Promise<boolean> {
  try {
    const value = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
    if (value === "true") return true;
    if (value !== "false") log(JSON.stringify({ component: "session-steps", event: "tsl_selftest.switch_unreadable", level: "error", reason: "value" }));
    return false;
  } catch (error) {
    if (error instanceof Error && error.name === "ParameterNotFound") return false;
    log(JSON.stringify({ component: "session-steps", event: "tsl_selftest.switch_unreadable", level: "error", errorName: error instanceof Error ? error.name : "unknown" }));
    return false;
  }
}

/** SU-1 uses the same exact staging prefix and fail-closed opt-in as TS-L. */
export const SU1_CHECK_BOOT_VARIABLE = "AGENTX_SU1_CHECK";
export const SU1_CHECK_PARAMETER = "su1-check";
export async function readSu1CheckOn(ssm: { send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }> }, name: string, log: (line: string) => void = console.error): Promise<boolean> {
  try {
    const value = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
    if (value === "true") return true;
    if (value !== "false") log(JSON.stringify({ component: "session-steps", event: "su1_check.switch_unreadable", level: "error", reason: "value" }));
    return false;
  } catch (error) {
    if (error instanceof Error && error.name === "ParameterNotFound") return false;
    log(JSON.stringify({ component: "session-steps", event: "su1_check.switch_unreadable", level: "error", errorName: error instanceof Error ? error.name : "unknown" }));
    return false;
  }
}

/** The switch as a launch holds it: present only when the operator's parameter said `true`; `settingsPrefix` is the install's worker settings prefix. */
export interface TslSelftestSwitch { settingsPrefix: string }

/**
 * The user data, with the list (and the install's reserved and routed ranges, for the worker's own checks) when there is one, and the TS-L self-test variable when `tslSelftest` is given for a named environment whose
 * settings prefix is exactly staging's (anything else leaves it out: the boot's own gate then never sees it). With neither it is exactly `ec2WorkerUserData`'s.
 */
export function workerUserDataWithPrivateAddresses(config: Ec2WorkerBootConfig, bootScript: string, entries: readonly string[], ranges: { reservedCidrs?: readonly string[]; routedCidrs?: readonly string[] } = {}, tslSelftest?: TslSelftestSwitch, su1Check?: TslSelftestSwitch): string {
  const exports: string[] = [];
  if (entries.length > 0) {
    const value = entries.join(",");
    if (!PRIVATE_ADDRESSES_BOOT_PATTERN.test(value)) throw new Error("the internal address list does not fit the worker's launch setting");
    if (config.environmentKind !== "named") throw new Error("only a named environment's worker can carry an internal address list");
    exports.push(`export ${PRIVATE_ADDRESSES_BOOT_VARIABLE}='${value}'`);
    for (const [name, cidrs] of [[PRIVATE_ADDRESS_RESERVED_BOOT_VARIABLE, ranges.reservedCidrs ?? []], [PRIVATE_ADDRESS_ROUTED_BOOT_VARIABLE, ranges.routedCidrs ?? []]] as const) {
      if (cidrs.length === 0) continue;
      const listed = cidrs.join(",");
      if (!PRIVATE_ADDRESS_CIDRS_BOOT_PATTERN.test(listed)) throw new Error("the install's address ranges do not fit the worker's launch setting");
      exports.push(`export ${name}='${listed}'`);
    }
  }
  if (tslSelftest !== undefined && config.environmentKind === "named" && tslSelftest.settingsPrefix === TSL_SELFTEST_ALLOWED_PREFIX) exports.push(`export ${TSL_SELFTEST_BOOT_VARIABLE}='1'`);
  if (su1Check !== undefined && config.environmentKind === "named" && su1Check.settingsPrefix === TSL_SELFTEST_ALLOWED_PREFIX) exports.push(`export ${SU1_CHECK_BOOT_VARIABLE}='1'`);
  if (exports.length === 0) return ec2WorkerUserData(config, bootScript);
  const lines = ec2WorkerBootScript(config, bootScript).split("\n");
  // Line 0 is the interpreter, line 1 the header; the configuration's exports follow, and these join them.
  lines.splice(2, 0, ...exports);
  const compressed = gzipSync(Buffer.from(lines.join("\n"), "utf8"), { level: 9 });
  if (compressed.length >= EC2_USER_DATA_MAX_BYTES) throw new Error(`worker user data is ${String(compressed.length)} bytes compressed; EC2 allows less than ${String(EC2_USER_DATA_MAX_BYTES)}`);
  return compressed.toString("base64");
}
