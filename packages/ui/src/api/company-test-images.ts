// The company's approved extra test-service images (switches `tx` and `pj` on the server: with either off every path is "not found", and the screen says so). Rovara's own image list stays the default; an admin approves any
// other image once, here, pinned to the digest Rovara looked up. Every write is sent once from the browser session: a refusal is thrown as an `ApiError` for the screen to show and is never repeated here. The server decides
// who may and what an image means; this file reads its fixed shapes (zod here, not in the browser contract entry: nothing else in the app reads them).
import { z } from "zod";
import { createApiClient } from "./client.js";
import type { AppHost } from "../host.js";

export const COMPANY_TEST_IMAGES_PATH = "/v1/app/org/test-images";
const NEVER = { retry: "never" } as const;
const line = z.string().max(500);
const Image = z.object({
  imageId: z.string(), revision: z.number().int(), status: z.enum(["proposed", "approved"]), image: line, registry: line, official: z.boolean(), copy: z.enum(["ready", "copying", "failed", "none"]), digest: z.string().regex(/^[a-f0-9]{64}$/u), family: line, version: line,
  origin: z.enum(["admin", "setup"]), project: line.optional(), proposedBy: line, proposedByYou: z.boolean(), proposedAt: z.string(), approvedAt: z.string().optional(), updatedAt: z.string(),
});
export const CompanyTestImagesStateReader = z.object({ images: z.array(Image), catalogAvailable: z.boolean(), kinds: z.array(line), registries: z.object({ revision: z.number().int().min(0), hosts: z.array(line).max(8) }) });
export type CompanyTestImagesState = z.infer<typeof CompanyTestImagesStateReader>;
export type CompanyTestImage = CompanyTestImagesState["images"][number];
const Done = z.object({ status: z.literal("done") }).passthrough();

export function createCompanyTestImagesApi(host: AppHost) {
 const api = createApiClient(host);
 const post = async (body: unknown) => { const sent = await api.send("POST", COMPANY_TEST_IMAGES_PATH, body, Done, NEVER); if (sent.kind !== "done") throw new Error("unreadable"); };
 return {
  list: (): Promise<CompanyTestImagesState> => api.get(COMPANY_TEST_IMAGES_PATH, CompanyTestImagesStateReader),
  /** Names an image (`postgres:18`). Rovara looks the digest up and the image waits for approval: nothing runs. */
  add: (image: string) => post({ action: "add", image }),
  /** Approves exactly the revision and digest the admin saw; the server answers CHANGE_STALE if either moved. Needs a sign-in within the last 10 minutes. */
  approve: (image: CompanyTestImage) => post({ action: "approve", imageId: image.imageId, expectedRevision: image.revision, expectedDigest: image.digest }),
  /** Revokes an approved image, or dismisses a waiting one. */
  revoke: (image: CompanyTestImage) => post({ action: "revoke", imageId: image.imageId, expectedRevision: image.revision }),
  /** Adds a registry host to the company's own list (an admin, fresh sign-in, audited); `revision` is the list's revision the admin saw. */
  addRegistry: (host: string, revision: number) => post({ action: "add_registry", host, expectedRevision: revision }),
  removeRegistry: (host: string, revision: number) => post({ action: "remove_registry", host, expectedRevision: revision }),
 };
}
