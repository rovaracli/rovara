import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TeamRule } from "../../../api/graduation.js";
import { RULE_RETIRE_CONFIRM, TEAM_RULES_TITLE, whereWords } from "../../../api/graduation.js";
import { useGraduation, useLearnedApi, useLessonPages } from "../../../api/learned.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { Button } from "../../../design/Button.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { failureWords, refreshIfStale, refreshLessons } from "./graduation-shared.js";
import { servedReadState } from "../../../api/served-read.js";
import { RECONNECTING_TEXT, WriteRegion } from "../write-freeze.js";

function Rule({ project, rule, frozen }: { project: string; rule: TeamRule; frozen: boolean }) {
  const api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce(), frozenRef = useRef(frozen);
  // Rule 14: Retire needs the approved list AND the graduation read fresh; a click already in flight when either failed is refused here.
  useLayoutEffect(() => { frozenRef.current = frozen; });
  const [state, setState] = useState<{ kind: "idle" } | { kind: "confirming" } | { kind: "busy" } | { kind: "done" } | { kind: "error"; text: string }>({ kind: "idle" });
  async function retire() {
    if (frozenRef.current) { setState({ kind: "error", text: RECONNECTING_TEXT });return; }
    setState({ kind: "busy" });
    try { await api.retireRule(project, rule.id);setState({ kind: "done" });announce("Rule retired. Rovara no longer adds it to tasks.");refreshLessons(query, project); }
    catch (failure) { setState({ kind: "error", text: failureWords(failure, "That didn't go through. Reload to check where it stands.") });refreshIfStale(failure, query, project, announce); }
  }
  const busy = state.kind === "busy";
  return <li><article className="rv-lesson" data-rule-id={rule.id}>
    <p className="rv-lesson-description" data-testid="rule-text"><VisibleText text={rule.text} /></p>
    <ul className="rv-lesson-facts"><li><VisibleText text={whereWords(rule.paths)} /></li>{rule.repos.length > 0 && <li><VisibleText text={"Repositories: " + rule.repos.join(", ")} /></li>}</ul>
    {state.kind === "done" ? <p role="status" className="rv-learned-note">Retired. Rovara no longer adds it to tasks.</p>
      : state.kind === "confirming" || busy ? <div className="rv-lesson-actions" role="group" aria-label="Confirm retiring this rule">
        <p>{RULE_RETIRE_CONFIRM}</p>
        <Button variant="danger" busy={busy} onClick={() => { void retire(); }}>Retire rule</Button>
        <Button variant="quiet" disabled={busy} onClick={() => setState({ kind: "idle" })}>Cancel</Button></div>
      : <div className="rv-lesson-actions"><Button variant="quiet" aria-label={visibleText(`Retire rule: ${rule.text.slice(0, 60)}`)} onClick={() => setState({ kind: "confirming" })}>Retire</Button></div>}
    {state.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={state.text} /></p>}
  </article></li>;
}

/** "Team rules in use": the live rules lessons became, for people who decide, each with its words, where it applies and Retire with one confirm. */
export function TeamRules({ project }: { project: string }) {
  const approved = useLessonPages(project, "approved"), approvedRead = servedReadState(approved), canDecide = approvedRead.data?.pages[0]?.canDecide === true;
  const read = useGraduation(project, canDecide), graduation = servedReadState(read);
  if (!canDecide || graduation.data === undefined || !graduation.data.canDecide || graduation.data.rules.length === 0) return null;
  // Kept facts after a failed re-read of EITHER read never grant a write.
  const stale = approvedRead.staleSince !== undefined || graduation.staleSince !== undefined;
  return <section className="rv-team-rules" aria-labelledby="team-rules-title" data-testid="team-rules"><WriteRegion stale={stale}>
    <h3 id="team-rules-title">{TEAM_RULES_TITLE}</h3>
    <ul className="rv-learned-list" aria-label={TEAM_RULES_TITLE}>{graduation.data.rules.map(rule => <Rule key={rule.id} project={project} rule={rule} frozen={stale} />)}</ul>
  </WriteRegion></section>;
}
