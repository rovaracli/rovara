// Convergence lane A8: the `email` port on Amazon SES (the v2 API, `SendEmail` with simple content).
//
// What is held here, beyond the translation (the email conformance suite pins the port's own rules; `tests/unit/cloud-email-ses.test.ts` pins these):
//  - The port's refusal runs first (`emailRefusal`), so a bad message never reaches SES, and a second check refuses any control or format character (`\p{Cc}`, `\p{Cf}`) in the recipient, the subject
//    and the sender, because a header must never be split by a character the port's own rule does not list.
//  - The sender is the owner's setting. A message never names one.
//  - Sending limits are handled twice: this process keeps its own per-second, per-day and per-company-per-day counts and answers `unavailable` without calling SES once one is reached, and SES's own
//    limit answers (throttling, sending quota) are `unavailable` too and start a short cool-down, so a burst does not hammer a service that has just said no.
//  - `refused` is for what SES will not take for this message (a rejected message, a bad request): never retried. Everything else (paused or suspended sending, an identity or configuration set
//    that is missing, a service fault, a timeout, a lost connection) is `unavailable`: the owner or the service can fix it, and the caller retries later. An answer that was lost may have been sent: the port
//    says so, and the caller marks what it sent itself.
//  - Errors and logs carry fixed sentences and codes. SES's own error text names the address it refused ("Email address is not verified: ..."), so it is never copied: not into the error, not into a log line.
//  - The mail client's unsubscribe offer is set from the parsed link (`List-Unsubscribe`), exactly as the hosted product sets it today.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailError, emailRefusal, emailUnsubscribeHref, type EmailCapabilities, type EmailMessage, type EmailSender } from "../k1-ports/index.js";

/** What the adapter needs of an SES client: the SDK's `SESv2Client` has it. */
export interface SesSender {
  send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}

export interface SesSendLimits {
  /** At most this many sends handed to SES in any one second by this process. */
  perSecond?: number;
  /** At most this many in one UTC day by this process. */
  perDay?: number;
  /** At most this many for one company in one UTC day by this process. */
  perCompanyPerDay?: number;
}

export interface SesEmailSenderOptions {
  client: SesSender;
  /** The owner's sender: an address, or `Name <address>`. */
  from: string;
  /** An SES configuration set (bounce and complaint handling); absent: none. */
  configurationSetName?: string;
  /** The longest one call may take (the caller's own deadline may be shorter). Default 2,500 ms, as the hosted sender's. */
  sendTimeoutMs?: number;
  limits?: SesSendLimits;
  /** How long sends are held back after SES says it is throttling or over its quota. Default 1,000 ms. */
  coolDownMs?: number;
  now?: () => number;
  /** Fixed codes only. */
  log?: (entry: Record<string, unknown>) => void;
}

export const SES_CAPABILITIES: EmailCapabilities = { available: true, html: true, unsubscribeHeader: true };
export const SES_SEND_TIMEOUT_MS = 2_500;
export const SES_COOL_DOWN_MS = 1_000;
/** The most companies whose day count is kept; an older day's entries are dropped first, then the oldest. */
const COMPANY_COUNTS_MAX = 10_000;
const DAY_MS = 86_400_000;

const REFUSED_BY_SES: ReadonlySet<string> = new Set(["MessageRejected", "BadRequestException"]);
const SES_LIMIT_ANSWERS: ReadonlySet<string> = new Set(["TooManyRequestsException", "LimitExceededException", "ThrottlingException", "Throttling", "RequestLimitExceeded"]);

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const WORDS = {
  unavailable: "the email could not be sent now",
  limit: "the email sending limit is reached; try again later",
  refused: "the email service will not send this message",
} as const;

/** A sender setting: an address or `Name <address>` on one line. */
export function isSesSender(value: string): boolean {
  if (value === "" || value.length > 320 || CONTROL_OR_FORMAT.test(value)) return false;
  return /^[^<>@\s,;"]+@[^<>@\s,;"]+\.[^<>@\s,;"]+$/u.test(value) || /^[^<>@,;"\r\n]{1,100}<[^<>@\s,;"]+@[^<>@\s,;"]+\.[^<>@\s,;"]+>$/u.test(value);
}

const errorNameOf = (error: unknown): string => (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "unknown");

export class SesEmailSender implements EmailSender {
  readonly capabilities = SES_CAPABILITIES;
  private readonly from: string;
  private readonly timeoutMs: number;
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly recent: number[] = [];
  private day = { start: 0, count: 0 };
  private readonly companies = new Map<string, { start: number; count: number }>();
  private coolUntil = 0;

  constructor(private readonly options: SesEmailSenderOptions) {
    if (!isSesSender(options.from)) throw new TypeError("the email sender is an address, or a name and an address, on one line");
    this.from = options.from;
    this.timeoutMs = options.sendTimeoutMs ?? SES_SEND_TIMEOUT_MS;
    this.coolDownMs = options.coolDownMs ?? SES_COOL_DOWN_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  async send(message: EmailMessage): Promise<void> {
    const refusal = emailRefusal(message);
    if (refusal !== undefined) throw this.refuse("port", undefined, refusal);
    if (CONTROL_OR_FORMAT.test(message.to) || CONTROL_OR_FORMAT.test(message.subject)) throw this.refuse("control_character", undefined, "the recipient or the subject holds a control character");
    const at = this.now();
    const remaining = message.deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, message.deadline - at);
    if (remaining <= 0) throw this.unavailable("deadline");
    this.admit(message.companyId, at);

    const html = message.html;
    const unsubscribe = message.unsubscribeUrl === undefined ? undefined : emailUnsubscribeHref(message.unsubscribeUrl);
    const command = new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [message.to] },
      ...(this.options.configurationSetName === undefined ? {} : { ConfigurationSetName: this.options.configurationSetName }),
      Content: { Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: { Text: { Data: message.text, Charset: "UTF-8" }, ...(html === undefined ? {} : { Html: { Data: html, Charset: "UTF-8" } }) },
        ...(unsubscribe === undefined ? {} : { Headers: [{ Name: "List-Unsubscribe", Value: `<${unsubscribe}>` }] }),
      } },
    });
    try {
      await this.options.client.send(command, { abortSignal: AbortSignal.timeout(remaining) });
    } catch (error) {
      const name = errorNameOf(error);
      if (REFUSED_BY_SES.has(name)) throw this.refuse("ses_rejected", name);
      if (SES_LIMIT_ANSWERS.has(name)) {
        this.coolUntil = this.now() + this.coolDownMs;
        throw this.unavailable("ses_limit", name, WORDS.limit);
      }
      throw this.unavailable("ses_unavailable", name);
    }
  }

  close(): void {
    this.options.client.destroy?.();
  }

  /** Counts this send against this process's limits, or throws `unavailable` without calling SES. */
  private admit(companyId: string, at: number): void {
    if (at < this.coolUntil) throw this.unavailable("cool_down", undefined, WORDS.limit);
    const { perSecond, perDay, perCompanyPerDay } = this.options.limits ?? {};
    const today = Math.floor(at / DAY_MS) * DAY_MS;
    if (this.day.start !== today) this.day = { start: today, count: 0 };
    while (this.recent.length > 0 && at - this.recent[0]! >= 1_000) this.recent.shift();
    if (perSecond !== undefined && this.recent.length >= perSecond) throw this.unavailable("per_second", undefined, WORDS.limit);
    if (perDay !== undefined && this.day.count >= perDay) throw this.unavailable("per_day", undefined, WORDS.limit);
    let company = this.companies.get(companyId);
    if (company === undefined || company.start !== today) company = { start: today, count: 0 };
    if (perCompanyPerDay !== undefined && company.count >= perCompanyPerDay) throw this.unavailable("per_company_day", undefined, WORDS.limit);
    // Counted now, not refunded when SES then fails: an answer that was lost may have been sent, and SES counts what it took.
    this.recent.push(at);
    this.day.count += 1;
    company.count += 1;
    this.companies.delete(companyId);
    this.companies.set(companyId, company);
    if (this.companies.size > COMPANY_COUNTS_MAX) {
      // Bounded memory: other days' counts go first, then the longest idle company's (its count for today starts again).
      for (const [key, value] of this.companies) if (value.start !== today) this.companies.delete(key);
      while (this.companies.size > COMPANY_COUNTS_MAX) this.companies.delete(this.companies.keys().next().value as string);
    }
  }

  /** `words` is one of this module's fixed sentences or the port's own refusal sentence (which never quotes the message). */
  private refuse(reason: string, errorName?: string, words: string = WORDS.refused): EmailError {
    this.log({ event: "email.refused", reason, ...(errorName === undefined ? {} : { errorName }) });
    return new EmailError("refused", words);
  }

  private unavailable(reason: string, errorName?: string, words: string = WORDS.unavailable): EmailError {
    this.log({ event: "email.unavailable", reason, ...(errorName === undefined ? {} : { errorName }) });
    return new EmailError("unavailable", words);
  }
}
