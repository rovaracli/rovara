// UX3: for each company settings page, what a change there affects and who can change it. One table, so the words are the same everywhere and a read-only viewer is
// told why. These are statements about rules the server already enforces; this file changes none of them.
export type SettingsRole = "owner" | "admin" | "member";
export interface SettingsArea { title: string; affects: string; who: string; changers: readonly SettingsRole[]; readOnly?: true }
export const SETTINGS_AREAS = {
  overview: { title: "Company settings", affects: "Nothing on this page changes anything. It links to every setting.", who: "Company owners and admins see this area.", changers: [], readOnly: true },
  people: { title: "People", affects: "Who can sign in and use Rovara for this company. Removing someone ends their access at once.", who: "Owners change roles and remove anyone. Admins can remove members but not owners or admins.", changers: ["owner", "admin"] },
  invites: { title: "Invites", affects: "Who can join the company, and with which role.", who: "Owners and admins create and revoke invites. Only owners can invite an admin.", changers: ["owner", "admin"] },
  roles: { title: "Roles", affects: "This page only explains roles. Change a person's role on the People page.", who: "Only owners change roles.", changers: [], readOnly: true },
  connections: { title: "Connections", affects: "What Rovara can reach for every project in the company: your code, AI provider, Slack, trackers and cloud tools.", who: "Owners and admins connect, check and remove connections. Changing one affects every project that uses it.", changers: ["owner", "admin"] },
  models: { title: "AI models", affects: "Which AI provider Rovara tries first for the whole company. Add a provider on the Connections page.", who: "Owners and admins can change the order.", changers: ["owner", "admin"] },
  money: { title: "Money and limits", affects: "How much AI work the company and its tasks may spend. A looser limit lets work run longer and cost more.", who: "Owners and admins edit task stops; a looser stop must be approved by a different owner or admin. The monthly base amounts are shown here but not edited on this page. Only owners turn enforcement on.", changers: ["owner", "admin"] },
  billing: { title: "Billing", affects: "Whether Rovara keeps working when the trial allowance is used up, and who is billed for AI models and machine time after that.", who: "Owners and admins can read this page and change it. Some changes need a sign-in from the last 10 minutes.", changers: ["owner", "admin"] },
  "how-we-work": { title: "How we work", affects: "The default steps, models, design review and learning rules for every project, unless a project is locked to a stricter choice.", who: "Owners and admins save company defaults. A less-safe change needs a different owner or admin to confirm it.", changers: ["owner", "admin"] },
  "company-rules": { title: "Company rules", affects: "The standing instructions every agent follows on every step of every task, in every project. A project's How we work can add to them or narrow them, never loosen them.", who: "Owners and admins propose changes. A different owner or admin has to approve one before it applies.", changers: ["owner", "admin"] },
  projects: { title: "Projects", affects: "Which repositories and people each project covers. Archiving stops new work in a project.", who: "Owners and admins are maintainers of every project and can change any of them.", changers: ["owner", "admin"] },
  "tracker-people": { title: "Tracker people", affects: "Which Linear or Jira person counts as which Rovara member, which decides whose tickets can start work.", who: "Owners and admins can map people.", changers: ["owner", "admin"] },
  "second-review": { title: "Second opinion", affects: "This page shows second-opinion reviews. It changes nothing.", who: "Owners and admins can read it.", changers: [], readOnly: true },
  "approval-window": { title: "Recent sign-in window", affects: "How recently a person must have signed in to Rovara before they can approve medium-risk work from chat or comments. A longer window means fewer interruptions and a weaker safeguard.", who: "Owners and admins can shorten it at once. Making it longer, up to 7 days, needs a second owner or admin to approve it.", changers: ["owner", "admin"] },
  audit: { title: "Audit", affects: "This page shows what happened and who did it. It changes nothing.", who: "Owners and admins can read it.", changers: [], readOnly: true },
  health: { title: "Health", affects: "This page shows whether Rovara's services are ready. It changes nothing.", who: "Owners and admins can read it. The people who run your Rovara install fix what it shows.", changers: [], readOnly: true },
  domains: { title: "Company domains", affects: "Whose email counts as the company's. That decides who can be linked to a tracker account.", who: "Only company owners can add or remove a domain.", changers: ["owner"] },
  "new-screens": { title: "Old screens", affects: "Whether everyone in the company gets a new screen (the default) or the old one. A change shows when people next open or reload the app.", who: "Company owners find this in Settings. Owners and admins can change it, after signing in within the last 10 minutes.", changers: ["owner", "admin"] },
  agents: { title: "Agents", affects: "This page shows agent versions and company guardrails. Change an agent from its own page.", who: "Owners and admins can read this page. Owners and admins can also change the company guardrails, but not from this page yet.", changers: [], readOnly: true },
  waiting: { title: "Waiting for people", affects: "These are requests that need a person to decide. Deciding one applies that change.", who: "You see the requests you are allowed to decide.", changers: ["owner", "admin", "member"] },
} as const satisfies Record<string, SettingsArea>;
export type SettingsAreaId = keyof typeof SETTINGS_AREAS;
const ROLE_WORDS: Record<SettingsRole, string> = { owner: "an owner", admin: "an admin", member: "a member" };
/** Why this viewer can't change the page, in words; undefined when they can (or when the page changes nothing for anyone). */
export function readOnlyReason(area: SettingsAreaId, role: SettingsRole): string | undefined {
  const entry: SettingsArea = SETTINGS_AREAS[area];
  if (entry.readOnly === true) return undefined;
  return entry.changers.includes(role) ? undefined : `You can't change this here. You are ${ROLE_WORDS[role]}. ${entry.who}`;
}
