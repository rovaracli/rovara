import { useState } from "react";
import { setupItemsOf, type SetupAgentView, type SetupConfirmReply } from "@agentx/contracts/web";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Checkbox } from "../../design/Checkbox.js";
import { VisibleText } from "../../design/VisibleText.js";
import { VERDICT_WORDS } from "../setup/words.js";
import { ACTIONS, FOUND } from "./setup-tab-text.js";

type Ready = SetupAgentView & { proposal: NonNullable<SetupAgentView["proposal"]> };

/**
 * "The setup Rovara found" (3.9, card 1): the commands, grouped To install and To test, each with whether the code host still shows what it cited, then one line on what happens next, and "Check this setup". Checking it
 * PROPOSES the ticked commands and starts the check on a second machine; it applies nothing. An item that does not match the code says which command Rovara could not find and can be ticked after that warning; the second machine still checks it. The button is primary only when the status card has no primary of its own, and when it is disabled a line says why.
 */
export function FoundSetupCard({ project, view, settingsRevision, onProposed, primary }: { project: string; view: Ready; settingsRevision: number; onProposed: () => void; primary: boolean }) {
  const api = useSetupAgentApi();
  const items = setupItemsOf(view.proposal).filter(item => item.kind === "setup" || item.kind === "tests");
  const verdict = (id: string) => view.verification?.[id] ?? "unchecked";
  const [chosen, setChosen] = useState<Record<string, boolean>>({}), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<SetupConfirmReply>();
  // Only what the code host confirmed is ticked to begin with; an item that could not be checked against a file, or does not match the code, can be ticked by the person after the warning beside it.
  const on = (id: string) => chosen[id] ?? verdict(id) === "verified";
  const ids = items.filter(item => on(item.id)).map(item => item.id);
  const anyway = ids.filter(id => verdict(id) === "unverified");
  const checked = view.verified === true;
  const noInstall = ids.some(id => items.find(item => item.id === id)?.kind === "tests") && !ids.some(id => items.find(item => item.id === id)?.kind === "setup");
  const why = !checked ? undefined : ids.length === 0 ? FOUND.tickOne : undefined;
  async function use() {
    setBusy(true); setError(undefined);
    try { setDone(await api.confirm(project, { requestId: crypto.randomUUID(), expectedRevision: settingsRevision, itemIds: ids, ...(anyway.length === 0 ? {} : { useAnyway: anyway }) })); onProposed(); } catch (caught) { setError(caught instanceof ApiError ? caught.message : "Couldn't check this setup. Try again."); } finally { setBusy(false); }
  }
  const group = (kind: "setup" | "tests", title: string) => {
    const part = items.filter(item => item.kind === kind);
    if (part.length === 0) return null;
    return <div className="rv-setup-found-group" data-testid={`found-${kind}`}>
      <h4>{title}</h4>
      <ul>{part.map(item => {
        const value = item.proposed.value as { repo: string; commands: string[] };
        const word = verdict(item.id);
        const unmatched = view.unmatched?.[item.id];
        return <li key={item.id}>
          <Checkbox label={value.repo} checked={on(item.id)} disabled={done !== undefined} onCheckedChange={next => { setChosen({ ...chosen, [item.id]: next === true }); }} />
          <ul className="rv-setup-found-commands" aria-label={`Commands in ${value.repo}`}>{value.commands.map(line => <li key={line}><code><VisibleText text={line} /></code></li>)}</ul>
          {word === "unverified"
            ? <><p className="rv-muted" data-testid="found-unmatched">{unmatched === undefined ? FOUND.unmatchedUnknown : <>{FOUND.unmatchedBefore}<code><VisibleText text={unmatched} /></code>{FOUND.unmatchedAfter}</>}</p><p role="note" data-testid="found-anyway">{on(item.id) ? FOUND.chosenAnyway : unmatched === undefined ? FOUND.useAnywayUnknown : FOUND.useAnyway}</p></>
            : <p className="rv-muted">{VERDICT_WORDS[word]}</p>}
        </li>;
      })}</ul>
    </div>;
  };
  return <section id="setup-found" className="rv-setup-card rv-setup-card-quiet" aria-labelledby="rv-setup-found-title" data-testid="setup-found">
    <h3 id="rv-setup-found-title">{FOUND.heading}</h3>
    {items.length === 0 ? <p>{FOUND.none}</p> : <>{group("setup", FOUND.install)}{group("tests", FOUND.test)}</>}
    {!checked && <p id="found-why" role="status" className="rv-muted">{FOUND.checking}</p>}
    {done === undefined
      ? <>
        {noInstall && <p role="note" data-testid="found-no-install">{FOUND.noInstall}</p>}
        <p className="rv-muted" data-testid="found-next">{FOUND.next(project)}</p>
        <div className="rv-setup-card-actions"><Button variant={primary ? "primary" : "secondary"} busy={busy} disabled={!checked || ids.length === 0} aria-describedby={checked && why === undefined ? undefined : "found-why"} data-testid="found-check" onClick={() => { void use(); }}>{ACTIONS.checkSetup}</Button></div>
        {why !== undefined && <p id="found-why" className="rv-muted" data-testid="found-why">{why}</p>}
      </>
      : <><p role="status" data-testid="found-saved">{FOUND.saved}</p>{done.left.length > 0 && <ul aria-label="Left out">{done.left.map(left => <li key={`${left.id}-${left.reason}`}><VisibleText text={left.id} />: {FOUND.leftOut[left.reason]}</li>)}</ul>}</>}
    {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  </section>;
}
