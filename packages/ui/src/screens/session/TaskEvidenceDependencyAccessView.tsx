import { EVIDENCE_FALLBACK_REASON_WORDS, evidenceDependencyLabelWords } from "@agentx/contracts/web";
import type { ReadTask } from "./workspace-types.js";
type EvidenceEnvironment = NonNullable<ReadTask["evidence"]>["environment"];
import { Banner } from "../../design/Banner.js";
import { VisibleText } from "../../design/VisibleText.js";

/** Presents only dependency-access facts already admitted by the evidence contract reader. */
export function TaskEvidenceDependencyAccessView({ environment }: { environment: EvidenceEnvironment }) {
  const refused = environment.services.filter(service => service.mode === "live-forbidden");
  const dependencies = environment.dependencies;
  const fallbacks = dependencies?.filter(dependency => dependency.fellBack !== undefined) ?? [];

  return <section aria-label="Task evidence dependency access">
    {refused.length > 0 && <Banner title="Live dependency access refused" tone="warning">
      {refused.map(service => <p key={service.name}><span>The check could not use this live service: </span><VisibleText text={service.name} /><span>. The evidence does not prove the live integration. Configure an allowed test service.</span></p>)}
    </Banner>}
    {(dependencies === undefined || dependencies.some(dependency => dependency.label === "unknown")) && <Banner title="Dependency evidence unavailable" tone="warning">
      <p>The test dependency&apos;s status could not be read. This is not proof that the code failed. Load the dependency evidence.</p>
    </Banner>}
    {dependencies !== undefined && dependencies.length > 0 && <ul aria-label="Dependencies">{dependencies.filter(dependency => dependency.fellBack === undefined).map(dependency => <li key={dependency.name}>
      <VisibleText text={dependency.name} /><span>{": " + (dependency.label === "unknown" ? "Status unavailable" : evidenceDependencyLabelWords(dependency.label, dependency.name, dependency.madeUpAnswers ?? 0)) + (dependency.startedMs === undefined ? "" : ", started in " + dependency.startedMs + " ms")}</span>
    </li>)}</ul>}
    {fallbacks.length > 0 && <section aria-label="Dependency fallback">
      <h3>Dependency fallback</h3>
      <ul>{fallbacks.map(dependency => {
        const fallback = dependency.fellBack!;
        const source = fallback.reason === "did_not_start" ? "Runner infrastructure" : "Test dependency";
        return <li key={dependency.name}>
          <VisibleText text={dependency.name} />
          <span>{": " + (dependency.label === "unknown" ? "Status unavailable" : evidenceDependencyLabelWords(dependency.label, dependency.name, dependency.madeUpAnswers ?? 0)) + " (fallback: " + (fallback.reason === "unknown" ? "Reason unavailable" : EVIDENCE_FALLBACK_REASON_WORDS[fallback.reason]) + ") · " + source}</span>
        </li>;
      })}</ul>
    </section>}
  </section>;
}
