import type { ReadTask } from "./workspace-types.js";

type Evidence = NonNullable<ReadTask["evidence"]>;
type WithheldArtifact = NonNullable<Evidence["browser"][number]["withheld"]>[number];

const artifactNames: Record<string, string> = { video: "Video", trace: "Trace" };
const withheldReasons: Record<string, string> = {
  account_not_run_scoped: "an account is not single-use",
  tier_not_allowed: "this test environment does not allow it",
  data_not_synthetic: "the data is not synthetic",
  company_setting_off: "the company setting is off",
  revocation_not_confirmed: "the test accounts could not be confirmed closed",
  size_over_cap: "too large",
  upload_failed: "the upload failed",
};

export function EvidenceArtifactWithheldView({ artifact, reason }: WithheldArtifact) {
  const name = artifactNames[artifact] ?? "Artifact";
  return (
    <section aria-label={`${name} not kept`}>
      <h5>{name}</h5>
      {reason === "upload_failed" ? (
        <p>This evidence artifact was not kept because its upload failed. The check result is separate from this missing artifact. Run the evidence capture again.</p>
      ) : (
        <p>{`${name} not kept: ${withheldReasons[reason] ?? "the reason is unavailable"}.`}</p>
      )}
    </section>
  );
}
