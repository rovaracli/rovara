import { useState } from "react";
import { Link } from "react-router";
import { setupItemsOf, type SetupApplyResponse, type SetupApplyResultItem, type SetupDraftResponse, type SetupItem, type SetupReviewEntry } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { paths } from "../../../paths.js";
import { isConfirmUrl } from "../../../text/links.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";

type Ready = SetupDraftResponse & { proposal: NonNullable<SetupDraftResponse["proposal"]> };
type Choice = { id: string; useSuggestion?: boolean };

/** The section an item is listed under, in the order the page shows them. */
const SECTIONS: ReadonlyArray<{ title: string; kinds: readonly SetupItem["kind"][] }> = [
  { title: "Setup and test commands", kinds: ["setup", "tests"] },
  { title: "Dev container", kinds: ["devcontainer"] },
  { title: "Repositories to add", kinds: ["repository"] },
  { title: "Websites the setup needs", kinds: ["allowed_domain"] },
  { title: "Secrets it needs (names only)", kinds: ["secret"] },
  { title: "Context sources found", kinds: ["source"] },
  { title: "Where work requests come from", kinds: ["intake"] },
  { title: "Checks and test environment", kinds: ["check", "test_environment"] },
  { title: "The team's knowledge Rovara found", kinds: ["knowledge", "spec_target"] },
];

/** What an item says, in the person's words. The value is a repository's text, so it is always shown through VisibleText. */
function valueLines(item: SetupItem): string[] {
  const value = item.proposed.value as Record<string, unknown> | string;
  if (typeof value === "string") return [value];
  switch (item.kind) {
    case "setup":
    case "tests": return [`In ${String(value["repo"])}:`, ...(value["commands"] as string[])];
    case "check": return [`${String(value["name"])} (${String(value["repo"])}): ${String(value["command"])}`];
    case "test_environment": return [String(value["hint"])];
    case "devcontainer": return [`${String(value["configPath"])} in ${String(value["repository"])}${value["exists"] === true ? " (already there)" : " (Rovara drafted this file)"}`];
    case "repository": return [`${String(value["name"])}: ${String(value["url"])}${typeof value["defaultBranch"] === "string" ? ` (${value["defaultBranch"]})` : ""}`];
    case "knowledge": return [`${String(value["kind"])}: ${String(value["path"])}`];
    case "spec_target": return [`${String(value["format"])} specs in ${String(value["path"])}`];
    case "source": return [`${String(value["name"])} (found in ${String(value["foundIn"]).replace("_", " ")})`];
    case "intake": return [`${String(value["channel"]).replace("_", " ")}: ${String(value["hint"])}`];
    case "secret": return [`${String(value["name"])}${String(value["why"]) === "" ? "" : `: ${String(value["why"])}`}`];
    default: return [];
  }
}

function Citations({ item }: { item: SetupItem }) {
  return <ul className="rv-proposal-from" aria-label="Where this came from">{item.proposed.from.map((place, index) => <li key={index}>
    {place.path === undefined ? <>Rovara concluded this: <VisibleText text={place.note ?? ""} /></> : <><VisibleText text={`${place.repo ?? ""}/${place.path}${place.line === undefined ? "" : `:${String(place.line)}`}`} />{place.quote !== undefined && <> <q><VisibleText text={place.quote} /></q></>}</>}
  </li>)}</ul>;
}

const VERIFICATION_WORDS = {
  verified: "Checked against the file",
  unverified: "Rovara could not find this in the file",
  unchecked: "Source not checked",
} as const;

/** Words for what happened to one item of an apply. */
export function resultWords(result: SetupApplyResultItem): string {
  switch (result.outcome) {
    case "applied": return result.pullRequest === undefined ? "Applied." : "Applied. A pull request is being opened.";
    case "already_set": return "The project already has this.";
    case "kept_yours": return "Kept your value. Tick \"Use Rovara's\" to replace it.";
    case "approval_needed": return "Waiting for an administrator to approve it.";
    case "website_proposal": return "Carry this to website access: websites are widened only through a proposal.";
    case "managed_by_file": return "The meta repo's config file manages this. Change it there.";
    case "unknown_item": return "This proposal has no such item.";
    case "failed": return "Rovara couldn't apply this item.";
    default: return result.message ?? "Rovara can't set this up from here yet.";
  }
}

export function ProposalReview({ project, response, busy, results, onApply }: {
  project: string; response: Ready; busy: boolean; results: SetupApplyResponse["results"] | undefined; onApply: (items: Choice[]) => void;
}) {
  const host = useAppHost();
  const { proposal } = response;
  const review = new Map((response.review ?? []).map((entry) => [entry.id, entry] as const));
  const items = setupItemsOf(proposal);
  // Only an item Rovara checked against the file (the quote it cites is in the file and holds the value), that sets something the project has no value for, starts ticked. A
  // citation with no quote shows nothing about a value, so an item that cites a file without one is never ticked for the person, whatever it is marked.
  const quotedFromFile = (item: SetupItem) => item.proposed.from.filter((place) => place.path !== undefined).every((place) => place.quote !== undefined && place.quote !== "") && item.proposed.from.some((place) => place.path !== undefined);
  const startsTicked = (item: SetupItem, entry: SetupReviewEntry | undefined) => entry !== undefined && entry.handling === "settings" && entry.unavailable === undefined && entry.verification === "verified" && quotedFromFile(item) && (entry.current === undefined || entry.current.state === "empty");
  const [ticked, setTicked] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((item) => [item.id, startsTicked(item, review.get(item.id))])));
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  const chosen = items.filter((item) => ticked[item.id] === true && review.get(item.id)?.handling === "settings" && review.get(item.id)?.unavailable === undefined);
  const resultOf = (id: string) => results?.find((result) => result.id === id);

  function row(item: SetupItem) {
    const entry = review.get(item.id);
    const handling = entry?.handling ?? "info";
    const result = resultOf(item.id);
    const differs = entry?.current?.state === "differs";
    const label = `${item.kind.replace("_", " ")}: ${valueLines(item)[0] ?? ""}`;
    const card = entry?.approval;
    return <li key={item.id} className="rv-proposal-item">
      {handling === "settings" && entry?.unavailable === undefined && <label className="rv-onboarding-choice"><input type="checkbox" checked={ticked[item.id] === true} onChange={(event) => setTicked({ ...ticked, [item.id]: event.target.checked })} aria-label={label} /><span><strong>{item.kind === "setup" ? "Setup" : item.kind === "tests" ? "Tests" : "Use"}</strong></span></label>}
      <div className="rv-proposal-value">{valueLines(item).map((line, index) => <p key={index}><VisibleText text={line} /></p>)}</div>
      <p className="rv-proposal-meta"><span>{VERIFICATION_WORDS[entry?.verification ?? "unchecked"]}</span> <span>Confidence: {item.proposed.confidence}</span></p>
      <Citations item={item} />
      {differs && <div role="note" className="rv-proposal-conflict"><p>You have: <VisibleText text={(entry?.current?.yours ?? []).join(" and ")} /></p><p>Rovara suggests: <VisibleText text={valueLines(item).slice(item.kind === "setup" || item.kind === "tests" ? 1 : 0).join(" and ")} /></p>
        <label className="rv-onboarding-choice"><input type="checkbox" checked={replace[item.id] === true} onChange={(event) => { setReplace({ ...replace, [item.id]: event.target.checked }); if (event.target.checked) setTicked({ ...ticked, [item.id]: true }); }} aria-label={`Use Rovara's for ${label}`} /><span>Use Rovara's</span></label></div>}
      {entry?.unavailable !== undefined && <p className="rv-proposal-unavailable"><VisibleText text={entry.unavailable} /></p>}
      {handling === "website_proposal" && <p>Websites are widened only through a proposal. <Link to={`${paths.admin.home}/projects/${encodeURIComponent(project)}`}>Open website access</Link> and add <VisibleText text={String(item.proposed.value)} />.</p>}
      {handling === "approval" && entry?.unavailable === undefined && <div className="rv-proposal-card" role="group" aria-label={`Approval for ${label}`}>
        <p>This needs an administrator's approval before it changes anything.</p>
        {(card === undefined || card.state === "declined" || card.state === "expired") && <Button busy={busy} onClick={() => onApply([{ id: item.id }])}>{card === undefined ? "Ask for approval" : "Ask again"}</Button>}
        {card?.state === "pending" && <><p role="status">Waiting for approval.</p>{result?.approval !== undefined && isConfirmUrl(result.approval.confirmUrl, host.origin) && <Button onClick={() => host.openExternal(result.approval!.confirmUrl)}>Open approval</Button>}<Button busy={busy} onClick={() => onApply([{ id: item.id }])}>Check approval</Button></>}
        {card?.state === "approved" && <><p role="status">Approved.</p><Button variant="primary" busy={busy} onClick={() => onApply([{ id: item.id }])}>Apply now</Button></>}
      </div>}
      {result !== undefined && <p role="status" className="rv-proposal-result"><VisibleText text={resultWords(result)} /></p>}
    </li>;
  }

  return <div className="rv-proposal">
    <p>Rovara read your repositories and suggests the following. Each suggestion says where it came from; nothing changes until you apply it.</p>
    {proposal.notes !== "" && <p className="rv-proposal-notes"><VisibleText text={proposal.notes} /></p>}
    {SECTIONS.map((section) => {
      const rows = items.filter((item) => section.kinds.includes(item.kind));
      return rows.length === 0 ? null : <fieldset key={section.title}><legend>{section.title}</legend><ul>{rows.map(row)}</ul></fieldset>;
    })}
    {proposal.flaggedCommands.length > 0 && <fieldset><legend>Commands Rovara will not propose</legend><p>These download and run a script. They are shown so you can see what the repository asks for, and cannot be applied.</p><ul>{proposal.flaggedCommands.map((flagged, index) => <li key={index}><code><VisibleText text={flagged.command} /></code> <VisibleText text={flagged.reason} /></li>)}</ul></fieldset>}
    {proposal.foundNotUsed.length > 0 && <fieldset><legend>Found, not used</legend><ul>{proposal.foundNotUsed.map((found, index) => <li key={index}><VisibleText text={`${found.kind === "hook" ? "Hooks" : "MCP server config"} in ${found.repo}/${found.path}`} />: {found.kind === "hook" ? "found, not run" : "found, not connected. Ask an administrator to connect a source."}</li>)}</ul></fieldset>}
    <Button variant="primary" busy={busy} disabled={chosen.length === 0} onClick={() => onApply(chosen.map((item) => ({ id: item.id, ...(replace[item.id] === true ? { useSuggestion: true } : {}) })))}>Apply selected</Button>
  </div>;
}
