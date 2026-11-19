// Company settings, "AI and spending" (guided onboarding PR 15): the setup step's own component, for company owners and admins after setup. Code's
// task refusals name this page ("Pick another model in Company settings, AI and spending").
import { PageHeader } from "../../../design/PageHeader.js";
import { AiSpendStep } from "../../setup/AiSpendStep.js";
import { useAdminContext } from "../AdminLayout.js";
import { LearningModelCard } from "./LearningModelCard.js";

export function AiSpendingScreen() {
 const { developerId, role, checking } = useAdminContext();
 return <section><PageHeader focusOnMount title="AI and spending" description="Who pays for the AI, the model Rovara uses, and the company's monthly limit." />
  {!checking && <AiSpendStep key={`${developerId}:${role}`} role={role} developerId={developerId} />}
  {!checking && <LearningModelCard key={`learning:${developerId}:${role}`} developerId={developerId} role={role} />}
 </section>;
}
