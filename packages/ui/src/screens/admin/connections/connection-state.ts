// UX3: what each connection card says about itself. Pure functions: the screen reads stored state and these turn it into a plain state word, the reason and the fix.
// Nothing here checks a vendor. A tick means a check that passed (or a GitHub App Rovara can see installed); "Needs attention" always says why and what to do.
export type CardState = "connected" | "attention" | "not_connected" | "per_project" | "built_in" | "unavailable";
export const STATE_WORDS: Readonly<Record<CardState, string>> = { connected: "✓ Connected", attention: "Needs attention", not_connected: "Not connected", per_project: "Set up per project", built_in: "✓ Built in", unavailable: "Not available here" };
export interface CardSummary { state: CardState; why: string; fix?: string }

export interface GithubInstall { installationId: number; accountLogin: string; status: "active" | "suspended" | "removed" | "unknown"; connectedBy?: string | undefined; connectedAt?: string | undefined }
export interface GithubRequest { accountLogin?: string | undefined; status: string }

export function githubSummary(installs: readonly GithubInstall[], requests: readonly GithubRequest[]): CardSummary {
  const active = installs.filter(install => install.status === "active");
  if (active.length > 0) {
    const names = active.map(install => install.accountLogin).join(", ");
    const trouble = installs.filter(install => install.status !== "active");
    return trouble.length === 0
      ? { state: "connected", why: `Rovara can work on repositories from ${names}.` }
      : { state: "attention", why: `${names} works, but ${trouble.map(install => `${install.accountLogin} is ${install.status}`).join(", ")}.`, fix: "Ask the owner of that GitHub organization to restore the Rovara app, or connect it again." };
  }
  const suspended = installs.find(install => install.status === "suspended");
  if (suspended !== undefined) return { state: "attention", why: `The Rovara app on ${suspended.accountLogin} is suspended on GitHub, so Rovara can't read your code.`, fix: "Ask the owner of that GitHub organization to unsuspend it, then press Check connection." };
  if (installs.length > 0 && installs.every(install => install.status === "unknown")) return { state: "attention", why: "Rovara can't tell what state its GitHub app is in.", fix: "Press Check connection, or connect GitHub again." };
  if (installs.length > 0) return { state: "attention", why: "The Rovara app was removed from GitHub, so Rovara can't read your code.", fix: "Connect GitHub again." };
  const waiting = requests.find(request => request.status === "waiting");
  if (waiting !== undefined) return { state: "attention", why: `Waiting for your GitHub admin to approve Rovara${waiting.accountLogin === undefined ? "" : ` on ${waiting.accountLogin}`}.`, fix: "Ask them to approve it on GitHub, then press Check connection." };
  return { state: "not_connected", why: "Rovara can't read your code until GitHub is connected.", fix: "Connect GitHub." };
}

export interface ProviderSource { sourceId: string; label: string }
export function providerSummary(sources: readonly ProviderSource[], available: readonly string[] | undefined, failed: ReadonlySet<string>): CardSummary {
  if (sources.length === 0) {
    const addable = (available ?? []).filter(kind => kind !== "endpoint");
    return { state: "not_connected", why: "Work runs on Rovara's own models. Adding your own provider is optional.", ...(addable.length === 0 ? {} : { fix: "Add a provider." }) };
  }
  const broken = sources.filter(source => failed.has(source.sourceId));
  return broken.length === 0
    ? { state: "connected", why: `${sources.length === 1 ? "1 provider is" : `${String(sources.length)} providers are`} added. Press Check it works to test one.` }
    : { state: "attention", why: `${broken.map(source => source.label).join(", ")} didn't pass its check.`, fix: "Open it and read what the provider said." };
}

export interface RegistryConnection { connectionId: string; type: string; label: string; hasCredential: boolean; updatedAt: string; createdBy?: string | undefined; createdAt?: string | undefined; lastCheck?: { ok: boolean; at: string } | undefined; access?: string | undefined; identity?: "service" | "personal" | undefined }

/** One saved connection: its own state, from what is stored, with the cause of a failed check when this page session has just run it. */
export function connectionSummary(connection: RegistryConnection, lastMessage: string | undefined): CardSummary {
  if (connection.type !== "cloudwatch" && !connection.hasCredential) return { state: "attention", why: "No key is saved for this connection.", fix: "Remove it and add it again with its key." };
  if (connection.lastCheck === undefined) return { state: "attention", why: "It has never been checked.", fix: "Press Check it works." };
  if (!connection.lastCheck.ok) return { state: "attention", why: lastMessage === undefined ? "Its last check failed." : `Its last check failed: ${lastMessage}.`, fix: lastMessage === undefined ? "Press Check it works to see why." : "Fix that, then press Check it works again." };
  return { state: "connected", why: "Its last check passed." };
}

/** The card for a type that can have several connections: connected only when every one passed; a missing one is "not connected". */
export function groupSummary(connections: readonly RegistryConnection[], messages: Readonly<Record<string, string>>, vendor: string): CardSummary {
  if (connections.length === 0) return { state: "not_connected", why: `Rovara can't read ${vendor} yet.`, fix: `Add ${vendor}.` };
  const parts = connections.map(connection => connectionSummary(connection, messages[connection.connectionId]));
  const broken = parts.findIndex(part => part.state !== "connected");
  if (broken === -1) return { state: "connected", why: connections.length === 1 ? `${connections[0]!.label} passed its last check.` : `All ${String(connections.length)} connections passed their last check.` };
  return { state: "attention", why: `${connections[broken]!.label}: ${parts[broken]!.why}`, ...(parts[broken]!.fix === undefined ? {} : { fix: parts[broken]!.fix }) };
}

export function slackSummary(read: { status: "loading" } | { status: "unavailable" } | { status: "refused" } | { status: "ok"; associations: number }): CardSummary {
  if (read.status === "loading") return { state: "not_connected", why: "Checking what Rovara has stored about your Slack workspace." };
  // A refusal (not signed in, not allowed, not set up on this install, or the service answering 503) is the same "not available here yet" the evidence panel says; it is not a connection that needs attention.
  if (read.status === "refused") return { state: "unavailable", why: "Slack workspace details aren't available here yet." };
  if (read.status === "unavailable") return { state: "attention", why: "Rovara couldn't read your Slack workspace details just now.", fix: "Reload this page to try again." };
  return read.associations > 0
    ? { state: "connected", why: "Your Slack workspace is connected to this company. Channels are linked project by project." }
    : { state: "not_connected", why: "No Slack workspace is connected to this company.", fix: "Ask your Rovara operator to connect it (steps below)." };
}

/** The cause shown for a failed add or check: a server message is the vendor's or Rovara's own sentence, so it is shown inert and capped. */
export function causeText(message: string | undefined): string {
  const text = (message ?? "").replace(/\p{Cc}/gu, " ").trim().replace(/[.\s]+$/, "");
  return text === "" ? "the check didn't give a reason" : text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Who connected it and when, for the card: a name when the members list has one, otherwise the plain fact. */
/** `names` is undefined while the members list has not been read (or could not be): then who it was is not shown, rather than guessed at. */
export function whoWhen(by: string | undefined, at: string | undefined, names: ReadonlyMap<string, string> | undefined): string {
  const when = at === undefined ? undefined : new Date(at);
  const day = when !== undefined && Number.isFinite(when.getTime()) ? ` on ${when.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}` : "";
  if (by === undefined || names === undefined) return by === undefined && day !== "" ? `Date recorded${day}` : "Not recorded";
  const name = names.get(by);
  return `${name ?? "A former member or an admin"}${day}`;
}
export function connectedByWords(by: string | undefined, at: string | undefined, names: ReadonlyMap<string, string> | undefined): string {
  const text = whoWhen(by, at, names);
  return text === "Not recorded" ? "Who connected it was not recorded" : by === undefined ? `Connected${text.replace(/^Date recorded/, "")}` : `Connected by ${text}`;
}
