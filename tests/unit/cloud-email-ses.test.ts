// Convergence lane A8: Cloud's SES email adapter (Code's email port, K1) refuses the recipient a header could be split by, handles sending limits (its own and the
// service's), and never puts an address or the service's own error text in an error or a log line.
import { describe, expect, it } from "vitest";
import { EMAIL_SUBJECT_MAX, EmailError, type EmailMessage } from "../../packages/broker/src/cloud-adapters/k1-ports/index.js";
import { SesEmailSender, isSesSender, type SesEmailSenderOptions } from "../../packages/broker/src/cloud-adapters/email-realtime.js";
import { FakeSes, serviceError } from "../support/cloud-adapters/ses-fake.js";

const COMPANY = "org_00000000000000000000";
const OTHER = "org_11111111111111111111";
const FROM = "Rovara <notices@example.test>";
const message = (extra: Partial<EmailMessage> = {}): EmailMessage => ({ companyId: COMPANY, purpose: "attention", to: "dev@example.test", subject: "2 tasks need you", text: "Open https://rovara.example.test/app to see them.", ...extra });

function world(extra: Partial<SesEmailSenderOptions> = {}) {
  const ses = new FakeSes();
  const logs: Array<Record<string, unknown>> = [];
  const clock = { now: Date.UTC(2026, 10, 11, 12, 0, 0) };
  const sender = new SesEmailSender({ client: ses, from: FROM, now: () => clock.now, log: (entry) => logs.push(entry), ...extra });
  return { ses, sender, logs, clock };
}
const failure = async (promise: Promise<unknown>): Promise<EmailError> => {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmailError);
  return error as EmailError;
};

// Code's email conformance suite (`runEmailConformance`) is not in the vendored pin yet. It is registered with the pin bump (tests/conformance/pending-lanes.ts, PENDING_AFTER_PIN); until then the cases below cover the same
// ground the suite does: one message to one address, the HTML only when it can, plain-address and subject refusals, fixed words, a retryable `unavailable` when down, and the deadline.
describe("the port's own cases, until the conformance suite is registered", () => {
  it.todo("passes runEmailConformance from the vendored Code (blocked on the pin bump)");

  it("says it can send, sends the text and the HTML, refuses a recipient that is not one plain address, and is retryable when SES is down", async () => {
    const { ses, sender } = world({ now: Date.now });
    expect(sender.capabilities.available).toBe(true);
    await sender.send(message({ html: "<p>Open the app.</p>" }));
    expect(ses.taken()).toHaveLength(1);
    for (const to of ["", "not-an-address", "a@example.test, b@example.test", "Dev <dev@example.test>", "a@example.test;b@example.test"]) expect((await failure(sender.send(message({ to })))).code, to).toBe("refused");
    ses.down = true;
    const down = await failure(sender.send(message()));
    expect([down.code, down.retryable]).toEqual(["unavailable", true]);
    ses.down = false;
    await sender.send(message());
    expect(ses.taken()).toHaveLength(2);
    expect((await failure(sender.send(message({ deadline: Date.now() - 1 })))).code).toBe("unavailable");
    expect(ses.taken()).toHaveLength(2);
  });
});

describe("what is sent to SES", () => {
  it("sends the owner's sender, one recipient, UTF-8 text and HTML, and the mail client's unsubscribe offer from the parsed link", async () => {
    const { ses, sender } = world({ configurationSetName: "notices" });
    await sender.send(message({ html: "<p>Open the app.</p>", unsubscribeUrl: "https://Rovara.example.test/stop?x=1&y=2" }));
    expect(ses.inputs).toEqual([{
      FromEmailAddress: FROM, Destination: { ToAddresses: ["dev@example.test"] }, ConfigurationSetName: "notices",
      Content: { Simple: {
        Subject: { Data: "2 tasks need you", Charset: "UTF-8" },
        Body: { Text: { Data: "Open https://rovara.example.test/app to see them.", Charset: "UTF-8" }, Html: { Data: "<p>Open the app.</p>", Charset: "UTF-8" } },
        Headers: [{ Name: "List-Unsubscribe", Value: "<https://rovara.example.test/stop?x=1&y=2>" }],
      } },
    }]);
  });

  it("sends the text alone, with no HTML part and no header, when the message has neither, and names no configuration set unless set", async () => {
    const { ses, sender } = world();
    await sender.send(message());
    const simple = ses.inputs[0]!.Content!.Simple!;
    expect(simple.Body).toEqual({ Text: { Data: "Open https://rovara.example.test/app to see them.", Charset: "UTF-8" } });
    expect(simple.Headers).toBeUndefined();
    expect(ses.inputs[0]!.ConfigurationSetName).toBeUndefined();
  });

  it("never lets a message pick the sender: a field the port does not have is not read", async () => {
    const { ses, sender } = world();
    await sender.send({ ...message(), from: "ceo@example.test", FromEmailAddress: "ceo@example.test", cc: "x@example.test" } as EmailMessage);
    expect(ses.inputs[0]!.FromEmailAddress).toBe(FROM);
    expect(ses.inputs[0]!.Destination).toEqual({ ToAddresses: ["dev@example.test"] });
  });

  it("bounds the call by the sender's timeout, or by the message's own deadline when that is sooner", async () => {
    const { ses, sender } = world({ sendTimeoutMs: 5_000 });
    const before = Date.now();
    await sender.send(message({ deadline: before + 200 }));
    await sender.send(message());
    expect(ses.signals).toHaveLength(2);
    expect(ses.signals.every((signal) => signal !== undefined && !signal.aborted)).toBe(true);
  });

  it("answers a call that hangs with a retryable `unavailable` when its timeout passes", async () => {
    const { ses, sender, logs } = world({ sendTimeoutMs: 100 });
    ses.hang = true;
    const error = await failure(sender.send(message()));
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(logs).toEqual([{ event: "email.unavailable", reason: "ses_unavailable", errorName: "TimeoutError" }]);
  });
});

describe("the recipient control-character case", () => {
  const recipients = [
    "dev@example.test\r\nBcc: x@example.test", "dev\u0001@example.test", "dev@example.test\u007f", "dev\u0085@example.test", "dev​@example.test", "dev@exa‮mple.test", "dev@example.test\u0000",
    "dev@example.test ", "dev@example.test ", "\u001bdev@example.test", "dev@example.test­",
  ];

  it("refuses every recipient with a control or format character, never retried, and calls nothing", async () => {
    const { ses, sender } = world();
    for (const to of recipients) {
      const error = await failure(sender.send(message({ to })));
      expect(error.code, JSON.stringify(to)).toBe("refused");
      expect(error.retryable).toBe(false);
    }
    expect(ses.inputs).toHaveLength(0);
    expect(ses.signals).toHaveLength(0);
  });

  it("refuses a subject with one, and still sends the same message with a plain recipient (the positive control)", async () => {
    const { ses, sender } = world();
    for (const subject of ["Hello\u0085World", "Hello​World", `x${"\u0007"}y`]) expect((await failure(sender.send(message({ subject })))).code).toBe("refused");
    expect(ses.inputs).toHaveLength(0);
    await sender.send(message({ subject: "Hello World" }));
    expect(ses.inputs).toHaveLength(1);
  });

  it("refuses a sender setting that is not one plain sender on one line", () => {
    for (const from of ["", "a@b", "a@example.test\r\nBcc: x@example.test", "Name <a@example.test>, b@example.test", "<a@example.test>", "a@example.test\u0085", "x".repeat(400)]) {
      expect(isSesSender(from), JSON.stringify(from)).toBe(false);
      expect(() => new SesEmailSender({ client: new FakeSes(), from })).toThrow(TypeError);
    }
    expect(isSesSender("notices@example.test")).toBe(true);
    expect(isSesSender(FROM)).toBe(true);
  });

  it("still refuses a subject past the limit and a text with a NUL, as the port does", async () => {
    const { ses, sender } = world();
    expect((await failure(sender.send(message({ subject: "x".repeat(EMAIL_SUBJECT_MAX + 1) })))).code).toBe("refused");
    expect((await failure(sender.send(message({ text: "a\u0000b" })))).code).toBe("refused");
    expect(ses.inputs).toHaveLength(0);
  });
});

describe("sending limits", () => {
  it("holds sends past its own per-second limit without calling SES, and allows them again a second later", async () => {
    const { ses, sender, clock } = world({ limits: { perSecond: 3 } });
    for (let index = 0; index < 3; index += 1) await sender.send(message());
    const error = await failure(sender.send(message()));
    expect(error.code).toBe("unavailable");
    expect(error.message).toMatch(/limit/);
    expect(ses.inputs).toHaveLength(3);
    clock.now += 999;
    expect((await failure(sender.send(message()))).code).toBe("unavailable");
    clock.now += 1;
    await sender.send(message());
    expect(ses.inputs).toHaveLength(4);
  });

  it("holds sends past its own daily limit until the next UTC day", async () => {
    const { ses, sender, clock } = world({ limits: { perDay: 2 } });
    await sender.send(message());
    await sender.send(message());
    expect((await failure(sender.send(message()))).code).toBe("unavailable");
    clock.now = Date.UTC(2026, 10, 12, 0, 0, 1);
    await sender.send(message());
    expect(ses.inputs).toHaveLength(3);
  });

  it("keeps a per-company daily limit: one company's sends never use another's", async () => {
    const { ses, sender, clock } = world({ limits: { perCompanyPerDay: 1 } });
    await sender.send(message({ companyId: COMPANY, to: "a@example.test" }));
    expect((await failure(sender.send(message({ companyId: COMPANY, to: "a2@example.test" })))).code).toBe("unavailable");
    await sender.send(message({ companyId: OTHER, to: "b@example.test" }));
    expect((await failure(sender.send(message({ companyId: OTHER, to: "b2@example.test" })))).code).toBe("unavailable");
    expect(ses.taken().map((sent) => sent.to)).toEqual(["a@example.test", "b@example.test"]);
    clock.now += 86_400_000;
    await sender.send(message({ companyId: COMPANY, to: "a3@example.test" }));
    expect(ses.inputs).toHaveLength(3);
  });

  it("does not count a refused message against any limit", async () => {
    const { ses, sender } = world({ limits: { perSecond: 1, perDay: 1, perCompanyPerDay: 1 } });
    await failure(sender.send(message({ to: "not-an-address" })));
    await sender.send(message());
    expect(ses.inputs).toHaveLength(1);
  });

  it("takes SES's own throttling and quota answers as `unavailable`, and holds sends for a short cool-down instead of asking again at once", async () => {
    for (const name of ["TooManyRequestsException", "LimitExceededException", "ThrottlingException"]) {
      const { ses, sender, clock } = world({ coolDownMs: 1_000 });
      ses.failures.push(serviceError(name, "Maximum sending rate exceeded."));
      const first = await failure(sender.send(message()));
      expect(first.code, name).toBe("unavailable");
      expect(first.retryable).toBe(true);
      const callsAfterFirst = ses.signals.length;
      expect((await failure(sender.send(message()))).code, name).toBe("unavailable");
      expect(ses.signals.length, `${name}: no call during the cool-down`).toBe(callsAfterFirst);
      clock.now += 1_000;
      await sender.send(message());
      expect(ses.inputs, name).toHaveLength(1);
    }
  });

  it("takes a rejected message and a bad request as `refused` (never retried), and every other service answer as `unavailable`", async () => {
    const answers: Array<[string, "refused" | "unavailable"]> = [
      ["MessageRejected", "refused"], ["BadRequestException", "refused"],
      ["SendingPausedException", "unavailable"], ["AccountSuspendedException", "unavailable"], ["MailFromDomainNotVerifiedException", "unavailable"], ["NotFoundException", "unavailable"],
      ["InternalServiceErrorException", "unavailable"], ["ServiceUnavailable", "unavailable"], ["UnknownThing", "unavailable"], ["TypeError", "unavailable"],
    ];
    for (const [name, code] of answers) {
      const { sender, ses } = world();
      ses.failures.push(serviceError(name, "Email address is not verified. The following identities failed the check: private.person@example.test"));
      const error = await failure(sender.send(message({ to: "private.person@example.test" })));
      expect(error.code, name).toBe(code);
      expect(error.retryable, name).toBe(code === "unavailable");
    }
  });

  it("is not held back by a cool-down that has passed, and a failed send does not stop a later one", async () => {
    const { ses, sender } = world();
    ses.failures.push(serviceError("InternalServiceErrorException", "x"));
    await failure(sender.send(message()));
    await sender.send(message());
    expect(ses.inputs).toHaveLength(1);
  });
});

describe("no address and no service text in an error or a log", () => {
  it("names neither the recipient, nor the subject, nor the service's own words, whatever fails", async () => {
    const { ses, sender, logs, clock } = world({ limits: { perDay: 100 } });
    const secrets = ["private.person", "example.test", "Project Nightjar", "identities failed the check", "ECONNREFUSED"];
    const sentence = "Email address is not verified. The following identities failed the check: private.person@example.test";
    const errors: EmailError[] = [];
    const to = "private.person@example.test";
    const subject = "About Project Nightjar";
    // A rejection naming the address, a throttle, the cool-down after it, a lost connection naming the address, a bad recipient, a recipient with a line break, a subject with one, a deadline, and our own limit.
    ses.failures.push(serviceError("MessageRejected", sentence));
    errors.push(await failure(sender.send(message({ to, subject }))));
    ses.failures.push(serviceError("TooManyRequestsException", sentence));
    errors.push(await failure(sender.send(message({ to, subject }))));
    errors.push(await failure(sender.send(message({ to, subject }))));
    clock.now += 1_000;
    ses.down = true;
    errors.push(await failure(sender.send(message({ to, subject }))));
    ses.down = false;
    errors.push(await failure(sender.send(message({ to: "private.person@example", subject }))));
    errors.push(await failure(sender.send(message({ to: "private.person@example.test\r\nBcc: x@example.test", subject }))));
    errors.push(await failure(sender.send(message({ to, subject: "About Project Nightjar\r\nBcc: x@example.test" }))));
    errors.push(await failure(sender.send(message({ to, subject, deadline: clock.now - 1 }))));
    // The positive control: the paths ran, so there are errors and log lines to look in.
    expect(errors.map((error) => error.code)).toEqual(["refused", "unavailable", "unavailable", "unavailable", "refused", "refused", "refused", "unavailable"]);
    expect(logs).toHaveLength(8);
    const seen = JSON.stringify([errors.map((error) => [error.name, error.code, error.message, error.stack === undefined ? "" : error.stack.split("\n")[0]]), logs]);
    for (const secret of secrets) expect(seen, secret).not.toContain(secret);
    // Every log line is a fixed code, a reason and at most an error name made of letters.
    for (const entry of logs) {
      expect(Object.keys(entry).every((key) => ["event", "reason", "errorName"].includes(key)), JSON.stringify(entry)).toBe(true);
      expect(typeof entry["errorName"] === "string" ? entry["errorName"] : "").toMatch(/^[A-Za-z0-9]*$/u);
    }
  });

  it("logs an error name only when it is made of letters and digits: free text in a name is not copied", async () => {
    const { ses, sender, logs } = world();
    ses.failures.push(serviceError("private.person@example.test", "x"));
    await failure(sender.send(message()));
    expect(JSON.stringify(logs)).not.toContain("private.person");
    expect(logs).toEqual([{ event: "email.unavailable", reason: "ses_unavailable", errorName: "unknown" }]);
  });
});

describe("closing", () => {
  it("closes the client it was given", () => {
    const { ses, sender } = world();
    sender.close();
    expect(ses.destroyed).toBe(true);
  });
});
