// The names of the events API's channels: `/<namespace>/o-<company>/<u|s|p>/<segment>`. One channel per audience, and the company is IN the name, so a listener who may hear a company's channels (the events API's own
// authorizer checks the pattern) can never hear another company's. The segments are the hosted product's: a person's and a project's are a hash (no person id, no project name is in a channel), a session's is its id's body.
import { createHash } from "node:crypto";
import type { RealtimeAudience } from "../k1-ports/index.js";

const COMPANY = /^org_([0-9a-z]{20})$/u;
const SESSION = /^(ses|crn)_([0-9a-z]{20})$/u;
const NAMESPACE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/u;

export const DEFAULT_NAMESPACE = "rovara";

const sha40 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 40);

export const isChannelNamespace = (value: string): boolean => NAMESPACE.test(value);

/** The channel one audience of one company listens on. Throws for a company id or a session id that has not the shape the channel names are built from (the caller counts that entry as failed). */
export function channelOf(namespace: string, companyId: string, audience: RealtimeAudience): string {
  const body = COMPANY.exec(companyId)?.[1];
  if (body === undefined) throw new Error("a company id is org_ and 20 letters or digits");
  const prefix = `/${namespace}/o-${body}`;
  switch (audience.kind) {
    case "person": return `${prefix}/u/d-${sha40(audience.personId)}`;
    case "project": return `${prefix}/p/p-${sha40(`${companyId}\n${audience.project}`)}`;
    case "session": {
      const matched = SESSION.exec(audience.sessionId);
      if (matched === null) throw new Error("not a session id");
      return `${prefix}/s/${matched[1] === "crn" ? "c" : "s"}-${matched[2]!}`;
    }
  }
}

/** What a channel name says: the company id and the kind of audience. Undefined for a name this module does not make. */
export function parseChannel(namespace: string, channel: string): { companyId: string; kind: RealtimeAudience["kind"]; segment: string } | undefined {
  const parts = channel.split("/");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== namespace) return undefined;
  const body = /^o-([0-9a-z]{20})$/u.exec(parts[2]!)?.[1];
  const kind = ({ u: "person", s: "session", p: "project" } as const)[parts[3] as "u" | "s" | "p"];
  const segment = parts[4]!;
  const shape = { person: /^d-[0-9a-f]{40}$/u, session: /^[sc]-[0-9a-z]{20}$/u, project: /^p-[0-9a-f]{40}$/u };
  if (body === undefined || kind === undefined || !shape[kind].test(segment)) return undefined;
  return { companyId: `org_${body}`, kind, segment };
}
