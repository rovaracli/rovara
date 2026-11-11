// TS-L1, L2, L3, L4 (Postgres only) and L6: the LIVE parts of scripts/linux-check-test-services.sh, driven by the worker's real run-layer modules (run-network, service-helpers, service-runner, service-reset, service-env,
// NO SSM ON STAGING WORKERS: staging workers are not SSM-managed (their instance profile has no SSM permission, by design). This driver is for a host you have a shell on (linux-runtime CI, a developer's Linux machine, a purpose-launched worker).
// On a staging worker the live isolation facts come from the escape project (tests/fixtures/test-services-escape-project) run as a task, and the root facts from the worker's self-report in CloudWatch: see scripts/linux-check-test-services.sh.
// check-sandbox). NOTHING HERE HAS BEEN RUN against Docker: it is written to be run once, on a staging worker, by the operator, with the owner's OK (slice 1 of test services; see the round file's Slice 1 section).
//
// WHERE IT RUNS. Not on the Mac and not on the host: inside a throwaway container of the worker's own image, with the host's Docker socket (the same way the worker itself reaches Docker). The shell script starts it:
//   docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only --user 0:0 --group-add <docker gid>  -v <docker.sock> -v <work dir at the same path> -v live.mjs:/opt/agentx/tsl-live.mjs:ro
//     <worker image> node /opt/agentx/tsl-live.mjs run
// The work directory is mounted at the SAME path on the host and in the container because a bind mount that the Docker daemon makes (the sealed sandbox's resolv.conf and hosts, a run directory) names a HOST path.
// The run-layer modules are imported from the image's compiled worker (/opt/agentx/packages/worker/dist), so the check exercises the code that ships, not a copy.
//
// MODES (the first argument).
//   run         the live checks: prints one `TSL <id> PASS|FAIL|PENDING <name> | <detail>` line per item (the shell script's own format) and exits 0.
//   ci          the live checks on the linux-runtime CI runner (scripts/ci-test-services-linux.sh): the same checks, but the Postgres entry is the committed catalog's with the digest of a public postgres:16 image pushed to a
//               local registry (localhost:5000), because CI has no ECR and no signed catalog. No trust check, no AWS. Never used on a staging worker.
//   pull-list   prints the catalog image references (by digest) the run needs, one per line, so the shell script can pull them with the worker's registry login before the run (the checks start images with --pull=never).
//   --js        (CI) prints this driver as a program a bare `node` runs (types stripped), for the `ci` mode above.
//   --ssm-params  (on the Mac) prints the JSON `commands` of an AWS-RunShellScript call that delivers the shell script, this driver (types stripped), and the catalog to a staging worker and runs them (see the shell script's header).
//
// WHAT IT STARTS. Throwaway run networks (`rovara-svc-<hash>`, bridge `rvi<hex>`) and their containers, all made by the real modules and all carrying the run-network labels of one fixed throwaway workspace key (TSL_WORKSPACE), so a
// killed check is cleaned by the next one's worker-start sweep (which this driver runs first) and by the shell script's own cleanup. It makes no AWS call, reads no secret and prints none: the only credential is a random Postgres
// password it generates, hands to the launcher's 0600 env file, and keeps out of every line it prints (the service redactor is applied to everything that is printed).
//
// WHAT EACH ITEM PROVES is in the line it prints and in the shell script's list of items. A probe says `open` (a connection was accepted), `refused`, `timeout` (a DROP wall: no answer at all), or `error:<code>`; "reaches" means `open`.
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { CatalogEntrySchema, checkMirrorServesDigest, resolveCatalogImage, type CatalogEntry, type RegistryManifestPort, type SubstituteApprovalPort, type VerifiedCatalog } from "@rovara-code/contracts";
import { loadSignedCatalog } from "@agentx/cloud-contracts";
import type * as RunNetworkModule from "../packages/worker/src/run-network.js";
import type * as ServiceHelpersModule from "../packages/worker/src/service-helpers.js";
import type * as ServiceRunnerModule from "../packages/worker/src/service-runner.js";
import type * as ServiceResetModule from "../packages/worker/src/service-reset.js";
import type * as ServiceEnvModule from "../packages/worker/src/service-env.js";
import type * as CheckSandboxModule from "../packages/worker/src/check-sandbox.js";
import type * as ContainersModule from "../packages/worker/src/swebench/containers.js";

// ---- lines

export type LiveStatus = "PASS" | "FAIL" | "PENDING";
export interface LiveLine { id: string; status: LiveStatus; name: string; detail: string }

/** One line in the shell script's format. The detail is one line of at most 400 characters, with the given values (the password) removed first. */
export function formatLine(line: LiveLine, redact: (text: string) => string = (text) => text): string {
  const detail = redact(line.detail).replace(/[\r\n\t]+/gu, " ").slice(0, 400);
  return `TSL ${line.id} ${line.status} ${line.name} | ${detail}`;
}
const pass = (id: string, name: string, detail: string): LiveLine => ({ id, status: "PASS", name, detail });
const fail = (id: string, name: string, detail: string): LiveLine => ({ id, status: "FAIL", name, detail });
/** PASS when nothing is wrong, FAIL listing what is. */
const verdict = (id: string, name: string, problems: readonly string[], detail: string): LiveLine => (problems.length === 0 ? pass(id, name, detail) : fail(id, name, problems.join(" ")));

// ---- the probe program: node, run with `docker exec <container> node -e <PROBE_JS> <json>` inside a sandbox or a helper's neighbour

export type ProbeTest =
  | { label: string; kind: "conn"; host: string; port: number; ms?: number }
  | { label: string; kind: "lookup"; name: string; ms?: number }
  | { label: string; kind: "dnsq"; server: string; name: string; ms?: number; port?: number }
  | { label: string; kind: "embdirect"; name: string; ms?: number }
  | { label: string; kind: "embdirecttcp"; ms?: number }
  | { label: string; kind: "v6listen" }
  | { label: string; kind: "caps" }
  | { label: string; kind: "routes" }
  | { label: string; kind: "addrs" }
  | { label: string; kind: "file"; path: string }
  | { label: string; kind: "write"; path: string }
  | { label: string; kind: "send"; host: string; port: number };

/** A program, not data: it runs in the container, prints `<label> <status> <detail>` per test and exits. Small on purpose. */
export const PROBE_JS = String.raw`const dgram=require('dgram'),net=require('net'),fs=require('fs'),dns=require('dns'),os=require('os');
const cfg=JSON.parse(process.argv[1]);
const out=(l,s,x)=>l+' '+s+(x===undefined?'':' '+x);
const enc=(name,id)=>{const b=[Buffer.from([id>>8,id&255,1,0,0,1,0,0,0,0,0,0])];for(const p of name.split('.')){b.push(Buffer.from([p.length]),Buffer.from(p));}b.push(Buffer.from([0,0,1,0,1]));return Buffer.concat(b);};
const conn=(t)=>new Promise(res=>{let done=false;const s=net.connect({host:t.host,port:t.port});const end=(v)=>{if(done)return;done=true;clearTimeout(timer);s.destroy();res(v);};const timer=setTimeout(()=>end(out(t.label,'timeout')),t.ms||3000);s.on('connect',()=>end(out(t.label,'open')));s.on('error',(e)=>end(out(t.label,e.code==='ECONNREFUSED'?'refused':'error:'+(e.code||'unknown'))));});
const lookup=(t)=>new Promise(res=>{const timer=setTimeout(()=>res(out(t.label,'timeout')),t.ms||5000);dns.lookup(t.name,{family:4},(e,a)=>{clearTimeout(timer);res(e?out(t.label,'error:'+(e.code||'unknown')):out(t.label,'resolved',a));});});
const dnsq=(t)=>new Promise(res=>{const s=dgram.createSocket('udp4');let done=false;const end=(v)=>{if(done)return;done=true;clearTimeout(timer);try{s.close();}catch(e){}res(v);};const timer=setTimeout(()=>end(out(t.label,'timeout')),t.ms||3000);s.on('message',(m)=>end(out(t.label,'answer','rcode='+(m.readUInt16BE(2)&15)+' an='+m.readUInt16BE(6))));s.on('error',(e)=>end(out(t.label,'error:'+(e.code||'unknown'))));s.send(enc(t.name,4242),t.port||53,t.server,(e)=>{if(e)end(out(t.label,'error:'+(e.code||'unknown')));});});
const embdirect=(t)=>{let port=0;try{for(const l of fs.readFileSync('/proc/net/udp','utf8').split('\n').slice(1)){const f=l.trim().split(/\s+/);if(f[1]&&f[1].toUpperCase().startsWith('0B00007F:')){port=parseInt(f[1].split(':')[1],16);break;}}}catch(e){}if(!port)return Promise.resolve(out(t.label,'error:NOLISTENER'));return dnsq({label:t.label,name:t.name,server:'127.0.0.11',port:port,ms:t.ms});};
const lst=(f,only)=>{try{return fs.readFileSync(f,'utf8').split('\n').slice(1).map(l=>l.trim().split(/\s+/)).filter(x=>x.length>9&&x[1]&&(!only||x[3]==='0A'));}catch(e){return [];}};
const embdirecttcp=(t)=>{const r=lst('/proc/net/tcp',true).find(x=>x[1].toUpperCase().startsWith('0B00007F:'));if(!r)return Promise.resolve(out(t.label,'error:NOLISTENER'));return conn({label:t.label,host:'127.0.0.11',port:parseInt(r[1].split(':')[1],16),ms:t.ms});};
const own=()=>{const s=new Set();try{for(const f of fs.readdirSync('/proc/self/fd')){try{const m=/^socket:\[(\d+)\]$/.exec(fs.readlinkSync('/proc/self/fd/'+f));if(m)s.add(m[1]);}catch(e){}}}catch(e){}return s;};
const v6listen=(t)=>{const mine=own();const bad=[];for(const [f,tcp] of [['/proc/net/tcp6',true],['/proc/net/udp6',false]]){for(const x of lst(f,false)){if(mine.has(x[9]))continue;const port=parseInt(x[1].split(':')[1]||'0',16);if(tcp?x[3]==='0A':port!==0)bad.push(f.slice(10)+':'+x[1]);}}return Promise.resolve(out(t.label,'v6listen','bad='+bad.join(',')));};
const caps=(t)=>{try{const m=fs.readFileSync('/proc/self/status','utf8');const g=(k)=>((new RegExp('^'+k+':\\s*([0-9a-fA-F]+)','m').exec(m)||[])[1]||'?');return Promise.resolve(out(t.label,'caps','eff='+g('CapEff')+' bnd='+g('CapBnd')+' amb='+g('CapAmb')));}catch(e){return Promise.resolve(out(t.label,'error:'+(e.code||'unknown')));}};
const routes=(t)=>{let v4='',v6='';try{v4=fs.readFileSync('/proc/net/route','utf8').split('\n').slice(1).filter(Boolean).map(l=>l.split(/\s+/).slice(0,4).join(':')).join(',');}catch(e){}try{v6=fs.readFileSync('/proc/net/ipv6_route','utf8').split('\n').filter(l=>l&&!/ lo$/.test(l)).length+'';}catch(e){}return Promise.resolve(out(t.label,'routes','v4='+v4+' v6routes='+v6));};
const addrs=(t)=>{const g=[];const a=[];for(const [n,l] of Object.entries(os.networkInterfaces())){for(const i of l||[]){if(i.family==='IPv6'){if(!/^fe80|^::1$/.test(i.address))g.push(n+':'+i.address);}else if(i.family==='IPv4'&&!i.internal)a.push(n+':'+i.address);}}return Promise.resolve(out(t.label,'addrs','v4='+a.join(',')+' v6global='+g.join(',')));};
const file=(t)=>{try{return Promise.resolve(out(t.label,'file',JSON.stringify(fs.readFileSync(t.path,'utf8')).slice(0,1500)));}catch(e){return Promise.resolve(out(t.label,'error:'+(e.code||'unknown')));}};
const write=(t)=>{try{fs.appendFileSync(t.path,'# tsl\n');return Promise.resolve(out(t.label,'written'));}catch(e){return Promise.resolve(out(t.label,'denied',e.code||'unknown'));}};
const send=(t)=>new Promise(res=>{const s=dgram.createSocket('udp4');s.on('error',(e)=>{try{s.close();}catch(x){}res(out(t.label,'error:'+(e.code||'unknown')));});s.bind(0,()=>{try{s.setBroadcast(true);}catch(e){}s.send(Buffer.from('tsl'),t.port,t.host,(e)=>{try{s.close();}catch(x){}res(e?out(t.label,'error:'+(e.code||'unknown')):out(t.label,'sent'));});});});
const kinds={conn,lookup,dnsq,embdirect,embdirecttcp,v6listen,caps,routes,addrs,file,write,send};
Promise.all(cfg.tests.map((t)=>kinds[t.kind](t).catch((e)=>out(t.label,'error:'+String(e&&e.code||e))))).then((l)=>{console.log(l.join('\n'));process.exit(0);});
setTimeout(()=>process.exit(0),30000);`;

/** A listener for datagrams, run in a container of its own for the multicast and broadcast items: says `received` or `silent` after `ms`. */
export const LISTEN_JS = String.raw`const dgram=require('dgram');const cfg=JSON.parse(process.argv[1]);let got=0;
const s=dgram.createSocket({type:'udp4',reuseAddr:true});
s.on('message',()=>{got+=1;});s.on('error',()=>{});
s.bind(cfg.port,()=>{for(const g of cfg.groups){try{s.addMembership(g);}catch(e){}}});
setTimeout(()=>{console.log(got>0?'received '+got:'silent');process.exit(0);},cfg.ms);`;

export interface ProbeResult { status: string; rest: string }

/** The lines of a probe's output by label. A line that is not `<label> <status> ...` is ignored, and a label seen twice keeps the first. */
export function parseProbeOutput(text: string): Map<string, ProbeResult> {
  const results = new Map<string, ProbeResult>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9._-]{1,48}) (open|refused|timeout|answer|resolved|routes|addrs|caps|v6listen|file|written|denied|sent|error:[A-Za-z0-9_-]{1,30})(?: (.*))?$/u.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined || results.has(match[1])) continue;
    results.set(match[1], { status: match[2], rest: match[3] ?? "" });
  }
  return results;
}

/** The labels of `wanted` whose status is not one of `allowed` (a label with no line counts as `no-result`). The text of what is wrong, empty when nothing is. */
export function unexpected(results: ReadonlyMap<string, ProbeResult>, wanted: readonly string[], allowed: readonly string[]): string[] {
  const bad: string[] = [];
  for (const label of wanted) {
    const status = results.get(label)?.status;
    if (status === undefined) bad.push(`${label}=no-result`);
    else if (!allowed.includes(status)) bad.push(`${label}=${status}`);
  }
  return bad;
}
/** What a wall that DROPs looks like from inside: no answer at all. A refusal or an answer means something else is in the way. */
export const SILENT = ["timeout"] as const;
/** Nothing got through: not an open connection, not an answer. */
export const NOT_THROUGH = ["timeout", "refused", "error:ENETUNREACH", "error:EHOSTUNREACH", "error:ENETDOWN", "error:EADDRNOTAVAIL", "error:ECONNRESET", "error:EPERM", "error:EACCES"] as const;

/** Does a default route (destination and mask all zero) appear in `routes` output (`iface:dest:gateway:flags,...`)? The kernel prints addresses as little-endian hex. */
export function hasDefaultRoute(routes: string): boolean {
  return routes.split(" ")[0]?.replace(/^v4=/u, "").split(",").some((row) => row.split(":")[1] === "00000000") === true;
}

// ---- the run layer, loaded from the image's compiled worker

export const WORKER_DIST = "/opt/agentx/packages/worker/dist";
export interface RunLayer {
  runNetwork: typeof RunNetworkModule;
  helpers: typeof ServiceHelpersModule;
  runner: typeof ServiceRunnerModule;
  reset: typeof ServiceResetModule;
  env: typeof ServiceEnvModule;
  check: typeof CheckSandboxModule;
  containers: typeof ContainersModule;
}
export async function loadRunLayer(dist: string = WORKER_DIST): Promise<RunLayer> {
  const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(dist, file)).href)) as T;
  return {
    runNetwork: await load<typeof RunNetworkModule>("run-network.js"),
    helpers: await load<typeof ServiceHelpersModule>("service-helpers.js"),
    runner: await load<typeof ServiceRunnerModule>("service-runner.js"),
    reset: await load<typeof ServiceResetModule>("service-reset.js"),
    env: await load<typeof ServiceEnvModule>("service-env.js"),
    check: await load<typeof CheckSandboxModule>("check-sandbox.js"),
    containers: await load<typeof ContainersModule>("swebench/containers.js"),
  };
}

// ---- inputs

/** The one catalog id this slice proves. */
export const POSTGRES_ID = "postgres@16";
/** The throwaway workspace key (16 hex digits) every object of these checks carries, so a killed check is found and removed by the next one. */
export const TSL_WORKSPACE = "7e57c4ec7e57c4ec";
const NODE = "/usr/local/bin/node";
const PROBE_PORT = 5432;
/** The port the L1 sandbox listens on so the helper has something open to reach (the positive control). */
const CONTROL_PORT = 7778;
const ROUND_BUDGET_MS = 10 * 60_000;

export interface LiveInput {
  /** The signed catalog, from `loadVerifiedCatalog` (loadSignedCatalog): nothing else is accepted, unless `entry` is given (the CI mode). */
  catalog?: VerifiedCatalog;
  /** The manifest bytes the environment's registry serves, by digest (the shell script fetched them with the worker role); `resolveCatalogImage` hashes them. */
  manifests?: RegistryManifestPort;
  /** CI mode only (`ciPostgresEntry`): the Postgres entry to run, in place of the signed catalog's. A staging worker never gets this. */
  entry?: CatalogEntry & { image: { digest: string } };
  /** `<account>.dkr.ecr.<region>.amazonaws.com`. */
  registry: string;
  /** The named environment (`staging`). */
  env: string;
  /** The worker's own image, by digest: the probes and the check sandbox run from it. */
  workerImage: string;
  /** A directory on the host, mounted at the same path here. */
  workDir: string;
  /** The Docker CLI. Absent: the real one (from the run layer). */
  docker?: ContainersModule.DockerCli;
  layer?: RunLayer;
}

/** The catalog cannot be trusted yet because no catalog key is compiled in (or none counts here). Reported as BLOCKED, never as a pass. */
export class BlockedError extends Error {
  constructor() {
    super("BLOCKED: no trusted catalog key");
    this.name = "BlockedError";
  }
}

/**
 * The signed catalog through `loadSignedCatalog` (the compiled-in keys, `catalog-trust.ts`; the account decides whether the staging-only key counts). No trusted key at all is BLOCKED; any other failure is a sentence.
 * There is no way to hand it keys: tests build a `VerifiedCatalog` with `@agentx/contracts/testing` and pass that to the checks instead.
 */
export function loadVerifiedCatalog(input: { catalogBytes: Uint8Array; signatureBytes: Uint8Array; runningAccountId: string | undefined }): VerifiedCatalog {
  if (input.signatureBytes.byteLength === 0) throw new Error("the catalog has no signature file yet: run the catalog build for it first");
  const loaded = loadSignedCatalog({ catalogBytes: input.catalogBytes, signatureBytes: input.signatureBytes, trust: { runningAccountId: input.runningAccountId } });
  if (loaded.ok) return loaded.catalog;
  if (loaded.reason === "no trusted catalog key") throw new BlockedError();
  throw new Error(`the catalog is not trusted: ${loaded.reason}`);
}

/** The Postgres entry, when the verified catalog pins it. Throws a sentence (never the catalog) when it does not. */
export function postgresEntry(catalog: VerifiedCatalog): CatalogEntry & { image: { digest: string } } {
  const entry = catalog.entries.find((candidate) => candidate.id === POSTGRES_ID);
  if (entry === undefined) throw new Error(`the catalog has no ${POSTGRES_ID}`);
  if (!catalog.pinned || entry.image.digest === undefined || entry.status === "retired") throw new Error(`${POSTGRES_ID} is not pinned in this catalog: run the catalog repack and build for it first`);
  return entry as CatalogEntry & { image: { digest: string } };
}

/** The references the shell script pulls before the run: only what this slice uses, always by digest. */
export function pullList(input: { catalog: VerifiedCatalog; registry: string; env: string }): string[] {
  const entry = postgresEntry(input.catalog);
  return [`${input.registry}/rovara-catalog/${input.env}/${entry.image.repository}@sha256:${entry.image.digest}`];
}

/** A manifest port over a directory of files named by digest (the shell script wrote them from the registry, byte for byte). */
export function manifestFilesPort(read: (digest: string) => Promise<Uint8Array | undefined>): RegistryManifestPort {
  return { manifestBytes: async (_repositoryName, digest) => (/^[a-f0-9]{64}$/u.test(digest) ? read(digest) : undefined) };
}

/** `resolveCatalogImage` for the one image: the registry must serve the catalog's digest, by the manifest bytes hashed here. Throws the registry's refusal sentence otherwise. */
export async function resolvePostgres(input: Pick<LiveInput, "catalog" | "manifests" | "env">): Promise<void> {
  if (input.catalog === undefined || input.manifests === undefined) throw new Error("the signed catalog and the registry's manifests are needed");
  const entry = postgresEntry(input.catalog);
  const check = await checkMirrorServesDigest(input.manifests, { id: POSTGRES_ID, repositoryName: `rovara-catalog/${input.env}/${entry.image.repository}`, digest: entry.image.digest });
  const noApprovals: SubstituteApprovalPort = { find: async () => undefined };
  const resolved = await resolveCatalogImage({ catalog: input.catalog, catalogId: POSTGRES_ID, edition: "public", served: { source: "rovara_registry", check }, approvals: noApprovals });
  if (!resolved.ok) throw new Error(resolved.message);
}

/**
 * CI mode: the committed catalog's `postgres@16` entry (its run arguments, health check, resources and reset are the very ones a staging worker uses) with the digest of the image CI pushed to its local registry.
 * The catalog is NOT verified here (CI has no signing key and no registry of its own): this proves how the entry RUNS on a real Docker host, not that the catalog is trusted. Throws a sentence when the entry is missing or not valid.
 */
export function ciPostgresEntry(catalogBytes: Uint8Array | string, digest: string): CatalogEntry & { image: { digest: string } } {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("the Postgres digest is 64 hex digits");
  const parsed = JSON.parse(typeof catalogBytes === "string" ? catalogBytes : Buffer.from(catalogBytes).toString("utf8")) as { entries?: Array<{ id?: unknown; image?: Record<string, unknown> }> };
  const raw = parsed.entries?.find((candidate) => candidate.id === POSTGRES_ID);
  if (raw === undefined || typeof raw.image !== "object") throw new Error(`the catalog has no ${POSTGRES_ID}`);
  const entry = CatalogEntrySchema.parse({ ...raw, image: { ...raw.image, digest } });
  return entry as CatalogEntry & { image: { digest: string } };
}

const randomAlnum = (length: number): string => randomBytes(length * 2).toString("base64").replace(/[^A-Za-z0-9]/gu, "").slice(0, length).padEnd(length, "x");
const clean = (text: string): string => text.replace(/\s+/gu, " ").trim();

// ---- the lab: one throwaway run with a real Postgres, started by the real ServiceRunner

interface Lab {
  runId: string;
  session: ServiceRunnerModule.ServiceSession;
  net: ServiceRunnerModule.SandboxNetworkView;
  slot: number;
  helper: ServiceHelpersModule.StartedHelper;
  labels: string[];
  request: ServiceHelpersModule.HelperRequest;
  files: Awaited<ReturnType<typeof ServiceEnvModule.createRunDirectoryFiles>>;
  stop(): Promise<void>;
}

interface Context {
  input: LiveInput;
  layer: RunLayer;
  docker: ContainersModule.DockerCli;
  entry: CatalogEntry & { image: { digest: string } };
  secrets: string[];
  redact: (text: string) => string;
  counter: { n: number };
  cleanups: Array<() => Promise<void>>;
}

const sh = async (context: Context, args: readonly string[], timeoutMs = 60_000): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
  const result = await context.docker.run(args, { timeoutMs }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

async function startLab(context: Context, label: string): Promise<Lab> {
  const { layer, input } = context;
  context.counter.n += 1;
  const runId = `tsl-${label}-${String(context.counter.n)}-${randomBytes(3).toString("hex")}`;
  const credentials = { user: "tsluser", password: randomAlnum(24), database: "tsldb" };
  context.secrets.push(credentials.password);
  const request: ServiceHelpersModule.HelperRequest = { id: "postgres", name: "Postgres", entry: context.entry, aliases: ["postgres"], credentials };
  const runParent = join(input.workDir, "run");
  await mkdir(runParent, { recursive: true, mode: 0o700 });
  const files = await layer.env.createRunDirectoryFiles(runParent, runId);
  let session: ServiceRunnerModule.ServiceSession;
  try {
    session = await layer.runner.createDockerServiceRunner(context.docker).start({
      runId, workspace: TSL_WORKSPACE, roundBudgetMs: ROUND_BUDGET_MS, registry: input.registry, edition: "public", probeImage: input.workerImage, maxMemMiB: 3072,
      helpers: [request], files, resetHooks: layer.reset.createResetHooks(),
    });
  } catch (error) {
    await layer.env.removeRunDirectory(files.directory);
    throw error;
  }
  const helper = session.helpers[0];
  if (helper === undefined) {
    await session.stop();
    await layer.env.removeRunDirectory(files.directory);
    throw new Error("the runner started no helper");
  }
  // The run's own labels, read back from the helper the real launcher started: every probe container carries them, so the real sweeps see it.
  const inspected = await sh(context, ["inspect", "--format", "{{json .Config.Labels}}", helper.container]);
  const labels = labelArgsFrom(inspected.stdout);
  const slot = Number(/^172\.30\.([0-9]{1,3})\./u.exec(session.network.subnet)?.[1] ?? "0");
  let stopped = false;
  const lab: Lab = {
    runId, session, net: session.network, slot, helper, labels, request, files,
    async stop() {
      if (stopped) return;
      stopped = true;
      await session.stop().catch(() => undefined);
      await layer.env.removeRunDirectory(files.directory);
    },
  };
  context.cleanups.push(() => lab.stop());
  return lab;
}

/** `--label k=v` pairs for the run-network labels in a container's label map. Anything else is dropped. */
export function labelArgsFrom(json: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json.trim()); } catch { return []; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([key, value]) => /^rovara\.run-network(?:\.[a-z]+)?$/u.test(key) && typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value))
    .flatMap(([key, value]) => ["--label", `${key}=${String(value)}`]);
}

/** The four ids of a `Uid:` line of /proc/<pid>/status (real, effective, saved, filesystem), or nothing when it is not that line. Root is any of them being 0. */
export function parseUids(text: string): number[] | undefined {
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/mu.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

/** A throwaway node container on the run's network at a fixed address, with the run's labels, hardened like a task sandbox. */
async function startNode(context: Context, lab: Lab, name: string, ip: string, networkName: string = lab.net.name, mounts: readonly string[] = [], listen?: number): Promise<string> {
  const args = [
    "run", "-d", "--name", name, "--network", networkName, ...(networkName === lab.net.name ? ["--ip", ip] : []), ...lab.labels,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", "--pids-limit", "64", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5",
    "--user", "1000:1000", "--pull=never", ...mounts, "--entrypoint", NODE, context.input.workerImage, "-e", `${listen === undefined ? "" : `require('net').createServer((s)=>{s.on('error',()=>{});s.end();}).listen(${String(listen)},'0.0.0.0');`}setInterval(()=>{},1e6)`,
  ];
  const started = await sh(context, args);
  if (started.exitCode !== 0) throw new Error(`could not start ${name}: ${clean(started.stderr).slice(0, 160)}`);
  return name;
}

async function probe(context: Context, container: string, tests: readonly ProbeTest[]): Promise<Map<string, ProbeResult>> {
  const ran = await sh(context, ["exec", container, NODE, "-e", PROBE_JS, JSON.stringify({ tests })], 60_000);
  return parseProbeOutput(ran.stdout);
}

const conn = (label: string, host: string, port: number, ms = 3000): ProbeTest => ({ label, kind: "conn", host, port, ms });

/** The addresses a sandbox must NOT be able to reach, whatever the run: public DNS and web, the metadata address, the gateway, a private neighbour. */
function wallTests(lab: Lab): ProbeTest[] {
  const gateway = lab.net.gateway;
  return [
    conn("pub-dns", "8.8.8.8", 53), conn("pub-https", "8.8.8.8", 443), conn("pub-name", "1.1.1.1", 443), conn("metadata", "169.254.169.254", 80),
    conn("gw-22", gateway, 22), conn("gw-80", gateway, 80), conn("gw-443", gateway, 443), conn("gw-5432", gateway, PROBE_PORT), conn("private-10", "10.0.0.1", 443), conn("private-192", "192.168.0.1", 443),
  ];
}
const WALL_LABELS = ["pub-dns", "pub-https", "pub-name", "metadata", "gw-22", "gw-80", "gw-443", "gw-5432", "private-10", "private-192"];

// ---- TS-L1

async function checkL1(context: Context): Promise<LiveLine[]> {
  const lines: LiveLine[] = [];
  const first = await startLab(context, "l1a");
  const second = await startLab(context, "l1b");
  const sandboxA = await startNode(context, first, `${first.net.name}-sbx`, first.net.workingSandboxIp, first.net.name, [], CONTROL_PORT);
  const sandboxB = await startNode(context, second, `${second.net.name}-sbx`, second.net.workingSandboxIp);
  // sandbox -> helper passes; the sandbox and the helper reach nothing outside the run; the helper reaches no public address, no private range, nothing at the gateway
  const fromSandbox = await probe(context, sandboxA, [conn("helper-addr", first.helper.address, PROBE_PORT, 5000), { label: "helper-name", kind: "lookup", name: "postgres" }, ...wallTests(first)]);
  const helperProblems = unexpected(fromSandbox, ["helper-addr"], ["open"]);
  const sandboxWalls = unexpected(fromSandbox, WALL_LABELS, NOT_THROUGH);
  const helperExec = await sh(context, ["exec", first.helper.container, "bash", "-c", `for t in ${first.net.workingSandboxIp}:${String(CONTROL_PORT)} 8.8.8.8:443 8.8.8.8:53 1.1.1.1:443 169.254.169.254:80 10.0.0.1:443 ${first.net.gateway}:80; do if timeout 3 bash -c "exec 3<>/dev/tcp/\${t%:*}/\${t#*:}" 2>/dev/null; then echo "open $t"; else echo "closed $t"; fi; done`], 60_000);
  const opened = helperExec.stdout.split("\n").filter((row) => row.startsWith("open ")).map((row) => row.slice(5));
  // The positive control: the helper's probe method must see an open connection where there is one (its own run's sandbox). If it does not, "nothing got through" would prove nothing.
  const control = `${first.net.workingSandboxIp}:${String(CONTROL_PORT)}`;
  const helperOut = opened.filter((target) => target !== control);
  lines.push(verdict("L1.live", "helper-reachable-internet-not",
    [...helperProblems.map((p) => `sandbox-to-helper:${p}`), ...sandboxWalls.map((p) => `sandbox:${p}`), ...(helperExec.exitCode === 0 ? [] : ["helper-exec-failed"]), ...(opened.includes(control) ? [] : ["control-failed:the-helper-could-not-reach-its-own-sandbox"]), ...helperOut.map((t) => `helper-reached:${t}`)],
    `sandbox reaches the helper at ${first.helper.address}:${String(PROBE_PORT)}; neither it nor the helper reaches a public address, the metadata address, a private range or the gateway`));
  // TS-RN-2: a sandbox of one run cannot reach another run's helper (by address, or through the gateway), in either direction, and still reaches its own
  const cross = await probe(context, sandboxA, [conn("other-helper", second.helper.address, PROBE_PORT), conn("other-sandbox", second.net.workingSandboxIp, PROBE_PORT), conn("own-helper", first.helper.address, PROBE_PORT, 5000)]);
  const crossBack = await probe(context, sandboxB, [conn("other-helper", first.helper.address, PROBE_PORT), conn("other-sandbox", first.net.workingSandboxIp, PROBE_PORT)]);
  lines.push(verdict("L1.live-other-run", "another-runs-helper-unreachable",
    [...unexpected(cross, ["other-helper", "other-sandbox"], NOT_THROUGH).map((p) => `a-to-b:${p}`), ...unexpected(crossBack, ["other-helper", "other-sandbox"], NOT_THROUGH).map((p) => `b-to-a:${p}`), ...unexpected(cross, ["own-helper"], ["open"]).map((p) => `own:${p}`)],
    `a sandbox on ${first.net.name} cannot reach ${second.net.name}'s helper or sandbox (either way) and still reaches its own helper`));
  return lines;
}

// ---- TS-L2

async function checkL2(context: Context): Promise<LiveLine[]> {
  const lab = await startLab(context, "l2");
  const problems: string[] = [];
  // the dual-homed working sandbox: the internet-facing network first, then the run's network at .3 (as task-sandbox.ts does)
  const name = `${lab.net.name}-work`;
  const started = await sh(context, ["run", "-d", "--name", name, "--network", "agentx-task", ...lab.labels, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--pids-limit", "64", "--memory", "128m", "--memory-swap", "128m", "--user", "1000:1000", "--pull=never", "--entrypoint", NODE, context.input.workerImage, "-e", "setInterval(()=>{},1e6)"]);
  if (started.exitCode !== 0) return [fail("L2.live", "dual-homed-sandbox", `the working sandbox could not start on agentx-task: ${clean(started.stderr).slice(0, 160)}`)];
  const joined = await sh(context, ["network", "connect", "--ip", lab.net.workingSandboxIp, lab.net.name, name]);
  if (joined.exitCode !== 0) return [fail("L2.live", "dual-homed-sandbox", "the working sandbox could not join the run's network at .3")];
  const result = await probe(context, name, [
    { label: "alias", kind: "lookup", name: "postgres" }, { label: "public-name", kind: "lookup", name: "registry.npmjs.org" }, conn("helper", lab.helper.address, PROBE_PORT, 5000), { label: "addrs", kind: "addrs" },
  ]);
  if (result.get("alias")?.status !== "resolved" || result.get("alias")?.rest !== lab.helper.address) problems.push(`alias:${result.get("alias")?.status ?? "no-result"}:${result.get("alias")?.rest ?? ""}`);
  if (result.get("public-name")?.status !== "resolved") problems.push(`public-name:${result.get("public-name")?.status ?? "no-result"}`);
  if (result.get("helper")?.status !== "open") problems.push(`helper:${result.get("helper")?.status ?? "no-result"}`);
  // a helper cannot use the sandbox as a route: it cannot reach the working network's address of the sandbox, nor anything beyond it
  const working = /agentx-task:([0-9.]+)/u.exec(result.get("addrs")?.rest ?? "")?.[1] ?? (await networkAddress(context, name, "agentx-task"));
  if (working === undefined) problems.push("working-network-address-unknown");
  else {
    const reach = await sh(context, ["exec", lab.helper.container, "bash", "-c", `for t in ${working}:22 ${working}:80 8.8.8.8:443; do if timeout 3 bash -c "exec 3<>/dev/tcp/\${t%:*}/\${t#*:}" 2>/dev/null; then echo "open $t"; fi; done`], 60_000);
    for (const row of reach.stdout.split("\n").filter((entry) => entry.startsWith("open "))) problems.push(`helper-reached:${row.slice(5)}`);
  }
  return [verdict("L2.live", "dual-homed-sandbox", problems, "run aliases resolve to the helper, an allowed public name resolves, the helper reaches nothing through the sandbox or on the working network")];
}

async function networkAddress(context: Context, container: string, network: string): Promise<string | undefined> {
  const found = await sh(context, ["inspect", "--format", `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`, container]);
  const address = found.stdout.trim();
  return found.exitCode === 0 && /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/u.test(address) ? address : undefined;
}

// ---- TS-L3 (the sealed check sandbox)

/** The working sandbox's listener for the relay item. It keeps running when a peer resets the connection: without the error handler, a probe that connects and closes before reading makes node throw ECONNRESET
 * and the working sandbox exits, which hid the relay (a dead listener cannot relay) and left the spoofing item's probe from .3 with no container to run in. */
export const RELAY_LISTENER_JS = "require('net').createServer((s)=>{s.on('error',()=>{});s.end('relay');}).listen(7777,'0.0.0.0');setInterval(()=>{},1e6)";

/** A container's state and the last lines of its log, one line, for a FAIL detail (the DNS helper prints nothing unless it fails; formatLine redacts and cuts it). */
async function containerState(context: Context, container: string): Promise<string> {
  const state = await sh(context, ["inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}", container]);
  const logs = await sh(context, ["logs", "--tail", "5", container]);
  return `state=${clean(state.stdout) || `unknown(${clean(state.stderr).slice(0, 60)})`} log=${clean(`${logs.stdout} ${logs.stderr}`).slice(0, 200)}`;
}

// ---- TS-L3: the two embedded-resolver items (TS-SEAL-5)

/** What the two embedded-resolver items judge: the sealed sandbox's probe results, the unguarded control's, and facts read around the round. */
export interface EmbeddedResolverEvidence {
  /** The probes run in the sealed sandbox: resolv, embedded, embedded-public, embedded-tcp, embedded-direct, embedded-direct-tcp, v6, caps. */
  results: ReadonlyMap<string, ProbeResult>;
  /** The probes run in a container of the same network that the guard never touched: ctl-embedded, ctl-embedded-tcp, ctl-embedded-direct, ctl-embedded-direct-tcp, ctl-embedded-public. */
  control: ReadonlyMap<string, ProbeResult>;
  /** The `nameserver` lines of the sandbox's resolv.conf. */
  nameservers: ReadonlyArray<string | undefined>;
  dnsHelperIp: string;
  /** True when resolv.conf is not what it was before the sandbox tried to write it. */
  resolvChanged: boolean;
  /** True when no container named like the guard is left (it runs with --rm). */
  guardContainerGone: boolean;
  /** `iptables-nft -S OUTPUT` read from outside, by a second NET_ADMIN container joined to the sandbox's namespace; undefined when that read failed. */
  outputRules: string | undefined;
}

/** "No address": a timeout, a refusal, a send that failed, or an answer with no records. */
function noAddress(result: ProbeResult | undefined): boolean {
  return result !== undefined && ((NOT_THROUGH as readonly string[]).includes(result.status) || (result.status === "answer" && /\ban=0\b/u.test(result.rest)));
}

/** The rule the guard installs, as `iptables-nft -S OUTPUT` prints it: first in the chain, after the policy line. */
export const GUARD_RULE_LINE = "-A OUTPUT -d 127.0.0.11/32 -j DROP";

/**
 * L3.embedded-resolver, the accepted residual (TS-SEAL-5 a): Docker's embedded resolver exists in the sandbox and may answer the names of the run's own containers (not judged). Whatever it does, a PUBLIC name must get no
 * address through it (CVE-2024-29018: no forwarding out of an internal network). That is measured where the resolver is OPEN, in the unguarded control container (`ctl-embedded-public`): the sealed sandbox's own probe of it
 * only ever shows the guard's EPERM. The control's resolver is shown alive by `ctl-embedded` (an answer), so the public name must also get an ANSWER, with no records (REFUSED, SERVFAIL, NXDOMAIN): a timeout fails. It is the floor under the guard. And L3.embedded-resolver-blocked, the guard (TS-SEAL-5 b): from the sealed sandbox a lookup of 127.0.0.11 gets nothing on every path (port 53 over UDP and
 * over TCP, which Docker's nat rule rewrites to the resolver's random port, and that random port itself over UDP and TCP, which no rewrite is in the path of). A UDP send is refused with EPERM by the DROP rule (the item requires
 * exactly that: a timeout would mean something else dropped it); a TCP connect times out. A container of the same network that the guard never touched gets an answer on each (the positive control: a silent sandbox is the guard's
 * doing, not a resolver that is absent or unreachable by these probes). The rule is read back from outside and is first in the chain. The sandbox has no capability (NET_ADMIN is only the guard container's), no IPv6 socket
 * listens other than on the loopback or wildcard address, and the guard container is gone.
 */
export function embeddedResolverLines(input: EmbeddedResolverEvidence): LiveLine[] {
  const { results, control } = input;
  const shown = (map: ReadonlyMap<string, ProbeResult>, label: string): string => `${map.get(label)?.status ?? "no-result"}(${map.get(label)?.rest ?? ""})`;
  const ruleLines = (input.outputRules ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return [
    verdict("L3.embedded-resolver", "docker-embedded-resolver-and-dnat", [
      ...(input.nameservers.length === 1 && input.nameservers[0] === input.dnsHelperIp ? [] : [`resolv.conf-names:${input.nameservers.join(",") || "none"}`]),
      // The control's resolver is alive (ctl-embedded must be an answer, judged by the next item), so for a public name it must ANSWER without an address: a timeout would also be what a forward that went out and got nothing looks like.
      ...(control.get("ctl-embedded-public")?.status === "answer" && noAddress(control.get("ctl-embedded-public")) ? [] : [`embedded-public-in-the-unguarded-control=${shown(control, "ctl-embedded-public")}`]),
      ...unexpected(control, ["ctl-embedded"], ["answer"]).map((p) => `control-resolver-not-alive:${p}`),
      ...(input.resolvChanged ? ["resolv.conf-changed"] : []),
    ], `the sandbox's resolv.conf names ${input.dnsHelperIp} alone and, where Docker's resolver is open (an unguarded container of the same network), a public name gets no address through 127.0.0.11 (an answer for the run's own container names is the accepted residual, TS-SEAL-5; it was ${control.get("ctl-embedded")?.status ?? "no-result"} there)`),
    verdict("L3.embedded-resolver-blocked", "embedded-resolver-closed-in-the-sealed-sandbox", [
      // UDP: the DROP rule makes the send itself fail with EPERM. A timeout would mean something other than this rule dropped the packet.
      ...unexpected(results, ["embedded", "embedded-public", "embedded-direct"], ["error:EPERM"]),
      // TCP: the SYN is dropped, so the connect times out (or fails some other way, but never opens).
      ...unexpected(results, ["embedded-tcp", "embedded-direct-tcp"], NOT_THROUGH),
      ...(["embedded-direct", "embedded-direct-tcp"] as const).flatMap((label) => (results.get(label)?.status === "error:NOLISTENER" ? [`${label}-found-no-resolver-socket`] : [])),
      ...unexpected(control, ["ctl-embedded", "ctl-embedded-direct"], ["answer"]).map((p) => `control-failed:${p}`),
      ...unexpected(control, ["ctl-embedded-tcp", "ctl-embedded-direct-tcp"], ["open"]).map((p) => `control-failed:${p}`),
      ...(ruleLines[0]?.startsWith("-P OUTPUT ") === true && ruleLines[1] === GUARD_RULE_LINE ? [] : [`rule-not-first-in-the-chain:${input.outputRules === undefined ? "unreadable" : ruleLines.slice(0, 3).join(" / ")}`]),
      ...(results.get("v6")?.status === "v6listen" && results.get("v6")?.rest === "bad=" ? [] : [`ipv6-listener:${shown(results, "v6")}`]),
      ...(/^eff=0+ bnd=0+ amb=0+$/u.test(results.get("caps")?.rest ?? "") ? [] : [`sandbox-has-capabilities:${shown(results, "caps")}`]),
      ...(input.guardContainerGone ? [] : ["guard-container-left-behind-or-unreadable"]),
    ], "a lookup of 127.0.0.11 from the sealed sandbox (port 53 over UDP and TCP, and the resolver's own UDP and TCP ports) gets nothing (UDP: EPERM from the rule), while a container on the same network that is not guarded gets an answer on each; the rule is first in the sandbox's OUTPUT chain, no IPv6 listener, no capability, and the guard container is gone"),
  ];
}

async function checkL3(context: Context): Promise<LiveLine[]> {
  const { layer, input } = context;
  const lab = await startLab(context, "l3");
  const other = await startLab(context, "l3o");
  // the working sandbox (.3), dual-homed, with a listener started in it BEFORE the detach
  const workingName = `${lab.net.name}-work`;
  await sh(context, ["run", "-d", "--name", workingName, "--network", "agentx-task", ...lab.labels, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--pids-limit", "64", "--memory", "128m", "--memory-swap", "128m", "--user", "1000:1000", "--pull=never", "--entrypoint", NODE, input.workerImage, "-e", RELAY_LISTENER_JS]);
  const joined = await sh(context, ["network", "connect", "--ip", lab.net.workingSandboxIp, lab.net.name, workingName]);
  if (joined.exitCode !== 0) return L3_IDS.map(([id, name]) => fail(id, name, "the working sandbox could not join the run's network at .3"));
  const workspace = join(input.workDir, "workspace");
  const filesDir = join(input.workDir, `check-files-${lab.runId}`);
  await mkdir(workspace, { recursive: true, mode: 0o755 });
  await mkdir(filesDir, { recursive: true, mode: 0o755 });
  const sinkholeIp = layer.runNetwork.runNetworkHelperIp(lab.slot, 31);
  const netForPlan: CheckSandboxModule.CheckSandboxNetwork = {
    name: lab.net.name, slot: lab.slot, subnet: lab.net.subnet, dnsHelperIp: lab.net.dnsHelperIp, workingSandboxIp: lab.net.workingSandboxIp, checkSandboxIp: lab.net.checkSandboxIp, labelArgs: () => lab.labels,
  };
  const plan = layer.check.checkSandboxPlan({
    net: netForPlan, taskId: `tsl-${lab.runId}`.slice(0, 40), image: input.workerImage, guardImage: input.workerImage, rootPath: workspace, maskedPaths: [], filesDir,
    helpers: [{ alias: "postgres", address: lab.helper.address }], sinkholeIp, workingSandboxName: workingName,
  });
  await layer.check.writeCheckSandboxFiles(plan);
  const dns = await sh(context, plan.dnsHelperRunArgs);
  if (dns.exitCode !== 0) return L3_IDS.map(([id, name]) => fail(id, name, "the sealed DNS helper could not start"));
  // As the product does (test-services-run.ts): the check sandbox starts only once the name server listens.
  const dnsReady = await layer.check.waitForSealedDnsHelper(context.docker, plan.dnsHelperName).then(() => undefined, (error: unknown) => (error instanceof Error ? error.message : String(error)));
  if (dnsReady !== undefined) {
    const why = await containerState(context, plan.dnsHelperName);
    return L3_IDS.map(([id, name]) => fail(id, name, `the sealed DNS helper is not listening: ${dnsReady}; ${why}`));
  }
  const lines: LiveLine[] = [];
  const neighbour = await startNode(context, lab, `${lab.net.name}-nbr`, layer.runNetwork.runNetworkHelperIp(lab.slot, 20));
  // The positive control of the resolver guard (TS-SEAL-5 b): a container on the same network that the guard never touched. Docker's embedded resolver answers it on all three paths, so a silent sealed sandbox is the
  // guard's doing and not a resolver that is absent, not listening or not reachable by these probes.
  const embeddedControl = await probe(context, neighbour, [
    { label: "ctl-embedded", kind: "dnsq", server: "127.0.0.11", name: "postgres" }, { label: "ctl-embedded-tcp", kind: "conn", host: "127.0.0.11", port: 53, ms: 3000 }, { label: "ctl-embedded-direct", kind: "embdirect", name: "postgres" },
    { label: "ctl-embedded-direct-tcp", kind: "embdirecttcp", ms: 3000 },
    // The accepted floor (TS-SEAL-5 a), measured where the resolver is open: what an UNGUARDED container gets for a public name. The sealed sandbox's own probe of it is only EPERM.
    // 10 s, well above Docker's roughly 4 s forward timeout, because the answer is required (a timeout would not show that the resolver refused to forward).
    { label: "ctl-embedded-public", kind: "dnsq", server: "127.0.0.11", name: "registry.npmjs.org", ms: 10_000 },
  ]);
  // the relay is real before the detach: a neighbour reaches the listener in the working sandbox at .3
  const relayBefore = await probe(context, neighbour, [conn("relay-before", lab.net.workingSandboxIp, 7777, 5000)]);
  const round = await layer.check.withDetachedWorking(context.docker, plan, async (start) => {
    // the working sandbox is off the network now: only .2, the helpers and (below) .4 are on it
    const detachedNetworks = await sh(context, ["network", "inspect", "--format", "{{range .Containers}}{{.Name}} {{end}}", lab.net.name]);
    await start();
    const check = plan.sandboxName;
    const tests: ProbeTest[] = [
      { label: "resolv", kind: "file", path: "/etc/resolv.conf" }, { label: "embedded", kind: "dnsq", server: "127.0.0.11", name: "postgres" }, { label: "embedded-public", kind: "dnsq", server: "127.0.0.11", name: "registry.npmjs.org" },
      // TS-SEAL-5 (b): the guard closed 127.0.0.11 before the first command. Port 53 is rewritten by Docker's nat rule to the resolver's random port; "embedded-direct" goes straight to that random port (read from /proc/net/udp), so
      // the nat rewrite is not in its path at all, and "embedded-tcp" is the TCP side of port 53. All four must get nothing. "caps" proves the sandbox itself has no capability (NET_ADMIN is only ever the guard's).
      { label: "embedded-tcp", kind: "conn", host: "127.0.0.11", port: 53, ms: 3000 }, { label: "embedded-direct", kind: "embdirect", name: "postgres" },
      { label: "embedded-direct-tcp", kind: "embdirecttcp", ms: 3000 }, { label: "v6", kind: "v6listen" }, { label: "caps", kind: "caps" },
      { label: "known", kind: "lookup", name: "postgres" }, { label: "unknown", kind: "lookup", name: `tsl-${randomBytes(4).toString("hex")}.example.invalid` },
      conn("relay", lab.net.workingSandboxIp, 7777), conn("helper", lab.helper.address, PROBE_PORT, 5000), conn("other-helper", other.helper.address, PROBE_PORT), conn("other-sandbox", other.net.workingSandboxIp, PROBE_PORT),
      { label: "routes", kind: "routes" }, { label: "addrs", kind: "addrs" }, { label: "write-resolv", kind: "write", path: "/etc/resolv.conf" }, { label: "write-hosts", kind: "write", path: "/etc/hosts" },
      { label: "v6-conn", kind: "conn", host: "2001:4860:4860::8888", port: 443, ms: 3000 }, ...wallTests(lab),
    ];
    const results = await probe(context, check, tests);
    // From outside, as the reader of the rule: another NET_ADMIN container joined to the sandbox's namespace lists its filter OUTPUT chain. The product does not do this (its own read-back is `-C`); this is the CI proof of position.
    const readBack = await sh(context, ["run", "--rm", "--pull=never", "--name", `${check}-guard-read`, ...lab.labels, "--network", `container:${check}`, "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
      "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=1m", "--entrypoint", layer.check.RESOLVER_GUARD_BINARY, input.workerImage, "-w", "5", "-S", "OUTPUT"]);
    const afterWrite = await probe(context, check, [{ label: "resolv", kind: "file", path: "/etc/resolv.conf" }]);
    const dnsRecord = await layer.check.readSealedDnsRecord(context.docker, plan.dnsHelperName);
    return { results, afterWrite, dnsRecord, networks: detachedNetworks.stdout, outputRules: readBack.exitCode === 0 ? readBack.stdout : undefined };
  });
  const results = round.results;
  // The positive control of the relay item: the listener in the working sandbox is still there after the round (it is back at .3), so ".4 could not reach .3" was the detach, not a dead listener.
  const relayAfter = await probe(context, neighbour, [conn("relay-after", lab.net.workingSandboxIp, 7777, 5000)]);
  const dnsAfter = results.get("unknown")?.rest === sinkholeIp ? "" : await containerState(context, plan.dnsHelperName);
  const resolvFile = results.get("resolv")?.rest ?? "";
  const nameservers = [...resolvFile.matchAll(/nameserver ([0-9.]+)/gu)].map((match) => match[1]);
  // L3.live: a run name resolves to its helper, an unknown name goes to the sinkhole, an IP literal on the internet fails
  lines.push(verdict("L3.live", "sealed-sandbox-reaches-only-the-run", [
    ...(results.get("known")?.rest === lab.helper.address && results.get("known")?.status === "resolved" ? [] : [`known-name:${results.get("known")?.status ?? "no-result"}:${results.get("known")?.rest ?? ""}`]),
    ...(results.get("unknown")?.rest === sinkholeIp ? [] : [`unknown-name-not-sinkholed:${results.get("unknown")?.status ?? "no-result"}:${results.get("unknown")?.rest ?? ""}`]),
    ...unexpected(results, ["helper"], ["open"]), ...unexpected(results, WALL_LABELS, NOT_THROUGH),
    ...(round.dnsRecord.unknown.some((row) => row.name.startsWith("tsl-")) ? [] : ["unknown-name-not-recorded"]),
    ...(dnsAfter === "" ? [] : [`dns-helper:${dnsAfter}`]),
  ], `a run name resolves to ${lab.helper.address}, an unknown name resolves to the sinkhole ${sinkholeIp} and is recorded, an IP literal on the internet fails`));
  const guardLeft = await sh(context, ["ps", "--all", "--quiet", "--filter", `name=^${plan.sandboxName}-guard`]);
  lines.push(...embeddedResolverLines({
    results, control: embeddedControl, nameservers, dnsHelperIp: lab.net.dnsHelperIp, resolvChanged: round.afterWrite.get("resolv")?.rest !== resolvFile,
    guardContainerGone: guardLeft.exitCode === 0 && guardLeft.stdout.trim() === "", outputRules: round.outputRules,
  }));
  const attachedNames = round.networks.split(/\s+/u).filter(Boolean);
  lines.push(verdict("L3.working-relay", "working-sandbox-relay-is-gone", [
    ...unexpected(results, ["relay"], NOT_THROUGH), ...(attachedNames.includes(workingName) ? ["working-sandbox-still-on-the-network"] : []),
    ...unexpected(relayBefore, ["relay-before"], ["open"]).map((p) => `listener-before-detach:${p}`),
    ...unexpected(relayAfter, ["relay-after"], ["open"]).map((p) => `listener-after-round:${p}`),
  ], `with a listener in the working sandbox from before the detach (and still there after the round), a connection from .4 to .3 fails; the network lists ${attachedNames.join(", ")}`));
  const v6Global = /v6global=(\S*)/u.exec(results.get("addrs")?.rest ?? "")?.[1] ?? "?";
  lines.push(verdict("L3.ipv6", "no-ipv6-in-or-out", [
    ...(v6Global === "" ? [] : [`global-ipv6-address:${v6Global}`]), ...unexpected(results, ["v6-conn"], [...NOT_THROUGH, "error:EAFNOSUPPORT", "error:ENETUNREACH", "error:EINVAL"]),
    ...(/v6routes=0\b/u.test(results.get("routes")?.rest ?? "") ? [] : [`ipv6-routes:${/v6routes=(\S*)/u.exec(results.get("routes")?.rest ?? "")?.[1] ?? "?"}`]),
  ], "no global IPv6 address, no IPv6 route, and an IPv6 connection to a public address fails (the host's INPUT drop is checked by the shell script)"));
  lines.push(verdict("L3.no-route", "no-default-route-8888-metadata-gateway", [
    ...(hasDefaultRoute(results.get("routes")?.rest ?? "") ? ["default-route-present"] : []), ...unexpected(results, WALL_LABELS, NOT_THROUGH),
  ], "no default route in the sandbox and 8.8.8.8 (53 and 443), 169.254.169.254 and the gateway (22, 80, 443, 5432) all fail"));
  lines.push(verdict("L3.other-run", "another-run-unreachable", unexpected(results, ["other-helper", "other-sandbox"], NOT_THROUGH),
    `another run's helper (${other.helper.address}) and sandbox (${other.net.workingSandboxIp}) cannot be reached from .4`));
  lines.push(verdict("L3.run-files", "run-files-not-writable-through-workspace", [
    ...unexpected(results, ["write-resolv", "write-hosts"], ["denied"]), ...(round.afterWrite.get("resolv")?.rest === resolvFile ? [] : ["resolv.conf-changed"]),
  ], "writing /etc/resolv.conf and /etc/hosts from the sandbox is denied, and resolv.conf still names the DNS helper alone"));
  // the remaining items need containers beside the sealed sandbox, started with the working sandbox back on the network (as the real round does after it)
  lines.push(await multicastItem(context, lab, other, plan.sandboxName, workspace, neighbour));
  lines.push(await spoofingItem(context, lab, neighbour, workingName, plan.dnsHelperName));
  return lines;
}

const L3_IDS: ReadonlyArray<readonly [string, string]> = [
  ["L3.live", "sealed-sandbox-reaches-only-the-run"], ["L3.embedded-resolver", "docker-embedded-resolver-and-dnat"], ["L3.embedded-resolver-blocked", "embedded-resolver-closed-in-the-sealed-sandbox"], ["L3.working-relay", "working-sandbox-relay-is-gone"], ["L3.ipv6", "no-ipv6-in-or-out"],
  ["L3.no-route", "no-default-route-8888-metadata-gateway"], ["L3.other-run", "another-run-unreachable"], ["L3.multicast", "multicast-and-broadcast-stay-on-the-bridge"],
  ["L3.run-files", "run-files-not-writable-through-workspace"], ["L3.spoofing", "helper-ignores-spoofed-and-neighbour-sources"],
];

/** Multicast and broadcast from a sandbox of the run reach no listener on another run's bridge or on Docker's default bridge. */
async function multicastItem(context: Context, lab: Lab, other: Lab, _sealed: string, _workspace: string, sender: string): Promise<LiveLine> {
  const groups = ["224.0.0.251", "239.255.255.250"];
  const listen = JSON.stringify({ port: 5353, groups, ms: 6000 });
  const listeners: string[] = [];
  for (const [index, network] of [other.net.name, "bridge"].entries()) {
    const name = `${lab.net.name}-lsn${String(index)}`;
    const started = await sh(context, ["run", "-d", "--name", name, "--network", network, ...lab.labels, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "32", "--memory", "64m", "--user", "1000:1000",
      "--pull=never", "--entrypoint", NODE, context.input.workerImage, "-e", LISTEN_JS, listen]);
    if (started.exitCode === 0) listeners.push(name);
  }
  const broadcast = lab.net.subnet.replace(/\.0\/24$/u, ".255");
  await probe(context, sender, [
    { label: "mc1", kind: "send", host: "224.0.0.251", port: 5353 }, { label: "mc2", kind: "send", host: "239.255.255.250", port: 5353 }, { label: "bc", kind: "send", host: broadcast, port: 5353 },
  ]);
  const problems: string[] = listeners.length === 2 ? [] : ["listener-not-started"];
  for (const name of listeners) {
    await sh(context, ["wait", name], 30_000);
    const logs = await sh(context, ["logs", name]);
    if (!logs.stdout.includes("silent")) problems.push(`${name}-heard:${clean(logs.stdout).slice(0, 40)}`);
  }
  return verdict("L3.multicast", "multicast-and-broadcast-stay-on-the-bridge", problems, "sends to 224.0.0.251, 239.255.255.250 and the /24 broadcast were heard by no listener on another run's bridge or on Docker's default bridge");
}

/** A query to the sealed DNS helper from the working sandbox (.3) and from a neighbour (.16 and up) gets no answer and records nothing. The forged-source (IP_FREEBIND) case needs a raw socket and is the accepted residual TS-SEAL-4: it can only add a name to the record blindly. */
async function spoofingItem(context: Context, lab: Lab, neighbour: string, workingName: string, dnsName: string): Promise<LiveLine> {
  const name = `tsl-spoof-${randomBytes(3).toString("hex")}.example.invalid`;
  const fromNeighbour = await probe(context, neighbour, [{ label: "nbr", kind: "dnsq", server: lab.net.dnsHelperIp, name }]);
  const fromWorking = await probe(context, workingName, [{ label: "work", kind: "dnsq", server: lab.net.dnsHelperIp, name }]);
  const record = await sh(context, ["exec", dnsName, "cat", "/state/unknown.json"]);
  return verdict("L3.spoofing", "helper-ignores-spoofed-and-neighbour-sources", [
    ...unexpected(fromNeighbour, ["nbr"], SILENT), ...unexpected(fromWorking, ["work"], SILENT), ...(record.stdout.includes(name) ? ["a-neighbour-query-was-recorded"] : []),
  ], "a query to the DNS helper from .3 and from a neighbour at .20 gets no answer and is not recorded (a forged .4 source can only add a name blindly: TS-SEAL-4, accepted)");
}

// ---- TS-L4 (Postgres) and TS-RUN-3 (template_db)

async function checkL4(context: Context): Promise<LiveLine[]> {
  const lab = await startLab(context, "l4");
  const problems: string[] = [];
  const container = lab.helper.container;
  const inspected = await sh(context, ["inspect", "--format", "{{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.SecurityOpt}} {{.Config.User}} {{json .HostConfig.Tmpfs}} {{json .HostConfig.Privileged}}", container]);
  const [capDrop = "", capAdd = "", readonly = "", securityOpt = "", user = "", tmpfs = "", privileged = ""] = inspected.stdout.trim().split(" ");
  if (!capDrop.includes("ALL")) problems.push("cap-drop-ALL-missing");
  if (capAdd !== "null" && capAdd !== "[]") problems.push(`cap-add:${capAdd}`);
  if (readonly !== "true") problems.push(`readonly-root:${readonly}`);
  if (!securityOpt.includes("no-new-privileges")) problems.push("no-new-privileges-missing");
  if (privileged !== "false") problems.push(`privileged:${privileged}`);
  if (/^(?:0|root)(?::|$)/u.test(user) || user === "") problems.push(`user:${user || "unset"}`);
  if (tmpfs === "null" || !tmpfs.includes("/")) problems.push("no-tmpfs");
  const uids = parseUids((await sh(context, ["exec", container, "grep", "^Uid:", "/proc/1/status"])).stdout);
  if (uids === undefined) problems.push("uid-unreadable");
  else if (uids.includes(0)) problems.push(`process-runs-as-root:uids=${uids.join(",")}`);
  const caps = await sh(context, ["exec", container, "grep", "CapEff", "/proc/1/status"]);
  if (!/CapEff:\s*0+\s*$/u.test(caps.stdout.trim())) problems.push(`effective-capabilities:${clean(caps.stdout).slice(0, 40)}`);
  if (!(await lab.session.probe("postgres", 30_000))) problems.push("not-healthy");
  const lines: LiveLine[] = [verdict("L4.live", "helpers-start-non-root", problems, "Postgres runs as a non-root user with every capability dropped, a read-only root, no-new-privileges and tmpfs data, and answers its health check")];
  lines.push(await templateDbItem(context, lab));
  return lines;
}

/** TS-RUN-3: the template_db reset on the real image: the seeded data survives a reset, the unseeded change does not. Relies on the official image's local-socket trust (the launcher's own psql runs over the socket). */
async function templateDbItem(context: Context, lab: Lab): Promise<LiveLine> {
  const { user, database } = lab.request.credentials ?? {};
  if (user === undefined || database === undefined) return fail("L4.template-db", "template-db-reset-keeps-seeds", "the request had no user and database");
  const sql = async (statement: string, db: string = database): Promise<string> => {
    const ran = await sh(context, ["exec", lab.helper.container, "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", db, "-c", statement]);
    if (ran.exitCode !== 0) throw new Error(`psql failed: ${clean(ran.stderr).slice(0, 120)}`);
    return ran.stdout.trim();
  };
  const problems: string[] = [];
  await sql("CREATE TABLE tsl_seed (n integer)");
  await sql("INSERT INTO tsl_seed VALUES (1)");
  await lab.session.seeded("postgres");
  const afterSeeded = await sql("SELECT count(*) FROM tsl_seed");
  if (afterSeeded !== "1") problems.push(`after-seeded:${afterSeeded}`);
  await sql("INSERT INTO tsl_seed VALUES (2)");
  const outcome = await lab.session.reset("postgres");
  if (!outcome.keptSeeds) problems.push("reset-did-not-keep-seeds");
  const afterReset = await sql("SELECT count(*) FROM tsl_seed");
  if (afterReset !== "1") problems.push(`after-reset:${afterReset}`);
  return verdict("L4.template-db", "template-db-reset-keeps-seeds", problems, "after the seeds, a change is undone by the reset and the seeded row is still there (CREATE DATABASE ... TEMPLATE on the real image)");
}

// ---- TS-L6

async function checkL6(context: Context): Promise<LiveLine[]> {
  const { layer } = context;
  const lab = await startLab(context, "l6");
  const name = lab.net.name;
  const slot = lab.slot;
  // "kill the worker without a stop": the lab is left as it is (no stop), the way a killed worker leaves it; then the restarted worker's first act, the worker-start sweep, runs.
  const before = await sh(context, ["ps", "-a", "-q", "--filter", `label=${layer.runNetwork.RUN_NETWORK_LABEL}=${name}`]);
  const swept = await layer.helpers.sweepServicesNetworksAtWorkerStart(context.docker, TSL_WORKSPACE);
  const afterContainers = await sh(context, ["ps", "-a", "-q", "--filter", `label=${layer.runNetwork.RUN_NETWORK_LABEL}=${name}`]);
  const afterNetworks = await sh(context, ["network", "ls", "-q", "--filter", `label=${layer.runNetwork.RUN_NETWORK_LABEL}=${name}`]);
  const problems: string[] = [];
  if (before.stdout.trim() === "") problems.push("nothing-to-sweep");
  if (afterContainers.stdout.trim() !== "") problems.push("helper-still-there");
  if (afterNetworks.stdout.trim() !== "") problems.push("network-still-there");
  // the slot is taken again by the next run that hashes to it: start a run and look at its network's subnet
  const again = await startLab(context, "l6b");
  return [verdict("L6.live", "killed-worker-sweep", problems, `the worker-start sweep removed ${String(swept.containers)} container(s) and ${String(swept.networks)} network(s) of the killed run (slot ${String(slot)}); the next run started on ${again.net.name}`)];
}

// ---- the whole run

export const ITEMS = ["L1", "L2", "L3", "L4", "L6"] as const;
const PENDING_IDS: Readonly<Record<(typeof ITEMS)[number], ReadonlyArray<readonly [string, string]>>> = {
  L1: [["L1.live", "helper-reachable-internet-not"], ["L1.live-other-run", "another-runs-helper-unreachable"]],
  L2: [["L2.live", "dual-homed-sandbox"]],
  L3: L3_IDS,
  L4: [["L4.live", "helpers-start-non-root"], ["L4.template-db", "template-db-reset-keeps-seeds"]],
  L6: [["L6.live", "killed-worker-sweep"]],
};

/** Every live item as a FAIL with the same reason (the catalog cannot be trusted yet): reported, never passed. */
export function blockedLines(reason: string): LiveLine[] {
  return ITEMS.flatMap((item) => PENDING_IDS[item].map(([id, name]) => fail(id, name, reason)));
}

/** Runs every item, one after the other (each in a lab of its own), removes everything it started, and answers the lines. A check that cannot run gives FAIL lines for its items, never a silent skip and never a PASS. */
export async function runLiveChecks(input: LiveInput): Promise<{ lines: LiveLine[]; redact: (text: string) => string }> {
  const layer = input.layer ?? (await loadRunLayer());
  const docker = input.docker ?? layer.containers.createDockerCli();
  const secrets: string[] = [];
  const redact = (text: string): string => secrets.reduce((value, secret) => value.split(secret).join("[removed]"), text);
  let entry: CatalogEntry & { image: { digest: string } };
  if (input.entry !== undefined) entry = input.entry;
  else {
    if (input.catalog === undefined) throw new Error("no catalog");
    entry = postgresEntry(input.catalog);
    await resolvePostgres(input);
  }
  const context: Context = { input, layer, docker, entry, secrets, redact, counter: { n: 0 }, cleanups: [] };
  const lines: LiveLine[] = [];
  // the worker-start sweep of the throwaway workspace: what an earlier, killed check left behind goes first
  await layer.helpers.sweepServicesNetworksAtWorkerStart(docker, TSL_WORKSPACE).catch(() => undefined);
  const checks: Record<(typeof ITEMS)[number], (context: Context) => Promise<LiveLine[]>> = { L1: checkL1, L2: checkL2, L3: checkL3, L4: checkL4, L6: checkL6 };
  for (const item of ITEMS) {
    try {
      lines.push(...(await checks[item](context)));
    } catch (error) {
      const reason = clean(redact(error instanceof Error ? error.message : String(error))).slice(0, 200);
      lines.push(...PENDING_IDS[item].map(([id, name]) => fail(id, name, `the check could not run: ${reason}`)));
    } finally {
      // everything this item started, by its labels, whatever happened; the next item starts from nothing
      for (const cleanup of context.cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
      await layer.helpers.sweepServicesNetworksAtWorkerStart(docker, TSL_WORKSPACE).catch(() => undefined);
    }
  }
  return { lines, redact };
}

// ---- delivery through SSM (on the Mac)

/** One SSM command string stays short: each file goes in base64 pieces of this size. */
export const SSM_CHUNK_CHARS = 3_000;

/** The driver as a program a bare `node` runs: types stripped, imports left as they are. Needs esbuild (a dev dependency of the repository). */
export async function driverJavaScript(file: string): Promise<string> {
  const { transform } = await import("esbuild");
  return (await transform(await readFile(file, "utf8"), { loader: "ts", format: "esm", platform: "node", target: "node22", sourcefile: "linux-check-test-services-live.ts" })).code;
}

/** The `commands` of an AWS-RunShellScript call: write the three files (gzip, then base64) into a root-only directory made with mktemp, run the shell script with TSL_DIR set, remove the directory. Pure: nothing is sent. */
export function ssmCommands(files: { script: string; driver: string; catalog: string; signature: string }): string[] {
  const pieces = (name: string, text: string): string[] => {
    const encoded = gzipSync(Buffer.from(text, "utf8"), { level: 9 }).toString("base64");
    const out = [`: > "$d/${name}.b64"`];
    for (let at = 0; at < encoded.length; at += SSM_CHUNK_CHARS) out.push(`printf '%s' '${encoded.slice(at, at + SSM_CHUNK_CHARS)}' >> "$d/${name}.b64"`);
    out.push(`base64 -d "$d/${name}.b64" | gunzip > "$d/${name}" || exit 1`);
    return out;
  };
  return [
    `umask 077; d=$(mktemp -d /var/tmp/tsl.XXXXXX) || exit 1`,
    ...pieces("s.sh", files.script), ...pieces("live.mjs", files.driver), ...pieces("catalog.json", files.catalog), ...pieces("catalog.sig.json", files.signature),
    `TSL_DIR="$d" bash "$d/s.sh"; rc=$?; rm -rf "$d"; exit $rc`,
  ];
}

// ---- CI mode

/** The CI mode's inputs are plain environment values, each checked; a missing or malformed one stops the run (exit 1), never skips an item. */
async function runCi(environment: NodeJS.ProcessEnv): Promise<number> {
  const need = (name: string, pattern: RegExp): string => {
    const value = environment[name];
    if (value === undefined || !pattern.test(value)) throw new Error(`${name} is missing or not in the expected form`);
    return value;
  };
  const digest = need("TSL_CI_POSTGRES_DIGEST", /^sha256:[a-f0-9]{64}$/u).slice("sha256:".length);
  const registry = need("TSL_REGISTRY", /^localhost:[0-9]{2,5}$/u);
  const env = need("TSL_ENV", /^[a-z][a-z0-9-]{0,19}$/u);
  const workDir = need("TSL_WORK", /^\/[A-Za-z0-9._/-]{1,200}$/u);
  const workerImage = need("TSL_WORKER_IMAGE", /^(?:[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u);
  const catalogFile = need("TSL_CATALOG", /^\/[A-Za-z0-9._/-]{1,200}$/u);
  const entry = ciPostgresEntry(await readFile(catalogFile), digest);
  const { lines, redact } = await runLiveChecks({ entry, registry, env, workerImage, workDir });
  process.stdout.write(`${lines.map((line) => formatLine(line, redact)).join("\n")}\n`);
  return 0;
}

// ---- the command line

async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0];
  const here = dirname(new URL(import.meta.url).pathname);
  if (mode === "--ssm-params") {
    const repo = resolve(here, "..");
    const commands = ssmCommands({
      script: await readFile(join(here, "linux-check-test-services.sh"), "utf8"),
      driver: await driverJavaScript(join(here, "linux-check-test-services-live.ts")),
      catalog: await readFile(join(repo, "environments/service-catalog/catalog.json"), "utf8"),
      // Not there until the catalog is built and signed: delivered empty, and the live run then says so (BLOCKED or "no signature yet"), never passes.
      signature: await readFile(join(repo, "environments/service-catalog/catalog.sig.json"), "utf8").catch(() => ""),
    });
    process.stdout.write(`${JSON.stringify({ commands })}\n`);
    return 0;
  }
  if (mode === "--js") {
    process.stdout.write(await driverJavaScript(join(here, "linux-check-test-services-live.ts")));
    return 0;
  }
  if (mode === "ci") return runCi(process.env);
  if (mode !== "run" && mode !== "pull-list") {
    process.stderr.write("usage: --ssm-params (on the Mac)  |  --js  |  run  |  pull-list  |  ci   (run, pull-list and ci inside the worker image; see the header)\n");
    return 2;
  }
  const environment = process.env;
  const need = (name: string, pattern: RegExp): string => {
    const value = environment[name];
    if (value === undefined || !pattern.test(value)) throw new Error(`${name} is missing or not in the expected form`);
    return value;
  };
  const registry = need("TSL_REGISTRY", /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/u);
  const env = need("TSL_ENV", /^[a-z][a-z0-9-]{0,19}$/u);
  const catalogFile = need("TSL_CATALOG", /^\/[A-Za-z0-9._/-]{1,200}$/u);
  // The account this process runs in: the shell script read it from the instance identity document (not a setting); absent or malformed means unknown, and the staging-only key is then not trusted.
  const account = /^[0-9]{12}$/u.test(environment["TSL_ACCOUNT_ID"] ?? "") ? environment["TSL_ACCOUNT_ID"] : undefined;
  let catalog: VerifiedCatalog;
  try {
    catalog = loadVerifiedCatalog({ catalogBytes: await readFile(catalogFile), signatureBytes: await readFile(catalogFile.replace(/catalog\.json$/u, "catalog.sig.json")).catch(() => Buffer.alloc(0)), runningAccountId: account });
  } catch (error) {
    if (!(error instanceof BlockedError)) throw error;
    // Every live item is reported, none passes.
    if (mode === "pull-list") { process.stdout.write(`${error.message}\n`); return 3; }
    process.stdout.write(`${blockedLines(error.message).map((line) => formatLine(line)).join("\n")}\n`);
    return 0;
  }
  if (mode === "pull-list") {
    process.stdout.write(`${pullList({ catalog, registry, env }).join("\n")}\n`);
    return 0;
  }
  const workDir = need("TSL_WORK", /^\/[A-Za-z0-9._/-]{1,200}$/u);
  const workerImage = need("TSL_WORKER_IMAGE", /^[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[a-f0-9]{64}$/u);
  const manifestDir = need("TSL_MANIFESTS", /^\/[A-Za-z0-9._/-]{1,200}$/u);
  const manifests = manifestFilesPort((digest) => readFile(join(manifestDir, digest)).catch(() => undefined));
  const { lines, redact } = await runLiveChecks({ catalog, manifests, registry, env, workerImage, workDir });
  process.stdout.write(`${lines.map((line) => formatLine(line, redact)).join("\n")}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`TSL ERROR ${error instanceof Error ? error.message.slice(0, 200) : "the live checks stopped"}\n`);
    process.exitCode = 1;
  });
}
