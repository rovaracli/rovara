// Company-approved extra test-service images (switch `pj`): who may do what. Rovara's signed catalog stays the default allow set; this is how a company admin approves any OTHER image once (see test-env/company-images.ts).
//
//   - PROPOSING changes nothing that runs. An admin adds an image by name, or a project's setup (the compose or dev container reader, the setup agent) names one that is in neither list; Rovara looks up the digest of the
//     tag itself (`resolveDigest`) and stores a WAITING row. A name Rovara's list already covers is never proposed, and one an admin already approved at the same digest is left alone.
//   - APPROVING is a live company owner or admin, from a live browser session, with a sign-in in the last 10 minutes (`requireFreshAdmin`, read from the stored session, never from the request). It is pinned to the exact
//     revision and digest the admin saw on the card, and the signed catalog must have a run profile for the image's family at that moment. Each approval is one transaction with its audit event.
//   - REVOKING (or dismissing a waiting image) needs a live admin in a browser session; a safety action stays easy. It removes the row and is audited. A revoked image is served no more.
// Nothing here returns a name, a digest or an error text of a registry: answers are ids, fixed words and the image the admin must read to approve it.
import { OrgIdSchema, agentXError, type OrgId, type VerifiedCatalog } from "@agentx/contracts";
import { isFreshSignIn } from "../developer/store.js";
import {
  COMPANY_IMAGES_MAX, COMPANY_IMAGES_MAX_WAITING, COMPANY_IMAGE_READ_WORDS, CompanyImageIdSchema, companyImageIdOf, companyImageStanding, profileEntryOf, readCompanyImage,
  type CompanyImage,
} from "../test-env/company-images.js";
import type { CompanyImageDigestResolver } from "../test-env/company-image-resolver.js";

export type CompanyImageAuditAction = "company_image.proposed" | "company_image.approved" | "company_image.revoked";
export interface CompanyImageAuditEntry {
  orgId: OrgId; action: CompanyImageAuditAction; actor: string; at: string; imageId: string; revision: number; digest: string;
  authority: "fresh_sign_in" | "live_admin" | "project_setup";
  /** The image as a person reads it: it goes in the event's `details`, never in a fact. */
  image: string;
}

/** The store. An adapter must commit the row, the live and waiting counters and the audit event in ONE transaction, conditional on the revision read (null: no row yet); `false` when the condition fails (the caller then says CHANGE_STALE). */
export interface CompanyImageStore {
  get(orgId: OrgId, imageId: string): Promise<CompanyImage | undefined>;
  /** The company's live rows (waiting and approved). */
  list(orgId: OrgId): Promise<CompanyImage[]>;
  commit(next: CompanyImage, expectedRevision: number | null, entry: CompanyImageAuditEntry): Promise<boolean>;
  /** Removes the row at the revision read (a revoke or a dismissal). */
  remove(current: CompanyImage, entry: CompanyImageAuditEntry): Promise<boolean>;
}

export interface CompanyImageCaller { orgId: OrgId; developerId: string; sessionId?: string | undefined }

export interface CompanyImageDeps {
  store: CompanyImageStore;
  requireAdmin(caller: { orgId: OrgId; developerId: string }): Promise<void>;
  readSession(sessionId: string): Promise<{ authTime?: string; developerId: string; revokedAt?: string } | undefined>;
  resolveDigest: CompanyImageDigestResolver;
  /** The release's signed catalog, or undefined when it could not be read. */
  catalog(): Promise<VerifiedCatalog | undefined>;
  edition: "public" | "enterprise";
  now(): Date;
}

const DeveloperIdPattern = /^[a-f0-9]{64}$/u;
const forbidden = () => agentXError("FORBIDDEN", "Live company owner or admin access is required.");
const reauth = () => agentXError("REAUTH_REQUIRED", "Sign in again to confirm this company change.");
const stale = () => agentXError("CHANGE_STALE", "That image changed. Refresh before continuing.");
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);
const notFound = () => agentXError("NOT_FOUND", "That image was not found.");

export const COMPANY_IMAGE_WORDS = {
  covered: "Rovara's image list already has this kind of service at this version, so it needs no approval.",
  noCatalog: "Rovara's image list could not be read, so no image can be approved right now.",
  noProfile: "Rovara has no safe way to run this kind of service yet, so it cannot be approved. Rovara can approve images of the kinds in its own image list.",
  noDigest: "Rovara could not look this image up in its registry, so nothing was proposed. Check the name and that the registry is public.",
  tooManyWaiting: "Too many images are waiting for approval. Approve or dismiss some first.",
  tooMany: "The company has reached its limit of approved and waiting images. Revoke one first.",
} as const;

function validCaller(caller: CompanyImageCaller): void {
  if (!OrgIdSchema.safeParse(caller.orgId).success || !DeveloperIdPattern.test(caller.developerId)) throw forbidden();
}

/** Admin now, then a stored session of the SAME person, not revoked, whose interactive sign-in is fresh by the platform's one rule. The admin check comes first and reads nothing else. */
export async function requireFreshAdmin(deps: Pick<CompanyImageDeps, "requireAdmin" | "readSession" | "now">, caller: CompanyImageCaller): Promise<void> {
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
  const session = typeof caller.sessionId === "string" && caller.sessionId.length > 0 && caller.sessionId.length <= 200 ? await deps.readSession(caller.sessionId) : undefined;
  if (session === undefined || session.developerId !== caller.developerId || session.revokedAt !== undefined || !isFreshSignIn(session, deps.now().getTime())) throw reauth();
}

const entryOf = (action: CompanyImageAuditEntry["action"], authority: CompanyImageAuditEntry["authority"], actor: string, image: CompanyImage, at: string): CompanyImageAuditEntry => ({
  orgId: image.orgId, action, actor, at, imageId: image.imageId, revision: image.revision, digest: image.digest, authority, image: `${image.registry}/${image.repository}:${image.tag}`,
});

/** The outcome of proposing one name. `covered` and `approved` need nothing more; `waiting` is on the admin's page. */
export type ProposeOutcome = { status: "waiting" | "approved" | "covered"; imageId?: string } | { status: "refused"; reason: "not_a_reference" | "has_digest" | "no_tag" | "no_version" | "no_catalog" | "no_profile" | "no_digest" | "too_many" };

async function propose(deps: CompanyImageDeps, input: { orgId: OrgId; actor: string; reference: unknown; origin: CompanyImage["origin"]; authority: CompanyImageAuditEntry["authority"]; project?: string }): Promise<ProposeOutcome> {
  const read = readCompanyImage(input.reference);
  if (!read.ok) return { status: "refused", reason: read.reason };
  const catalog = await Promise.resolve(deps.catalog()).catch(() => undefined);
  if (catalog === undefined) return { status: "refused", reason: "no_catalog" };
  // An image whose kind Rovara's list has no run profile for can never be served, so it is not worth an admin's attention.
  if (profileEntryOf(catalog, read.family, read.major, deps.edition) === undefined) return { status: "refused", reason: "no_profile" };
  const digest = await Promise.resolve(deps.resolveDigest(read.image)).catch(() => undefined);
  if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) return { status: "refused", reason: "no_digest" };
  const existing = await deps.store.list(input.orgId);
  const name = `${read.image.registry}/${read.image.repository}`;
  const standing = companyImageStanding({ catalog, edition: deps.edition, approved: existing, family: read.family, major: read.major, name, digest });
  if (standing === "catalog") return { status: "covered" };
  if (standing === "approved") return { status: "approved", imageId: companyImageIdOf(read.image, digest) };
  const imageId = companyImageIdOf(read.image, digest);
  if (existing.some((image) => image.imageId === imageId)) return { status: "waiting", imageId };
  if (existing.length >= COMPANY_IMAGES_MAX) return { status: "refused", reason: "too_many" };
  if (existing.filter((image) => image.status === "proposed").length >= COMPANY_IMAGES_MAX_WAITING) return { status: "refused", reason: "too_many" };
  const at = deps.now().toISOString();
  const next: CompanyImage = {
    orgId: input.orgId, imageId, revision: 1, status: "proposed", registry: read.image.registry, repository: read.image.repository, tag: read.image.tag, digest, family: read.family, version: read.major,
    origin: input.origin, proposedBy: input.actor, proposedAt: at, updatedAt: at, ...(input.project === undefined ? {} : { project: input.project.slice(0, 128) }),
  };
  // A cancelled create is a race with the same image (or a full counter): the row that won is what the admin sees.
  if (!await deps.store.commit(next, null, entryOf("company_image.proposed", input.authority, input.actor, next, at))) {
    return (await deps.store.get(input.orgId, imageId)) === undefined ? { status: "refused", reason: "too_many" } : { status: "waiting", imageId };
  }
  return { status: "waiting", imageId };
}

const REFUSAL_WORDS: Record<Extract<ProposeOutcome, { status: "refused" }>["reason"], string> = {
  ...COMPANY_IMAGE_READ_WORDS, no_catalog: COMPANY_IMAGE_WORDS.noCatalog, no_profile: COMPANY_IMAGE_WORDS.noProfile, no_digest: COMPANY_IMAGE_WORDS.noDigest, too_many: COMPANY_IMAGE_WORDS.tooMany,
};

/** An admin names an image. It waits for approval: nothing runs. A live admin is enough (no sign-in time: a proposal changes nothing that runs). */
export async function proposeImageAsAdmin(deps: CompanyImageDeps, caller: CompanyImageCaller, input: { image: unknown }): Promise<ProposeOutcome & { words?: string }> {
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
  const outcome = await propose(deps, { orgId: caller.orgId, actor: caller.developerId, reference: input.image, origin: "admin", authority: "live_admin" });
  if (outcome.status === "refused") throw invalid(REFUSAL_WORDS[outcome.reason]);
  return outcome.status === "covered" ? { ...outcome, words: COMPANY_IMAGE_WORDS.covered } : outcome;
}

/**
 * The setup flow names images (the compose reader, the dev container reader, the setup agent): each that is in neither list becomes a waiting row for the admins' page, on behalf of the project's maintainer. Nothing
 * runs. Returns one outcome per name, at most 8 names, and never throws: a lookup that fails is a `refused` outcome, so setup is never held up by it. `project` is shown on the card.
 */
export async function proposeImagesFromSetup(deps: CompanyImageDeps, input: { orgId: OrgId; developerId: string; project: string; images: readonly unknown[] }): Promise<ProposeOutcome[]> {
  if (!OrgIdSchema.safeParse(input.orgId).success || !DeveloperIdPattern.test(input.developerId)) return [];
  const outcomes: ProposeOutcome[] = [];
  for (const reference of input.images.slice(0, 8)) {
    outcomes.push(await propose(deps, { orgId: input.orgId, actor: input.developerId, reference, origin: "setup", authority: "project_setup", project: input.project }).catch((): ProposeOutcome => ({ status: "refused", reason: "no_digest" })));
  }
  return outcomes;
}

async function load(deps: CompanyImageDeps, caller: CompanyImageCaller, imageId: string): Promise<CompanyImage> {
  if (!CompanyImageIdSchema.safeParse(imageId).success) throw notFound();
  const row = await deps.store.get(caller.orgId, imageId);
  if (row === undefined) throw notFound();
  return row;
}

/** Approves exactly the revision and digest the admin saw. A live admin with a sign-in in the last 10 minutes; the signed catalog must still have a run profile for the image's family. */
export async function approveImage(deps: CompanyImageDeps, caller: CompanyImageCaller, input: { imageId: string; expectedRevision: number; expectedDigest: string }): Promise<CompanyImage> {
  await requireFreshAdmin(deps, caller);
  const current = await load(deps, caller, input.imageId);
  if (current.revision !== input.expectedRevision || current.digest !== input.expectedDigest) throw stale();
  if (current.status === "approved") return current;
  const catalog = await Promise.resolve(deps.catalog()).catch(() => undefined);
  if (catalog === undefined) throw invalid(COMPANY_IMAGE_WORDS.noCatalog);
  if (profileEntryOf(catalog, current.family, current.version, deps.edition) === undefined) throw invalid(COMPANY_IMAGE_WORDS.noProfile);
  const at = deps.now().toISOString();
  const next: CompanyImage = { ...current, status: "approved", revision: current.revision + 1, approvedBy: caller.developerId, approvedAt: at, updatedAt: at };
  if (!await deps.store.commit(next, current.revision, entryOf("company_image.approved", "fresh_sign_in", caller.developerId, next, at))) throw stale();
  return next;
}

/** Revokes an approved image, or dismisses a waiting one. A live admin; the row is removed and the change is audited. A revoked image is served no more. */
export async function revokeImage(deps: CompanyImageDeps, caller: CompanyImageCaller, input: { imageId: string; expectedRevision: number }): Promise<void> {
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
  const current = await load(deps, caller, input.imageId);
  if (current.revision !== input.expectedRevision) throw stale();
  const at = deps.now().toISOString();
  if (!await deps.store.remove(current, entryOf("company_image.revoked", "live_admin", caller.developerId, { ...current, revision: current.revision + 1 }, at))) throw stale();
}

/** The company's live images, for the admin's page and for planning a run. A live admin for the page; `readCompanyImages` below is for the broker's own planning. */
export async function listImages(deps: CompanyImageDeps, caller: CompanyImageCaller): Promise<CompanyImage[]> {
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
  return deps.store.list(caller.orgId);
}
