import { useState } from "react";
import { setupItemsOf, type SetupAgentView, type SetupConfirmReply } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { CONFIRM_WORDS, MISMATCH_WORDS, REVIEW_WORDS, VERDICT_WORDS } from "./words.js";

type Ready = SetupAgentView & { proposal: NonNullable<SetupAgentView["proposal"]> };

/**
 * "Use this setup": the commands Rovara found, each with whether the code host still shows what it cited. Using it PROPOSES the ticked commands as the project's test environment and applies nothing: the page says so,
 * and the next steps (settings, the setup check on a fresh machine, the Prove, approval) are the test environment section's. An item that does not match the code says which command Rovara could not find and can be ticked after that warning, as on the Setup tab's card; the second machine still checks it.
 */
export function ConfirmCard({ project, view, settingsRevision, onProposed, place = "step" }: { project: string; view: Ready; settingsRevision: number; onProposed: () => void; /** "checklist": the card is in the checklist's Setup run row, where the check starts by itself and the approval is right below, so the words say that. */ place?: "step" | "checklist" }) {
  const api = useSetupAgentApi();
  const items = setupItemsOf(view.proposal).filter(item => item.kind === "setup" || item.kind === "tests");
  const verdict = (id: string) => view.verification?.[id] ?? "unchecked";
  const [chosen, setChosen] = useState<Record<string, boolean>>({}), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<SetupConfirmReply>();
  // Only what the code host confirmed is ticked to begin with; an item that could not be checked against a file, or does not match the code, can be ticked by the person after the warning beside it.
  const on = (id: string) => chosen[id] ?? verdict(id) === "verified";
  const ids = items.filter(item => on(item.id)).map(item => item.id);
  const anyway = ids.filter(id => verdict(id) === "unverified");
  const checked = view.verified === true;
  async function use() {
    setBusy(true); setError(undefined);
    try { setDone(await api.confirm(project, { requestId: crypto.randomUUID(), expectedRevision: settingsRevision, itemIds: ids, ...(anyway.length === 0 ? {} : { useAnyway: anyway }) })); onProposed(); } catch (caught) { setError(caught instanceof ApiError ? caught.message : "Couldn't use this setup. Try again."); } finally { setBusy(false); }
  }
  return <section aria-label="Use this setup" className="rv-proposal-card">
    <h4>What Rovara found</h4>
    {view.summary !== undefined && <p className="rv-proposal-meta">{view.summary.commandsRun} commands run.</p>}
    {items.length === 0 ? <p>Rovara found no setup or test commands to use.</p> : <ul>
      {items.map(item => {
        const value = item.proposed.value as { repo: string; commands: string[] };
        const word = verdict(item.id);
        const unmatched = view.unmatched?.[item.id];
        return <li key={item.id} className="rv-proposal-item">
          <label className="rv-onboarding-choice"><input type="checkbox" checked={on(item.id)} disabled={done !== undefined} onChange={event => { setChosen({ ...chosen, [item.id]: event.target.checked }); }} />
            <span>{item.kind === "setup" ? "Setup" : "Tests"} in <VisibleText text={value.repo} />: {value.commands.map(line => <code key={line}><VisibleText text={line} /> </code>)}</span></label>
          {word === "unverified"
            ? <><p className="rv-proposal-meta" data-testid="confirm-unmatched"><span>{unmatched === undefined ? MISMATCH_WORDS.unknown : <>{MISMATCH_WORDS.before}<code><VisibleText text={unmatched} /></code>{MISMATCH_WORDS.after}</>}</span></p><p role="note" data-testid="confirm-anyway">{on(item.id) ? MISMATCH_WORDS.chosenAnyway : unmatched === undefined ? MISMATCH_WORDS.useAnywayUnknown : MISMATCH_WORDS.useAnyway}</p></>
            : <p className="rv-proposal-meta"><span>{VERDICT_WORDS[word]}</span></p>}
        </li>;
      })}
    </ul>}
    <p>{place === "checklist" ? REVIEW_WORDS.confirmRule : CONFIRM_WORDS.rule}</p>
    {!checked && <p id="confirm-why" role="status">{CONFIRM_WORDS.checking}</p>}
    {done === undefined
      ? <><Button variant="primary" busy={busy} disabled={!checked || ids.length === 0} aria-describedby={checked && ids.length > 0 ? undefined : "confirm-why"} onClick={() => { void use(); }}>Use this setup</Button>{checked && ids.length === 0 && <p id="confirm-why" className="rv-proposal-meta" data-testid="confirm-why">{MISMATCH_WORDS.tickOneUse}</p>}</>
      : <><p role="status">{place === "checklist" ? REVIEW_WORDS.confirmNext : CONFIRM_WORDS.next}</p>{done.left.length > 0 && <ul aria-label="Left out">{done.left.map(left => <li key={`${left.id}-${left.reason}`}><VisibleText text={left.id} />: {CONFIRM_WORDS.leftOut[left.reason]}</li>)}</ul>}</>}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  </section>;
}
