// The broker's side of the company image mirror when it plans a run: which approved images have a finished copy in the install's registry (and so may be put in a plan), and starting the copier for those that do not.
// The plan names the install's own repository and the approved digest; an image with no finished copy is "still being copied" (`image_copying`), never pulled from its source.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CompanyImageMirrorJobSchema, companyImageRepositoryName, type CompanyImageMirrorJob, type CompanyImageMirrorRef, type OrgId } from "@agentx/contracts";
import type { CompanyImage } from "./company-images.js";
import { mirrorNeedsStart, readMirrorState, type MirrorTable } from "./company-image-mirror-state.js";

export type MirrorStarter = (job: CompanyImageMirrorJob) => Promise<void>;

/** Starts the mirror function with a job (an asynchronous invoke: the copy takes minutes). Throws when the start is not accepted. */
export function lambdaMirrorStarter(functionName: string, client: { send(command: unknown): Promise<unknown> } = new LambdaClient({})): MirrorStarter {
  return async (job) => {
    const checked = CompanyImageMirrorJobSchema.parse(job);
    const response = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(checked)) })) as { StatusCode?: number };
    if (response.StatusCode !== 202) throw new Error("the mirror was not started");
  };
}

/** The starter the broker uses, from its settings: absent where the install has no mirror function (then no company image is ever served). */
export function mirrorStarterFromEnvironment(env: NodeJS.ProcessEnv = process.env): MirrorStarter | undefined {
  const name = env["COMPANY_IMAGE_MIRROR_FUNCTION_NAME"];
  return name === undefined || name === "" ? undefined : lambdaMirrorStarter(name);
}

/**
 * The finished copies of the company's approved images, by image id. An image whose copy is not `ready` for exactly its digest is absent, and, when nothing is running or a failure is old enough to retry, the copier is
 * started for it (best effort, never awaited past the start). Never throws: any doubt is "not copied".
 */
export async function readCompanyImageMirrors(
  table: MirrorTable, orgId: OrgId, images: readonly CompanyImage[],
  options: { env?: NodeJS.ProcessEnv; start?: MirrorStarter | undefined; extraRegistries?: readonly string[]; now?: () => number } = {},
): Promise<Map<string, CompanyImageMirrorRef>> {
  const found = new Map<string, CompanyImageMirrorRef>();
  const env = options.env ?? process.env;
  const name = env["AGENTX_ENV"];
  if (name === undefined || name === "") return found;
  const start = "start" in options ? options.start : mirrorStarterFromEnvironment(env);
  const now = options.now ?? Date.now;
  for (const image of images) {
    if (image.status !== "approved") continue;
    try {
      const repository = companyImageRepositoryName({ env: name, orgId, imageId: image.imageId });
      const state = await readMirrorState(table, orgId, image.imageId);
      if (state?.state === "ready" && state.digest === image.digest && state.repository === repository) { found.set(image.imageId, { repository, digest: image.digest }); continue; }
      if (start !== undefined && mirrorNeedsStart(state, image.digest, now())) {
        await start({ action: "copy", orgId, imageId: image.imageId, cycle: image.cycle, registry: image.registry, repository: image.repository, digest: image.digest, extraRegistries: [...(options.extraRegistries ?? [])] }).catch(() => undefined);
      }
    } catch { /* not copied */ }
  }
  return found;
}
