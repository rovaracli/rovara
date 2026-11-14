// TE-F1e (te-f1e.md item 1; design 2.1, 4.2, 4.3, 5, 7; DECISIONS 157, 163b, 165, 211): the ProductModelEgress function, the ONLY place a customer's product key is held in memory. A Node.js Lambda with response
// streaming, OUTSIDE the VPC (so the key never reaches a worker host that may also run another company's task, and no provider host joins the VPC-wide DNS list), with no Function URL and no API Gateway route.
// The worker's Cloud adapter (packages/worker/src/model-egress-cloud.ts) invokes it with the operation's model-egress capability and the frame; nothing in the frame names a company, a project or a source.
//
// One call, in order (each refusal makes NO model call and holds nothing: a refusal before the reservation writes nothing, one after it settles to 0):
//   1. parse the wire envelope and the frame with F1-a (`parseModelEgressFrame`): bad_request / too_large;
//   2. verify the capability with the PUBLIC key (fork F1) and read the operation's company, project and task from State, checking it is live (operation-scope.ts): else not_found;
//   3. the company gate `productModels` (A1, default off): off is not_found for every call;
//   4. F1-d's `loadProductSourceForRow(org, project, row)`: a source with "tests" on for that row, else not_found (missing and another company's are the same answer);
//   5. the key, through the tagged proxy session (proxy-secret.ts), or for a `gcp-oauth:*` row a token from the GoogleTokenSource seam (until F1-f: the fixed not-run refusal); its spellings are registered with
//      this function's log redactor BEFORE it is used;
//   6. the outbound request, built by F1-a from the ROW (https, the row's host, port 443; inbound credentials dropped; exactly one credential placed), and the host checked against the row again;
//   7. reserve on the meter (meter.ts): task, project month, company month, all or nothing;
//   8. ONE call through the DNS-checked transport (provider-transport.ts): no retry, a redirect is never followed;
//   9. stream back with F1-a's response allow list and key-echo scrub (across chunk boundaries); a 401/403 body is replaced and the source gets a warning (F1-d's `recordProductSourceWarning`);
//  10. settle the meter.
// Logs are fixed fields only: event, row, status, class, refusal word, cost, tokens, time. Never a body, a header value, a query, a provider message, a company's id or a key.
import type { KeyObject } from "node:crypto";
import {
  buildOutboundRequest, builtinModelCatalog, classOfRefusal, classifyProviderResponse, createKeyEchoScanner, createUsageScanner, e2eSecretSpellings, familyErrorBody, isRedirectStatus, isTokenScheme, keyEchoNeedles,
  modelOfBody, parseModelEgressFrame, parseModelEgressRow, refusalResponse, reserveEstimate, sanitizeResponseHeaders, scrubResponseBody, settleCost, usageFromBody, MODEL_EGRESS_MIN_KEY_CHARS, MODEL_EGRESS_REFUSAL_HEADER,
  type ModelEgressConnection, type ModelEgressEvent, type ModelEgressFamily, type ModelEgressFrame, type ModelEgressRefusal, type ModelEgressRow, type ModelEgressSettle, type OrgId,
} from "@rovara-code/contracts";
import { PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES, ProductModelEgressRequestSchema } from "@agentx/cloud-contracts";
import { verifyModelEgressCapability } from "./capability.js";
import { reserveProductAiCall, settleProductAiCall, type ProductAiMeterDependencies, type ProductAiReserveRefusal } from "./meter.js";
import type { OperationScopeReader } from "./operation-scope.js";
import { EgressNotSentError, EgressSsrfError, type ProviderResponse, type ProviderTransport } from "./provider-transport.js";
import type { ProxySecretReader } from "./proxy-secret.js";
import type { GoogleTokenSource, ProductModelsGate, ProductSourceForRow, ProductSourceLoader, ProductSourceWarningRecorder } from "./seams.js";

export type EgressLogFields = Readonly<Record<string, string | number>>;

export interface ProductModelEgressDependencies {
  /** The capability key's public half (KMS GetPublicKey once per cold start in production). */
  readonly publicKey: () => Promise<KeyObject>;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly readScope: OperationScopeReader;
  readonly gate: ProductModelsGate;
  readonly loadSource: ProductSourceLoader;
  /** The egress row a source serves (catalog row plus scheme, prices, default output), or undefined when this function cannot serve it. */
  readonly rowFor: (source: ProductSourceForRow) => ModelEgressRow | undefined;
  /** The family of a PUBLIC row id, for the shape of a refusal that is not about a source ("missing" and "another company's" cannot differ). */
  readonly familyOf: (rowId: string) => ModelEgressFamily | undefined;
  readonly keys: ProxySecretReader;
  readonly tokens: GoogleTokenSource;
  readonly meter: ProductAiMeterDependencies;
  readonly transport: ProviderTransport;
  readonly recordWarning: ProductSourceWarningRecorder;
  readonly log: (fields: EgressLogFields) => void;
}

const UNREACHABLE = "The provider could not be reached.";

/** Whether `host` is one this row may call: one of its own hosts, or an Azure row's connected resource host under the row's suffix. Nothing else, whatever a frame said. */
export function hostAllowedForRow(row: Pick<ModelEgressRow, "hosts" | "hostSuffixes">, connection: ModelEgressConnection, host: string): boolean {
  if (row.hosts.includes(host)) return true;
  return connection.host !== undefined && host === connection.host && row.hostSuffixes.some((suffix) => host.endsWith(`.${suffix}`));
}

/** The connection the ROW's routing reads, from the loaded source record only. */
export function connectionOfSource(source: ProductSourceForRow): ModelEgressConnection {
  return {
    ...(source.resourceHost === undefined ? {} : { host: source.resourceHost }),
    ...(source.vertex === undefined ? {} : { vertex: { project: source.vertex.projectId, location: source.vertex.location } }),
  };
}

/** Production row resolution: the built-in catalog row with the source's scheme, the row's default output, and NO price table yet (every model is reserved at the core's unpriced ceiling and settled as
 * "estimated": it errs high). A gateway or Azure source is not served until its extras are on the source record (DEFERRED TE-F1E-PRICE-TABLE). */
export function defaultProductRowFor(source: ProductSourceForRow): ModelEgressRow | undefined {
  if (source.gatewayHost !== undefined) return undefined;
  const catalogRow = builtinModelCatalog().rows.find((row) => row.id === source.rowId);
  if (catalogRow === undefined) return undefined;
  const parsed = parseModelEgressRow({ ...(JSON.parse(JSON.stringify(catalogRow)) as Record<string, unknown>), scheme: source.scheme, defaultMaxOutputTokens: 4096, prices: [] });
  return parsed.ok && parsed.row.azure === undefined ? parsed.row : undefined;
}
export const defaultFamilyOf = (rowId: string): ModelEgressFamily | undefined => builtinModelCatalog().rows.find((row) => row.id === rowId)?.family;

/**
 * The function's log redactor, scoped to ONE call (REVIEW-1 M-1): every spelling of the call's key (registered BEFORE first use) is cut from the call's log fields, a last guard behind the fixed-fields rule. The
 * spellings live only while the call runs and are dropped when it ends, however it ends (completed, refused, thrown, or abandoned by its reader): no key outlives its call here.
 */
const liveRedactors = new Set<Set<string>>();
/** How many key spellings live calls hold right now (0 when no call is running). For tests and the proof that nothing outlives a call. */
export const egressRedactorNeedlesHeld = (): number => [...liveRedactors].reduce((total, needles) => total + needles.size, 0);

function createCallRedactor(): { register(secret: string): void; clean(fields: EgressLogFields): EgressLogFields; dispose(): void } {
  const needles = new Set<string>();
  liveRedactors.add(needles);
  const cut = (text: string): string => {
    let out = text;
    for (const needle of needles) out = out.split(needle).join("[redacted]");
    return out;
  };
  return {
    register(secret) {
      for (const spelling of e2eSecretSpellings(secret)) if (spelling.length >= 8) needles.add(spelling);
      if (secret.length >= MODEL_EGRESS_MIN_KEY_CHARS) for (const needle of keyEchoNeedles(secret)) if (needle.length >= 8) needles.add(needle);
    },
    clean(fields) {
      const out: Record<string, string | number> = Object.create(null) as Record<string, string | number>;
      for (const [name, value] of Object.entries(fields)) out[cut(name)] = typeof value === "string" ? cut(value) : value;
      return out;
    },
    dispose() {
      needles.clear();
      liveRedactors.delete(needles);
    },
  };
}

function decodeBase64(text: string): Uint8Array {
  const buffer = Buffer.from(text, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const refusalFor = (refusal: ProductAiReserveRefusal): { word: ModelEgressRefusal; capMicros?: number; overrun?: boolean } => {
  if (refusal.reason === "overrun") return { word: "cap", overrun: true };
  if (refusal.reason === "busy") return { word: "overloaded" };
  if (refusal.reason === "cap" && refusal.item === "task" && refusal.capMicros !== undefined) return { word: "cap", capMicros: refusal.capMicros };
  return { word: "cap" };
};

/** One call, as the port's events: one head, chunks, one settle. Never throws for a refusal or a provider fault. */
export async function* handleProductModelEgress(deps: ProductModelEgressDependencies, input: unknown): AsyncGenerator<ModelEgressEvent> {
  const redactor = createCallRedactor();
  try {
    yield* handleCall(deps, input, redactor);
  } finally {
    redactor.dispose();
  }
}

async function* handleCall(deps: ProductModelEgressDependencies, input: unknown, redactor: ReturnType<typeof createCallRedactor>): AsyncGenerator<ModelEgressEvent> {
  const started = deps.now();
  const log = (fields: EgressLogFields): void => {
    try {
      deps.log(redactor.clean({ ...fields, ms: deps.now() - started }));
    } catch {
      // A log sink that throws is not the call's problem.
    }
  };
  let family: ModelEgressFamily = "openai_compatible";
  let rowName = "unknown";
  const refuse = function* (word: ModelEgressRefusal, extra: { capMicros?: number; overrun?: boolean; notRun?: string } = {}): Generator<ModelEgressEvent> {
    const answer = refusalResponse(family, word, extra);
    const body = extra.notRun === undefined ? answer.body : familyErrorBody(family, answer.status, extra.notRun, `rovara_${word}`);
    log({ event: "refused", row: rowName, status: answer.status, class: classOfRefusal(word), refusal: word });
    yield { kind: "head", status: answer.status, headers: answer.headers };
    yield { kind: "chunk", bytes: body };
    yield { kind: "settle", status: answer.status, class: classOfRefusal(word), refusal: word, costMicros: 0, estimated: false };
  };

  // 1. The envelope and the frame (pure; nothing read yet).
  const envelope = ProductModelEgressRequestSchema.safeParse(input);
  if (!envelope.success) {
    // A body over Cloud's limit is `too_large` (refused, never truncated); every other envelope fault is `bad_request`.
    const tooLarge = envelope.error.issues.some((issue) => issue.code === "too_big" && issue.path.join(".") === "frame.body");
    yield* refuse(tooLarge ? "too_large" : "bad_request");
    return;
  }
  family = deps.familyOf(envelope.data.frame.row) ?? "openai_compatible";
  rowName = deps.familyOf(envelope.data.frame.row) === undefined ? "unknown" : envelope.data.frame.row;
  const body = decodeBase64(envelope.data.frame.body);
  if (body.byteLength > PRODUCT_MODEL_CLOUD_BODY_MAX_BYTES) {
    yield* refuse("too_large");
    return;
  }
  const parsed = parseModelEgressFrame({ ...envelope.data.frame, body });
  if (!parsed.ok) {
    yield* refuse(parsed.refusal);
    return;
  }
  const frame: ModelEgressFrame = parsed.frame;

  // 2-4. Whose call, from the capability and our own records only; the gate; the source.
  let orgId: OrgId | undefined;
  let scope: Awaited<ReturnType<OperationScopeReader>>;
  let source: ProductSourceForRow | undefined;
  try {
    const claims = verifyModelEgressCapability(envelope.data.capability, await deps.publicKey(), Math.floor(deps.now() / 1000));
    scope = claims === undefined || claims.purpose !== "task" ? undefined : await deps.readScope(claims);
    orgId = scope?.orgId;
    source = scope === undefined || orgId === undefined || !(await deps.gate(orgId)) ? undefined : await deps.loadSource(orgId, scope.project, frame.row);
  } catch {
    source = undefined;
  }
  if (scope === undefined || orgId === undefined || source === undefined || source.orgId !== orgId || source.project !== scope.project || source.rowId !== frame.row) {
    yield* refuse("not_found");
    return;
  }
  const row = deps.rowFor(source);
  if (row === undefined || row.id !== frame.row) {
    yield* refuse("not_found");
    return;
  }
  family = row.family;
  const connection = connectionOfSource(source);

  // 5. The one credential. Registered with the redactor (inside `deps.log`'s sink in production) before any use.
  let secret: string | undefined;
  if (row.family === "bedrock" || row.scheme === "sigv4") {
    // The route refuses it with its own not-run sentence below; no key is read for it.
    secret = undefined;
  } else if (isTokenScheme(row.scheme)) {
    let minted: Awaited<ReturnType<GoogleTokenSource["tokenFor"]>>;
    try {
      minted = await deps.tokens.tokenFor(orgId, source);
    } catch {
      minted = { ok: false, notRun: "not run: Vertex needs the federation setup" };
    }
    if (!minted.ok) {
      yield* refuse("not_allowed", { notRun: minted.notRun });
      return;
    }
    secret = minted.token;
  } else {
    secret = await deps.keys.keyFor(orgId, source);
  }
  if (secret !== undefined) {
    try {
      redactor.register(secret);
    } catch {
      // A secret too short to scan is refused next.
    }
  }
  if (row.family !== "bedrock" && row.scheme !== "sigv4" && (secret === undefined || secret.length < MODEL_EGRESS_MIN_KEY_CHARS)) {
    yield* refuse("not_allowed");
    return;
  }

  // 6. The outbound request, from the ROW.
  let built: ReturnType<typeof buildOutboundRequest>;
  try {
    built = buildOutboundRequest(row, connection, frame, secret ?? "");
  } catch {
    built = { ok: false, refusal: "bad_request" };
  }
  if (!built.ok) {
    yield* refuse(built.refusal, built.notRun === undefined ? {} : { notRun: built.notRun });
    return;
  }
  const key = secret as string;
  const request = built.request;
  if (!hostAllowedForRow(row, connection, request.host)) {
    yield* refuse("ssrf");
    return;
  }

  // 7. Reserve, before the call.
  const estimate = reserveEstimate({ row, model: built.route.model ?? modelOfBody(request.body), inputBytes: request.body.byteLength, maxOutputTokens: built.maxOutputTokens, externalInput: built.externalInput });
  let reserved: Awaited<ReturnType<typeof reserveProductAiCall>>;
  try {
    reserved = await reserveProductAiCall(deps.meter, {
      orgId, project: scope.project, taskId: scope.taskId, estimateMicros: estimate.reserveMicros,
      caps: { taskMicros: source.caps.taskMicros, taskCalls: source.caps.taskCalls, projectMonthMicros: source.caps.projectMonthMicros, ...(source.companyCeiling?.monthMicros === undefined ? {} : { companyMonthMicros: source.companyCeiling.monthMicros }) },
    });
  } catch {
    reserved = { ok: false, reason: "busy" };
  }
  if (!reserved.ok) {
    const { word, ...extra } = refusalFor(reserved);
    yield* refuse(word, extra);
    return;
  }
  const reservation = reserved.reservation;
  const settleMeter = async (costMicros: number): Promise<boolean> => {
    try {
      return (await settleProductAiCall(deps.meter, reservation, costMicros)).overrun;
    } catch {
      // The reservation stays: the meter errs high.
      log({ event: "settle_failed", row: row.id });
      return false;
    }
  };

  // 8. ONE attempt: a retry after a fault, a 5xx or a 429 can double-spend.
  let response: ProviderResponse | undefined;
  let refusedAddress = false;
  let notSent = false;
  try {
    response = await deps.transport(request);
  } catch (error) {
    response = undefined;
    refusedAddress = error instanceof EgressSsrfError;
    notSent = error instanceof EgressNotSentError;
  }
  if (response === undefined) {
    if (refusedAddress) {
      // Refused before any byte left: nothing was spent.
      await settleMeter(0);
      yield* refuse("ssrf");
      return;
    }
    // Nothing left the process (lookup or connection failed before the TLS handshake): the reservation is released. Otherwise the request may have reached the provider before the fault: the reservation is
    // kept (errs high, never low).
    const cost = notSent ? 0 : estimate.reserveMicros;
    await settleMeter(cost);
    log({ event: "call", row: row.id, status: 502, class: "provider_error", cost });
    yield { kind: "head", status: 502, headers: [["content-type", "application/json"]] };
    yield { kind: "chunk", bytes: familyErrorBody(row.family, 502, UNREACHABLE, "rovara_unreachable") };
    yield { kind: "settle", status: 502, class: "provider_error", costMicros: cost, estimated: !notSent };
    return;
  }
  if (isRedirectStatus(response.status)) {
    // Never followed, never passed on.
    await settleMeter(0);
    yield* refuse("ssrf");
    return;
  }

  // 9. Back to the worker, scrubbed.
  const headers = sanitizeResponseHeaders(response.headers, { key }).filter(([name]) => name !== MODEL_EGRESS_REFUSAL_HEADER);
  const contentType = response.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  const streaming = response.status < 400 && (built.route.streaming === "always" || /event-stream/iu.test(contentType));
  const finish = async (args: { status: number; usage: ReturnType<typeof usageFromBody>; cls: ModelEgressSettle["class"]; complete: boolean }): Promise<ModelEgressSettle> => {
    const cost = settleCost({ reservation: estimate, usage: args.usage, complete: args.complete });
    const overrun = await settleMeter(cost.costMicros);
    log({ event: "call", row: row.id, status: args.status, class: args.cls, cost: cost.costMicros, ...(args.usage === undefined ? {} : { inputTokens: args.usage.inputTokens, outputTokens: args.usage.outputTokens }) });
    return { kind: "settle", status: args.status, class: args.cls, ...(args.usage === undefined ? {} : { inputTokens: args.usage.inputTokens, outputTokens: args.usage.outputTokens }), costMicros: cost.costMicros, estimated: cost.estimated, ...(overrun ? { overrun: true } : {}) };
  };
  if (response.status === 401 || response.status === 403) {
    try {
      await deps.recordWarning(orgId, scope.project, source.sourceId, { status: response.status, at: new Date(deps.now()).toISOString() });
    } catch {
      log({ event: "warning_failed", row: row.id });
    }
  }

  if (!streaming) {
    const parts: Uint8Array[] = [];
    let complete = true;
    try {
      for await (const part of response.body) parts.push(part);
    } catch {
      complete = false;
    }
    if (!complete) {
      // Cut off mid-body (the 10 MiB cap, a reset, the deadline): never the provider's status with half a body. A provider error ("not run", DEC 171), settled at the reservation or more (REVIEW-1 M-2).
      yield { kind: "head", status: 502, headers: [["content-type", "application/json"]] };
      yield { kind: "chunk", bytes: familyErrorBody(row.family, 502, UNREACHABLE, "rovara_unreachable") };
      yield await finish({ status: 502, usage: undefined, cls: "provider_error", complete: false });
      return;
    }
    const whole = Buffer.concat(parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)));
    const wholeBytes = new Uint8Array(whole.buffer, whole.byteOffset, whole.byteLength);
    const scrubbed = scrubResponseBody({ family: row.family, status: response.status, headers: response.headers, body: wholeBytes, key });
    const cls = classifyProviderResponse({ status: response.status, body: wholeBytes });
    yield { kind: "head", status: response.status, headers };
    yield { kind: "chunk", bytes: scrubbed.body };
    yield await finish({ status: response.status, usage: usageFromBody(row.family, wholeBytes), cls, complete });
    return;
  }

  const scanner = createKeyEchoScanner(key);
  const usage = createUsageScanner(row.family);
  let complete = true;
  let hit = false;
  yield { kind: "head", status: response.status, headers };
  try {
    for await (const part of response.body) {
      usage.push(part);
      const step = scanner.push(part);
      if (step.safe.byteLength > 0) yield { kind: "chunk", bytes: step.safe };
      if (step.hit) {
        hit = true;
        complete = false;
        break;
      }
    }
  } catch {
    complete = false;
  }
  if (!hit) {
    const end = scanner.finish();
    if (end.safe.byteLength > 0) yield { kind: "chunk", bytes: end.safe };
    hit = end.hit;
    if (hit) complete = false;
  }
  yield await finish({ status: response.status, usage: usage.finish(), cls: hit || !complete ? "provider_error" : classifyProviderResponse({ status: response.status }), complete });
}
