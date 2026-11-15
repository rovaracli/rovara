// A DynamoDB that answers at the wire: the gateway's own signed HTTP request (X-Amz-Target, SigV4 Authorization, JSON
// AttributeValues) goes in, DynamoDB's JSON answer (or its error body) comes out, with no socket. Items, conditions,
// update expressions, index queries and all-or-nothing transactions are FakeDynamoDb's (tests/support/fake-dynamodb.ts), the
// same evaluator cloud/next's other stores are tested on. Marshalling is this file's own, not the code under test's.
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { AwsUnknownError, type WireRequest, type WireResponse, type WireTransport } from "../../packages/model-gateway/src/aws.js";
import { GATEWAY_LEDGER_INDEXES, GATEWAY_METER_INDEXES } from "../../packages/model-gateway/src/deploy.js";

const INDEXES = [...Object.values(GATEWAY_LEDGER_INDEXES), ...Object.values(GATEWAY_METER_INDEXES)];

type Json = Record<string, unknown>;
export interface WireCall { operation: string; table: string; keys: Array<{ pk: string; sk: string }>; input: Json }
/** What a fault does: answer an error before applying, apply then lose the answer (outcome unknown), or hang until aborted. */
export type WireFault = { kind: "error"; status: number; type: string; reasons?: string[] } | { kind: "lost-after-apply" } | { kind: "lost-before-apply" } | { kind: "hang" };

const COMMANDS: Record<string, string> = { GetItem: "GetCommand", PutItem: "PutCommand", UpdateItem: "UpdateCommand", DeleteItem: "DeleteCommand", Query: "QueryCommand", TransactWriteItems: "TransactWriteCommand" };
// Binary is held as { $b64 } so FakeDynamoDb's JSON-length item-size check counts it near its real size (4/3).
function fromWire(value: unknown): unknown {
  const [[type, inner]] = Object.entries(value as Json) as [[string, unknown]];
  switch (type) {
    case "S": case "BOOL": return inner;
    case "N": return Number(inner);
    case "NULL": return null;
    case "B": return { $b64: inner };
    case "L": return (inner as unknown[]).map(fromWire);
    case "M": return plain(inner);
    default: throw new Error(`unsupported attribute type ${type}`);
  }
}
function toWire(value: unknown): unknown {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toWire) };
  const object = value as Json;
  if (typeof object.$b64 === "string" && Object.keys(object).length === 1) return { B: object.$b64 };
  return { M: wire(object) };
}
const plain = (value: unknown): Json => Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, fromWire(v)]));
const wire = (value: Json): Json => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));

export class WireDynamo {
  readonly fake = new FakeDynamoDb({ indexKeys: Object.fromEntries(INDEXES.map((index) => [index.name, { partition: index.partitionKey, sort: index.sortKey }])) });
  readonly calls: WireCall[] = [];
  readonly requests: WireRequest[] = [];
  /** Which table each item was written to: a read on another table does not see it. */
  readonly #tableOf = new Map<string, string>();
  readonly #tokens = new Map<string, string>();
  #faults: Array<{ match: (call: WireCall) => boolean; fault: WireFault; times: number }> = [];
  constructor(readonly tables: readonly string[]) {}

  fault(match: (call: WireCall) => boolean, fault: WireFault, times = 1): void { this.#faults.push({ match, fault, times }); }
  /** All items of a table, as plain values. */
  items(table: string): Json[] {
    const binary = (value: unknown): unknown => Array.isArray(value) ? value.map(binary) : value !== null && typeof value === "object" ? (typeof (value as Json).$b64 === "string" ? new Uint8Array(Buffer.from((value as Json).$b64 as string, "base64")) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, binary(v)]))) : value;
    return [...this.fake.items.values()].filter((item) => this.#tableOf.get(JSON.stringify([item.pk, item.sk])) === table).map((item) => binary(structuredClone(item)) as Json);
  }

  readonly transport: WireTransport = async (request) => {
    this.requests.push(request);
    const target = request.headers["x-amz-target"] ?? "";
    if (!request.url.startsWith("https://dynamodb.") || !/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/[a-z0-9-]+\/dynamodb\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/u.test(request.headers.authorization ?? "") || request.headers["content-type"] !== "application/x-amz-json-1.0" || !target.startsWith("DynamoDB_20120810.")) {
      return this.#error(400, "MissingAuthenticationTokenException");
    }
    const operation = target.slice("DynamoDB_20120810.".length);
    const input = JSON.parse(request.body.toString("utf8")) as Json;
    const call = this.#describe(operation, input);
    this.calls.push(call);
    if (call.table === "" || call.keys.some((key) => typeof key.pk !== "string")) return this.#error(400, "ValidationException");
    const found = this.#faults.find((each) => each.times > 0 && each.match(call));
    if (found !== undefined) {
      found.times--;
      if (found.fault.kind === "error") return this.#error(found.fault.status, found.fault.type, found.fault.reasons);
      if (found.fault.kind === "lost-before-apply") return { status: 500, body: Buffer.from("{}") };
      if (found.fault.kind === "hang") {
        return new Promise<WireResponse>((_, reject) => {
          const fail = () => reject(new AwsUnknownError());
          if (request.signal?.aborted) fail(); else request.signal?.addEventListener("abort", fail, { once: true });
        });
      }
      await this.#apply(operation, input, call);
      return { status: 500, body: Buffer.from("{}") };
    }
    return this.#apply(operation, input, call);
  };

  #describe(operation: string, input: Json): WireCall {
    if (operation === "TransactWriteItems") {
      const entries = (input.TransactItems as Json[]).map((entry) => Object.values(entry)[0] as Json);
      const tables = [...new Set(entries.map((entry) => String(entry.TableName)))];
      return { operation, table: tables.join(","), keys: entries.map((entry) => plain(entry.Key ?? entry.Item) as { pk: string; sk: string }), input };
    }
    const key = input.Key ?? input.Item;
    return { operation, table: typeof input.TableName === "string" ? input.TableName : "", keys: key === undefined ? [] : [plain(key) as { pk: string; sk: string }], input };
  }

  async #apply(operation: string, input: Json, call: WireCall): Promise<WireResponse> {
    const command = COMMANDS[operation];
    if (command === undefined) return this.#error(400, "UnknownOperationException");
    if (call.table.split(",").some((table) => !this.tables.includes(table))) return this.#error(400, "ResourceNotFoundException");
    const token = input.ClientRequestToken as string | undefined;
    const fingerprint = JSON.stringify(input.TransactItems ?? null);
    if (token !== undefined && this.#tokens.has(token)) {
      // DynamoDB: a repeat of an applied transaction with its token answers success without applying again.
      return this.#tokens.get(token) === fingerprint ? { status: 200, body: Buffer.from("{}") } : this.#error(400, "IdempotentParameterMismatchException");
    }
    const values = (entry: Json): Json => {
      const out: Json = { ...entry };
      if (entry.Key !== undefined) out.Key = plain(entry.Key);
      if (entry.Item !== undefined) out.Item = plain(entry.Item);
      if (entry.ExpressionAttributeValues !== undefined) out.ExpressionAttributeValues = plain(entry.ExpressionAttributeValues);
      delete out.ClientRequestToken;
      return out;
    };
    const translated = operation === "TransactWriteItems"
      ? { TransactItems: (input.TransactItems as Json[]).map((entry) => Object.fromEntries(Object.entries(entry).map(([kind, action]) => [kind, values(action as Json)]))) }
      : values(input);
    if (operation === "GetItem") {
      const key = translated.Key as { pk: string; sk: string };
      if ((this.#tableOf.get(JSON.stringify([key.pk, key.sk])) ?? call.table) !== call.table) return this.#ok({});
    }
    if (operation === "Query" && translated.IndexName !== undefined && !INDEXES.some((index) => index.name === translated.IndexName)) return this.#error(400, "ValidationException");
    try {
      const answer = await this.fake.send({ constructor: { name: command }, input: translated }) as Json;
      if (operation === "TransactWriteItems") {
        for (const entry of input.TransactItems as Json[]) { const action = Object.values(entry)[0] as Json; const key = plain(action.Key ?? action.Item); this.#tableOf.set(JSON.stringify([key.pk, key.sk]), String(action.TableName)); }
        if (token !== undefined) this.#tokens.set(token, fingerprint);
      } else if (["PutItem", "UpdateItem"].includes(operation)) {
        const key = (translated.Key ?? translated.Item) as Json; this.#tableOf.set(JSON.stringify([key.pk, key.sk]), call.table);
      }
      if (operation === "GetItem") return this.#ok(answer.Item === undefined ? {} : { Item: wire(answer.Item as Json) });
      if (operation === "Query") {
        const items = (answer.Items as Json[]).filter((item) => this.#tableOf.get(JSON.stringify([item.pk, item.sk])) === call.table);
        return this.#ok({ Items: items.map(wire), Count: items.length });
      }
      return this.#ok({});
    } catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code: string }> };
      const name = failure.name ?? "InternalServerError";
      if (name === "Error" || name === "TypeError") throw error;
      return this.#error(400, name, failure.CancellationReasons?.map((reason) => reason.Code));
    }
  }

  #ok(body: Json): WireResponse { return { status: 200, body: Buffer.from(JSON.stringify(body)) }; }
  #error(status: number, type: string, reasons?: string[]): WireResponse {
    return { status, body: Buffer.from(JSON.stringify({ __type: `com.amazonaws.dynamodb.v20120810#${type}`, message: "fixed fake message", ...(reasons === undefined ? {} : { CancellationReasons: reasons.map((Code) => ({ Code })) }) })) };
  }
}
