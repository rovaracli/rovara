// The words of the project People tab, the collaborator approvals switch and the product decisions panel (lane exp/project-people). Plain sentences; no jargon; a refusal from the server is always shown as it came.
import type { CloudProjectRole } from "@agentx/cloud-contracts/web";
import { PROJECT_PEOPLE_STALE_MESSAGE } from "@agentx/cloud-contracts/web";

export { PROJECT_PEOPLE_STALE_MESSAGE };
/** One line per role: what a person in it can do in this project. */
export const ROLE_HELP: Readonly<Record<CloudProjectRole, string>> = {
 maintainer: "Runs the project: starts work, approves plans and merges, changes settings and people.",
 contributor: "Starts work and approves their own tasks. Cannot change settings or people.",
 collaborator: "Reads the project's work, comments, asks Rovara, answers questions and can approve low-risk product decisions. Never starts coding work, merges or sees spending.",
 viewer: "Reads the project's work. Cannot start or change anything.",
};
export const sourceWords = (source: string): string => source === "grant" ? "Added to this project" : source === "org_role" ? "Company owner or admin" : "Through the project's channel";
export const ADD_UNAVAILABLE = "Everyone in the company who can be added is already on this project.";
export const NO_EDIT_NOTE = "Only a project maintainer, or a company owner or admin, can change who is on this project.";
/** Who a row's role is set by when it is not a grant the page can change. */
export const fixedRowWords = (source: string): string => source === "org_role" ? "Set by their company role" : "Set by the project's Slack channel";
export const LAST_MAINTAINER_HINT = "A project needs at least one maintainer.";
export const WAITING_FOR_ADMIN = "Waiting for an admin";
export const WAITING_FOR_ADMIN_BODY = "Turning on self-approval needs a company owner or admin to confirm it. Nothing changes until one does.";
export const OTHERS_SAVED = "Your other changes were saved."
export const MAINTAINER_EMAIL_NOTE = "A maintainer's invite goes to one colleague's email address. Only a company owner or admin can make a shareable link.";
export const emailOutcomeWords = (outcome: "sent" | "not_set_up" | "failed" | "limited" | undefined, canCopyLink = true): string => !canCopyLink && (outcome === "failed" || outcome === "not_set_up" || outcome === "limited") ? (outcome === "failed" ? "Invite created, but the email couldn't be sent. Check the address, or ask a company owner or admin to help." : outcome === "not_set_up" ? "Invite created. Email isn't set up here, so ask a company owner or admin to share it." : "Invite created, but it wasn't emailed: this address already got an invite email today, or the company reached today's email limit. Try again tomorrow, or ask a company owner or admin.") : outcome === "sent" ? "Invite created and emailed." : outcome === "failed" ? "Invite created, but the email couldn't be sent. Copy the link and send it yourself." : outcome === "not_set_up" ? "Invite created. Email isn't set up here, so copy the link and send it yourself." : outcome === "limited" ? "Invite created, but it wasn't emailed: this address already got an invite email today, or the company reached today's email limit. Copy the link and send it yourself." : "Invite created.";

/**
 * The welcome note when someone joined through an invite that named a project. The URL is only a claim, so nothing is stated as fact unless the project read confirmed it (`confirmed`): without that the words are
 * neutral ("If you were added to foo, it will appear in your projects"), and a project note (archived or gone) is worded the same way, never as a certainty about the project.
 */
export const joinedWords = (company: string | undefined, project: string | undefined, note: string | null, confirmed = false): { title: string; body: string } => {
 const title = "You joined " + (company === undefined ? "the company" : company), name = project === undefined ? "the project" : project;
 if (note !== null) return { title, body: "If you were meant to be added to " + name + ", it may not have happened: it may have been archived or removed before you joined. If it isn't in your projects, ask a maintainer." };
 if (confirmed) return { title, body: "You are also on the project " + name + "." };
 return { title, body: "If you were added to " + name + ", it will appear in your projects." };
};

/** Why a person cannot approve a product decision right now, from the server's own reason. */
export const APPROVE_REFUSAL_WORDS: Readonly<Record<string, string>> = {
 role_not_allowed: "Your role in this project can't approve this decision. A maintainer or the task's owner can.",
 collaborator_approvals_off: "Collaborators can't approve decisions in this project right now: a maintainer has turned that off.",
 fresh_sign_in_required: "Sign in again to approve. Approving a decision needs a recent sign-in.",
};
export const approveRefusalWords = (code: string | undefined): string | undefined => code === undefined ? undefined : APPROVE_REFUSAL_WORDS[code] ?? "You can't approve this decision right now.";
export const RISK_WORDS: Readonly<Record<string, string>> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
export const EMPTY_DECISIONS = { title: "No product decisions waiting", description: "When a task needs a choice about wording, design or scope, it shows up here for the people who can decide it." };

const REVIEWER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?$/u;
export const REVIEWERS_MAX = 10;
/** The reviewers typed one per line or separated by commas or spaces: the names, or the first thing wrong with them. */
export function parseReviewers(text: string): { ok: true; names: string[] } | { ok: false; message: string } {
 const names = text.split(/[\s,]+/u).filter(name => name !== "");
 if (names.length > REVIEWERS_MAX) return { ok: false, message: "Name at most " + String(REVIEWERS_MAX) + " reviewers." };
 for (const name of names) if (!REVIEWER.test(name)) return { ok: false, message: "\"" + name.slice(0, 60) + "\" isn't a reviewer name. Use a person's login or an organization/team." };
 if (new Set(names.map(name => name.toLowerCase())).size !== names.length) return { ok: false, message: "A reviewer is named twice." };
 return { ok: true, names };
}
