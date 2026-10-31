// R4: running statements on the lake through Athena. The SDK adapter for AthenaPort is not here (@aws-sdk/client-athena is not a
// dependency yet; see report.md). Errors are fixed codes: no text from Athena or from rows ever reaches a log or an error message
// (checklist section 1).
import { createHash, randomUUID } from "node:crypto";

export type AthenaState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface AthenaPort {
  startQuery(request: {
    sql: string;
    /** SQL literals, in order of the ? marks. */
    executionParameters: string[];
    workGroup: string;
    /** Only for statements that change data: unique per attempt (AWS ClientRequestToken, 32 to 128 characters). */
    clientRequestToken?: string;
  }): Promise<{ queryExecutionId: string }>;
  getQueryState(queryExecutionId: string): Promise<{ state: AthenaState }>;
  /** One page of a SELECT result: column names plus string rows (the header row of the Athena API is already removed). */
  getResults(queryExecutionId: string, nextToken?: string): Promise<{ columns: string[]; rows: Array<Array<string | null>>; nextToken?: string }>;
  stopQuery(queryExecutionId: string): Promise<void>;
}

export type LakeErrorCode = "lake_unavailable" | "lake_query_failed" | "lake_timeout";

export class LakeError extends Error {
  constructor(readonly code: LakeErrorCode) {
    super(code);
    this.name = "LakeError";
  }
}

export interface LakeClientOptions {
  athena: AthenaPort;
  workGroup: string;
  now?: () => number;
  /** A fresh value for every attempt of a data-changing statement. Default: a random UUID. */
  newNonce?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** The whole statement, start to results. Default 60 s. */
  timeoutMs?: number;
  /** Rows kept from a SELECT. More is reported as `truncated`. Default 1,000. */
  maxRows?: number;
}

export interface LakeRows {
  rows: Array<Record<string, string | null>>;
  truncated: boolean;
}

export interface LakeClient {
  /** SELECT: returns rows keyed by column name. */
  query(sql: string, parameters: readonly string[]): Promise<LakeRows>;
  /** INSERT or DELETE: waits until it has finished. `parameters` is empty for DELETE (Athena cannot parameterise it). */
  execute(sql: string, parameters: readonly string[]): Promise<void>;
  readonly now: () => number;
}

const MAX_PAGES = 50;

export function createLakeClient(options: LakeClientOptions): LakeClient {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxRows = options.maxRows ?? 1000;
  const newNonce = options.newNonce ?? randomUUID;

  async function run(sql: string, parameters: readonly string[], mutating: boolean): Promise<string> {
    const deadline = now() + timeoutMs;
    let id: string;
    try {
      // One token per ATTEMPT. A token that repeated across attempts would make Athena return the earlier (possibly FAILED) execution
      // for a retry, and an erasure could never be retried. DELETE and INSERT ... WHERE NOT EXISTS are idempotent, so no dedupe is needed.
      const token = mutating ? createHash("sha256").update(`${options.workGroup}\u0000${sql}\u0000${parameters.join("\u0001")}\u0000${newNonce()}`).digest("hex") : undefined;
      ({ queryExecutionId: id } = await options.athena.startQuery({
        sql,
        executionParameters: [...parameters],
        workGroup: options.workGroup,
        ...(token === undefined ? {} : { clientRequestToken: token }),
      }));
    } catch {
      throw new LakeError("lake_unavailable");
    }
    let delay = 200;
    for (;;) {
      let state: AthenaState;
      try {
        ({ state } = await options.athena.getQueryState(id));
      } catch {
        throw new LakeError("lake_unavailable");
      }
      if (state === "SUCCEEDED") return id;
      if (state === "FAILED" || state === "CANCELLED") throw new LakeError("lake_query_failed");
      if (now() + delay > deadline) {
        await options.athena.stopQuery(id).catch(() => undefined);
        throw new LakeError("lake_timeout");
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }

  return {
    now,
    async query(sql, parameters) {
      const id = await run(sql, parameters, false);
      const rows: Array<Record<string, string | null>> = [];
      let token: string | undefined;
      let truncated = false;
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await options.athena.getResults(id, token);
          for (const row of result.rows) {
            if (rows.length >= maxRows) {
              truncated = true;
              break;
            }
            rows.push(Object.fromEntries(result.columns.map((column, i) => [column, row[i] ?? null])));
          }
          token = result.nextToken;
          if (truncated || token === undefined) break;
          if (page === MAX_PAGES - 1) truncated = true;
        }
      } catch {
        throw new LakeError("lake_unavailable");
      }
      return { rows, truncated };
    },
    async execute(sql, parameters) {
      await run(sql, parameters, true);
    },
  };
}
