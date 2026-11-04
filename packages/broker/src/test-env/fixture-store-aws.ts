// Test services, slice 3 (s3-fakes-store, TS-FAKES-1): the real ports of the fixture store (test-env/fixture-store.ts). The store's rules are in that file; nothing here decides anything.
//
//   s3FixtureObjects     the object port, on the artifacts bucket under `private/<org>/fixtures/<project>/<sha256>`. Every object is written with SSE-KMS under the install's fixture key and no public access (the bucket blocks it).
//                        The adapter touches ONLY keys of exactly that shape (an org id, a project and a digest) and refuses any other key before it sends anything, so a bug in a caller can never reach another prefix.
//                          - putIfAbsent           PutObject with `If-None-Match: *`; a 412 (or a 409, an overlapping write) is "exists".
//                          - replaceIfUnchanged    the conditional write the store's repair path needs (TS-FAKES-1): the object is read once (its ETag and size first, its bytes only when the size matches), compared with what the
//                                                  caller observed, and written with `If-Match: <that ETag>`. If anyone wrote in between, S3 answers 412 and the answer is "changed", nothing written. There is no read-then-write window.
//                          - get                   a ranged read, so a huge object is never pulled whole; a missing object is undefined.
//                          - presignGet            a SigV4 GET for one key, never longer than 15 minutes.
//   dynamoFixtureIndex   the index port, in the State table: pk `ORG#<org>`, sk `FIXTURE#<project>#<digest>`. The org and the project are part of the key, so one project's lookup can never return another project's row (H1); a row read back is parsed strictly and
//                        a row that does not parse, or names another org or digest, is not found. Writes are conditional (`attribute_not_exists` for a new row, the stored `version` for a replace).
//   awsFixtureStore      the store with both ports and the `tx` switch. Without the fixture key (a legacy install, or `tx` never set up) there is no store at all: `undefined`, and the routes do not exist.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AGENTX_NAME_PATTERN, FIXTURE_PROTOCOLS, OrgIdSchema, orgPk } from "@agentx/contracts";
import { z } from "zod";
import {
  FIXTURE_READ_URL_SECONDS, createFixtureStore,
  type FixtureDenyFor, type FixtureIndexPort, type FixtureObjectPort, type FixtureRecord, type FixtureStore,
} from "./fixture-store.js";
import { testServicesEnabled } from "./test-services-switch.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const PREFIX = /^[A-Za-z0-9._-]{1,64}$/u;
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:(?:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f-]{36})|alias\/agentx\/[a-z][a-z0-9-]{0,62}\/fixtures)$/u;
/** The most pages one listing reads; a longer list is cut (the answer errs towards "no earlier approved set", which only makes a review stricter). */
const LIST_PAGES_MAX = 10;

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
};
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "");
const notFound = (error: unknown): boolean => statusOf(error) === 404 || nameOf(error) === "NoSuchKey" || nameOf(error) === "NotFound";
/** 412 `PreconditionFailed`, or 409 `ConditionalRequestConflict` (another write to the key is in flight): the condition did not hold. */
const conditionFailed = (error: unknown): boolean => statusOf(error) === 412 || statusOf(error) === 409 || nameOf(error) === "PreconditionFailed" || nameOf(error) === "ConditionalRequestConflict";
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

export interface S3FixtureObjectsConfig {
  s3: Pick<S3Client, "send">;
  bucket: string;
  /** The ARN of the install's fixture key (SSE-KMS). Required: an object is never written with a different key or without one. */
  kmsKeyArn: string;
  /** `private` on Public Cloud. */
  prefix?: string;
  /** A test seam; the default signs with the SDK's presigner (which needs the real client). */
  presign?: (key: string, expiresInSeconds: number) => Promise<string>;
}

/** The object port on S3. Throws at construction for a bad bucket, key or prefix, so a misconfigured install has no store instead of a store that writes somewhere else. */
export function s3FixtureObjects(config: S3FixtureObjectsConfig): FixtureObjectPort {
  const prefix = config.prefix ?? "private";
  if (!PREFIX.test(prefix)) throw new Error("the fixture prefix is not a plain path segment");
  if (config.bucket.trim() === "") throw new Error("the fixture bucket is not named");
  if (!KMS_KEY_ARN.test(config.kmsKeyArn)) throw new Error("the fixture key is not a KMS key ARN");
  const shape = new RegExp(`^${prefix.replace(/\./gu, "\\.")}/org_[0-9a-z]{20}/fixtures/[a-z][a-z0-9-]{0,62}/[a-f0-9]{64}$`, "u");
  const checked = (key: string): string => { if (!shape.test(key)) throw new Error("not a fixture key"); return key; };
  const { s3, bucket } = config;
  const encryption = { ServerSideEncryption: "aws:kms", SSEKMSKeyId: config.kmsKeyArn, BucketKeyEnabled: true } as const;
  const bytesOf = async (body: unknown): Promise<Uint8Array> => {
    const stream = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (stream?.transformToByteArray === undefined) throw new Error("the object has no readable body");
    return stream.transformToByteArray();
  };
  return {
    async putIfAbsent(key, bytes, contentType) {
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: checked(key), Body: bytes, ContentType: contentType, IfNoneMatch: "*", ...encryption }));
        return "created";
      } catch (error) {
        if (conditionFailed(error)) return "exists";
        throw error;
      }
    },
    async replaceIfUnchanged(key, observed, bytes, contentType) {
      checked(key);
      let etag: string | undefined;
      let size: number | undefined;
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })) as { ETag?: string; ContentLength?: number };
        etag = head.ETag;
        size = head.ContentLength;
      } catch (error) {
        if (notFound(error)) return "changed";
        throw error;
      }
      // No ETag to hold the write to is no write. A different size is a different object: nothing to read.
      if (etag === undefined || size !== observed.length) return "changed";
      let current: Uint8Array;
      try {
        // The read is held to the same ETag, so the bytes compared are the bytes of the version the write will replace.
        current = await bytesOf((await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag })) as { Body?: unknown }).Body);
      } catch (error) {
        if (notFound(error) || conditionFailed(error)) return "changed";
        throw error;
      }
      if (!sameBytes(current, observed)) return "changed";
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, IfMatch: etag, ...encryption }));
        return "replaced";
      } catch (error) {
        if (conditionFailed(error) || notFound(error)) return "changed";
        throw error;
      }
    },
    async get(key, maxBytes) {
      checked(key);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("a read needs a size bound");
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${String(maxBytes - 1)}` })) as { Body?: unknown };
        const bytes = await bytesOf(out.Body);
        return bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
      } catch (error) {
        // An empty object answers a ranged read with 416; it is a stored object of no content, which the store reads as a bad one.
        if (statusOf(error) === 416) return new Uint8Array();
        if (notFound(error)) return undefined;
        throw error;
      }
    },
    async presignGet(key, expiresInSeconds) {
      checked(key);
      if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > FIXTURE_READ_URL_SECONDS) throw new Error("a fixture URL lives at most 15 minutes");
      if (config.presign !== undefined) return config.presign(key, expiresInSeconds);
      return getSignedUrl(s3 as S3Client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
  };
}

const Iso = z.string().datetime();
const RowSchema = z.object({
  storeId: z.string().max(200), orgId: OrgIdSchema, project: z.string().regex(AGENTX_NAME_PATTERN), digest: z.string().regex(DIGEST), dependencyId: z.string().min(1).max(200), family: z.string().min(1).max(300),
  protocol: z.enum(FIXTURE_PROTOCOLS), origin: z.enum(["recorded", "written", "imported"]), revision: z.number().int().min(0).max(1_000_000),
  entries: z.number().int().min(0).max(2000), faults: z.number().int().min(0).max(20), bytes: z.number().int().min(0).max(4 * 1024 * 1024),
  recordedFrom: z.enum(["synthetic", "test_account", "written"]), firstFromTestAccount: z.boolean(), scanClean: z.boolean(),
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]), submittedBy: z.string().max(200), submittedAt: Iso,
  decidedBy: z.string().max(200).optional(), decidedAt: Iso.optional(), withdrawnBy: z.string().max(200).optional(), withdrawnAt: Iso.optional(),
  version: z.number().int().min(1).max(1_000_000),
}).strict();

export interface DynamoFixtureIndexConfig {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table. */
  tableName: string;
}

const SORT_PREFIX = "FIXTURE#";
const projectSortPrefix = (project: string): string => `${SORT_PREFIX}${z.string().regex(AGENTX_NAME_PATTERN).parse(project)}#`;
const rowKey = (orgId: string, project: string, digest: string): { pk: string; sk: string } => ({ pk: orgPk(OrgIdSchema.parse(orgId)), sk: `${projectSortPrefix(project)}${z.string().regex(DIGEST).parse(digest)}` });
const attributesOf = (record: FixtureRecord): Record<string, unknown> => ({ ...rowKey(record.orgId, record.project, record.digest), entity: "FIXTURE_SET", ...RowSchema.parse(record) });
/** A stored item as a record, or undefined when it does not read back as exactly one. */
function recordOf(item: unknown): FixtureRecord | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const rest: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  delete rest["pk"];
  delete rest["sk"];
  delete rest["entity"];
  const parsed = RowSchema.safeParse(rest);
  return parsed.success ? (parsed.data as FixtureRecord) : undefined;
}

/** The index port in the State table. An item that is not exactly a fixture row, or whose org or digest is not the one it is stored under, is ignored. */
export function dynamoFixtureIndex(config: DynamoFixtureIndexConfig): FixtureIndexPort {
  const { documentClient, tableName } = config;
  return {
    async get(orgId, project, digest) {
      const key = rowKey(orgId, project, digest);
      const found = (await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> };
      const record = recordOf(found.Item);
      return record !== undefined && record.orgId === orgId && record.project === project && record.digest === digest && key.sk === `${projectSortPrefix(record.project)}${record.digest}` ? record : undefined;
    },
    async putIfAbsent(record) {
      try {
        await documentClient.send(new PutCommand({ TableName: tableName, Item: attributesOf(record), ConditionExpression: "attribute_not_exists(pk)" }));
        return true;
      } catch (error) {
        if (nameOf(error) === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async replace(record, expectedVersion) {
      try {
        await documentClient.send(new PutCommand({
          TableName: tableName, Item: attributesOf(record),
          ConditionExpression: "attribute_exists(pk) AND #version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion },
        }));
        return true;
      } catch (error) {
        if (nameOf(error) === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async listByDependency(orgId, project, dependencyId) {
      const partition = orgPk(OrgIdSchema.parse(orgId));
      const found: FixtureRecord[] = [];
      let startKey: Record<string, unknown> | undefined;
      for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
        const out = (await documentClient.send(new QueryCommand({
          TableName: tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)", FilterExpression: "dependencyId = :dependency",
          ExpressionAttributeValues: { ":pk": partition, ":sk": projectSortPrefix(project), ":dependency": dependencyId }, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }))) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
        for (const item of out.Items ?? []) {
          const record = recordOf(item);
          if (record !== undefined && record.orgId === orgId && record.project === project && record.dependencyId === dependencyId && item["sk"] === `${projectSortPrefix(record.project)}${record.digest}`) found.push(record);
        }
        if (out.LastEvaluatedKey === undefined) break;
        startKey = out.LastEvaluatedKey;
      }
      return found;
    },
  };
}

export interface AwsFixtureStoreConfig {
  s3: Pick<S3Client, "send">;
  bucket: string;
  kmsKeyArn: string;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  presign?: S3FixtureObjectsConfig["presign"];
  now?: () => Date;
}

/**
 * The fixture store on the real ports, behind `tx`. `denyFor` is the production deny list the CALLER knows (a project's approved environment): the store scans every set against it at submit, approve, deliver and
 * read, and a list that cannot be read must throw (fail closed), never answer empty.
 */
export function awsFixtureStore(config: AwsFixtureStoreConfig, denyFor: FixtureDenyFor, env: NodeJS.ProcessEnv = process.env): FixtureStore {
  return createFixtureStore({
    enabled: () => testServicesEnabled(env),
    objects: s3FixtureObjects({ s3: config.s3, bucket: config.bucket, kmsKeyArn: config.kmsKeyArn, ...(config.presign === undefined ? {} : { presign: config.presign }) }),
    index: dynamoFixtureIndex({ documentClient: config.documentClient, tableName: config.tableName }),
    denyFor,
    ...(config.now === undefined ? {} : { now: config.now }),
  });
}

/**
 * What the install gives the routes: a factory for the store, or nothing. Nothing while `tx` is off, and nothing where the install has no fixture key (`FIXTURE_KEY_ARN`, built from the environment name by `fixtureKeyAlias`; a legacy install has no AGENTX_ENV and no key), no bucket
 * or no table: the routes then do not exist. A key that is not a KMS key ARN is the same as none, and is logged by name only.
 */
export function fixtureStoreForRoutes(
  input: { s3: Pick<S3Client, "send">; documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; artifactBucketName: string; fixtureStore?: (denyFor: FixtureDenyFor) => FixtureStore },
  env: NodeJS.ProcessEnv = process.env,
): { fixtureStore?: (denyFor: FixtureDenyFor) => FixtureStore } {
  if (!testServicesEnabled(env)) return {};
  // A store the caller supplied (a test) wins; it is still behind `tx`, which the store reads on every call.
  if (input.fixtureStore !== undefined) return { fixtureStore: input.fixtureStore };
  const kmsKeyArn = env["FIXTURE_KEY_ARN"];
  if (kmsKeyArn === undefined || kmsKeyArn === "") return {};
  if (!KMS_KEY_ARN.test(kmsKeyArn) || input.artifactBucketName === "" || input.tableName === "") {
    console.log(JSON.stringify({ component: "broker", event: "fixture_store.not_installed" }));
    return {};
  }
  const config: AwsFixtureStoreConfig = { s3: input.s3, bucket: input.artifactBucketName, kmsKeyArn, documentClient: input.documentClient, tableName: input.tableName };
  return { fixtureStore: (denyFor) => awsFixtureStore(config, denyFor, env) };
}
