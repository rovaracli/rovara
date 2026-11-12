// Owner decision 123: what the host's wall (packages/worker/ec2/boot-stage2.sh `rovara-private-allow`) tells the worker at its start, as two environment values the launcher hands it:
//   AGENTX_PRIVATE_ADDRESS_HOSTS   the internal names it pinned and the addresses it opened for them (`name=address`, comma separated). Every task sandbox gets an `--add-host` for each, so a lookup inside the sandbox
//                                  agrees with the wall (a name that would answer otherwise, a rebinding included, still points at the pinned address). Dev containers get the same through docker-walled.sh.
//   AGENTX_PRIVATE_ADDRESS_FACTS   the counts (`entries=K,opened=N,skipped=M`), which the worker logs once at its start.
// Each is used only in its one written form; anything else gives nothing (the wall, not this, decides what is reachable).
import { isIP } from "node:net";

export const PRIVATE_ADDRESS_HOSTS_ENVIRONMENT = "AGENTX_PRIVATE_ADDRESS_HOSTS";
export const PRIVATE_ADDRESS_FACTS_ENVIRONMENT = "AGENTX_PRIVATE_ADDRESS_FACTS";
const PAIRS = /^[a-z0-9.-]{1,94}=[0-9.]{7,15}(?:,[a-z0-9.-]{1,94}=[0-9.]{7,15}){0,127}$/u;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** The `--add-host` arguments for the pinned pairs; none when the value is absent or not in its form. */
export function privateAddressHostArgs(environment: NodeJS.ProcessEnv = process.env): string[] {
  const value = environment[PRIVATE_ADDRESS_HOSTS_ENVIRONMENT];
  if (value === undefined || !PAIRS.test(value)) return [];
  const pairs = value.split(",").map((pair) => pair.split("="));
  if (!pairs.every(([name, address]) => name !== undefined && NAME.test(name) && address !== undefined && isIP(address) === 4)) return [];
  return pairs.flatMap(([name, address]) => ["--add-host", `${name!}:${address!}`]);
}

/** The step's counts, or undefined when absent or not in their form. */
export function privateAddressFacts(environment: NodeJS.ProcessEnv = process.env): { entries: number; opened: number; skipped: number } | undefined {
  const match = /^entries=([0-9]{1,2}),opened=([0-9]{1,2}),skipped=([0-9]{1,2})$/u.exec(environment[PRIVATE_ADDRESS_FACTS_ENVIRONMENT] ?? "");
  return match === null ? undefined : { entries: Number(match[1]), opened: Number(match[2]), skipped: Number(match[3]) };
}
