// Wire lane D (MF-2, applier part): what an approved intake card does. The setup agent proposes a place work is asked for (a channel, the label that asks, a connection by name); once an org admin (who may
// approve their own cards) has approved the card, a maintainer applies it from the setup page and the proposal becomes ONE intake source of the project (`intake/sources.ts`). Nothing starts by itself:
// who a ticket's label came from still decides whether work starts (`intake/engine.ts`). A channel that is started another way (Slack, Linear) or a proposal with no label is refused in fixed words.
// The intake UI (waiting list, Start, sources editor, Home notice) is a later lane's.
import { IntakeChannelRefSchema, agentXError, type IntakeChannelRef, type SetupIntakeValue } from "@rovara-code/contracts";
import { registerSetupItemApplier, type SetupItemApplier } from "../rovara-code/setup-items.js";

/** Fixed words for what cannot be set up from a card. */
export const INTAKE_SETUP_WORDS = {
  channel: "Rovara can't set up this channel as an intake source from here. Slack and Linear start work in their own way.",
  label: "Say which label asks for work before this can be set up.",
  invalid: "This intake suggestion is not one Rovara can set up.",
  connection: "This suggestion names a connection the project does not have. Add the connection first, or set the source up without one.",
  differs: "This place already has an intake source with other settings. Change it in the project's intake sources instead.",
} as const;

/** The source a proposal names, or an error in fixed words. */
export function intakeRefOfSetupValue(value: SetupIntakeValue): IntakeChannelRef {
  if (value.channel !== "jira" && value.channel !== "github_issue" && value.channel !== "tracker") throw agentXError("CONFIG_INVALID", INTAKE_SETUP_WORDS.channel);
  if (value.label === undefined) throw agentXError("CONFIG_INVALID", INTAKE_SETUP_WORDS.label);
  const parsed = IntakeChannelRefSchema.safeParse({
    channel: value.channel,
    ...(value.channel === "tracker" && value.system !== undefined ? { system: value.system } : {}),
    ...(value.connection === undefined ? {} : { connection: value.connection }),
    when: { label: value.label },
  });
  if (!parsed.success) throw agentXError("CONFIG_INVALID", INTAKE_SETUP_WORDS.invalid);
  return parsed.data;
}

export const intakeSetupApplier: SetupItemApplier = {
  cardWords: (item) => {
    const value = item.proposed.value as SetupIntakeValue;
    const where = value.channel === "tracker" ? `the tracker ${value.system ?? "named in the suggestion"}` : value.channel === "jira" ? "Jira" : value.channel === "github_issue" ? "GitHub Issues" : value.channel;
    return [
      `Let a ticket in ${where}${value.connection === undefined ? "" : ` (connection ${value.connection})`} ask Rovara for work when it carries the label "${value.label ?? "(none named)"}".`,
      "Work starts only when a member of your company puts the label on, or presses Start. A ticket anyone else files waits for a member.",
    ];
  },
  apply: async (context) => {
    const ref = intakeRefOfSetupValue(context.item.proposed.value as SetupIntakeValue);
    // A source reads through a connection by name: it must be one the project has now (a name from a README is not a connection).
    if (ref.connection !== undefined && !await context.host.connectionExists(ref.connection)) throw agentXError("CONFIG_INVALID", INTAKE_SETUP_WORDS.connection);
    const added = await context.host.addIntakeSource(ref);
    if (added === "differs") throw agentXError("CONFIG_INVALID", INTAKE_SETUP_WORDS.differs);
    return { warnings: added === "already_set" ? ["This place was already set up as an intake source."] : [] };
  },
};

/** Registers the applier. Safe to call more than once. */
export function registerIntakeSetupApplier(): void {
  registerSetupItemApplier("intake", intakeSetupApplier);
}
