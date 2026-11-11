// Company-approved extra test-service images (switches `tx` and `pj`): the admin's routes. Rovara's signed catalog stays the default allow set; an admin approves any other image once, here. With either switch off every path
// falls through as any unknown path.
//   GET   /v1/app/org/test-images    a live company owner or admin (a browser, or the API: reading is open to both): the company's waiting and approved images, with the digest each pins, and the kinds of service Rovara can run.
//   POST  /v1/app/org/test-images    a live company owner or admin, from a LIVE BROWSER SESSION (a token or the API is refused here and before this in the entry file):
//           { action: "add", image }                                         name an image (`postgres:18`); Rovara looks the digest up and it WAITS: nothing runs;
//           { action: "approve", imageId, expectedRevision, expectedDigest } approve exactly the digest the card showed: needs a sign-in within the last 10 minutes;
//           { action: "revoke", imageId, expectedRevision }                  revoke an approved image, or dismiss a waiting one.
// The authority is `org/company-test-images.ts` (fresh sign-in read from the stored session, audited in the write's own transaction); this file builds its dependencies. Answers are ids, digests, fixed words and the image an
// admin must read to approve it; never an error text from a registry.
import { z } from "zod";
import { EDITION_ENV_VAR, agentXError, type OrgId } from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { requireLiveCompanyAdmin } from "../../org/company-authority.js";
import { dynamoCompanyImageStore } from "../../org/company-test-image-store.js";
import { approveImage, listImages, proposeImageAsAdmin, revokeImage, type CompanyImageCaller, type CompanyImageDeps } from "../../org/company-test-images.js";
import { COMPANY_IMAGE_DEFAULT_REGISTRY, isOfficialUpstream, type CompanyImage } from "../../test-env/company-images.js";
import { registryDigestResolver, type CompanyImageDigestResolver } from "../../test-env/company-image-resolver.js";
import { projectImagesEnabled, testServicesEnabled } from "../../test-env/test-services-switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { getSignIn } from "./authentication.js";
import { bodyError, signInStoreOf } from "./common.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const COMPANY_TEST_IMAGES_PATH = "/v1/app/org/test-images";
export const COMPANY_TEST_IMAGES_BROWSER_MESSAGE = "Use a live browser session to change the company's approved images.";
/** Whether the path is this file's (the entry file refuses a token for it before anything is read). */
export const isCompanyTestImagesPath = (pathname: string): boolean => pathname === COMPANY_TEST_IMAGES_PATH;
/** Both switches: the images are an extra of test services, and a project may bring its own only with `pj`. */
export const companyTestImagesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => testServicesEnabled(env) && projectImagesEnabled(env);

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Revision = z.number().int().min(1).max(999_999_999);
const ImageId = z.string().regex(/^img_[a-f0-9]{20}$/u);
const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), image: z.string().min(1).max(300) }).strict(),
  z.object({ action: z.literal("approve"), imageId: ImageId, expectedRevision: Revision, expectedDigest: Digest }).strict(),
  z.object({ action: z.literal("revoke"), imageId: ImageId, expectedRevision: Revision }).strict(),
]);

/** The digest lookup (`registryDigestResolver`, global fetch) unless a test gives one through the route's dependencies. */
const resolverOf = (deps: DeveloperRouteDependencies): CompanyImageDigestResolver => deps.companyImageResolver ?? registryDigestResolver();

/** Everything `org/company-test-images.ts` needs, built from this request's dependencies. ONE clock: the stored session's freshness and every row's time read `deps.now()`. */
export function companyImageDepsOf(deps: DeveloperRouteDependencies, env: NodeJS.ProcessEnv = process.env): CompanyImageDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "Company images are not available here.");
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  return {
    store: dynamoCompanyImageStore({ ...table, audit: deps.audit }),
    requireAdmin: (caller) => requireLiveCompanyAdmin({ ...table, signInTableName }, caller),
    async readSession(sessionId) {
      try { return await getSignIn<{ authTime?: string; developerId: string; revokedAt?: string }>(deps, `SESSION#${sessionId}`); } catch { return undefined; }
    },
    resolveDigest: resolverOf(deps),
    catalog: async () => deps.serviceCatalog?.(),
    edition: env[EDITION_ENV_VAR] === "enterprise" ? "enterprise" : "public",
    now: () => new Date(deps.now()),
  };
}

const callerOf = (caller: DeveloperCaller): CompanyImageCaller => ({ orgId: caller.orgId, developerId: caller.developerId, sessionId: caller.sessionId });

/** An image as the admin's card shows it: what it is, where it comes from, and the digest an approval pins. */
function imageView(image: CompanyImage, context: { caller: DeveloperCaller; people: ReadonlyMap<string, string> }) {
  const name = image.registry === COMPANY_IMAGE_DEFAULT_REGISTRY && image.repository.startsWith("library/") ? image.repository.slice("library/".length) : image.repository;
  return {
    imageId: image.imageId, revision: image.revision, status: image.status, image: `${name}:${image.tag}`, registry: image.registry, /** False for any image that is not a Docker Hub official one: the card then says who publishes it is for the admin to judge. */ official: isOfficialUpstream(`${image.registry}/${image.repository}`), digest: image.digest, family: image.family, version: image.version,
    origin: image.origin, ...(image.project === undefined ? {} : { project: image.project }), proposedBy: context.people.get(image.proposedBy) ?? "Unknown", proposedByYou: image.proposedBy === context.caller.developerId,
    proposedAt: image.proposedAt, ...(image.approvedAt === undefined ? {} : { approvedAt: image.approvedAt }), updatedAt: image.updatedAt,
  };
}

async function stateOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, imageDeps: CompanyImageDeps) {
  const [images, catalog] = await Promise.all([listImages(imageDeps, callerOf(caller)), Promise.resolve(imageDeps.catalog()).catch(() => undefined)]);
  const ids = [...new Set(images.map((image) => image.proposedBy))].slice(0, 100);
  // A person's name is best effort: an unknown or unreadable one is shown as "Unknown", never as an error.
  const found = ids.length === 0 ? new Map<string, unknown>() : await signInStoreOf(deps).getDevelopers(ids).catch(() => new Map<string, unknown>());
  const people = new Map(ids.map((id) => [id, (found.get(id) as { displayName?: string } | undefined)?.displayName ?? "Unknown"] as const));
  const order = { proposed: 0, approved: 1 } as const;
  const kinds = catalog === undefined ? [] : [...new Set(catalog.entries.filter((entry) => entry.backing === "local" && entry.status !== "retired").map((entry) => entry.family))].sort();
  return {
    images: images.sort((a, b) => order[a.status] - order[b.status] || (a.updatedAt < b.updatedAt ? 1 : -1)).map((image) => imageView(image, { caller, people })),
    catalogAvailable: catalog !== undefined, kinds,
  };
}

/** The reply, or undefined when a switch is off or the path is not this file's. */
export async function routeCompanyTestImages(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!companyTestImagesEnabled(env) || url.pathname !== COMPANY_TEST_IMAGES_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  const imageDeps = companyImageDepsOf(deps, env);
  const orgId: OrgId = caller.orgId;
  if (request.method === "GET") return new StatusReply(200, await stateOf(deps, caller, imageDeps));
  // Every change is a live browser session's. The entry file refuses a token before this, and so does this: a token or the API can only read.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", COMPANY_TEST_IMAGES_BROWSER_MESSAGE);
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) throw bodyError(parsed.error);
  const input = parsed.data;
  const who = callerOf(caller);
  switch (input.action) {
    case "add": await proposeImageAsAdmin(imageDeps, who, { image: input.image }); break;
    case "approve": await approveImage(imageDeps, who, input); break;
    case "revoke": await revokeImage(imageDeps, who, input); break;
  }
  logDeveloperEvent({ event: "developer.company_images_changed", orgId, action: input.action });
  return new StatusReply(200, { status: "done", ...(await stateOf(deps, caller, imageDeps)) });
}
