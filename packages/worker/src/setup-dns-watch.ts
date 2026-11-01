import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { connect, createServer, isIP, type Server, type Socket as TcpSocket } from "node:net";
import { SETUP_BLOCKED_HOSTS_MAX, SetupHostSchema, agentXError } from "@agentx/contracts";

/**
 * Blocked-host detection for the setup agent (design setup-test-health 3.3, task SH9).
 *
 * The network's DNS firewall answers NXDOMAIN (or REFUSED) for a name outside the project's allowed websites, and its query log is per VPC, not per sandbox. So the setup sandbox is
 * given a DNS forwarder of its own (`--dns <address>`, see `TaskSandboxOptions.dns`): it passes every standard query to the one real resolver, hands the answer back byte for byte,
 * and remembers the names the resolver refused, for this run only, at most `SETUP_BLOCKED_HOSTS_MAX` of them.
 *
 * What it will not do, so the host list cannot be steered by a repository:
 *   - it never reads a command's output. The only way a name gets in is a question the sandbox asked the resolver and the resolver's own refusal of it (an address lookup: A, AAAA or HTTPS);
 *   - a name must be a plain host name (`SetupHostSchema`): an address literal, a single label or an underscore name is dropped, never recorded;
 *   - an answer counts only when it comes from the one upstream, with the id and the question that were asked;
 *   - it is not an open resolver: one upstream, optional list of source addresses, a bound on queries in flight (past it a query is dropped, and the client asks again).
 * A name a command makes up (a tunnel to an attacker's zone) is a name like any other: the host list is only ever a list for an administrator to read (SH12), never a grant.
 */

/** RFC 1035 response codes this module acts on. */
const RCODE_NXDOMAIN = 3;
const RCODE_REFUSED = 5;
/** The address lookups: A, AAAA and HTTPS. A refused TXT, MX or reverse lookup is not a host a command needs. */
const ADDRESS_LOOKUP_TYPES: ReadonlySet<number> = new Set([1, 28, 65]);
/** The most bytes of a DNS message it handles (the EDNS payload size resolvers use). */
const MAX_MESSAGE_BYTES = 4_096;
const HEADER_BYTES = 12;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_IN_FLIGHT = 64;
const MAX_TCP_CONNECTIONS = 16;
const TCP_IDLE_MS = 10_000;
const START_ATTEMPTS = 5;
/** Queries one TCP connection may have waiting at once; one more and the connection is closed. */
const MAX_TCP_PENDING_PER_CONNECTION = 8;
/** A TCP answer may fill its two-byte length (RFC 7766); a query never needs more than 4096. */
const MAX_TCP_ANSWER_BYTES = 65_535;

export interface DnsPacket {
  id: number;
  response: boolean;
  opcode: number;
  truncated: boolean;
  rcode: number;
  /** The question's name, lower-case, without the trailing dot. */
  name: string;
  type: number;
  /** A label of the question contains a dot, so `name` (the labels joined by dots) is not the one name that was asked. Such a name is never recorded. */
  dottedLabel: boolean;
}

/** An IPv4 or IPv6 literal that is unspecified (0.0.0.0, ::), multicast, or the IPv4 broadcast address. */
function unspecifiedOrMulticast(address: string): boolean {
  if (isIP(address) === 4) {
    const first = Number(address.split(".")[0]);
    return address === "0.0.0.0" || address === "255.255.255.255" || (first >= 224 && first <= 239);
  }
  const lower = address.toLowerCase();
  return /^(?:0*:)+0*$/u.test(lower) || lower.startsWith("ff");
}

/** A private address the sandbox network can reach: RFC 1918, or an IPv6 unique-local or link-local one. Loopback, public, v4-mapped and unspecified addresses are not. */
function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const first = address.toLowerCase().split("%")[0]!.split(":")[0]!;
  if (first === "") return false;
  const value = Number.parseInt(first, 16);
  return Number.isFinite(value) && ((value & 0xfe00) === 0xfc00 || (value & 0xffc0) === 0xfe80);
}

/**
 * The header and the one question of a DNS message, or undefined when the message is not exactly one a stub resolver sends or gets back: shorter than a question, not one question, a name
 * with a compression pointer or a label over 63 bytes or more than 253 bytes in all, or a question cut short. Reads nothing past the question.
 */
export function parseDnsPacket(packet: Buffer, maxBytes: number = MAX_MESSAGE_BYTES): DnsPacket | undefined {
  if (packet.length < HEADER_BYTES + 5 || packet.length > maxBytes) return undefined;
  if (packet.readUInt16BE(4) !== 1) return undefined;
  const flags = packet.readUInt16BE(2);
  const labels: string[] = [];
  let offset = HEADER_BYTES;
  let nameBytes = 0;
  let dottedLabel = false;
  for (;;) {
    const length = packet[offset];
    if (length === undefined) return undefined;
    offset += 1;
    if (length === 0) break;
    if (length > 63) return undefined; // a compression pointer (0xC0...) or a reserved label type
    if (offset + length > packet.length) return undefined;
    nameBytes += length + 1;
    if (nameBytes > 253) return undefined;
    const label = packet.toString("latin1", offset, offset + length);
    if (label.includes(".")) dottedLabel = true;
    labels.push(label);
    offset += length;
  }
  if (offset + 4 > packet.length) return undefined;
  return {
    id: packet.readUInt16BE(0), response: (flags & 0x8000) !== 0, opcode: (flags >> 11) & 0xf, truncated: (flags & 0x0200) !== 0, rcode: flags & 0xf,
    name: labels.join(".").toLowerCase(), type: packet.readUInt16BE(offset), dottedLabel,
  };
}

export interface SetupDnsWatchOptions {
  /**
   * The address to listen on, UDP and TCP: the sandbox network's gateway, which is what the sandbox is given as its DNS server. It must be an explicit PRIVATE address (10/8, 172.16/12, 192.168/16,
   * fc00::/7, fe80::/10): never 0.0.0.0 or `::` (an open forwarder on every interface), multicast, or a public address.
   */
  listenAddress: string;
  /** Allow a loopback listen address. For tests and a developer's machine only: a sandbox cannot reach loopback, so a real run never sets it. */
  allowLoopback?: boolean;
  /** Default 53. 0 picks a free port (tests). */
  port?: number;
  /** The real resolver every query is passed on to. */
  upstream: { address: string; port?: number };
  /**
   * The source addresses that are served (the sandbox container's address, known only once the container runs: `setAllowedSources`). Until a list is set the watch serves NOTHING and records
   * nothing, so another sandbox on the same network can never add names to a run's list. Every other packet is dropped and not recorded.
   */
  allowedSources?: readonly string[];
  /** How long to wait for the upstream's answer before dropping the query. Default 3 s. */
  upstreamTimeoutMs?: number;
  /** Queries being answered at once, UDP and TCP together. Default 64. */
  maxInFlight?: number;
}

/**
 * One setup run's DNS forwarder. `start()` binds, `blockedHosts()` is everything the run saw refused (at most 50), `takeBlocked()` is what was refused since the last call (a journal entry's
 * `blockedHosts`), and `stop()` closes everything. A refusal is only ever recorded after the answer was relayed.
 */
export class SetupDnsWatch {
  private readonly options: SetupDnsWatchOptions;
  private readonly all = new Set<string>();
  private readonly sinceTake = new Set<string>();
  private sources: ReadonlySet<string> | undefined;
  private readonly upstreamPort: number;
  private readonly upstreamTimeoutMs: number;
  private readonly maxInFlight: number;
  private inFlight = 0;
  private droppedNamesCount = 0;
  private droppedQueriesCount = 0;
  private udp: UdpSocket | undefined;
  private tcp: Server | undefined;
  private readonly tcpSockets = new Set<TcpSocket>();
  private readonly upstreamSockets = new Set<UdpSocket | TcpSocket>();
  private stopped = false;

  constructor(options: SetupDnsWatchOptions) {
    if (isIP(options.listenAddress) === 0) throw agentXError("CONFIG_INVALID", "the setup DNS watch listens on an IP address");
    const loopback = options.allowLoopback === true && (options.listenAddress === "127.0.0.1" || options.listenAddress === "::1");
    if (!loopback && (unspecifiedOrMulticast(options.listenAddress) || !isPrivateAddress(options.listenAddress))) {
      throw agentXError("CONFIG_INVALID", "the setup DNS watch listens on one explicit private IP address, never an unspecified, multicast, loopback or public one");
    }
    if (isIP(options.upstream.address) === 0) throw agentXError("CONFIG_INVALID", "the setup DNS watch forwards to an IP address");
    this.options = options;
    if (options.allowedSources !== undefined) this.setAllowedSources(options.allowedSources);
    this.upstreamPort = options.upstream.port ?? 53;
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  }

  /** Sets (replaces) the source addresses that are served. A non-empty list of IP addresses; unspecified and multicast addresses are refused. Takes effect for the next packet or connection. */
  setAllowedSources(sources: readonly string[]): void {
    if (sources.length === 0 || sources.length > 16 || sources.some((source) => isIP(source) === 0 || unspecifiedOrMulticast(source))) {
      throw agentXError("CONFIG_INVALID", "the setup DNS watch serves one to sixteen explicit IP addresses");
    }
    this.sources = new Set(sources);
  }

  /** Binds UDP and TCP on the same port and returns it. A port taken in between (only when asking for a free one) is tried again, a few times. */
  async start(): Promise<{ address: string; port: number }> {
    if (this.stopped) throw agentXError("RUNTIME_UNAVAILABLE", "the setup DNS watch was already stopped");
    if (this.udp !== undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the setup DNS watch already started");
    const wanted = this.options.port ?? 53;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.bind(wanted);
      } catch (error) {
        await this.closeSockets();
        if (wanted !== 0 || attempt >= START_ATTEMPTS || (error as { code?: unknown }).code !== "EADDRINUSE") throw error;
      }
    }
  }

  private async bind(wanted: number): Promise<{ address: string; port: number }> {
    const family = isIP(this.options.listenAddress) === 6 ? "udp6" : "udp4";
    const udp = createSocket(family);
    this.udp = udp;
    udp.on("message", (message, remote) => this.onUdp(message, remote.address, remote.port));
    udp.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(wanted, this.options.listenAddress, () => { udp.off("error", reject); resolve(); }); });
    const port = udp.address().port;
    const tcp = createServer((socket) => this.onTcpConnection(socket));
    this.tcp = tcp;
    tcp.maxConnections = MAX_TCP_CONNECTIONS;
    tcp.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, this.options.listenAddress, () => { tcp.off("error", reject); resolve(); }); });
    return { address: this.options.listenAddress, port };
  }

  /** Every name the resolver refused for this run, in the order first seen. At most 50. */
  blockedHosts(): string[] {
    return [...this.all];
  }

  /** The names refused since the last call (for one journal entry), then forgets them; `blockedHosts()` keeps them. */
  takeBlocked(): string[] {
    const taken = [...this.sinceTake];
    this.sinceTake.clear();
    return taken;
  }

  /** Refusals not kept because the run already holds 50 names. */
  droppedNames(): number {
    return this.droppedNamesCount;
  }

  /** Queries dropped because the bound on queries in flight was reached. */
  droppedQueries(): number {
    return this.droppedQueriesCount;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.closeSockets();
  }

  private async closeSockets(): Promise<void> {
    const udp = this.udp;
    const tcp = this.tcp;
    this.udp = undefined;
    this.tcp = undefined;
    for (const socket of this.tcpSockets) socket.destroy();
    for (const socket of this.upstreamSockets) {
      if ("destroy" in socket) socket.destroy();
      else { try { socket.close(); } catch { /* already closed */ } }
    }
    this.tcpSockets.clear();
    this.upstreamSockets.clear();
    await Promise.all([
      udp === undefined ? undefined : new Promise<void>((resolve) => { try { udp.close(() => resolve()); } catch { resolve(); } }),
      tcp === undefined ? undefined : new Promise<void>((resolve) => { if (!tcp.listening) resolve(); else tcp.close(() => resolve()); }),
    ]);
  }

  // ---- what to serve

  private served(address: string | undefined): boolean {
    return this.sources !== undefined && address !== undefined && this.sources.has(address);
  }

  /** The query to forward, or undefined to drop the packet: it must be one standard query. */
  private queryOf(packet: Buffer): DnsPacket | undefined {
    const parsed = parseDnsPacket(packet);
    return parsed === undefined || parsed.response || parsed.opcode !== 0 ? undefined : parsed;
  }

  private take(): boolean {
    if (this.inFlight >= this.maxInFlight) {
      this.droppedQueriesCount += 1;
      return false;
    }
    this.inFlight += 1;
    return true;
  }

  // ---- UDP

  private onUdp(message: Buffer, address: string, port: number): void {
    if (this.stopped || !this.served(address)) return;
    const query = this.queryOf(message);
    if (query === undefined || !this.take()) return;
    void this.forwardUdp(message, query)
      .then((reply) => {
        if (reply === undefined || this.udp === undefined) return;
        this.udp.send(reply.raw, port, address, () => undefined);
        this.record(query, reply.parsed);
      })
      .catch(() => undefined)
      .finally(() => { this.inFlight -= 1; });
  }

  private forwardUdp(raw: Buffer, query: DnsPacket): Promise<{ raw: Buffer; parsed: DnsPacket } | undefined> {
    return new Promise((resolve) => {
      if (this.stopped) { resolve(undefined); return; }
      const socket = createSocket(isIP(this.options.upstream.address) === 6 ? "udp6" : "udp4");
      this.upstreamSockets.add(socket);
      const finish = (value: { raw: Buffer; parsed: DnsPacket } | undefined) => {
        clearTimeout(timer);
        this.upstreamSockets.delete(socket);
        try { socket.close(); } catch { /* already closed */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), this.upstreamTimeoutMs);
      socket.on("error", () => finish(undefined));
      socket.on("message", (reply, remote) => {
        if (remote.address !== this.options.upstream.address || remote.port !== this.upstreamPort) return;
        const parsed = answerTo(query, reply);
        if (parsed !== undefined) finish({ raw: reply, parsed });
      });
      socket.send(raw, this.upstreamPort, this.options.upstream.address, (error) => { if (error !== null) finish(undefined); });
    });
  }

  // ---- TCP (a truncated UDP answer is asked again over TCP)

  private onTcpConnection(socket: TcpSocket): void {
    if (this.stopped || !this.served(socket.remoteAddress)) { socket.destroy(); return; }
    this.tcpSockets.add(socket);
    socket.setTimeout(TCP_IDLE_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.tcpSockets.delete(socket));
    let buffered = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve();
    let pending = 0;
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const length = buffered.readUInt16BE(0);
        if (length === 0 || length > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
        if (buffered.length < 2 + length) return;
        const message = buffered.subarray(2, 2 + length);
        buffered = buffered.subarray(2 + length);
        // A client that queues more than a few queries is not a resolver: close it. What is queued is dropped when it is reached (serveTcp checks the socket and the watch first).
        if (pending >= MAX_TCP_PENDING_PER_CONNECTION) { socket.destroy(); return; }
        pending += 1;
        chain = chain.then(() => this.serveTcp(socket, message)).catch(() => undefined).finally(() => { pending -= 1; });
      }
    });
  }

  private async serveTcp(socket: TcpSocket, message: Buffer): Promise<void> {
    if (this.stopped || socket.destroyed) return;
    const query = this.queryOf(message);
    if (query === undefined || !this.take()) return;
    try {
      const reply = await this.forwardTcp(message, query);
      if (reply === undefined || socket.destroyed) return;
      socket.write(Buffer.concat([Buffer.from([reply.raw.length >> 8, reply.raw.length & 0xff]), reply.raw]));
      this.record(query, reply.parsed);
    } finally {
      this.inFlight -= 1;
    }
  }

  private forwardTcp(raw: Buffer, query: DnsPacket): Promise<{ raw: Buffer; parsed: DnsPacket } | undefined> {
    return new Promise((resolve) => {
      if (this.stopped) { resolve(undefined); return; }
      const socket = connect(this.upstreamPort, this.options.upstream.address);
      this.upstreamSockets.add(socket);
      let buffered = Buffer.alloc(0);
      const finish = (value: { raw: Buffer; parsed: DnsPacket } | undefined) => {
        clearTimeout(timer);
        this.upstreamSockets.delete(socket);
        socket.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), this.upstreamTimeoutMs);
      socket.on("error", () => finish(undefined));
      socket.on("close", () => finish(undefined));
      socket.on("connect", () => socket.write(Buffer.concat([Buffer.from([raw.length >> 8, raw.length & 0xff]), raw])));
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length < 2) return;
        const length = buffered.readUInt16BE(0);
        if (length === 0 || length > MAX_TCP_ANSWER_BYTES) { finish(undefined); return; }
        if (buffered.length < 2 + length) return;
        const reply = buffered.subarray(2, 2 + length);
        const parsed = answerTo(query, reply, MAX_TCP_ANSWER_BYTES);
        finish(parsed === undefined ? undefined : { raw: reply, parsed });
      });
    });
  }

  // ---- what is remembered

  /** Remembers the name when the resolver refused an address lookup of it and it is a plain host name. Never throws. */
  private record(query: DnsPacket, answer: DnsPacket): void {
    if (answer.rcode !== RCODE_NXDOMAIN && answer.rcode !== RCODE_REFUSED) return;
    if (!ADDRESS_LOOKUP_TYPES.has(query.type) || query.dottedLabel) return;
    if (!SetupHostSchema.safeParse(query.name).success) return;
    if (!this.all.has(query.name)) {
      if (this.all.size >= SETUP_BLOCKED_HOSTS_MAX) {
        this.droppedNamesCount += 1;
        return;
      }
      this.all.add(query.name);
    }
    this.sinceTake.add(query.name);
  }
}

/** The parsed answer when `reply` is the response to `query` (a response, the same id, the same question), else undefined. */
function answerTo(query: DnsPacket, reply: Buffer, maxBytes: number = MAX_MESSAGE_BYTES): DnsPacket | undefined {
  const parsed = parseDnsPacket(reply, maxBytes);
  return parsed !== undefined && parsed.response && parsed.id === query.id && parsed.name === query.name && parsed.type === query.type ? parsed : undefined;
}
