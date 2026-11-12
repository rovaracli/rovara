// Convergence lane A8: the temporary mirror of Code's K1 ports (`packages/broker/src/cloud-adapters/k1-ports/`) is checked against the real ones the day the vendored pin carries them. Until then this file only says so (a todo).
// When the pin has `emailRefusal` and the realtime guards, every case below compares the mirror's answer with the vendored one; any difference fails, and the fix is to delete the mirror and import from `@rovara-code/contracts`.
import * as vendored from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import * as mirror from "../../packages/broker/src/cloud-adapters/k1-ports/index.js";

const has = "emailRefusal" in vendored && "isRealtimeNotice" in vendored;
const real = vendored as unknown as typeof mirror;

const MESSAGES: Array<Record<string, unknown>> = [
  { companyId: "org_00000000000000000000", purpose: "attention", to: "dev@example.test", subject: "Hi", text: "Body." },
  { companyId: "org_00000000000000000000", purpose: "attention", to: "dev\u0085@example.test", subject: "Hi", text: "Body." },
  { companyId: "org_00000000000000000000", purpose: "attention", to: "dev@example.test\r\nBcc: x@example.test", subject: "Hi", text: "Body." },
  { companyId: "org_00000000000000000000", purpose: "Bad Word", to: "dev@example.test", subject: "Hi", text: "Body." },
  { companyId: "org_00000000000000000000", purpose: "invite", to: "dev@example.test", subject: "x".repeat(201), text: "Body." },
  { companyId: "org_00000000000000000000", purpose: "invite", to: "dev@example.test", subject: "Hi", text: "" },
  { companyId: "org_00000000000000000000", purpose: "invite", to: "dev@example.test", subject: "Hi", text: "Body.", unsubscribeUrl: "http://x.test/stop" },
  { companyId: "org_00000000000000000000", purpose: "invite", to: "dev@example.test", subject: "Hi", text: "Body.", unsubscribeUrl: "https://x.test/stop" },
];
const NOTICES: unknown[] = [{ type: "home.changed", revision: 1 }, { type: "session.updated", title: "words here" }, { type: "Bad Type" }, { type: "a.b", nested: { x: 1 } }, { type: "a.b", n: Number.NaN }, "x", null, []];
const AUDIENCES: unknown[] = [{ kind: "session", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" }, { kind: "project", project: "web" }, { kind: "person", personId: "*" }, { kind: "everyone" }, { kind: "project", project: "web", extra: 1 }];

describe("the K1 port mirror", () => {
  it.skipIf(has)("waits for the vendor pin to carry Code's K1 ports (then the cases below run)", () => {
    expect(has).toBe(false);
  });

  it.skipIf(!has)("refuses and accepts the same emails as Code's port", () => {
    for (const message of MESSAGES) expect(mirror.emailRefusal(message as never), JSON.stringify(message)).toBe(real.emailRefusal(message as never));
    expect(mirror.emailUnsubscribeHref("https://X.test/a b")).toBe(real.emailUnsubscribeHref("https://X.test/a b"));
    expect([mirror.EMAIL_SUBJECT_MAX, mirror.EMAIL_BODY_MAX_BYTES]).toEqual([real.EMAIL_SUBJECT_MAX, real.EMAIL_BODY_MAX_BYTES]);
  });

  it.skipIf(!has)("accepts the same notices and audiences as Code's port, and names audiences the same way", () => {
    for (const notice of NOTICES) expect(mirror.isRealtimeNotice(notice), JSON.stringify(notice)).toBe(real.isRealtimeNotice(notice));
    for (const audience of AUDIENCES) expect(mirror.isRealtimeAudience(audience), JSON.stringify(audience)).toBe(real.isRealtimeAudience(audience));
    for (const audience of AUDIENCES.filter(real.isRealtimeAudience)) expect(mirror.realtimeAudienceKey(audience as never)).toBe(real.realtimeAudienceKey(audience as never));
    expect([mirror.REALTIME_BATCH_MAX, mirror.REALTIME_NOTICE_MAX_BYTES]).toEqual([real.REALTIME_BATCH_MAX, real.REALTIME_NOTICE_MAX_BYTES]);
  });
});
