import { ArtifactLinkSchema, type ArtifactLink } from "@agentx/contracts/web";
import type { ReadTask } from "./workspace-types.js";
export type EvidenceArtifactLink = NonNullable<ReadTask["evidence"]>["browser"][number]["strip"]["after"][number];
import { Banner } from "../../design/Banner.js";
import { Button } from "../../design/Button.js";

const unavailableText = "This evidence link is unavailable. Its check result is shown separately.";
const expiredText = "This evidence link expired. An expired link does not show whether the check passed. Request a new authorized evidence link.";
const withheldText = "This evidence artifact was not kept. Its check result is shown separately.";

/** Draws the artifact-link state beside its evidence item without changing the check result. */
export function EvidenceArtifactExpiryView({
  link,
  prefix,
  onRequestNewLink,
}: {
  link?: EvidenceArtifactLink | undefined;
  prefix: string;
  onRequestNewLink?: (link: ArtifactLink) => void;
}) {
  const title = prefix || "Evidence artifact";
  if (!link) return <Banner title={title} tone="warning">{unavailableText}</Banner>;
  if (link.state === "available") return null;
  if (link.state === "withheld") return <Banner title={title} tone="warning">{withheldText}</Banner>;
  if (link.state !== "expired") return <Banner title={title} tone="warning">{unavailableText}</Banner>;
  const renewable = ArtifactLinkSchema.safeParse(link);
  return <Banner title={title} tone="warning">
    <p>{expiredText}</p>
    {onRequestNewLink && renewable.success && <Button onClick={() => onRequestNewLink(renewable.data)}>Request a new link</Button>}
  </Banner>;
}
