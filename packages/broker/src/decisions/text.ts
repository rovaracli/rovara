// Plain one-line text for cards: whatever came from a person, a plan or a repository is flattened to one line, stripped of hidden and control characters and cut at a word. Nothing here is markup.
export function plainLine(value: string, max: number): string {
  const text = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, Math.max(1, max - 1)).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Whether a path is a same-origin relative path a card may link to: one leading slash, no second slash, no backslash, no spaces or control characters, no `..` segment, no scheme. */
export function isSafeRelativePath(value: string): boolean {
  return value.length <= 2048 && /^\/(?![/\\])[^\s\\\p{Cc}\p{Cf}]*$/u.test(value) && !value.split(/[/?#]/u).includes("..");
}
