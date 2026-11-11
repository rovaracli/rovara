import { setupItemsOf, type SetupAgentView } from "@agentx/cloud-contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { PARTIAL_WORDS, VERDICT_WORDS } from "./words.js";

type Stopped = SetupAgentView & { proposal: NonNullable<SetupAgentView["proposal"]>; stoppedBy: NonNullable<SetupAgentView["stoppedBy"]> };

/**
 * A run a person stopped keeps what it had (F5): shown as a read-only list marked "stopped by <person>". It has no tick box and no "Use this setup": it is not proven, and nothing here applies it. To use a
 * setup the person runs it again and lets it finish. Every name and command goes through VisibleText.
 */
export function PartialProposal({ view }: { view: Stopped }) {
  const items = setupItemsOf(view.proposal).filter(item => item.kind === "setup" || item.kind === "tests");
  const verdict = (id: string) => view.verification?.[id] ?? "unchecked";
  return <section aria-label="Stopped run" className="rv-proposal-card">
    <h4>{PARTIAL_WORDS.heading}</h4>
    <p role="status">Stopped by <VisibleText text={view.stoppedBy.name} />.</p>
    {items.length === 0 ? <p>{PARTIAL_WORDS.none}</p> : <ul>
      {items.map(item => {
        const value = item.proposed.value as { repo: string; commands: string[] };
        return <li key={item.id} className="rv-proposal-item">
          <span>{item.kind === "setup" ? "Setup" : "Tests"} in <VisibleText text={value.repo} />: {value.commands.map(line => <code key={line}><VisibleText text={line} /> </code>)}</span>
          <p className="rv-proposal-meta"><span>{VERDICT_WORDS[verdict(item.id)]}</span></p>
        </li>;
      })}
    </ul>}
    <p>{PARTIAL_WORDS.rule}</p>
  </section>;
}
