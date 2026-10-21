/**
 * A fake time-stamping authority speaking HTTP for the anchor's tests: one handler per TSA URL for `routeFetch`. It reads the
 * RFC 3161 request with a reader of its own (not the verifier's), answers from the fake PKI in `fake-tsa.ts`, and misbehaves
 * the way a test asks. Every request is recorded with the time on the test's clock, so spacing can be asserted.
 */
import { createHash } from "node:crypto";
import { OIDS, buildResponse, buildToken, makePki, makeSigner, type FakePki } from "./fake-tsa.js";

export type TsaBehavior =
  | "grant"
  /** Never answers; the client's abort ends the request. */
  | "hang"
  | "rejection"
  | "other-hash"
  | "wrong-nonce"
  /** Signed by a PKI whose root the client does not trust for this authority. */
  | "wrong-root"
  /** The signer certificate has no timestamping extended key usage. */
  | "no-eku"
  /** The signing-certificate attribute names another certificate. */
  | "ess-mismatch"
  | "http-500"
  | "html"
  | "no-token";

export interface TsaRequestRecord {
  url: string;
  /** The test clock when the request arrived. */
  at: number;
  contentType: string | null;
  method: string;
  hashHex: string;
  nonce: bigint | undefined;
}

export interface FakeTsaHost {
  readonly url: string;
  readonly pki: FakePki;
  behavior: TsaBehavior;
  readonly requests: TsaRequestRecord[];
  readonly handler: (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;
}

// ---- a reader for the request, independent of the verifier ----

interface Tlv { tag: number; content: Uint8Array }

function readTlv(bytes: Uint8Array, offset: number): { node: Tlv; next: number } {
  const tag = bytes[offset] as number;
  let length = bytes[offset + 1] as number;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + (bytes[start + index] as number);
    start += count;
  }
  return { node: { tag, content: bytes.subarray(start, start + length) }, next: start + length };
}

function childrenOf(content: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < content.length) {
    const { node, next } = readTlv(content, offset);
    out.push(node);
    offset = next;
  }
  return out;
}

function integerOf(content: Uint8Array): bigint {
  let value = 0n;
  for (const byte of content) value = (value << 8n) | BigInt(byte);
  return value;
}

/** version, messageImprint (algorithm, digest), and the nonce when there is one. */
export function parseTimeStampRequest(bytes: Uint8Array): { hashHex: string; nonce: bigint | undefined } {
  const top = readTlv(bytes, 0).node;
  const parts = childrenOf(top.content);
  const imprint = childrenOf((parts[1] as Tlv).content);
  const digest = (imprint[1] as Tlv).content;
  const nonceNode = parts.slice(2).find((part) => part.tag === 0x02);
  return { hashHex: Buffer.from(digest).toString("hex"), nonce: nonceNode === undefined ? undefined : integerOf(nonceNode.content) };
}

export interface FakeTsaHostOptions {
  url: string;
  /** The PKI whose root the client trusts for this authority. */
  pki: FakePki;
  /** The test clock; a token's genTime is the clock's reading when the request arrived. */
  now: () => number;
  behavior?: TsaBehavior;
}

let imposter: FakePki | undefined;

export function fakeTsaHost(options: FakeTsaHostOptions): FakeTsaHost {
  const requests: TsaRequestRecord[] = [];
  const host: FakeTsaHost = {
    url: options.url,
    pki: options.pki,
    behavior: options.behavior ?? "grant",
    requests,
    handler: async (url, init) => {
      if (url.href !== new URL(options.url).href) return undefined;
      const body = init?.body as Uint8Array;
      const parsed = parseTimeStampRequest(body);
      const headers = new Headers(init?.headers);
      requests.push({ url: options.url, at: options.now(), contentType: headers.get("content-type"), method: init?.method ?? "GET", ...parsed });
      const reply = (bytes: Uint8Array): Response => new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "application/timestamp-reply" } });
      const pki = options.pki;
      const genTime = new Date(options.now());
      const base = { hashHex: parsed.hashHex, ...(parsed.nonce === undefined ? {} : { nonce: parsed.nonce }), genTime };
      switch (host.behavior) {
        case "hang":
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === undefined || signal === null) return;
            const abort = (): void => { reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })); };
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        case "http-500":
          return new Response("upstream failure", { status: 500 });
        case "html":
          return new Response("<html><body>Welcome to the time stamp service</body></html>", { status: 200, headers: { "content-type": "text/html" } });
        case "rejection":
          return reply(buildResponse(2));
        case "no-token":
          return reply(buildResponse(0));
        case "other-hash":
          return reply(buildResponse(0, buildToken({ signer: pki.signer, ...base, imprintHashHex: createHash("sha256").update("some other statement").digest("hex"), certificates: [pki.ca, pki.signer] })));
        case "wrong-nonce":
          return reply(buildResponse(0, buildToken({ signer: pki.signer, ...base, nonce: (parsed.nonce ?? 0n) + 1n, certificates: [pki.ca, pki.signer] })));
        case "wrong-root": {
          imposter ??= makePki("Imposter");
          return reply(buildResponse(0, buildToken({ signer: imposter.signer, ...base, certificates: [imposter.ca, imposter.signer] })));
        }
        case "no-eku": {
          const signer = makeSigner(pki.ca, "No Usage Signer", undefined, { extendedKeyUsage: { oids: [OIDS.serverAuth], critical: true } });
          return reply(buildResponse(0, buildToken({ signer, ...base, certificates: [pki.ca, signer] })));
        }
        case "ess-mismatch":
          return reply(buildResponse(0, buildToken({ signer: pki.signer, ...base, essCertificate: pki.ca.der, certificates: [pki.ca, pki.signer] })));
        case "grant":
          return reply(buildResponse(0, buildToken({ signer: pki.signer, ...base, certificates: [pki.ca, pki.signer] })));
      }
    },
  };
  return host;
}
