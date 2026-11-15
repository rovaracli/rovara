import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { credentialsFromEnvironment, type CredentialSource } from "./aws.js";
import type { CapsSource } from "./caps.js";
import { runCorrections, runExpirySweep } from "./correction.js";
import { GATEWAY_ENV, GATEWAY_LOG_EVENTS, GATEWAY_MODES } from "./deploy.js";
import { Dynamo } from "./dynamo.js";
import { DynamoEndedTasks, DynamoMeter } from "./dynamo-meter.js";
import { DynamoPriceSnapshotStore } from "./dynamo-prices.js";
import type { ModelLimitsSource } from "./guard.js";
import { createJwksReader, StaticInstallRegistry } from "./installs.js";
import { SnapshotPriceSource } from "./price-index.js";
import { PriceRefresher } from "./price-refresh.js";
import { fetchAWS, fetchLiteLLM, fetchTransport } from "./price-sources.js";
import { CALL_HARD_CEILING_MS, createAnthropicTransport, type ProviderKeys, type ProviderTransport } from "./provider.js";
import { createSecretsManagerKeys } from "./secrets.js";
import { createGatewayHandler, type GatewayDependencies } from "./server.js";
import { createTaskTokenVerifier } from "./token.js";

/**
 * The gateway process (the image's entry, main.ts): GATEWAY_MODE=serve runs the HTTP service behind the load balancer,
 * GATEWAY_MODE=price-fetch runs the daily price fetch once and exits. Settings come from deploy.ts's environment names; a
 * provider key comes from Secrets Manager by ARN, never from the environment.
 */

export type GatewayEnv = Readonly<Record<string, string | undefined>>;
export interface InstallConfig { issuer: string; jwksUrl: string; taskKids: string[] }
export interface ServeConfig { mode: "serve"; region: string; port: number; install: InstallConfig; tables: { meter: string; ledger: string; markers: string; prices: string }; anthropicKeySecret: string }
export interface PriceFetchConfig { mode: "price-fetch"; region: string; tables: { prices: string } }
export type GatewayConfig = ServeConfig | PriceFetchConfig;

/** A setting is missing or malformed. The message names the variable (a name, never a value). */
export class GatewayConfigError extends Error {
  constructor(readonly variable: string) { super(`gateway setting missing or invalid: ${variable}`); this.name = "GatewayConfigError"; }
}

const TABLE = /^[A-Za-z0-9_.-]{3,255}$/u;
const KID = /^[A-Za-z0-9_-]{16}$/u;
export const JWKS_PATH = "/.well-known/jwks.json";

export function readGatewayConfig(env: GatewayEnv): GatewayConfig {
  const need = (name: string, valid: (value: string) => boolean): string => {
    const value = env[name];
    if (value === undefined || value.length > 2048 || !valid(value)) throw new GatewayConfigError(name);
    return value;
  };
  const mode = need(GATEWAY_ENV.mode, (value) => (GATEWAY_MODES as readonly string[]).includes(value)) as GatewayConfig["mode"];
  const regionName = env.AWS_REGION !== undefined ? "AWS_REGION" : "AWS_DEFAULT_REGION";
  const region = need(regionName, (value) => /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(value));
  const prices = need(GATEWAY_ENV.pricesTable, (value) => TABLE.test(value));
  if (mode === "price-fetch") return { mode, region, tables: { prices } };
  const port = Number(need(GATEWAY_ENV.port, (value) => /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65535));
  const issuer = need(GATEWAY_ENV.installIssuer, (value) => { try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.href === value && !value.endsWith("/"); } catch { return false; } });
  // Pinned beside the issuer (TC-1: <iss>/.well-known/jwks.json), never another host.
  const jwksUrl = need(GATEWAY_ENV.installJwksUrl, (value) => value === `${issuer}${JWKS_PATH}`);
  const taskKids = need(GATEWAY_ENV.installTaskKids, (value) => { const kids = value.split(","); return kids.length >= 1 && kids.length <= 2 && kids.every((kid) => KID.test(kid)) && new Set(kids).size === kids.length; }).split(",");
  const table = (name: string) => need(name, (value) => TABLE.test(value));
  const anthropicKeySecret = need(GATEWAY_ENV.anthropicKeySecret, (value) => /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/u.test(value));
  return { mode, region, port, install: { issuer, jwksUrl, taskKids }, tables: { meter: table(GATEWAY_ENV.meterTable), ledger: table(GATEWAY_ENV.ledgerTable), markers: table(GATEWAY_ENV.markersTable), prices }, anthropicKeySecret };
}

/** One JSON object per line on stdout, with an `event` field the alarms' metric filters count (deploy.ts GATEWAY_LOG_EVENTS). */
export type GatewayLog = (line: { event: string } & Record<string, string | number | boolean>) => void;
export function jsonLog(write: (text: string) => void = (text) => { process.stdout.write(text); }, now: () => number = Date.now): GatewayLog {
  return (line) => {
    try { write(`${JSON.stringify({ ...line, time: new Date(now()).toISOString() })}\n`); } catch { /* Logging never stops a call. */ }
  };
}

/**
 * Budgets are not settable yet (R3a: "setting caps is a later lane"). Until a caps store exists, the gateway answers every call
 * 503 "model access unavailable" rather than run with an invented budget (fail closed). Corrections skip for the same reason.
 */
export const UNCONFIGURED_CAPS: CapsSource = { capsFor: () => Promise.resolve({} as never) };
/**
 * The most output tokens a request may ask for, and what a request that names none is given. One figure for every model the
 * task token allows, until per-model limits come with the model catalog (a request above a model's real limit is refused by the
 * provider).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
export const DEFAULT_MODEL_LIMITS: ModelLimitsSource = { maxOutputTokens: (provider) => provider === "anthropic" ? DEFAULT_MAX_OUTPUT_TOKENS : undefined };

/** A release drains a task for as long as one call may last (the load balancer's deregistration delay is the same hour). */
export const GATEWAY_DRAIN_MS = CALL_HARD_CEILING_MS;
/** Every five minutes: reload the prices table, then a bounded correction run and expiry sweep. */
export const MAINTENANCE_MS = 5 * 60_000;

export interface ServeDependencies {
  env?: GatewayEnv; log?: GatewayLog; credentials?: CredentialSource; db?: Dynamo;
  fetch?: typeof fetch; transport?: ProviderTransport; keys?: ProviderKeys; caps?: CapsSource; modelLimits?: ModelLimitsSource;
  now?: () => number; host?: string; port?: number; /** false: no listener (tests drive the server's request event). */ listen?: boolean; drainMs?: number; maintenanceMs?: number;
}
export interface RunningGateway { server: Server; port: number; draining(): boolean; drain(): Promise<void>; maintain(): Promise<void> }

const UNAVAILABLE = JSON.stringify({ error: { type: "unavailable", message: "model access unavailable" } });

export async function startServe(config: ServeConfig, deps: ServeDependencies = {}): Promise<RunningGateway> {
  const log = deps.log ?? jsonLog();
  const now = deps.now ?? Date.now;
  const credentials = deps.credentials ?? credentialsFromEnvironment(deps.env ?? process.env);
  const db = deps.db ?? new Dynamo({ region: config.region, credentials });
  const meter = new DynamoMeter({ db, tables: config.tables, now });
  const prices = new SnapshotPriceSource(new DynamoPriceSnapshotStore(db, config.tables.prices), { now });
  await prices.reload();
  const caps = deps.caps ?? UNCONFIGURED_CAPS;
  const handlerDeps: GatewayDependencies = {
    verifyToken: createTaskTokenVerifier({ registry: new StaticInstallRegistry([config.install]), readJwks: createJwksReader(deps.fetch ?? fetch), now }),
    ended: new DynamoEndedTasks(db, config.tables.markers), meter, caps, prices, now,
    // The busy answer is counted from its log line (overrun_busy); the process needs no metrics permission.
    metrics: { overrunBusy: () => undefined },
    modelLimits: deps.modelLimits ?? DEFAULT_MODEL_LIMITS,
    keys: deps.keys ?? createSecretsManagerKeys({ region: config.region, credentials, secretArns: { anthropic: config.anthropicKeySecret }, now }),
    transport: deps.transport ?? createAnthropicTransport(),
    log: (event) => log({ ...event }),
  };
  const handler = createGatewayHandler(handlerDeps);
  const inFlight = new Set<Promise<void>>();
  let draining = false;
  const refuse = (res: ServerResponse) => { res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", connection: "close" }); res.end(UNAVAILABLE); };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    // Once draining, the health check fails and a new request (on a kept-alive connection) is refused; open calls finish.
    if (draining) { refuse(res); return; }
    const running = handler(req, res).catch(() => { if (!res.headersSent) refuse(res); else res.destroy(); });
    inFlight.add(running); void running.finally(() => inFlight.delete(running));
  });
  // The load balancer keeps idle connections for up to an hour; the target must keep them at least as long, or it would cut
  // a connection the balancer is about to reuse (a 502). A request's own time is bounded by handleGateway's deadline.
  server.keepAliveTimeout = (GATEWAY_DRAIN_MS / 1000 + 5) * 1000;
  server.headersTimeout = server.keepAliveTimeout + 1000;
  server.requestTimeout = 0;
  server.timeout = 0;
  if (deps.listen !== false) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(deps.port ?? config.port, deps.host ?? "0.0.0.0", () => { server.off("error", reject); resolve(); }); });

  let maintaining: Promise<void> | undefined;
  const maintain = (): Promise<void> => {
    maintaining ??= (async () => {
      try {
        await prices.reload();
        const runId = randomUUID();
        const expiry = await runExpirySweep({ meter, now: now(), runId, log: (line) => log({ ...line }) });
        const corrections = await runCorrections({ meter, prices, caps, now: now(), runId, log: (line) => log({ ...line }) });
        log({ event: "maintenance", corrected: corrections.corrected, skipped: corrections.skipped + expiry.skipped, expired: expiry.expired, unknown: corrections.unknown + expiry.unknown, more: corrections.more || expiry.more });
      } catch { log({ event: "maintenance_failed" }); }
      finally { maintaining = undefined; }
    })();
    return maintaining;
  };
  const timer = setInterval(() => { void maintain(); }, deps.maintenanceMs ?? MAINTENANCE_MS);
  timer.unref();

  let drained: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    drained ??= (async () => {
      draining = true; clearInterval(timer);
      log({ event: "draining", open: inFlight.size });
      const closed = new Promise<void>((resolve) => { server.close(() => resolve()); });
      server.closeIdleConnections();
      const limit = setTimeout(() => { log({ event: "drain_timeout", open: inFlight.size }); server.closeAllConnections(); }, deps.drainMs ?? GATEWAY_DRAIN_MS);
      // Every open call ends (and settles: the settle runs in handleGateway's finally) before the process may exit.
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      server.closeIdleConnections();
      await closed;
      clearTimeout(limit);
      await maintaining?.catch(() => undefined);
      log({ event: "stopped" });
    })();
    return drained;
  };
  const port = deps.listen === false ? 0 : (server.address() as AddressInfo).port;
  log({ event: "started", mode: "serve", port });
  return { server, port, draining: () => draining, drain, maintain };
}

export interface PriceFetchDependencies { env?: GatewayEnv; log?: GatewayLog; credentials?: CredentialSource; db?: Dynamo; fetch?: typeof fetch; now?: () => number }

/** One price fetch (the EventBridge rule's task). Writes only the prices table. Returns the process exit code. */
export async function runPriceFetch(config: PriceFetchConfig, deps: PriceFetchDependencies = {}): Promise<number> {
  const log = deps.log ?? jsonLog();
  try {
    const db = deps.db ?? new Dynamo({ region: config.region, credentials: deps.credentials ?? credentialsFromEnvironment(deps.env ?? process.env) });
    const store = new DynamoPriceSnapshotStore(db, config.tables.prices);
    const prices = new SnapshotPriceSource(store, deps.now === undefined ? {} : { now: deps.now });
    await prices.reload();
    const transport = fetchTransport(deps.fetch ?? fetch);
    const refresher = new PriceRefresher({
      store, prices,
      litellm: (previous) => fetchLiteLLM(transport, { previous }),
      aws: (previous) => fetchAWS(transport, { previous }),
      log: (line) => log({ ...line }),
    });
    const result = await refresher.run((deps.now ?? Date.now)());
    if (!result.ok) { log({ event: GATEWAY_LOG_EVENTS.priceFetchFailed }); return 1; }
    log({ event: "price_fetched", gained: result.gained });
    return 0;
  } catch { log({ event: GATEWAY_LOG_EVENTS.priceFetchFailed }); return 1; }
}

export interface ProcessHooks { onSignal(signal: "SIGTERM" | "SIGINT", handler: () => void): void; exit(code: number): void }

/** The whole process: read the settings, run the mode, drain on SIGTERM. A bad setting exits 2 with the variable's name logged. */
export async function runGateway(env: GatewayEnv, hooks: ProcessHooks, deps: ServeDependencies & PriceFetchDependencies = {}): Promise<RunningGateway | undefined> {
  const log = deps.log ?? jsonLog();
  let config: GatewayConfig;
  try { config = readGatewayConfig(env); }
  catch (error) { log({ event: "config_invalid", variable: error instanceof GatewayConfigError ? error.variable : "unknown" }); hooks.exit(2); return undefined; }
  if (config.mode === "price-fetch") { hooks.exit(await runPriceFetch(config, { ...deps, env, log })); return undefined; }
  let running: RunningGateway;
  try { running = await startServe(config, { ...deps, env, log }); }
  catch { log({ event: "start_failed" }); hooks.exit(1); return undefined; }
  const stop = () => { void running.drain().then(() => hooks.exit(0), () => hooks.exit(1)); };
  hooks.onSignal("SIGTERM", stop);
  hooks.onSignal("SIGINT", stop);
  return running;
}

