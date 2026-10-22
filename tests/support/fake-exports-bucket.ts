// An in-memory exports bucket for the audit tests: PutObject (with If-None-Match), GetObject, DeleteObject and ListObjectsV2 (prefix,
// MaxKeys and continuation tokens, as S3 pages them), with every call kept.
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

export interface FakeBucketCall {
  command: "PutObject" | "GetObject" | "DeleteObject" | "ListObjectsV2";
  bucket: string | undefined;
  key: string | undefined;
  prefix?: string;
}

export class FakeExportsBucket {
  readonly objects = new Map<string, Buffer>();
  readonly calls: FakeBucketCall[] = [];
  /** Runs inside a put, before it takes effect: a concurrent run's commit, or a shred, say. */
  beforePut: ((key: string) => void | Promise<void>) | undefined;
  /** Runs before a delete takes effect; throw to make it fail. */
  beforeDelete: ((key: string) => void | Promise<void>) | undefined;
  /** Runs before a list; throw to make it fail. */
  beforeList: (() => void | Promise<void>) | undefined;
  /** The most keys one list call returns. S3's own limit is 1000. */
  pageSize = 1000;

  readonly client = { send: (command: unknown) => this.send(command) } as unknown as S3Client;

  /** The keys held, sorted. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  /** The keys under `prefix`. */
  keysUnder(prefix: string): string[] {
    return this.keys().filter((key) => key.startsWith(prefix));
  }

  async send(command: unknown): Promise<unknown> {
    await Promise.resolve();
    const input = (command as { input: Record<string, unknown> }).input;
    const bucket = typeof input.Bucket === "string" ? input.Bucket : undefined;
    if (command instanceof ListObjectsV2Command) {
      const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
      this.calls.push({ command: "ListObjectsV2", bucket, key: undefined, prefix });
      await this.beforeList?.();
      const after = typeof input.ContinuationToken === "string" ? input.ContinuationToken : undefined;
      const limit = Math.min(typeof input.MaxKeys === "number" ? input.MaxKeys : 1000, this.pageSize);
      const matching = this.keysUnder(prefix).filter((key) => after === undefined || key > after);
      const page = matching.slice(0, limit);
      const truncated = matching.length > page.length;
      return {
        Contents: page.map((Key) => ({ Key, Size: this.objects.get(Key)!.length })),
        KeyCount: page.length,
        IsTruncated: truncated,
        ...(truncated ? { NextContinuationToken: page.at(-1) } : {}),
        $metadata: { httpStatusCode: 200 },
      };
    }
    const key = String(input.Key);
    if (command instanceof PutObjectCommand) {
      this.calls.push({ command: "PutObject", bucket, key });
      await this.beforePut?.(key);
      // `If-None-Match: *` fails with 412 when the key exists, as S3 does.
      if (input.IfNoneMatch === "*" && this.objects.has(key)) throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      this.objects.set(key, Buffer.from(input.Body as Uint8Array));
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof GetObjectCommand) {
      this.calls.push({ command: "GetObject", bucket, key });
      const body = this.objects.get(key);
      if (body === undefined) throw Object.assign(new Error("no such key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    if (command instanceof DeleteObjectCommand) {
      this.calls.push({ command: "DeleteObject", bucket, key });
      await this.beforeDelete?.(key);
      this.objects.delete(key);
      return { $metadata: { httpStatusCode: 204 } };
    }
    throw new Error("FakeExportsBucket supports put, get, delete and list only");
  }
}
