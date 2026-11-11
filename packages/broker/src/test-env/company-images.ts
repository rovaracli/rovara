// Company-approved extra test-service images (switch `pj`): the pure part. Rovara's signed catalog stays the default allow set; a company admin may approve any OTHER image once, and an image is served when it is
// in the signed catalog OR on the company's approved list with the exact digest the admin approved. Nothing here reads a store, a clock or a network: the approvals, the catalog and the digest are parameters.
//
//   - A reference is read the way Docker reads it (`postgres:18` is `docker.io/library/postgres:18`) and only the plain form is accepted: lower-case names, a version tag, no digest, no credentials, no port, a public DNS
//     host. The broker looks the digest up itself (`company-image-resolver.ts`); a person never types one, so an approval can only pin what Rovara resolved and the admin read on the card.
//   - The run profile is NEVER the image's, the repository's or the admin's: an approved image runs with the profile of the signed catalog's entry for its family (user, memory, processes, tmpfs, ports, health check, reset,
//     connection variables). An image whose family has no such entry cannot be approved, so approving an image adds a digest, never a rule.
//   - An approval is of one exact digest. Its id (`img_` and the first 20 hex of the sha256 of `registry/repository@sha256:<digest>`) names the digest too, so the same name at another digest is another image that needs its
//     own approval, and the old approval never serves it (`digest_changed`).
import { catalogEntryById, catalogPrepullList, OrgIdSchema, type CatalogEntry, type OrgId, type VerifiedCatalog } from "@agentx/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

// ---- reading a reference

export const COMPANY_IMAGE_REFERENCE_MAX = 300;
export const COMPANY_IMAGE_DEFAULT_REGISTRY = "docker.io";
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
/** A public DNS name: labels of letters, digits and hyphens with at least one dot, no port, never an address. */
const DNS_HOST = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const PRIVATE_SUFFIX = /(?:^|\.)(?:local|localhost|internal|lan|home|corp|intranet|test|invalid|example)$/u;

export interface CompanyImageName {
  /** The registry host. `docker.io` for a name with no host; `index.docker.io` and `registry-1.docker.io` are `docker.io`. */
  registry: string;
  /** The repository path; a Docker Hub name with no `/` is under `library/`. */
  repository: string;
  tag: string;
}

export const COMPANY_IMAGE_READ_REFUSALS = ["not_a_reference", "has_digest", "no_tag", "no_version"] as const;
export type CompanyImageReadRefusal = (typeof COMPANY_IMAGE_READ_REFUSALS)[number];
export const COMPANY_IMAGE_READ_WORDS: Record<CompanyImageReadRefusal, string> = {
  not_a_reference: "That is not an image name Rovara can read. Use a plain lower-case name from a public registry, such as postgres:18.",
  has_digest: "Name the image with a version tag such as postgres:18. Rovara looks up the digest itself and pins it when an admin approves it.",
  no_tag: "Name the image with a version tag such as postgres:18. A name with no tag changes under you.",
  no_version: "The tag has to start with a version number, such as 18 or 7.2, so Rovara knows which version it is.",
};

const isAddressLike = (host: string): boolean => /^[0-9.]+$/u.test(host) || host.includes(":") || host.includes("[");

/** The image as Docker reads it, or the reason it is not a plain reference. A first part is a registry host only when it holds a `.` or a `:` or is `localhost` (Docker's own rule). */
export function readCompanyImage(text: unknown): { ok: true; image: CompanyImageName; family: string; major: string } | { ok: false; reason: CompanyImageReadRefusal } {
  // eslint-disable-next-line no-control-regex -- a reference is one line of plain text
  if (typeof text !== "string" || text.length === 0 || text.length > COMPANY_IMAGE_REFERENCE_MAX || /[\s\u0000-\u001f\u007f]/u.test(text)) return { ok: false, reason: "not_a_reference" };
  if (text.includes("@")) return { ok: false, reason: "has_digest" };
  const parts = text.split("/");
  let registry = COMPANY_IMAGE_DEFAULT_REGISTRY;
  if (parts.length > 1 && (parts[0]!.includes(".") || parts[0]!.includes(":") || parts[0] === "localhost")) registry = parts.shift()!;
  if (registry === "index.docker.io" || registry === "registry-1.docker.io") registry = COMPANY_IMAGE_DEFAULT_REGISTRY;
  const last = parts.length - 1;
  const colon = parts[last]!.lastIndexOf(":");
  if (colon < 0) return { ok: false, reason: parts.every((part) => PATH_COMPONENT.test(part)) ? "no_tag" : "not_a_reference" };
  const tag = parts[last]!.slice(colon + 1);
  parts[last] = parts[last]!.slice(0, colon);
  if (!TAG.test(tag) || parts.some((part) => !PATH_COMPONENT.test(part))) return { ok: false, reason: "not_a_reference" };
  if (!DNS_HOST.test(registry) || isAddressLike(registry) || PRIVATE_SUFFIX.test(registry)) return { ok: false, reason: "not_a_reference" };
  if (registry === COMPANY_IMAGE_DEFAULT_REGISTRY && parts.length === 1) parts.unshift("library");
  const repository = parts.join("/");
  if (registry.length + repository.length > 250) return { ok: false, reason: "not_a_reference" };
  const major = /^v?(\d{1,3})(?:[.-]|$)/u.exec(tag)?.[1];
  if (major === undefined) return { ok: false, reason: "no_version" };
  // Valkey is Redis's fork and runs as Redis does (the catalog files both under `redis`).
  const lastName = repository.split("/").at(-1)!;
  const family = lastName === "valkey" ? "redis" : lastName;
  if (!/^[a-z][a-z0-9-]{0,39}$/u.test(family)) return { ok: false, reason: "not_a_reference" };
  return { ok: true, image: { registry, repository, tag }, family, major };
}

/** `registry/repository`: the name an image has with no tag or digest. */
export const companyImageName = (image: Pick<CompanyImageName, "registry" | "repository">): string => `${image.registry}/${image.repository}`;

/** The image as a person reads it: `postgres:18 from Docker Hub` (an official Docker Hub image loses its `library/`). */
export function describeCompanyImage(image: CompanyImageName): string {
  const name = image.registry === COMPANY_IMAGE_DEFAULT_REGISTRY && image.repository.startsWith("library/") ? image.repository.slice("library/".length) : image.repository;
  return `${name}:${image.tag} from ${image.registry === COMPANY_IMAGE_DEFAULT_REGISTRY ? "Docker Hub" : image.registry}`;
}

// ---- the stored approval

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
export const CompanyImageIdSchema = z.string().regex(/^img_[a-f0-9]{20}$/u);

/** The id of one image at one digest. It names the digest, so another digest is another id. */
export const companyImageIdOf = (image: Pick<CompanyImageName, "registry" | "repository">, digest: string): string =>
  `img_${createHash("sha256").update(`${companyImageName(image)}@sha256:${Hex64.parse(digest)}`, "utf8").digest("hex").slice(0, 20)}`;

export const CompanyImageSchema = z.object({
  orgId: OrgIdSchema,
  imageId: CompanyImageIdSchema,
  revision: z.number().int().min(1),
  /** `proposed` waits for an admin; `approved` may be served. A revoked image has no row. */
  status: z.enum(["proposed", "approved"]),
  registry: z.string().max(253),
  repository: z.string().max(250),
  /** What was asked for and looked up (shown only: the digest is the pin). */
  tag: z.string().max(128),
  /** The 64 hex characters of the digest the registry gave for the tag when the image was proposed. This is what an admin approves and what runs. */
  digest: Hex64,
  family: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  version: z.string().regex(/^\d{1,3}$/u),
  origin: z.enum(["admin", "setup"]),
  /**
   * Random per proposal. A revoked image has no row, so the same image proposed again starts at revision 1 again; the cycle keeps that proposal's audit events apart from the earlier one's (an event id is made from the
   * action and the occurrence, and the ledger drops a repeated id as a duplicate).
   */
  cycle: z.string().regex(/^[a-f0-9]{16}$/u),
  proposedBy: z.string().min(1).max(100),
  proposedAt: z.string().datetime(),
  /** The project whose setup asked for it (shown only). */
  project: z.string().max(128).optional(),
  approvedBy: z.string().min(1).max(100).optional(),
  approvedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((image, context) => {
  if (image.imageId !== companyImageIdOf(image, image.digest)) context.addIssue({ code: "custom", path: ["imageId"], message: "the id is the image's own" });
  if ((image.status === "approved") !== (image.approvedBy !== undefined && image.approvedAt !== undefined)) context.addIssue({ code: "custom", path: ["status"], message: "an approved image says who approved it and when" });
});
export type CompanyImage = z.infer<typeof CompanyImageSchema>;

/** A company holds this many live images (waiting and approved) at most, and this many may wait at once. */
export const COMPANY_IMAGES_MAX = 50;
export const COMPANY_IMAGES_MAX_WAITING = 20;

// ---- what an image runs with

/**
 * The catalog entry whose run profile an approved image of this family runs with: a live, pinned, pre-pulled real-software entry of the family, offered in the edition; the one of the image's major version when there is
 * one, else the default, else the highest version. Undefined when the signed catalog has no such entry (the image then has no safe profile and cannot be approved or served).
 */
export function profileEntryOf(catalog: VerifiedCatalog, family: string, major: string, edition: "public" | "enterprise"): CatalogEntry | undefined {
  let ready: Set<string>;
  try { ready = new Set(catalogPrepullList(catalog).images.map((image) => image.id)); } catch { return undefined; }
  const live = catalog.entries.filter((entry) => entry.backing === "local" && entry.family === family && entry.status !== "retired" && entry.image.digest !== undefined && entry.editions.includes(edition) && ready.has(entry.id));
  if (!catalog.pinned || live.length === 0) return undefined;
  const sameMajor = live.filter((entry) => entry.version === major || entry.version.startsWith(`${major}.`));
  const pool = sameMajor.length > 0 ? sameMajor : live;
  return [...pool].sort((a, b) => Number(b.status === "default") - Number(a.status === "default") || (Number(b.version.split(".")[0]) || 0) - (Number(a.version.split(".")[0]) || 0) || (a.id < b.id ? -1 : 1))[0];
}

// ---- the one decision: is this image served?

export const COMPANY_IMAGE_REFUSALS = ["no_catalog", "not_in_catalog", "not_approved", "digest_changed", "no_profile"] as const;
export type CompanyImageRefusal = (typeof COMPANY_IMAGE_REFUSALS)[number];
/** Fixed words: no image name, digest or error text of any kind. */
export const COMPANY_IMAGE_REFUSAL_WORDS: Record<CompanyImageRefusal, string> = {
  no_catalog: "The service images this run needs could not be checked, so its test services were not started.",
  not_in_catalog: "A test service this project asks for is not in Rovara's image list.",
  not_approved: "An image this project asks for has not been approved by a company admin.",
  digest_changed: "An image this project asks for has changed since an admin approved it. An admin has to approve it again.",
  no_profile: "An image this project asks for has no safe way to run yet, because Rovara's image list has nothing for its kind of service.",
};

export type ImageRequest =
  /** An image of Rovara's signed catalog, by its catalog id. */
  | { catalogId: string }
  /** An approved image, by its id (what a dependency names). `digest`, when given, is the digest the caller expects it to run. */
  | { imageId: string; digest?: string | undefined }
  /** An image by name and the digest a registry gave for it NOW (a tag that moved is a different digest). */
  | { name: string; digest: string };

export type ImageServed =
  | { ok: true; source: "catalog"; catalogId: string; digest: string }
  | { ok: true; source: "company"; image: CompanyImage; profile: CatalogEntry; digest: string }
  | { ok: false; reason: CompanyImageRefusal };

const refused = (reason: CompanyImageRefusal): ImageServed => ({ ok: false, reason });

/**
 * Whether an image is served: it is in the signed catalog (live, pinned, offered in the edition, pre-pulled), OR it is on the company's approved list with exactly the digest an admin approved, and the signed catalog has a
 * run profile for its family. A waiting proposal is not approved. Never throws; every doubt is a refusal.
 */
export function serviceImageServed(input: { catalog: VerifiedCatalog | undefined; edition: "public" | "enterprise"; approved: readonly CompanyImage[]; request: ImageRequest }): ImageServed {
  try {
    const { catalog, request } = input;
    if (catalog === undefined) return refused("no_catalog");
    if ("catalogId" in request) {
      const entry = catalogEntryById(catalog, request.catalogId);
      if (entry === undefined || entry.status === "retired" || entry.image.digest === undefined || !catalog.pinned || !entry.editions.includes(input.edition)) return refused("not_in_catalog");
      if (!catalogPrepullList(catalog).images.some((image) => image.id === entry.id)) return refused("not_in_catalog");
      return { ok: true, source: "catalog", catalogId: entry.id, digest: entry.image.digest };
    }
    const live = input.approved.filter((image) => image.status === "approved");
    let found: CompanyImage | undefined;
    if ("imageId" in request) {
      found = live.find((image) => image.imageId === request.imageId);
      if (found === undefined) return refused("not_approved");
      if (request.digest !== undefined && request.digest !== found.digest) return refused("digest_changed");
    } else {
      const sameName = live.filter((image) => companyImageName(image) === request.name);
      found = sameName.find((image) => image.digest === request.digest);
      if (found === undefined) return refused(sameName.length > 0 ? "digest_changed" : "not_approved");
    }
    const profile = profileEntryOf(catalog, found.family, found.version, input.edition);
    if (profile === undefined) return refused("no_profile");
    return { ok: true, source: "company", image: found, profile, digest: found.digest };
  } catch {
    return refused("not_approved");
  }
}

/**
 * Where an image a project asks for stands, for the card an admin sees: `catalog` (Rovara's list already has software of that kind and version, so no approval is needed), `approved` (the company approved this exact digest),
 * `changed` (the company approved this name at another digest), or `none` (it needs an admin's approval). Pure.
 */
export function companyImageStanding(input: { catalog: VerifiedCatalog; edition: "public" | "enterprise"; approved: readonly CompanyImage[]; family: string; major: string; name: string; digest: string }): "catalog" | "approved" | "changed" | "none" {
  // Rovara's list holds Rovara's own images. A name is "the same software" only when it is the official upstream one (Docker Hub's `library/` images, and Valkey's own); the same kind from any other publisher is another image.
  if (!isOfficialUpstream(input.name)) return companyStandingOf(input);
  const live = input.catalog.entries.some((entry) => entry.backing === "local" && entry.family === input.family && entry.status !== "retired" && entry.editions.includes(input.edition) && entry.image.digest !== undefined && (entry.version === input.major || entry.version.startsWith(`${input.major}.`)));
  if (live) return "catalog";
  return companyStandingOf(input);
}

/** Docker Hub's official images (`docker.io/library/<name>`) and Valkey's own image: the upstream the catalog's software of that kind comes from. */
export const isOfficialUpstream = (name: string): boolean => name.startsWith("docker.io/library/") || name === "docker.io/valkey/valkey";

/** The standing of a name that Rovara's list does not cover: approved at this digest, approved at another one, or not approved. */
function companyStandingOf(input: { catalog: VerifiedCatalog; edition: "public" | "enterprise"; approved: readonly CompanyImage[]; name: string; digest: string }): "approved" | "changed" | "none" {
  const served = serviceImageServed({ catalog: input.catalog, edition: input.edition, approved: input.approved, request: { name: input.name, digest: input.digest } });
  if (served.ok) return "approved";
  return served.reason === "digest_changed" ? "changed" : "none";
}

/** Only a company's own rows count: a row of another company, or a row that does not parse, is never an approval. */
export function companyImagesOf(rows: readonly unknown[], orgId: OrgId): CompanyImage[] {
  return rows.flatMap((row) => {
    const parsed = CompanyImageSchema.safeParse(row);
    return parsed.success && parsed.data.orgId === orgId ? [parsed.data] : [];
  });
}
