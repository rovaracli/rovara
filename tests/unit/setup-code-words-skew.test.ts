// ADDRESS-WORDING (2026-11-24): the owner chose "address". Code now sends its refusals in the new words; a Code that still runs the old "website" words may sit beside this Cloud during a rollout. Cloud passes a Code message on
// only when it is EXACTLY a fixed sentence, so each of the three sentences is pinned in both forms: the new one and the old one, and both are said in the new words.
import { describe, expect, it } from "vitest";
import { CodeError, SETUP_APPROVAL_CODE_WORDS, SETUP_CODE_WORDS_REWRITE, SETUP_HOST_CODE_WORDS, SETUP_HOST_WORDS, approvalRefusal, hostRefusal } from "../../packages/cloud-server/src/index.js";

const refusal = (status: number, code: string, message: string) => new CodeError(status, { error: { code, message } });
const messageOf = (answer: { body: unknown }): string => (answer.body as { error: { message: string } }).error.message;

const NEW_ADMIN = "An address for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.";
const OLD_ADMIN = "A website for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.";
const NEW_WAITING = "That address is not waiting for a decision any more. Open the project's setup again.";
const OLD_WAITING = "That website is not waiting for a decision any more. Open the project's setup again.";
const NEW_REACH = "This setup change reaches outside the project's commands (an address, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.";
const OLD_REACH = "This setup change reaches outside the project's commands (a website, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.";

describe("Code's address sentences, new and old", () => {
  it("accepts each new sentence and each old one, and says both in the new words", () => {
    for (const words of [NEW_ADMIN, OLD_ADMIN, NEW_WAITING, OLD_WAITING]) expect(SETUP_HOST_CODE_WORDS).toContain(words);
    for (const words of [NEW_REACH, OLD_REACH]) expect(SETUP_APPROVAL_CODE_WORDS).toContain(words);
    expect(SETUP_CODE_WORDS_REWRITE.get(OLD_ADMIN)).toBe(NEW_ADMIN);
    expect(SETUP_CODE_WORDS_REWRITE.get(OLD_WAITING)).toBe(NEW_WAITING);
    expect(SETUP_CODE_WORDS_REWRITE.get(OLD_REACH)).toBe(NEW_REACH);
  });
  for (const [label, said] of [["new", NEW_ADMIN], ["old", OLD_ADMIN]] as const) {
    it(`a ${label} 403 for an address decision is said in the new words`, () => {
      const answer = hostRefusal(refusal(403, "FORBIDDEN", said));
      expect(answer.status).toBe(403);
      expect(messageOf(answer)).toBe(NEW_ADMIN);
    });
  }
  for (const [label, said] of [["new", NEW_WAITING], ["old", OLD_WAITING]] as const) {
    it(`a ${label} 409 for an address that is not waiting is said in the new words`, () => {
      const answer = hostRefusal(refusal(409, "CHANGE_STALE", said));
      expect(answer.status).toBe(409);
      expect(messageOf(answer)).toBe(NEW_WAITING);
    });
  }
  for (const [label, said] of [["new", NEW_REACH], ["old", OLD_REACH]] as const) {
    it(`a ${label} 403 for a setup change that reaches outside the commands is said in the new words`, () => {
      const answer = approvalRefusal("decide", refusal(403, "FORBIDDEN", said));
      expect(answer.status).toBe(403);
      expect(messageOf(answer)).toBe(NEW_REACH);
    });
  }
  it("any other Code text is still never passed on", () => {
    expect(messageOf(hostRefusal(refusal(403, "FORBIDDEN", "A site for a setup run is secret")))).toBe(SETUP_HOST_WORDS.cannotDecide);
    expect(messageOf(hostRefusal(refusal(409, "CHANGE_STALE", "SENSITIVE")))).toBe(SETUP_HOST_WORDS.notWaiting);
  });
});
