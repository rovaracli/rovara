// The AWS SDK adapters of the Team record's storage ports (wire-team-record): Bedrock `InvokeModel` for embeddings, S3 Vectors for the vector index, Athena for the lake.
//
// The three SDK packages are loaded ON FIRST USE, by name, so that a broker where the Team record is off (the default) never loads them, and so that this file builds where
// `@aws-sdk/client-s3vectors` and `@aws-sdk/client-athena` are not installed as dependencies yet (they are not in package-lock.json; adding them needs a network `npm install`, see the lane
// report). The Lambda Node.js runtime carries the AWS SDK for JavaScript v3. If a package is missing there, the first call fails with the fixed code `sdk_unavailable` and the record's
// code treats it as a storage failure (rows are stored with `embedPending`, search falls back to keywords, the lake answers "history unavailable"). Nothing here ever logs an SDK error
// message: SDK errors can echo request text.
//
// [verify] in the test environment: the request and response shapes below follow the AWS documentation of the three APIs as the storage lane wrote its ports; the first run of
// `tests/live/team-record-storage` (listed in the report's Test-environment checklist) is what confirms them against the real services.
import type { VectorCredentials } from "./vector-access.js";
import type { InvokeModelPort } from "./embed.js";
import type { AthenaPort, AthenaState } from "./lake.js";
import type { S3VectorsPort } from "./s3-vectors-index.js";

type AnyClient = { send(command: unknown): Promise<unknown> };
type Constructor<T> = new (input: Record<string, unknown>) => T;

export class SdkUnavailableError extends Error {
  readonly code = "sdk_unavailable";
  constructor() { super("sdk_unavailable"); this.name = "SdkUnavailableError"; }
}

/** Loads a package by name. The name is a variable on purpose: the bundler must not try to resolve it at build time. */
export type SdkLoader = (name: string) => Promise<Record<string, unknown>>;
export const loadSdkPackage: SdkLoader = async (name) => {
  try {
    return await import(/* @vite-ignore */ name) as Record<string, unknown>;
  } catch {
    throw new SdkUnavailableError();
  }
};

const command = <T>(module: Record<string, unknown>, name: string, input: Record<string, unknown>): T => {
  const ctor = module[name] as Constructor<T> | undefined;
  if (typeof ctor !== "function") throw new SdkUnavailableError();
  return new ctor(input);
};

/** Keeps only the error's NAME as `code` (what the retry rules read), never its message. */
function coded(error: unknown): Error & { code?: string } {
  const name = typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "Error";
  const wrapped: Error & { code?: string } = new Error(name);
  wrapped.code = name;
  return wrapped;
}

async function send<T>(client: AnyClient, input: unknown): Promise<T> {
  try {
    return await client.send(input) as T;
  } catch (error) {
    throw coded(error);
  }
}

export interface SdkOptions { region: string | undefined; load?: SdkLoader }

// ---- Bedrock embeddings

export function bedrockInvokeModelPort(options: SdkOptions): InvokeModelPort {
  const load = options.load ?? loadSdkPackage;
  let client: Promise<{ module: Record<string, unknown>; client: AnyClient }> | undefined;
  const open = () => client ??= load("@aws-sdk/client-bedrock-runtime").then((module) => {
    const Client = module.BedrockRuntimeClient as (new (config: Record<string, unknown>) => AnyClient) | undefined;
    if (typeof Client !== "function") throw new SdkUnavailableError();
    return { module, client: new Client(options.region === undefined ? {} : { region: options.region }) };
  });
  return async ({ modelId, body }) => {
    const { module, client: bedrock } = await open();
    const reply = await send<{ body?: Uint8Array }>(bedrock, command(module, "InvokeModelCommand", { modelId, body, contentType: "application/json", accept: "application/json" }));
    return reply.body === undefined ? "" : Buffer.from(reply.body).toString("utf8");
  };
}

// ---- S3 Vectors

/** An S3 Vectors port that signs with the given (per-workspace session) credentials. */
export function s3VectorsPortFromCredentials(options: SdkOptions, credentials: VectorCredentials): S3VectorsPort {
  const load = options.load ?? loadSdkPackage;
  let client: Promise<{ module: Record<string, unknown>; client: AnyClient }> | undefined;
  const open = () => client ??= load("@aws-sdk/client-s3vectors").then((module) => {
    const Client = module.S3VectorsClient as (new (config: Record<string, unknown>) => AnyClient) | undefined;
    if (typeof Client !== "function") throw new SdkUnavailableError();
    return { module, client: new Client({ ...(options.region === undefined ? {} : { region: options.region }), credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } }) };
  });
  const call = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
    const { module, client: s3 } = await open();
    return send<T>(s3, command(module, name, input));
  };
  return {
    async putVectors(request) { await call("PutVectorsCommand", request); },
    async queryVectors(request) {
      const reply = await call<{ vectors?: Array<{ key: string; distance?: number; metadata?: unknown }>; nextToken?: string }>("QueryVectorsCommand", request);
      return { vectors: reply.vectors ?? [], ...(reply.nextToken === undefined ? {} : { nextToken: reply.nextToken }) };
    },
    async getVectors(request) {
      const reply = await call<{ vectors?: Array<{ key: string; data?: { float32?: number[] }; metadata?: unknown }> }>("GetVectorsCommand", request);
      return { vectors: reply.vectors ?? [] };
    },
    async deleteVectors(request) { await call("DeleteVectorsCommand", request); },
    async createIndex(request) { await call("CreateIndexCommand", request); },
  };
}

// ---- Athena

export function athenaPort(options: SdkOptions): AthenaPort {
  const load = options.load ?? loadSdkPackage;
  let client: Promise<{ module: Record<string, unknown>; client: AnyClient }> | undefined;
  const open = () => client ??= load("@aws-sdk/client-athena").then((module) => {
    const Client = module.AthenaClient as (new (config: Record<string, unknown>) => AnyClient) | undefined;
    if (typeof Client !== "function") throw new SdkUnavailableError();
    return { module, client: new Client(options.region === undefined ? {} : { region: options.region }) };
  });
  const call = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
    const { module, client: athena } = await open();
    return send<T>(athena, command(module, name, input));
  };
  return {
    async startQuery(request) {
      const reply = await call<{ QueryExecutionId?: string }>("StartQueryExecutionCommand", {
        QueryString: request.sql, WorkGroup: request.workGroup,
        ...(request.executionParameters.length === 0 ? {} : { ExecutionParameters: request.executionParameters }),
        ...(request.clientRequestToken === undefined ? {} : { ClientRequestToken: request.clientRequestToken }),
      });
      if (reply.QueryExecutionId === undefined) throw coded({ name: "NoQueryExecutionId" });
      return { queryExecutionId: reply.QueryExecutionId };
    },
    async getQueryState(queryExecutionId) {
      const reply = await call<{ QueryExecution?: { Status?: { State?: string } } }>("GetQueryExecutionCommand", { QueryExecutionId: queryExecutionId });
      const state = reply.QueryExecution?.Status?.State;
      const known: readonly AthenaState[] = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"];
      if (state === undefined || !known.includes(state as AthenaState)) throw coded({ name: "UnknownQueryState" });
      return { state: state as AthenaState };
    },
    async getResults(queryExecutionId, nextToken) {
      const reply = await call<{ ResultSet?: { ResultSetMetadata?: { ColumnInfo?: Array<{ Name?: string }> }; Rows?: Array<{ Data?: Array<{ VarCharValue?: string }> }> }; NextToken?: string }>("GetQueryResultsCommand", { QueryExecutionId: queryExecutionId, ...(nextToken === undefined ? {} : { NextToken: nextToken }) });
      const columns = (reply.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []).map((column) => column.Name ?? "");
      const rows = (reply.ResultSet?.Rows ?? []).map((row) => (row.Data ?? []).map((cell) => cell.VarCharValue ?? null));
      // Athena returns the column names as the first row of the FIRST page only.
      return { columns, rows: nextToken === undefined ? rows.slice(1) : rows, ...(reply.NextToken === undefined ? {} : { nextToken: reply.NextToken }) };
    },
    async stopQuery(queryExecutionId) { await call("StopQueryExecutionCommand", { QueryExecutionId: queryExecutionId }); },
  };
}
