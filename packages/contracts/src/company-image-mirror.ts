// Company-approved extra test-service images (switch `pj`), 0.5.15: where an approved image comes from, where its mirrored copy lives, and what the worker may ask for. Pure: no clock, no network, no Node module.
//
// THE PIN IS THE PLATFORM DIGEST. A tag of a multi-architecture image resolves to an OCI index; the index lists one manifest per platform. Rovara pins the digest of the `linux/arm64` manifest the index names (the worker runs
// linux/arm64), not the index digest. Why: the broker's mirror copies exactly that manifest (and its layers) into the install's own registry, the worker pulls `<install registry>/<mirror repository>@sha256:<that digest>`,
// and Docker reports the same digest as `RepoDigests`; so the digest an admin approves, the digest the mirror verifies, and the digest the worker runs are ONE number, with no index in between to compare. The cost: a
// tag that is re-pushed with a new index but the same arm64 manifest keeps its approval (the bytes did not change), and an index that gains or changes its arm64 manifest reads as `digest_changed`, which is right.
//
// WHERE AN IMAGE MAY COME FROM. Only the registries below (and the extra registries a company admin added for that company) are ever contacted, by the HOST THIS FILE NAMES for them, never by a host taken from the typed
// name. A registry's token service and its blob redirects are held to hosts named here too.
//
// THE MIRROR. One private repository per approved image, in the install's own registry, under the saved-environment prefix (`rovara-env/<env>/o<org hash>/p<image hash>`): the creation template, the key, the immutable tags
// and the repository policy that saved environment images already have apply to it, and the same three roles reach it. The worker pulls from it with a login the broker mints for that one repository.
import { z } from "zod";
import { SavedEnvRegistryAuthSchema, isSavedEnvRepositoryName, savedEnvRepositoryPrefix } from "./saved-env-image.js";
import { sha256Hex } from "./web-hash.js";
import { OrgIdSchema } from "./org.js";

/** The platform the worker runs, and so the one platform manifest that is pinned and mirrored. */
export const COMPANY_IMAGE_PLATFORM = { os: "linux", architecture: "arm64" } as const;

export interface CompanyImageRegistryRule {
  /** The registry as an image name spells it. */
  readonly name: string;
  /** The host the registry's API is asked at. Never taken from the typed name. */
  readonly apiHost: string;
  /** The hosts a token service (`WWW-Authenticate` realm) may be at. */
  readonly authHosts: readonly string[];
  /** Blob downloads may be redirected to a host with one of these suffixes (a leading dot: a sub-domain only), over https. No other redirect is followed. */
  readonly blobHostSuffixes: readonly string[];
}

export const COMPANY_IMAGE_REGISTRIES: readonly CompanyImageRegistryRule[] = [
  { name: "docker.io", apiHost: "registry-1.docker.io", authHosts: ["auth.docker.io"], blobHostSuffixes: [".docker.com", ".docker.io", ".r2.cloudflarestorage.com", ".cloudfront.net"] },
  { name: "ghcr.io", apiHost: "ghcr.io", authHosts: ["ghcr.io"], blobHostSuffixes: [".githubusercontent.com", ".ghcr.io"] },
  { name: "quay.io", apiHost: "quay.io", authHosts: ["quay.io"], blobHostSuffixes: [".quay.io", ".cloudfront.net"] },
  { name: "public.ecr.aws", apiHost: "public.ecr.aws", authHosts: ["public.ecr.aws"], blobHostSuffixes: [".cloudfront.net", ".amazonaws.com"] },
];

/** The most extra registries one company may add. */
export const COMPANY_IMAGE_EXTRA_REGISTRIES_MAX = 8;
const DNS_HOST = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const PRIVATE_SUFFIX = /(?:^|\.)(?:local|localhost|internal|lan|home|corp|intranet|test|invalid|example|arpa)$/u;
/** Names that are another spelling of a built-in registry's host. */
const RESERVED_HOSTS: ReadonlySet<string> = new Set(["index.docker.io", "registry-1.docker.io", "registry.docker.io", "auth.docker.io", "hub.docker.com", ...COMPANY_IMAGE_REGISTRIES.map((rule) => rule.name)]);

/**
 * A registry host an admin may add: a lower-case public-looking DNS name with at least one dot and nothing else (no scheme, port, path, credentials, trailing dot, upper case or address). Returns it, or undefined.
 * Exact text only: it is never trimmed or lower-cased for the caller, so what is stored is what was checked. A built-in registry (or one of its other spellings) is not an extra.
 */
export function companyImageExtraRegistry(text: unknown): string | undefined {
  if (typeof text !== "string" || !DNS_HOST.test(text) || PRIVATE_SUFFIX.test(text) || /^[0-9.]+$/u.test(text) || text.startsWith("xn--") || text.includes(".xn--") || RESERVED_HOSTS.has(text)) return undefined;
  return text;
}

/** The extra registries of a company, each checked by `companyImageExtraRegistry`, without repeats; anything that is not a registry host is dropped (so a damaged stored list can only shrink). */
export function companyImageExtraRegistriesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list.slice(0, COMPANY_IMAGE_EXTRA_REGISTRIES_MAX * 2)) {
    const host = companyImageExtraRegistry(entry);
    if (host !== undefined && !out.includes(host)) out.push(host);
  }
  return out.slice(0, COMPANY_IMAGE_EXTRA_REGISTRIES_MAX);
}

/**
 * The rule for a registry as an image name spells it, or undefined when the registry is not allowed for this company. Exact match only: `ghcr.io.evil.example`, `GHCR.IO`, `ghcr.io:443`, `ghcr.io.` and `user@ghcr.io` are
 * all different text and match nothing. An extra registry is asked at its own host, its token service must be that host, and a blob redirect is not followed (nothing is allowed to send a download elsewhere).
 */
export function companyImageRegistryRule(registry: string, extra: readonly string[] = []): CompanyImageRegistryRule | undefined {
  const builtIn = COMPANY_IMAGE_REGISTRIES.find((rule) => rule.name === registry);
  if (builtIn !== undefined) return builtIn;
  const host = companyImageExtraRegistry(registry);
  if (host === undefined || !extra.includes(host)) return undefined;
  return { name: host, apiHost: host, authHosts: [host], blobHostSuffixes: [] };
}

// ---- the mirror's names

export const COMPANY_IMAGE_LOGIN_PATH = "company-image-login" as const;
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const ImageId = z.string().regex(/^img_[a-f0-9]{20}$/u);

/**
 * The mirror repository of one approved image of one company: `rovara-env/<env>/o<hash of the org>/p<hash of the org and the image id>`. The same shape as a saved environment's repository (so the creation template, the key,
 * the repository policy and the three fixed roles apply), under a hash domain of its own, so it can never be a project's repository. Throws on text that is not an org id or an image id.
 */
export function companyImageRepositoryName(input: { env: string; orgId: string; imageId: string }): string {
  const org = OrgIdSchema.parse(input.orgId);
  const image = ImageId.parse(input.imageId);
  const orgHash = sha256Hex(`rovara.saved-env.org\u0000${org}`).slice(0, 32);
  const imageHash = sha256Hex(`rovara.company-image.repository\u0000${org}\u0000${image}`).slice(0, 32);
  return `${savedEnvRepositoryPrefix(input.env)}/o${orgHash}/p${imageHash}`;
}

/** The tag the mirror gives the one image of a repository (a tagged image is not expired by the template's untagged rule; the digest, not the tag, is what anyone pulls). */
export const companyImageMirrorTag = (digest: string): string => `d-${Hex64.parse(digest)}`;

/** How long a pull login for a mirrored image lives, and how many a run may ask for. */
export const COMPANY_IMAGE_LOGIN_MAX_PER_OPERATION = 8;

export const CompanyImageLoginRequestSchema = z.object({ imageId: ImageId }).strict();
export type CompanyImageLoginRequest = z.infer<typeof CompanyImageLoginRequestSchema>;
export const CompanyImageLoginReplySchema = z.object({ login: SavedEnvRegistryAuthSchema }).strict();

/** The mirror's address inside a plan: the repository (a saved-environment-shaped name) and the platform digest it holds. */
export const CompanyImageMirrorRefSchema = z.object({ repository: z.string().refine(isSavedEnvRepositoryName, "a mirror repository name"), digest: Hex64 }).strict();
export type CompanyImageMirrorRef = z.infer<typeof CompanyImageMirrorRefSchema>;

// ---- the mirror job and its state

export const COMPANY_IMAGE_MIRROR_FAILURES = ["registry_not_allowed", "not_found", "digest_mismatch", "no_arm64", "too_large", "unsupported", "unavailable", "timeout"] as const;
export type CompanyImageMirrorFailure = (typeof COMPANY_IMAGE_MIRROR_FAILURES)[number];

const RegistryText = z.string().min(4).max(253);
export const CompanyImageMirrorJobSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("copy"), orgId: OrgIdSchema, imageId: ImageId, cycle: z.string().regex(/^[a-f0-9]{16}$/u), registry: RegistryText, repository: z.string().min(1).max(250), digest: Hex64,
    /** The company's extra registries as they were when the image was approved. */
    extraRegistries: z.array(RegistryText).max(COMPANY_IMAGE_EXTRA_REGISTRIES_MAX),
  }).strict(),
  z.object({ action: z.literal("delete"), orgId: OrgIdSchema, imageId: ImageId }).strict(),
]);
export type CompanyImageMirrorJob = z.infer<typeof CompanyImageMirrorJobSchema>;

export const CompanyImageMirrorStateSchema = z.object({
  state: z.enum(["copying", "ready", "failed"]),
  /** The approved (platform) digest this state is for: a state for another digest says nothing about this one (an image id names its digest, so a state is never read for another). */
  digest: Hex64,
  repository: z.string().refine(isSavedEnvRepositoryName, "a mirror repository name"),
  reason: z.enum(COMPANY_IMAGE_MIRROR_FAILURES).optional(),
  attempts: z.number().int().min(0).max(1000),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type CompanyImageMirrorState = z.infer<typeof CompanyImageMirrorStateSchema>;

/** A failed copy is tried again no sooner than this (a plan or an approval may ask sooner; the copier refuses), and a copy that has been `copying` this long is taken to have died. */
export const COMPANY_IMAGE_MIRROR_RETRY_MS = 10 * 60_000;
export const COMPANY_IMAGE_MIRROR_STALE_MS = 20 * 60_000;

/** The state table partition of a company's mirror rows. A partition of its own, so the mirror function's role may write it and nothing else (IAM limits a writer by partition key). */
export const companyImageMirrorPartition = (orgId: string): string => `COMPANY_IMAGE_MIRROR#${OrgIdSchema.parse(orgId)}`;
