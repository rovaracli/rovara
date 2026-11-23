// Account (board account / mock 25b). G5 ship: the live actions of the old "Your account" page live here, each with its own handler unchanged:
// Change name (the shell's NameForm, PUT /v1/app/me/name), Appearance (this browser's theme), Connected sign-ins (Connect / Unlink),
// and Don't learn from my Slack messages. Your GitHub account's Connect / Unlink are on its own page (/app/account/github).
import { useState } from "react";
import { Navigate, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ScriptTokenMetadataListSchema, isPlaceholderDisplayName } from "@agentx/contracts/web";
import { useTheme, type ThemePreference } from "../../theme.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { PageHeader } from "../../design/PageHeader.js";
import { NameForm } from "../../shell/NameForm.js";
import { ConnectedSignIns } from "../account/ConnectedSignIns.js";
import { SlackLearningSwitch } from "../account/SlackLearningSwitch.js";
import { NameReadRow } from "./NameReadRow.js";
import { GithubLinkReadPanel } from "./GithubLinkReadPanel.js";
import { Foot, GuardedSubmit, LinkRow, Pill, Row, Rows, Section, Unknown, VisibleText } from "./parts.js";
import { ReconnectingLine } from "./reconnecting.js";
import { COULDNT_REFRESH, rereadFailed, servedFacts, useNoteWrite, useReadIdentity, useScopedRead, useWritable } from "./read-model.js";

const ROLE = { owner: "Owner", admin: "Admin", member: "Member" } as Record<string, string>;
const WHEN = [
 ["A decision is waiting for you", "Plan approvals, merges, site requests"],
 ["A task you own is blocked or failed", "With the reason and the next step"],
 ["A task you own finished", "Merged, closed or answered"],
] as const;
const THEMES: readonly (readonly [ThemePreference, string])[] = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
/** GitHub's return and the old "?github=connect" address now belong to Your GitHub account; the query is kept. */
const GITHUB_KEYS = ["github_link", "github"] as const;
export function AccountReadScreen() {
 const location = useLocation(), params = new URLSearchParams(location.search);
 if (GITHUB_KEYS.some(key => params.has(key))) return <Navigate to={{ pathname: "/app/account/github", search: location.search }} replace />;
 return <AccountBody />;
}
function ChangeName() {
 const { developer } = useReadIdentity(), cache = useQueryClient(), noteWrite = useNoteWrite();
 const [open, setOpen] = useState(false), [saved, setSaved] = useState<{ refreshFailed: boolean }>();
 // Writes follow the one rule (useWritable): the button is offered, and a Save name is sent, only while who you are is a fresh read.
 const writable = useWritable();
 return <>
  {writable && <Button onClick={() => { setSaved(undefined); setOpen(true); }}>{developer.nameChosen === false || isPlaceholderDisplayName(developer.name) ? "Choose a name" : "Change name"}</Button>}
  <Dialog className="g5-dialog" title="Your name" description="Shown on tasks you start, on your decisions and comments, and in Company, People. It is not your sign-in." open={open} onOpenChange={setOpen}>
   {open && <GuardedSubmit allowed={() => writable}><NameForm label="Your name" initial={isPlaceholderDisplayName(developer.name) ? "" : developer.name} submit="Save name" onSaved={() => { noteWrite(); setOpen(false); setSaved({ refreshFailed: false }); void rereadFailed(cache, { queryKey: ["g5-account-setup"] }).then(refreshFailed => { setSaved({ refreshFailed }); }); }} secondary={<Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>} /></GuardedSubmit>}
  </Dialog>
  {saved !== undefined && <span className="g5-sr" role="status">{saved.refreshFailed ? `Your name is saved. ${COULDNT_REFRESH}` : "Your name is saved."}</span>}
 </>;
}
function Appearance() {
 const theme = useTheme();
 return <li className="g5-row" aria-label="Appearance">
  <div className="g5-row-main"><h3>Appearance</h3><p className="g5-row-detail">This browser only</p></div>
  <div className="g5-row-aside"><fieldset className="g5-segmented"><legend className="g5-sr">Appearance</legend>{THEMES.map(([value, word]) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme.preference === value} onChange={() => theme.setPreference(value)} /><span>{word}</span></label>)}</fieldset></div>
 </li>;
}
function AccountBody() {
 const me = useReadIdentity();
 const keys = useScopedRead("/v1/app/script-tokens", ScriptTokenMetadataListSchema);
 const role = me.developer.orgRole, email = me.developer.email;
 // The shared policy decides what is still shown of the keys list (the last good read after a failed re-read; nothing after an access signal).
 const keyFacts = servedFacts(keys).data;
 const activeKeys = keyFacts?.tokens.filter(key => key.status === "active").length;
 return <>
  <PageHeader title="Account" description={`${email === undefined ? "" : `${email} · `}${role} of ${me.org.name} · everything here is yours alone`} />
  <ReconnectingLine />
  <section className="g5-main g5-stack rv-account" aria-label="Your account">
   <Section title="You"><Rows>
    <NameReadRow action={<ChangeName />} />
    {email === undefined
     ? <Row title="Email" chip={<Unknown />} />
     : <Row title={<VisibleText text={email} />} detail="Comes from your sign-in. It can't be edited here." />}
    <Appearance />
   </Rows></Section>
   <Section title="Signing in and identities">
    <ConnectedSignIns />
    <Rows label="Identities">
    <GithubLinkReadPanel />
    <LinkRow to="/app/account/automation-keys" title="Automation keys" detail="Keys that let scripts act as you in chosen projects" {...(activeKeys === undefined ? {} : { aside: `${activeKeys} active` })} />
   </Rows></Section>
   <Section title="Your companies">
    <Rows>
     <Row title={<VisibleText text={me.org.name} />} detail={ROLE[role] ?? role} chip={<Pill tone="info">Current</Pill>} />
     <Row title="Other companies" chip={<Unknown />} />
    </Rows>
    <Foot>Each company has its own Inbox, Work, Projects and Company. A person in one company sees no list here.</Foot>
   </Section>
   <Section title="What Rovara tells you, and where">
    <div className="g5-table"><div className="rv-table-wrap rv-table-v2-wrap"><table className="rv-table rv-table-v2" aria-label="What Rovara tells you, and where">
     <thead><tr><th scope="col">When</th><th scope="col">Inbox</th></tr></thead>
     <tbody>{WHEN.map(([title, detail]) => <tr key={title}>
      <td><strong>{title}</strong><span className="g5-sub">{detail}</span></td>
      <td data-muted>Always</td>
     </tr>)}</tbody>
    </table></div></div>
    <p className="g5-unknown-line">Slack copy of each message <Unknown /></p>
    <Foot>Inbox always has everything; only the Slack copy can be turned off. Rovara sends no email.</Foot>
   </Section>
   <Section title="Learning"><Rows>
    <SlackLearningSwitch />
   </Rows></Section>
  </section>
 </>;
}
