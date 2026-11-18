// Your account (Hybrid 1, DEC 223): your name, how the app looks, your connected sign-ins and GitHub account, and automation keys.
// Owner DEC 254zzz73 removed step-up ("confirm it's you"), and with it the confirmation email and passkeys this page used to list.
import { Link } from "react-router";
import { isPlaceholderDisplayName } from "@agentx/contracts/web";
import { useTheme, type ThemePreference } from "../../theme.js";
import { PageHeader } from "../../design/PageHeader.js";
import { NameForm } from "../../shell/NameForm.js";
import { AdminSection } from "../admin/parts.js";
import { ConnectedSignIns } from "./ConnectedSignIns.js";
import { SlackLearningSwitch } from "./SlackLearningSwitch.js";
import { GithubAccount } from "./GithubAccount.js";
import { useNav } from "./use-nav.js";
import "../admin/admin.css";

export function AccountScreen() {
 const nav = useNav(), theme = useTheme();
 return <section aria-label="Your account" className="rv-account">
  <PageHeader focusOnMount title="Your account" {...(nav === undefined ? {} : { description: `${nav.me.name} · ${nav.org.name}` })} />
  <AdminSection title="You">
   {nav !== undefined && <NameForm key={nav.me.name} label="Your name" initial={isPlaceholderDisplayName(nav.me.name) ? "" : nav.me.name} submit="Save name" />}
   <fieldset className="rv-theme-options"><legend>Appearance</legend>{(["system", "light", "dark"] as const).map((value: ThemePreference) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme.preference === value} onChange={() => theme.setPreference(value)} />{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</label>)}</fieldset>
   <SlackLearningSwitch />
  </AdminSection>
  <ConnectedSignIns />
  <GithubAccount />
  <AdminSection title="Automation keys"><p>Manage keys for your scripts and CI.</p><Link to="/app/account/automation-keys">Automation keys</Link></AdminSection>
 </section>;
}
