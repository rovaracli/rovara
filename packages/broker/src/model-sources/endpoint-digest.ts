// N8: what "qualified" means for a company's own model endpoint, kept in its own small file because the model access function (inside the VPC) imports it too.
// See endpoint-qualification.ts for the rest of the rules an endpoint passes before it is used.
import { createHash } from "node:crypto";
import { canonicalJson, type ModelSource } from "@rovara-code/contracts";

export type EndpointSource = Extract<ModelSource, { kind: "endpoint" }>;

/**
 * The digest of the settings a check covers: the address, the wire format, the secret reference and the models (the name the endpoint serves and the catalog entry it
 * stands for). The label is not part of it: renaming a source does not need a new check.
 */
export function endpointQualificationDigest(source: EndpointSource): string {
  const models = source.models
    .map((entry) => ({ name: entry.name, provider: entry.catalog.provider, modelId: entry.catalog.modelId }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha256").update(canonicalJson({ version: 1, baseUrl: source.baseUrl, api: source.api, keyRef: source.keyRef ?? null, models }), "utf8").digest("hex");
}

/** Whether a check passed for exactly the settings the source has now. A source never checked, or changed since, is not qualified. */
export function endpointQualified(source: ModelSource): boolean {
  return source.kind === "endpoint" && source.qualifiedDigest !== undefined && source.qualifiedDigest === endpointQualificationDigest(source);
}
