// "How we work": the rules a maintainer writes. The server makes them inert and enforces the limit when the draft is saved (`broker/src/playbook/inert-rule-text.ts`, the authority);
// this is the same clean-up on the page, so the count and the "too long" message match what the server will do.
export const RULE_TEXT_MAX = 4000;
const HIDDEN = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** Line ends as `\n`, zero-width, bidirectional, other format and control characters (not newline or tab), other default-ignorable characters and variation selectors removed, ends trimmed. */
export function cleanRuleText(text: string): string {
 return text.replace(/\r\n?/g, "\n").replace(HIDDEN, character => character === "\n" || character === "\t" ? character : "").trim();
}
export const ruleLength = (text: string): number => Array.from(cleanRuleText(text)).length;
export const ruleTooLong = (text: string): boolean => ruleLength(text) > RULE_TEXT_MAX;
