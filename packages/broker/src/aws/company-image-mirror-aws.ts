// The AWS side of the company image mirror: the ECR writer the copier uses (made with ONE repository's push session credentials, so a call can reach that repository only), and nothing here keeps a credential or an AWS error's text.
import { BatchCheckLayerAvailabilityCommand, BatchGetImageCommand, CompleteLayerUploadCommand, InitiateLayerUploadCommand, PutImageCommand, UploadLayerPartCommand } from "@aws-sdk/client-ecr";
import { sha256Of } from "../test-env/company-image-manifest.js";
import type { EcrWriter } from "../test-env/company-image-mirror.js";

interface Sender { send(command: unknown): Promise<unknown> }
const named = (error: unknown, ...names: string[]): boolean => error instanceof Error && names.includes(error.name);
/** `BatchCheckLayerAvailability` takes at most 100 digests. */
const CHECK_BATCH = 100;

export function ecrWriterOf(ecr: Sender, repository: string): EcrWriter {
  return {
    async available(digests) {
      const found = new Set<string>();
      for (let at = 0; at < digests.length; at += CHECK_BATCH) {
        try {
          const answer = await ecr.send(new BatchCheckLayerAvailabilityCommand({ repositoryName: repository, layerDigests: digests.slice(at, at + CHECK_BATCH) })) as { layers?: Array<{ layerDigest?: string; layerAvailability?: string }> };
          for (const layer of answer.layers ?? []) if (layer.layerAvailability === "AVAILABLE" && typeof layer.layerDigest === "string") found.add(layer.layerDigest);
        } catch (error) {
          // A repository that does not exist yet holds nothing: the first upload creates it from the creation template.
          if (named(error, "RepositoryNotFoundException")) return found;
          throw error;
        }
      }
      return found;
    },

    async uploadBlob(digest, parts) {
      const started = await ecr.send(new InitiateLayerUploadCommand({ repositoryName: repository })) as { uploadId?: string };
      if (started.uploadId === undefined) throw new Error("no upload");
      let first = 0;
      for await (const part of parts) {
        await ecr.send(new UploadLayerPartCommand({ repositoryName: repository, uploadId: started.uploadId, partFirstByte: first, partLastByte: first + part.byteLength - 1, layerPartBlob: part }));
        first += part.byteLength;
      }
      // The parts are held to `digest` by the caller before the last one is released; ECR checks it again.
      await ecr.send(new CompleteLayerUploadCommand({ repositoryName: repository, uploadId: started.uploadId, layerDigests: [digest] }));
    },

    async putImage(input) {
      try {
        await ecr.send(new PutImageCommand({ repositoryName: repository, imageManifest: input.manifest, imageManifestMediaType: input.mediaType, imageDigest: input.digest, imageTag: input.tag }));
      } catch (error) {
        // The same image under the same tag is already there (a retry): the read-back that follows is the check.
        if (!named(error, "ImageAlreadyExistsException", "ImageTagAlreadyExistsException")) throw error;
      }
    },

    async readBack(digest) {
      const answer = await ecr.send(new BatchGetImageCommand({ repositoryName: repository, imageIds: [{ imageDigest: digest }], acceptedMediaTypes: ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"] })) as { images?: Array<{ imageManifest?: string }> };
      const manifest = answer.images?.[0]?.imageManifest;
      return manifest === undefined ? undefined : sha256Of(new TextEncoder().encode(manifest));
    },
  };
}
