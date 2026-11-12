// Internal addresses a company's tasks may reach (owner decision 123): what a worker launch carries. The provisioner's launch step reads the workspace's company, that company's APPROVED list, checks every entry
// again (a rule may have tightened since it was approved), and adds the list to the worker's user data as AGENTX_PRIVATE_ADDRESSES. Nothing else carries it, so:
//   - company isolation: a worker belongs to one workspace, a workspace to one company (its stored `orgId`); the list read is that company's and no other. A workspace that names no company gets no list.
//   - named environments only: the wall that reads the list is stage 2's (boot-stage2.sh). The legacy single-file boot has no such step, and its launch never carries a list.
//   - a launch reads the list once: a change applies to worker sessions started after it (the worker pins what it resolved for its whole session; see boot-stage2.sh `rovara-private-allow`).
// The vendored Code boot configuration (`Ec2WorkerBootConfigSchema`) is strict and read-only here, so the setting is added to the rendered script, after its header, in the same `export NAME='value'` form; the value
// is held to PRIVATE_ADDRESSES_BOOT_PATTERN (no quote, space or shell character can be in it).
import { gzipSync } from "node:zlib";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { EC2_USER_DATA_MAX_BYTES, OrgIdSchema, ec2WorkerBootScript, ec2WorkerUserData, type Ec2WorkerBootConfig } from "@rovara-code/contracts";
import { PRIVATE_ADDRESSES_BOOT_PATTERN, PRIVATE_ADDRESSES_BOOT_VARIABLE, checkPrivateAddress, type PrivateAddressInstall } from "@agentx/cloud-contracts";
import { readPrivateAddresses, type PrivateAddressTable } from "../org/private-addresses.js";

/** The approved entries a worker of this workspace is launched with: its company's list, each entry checked again; an entry that no longer passes is left out. */
export async function launchPrivateAddresses(table: PrivateAddressTable, workspaceId: string, install: PrivateAddressInstall): Promise<string[]> {
  const workspace = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const org = OrgIdSchema.safeParse(workspace?.orgId);
  if (workspace === undefined || workspace.id !== workspaceId || !org.success) return [];
  const list = await readPrivateAddresses(table, org.data);
  return list.entries.flatMap((entry) => {
    const checked = checkPrivateAddress(entry, install);
    return checked.ok && checked.entry === entry ? [entry] : [];
  });
}

/** The user data, with the list when there is one. With none it is exactly `ec2WorkerUserData`'s. */
export function workerUserDataWithPrivateAddresses(config: Ec2WorkerBootConfig, bootScript: string, entries: readonly string[]): string {
  if (entries.length === 0) return ec2WorkerUserData(config, bootScript);
  const value = entries.join(",");
  if (!PRIVATE_ADDRESSES_BOOT_PATTERN.test(value)) throw new Error("the internal address list does not fit the worker's launch setting");
  if (config.environmentKind !== "named") throw new Error("only a named environment's worker can carry an internal address list");
  const lines = ec2WorkerBootScript(config, bootScript).split("\n");
  // Line 0 is the interpreter, line 1 the header; the configuration's exports follow, and this one joins them.
  lines.splice(2, 0, `export ${PRIVATE_ADDRESSES_BOOT_VARIABLE}='${value}'`);
  const compressed = gzipSync(Buffer.from(lines.join("\n"), "utf8"), { level: 9 });
  if (compressed.length >= EC2_USER_DATA_MAX_BYTES) throw new Error(`worker user data is ${String(compressed.length)} bytes compressed; EC2 allows less than ${String(EC2_USER_DATA_MAX_BYTES)}`);
  return compressed.toString("base64");
}
