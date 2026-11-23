import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GraduationCard, GraduationTarget } from "../../../api/graduation.js";
import { GRADUATION_TITLE, NOT_NOW, PATHS_HELP, SAME_CHOICE_WORDS, TARGET_BUTTON_WORDS, TARGET_WORDS, WAITING_WORDS, firstChoiceWords, graduatedWords, needsWords, parsePaths, plainPath, provenWords, whereWords } from "../../../api/graduation.js";
import { useLearnedApi } from "../../../api/learned.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { Button } from "../../../design/Button.js";
import { Checkbox } from "../../../design/Checkbox.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { failureWords, refreshIfStale, refreshLessons } from "./graduation-shared.js";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PATHS_MAX = 20;

/** The week's one "Make this permanent?" card: why it is proven, where it applies, where it can go, and what each answer does. Only shown for people who decide. */
export function GraduationCardView({ project, card }: { project: string; card: GraduationCard }) {
  const api = useLearnedApi(), query = useQueryClient(), announce = useAnnounce();
  const dynamicPaths = card.paths.some(one => /[{}[\]]/u.test(one));
  const targets = dynamicPaths ? card.targets.filter(one => one !== "rule") : card.targets;
  // A rule can only narrow the lesson's own paths: they are offered as chips, all chosen. Only a lesson with no paths gets a free field (it may be narrowed to any).
  const [target, setTarget] = useState<GraduationTarget>(targets.includes(card.target) ? card.target : targets[0] ?? "check"), [pathsText, setPathsText] = useState(""), [kept, setKept] = useState<ReadonlySet<string>>(new Set(card.paths)), [name, setName] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "waiting"; text: string } | { kind: "error"; text: string }>({ kind: "idle" });
  const own = card.paths.length > 0, paths = own ? card.paths.filter(one => kept.has(one)) : parsePaths(pathsText);
  const pathsError = target !== "rule" ? undefined : own ? (paths.length === 0 ? "Keep at least one path, or choose another place." : undefined) : paths.length > PATHS_MAX ? `At most ${String(PATHS_MAX)} paths.` : paths.some(one => !plainPath(one)) ? "Use plain paths such as src/billing/**, with no leading slash and no \"..\"." : undefined;
  const nameError = target === "skill" && name.trim() !== "" && !SKILL_NAME.test(name.trim()) ? "Use lowercase letters, numbers and hyphens, up to 64 characters." : undefined;
  const needs = needsWords(card.needs), asked = card.needs.you, busy = state.kind === "busy", closed = state.kind === "done" || state.kind === "waiting";
  async function make() {
    if (busy || closed || asked || pathsError !== undefined || nameError !== undefined) return;
    setState({ kind: "busy" });
    try {
      const answer = await api.graduate(project, card.lessonId, { target, ...(target === "rule" && paths.length > 0 ? { paths } : {}), ...(target === "skill" && name.trim() !== "" ? { name: name.trim() } : {}) });
      const text = graduatedWords(answer);
      setState(answer.state === "waiting" ? { kind: "waiting", text } : { kind: "done", text });announce(`${card.title}: ${text}`);refreshLessons(query, project);
    } catch (failure) { setState({ kind: "error", text: failureWords(failure, "That didn't go through. Reload to check where it stands.") });refreshIfStale(failure, query, project, announce); }
  }
  async function later() {
    if (busy || closed) return;
    setState({ kind: "busy" });
    try { await api.graduateLater(project, card.lessonId);const text = "Okay. Rovara won't ask about this lesson again for 60 days.";setState({ kind: "done", text });announce(text);refreshLessons(query, project); }
    catch (failure) { setState({ kind: "error", text: failureWords(failure, "That didn't go through. Reload to check where it stands.") });refreshIfStale(failure, query, project, announce); }
  }
  return <article className="rv-permanent" aria-labelledby="permanent-title" data-testid="permanent-card">
    <h3 id="permanent-title">{GRADUATION_TITLE}</h3>
    <p className="rv-permanent-lesson"><b><VisibleText text={card.title} /></b></p>
    {card.description !== "" && <p className="rv-lesson-description"><VisibleText text={card.description} /></p>}
    <ul className="rv-lesson-facts"><li data-testid="permanent-proven">{provenWords(card)}</li><li data-testid="permanent-where"><VisibleText text={whereWords(card.paths)} /></li>{needs !== undefined && <li data-testid="permanent-needs">{needs}</li>}</ul>
    {closed ? <p role="status" className="rv-learned-note" data-testid="permanent-result"><VisibleText text={state.text} /></p> : <>
      <fieldset className="rv-permanent-targets" disabled={busy}>
        <legend>Where should it go?</legend>
        <div className="rv-choices">{targets.map(one => <label key={one} className="rv-choice"><input type="radio" name={"permanent-target-" + project} value={one} checked={target === one} onChange={() => setTarget(one)} /><span>{TARGET_WORDS[one]}{one === card.target ? " (suggested)" : ""}</span></label>)}</div>
      </fieldset>
      {dynamicPaths && <p className="rv-muted">Team rules need plain file paths, so this one can't become a rule.</p>}
      {target === "rule" && own && <fieldset className="rv-permanent-paths" disabled={busy}><legend>Code paths it applies to</legend>
        <ul className="rv-tidy-list" aria-label="Code paths">{card.paths.map(path => <li key={path}><Checkbox label={visibleText(path)} checked={kept.has(path)} disabled={busy} onCheckedChange={value => setKept(old => { const next = new Set(old); if (value === true) next.add(path); else next.delete(path); return next; })} /></li>)}</ul>
        <p className="rv-muted">A rule can only keep some of the lesson's own paths. It can't widen them.</p>{pathsError !== undefined && <p role="alert" className="rv-lesson-failed">{pathsError}</p>}</fieldset>}
      {target === "rule" && !own && <TextArea label="Code paths it applies to" hint={PATHS_HELP + " Leave empty for the whole project."} rows={3} value={pathsText} disabled={busy} {...(pathsError === undefined ? {} : { error: pathsError })} onChange={event => setPathsText(event.target.value)} />}
      {target === "skill" && <TextField label="Skill name (optional)" hint="Lowercase letters, numbers and hyphens." value={name} disabled={busy} {...(nameError === undefined ? {} : { error: nameError })} onChange={event => setName(event.target.value)} />}
      {target === "check" && <p className="rv-muted">Rovara writes a draft task you start yourself. Nothing starts by itself.</p>}
      {asked && <p className="rv-muted" data-testid="permanent-you-asked">{WAITING_WORDS}.</p>}
      {!asked && card.needs.required >= 2 && card.needs.have >= 1 && <p className="rv-muted" data-testid="permanent-same-choice">{SAME_CHOICE_WORDS}{card.needs.first !== undefined && <> <VisibleText text={firstChoiceWords(card.needs.first)} /></>}</p>}
      <div className="rv-lesson-actions">
        <Button variant="primary" busy={busy} disabled={asked || pathsError !== undefined || nameError !== undefined} onClick={() => { void make(); }}>{asked ? "You already asked" : TARGET_BUTTON_WORDS[target]}</Button>
        <Button variant="quiet" disabled={busy} onClick={() => { void later(); }}>{NOT_NOW}</Button>
      </div>
    </>}
    {state.kind === "error" && <p role="alert" className="rv-lesson-failed"><VisibleText text={state.text} /></p>}
  </article>;
}
