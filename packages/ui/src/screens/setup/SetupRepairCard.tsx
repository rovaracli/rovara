// L4-U5 (setup-upkeep-plan.md step 3c), reshaped by the Setup tab (FABLE-REVIEW 3.1): the "Setup needs repair" card on a project's page stays ABOVE the tabs as a short banner with one link, "Open Setup". The work (Fix setup,
// Check again without AI, approving a checked fix) is done in the Setup tab's status card. The banner says what Code's chat thread and the admins' notice say, in the same words (`SETUP_REPAIR_SENTENCES`, a byte mirror of Code):
// the title and the sentence with the check's own failing step. Silent when the setup works. Code decides who may act; this banner only points.
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { SETUP_REPAIR_SENTENCES } from "@agentx/contracts/web";
import { setupRepairKey, useSetupRepairApi } from "../../api/setup-repair.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ACTIONS } from "../setup-tab/setup-tab-text.js";
import "./setup-repair.css";

export function useSetupRepair(project: string) {
 const api = useSetupRepairApi();
 return useQuery({ queryKey: setupRepairKey(project), queryFn: () => api.read(project), retry: false, refetchOnWindowFocus: false });
}

/** The project's setup banner: nothing while the setup works (or while Code has no such read). */
export function SetupRepairCard({ project }: { project: string }) {
 const read = useSetupRepair(project);
 if (read.isPending || read.isError || read.data === undefined) return null;
 const card = read.data.repair;
 if (card === undefined) return null;
 return <section className="rv-setup-repair" aria-labelledby="rv-setup-repair-title" data-testid="setup-repair-card" data-fix-ready={card.fixReady ? "true" : "false"}>
  <h2 id="rv-setup-repair-title">{SETUP_REPAIR_SENTENCES.title}</h2>
  <p data-testid="setup-repair-body"><VisibleText text={SETUP_REPAIR_SENTENCES.body(card.step)} /></p>
  <div className="rv-setup-repair-actions"><Link className="rv-button rv-button-secondary" data-testid="setup-repair-open" to={`/app/projects/${encodeURIComponent(project)}?tab=setup`}>{ACTIONS.openSetup}</Link></div>
 </section>;
}
