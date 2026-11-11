import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AppProjectDetail } from "@agentx/contracts/web";
import { PageHeader } from "../../../design/PageHeader.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { AgentsStep } from "../steps/AgentsStep.js";
import { InviteStep } from "../steps/InviteStep.js";
import { CompanyStatus } from "./CompanyStatus.js";
import { NameStep } from "./NameStep.js";
import { ReposStep, type ChosenRepos } from "./ReposStep.js";
import { EnvironmentStep } from "./EnvironmentStep.js";
import { FirstTaskStep } from "./FirstTaskStep.js";
import "./project-setup.css";

/** The six steps of the rich project setup. The first two happen before the project exists (held in the page); the others follow the project's address (`?project=`, `?step=`). */
export const SETUP_V2_STEPS = [
 { key: "name", label: "Name" }, { key: "repos", label: "Repos" }, { key: "check", label: "Environment check" }, { key: "agents", label: "Agents" }, { key: "people", label: "People" }, { key: "first", label: "First task" },
] as const;
type StepKey = (typeof SETUP_V2_STEPS)[number]["key"];
const AFTER_CREATE: readonly StepKey[] = ["check", "agents", "people", "first"];

export interface ProjectSetupV2Props {
 canAdd: boolean;
 /** A project's maintainer who is not an admin: only the environment check is theirs. */
 maintainerOnly: boolean;
 installations: ReadonlyArray<{ installationId: number; accountLogin: string }>;
 installationsState: "pending" | "error" | "ready";
 refreshInstallations: () => void;
 githubRequested: boolean;
 projectName: string | undefined;
 project: { data: AppProjectDetail | undefined; isPending: boolean; isError: boolean; refetch: () => unknown };
 onProject: (project: AppProjectDetail) => void;
 refreshProject: () => void;
 /** Where "back to the project" goes for a maintainer. */
 onBackToProject: () => void;
}

export default function ProjectSetupV2(props: ProjectSetupV2Props) {
 const [params, setParams] = useSearchParams(), [name, setName] = useState(""), [description, setDescription] = useState(""), [early, setEarly] = useState<"name" | "repos">("name"), [chosen, setChosen] = useState<ChosenRepos>();
 const { projectName, project } = props, requested = AFTER_CREATE.find(key => key === params.get("step"));
 const step: StepKey = projectName === undefined ? early : props.maintainerOnly ? "check" : requested ?? "check";
 const index = SETUP_V2_STEPS.findIndex(entry => entry.key === step);
 function go(key: StepKey, target = projectName) { const next = new URLSearchParams();if (target) next.set("project", target);next.set("step", key);setParams(next); }
 const meta = chosen?.metaRepository === "" ? undefined : chosen?.metaRepository;
 let body;
 if (props.installationsState === "pending" && projectName === undefined) body = <Skeleton label="Checking your GitHub connection" />;
 else if (props.installationsState === "error" && projectName === undefined) body = <><p role="alert">Couldn't check your GitHub connection.</p><Button onClick={props.refreshInstallations}>Try again</Button></>;
 else if (projectName === undefined && props.installations.length === 0) body = <CompanyStatus installations={[]} githubRequested={props.githubRequested} refresh={props.refreshInstallations} canAdmin={props.canAdd} />;
 else if (projectName === undefined) body = step === "name"
  ? <><NameStep name={name} description={description} onName={setName} onDescription={setDescription} onNext={() => setEarly("repos")} /><CompanyStatus installations={props.installations} githubRequested={false} refresh={props.refreshInstallations} canAdmin={props.canAdd} /></>
  : <ReposStep installations={props.installations} name={name} description={description} onBack={() => setEarly("name")} onCreated={(created, picks) => { setChosen(picks);go("check", created); }} />;
 else if (project.isPending) body = <Skeleton label="Loading your project" />;
 else if (project.isError || project.data === undefined) body = <><p role="alert">Couldn't load this project.</p><Button onClick={() => { void project.refetch(); }}>Try again</Button></>;
 else if (step === "check") body = <EnvironmentStep project={project.data} metaRepository={meta} onProject={props.onProject} refresh={props.refreshProject} onNext={props.maintainerOnly ? props.onBackToProject : () => go("agents")} nextLabel={props.maintainerOnly ? "Back to the project" : "Continue to agents"} />;
 else if (step === "agents") body = <AgentsStep project={projectName} onNext={() => go("people")} />;
 else if (step === "people") body = <><InviteStep onNext={() => go("first")} /><p className="rv-muted rv-psv2-note">Invites join the company today. They can't carry a project or a project role yet, so add people to this project from its page once they have joined.</p></>;
 else body = <FirstTaskStep project={project.data} metaRepository={meta} onBack={() => go("check")} />;
 return <section className="rv-onboarding rv-psv2">
  <PageHeader title={project.data !== undefined ? "Set up " + project.data.name : "Set up a project"} description="Name it, add its repositories, check each one builds, and start a first task." focusOnMount />
  {!props.maintainerOnly && <nav aria-label="Project setup progress"><p className="rv-onboarding-count">Step {index + 1} of {SETUP_V2_STEPS.length}: {SETUP_V2_STEPS[index]!.label}</p><ol>{SETUP_V2_STEPS.map((entry, at) => <li key={entry.key} aria-current={entry.key === step ? "step" : undefined}><span>{at + 1}</span>{entry.label}</li>)}</ol></nav>}
  <div className="rv-onboarding-workspace rv-psv2-workspace" key={projectName ?? "new"}>{body}</div>
  {projectName !== undefined && !props.maintainerOnly && step !== "first" && <p className="rv-muted rv-psv2-later"><Link to={"/app/projects/" + encodeURIComponent(projectName)}>Save and finish later</Link></p>}
 </section>;
}
