// The AWS SDK adapters of the Team record's storage ports (wire-team-record): a direct Lambda invoke of the self-hosted embedder, S3 Vectors for the vector index, Athena for the lake.
//
// The three SDK packages are loaded ON FIRST USE (a literal dynamic import each), so that a broker where the Team record is off (the default) never evaluates them. S3 Vectors and Athena are
// declared dependencies of the broker and are bundled with it, so the Lambda runtime's own SDK version does not matter (fix round 1, S1). If a package cannot be loaded the first call fails with
// the fixed code `sdk_unavailable` and the record's code treats it as a storage failure. Nothing here ever logs an SDK error message: SDK errors can echo request text.
//
// [verify] in the test environment: the request and response shapes below follow the AWS documentation of the three APIs as the storage lane wrote its ports; the first run of
// `tests/live/team-record-storage` (listed in the report's Test-environment checklist) is what confirms them against the real services.
import type { VectorCredentials } from "./vector-access.js";
import type { EmbedderInvoke } from "../embedder/client.js";
import type { AthenaPort, AthenaState } from "./lake.js";
import type { S3VectorsPort } from "./s3-vectors-index.js";

type AnyClient = { send(command: unknown): Promise<unknown> };
type Constructor<T> = new (input: Record<string, unknown>) => T;

export class SdkUnavailableError extends Error {
  readonly code = "sdk_unavailable";
  constructor() { super("sdk_unavailable"); this.name = "SdkUnavailableError"; }
}

/**
 * Loads a package by name, on first use. Each name is a LITERAL import, so the bundler includes the package (they are dependencies of the broker: `@aws-sdk/client-s3vectors` and
 * `@aws-sdk/client-athena` at 3.1134.0, the version of the other clients) and evaluates it only when the record is used; a broker with the record off never loads them. The Lambda client
 * is the broker's own dependency, loaded the same way. A name this does not know, or a package that cannot be loaded, is the fixed `sdk_unavailable`.
 */
export type SdkLoader = (name: string) => Promise<Record<string, unknown>>;
export const loadSdkPackage: SdkLoader = async (name) => {
  try {
    switch (name) {
      case "@aws-sdk/client-s3vectors": return await import("@aws-sdk/client-s3vectors");
      case "@aws-sdk/client-athena": return await import("@aws-sdk/client-athena");
      case "@aws-sdk/client-lambda": return await import("@aws-sdk/client-lambda");
    }
  } catch {
    // fall through to the fixed error
  }
  throw new SdkUnavailableError();
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

// ---- The self-hosted embedder (a Lambda invoked directly)

/**
 * Invokes the embedder function and returns its JSON answer. The function reports its own refusals as a normal answer with `ok: false` and a fixed code, so a function error
 * (a crash, a timeout inside the function) is a failure of the call. The wait is bounded here: when it runs out the call is abandoned, the function carries on and is warm for the next.
 * Errors keep only their NAME as `code` (the retry rules read it), never their message.
 */
export function lambdaEmbedderInvoke(options: SdkOptions & { functionName: string; timeoutMs: number }): EmbedderInvoke {
  const load = options.load ?? loadSdkPackage;
  let client: Promise<{ module: Record<string, unknown>; client: AnyClient & { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> } }> | undefined;
  const open = () => client ??= load("@aws-sdk/client-lambda").then((module) => {
    const Client = module.LambdaClient as (new (config: Record<string, unknown>) => AnyClient) | undefined;
    if (typeof Client !== "function") throw new SdkUnavailableError();
    return { module, client: new Client(options.region === undefined ? {} : { region: options.region }) as never };
  });
  return async (request, limit) => {
    const { module, client: lambda } = await open();
    const abort = new AbortController();
    // The configured wait, or less when the caller's own run has less left (EmbedderCall.deadline).
    const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(options.timeoutMs, limit?.timeoutMs ?? options.timeoutMs)));
    try {
      const reply = await lambda.send(command(module, "InvokeCommand", { FunctionName: options.functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(request)) }), { abortSignal: abort.signal }) as { StatusCode?: number; FunctionError?: string; Payload?: Uint8Array };
      if (reply.FunctionError !== undefined) throw Object.assign(new Error("FunctionError"), { name: "FunctionError" });
      if (reply.StatusCode !== 200 || reply.Payload === undefined) throw Object.assign(new Error("BadReply"), { name: "BadReply" });
      return JSON.parse(Buffer.from(reply.Payload).toString("utf8")) as unknown;
    } catch (error) {
      throw coded(error);
    } finally {
      clearTimeout(timer);
    }
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
    async getIndex(request) { await call("GetIndexCommand", request); },
    async deleteIndex(request) { await call("DeleteIndexCommand", request); },
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
