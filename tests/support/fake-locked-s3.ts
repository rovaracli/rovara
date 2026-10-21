// An in-memory S3 bucket with versioning, Object Lock default retention and the write rules of the audit ledger's bucket
// policy, for the anchor's tests. It speaks the SDK's command objects (`client.send(new PutObjectCommand(...))`), so the
// code under test is the production code. What it models, and why each rule is here:
//   - Versioning: every PutObject makes a new version; a simple DeleteObject adds a delete marker; a versioned
//     DeleteObject inside the retention period is refused with 403 (Object Lock).
//   - Default retention: a version without its own retention takes the bucket's mode and days. An explicit retain-until
//     date is kept as given (and must satisfy DenyShortRetention).
//   - `If-None-Match: *`: 412 when the current version is a real version; it SUCCEEDS when the current version is a delete
//     marker (S3's documented behaviour, which is why the anchor lists versions first).
//   - RequireConditionalWrites (bucket policy): a PutObject without `If-None-Match` is refused with 403.
//   - DenyShortRetention (bucket policy): a PutObject that states a retain-until date with fewer than the floor's days left
//     is refused with 403. A request that states none is not refused: the key is absent, and the default retention applies.
//   - Object Lock buckets need an integrity header: a PutObject with neither Content-MD5 nor a checksum is refused with 400.
// Errors carry the SDK's shape: `name` and `$metadata.httpStatusCode`.
import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

const DAY_MS = 86_400_000;

export interface FakeLockedS3Options {
  now: () => number;
  /** The bucket's default retention. Default: compliance for 1,096 days (the production profile). */
  retention?: { mode: "COMPLIANCE" | "GOVERNANCE"; days: number };
}

interface StoredVersion {
  kind: "version";
  versionId: string;
  body: Buffer;
  lastModified: number;
  lockMode: "COMPLIANCE" | "GOVERNANCE";
  retainUntil: number;
  checksumSha256: string;
}
interface StoredMarker { kind: "marker"; versionId: string; lastModified: number }
type Entry = StoredVersion | StoredMarker;

export interface S3Call { command: string; key: string | undefined; input: Record<string, unknown> }

function failure(name: string, status: number, message: string): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status }, $fault: status >= 500 ? "server" : "client" });
}

export class FakeLockedS3 {
  /** Versions and delete markers per key, oldest first. */
  readonly entries = new Map<string, Entry[]>();
  /** Every command received, in order, accepted or refused. */
  readonly calls: S3Call[] = [];
  /** Runs before a command takes effect; throw to make it fail, or write to the bucket to model a concurrent writer. */
  before: ((call: S3Call) => void | Promise<void>) | undefined;
  /** Runs after a command took effect, before the caller sees the result; throw to model a crash after the write. */
  after: ((call: S3Call) => void | Promise<void>) | undefined;
  readonly client: S3Client;
  private counter = 0;
  private readonly retention: { mode: "COMPLIANCE" | "GOVERNANCE"; days: number };

  constructor(private readonly options: FakeLockedS3Options) {
    this.retention = options.retention ?? { mode: "COMPLIANCE", days: 1096 };
    this.client = { send: (command: unknown) => this.send(command) } as unknown as S3Client;
  }

  /** The bucket's default retention days, which is also the floor DenyShortRetention enforces. */
  get floorDays(): number {
    return this.retention.days;
  }

  /** The real versions of `key`, oldest first. */
  versionsOf(key: string): StoredVersion[] {
    return (this.entries.get(key) ?? []).filter((entry): entry is StoredVersion => entry.kind === "version");
  }

  /** The text of the current version of `key`, or undefined when there is none (or it is a delete marker). */
  currentText(key: string): string | undefined {
    const latest = this.entries.get(key)?.at(-1);
    return latest?.kind === "version" ? latest.body.toString("utf8") : undefined;
  }

  keys(): string[] {
    return [...this.entries.keys()].sort();
  }

  putCalls(): S3Call[] {
    return this.calls.filter((call) => call.command === "PutObject");
  }

  /** Test setup: adds a version the way a rewrite of the bucket would, ignoring every rule. */
  forceVersion(key: string, body: string): string {
    return this.addVersion(key, Buffer.from(body, "utf8"), undefined);
  }

  /** Test setup: a simple delete, which on a versioned bucket adds a delete marker. */
  addDeleteMarker(key: string): void {
    this.entry(key).push({ kind: "marker", versionId: this.nextVersionId(), lastModified: this.options.now() });
  }

  private entry(key: string): Entry[] {
    let list = this.entries.get(key);
    if (list === undefined) {
      list = [];
      this.entries.set(key, list);
    }
    return list;
  }

  private nextVersionId(): string {
    this.counter += 1;
    return `v${String(this.counter).padStart(6, "0")}-${createHash("sha256").update(String(this.counter)).digest("hex").slice(0, 10)}`;
  }

  private addVersion(key: string, body: Buffer, retainUntil: number | undefined): string {
    const now = this.options.now();
    const versionId = this.nextVersionId();
    this.entry(key).push({
      kind: "version",
      versionId,
      body,
      lastModified: now,
      lockMode: this.retention.mode,
      retainUntil: retainUntil ?? now + this.retention.days * DAY_MS,
      checksumSha256: createHash("sha256").update(body).digest("base64"),
    });
    return versionId;
  }

  private async send(command: unknown): Promise<unknown> {
    const input = ((command as { input?: Record<string, unknown> }).input ?? {});
    const name = (command as { constructor: { name: string } }).constructor.name.replace(/Command$/, "");
    const call: S3Call = { command: name, key: typeof input.Key === "string" ? input.Key : undefined, input };
    this.calls.push(call);
    await this.before?.(call);
    await Promise.resolve();
    let result: unknown;
    if (command instanceof PutObjectCommand) result = this.put(input);
    else if (command instanceof GetObjectCommand) result = this.get(input);
    else if (command instanceof HeadObjectCommand) result = this.head(input);
    else if (command instanceof ListObjectVersionsCommand) result = this.list(input);
    else if (command instanceof DeleteObjectCommand) result = this.remove(input);
    else throw new Error(`FakeLockedS3 does not support ${name}`);
    await this.after?.(call);
    return result;
  }

  private put(input: Record<string, unknown>): unknown {
    const key = String(input.Key);
    // The bucket policy, evaluated first: a refused request never reaches the integrity or precondition checks.
    if (input.IfNoneMatch !== "*") throw failure("AccessDenied", 403, "Access Denied: RequireConditionalWrites");
    const retainUntilDate = input.ObjectLockRetainUntilDate as Date | undefined;
    if (retainUntilDate !== undefined && (retainUntilDate.getTime() - this.options.now()) / DAY_MS < this.retention.days) {
      throw failure("AccessDenied", 403, "Access Denied: DenyShortRetention");
    }
    const integrity = ["ContentMD5", "ChecksumSHA256", "ChecksumSHA1", "ChecksumCRC32", "ChecksumCRC32C", "ChecksumCRC64NVME", "ChecksumAlgorithm"];
    if (!integrity.some((field) => input[field] !== undefined)) {
      throw failure("InvalidRequest", 400, "Content-MD5 OR x-amz-checksum- HTTP header is required for Put Object requests with Object Lock parameters");
    }
    const body = toBuffer(input.Body);
    if (typeof input.ChecksumSHA256 === "string" && input.ChecksumSHA256 !== createHash("sha256").update(body).digest("base64")) {
      throw failure("BadDigest", 400, "The SHA256 you specified did not match the calculated checksum.");
    }
    if (typeof input.ContentMD5 === "string" && input.ContentMD5 !== createHash("md5").update(body).digest("base64")) {
      throw failure("BadDigest", 400, "The Content-MD5 you specified did not match what we received.");
    }
    const latest = this.entries.get(key)?.at(-1);
    if (latest?.kind === "version") throw failure("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold");
    const versionId = this.addVersion(key, body, retainUntilDate?.getTime());
    return { VersionId: versionId, ETag: `"${createHash("md5").update(body).digest("hex")}"`, $metadata: { httpStatusCode: 200 } };
  }

  private select(input: Record<string, unknown>): StoredVersion {
    const key = String(input.Key);
    const list = this.entries.get(key) ?? [];
    if (typeof input.VersionId === "string") {
      const found = list.find((entry) => entry.versionId === input.VersionId);
      if (found === undefined) throw failure("NoSuchVersion", 404, "The specified version does not exist.");
      if (found.kind === "marker") throw failure("MethodNotAllowed", 405, "The specified method is not allowed against this resource.");
      return found;
    }
    const latest = list.at(-1);
    if (latest?.kind !== "version") throw failure("NoSuchKey", 404, "The specified key does not exist.");
    return latest;
  }

  private get(input: Record<string, unknown>): unknown {
    const found = this.select(input);
    return {
      Body: {
        transformToString: async () => found.body.toString("utf8"),
        transformToByteArray: async () => new Uint8Array(found.body),
      },
      VersionId: found.versionId,
      ContentLength: found.body.length,
      LastModified: new Date(found.lastModified),
      ObjectLockMode: found.lockMode,
      ObjectLockRetainUntilDate: new Date(found.retainUntil),
      $metadata: { httpStatusCode: 200 },
    };
  }

  private head(input: Record<string, unknown>): unknown {
    let found: StoredVersion;
    try {
      found = this.select(input);
    } catch (error) {
      // HeadObject has no body to carry the error code: S3 answers 404 NotFound.
      if ((error as Error).name === "NoSuchKey" || (error as Error).name === "NoSuchVersion") throw failure("NotFound", 404, "NotFound");
      throw error;
    }
    return {
      VersionId: found.versionId,
      ContentLength: found.body.length,
      LastModified: new Date(found.lastModified),
      ObjectLockMode: found.lockMode,
      ObjectLockRetainUntilDate: new Date(found.retainUntil),
      ChecksumSHA256: found.checksumSha256,
      $metadata: { httpStatusCode: 200 },
    };
  }

  private list(input: Record<string, unknown>): unknown {
    const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
    const maxKeys = typeof input.MaxKeys === "number" ? input.MaxKeys : 1000;
    // Keys ascending, the newest version of a key first, as S3 lists them.
    const all: Array<{ key: string; entry: Entry; latest: boolean }> = [];
    for (const key of [...this.entries.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const list = this.entries.get(key)!;
      for (let index = list.length - 1; index >= 0; index -= 1) all.push({ key, entry: list[index]!, latest: index === list.length - 1 });
    }
    let start = 0;
    if (typeof input.KeyMarker === "string") {
      const position = all.findIndex((item) => item.key === input.KeyMarker && (input.VersionIdMarker === undefined || item.entry.versionId === input.VersionIdMarker));
      start = position === -1 ? all.length : position + 1;
    }
    const page = all.slice(start, start + maxKeys);
    const truncated = start + maxKeys < all.length;
    const last = page.at(-1);
    return {
      Versions: page.filter((item) => item.entry.kind === "version").map((item) => ({
        Key: item.key, VersionId: item.entry.versionId, IsLatest: item.latest, LastModified: new Date(item.entry.lastModified),
        Size: (item.entry as StoredVersion).body.length,
      })),
      DeleteMarkers: page.filter((item) => item.entry.kind === "marker").map((item) => ({
        Key: item.key, VersionId: item.entry.versionId, IsLatest: item.latest, LastModified: new Date(item.entry.lastModified),
      })),
      IsTruncated: truncated,
      ...(truncated && last !== undefined ? { NextKeyMarker: last.key, NextVersionIdMarker: last.entry.versionId } : {}),
      $metadata: { httpStatusCode: 200 },
    };
  }

  private remove(input: Record<string, unknown>): unknown {
    const key = String(input.Key);
    if (typeof input.VersionId !== "string") {
      this.addDeleteMarker(key);
      return { DeleteMarker: true, $metadata: { httpStatusCode: 204 } };
    }
    const list = this.entries.get(key) ?? [];
    const index = list.findIndex((entry) => entry.versionId === input.VersionId);
    if (index === -1) throw failure("NoSuchVersion", 404, "The specified version does not exist.");
    const found = list[index]!;
    if (found.kind === "version" && found.retainUntil > this.options.now()) throw failure("AccessDenied", 403, "Access Denied: the object version is locked");
    list.splice(index, 1);
    return { $metadata: { httpStatusCode: 204 } };
  }
}

function toBuffer(body: unknown): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("FakeLockedS3 takes a string or bytes as a PutObject body");
}
