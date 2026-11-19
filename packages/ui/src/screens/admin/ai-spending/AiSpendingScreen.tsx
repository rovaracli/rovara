import { PageHeader } from "../../../design/PageHeader.js";
import { AiSpendStep } from "../../setup/AiSpendStep.js";
import { useAdminContext } from "../AdminLayout.js";

export function AiSpendingScreen() {
 const { orgId, company, developerId, role, checking } = useAdminContext();
 return <section><PageHeader focusOnMount title="AI and spending" description="Company AI connections, models for each step, and spending limits." />
  {!checking && <AiSpendStep key={`${orgId}:${developerId}:${role}`} orgId={orgId} company={company} role={role} developerId={developerId} />}
 </section>;
}
