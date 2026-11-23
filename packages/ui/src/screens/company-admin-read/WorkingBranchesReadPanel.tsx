import { useEffect, useRef, type ReactNode } from "react";
import type { AppProjectDetail } from "@agentx/contracts/web";
import { HeldState } from "../../design/HeldState.js";
import { VisibleText } from "../../design/VisibleText.js";
import { Fact, Facts, ReadSection } from "./parts.js";
import "./company-admin-read.css";

type Repo = AppProjectDetail["repositories"][number];
type Saved = NonNullable<AppProjectDetail["savedWorkingBranches"]>;

/**
 * G1 "Working branches", a panel inside the project page (/app/admin/projects/:name). It draws the project read that page already made (no second read, and
 * the page's own authority: a project maintainer who is not a company admin keeps it). A saved branch is shown only when the read carries the list; a read
 * without it is one quiet Unknown, never "the default branch". The live inspection and Save controls are passed in unchanged as `children`.
 */
export function WorkingBranchesReadPanel({ repositories, saved, children }: { repositories: readonly Repo[]; saved: Saved | undefined; children?: ReactNode }) {
 const savedFor = (repo: Repo) => saved?.filter(item => item.repository === repo.name) ?? [];
 // Keeps the live page's behaviour: when a save is confirmed and the read moves on, focus goes to the first saved-branch line.
 const signature = (saved ?? []).map(item => `${item.repository}:${item.branch}:${item.commit}`).join("\n"), previous = useRef(signature), first = useRef<HTMLParagraphElement>(null);
 useEffect(() => { if (previous.current !== signature && signature !== "") first.current?.focus(); previous.current = signature; }, [signature]);
 let firstSaved = true;
 return <section id="working-branches" className="rv-company-admin-read rv-car-panel" aria-labelledby="rv-car-working-branches">
  <h2 className="rv-car-panel-title" id="rv-car-working-branches">Working branches</h2>
  {repositories.length === 0 ? <p className="rv-car-quiet-card">No repositories returned. Repository connection status is unavailable here.</p> : <ul className="rv-car-repos rv-car-rows" aria-label="Repository branches">{repositories.map((repo, i) => <li key={repo.name ?? `${repo.fullName}:${i}`}>
   <div className="rv-car-row-main"><h3><VisibleText text={repo.fullName} /></h3>
    <p>GitHub default branch <code><VisibleText text={repo.defaultBranch} /></code></p>
    {saved !== undefined && (savedFor(repo).length === 0 ? <p>Using GitHub default branch</p> : savedFor(repo).map(item => { const mine = firstSaved; firstSaved = false; return <p key={item.repository} ref={mine ? first : undefined} tabIndex={-1}>Saved working branch <VisibleText text={item.branch} /> @ <span className="rv-car-nowrap"><code title={item.commit}>{item.commit.slice(0, 12)}</code>.</span> Not used by tasks yet; tasks start from the GitHub default branch.</p>; }))}</div>
  </li>)}</ul>}
  <ReadSection title="Which branch a task uses">
   <section className="rv-car-card" aria-label="Which branch a task uses"><Facts>
    <Fact label="Tasks start from">{repositories.length === 1 ? <><code><VisibleText text={repositories[0]!.defaultBranch} /></code>, the GitHub default branch</> : "The GitHub default branch of each repository"}</Fact>
    <Fact label="Saved branch">{saved === undefined ? <HeldState /> : saved.length === 0 ? "None saved" : `${saved.length} saved, not used by tasks yet`}</Fact>
   </Facts></section>
  </ReadSection>
  {saved === undefined && <p className="rv-car-note">Rovara can&apos;t tell yet which working branch is saved. A saved branch is not used by tasks yet; tasks start from the GitHub default branch.</p>}
  {children}
 </section>;
}
