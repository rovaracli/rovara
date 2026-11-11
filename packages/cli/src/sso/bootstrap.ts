// Enterprise foundations I-5: `rovara sso bootstrap`, run once by the installer with their own AWS credentials (the install's deploy or operator role session) on a
// new Enterprise install. It makes the named people owners and writes the first group mapping and emergency list, recorded in the audit ledger; the work is in
// the broker's `bootstrapSso`, which refuses once a mapping or a list exists. This file reads what the install recorded and calls it.
import { agentXError } from "@rovara-code/contracts";
import { editionPolicy } from "@agentx/cloud-contracts";
import { bootstrapSso, type SsoBootstrapResult } from "@agentx/broker/developer/sso-bootstrap";
import type { AuditRuntime } from "@agentx/broker/audit/outbox";
import type { CallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings } from "../environments/settings.js";
import { readRecordedEdition } from "../deploy/edition.js";
import { readSignInSettings } from "../signin/settings.js";

export interface SsoBootstrapFlags {
  claim: string;
  adminGroups: string[];
  memberGroups: string[];
  ownerSubjects: string[];
  breakGlassDays: number;
}

export interface SsoBootstrapServices {
  store: ParameterStore;
  identity: CallerIdentity;
  /** The stack's outputs (CloudFormation), or undefined when there is no such stack. */
  outputs: (stackName: string) => Promise<Record<string, string> | undefined>;
  /** The DynamoDB client of the install's account and region. */
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The audit outbox the bootstrap writes through. Pending items only: the install's audit drain delivers them. */
  audit: (tableName: string) => AuditRuntime;
  write: (line: string) => void;
  now: () => number;
}

export const SSO_BOOTSTRAP_NEEDS_YES = "Check the plan above, then run the same command with --yes to write it.";

export async function runSsoBootstrap(services: SsoBootstrapServices, env: string, flags: SsoBootstrapFlags, yes: boolean): Promise<SsoBootstrapResult & { env: string; stateTable: string }> {
  const settings = await readEnvironmentSettings(services.store, env);
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed`);
  const recordedEdition = await readRecordedEdition(services.store, env);
  if (recordedEdition !== "enterprise") throw agentXError("CONFIG_INVALID", `environment ${env} is not recorded as an Enterprise install; this command is for a new Enterprise install`);
  const signIn = await readSignInSettings(services.store, env);
  if (signIn?.oidc === undefined) throw agentXError("CONFIG_INVALID", "turn on the company sign-in first: rovara signin enable oidc");
  const outputs = await services.outputs(settings.stacks["control-plane"]);
  const stateTable = outputs?.StateTableName;
  if (stateTable === undefined) throw agentXError("CONFIG_INVALID", "the control plane stack does not name its state table");
  const caller = await services.identity.get();
  if (caller.account !== settings.account) throw agentXError("CONFIG_INVALID", `these AWS credentials belong to account ${caller.account}, not the install's account`);

  services.write(`Environment ${env}: first-run company sign-in`);
  services.write(`  claim: ${flags.claim}`);
  for (const group of flags.adminGroups) services.write(`  group ${group} -> admin`);
  for (const group of flags.memberGroups) services.write(`  group ${group} -> member`);
  services.write(`  owners: ${String(flags.ownerSubjects.length)} (they must also be in an admin group at your identity provider, or they cannot sign in)`);
  services.write(`  emergency sign-in list: the owners, for ${String(flags.breakGlassDays)} days`);
  if (!yes) throw agentXError("CONFIG_INVALID", SSO_BOOTSTRAP_NEEDS_YES);

  const result = await bootstrapSso(
    { documentClient: services.documentClient, tableName: stateTable, policy: editionPolicy("enterprise"), audit: services.audit(stateTable) },
    {
      env, oidcIssuer: signIn.oidc.issuer, recordedEdition, claim: flags.claim, adminGroups: flags.adminGroups, memberGroups: flags.memberGroups,
      ownerSubjects: flags.ownerSubjects, breakGlassDays: flags.breakGlassDays, installerArn: caller.arn, nowMs: services.now(),
    },
  );
  return { ...result, env, stateTable };
}
