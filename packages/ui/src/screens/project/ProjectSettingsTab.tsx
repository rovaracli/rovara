// Guided onboarding PR 9 (DEC 254k, 254n item 3): Project settings on the project's own page, reachable by the people Code lets change the project: company
// owners and admins AND the project's admins (the admin area is company admins only). Re-run setup, Archive and Restore (preview first), Slack and Linear, and
// the AI and spend limit. Code decides who may do each; every control shows only what Code offers this person.
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppProjectLifecycleSchema, PROJECT_LIFECYCLE_WORDS } from "@agentx/contracts/web";
import { useOnboardingApi } from "../../api/onboarding.js";
import { ApiError } from "../../api/errors.js";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "../../design/Skeleton.js";
import { ProjectScopeContext, type AdminContext } from "../admin/admin-context.js";
import { useAdminRead } from "../admin/projects/read.js";
import { ArchiveProject } from "../admin/projects/ArchiveProject.js";
import { RestoreProject } from "../admin/projects/RestoreProject.js";
import { ProjectIntegrations } from "../connect/ProjectIntegrations.js";
import { ProjectSpendLimits } from "../setup/ProjectSpendLimits.js";
import { SetupRunControls } from "../setup/SetupRunRow.js";
import { RecheckSetupRow } from "../setup/SetupRepairCard.js";
import { setupChecklistKey } from "../../api/setup-checklist.js";
import { TicketUpdatesSettings } from "./TicketUpdatesSettings.js";
import { ProjectPeople } from "../admin/projects/ProjectPeople.js";
import { LocalToolsSetting } from "./LocalToolsSetting.js";

const lifecycleReader = { parse(value: unknown) { return AppProjectLifecycleSchema.parse(value); } };

function Lifecycle({ project, scope }: { project: string; scope: AdminContext }) {
 const lifecycle = useAdminRead("project-lifecycle", project, `/v1/app/projects/${encodeURIComponent(project)}/lifecycle`, lifecycleReader);
 const settled = !lifecycle.isFetching && !lifecycle.isError && !scope.checking;
 const notYet = lifecycle.error instanceof ApiError && lifecycle.error.code === "NOT_ON_CODE_YET";
 const status = lifecycle.data?.status;
 return <section className="rv-project-section" aria-label="Archive or restore" data-testid="project-settings-lifecycle">
  <h2>Archive or restore</h2>
  {status === "archived" ? <p>This project is archived. New work stops. Running tasks stop at their next step.</p> : <p>Archiving stops new work in this project. Nothing is deleted, and it can be restored.</p>}
  {notYet && <p className="rv-muted">{PROJECT_LIFECYCLE_WORDS.notYet}</p>}
  {lifecycle.data !== undefined && lifecycle.data.actions.length === 0 && <p className="rv-muted" data-testid="project-settings-lifecycle-none">Only company owners and admins, or this project's admins, can archive or restore it.</p>}
  {status !== undefined && <>
   <ArchiveProject key={`${scope.orgId}:${scope.developerId}:${project}`} name={project} observedStatus={status} available={settled && status === "active" && lifecycle.data!.actions.includes("archive")} />
   <RestoreProject key={`restore:${scope.orgId}:${scope.developerId}:${project}`} name={project} observedStatus={status} available={settled && status === "archived" && lifecycle.data!.actions.includes("restore")} />
  </>}
 </section>;
}

export function ProjectSettingsTab({ project, canEdit }: { project: string; canEdit: boolean }) {
 const api = useOnboardingApi(), query = useQueryClient();
 const me = useQuery({ queryKey: ["me"], queryFn: api.me });
 if (me.data === undefined) return me.isError ? <p role="alert">Couldn't load your account. Reload this page.</p> : <Skeleton label="Loading Project settings" />;
 const scope: AdminContext = { orgId: me.data.org.orgId, company: me.data.org.name, developerId: me.data.developer.id, role: me.data.developer.orgRole === "owner" || me.data.developer.orgRole === "admin" ? me.data.developer.orgRole : "member", checking: me.isFetching };
 return <ProjectScopeContext.Provider value={scope}><div data-testid="project-settings">
  <section className="rv-project-section" aria-label="Setup" data-testid="project-settings-setup">
   <h2>Setup</h2>
   <p>Run Rovara's setup again to check how this project installs and tests. A re-run only proposes: the working setup stays until someone confirms a new one.</p>
   <SetupRunControls project={project} againLabel="Re-run setup" onChanged={() => { void query.invalidateQueries({ queryKey: setupChecklistKey(project) }); }} />
   <RecheckSetupRow project={project} />
  </section>
  <section className="rv-project-section" aria-label="Browser testing" data-testid="project-settings-browser-testing">
   <h2>Browser testing</h2>
   <p>Rovara starts your app in a test sandbox and tries each change in a real browser before it reaches review. An owner or admin approves what it uses.</p>
   <p><Link className="rv-button" to={`/app/projects/${encodeURIComponent(project)}/browser-testing`}>Open browser testing</Link></p>
  </section>
  <ProjectPeople key={`people:${scope.orgId}:${scope.developerId}:${project}`} name={project} />
  <Lifecycle project={project} scope={scope} />
  <ProjectIntegrations project={project} canEdit={canEdit} />
  <TicketUpdatesSettings project={project} />
  <LocalToolsSetting key={`local-tools:${scope.orgId}:${scope.developerId}:${project}`} project={project} />
  <p><Link to="/app/admin/ai-spending#ai-models">AI models for each step</Link> are managed for the company.</p><ProjectSpendLimits key={`spend:${scope.orgId}:${scope.developerId}:${project}`} project={project} developerId={scope.developerId} />
 </div></ProjectScopeContext.Provider>;
}
