import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppProjectDetail, BranchCheckResponse, RepositoryBranchCheck } from "@agentx/cloud-contracts/web";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { branchNotices, type BranchNotice } from "./default-branch-text.js";

/**
 * 0.5.16: the default branch is read on GitHub before anything of the setup starts. While a code repository's branch is empty (or gone, or the repository has no code at all) and the person has not chosen
 * to go on, only this question is shown: use another branch, or continue anyway. Nothing below it (no setup draft, no setup run, no check) is offered or started until it is answered. When GitHub cannot answer,
 * the page says so and goes on, and nothing is started for the person. Once the branch is fine, a "Default branch" line lets the person change it later (the same check runs on the branch chosen).
 */
export function DefaultBranchGate({ project, onProject, children }: { project: AppProjectDetail; onProject: (project: AppProjectDetail) => void; children: ReactNode }) {
 const api = useOnboardingApi(), query = useQueryClient(), key = ["onboard", "branch-check", project.name];
 const check = useQuery({ queryKey: key, queryFn: () => api.branchCheck(project.name), retry: false, staleTime: 30_000 });
 const [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
 async function act(id: string, run: () => Promise<void>) {
  setBusy(id);setError(undefined);
  try { await run(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't do that. Try again."); } finally { setBusy(undefined); }
 }
 const chooseBranch = (row: RepositoryBranchCheck, branch: string) => act("use:" + row.repository, async () => {
  const done = await api.setDefaultBranch(project.name, { requestId: crypto.randomUUID(), expectedRevision: project.latestRevision, repository: row.repository, branch });
  query.setQueryData(key, done.check);
  onProject(done.project);
 });
 const continueWith = (row: RepositoryBranchCheck) => act("go:" + row.repository, async () => {
  const done = await api.continueBranch(project.name, { repository: row.repository, branch: row.branch });
  query.setQueryData(key, done);
 });
 if (check.isPending) return <Skeleton label="Checking the default branch on GitHub" />;
 // Without an answer (GitHub or Rovara could not be reached) the page says so and goes on. An earlier answer is kept when a later read fails, and what is below sits in the same place whatever the head says, so it never restarts.
 const data: BranchCheckResponse | undefined = check.data, notices = data === undefined ? [] : branchNotices(data);
 const again = () => { void check.refetch(); };
 if (data?.blocked === true) {
  return <div className="rv-branch-gates">{notices.filter(notice => notice.kind !== "fine").map(notice => <BlockedNotice key={notice.row.repository} notice={notice} busy={busy} onUse={chooseBranch} onContinue={continueWith} onAgain={again} />)}{error !== undefined && <p role="alert"><VisibleText text={error} /></p>}</div>;
 }
 return <>
  <div className="rv-branch-head">
   {data === undefined && <section className="rv-branch-gate" data-state="unchecked" role="status" aria-label="Default branch check"><p>We couldn't check the branch; draft the setup when ready.</p><Button onClick={again}>Check the branch again</Button></section>}
   {notices.filter(notice => notice.kind === "unchecked" || notice.kind === "continued").map(notice => <section key={notice.row.repository} className="rv-branch-gate" data-state={notice.kind} role="status" aria-label={"Default branch of " + notice.row.fullName}><p>{notice.kind === "unchecked" ? "We couldn't check the branch; draft the setup when ready." : <>Going on with <code><VisibleText text={notice.row.branch} /></code> of <VisibleText text={notice.row.fullName} /> as it is: it has no files yet.</>}</p>{notice.kind === "unchecked" && <Button onClick={again}>Check the branch again</Button>}</section>)}
   {data !== undefined && data.repositories.length > 0 && <details className="rv-branch-change"><summary>Default branch: {data.repositories.map(row => <span key={row.repository}><code><VisibleText text={row.branch} /></code>{data.repositories.length > 1 ? <> (<VisibleText text={row.fullName} />)</> : null} </span>)}Change</summary>
    {data.repositories.map(row => <ChangeBranch key={row.repository} row={row} busy={busy === "use:" + row.repository} onUse={branch => chooseBranch(row, branch)} />)}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   </details>}
  </div>
  {children}
 </>;
}

function ChangeBranch({ row, busy, onUse }: { row: RepositoryBranchCheck; busy: boolean; onUse: (branch: string) => Promise<void> }) {
 const [value, setValue] = useState("");
 return <form onSubmit={event => { event.preventDefault();void onUse(value.trim()); }}><TextField label={"Use another branch of " + row.fullName} value={value} hint="The branch is read on GitHub before it is saved." maxLength={255} onChange={event => { setValue(event.target.value); }} /><Button type="submit" busy={busy} aria-label={"Check and use this branch for " + row.fullName} disabled={value.trim() === "" || value.trim() === row.branch}>Check and use this branch</Button></form>;
}

function BlockedNotice({ notice, busy, onUse, onContinue, onAgain }: { notice: BranchNotice; busy: string | undefined; onUse: (row: RepositoryBranchCheck, branch: string) => Promise<void>; onContinue: (row: RepositoryBranchCheck) => Promise<void>; onAgain: () => void }) {
 const { row } = notice, [picked, setPicked] = useState<string>(), top = row.alternatives[0], rest = row.alternatives.slice(1);
 const heading = notice.kind === "no_code" ? "This repository has no code yet. Push code first." : undefined;
 const name = (value: string) => <code><VisibleText text={value} /></code>;
 return <section className="rv-branch-gate" data-state={notice.kind} role="group" aria-label={"Default branch of " + row.fullName}>
  {heading !== undefined
   ? <><h2>{heading}</h2><p>Rovara found no files on any branch of <VisibleText text={row.fullName} />. Push your code to GitHub, then check again.</p></>
   : top !== undefined
    ? <><h2>{name(row.branch)} {notice.kind === "missing" ? "isn't in this repository" : "is empty"}; use {name(top.name)} instead?</h2><p><VisibleText text={row.fullName} /> {notice.kind === "missing" ? "has no branch with that name" : <>has no files on {name(row.branch)}</>}. {name(top.name)} has code{top.lastCommitAt === undefined ? "" : <>, last changed {top.lastCommitAt.slice(0, 10)}</>}.</p></>
    : <><h2>{name(row.branch)} {notice.kind === "missing" ? "isn't in this repository" : "is empty"}.</h2><p>Rovara didn't find another branch with code{row.searchedAll ? "" : " among the first branches it looked at"}. Name the branch to use, or check again once code is pushed.</p></>}
  <div className="rv-branch-actions">
   {top !== undefined && <Button variant="primary" busy={busy === "use:" + row.repository} disabled={busy !== undefined && busy !== "use:" + row.repository} onClick={() => { void onUse(row, top.name); }}>Use {top.name.length > 40 ? top.name.slice(0, 40) + "…" : top.name}</Button>}
   <Button disabled={busy !== undefined} onClick={onAgain}>Check again</Button>
   <Button variant="quiet" busy={busy === "go:" + row.repository} disabled={busy !== undefined && busy !== "go:" + row.repository} onClick={() => { void onContinue(row); }}>Continue anyway</Button>
  </div>
  {rest.length > 0 && <fieldset><legend>Or pick another branch with code</legend>{rest.map(candidate => <label className="rv-onboarding-choice" key={candidate.name}><input type="radio" name={"branch-" + row.repository} value={candidate.name} checked={picked === candidate.name} onChange={() => { setPicked(candidate.name); }} /><VisibleText text={candidate.name} />{candidate.lastCommitAt !== undefined && <span className="rv-muted"> last changed {candidate.lastCommitAt.slice(0, 10)}</span>}</label>)}<Button disabled={picked === undefined || busy !== undefined} onClick={() => { if (picked !== undefined) void onUse(row, picked); }}>Use the selected branch</Button></fieldset>}
  {notice.kind !== "no_code" && top === undefined && <ChangeBranch row={row} busy={busy === "use:" + row.repository} onUse={branch => onUse(row, branch)} />}
 </section>;
}
