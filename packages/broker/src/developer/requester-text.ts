// C55 (staging 0.4.11): whatever Rovara writes on GitHub (a pull request's footer, a connector's footer) names a person by their display name, or by their linked GitHub login when
// the display name is an email address (the sign-in provider falls back to the address when it has no name for someone), and never by an email address.

/** An email address anywhere in a text: a local part, an @, a domain with a dot. Deliberately wide: a false match only removes a word from a name. */
const EMAIL = /[^\s@<>()[\]{},;:"'`]+@[^\s@<>()[\]{},;:"'`]+\.[^\s@<>()[\]{},;:"'`]+/gu;
/** What GitHub issues as a login: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;

/** The text with every email address taken out, and the empty brackets and spaces they leave tidied away. */
export function withoutEmails(text: string): string {
  return text.replace(EMAIL, " ").replace(/<\s*>|\(\s*\)|\[\s*\]/gu, " ").replace(/<\s*|\s*>/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * The name a text on GitHub may use for a person: their display name without any email address in it, else their linked GitHub login (when it is one GitHub could have issued),
 * else undefined (the caller says "the task owner" or "a member").
 */
export function personNameForText(displayName: string, githubLogin?: string): string | undefined {
  const name = withoutEmails(displayName);
  if (name !== "" && /[\p{L}\p{N}]/u.test(name)) return name;
  return githubLogin !== undefined && GITHUB_LOGIN.test(githubLogin) ? githubLogin : undefined;
}

/** The login of the GitHub account a person linked, or undefined. */
export async function githubLoginOf(store: { identitiesOf(developerId: string): Promise<ReadonlyArray<{ provider: string; login?: string | undefined }>> }, developerId: string): Promise<string | undefined> {
  try {
    return (await store.identitiesOf(developerId)).find((identity) => identity.provider === "github" && identity.login !== undefined)?.login;
  } catch {
    // A login that cannot be read is no reason to fail a pull request; the footer says "the task owner".
    return undefined;
  }
}
