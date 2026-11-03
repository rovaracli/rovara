// Design review stage, DR10: the fixed words of the notices a waiting design review sends (3.7). No model word is in them: the task's title and the people's names are passed in already made safe for Slack by the caller
// (the notifier's `escapedLine`), and everything else is here. Plain words, what is waiting, who can act, and the task link.
import type { DesignWaitNoticeStep } from "./wait-clock.js";
import type { WaitAudienceCode } from "./wait-audience.js";

export type DesignWaitKind = "answers" | "cost" | "decision";

const THING: Record<DesignWaitKind, string> = {
  answers: "answers to its design questions",
  decision: "a decision on its design",
  cost: "a choice about what its design review may cost",
};

export interface DesignWaitWordsInput {
  step: DesignWaitNoticeStep;
  kind: DesignWaitKind;
  audience: WaitAudienceCode;
  /** The task's title, already safe to put in a Slack message. */
  title: string;
  /** The names of the people it waits on, already safe. */
  people: readonly string[];
  /** The task page's link text in Slack's `<url|label>` form, or undefined where there is no trusted base. */
  link: string | undefined;
}

const list = (names: readonly string[]): string => names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;

/** Who can act, in one sentence. */
function whoLine(input: DesignWaitWordsInput): string {
  const names = list(input.people);
  switch (input.audience) {
    case "approver_left": return names === "" ? "The person who was named to decide this has left the project, so it went to the project's maintainers." : `The person who was named to decide this is no longer able to, so it went to ${names}, who can.`;
    case "nobody_eligible": return "Nobody in this project can decide this now, because the person who was named to has left. A project owner needs to name a new approver.";
    case "unreadable": return "Who can act could not be worked out right now. The person who asked for the task can still act.";
    case "normal": return names === "" ? "" : `Waiting on ${names}.`;
  }
}

export function designWaitWords(input: DesignWaitWordsInput): string {
  const open = input.link === undefined ? "" : ` ${input.link}`;
  const quoted = `"${input.title}"`;
  const who = whoLine(input);
  switch (input.step) {
    case "24h": return `Rovara is waiting on ${THING[input.kind]} for ${quoted}. It has waited a day. ${who} Rovara does not decide this for anyone.${open}`.replace(/\s+/g, " ").trim();
    case "72h": return `Still waiting on ${THING[input.kind]} for ${quoted}. It has waited three days. ${who} Rovara does not decide this for anyone.${open}`.replace(/\s+/g, " ").trim();
    case "parked": return `Paused: ${quoted} has waited a week for ${THING[input.kind]}. Nothing is running and nothing is spending. ${who} Anyone who can act can pick it up again from the task page. If nobody does in 30 days it is closed as not decided.${open}`.replace(/\s+/g, " ").trim();
    case "closed": return `Closed: nobody decided the design for ${quoted}. The design, the findings and the answers stay on the task.${open}`;
  }
}
