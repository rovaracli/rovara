import { Suspense, lazy, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { useHowWeWork } from "../../api/how-we-work.js";
import { useLearningMode } from "../../api/learning-mode.js";
import { useLessonSources } from "../../api/lessons.js";
import { useOnboardingApi } from "../../api/onboarding.js";
import { useSavedEnvPanel } from "../../api/saved-env.js";
import type { useProject } from "../../api/projects.js";

type ProjectOverview = NonNullable<ReturnType<typeof useProject>["data"]>;
import { useTestEnvironmentApi } from "../../api/test-environment.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { MODE_WORDS } from "./lessons/learning-mode-words.js";

// The setup screen opens in place, as its own chunk: nothing of it loads until a row is opened.
const SetupStep = lazy(async () => ({ default: (await import("../onboarding/steps/SetupStep.js")).SetupStep }));
const SavedEnvSetting = lazy(async () => ({ default: (await import("./SavedEnvSetting.js")).SavedEnvSetting }));
const LearningModeControl = lazy(async () => ({ default: (await import("./lessons/LearningModeControl.js")).LearningModeControl }));

export type RowState = "done" | "attention" | "neutral" | "loading";
export interface ChecklistRow { id: string; title: string; state: RowState; why: string }

/** The setup check's state, as a row: done only when the latest settings passed. */
export function setupRow(setup: ProjectOverview["project"]["setup"]): ChecklistRow {
 const why: Record<string, [RowState, string]> = {
  ready: ["done", "The setup and test commands passed their check."],
  checking: ["neutral", "Checking the setup now."],
  failed: ["attention", "The last check failed. Open it to see the step, the cause and a fix."],
  outdated: ["attention", "The settings changed since the last check. Check them again."],
  unchecked: ["attention", "Not checked yet. Add the setup and test commands, or let Rovara propose them."],
 };
 const [state, text] = why[setup.status] ?? ["attention", "Not checked yet."];
 return { id: "setup", title: "Setup commands", state, why: text };
}

/** SV-1l: the saved environment's row: off, or on with the saved copy's health. */
export function savedEnvRowOf(panel: { enabled?: boolean | undefined; health: string }): ChecklistRow {
 const row = (state: RowState, why: string): ChecklistRow => ({ id: "saved-environment", title: "Saved environment", state, why });
 if (panel.enabled === false) return row("neutral", "Off for this project. Every new task sets up fresh.");
 if (panel.health === "healthy") return row("done", "On. New tasks start from the saved copy.");
 if (panel.health === "needs_repair") return row("attention", "On, but the last build failed. New tasks set up fresh until the next build works.");
 return row("neutral", "On. A saved copy is built after the first passing setup check.");
}

const MARK: Readonly<Record<RowState, string>> = { done: "Done", attention: "Needs attention", neutral: "", loading: "" };

function Row({ row, children, open, onToggle, action }: { row: ChecklistRow; children?: ReactNode; open: boolean; onToggle?: () => void; action?: ReactNode }) {
 const id = "setup-row-" + row.id;
 return <li className="rv-setup-row" data-state={row.state}>
  <div className="rv-setup-row-head">
   <span className="rv-setup-mark" aria-hidden="true">{row.state === "done" ? "✓" : row.state === "attention" ? "!" : "·"}</span>
   <div><h3 id={id}>{row.title}</h3><p className="rv-muted">{MARK[row.state] !== "" && <strong>{MARK[row.state] + ". "}</strong>}{row.state === "loading" ? "Reading" : row.why}</p></div>
   {action ?? (onToggle !== undefined && <Button aria-expanded={open} aria-controls={id + "-panel"} onClick={onToggle}>{open ? "Close" : "Open"}</Button>)}
  </div>
  {open && children !== undefined && <div id={id + "-panel"} role="region" aria-labelledby={id} className="rv-setup-row-panel">{children}</div>}
 </li>;
}

/** The setup screen, in place, for the project's maintainers: the same screen onboarding shows, reading the project's own settings. */
function SetupPanel({ project, focus }: { project: string; focus?: "test-environment" }) {
 const api = useOnboardingApi(), query = useQueryClient();
 const read = useQuery({ queryKey: ["onboard", "project", project], queryFn: () => api.project(project), retry: false, refetchInterval: q => q.state.data?.setup.status === "checking" ? 15_000 : false });
 if (read.isPending) return <Skeleton label="Loading the setup" />;
 if (read.isError) return <><p role="alert">Couldn't load the setup.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></>;
 return <Suspense fallback={<Skeleton label="Loading the setup" />}><div ref={element => { if (focus !== undefined && element !== null) element.querySelector("#" + focus)?.scrollIntoView({ block: "start" }); }}>
  <SetupStep project={read.data} onProject={value => { query.setQueryData(["onboard", "project", project], value);void query.invalidateQueries({ queryKey: ["project", project, "overview"] }); }} refresh={() => { void read.refetch(); }} onNext={() => { void query.invalidateQueries({ queryKey: ["project", project, "overview"] }); }} nextLabel="Done" />
 </div></Suspense>;
}

/**
 * UX-4b: one project setup checklist, always on the project page: repository, setup commands, test environment, saved environment (SV-1l), How we work, learning sources and connections used. Each row says whether it is done or
 * needs attention and why, and opens its screen in place. Maintainers change things here (every route behind it needs only a maintainer); everyone else reads the states.
 */
export function ProjectSetupChecklist({ overview, onTab }: { overview: ProjectOverview; onTab: (tab: string) => void }) {
 const project = overview.project.name, canEdit = overview.you.canEditSettings;
 const [open, setOpen] = useState<string>();
 const toggle = (id: string) => () => { setOpen(current => current === id ? undefined : id); };
 const testEnv = useTestEnvironmentApi();
 const env = useQuery({ queryKey: ["project", project, "test-environment", "checklist"], retry: false, enabled: canEdit, queryFn: () => testEnv.read(project) });
 const howWeWork = useHowWeWork(project), mode = useLearningMode(project), sources = useLessonSources(project), savedEnv = useSavedEnvPanel(project);

 const repositories = overview.project.repositories;
 const repositoryRow: ChecklistRow = repositories.length > 0
  ? { id: "repository", title: "Repository", state: "done", why: repositories.map(repository => repository.fullName).join(", ") }
  : { id: "repository", title: "Repository", state: "attention", why: "No repository is connected to this project." };
 const envRow: ChecklistRow = !canEdit ? { id: "test-environment", title: "Test environment", state: "neutral", why: "A maintainer of this project sets it up." }
  : env.isPending ? { id: "test-environment", title: "Test environment", state: "loading", why: "" }
  : env.isError ? (env.error instanceof ApiError && env.error.status === 404 ? { id: "test-environment", title: "Test environment", state: "neutral", why: "Test environments aren't turned on in this installation." } : { id: "test-environment", title: "Test environment", state: "attention", why: "Couldn't read the test environment." })
  : env.data.approved !== undefined ? { id: "test-environment", title: "Test environment", state: env.data.approved.check.status === "failed" ? "attention" : "done", why: env.data.approved.check.status === "failed" ? "Approved, but its check fails at the current settings." : "Approved and in use by tasks." }
  : { id: "test-environment", title: "Test environment", state: "attention", why: env.data.proposal !== undefined ? "A proposal waits for its check and approval." : "Not set up yet. Rovara can propose one from the setup." };
 // SV-1l: the saved environment, read by every member (the same read as the Saved environment section). Where saved environments are not on (404) the row says so and opens nothing.
 const savedEnvGone = savedEnv.isError && savedEnv.error instanceof ApiError && (savedEnv.error.status === 404 || savedEnv.error.status === 403);
 const savedEnvRow: ChecklistRow = savedEnv.isPending ? { id: "saved-environment", title: "Saved environment", state: "loading", why: "" }
  : savedEnvGone ? { id: "saved-environment", title: "Saved environment", state: "neutral", why: "Saved environments aren't turned on in this installation." }
  : savedEnv.isError ? { id: "saved-environment", title: "Saved environment", state: "attention", why: "Couldn't read the saved environment." }
  : savedEnvRowOf(savedEnv.data);
 const hwwRow: ChecklistRow = howWeWork.isPending ? { id: "how-we-work", title: "How we work", state: "loading", why: "" }
  : howWeWork.isError ? { id: "how-we-work", title: "How we work", state: "neutral", why: "Couldn't read how this project works." }
  : { id: "how-we-work", title: "How we work", state: "done", why: howWeWork.data.process.kind === "project_process" ? "This project runs its own version of the steps" + (howWeWork.data.process.version === undefined ? "." : " (version " + String(howWeWork.data.process.version) + ").") : "This project runs Rovara Code's steps" + (howWeWork.data.rules.length > 0 ? ", with project rules." : ".") };
 const recordGone = mode.isError && mode.error instanceof ApiError && mode.error.status === 404;
 const recordPaused = mode.isError && mode.error instanceof ApiError && mode.error.code === "TEAM_RECORD_PAUSED";
 const sourceCount = sources.data?.sources.length ?? 0;
 const learningRow: ChecklistRow = mode.isPending ? { id: "learning", title: "Learning sources", state: "loading", why: "" }
  : recordGone ? { id: "learning", title: "Learning sources", state: "neutral", why: "The team record isn't set up in this installation, so there is nothing to learn from yet." }
  : recordPaused ? { id: "learning", title: "Learning sources", state: "neutral", why: "The team record is paused in this installation: nothing new is captured or learned until it is resumed." }
  : mode.isError ? { id: "learning", title: "Learning sources", state: "attention", why: "Couldn't read how this project learns." }
  : mode.data.effective === "off" ? { id: "learning", title: "Learning sources", state: "attention", why: "Learning is off" + (mode.data.lock === "off" ? ": your company keeps it off." : ". Turn it on to learn from the team's work.") }
  : sourceCount === 0 ? { id: "learning", title: "Learning sources", state: "attention", why: "Learning is " + MODE_WORDS[mode.data.effective].label + ", but no source feeds it yet." }
  : { id: "learning", title: "Learning sources", state: "done", why: "Learning is " + MODE_WORDS[mode.data.effective].label + ", from " + String(sourceCount) + (sourceCount === 1 ? " source." : " sources.") };
 const channels = overview.project.channels;
 const connectionsRow: ChecklistRow = { id: "connections", title: "Connections used", state: channels.length > 0 ? "done" : "neutral", why: channels.length > 0 ? "Slack: " + channels.join(", ") + "." : "No Slack channel is connected to this project. People can still start work here." };

 return <section className="rv-project-section rv-setup-checklist" aria-label="Project setup">
  <h2>Project setup</h2>
  <ul className="rv-setup-rows">
   <Row row={repositoryRow} open={false} />
   <Row row={setupRow(overview.project.setup)} open={open === "setup"} {...(canEdit ? { onToggle: toggle("setup") } : {})}>{canEdit && <SetupPanel project={project} />}</Row>
   <Row row={envRow} open={open === "test-environment"} {...(canEdit && envRow.state !== "neutral" ? { onToggle: toggle("test-environment") } : {})}>{canEdit && <SetupPanel project={project} focus="test-environment" />}</Row>
   <Row row={savedEnvRow} open={open === "saved-environment"} {...(savedEnv.data?.enabled !== undefined ? { onToggle: toggle("saved-environment") } : {})}>{savedEnv.data !== undefined && <Suspense fallback={<Skeleton label="Loading" />}><SavedEnvSetting project={project} panel={savedEnv.data} /></Suspense>}</Row>
   <Row row={hwwRow} open={false} action={<Button onClick={() => { onTab("how-we-work"); }}>Open</Button>} />
   <Row row={learningRow} open={open === "learning"} action={<span className="rv-setup-actions">{!recordGone && <Button aria-expanded={open === "learning"} onClick={toggle("learning")}>{open === "learning" ? "Close" : "Open"}</Button>}{!recordGone && <Button variant="quiet" onClick={() => { onTab("sources"); }}>Sources</Button>}</span>}><Suspense fallback={<Skeleton label="Loading" />}><LearningModeControl project={project} /></Suspense></Row>
   <Row row={connectionsRow} open={open === "connections"} onToggle={toggle("connections")}><p className="rv-muted">{channels.length > 0 ? <>People in <VisibleText text={channels.join(", ")} /> can start work here and see this project's sessions.</> : "A company admin connects Slack channels to projects."}</p>{canEdit && <p><a href="#allowed-websites">Allowed websites</a> the setup and tasks may reach are listed on this page.</p>}</Row>
  </ul>
 </section>;
}
