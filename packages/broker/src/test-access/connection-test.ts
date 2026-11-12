// Customer test AWS account, lane TA2 (customer-test-account.md section 1, Screen 3): the connection test. It runs on its own once the admin confirmed the account, and again on "Test connection". Each check is a fixed word:
//   assumes                  the role can be assumed with the stored external id and the run tag (and is the role the template names for this connection, in the connected account);
//   external_id_required     the same role CANNOT be assumed without the external id (a role that can is open to a confused deputy: this fails the connection);
//   limits_attached          the test role and the cleanup role carry Rovara's permissions boundary (`rovara-test-boundary-<external id>`);
//   services_reachable       one harmless read per planned service in the connection's Region. A service the account's own policy (an SCP, or the role's policy) blocks is a WARNING, and stays on the emulator; it does not fail;
//   creates_and_deletes_own  the role can create a queue named for a run and delete it;
//   cannot_touch_others      the role CANNOT delete a queue that is not the run's: the call is refused by IAM before the queue is looked up (a "no such queue" answer means IAM let it through, and the fence is missing);
//   not_production           an alias that says production needs the admin's tick.
// All AWS calls are the port's (aws-port.ts). Nothing here keeps a credential, an AWS message, an ARN or an account id in the result: a code, and for the warning the service names. Anything the test created and could not delete is
// returned as `leftover` for the cleanup sweeper (TA6): it is never assumed gone.
import { DEFAULT_TEST_ACCESS_SERVICES, RUN_NAME_PREFIX, testAccessCleanupRoleName, testAccessRoleName } from "@agentx/cloud-contracts";
import { AssumeFailureError, type AccountCalls, type TestAccessAws } from "./aws-port.js";
import { isProdAlias, sanitizeAlias } from "./detect.js";
import { TestAccessSessionError, assumeForRecord, checkedConnection, type SessionDeps } from "./session.js";
import { newRunId } from "./token.js";
import type { ConnectionCheck, ConnectionRecord, ConnectionTestResult } from "./store.js";

export const CONNECTION_TEST_TASK = "connection-test";
/** The services probed when the plan names none: the default list, without IAM (probed by the boundary check). */
export const CONNECTION_TEST_SERVICES: readonly string[] = DEFAULT_TEST_ACCESS_SERVICES.filter((service) => service !== "iam");

export interface ConnectionTestDeps {
  aws: TestAccessAws;
  now: () => number;
  rovaraAccountIds: readonly string[];
  prodDeny: SessionDeps["prodDeny"];
  /** A test seam for the run id and the name of the other queue. */
  runId?: () => string;
  otherName?: () => string;
}

export interface ConnectionTestOutcome { result: ConnectionTestResult; alias?: string }

const pass = (id: ConnectionCheck["id"]): ConnectionCheck => ({ id, status: "pass" });
const fail = (id: ConnectionCheck["id"], code: string): ConnectionCheck => ({ id, status: "fail", code });
const skipped = (id: ConnectionCheck["id"], code: string): ConnectionCheck => ({ id, status: "skipped", code });

export async function runConnectionTest(deps: ConnectionTestDeps, record: ConnectionRecord, services: readonly string[] = CONNECTION_TEST_SERVICES): Promise<ConnectionTestOutcome> {
  const at = new Date(deps.now()).toISOString();
  const checks: ConnectionCheck[] = [];
  const finish = (leftover?: string, alias?: string): ConnectionTestOutcome => ({
    result: { at, passed: !checks.some((check) => check.status === "fail"), checks, ...(leftover === undefined ? {} : { leftover }) },
    ...(alias === undefined ? {} : { alias }),
  });
  const runId = deps.runId?.() ?? newRunId();
  const sessionDeps = { aws: deps.aws, now: deps.now, rovaraAccountIds: deps.rovaraAccountIds, prodDeny: deps.prodDeny };

  // 1. The role can be assumed with the external id.
  let session;
  try {
    session = await assumeForRecord(sessionDeps, record, { taskId: CONNECTION_TEST_TASK, runId, services: ["sqs"] });
    checks.push(pass("assumes"));
  } catch (error) {
    checks.push(fail("assumes", error instanceof TestAccessSessionError ? error.code : "unreachable"));
    for (const id of ["external_id_required", "limits_attached", "services_reachable", "creates_and_deletes_own", "cannot_touch_others", "not_production"] as const) checks.push(skipped(id, "not_assumed"));
    return finish();
  }

  // 2. The same role cannot be assumed without it. Neither the external id nor a tag is sent, so a role that answers has no external id condition at all.
  try {
    const { roleArn } = await checkedConnection(sessionDeps, record, "run");
    await deps.aws.assumeRole({ RoleArn: roleArn, RoleSessionName: "rovara-connection-test-noext", DurationSeconds: 900 });
    checks.push(fail("external_id_required", "role_open_without_external_id"));
  } catch (error) {
    checks.push(error instanceof AssumeFailureError && error.failure === "refused" ? pass("external_id_required") : fail("external_id_required", error instanceof AssumeFailureError ? "unreachable" : "not_checked"));
  }

  const calls: AccountCalls = deps.aws.calls(session.credentials, record.region, session.accountId);
  const alias = sanitizeAlias((await calls.listAccountAliases().catch(() => []))[0]);

  // 3. Both roles carry the permissions boundary.
  const boundary = `arn:aws:iam::${session.accountId}:policy/rovara-test-boundary-${record.externalId}`;
  const [testBoundary, cleanupBoundary] = await Promise.all([calls.roleBoundary(testAccessRoleName(record.connectionId)).catch(() => undefined), calls.roleBoundary(testAccessCleanupRoleName(record.connectionId)).catch(() => undefined)]);
  checks.push(testBoundary === boundary && cleanupBoundary === boundary ? pass("limits_attached") : fail("limits_attached", "boundary_missing"));

  // 4. Services reachable: one harmless read each.
  const blocked: string[] = [];
  let unreachable = false;
  const queueUsable = { value: true };
  for (const service of services) {
    const probe = await calls.probeService(service).catch((): "unreachable" => "unreachable");
    if (probe === "scp_blocked" || probe === "no_access") blocked.push(service);
    if (probe === "unreachable") unreachable = true;
    if (service === "sqs" && probe !== "ok") queueUsable.value = false;
  }
  checks.push(unreachable ? fail("services_reachable", "unreachable") : blocked.length > 0 ? { id: "services_reachable", status: "warn", code: "blocked", services: blocked.sort() } : pass("services_reachable"));

  // 5 and 6. Creates and deletes its own queue; cannot delete another.
  let leftover: string | undefined;
  if (!queueUsable.value) {
    checks.push(skipped("creates_and_deletes_own", "sqs_not_reachable"), skipped("cannot_touch_others", "sqs_not_reachable"));
  } else {
    const created = await calls.createQueue(`${RUN_NAME_PREFIX}${runId}-conntest`, runId).catch((): { ok: false; code: "error" } => ({ ok: false, code: "error" }));
    if (!created.ok) {
      checks.push(fail("creates_and_deletes_own", created.code === "denied" ? "create_denied" : "unreachable"));
    } else {
      const deleted = await calls.deleteQueueByUrl(created.queueUrl).catch((): "error" => "error");
      if (deleted === "deleted" || deleted === "not_found") checks.push(pass("creates_and_deletes_own"));
      else {
        leftover = created.queueUrl;
        checks.push(fail("creates_and_deletes_own", "delete_failed"));
      }
    }
    const other = deps.otherName?.() ?? `rovara-conntest-not-ours-${newRunId()}`;
    const outcome = await calls.deleteQueueByName(other).catch((): "error" => "error");
    checks.push(outcome === "denied" ? pass("cannot_touch_others") : fail("cannot_touch_others", outcome === "error" ? "unreachable" : "fence_missing"));
  }

  // 7. A production-looking alias needs the admin's tick.
  checks.push(isProdAlias(alias) && record.notProductionAck !== true ? fail("not_production", "alias_says_production") : pass("not_production"));
  return finish(leftover, alias);
}
