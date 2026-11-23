// TEST-ONLY legacy harness (as G2/G3): the read-only setup slots of the G5 rebuild (area 6, sections 19/20), composed the way the rebuild lane first drew them.
// Production mounts the live wizard inside the rebuilt frames instead (screens/account-setup-read/OnboardPage.tsx); these slots exist only so the lane's read-only suites keep proving the read panels.
import { useParams, useSearchParams } from "react-router";
import { ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { ReadEntry } from "../../../../../packages/ui/src/screens/account-setup-read/ReadEntry.js";
import { CompanySetupProgressRead } from "../../../../../packages/ui/src/screens/account-setup-read/CompanySetupProgressRead.js";
import { SetupWorkflowsReadScreen } from "../../../../../packages/ui/src/screens/account-setup-read/SetupWorkflowsReadScreen.js";
import { SetupProgressReadPanel } from "../../../../../packages/ui/src/screens/account-setup-read/SetupProgressReadPanel.js";
import { SetupJournalReadPanel } from "../../../../../packages/ui/src/screens/account-setup-read/SetupJournalReadPanel.js";
import { NameReadPanel } from "./NameReadPanel.js";
import { ProjectChecklistRead } from "./ProjectChecklistRead.js";
/** Shared shell/onboard/project slots are composed by WIRING, not registered twice. */
export function AccountSetupReadEntry({ slot = "onboard", project: supplied }: { slot?: "name" | "onboard" | "company" | "workflows" | "checklist" | "checklist-only" | "progress" | "journal"; project?: string }) {
 const [params] = useSearchParams(), route = useParams();
 const raw = supplied ?? route["name"] ?? params.get("project");
 const parsed = ProjectOverviewProjectSchema.shape.name.safeParse(raw);
 if (slot === "name") return <ReadEntry title="Choose your name" code="NAME-PROMPT-READ-FAILED"><NameReadPanel /></ReadEntry>;
 if (slot === "company" || (slot === "onboard" && raw === null)) return <ReadEntry title="Company setup progress" code="COMPANY-SETUP-READ-FAILED"><CompanySetupProgressRead /></ReadEntry>;
 if (!parsed.success) return <ReadEntry><p className="g5-note" role="status">Can't tell yet. Choose an existing project context to read its setup.</p></ReadEntry>;
 const project = parsed.data;
 if (slot === "workflows" || (slot === "onboard" && params.get("step") === "agents")) return <ReadEntry title="Workflows for setup" code="SETUP-AGENTS-READ-FAILED"><SetupWorkflowsReadScreen project={project} /></ReadEntry>;
 if (slot === "checklist-only") return <ReadEntry title="Project setup checklist" code="SETUP-READ-FAILED"><ProjectChecklistRead project={project} /></ReadEntry>;
 return <ReadEntry title={slot === "journal" ? "Setup run journal" : slot === "progress" ? "Setup run progress" : "Setup progress"} code="SETUP-READ-FAILED"><div className="g5-stack">{(slot === "onboard" || slot === "checklist") && <ProjectChecklistRead project={project} />}{slot !== "journal" && <SetupProgressReadPanel project={project} withLog={slot === "progress"} />}{slot !== "progress" && <SetupJournalReadPanel project={project} withRun={slot === "journal"} />}</div></ReadEntry>;
}
