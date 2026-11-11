// The CompanyImageMirror Lambda. The broker starts it (an asynchronous invoke) with a job right after an admin approves a company image (`copy`) or revokes one (`delete`); a plan that finds an approved image with no
// finished copy starts it again. It does the one slow thing the broker's 30 seconds cannot: it copies the approved image from its source registry into the install's own registry (test-env/company-image-mirror.ts).
//
// Its authority is narrow, by construction:
//   - the job names an org and an image id; the repository it writes is `companyImageRepositoryName` of those (never a name from the job), and it reaches ECR only through a push session whose policy names that ONE repository;
//   - its role may assume the saved-environment push and manage roles, write the mirror's own partition of the state table, and nothing else (infra/lib/company-image-mirror.ts);
//   - before the push it checks the repository is the one the creation template makes (or does not exist yet), and again after the push, before the copy is recorded as ready.
// Nothing is logged but fixed words, ids and a digest.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CompanyImageMirrorJobSchema, companyImageRepositoryName, type CompanyImageMirrorFailure, type CompanyImageMirrorJob } from "@agentx/contracts";
import { copyApprovedImage, type CopyPorts } from "../test-env/company-image-mirror.js";
import { claimMirror, deleteMirrorState, finishMirror, type MirrorTable } from "../test-env/company-image-mirror-state.js";
import { createRegistryClient, globalRegistryFetch } from "../test-env/company-image-registry-client.js";
import { assumePushCredentials, mintManageSessionFor, verifyRepositoryNamed, type SavedEnvSessionConfig, type SavedEnvSessionPorts } from "../test-env/saved-env-session.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { ecrWriterOf } from "./company-image-mirror-aws.js";
import { realSavedEnvAwsClients, savedEnvRegistryPort, savedEnvSessionPorts, type SavedEnvAwsClients } from "./broker/saved-env-aws.js";
import { savedEnvConfigOf } from "./broker/saved-env-config.js";

/** The Lambda's timeout is 900 seconds; the copy gives up a little before it, so the result is recorded rather than lost. */
export const MIRROR_LAMBDA_BUDGET_MS = 840_000;

export interface MirrorRunDependencies {
  table: MirrorTable;
  config: SavedEnvSessionConfig;
  clients: SavedEnvAwsClients;
  /** Test seams. */
  now?: () => number;
  copyPorts?: (ecr: ReturnType<typeof ecrWriterOf>) => CopyPorts;
  log?: (event: Record<string, unknown>) => void;
}

const defaultLog = (event: Record<string, unknown>): void => console.log(JSON.stringify({ component: "company-image-mirror", ...event }));
const noBindings = (now: () => number) => ({ readApproved: async () => undefined, proveHolds: async () => false, now });

export async function runMirrorJob(dependencies: MirrorRunDependencies, rawJob: unknown): Promise<"copied" | "failed" | "skipped" | "deleted" | "invalid"> {
  const log = dependencies.log ?? defaultLog;
  const now = dependencies.now ?? Date.now;
  const parsed = CompanyImageMirrorJobSchema.safeParse(rawJob);
  if (!parsed.success) { log({ event: "company_image_mirror.invalid_job" }); return "invalid"; }
  const job: CompanyImageMirrorJob = parsed.data;
  const repository = companyImageRepositoryName({ env: dependencies.config.env, orgId: job.orgId, imageId: job.imageId });
  const ports: SavedEnvSessionPorts = savedEnvSessionPorts(dependencies.clients, noBindings(now));

  if (job.action === "delete") {
    // A revoked image's copy goes: the repository holds only that image. A repository that is already gone is fine.
    try {
      const manage = await mintManageSessionFor(dependencies.config, ports, repository);
      if (!manage.ok) throw new Error("no session");
      await savedEnvRegistryPort(dependencies.clients).deleteRepository(manage.credentials, repository);
      await deleteMirrorState(dependencies.table, job.orgId, job.imageId);
      log({ event: "company_image_mirror.deleted", imageId: job.imageId });
      return "deleted";
    } catch {
      log({ event: "company_image_mirror.delete_failed", imageId: job.imageId });
      return "failed";
    }
  }

  const claimed = await claimMirror(dependencies.table, { orgId: job.orgId, imageId: job.imageId, digest: job.digest, repository, nowMs: now() }).catch(() => false);
  if (!claimed) { log({ event: "company_image_mirror.skipped", imageId: job.imageId }); return "skipped"; }
  const startedAt = new Date(now()).toISOString();
  const finish = (result: { ok: true } | { ok: false; reason: CompanyImageMirrorFailure }) => finishMirror(dependencies.table, { orgId: job.orgId, imageId: job.imageId, startedAt, nowMs: now(), ...result });
  try {
    // A repository someone made first with other settings is refused; one that does not exist yet is made by the first push, from the template.
    const before = await verifyRepositoryNamed(dependencies.config, ports, repository);
    if (!before.ok) { await finish({ ok: false, reason: "unavailable" }); return "failed"; }
    const push = await assumePushCredentials(dependencies.config, ports, repository);
    if (!push.ok) { await finish({ ok: false, reason: "unavailable" }); return "failed"; }
    const ecr = ecrWriterOf(dependencies.clients.ecr(push.credentials), repository);
    const copyPorts: CopyPorts = dependencies.copyPorts?.(ecr) ?? {
      registry: ({ registry, extra, repository: source }) => createRegistryClient({ registry, extra, repository: source, fetchImpl: globalRegistryFetch, lookup: async (host) => dnsLookup(host, { all: true, verbatim: true }) }),
      ecr, now, deadlineMs: now() + MIRROR_LAMBDA_BUDGET_MS,
    };
    const result = await copyApprovedImage(copyPorts, { registry: job.registry, extraRegistries: job.extraRegistries, digest: job.digest, repository: job.repository });
    if (!result.ok) { await finish(result); log({ event: "company_image_mirror.failed", imageId: job.imageId, reason: result.reason }); return "failed"; }
    // The repository must be the template's now that the push created it; a copy in any other is not recorded as ready.
    const after = await verifyRepositoryNamed(dependencies.config, ports, repository);
    if (!after.ok || after.state !== "matches") { await finish({ ok: false, reason: "unavailable" }); return "failed"; }
    await finish({ ok: true });
    log({ event: "company_image_mirror.copied", imageId: job.imageId, digest: job.digest });
    return "copied";
  } catch {
    await finish({ ok: false, reason: "unavailable" }).catch(() => undefined);
    log({ event: "company_image_mirror.failed", imageId: job.imageId, reason: "unavailable" });
    return "failed";
  }
}

/** The Lambda entry. */
export async function handler(event: unknown): Promise<void> {
  const config = savedEnvConfigOf(process.env);
  const tableName = process.env["STATE_TABLE_NAME"];
  if (config === undefined || tableName === undefined || tableName === "") throw new Error("the company image mirror is not configured");
  await runMirrorJob({
    table: { documentClient: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName },
    config: { enabled: true, env: config.env, scope: config.scope, kmsKeyArn: config.kmsKeyArn },
    clients: realSavedEnvAwsClients(config.scope.region),
  }, event);
}
