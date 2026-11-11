// Cloud's own words from integ's errors.ts. Rovara Code's contracts carry the error codes and the shared messages; the Slack member notice is about a company membership, which only Cloud has.

/**
 * What a Slack person hears (as a plain reply in the thread) when Rovara cannot match their Slack account to an explicit, current member of the company their Slack workspace is connected to
 * (SLACK_ACCOUNT_NOT_LINKED: the account was never added or linked). One text for the ingress and the Slack service, so the two cannot say different things.
 */
export const SLACK_NOT_A_MEMBER_NOTICE = "I can't match your Slack account to a member of your company in Rovara, so I can't do this for you. Ask a Rovara admin to add you, or link your Slack account yourself: sign in to Rovara, open your account menu and choose Link your Slack account. Then mention me again.";
