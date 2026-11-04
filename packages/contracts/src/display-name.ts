/** The Slack service and the broker both clean requester names with this, so their limits cannot drift apart. */
export const DISPLAY_NAME_MAX_CODE_POINTS = 80;
/** Broker header limit. 80 code points encode to at most 960 characters (12 per four-byte code point). */
export const DISPLAY_NAME_MAX_ENCODED_LENGTH = 1024;

// Control characters plus the zero-width and bidi format characters; U+200C and U+200D (ZWNJ, ZWJ) stay because scripts and emoji sequences need them.
const INVISIBLE = /[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A printable display name of at most 80 code points, cut only between whole character clusters, or undefined when nothing is left. */
export function cleanDisplayName(name: string): string | undefined {
  const clean = name.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  let result = "";
  let length = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const size = Array.from(segment).length;
    if (length + size > DISPLAY_NAME_MAX_CODE_POINTS) break;
    result += segment;
    length += size;
  }
  result = result.trimEnd();
  return result.length > 0 ? result : undefined;
}

/**
 * Text as a GFM code span, which GitHub renders literally: no mention, link, autolink, HTML or
 * issue reference. Per CommonMark the fence is one backtick longer than the text's longest
 * backtick run, padded with a space when the text starts or ends with a backtick. The broker marks
 * names in pull requests and TASK_BUSY with it, and the MCP server marks channel turns' authors.
 */
export function inertName(name: string): string {
  const longestRun = Math.max(0, ...(name.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = name.startsWith("`") || name.endsWith("`") ? " " : "";
  return `${fence}${pad}${name}${pad}${fence}`;
}

/**
 * An email address anywhere in a text: a local part, an @, a domain with a dot. Deliberately wide: a false match only removes a word from a name.
 * The source is shared (the broker's pull request texts build their global matcher from it) so the two rules cannot drift apart.
 */
export const EMAIL_ADDRESS_SOURCE = "[^\\s@<>()[\\]{},;:\"'`]+@[^\\s@<>()[\\]{},;:\"'`]+\\.[^\\s@<>()[\\]{},;:\"'`]+";

/** Whether the text holds an email address. */
export function containsEmailAddress(text: string): boolean {
  // Stored records are read through this, and an old or partial one may have no text at all.
  if (typeof text !== "string") return false;
  const matcher = new RegExp(EMAIL_ADDRESS_SOURCE, "u");
  // Compatibility forms count too: a fullwidth "＠" or a fullwidth domain is the same address to a person reading it.
  return matcher.test(text) || matcher.test(text.normalize("NFKC"));
}

/** The text with every email address taken out, and the empty brackets and spaces they leave tidied away. */
export function withoutEmailAddresses(text: string): string {
  const raw = new RegExp(EMAIL_ADDRESS_SOURCE, "u").test(text);
  return (raw ? text : text.normalize("NFKC")).replace(new RegExp(EMAIL_ADDRESS_SOURCE, "gu"), " ").replace(/<\s*>|\(\s*\)|\[\s*\]/gu, " ").replace(/<\s*|\s*>/gu, " ").replace(/\s+/gu, " ").trim();
}

/** What stands where an address was hidden from a text. */
export const EMAIL_HIDDEN = "[email removed]";

/**
 * The strict address rule for free text (names use the wide `EMAIL_ADDRESS_SOURCE`, where a false match only removes a word; here a false match would corrupt code). A local part of
 * letters, digits and `._%+'-` (no slash, starting with a letter or digit), an at sign, and a domain of dotted labels whose LAST label is letters only. So `react@18.3.1`, `golang.org/x/tools@v0.1.0`, `@scope/pkg@1.2.3` and
 * `image@sha256:abc` are not addresses. A domain that starts with two numeric labels is a version (`pkg@1.0.0-rc.final`, `pkg@1.2.beta`), while `163.com` is a real domain, and `user@host:path` (scp, git remotes) is not an address either.
 */
const STRICT_ADDRESS = /[\p{L}\p{N}][\p{L}\p{N}\p{Cf}._%+'-]*@(?!\d+(?:\.\d+)+)(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}(?![\p{L}\p{N}]|\.[\p{L}\p{N}]|:[^\s])/gu;
/** The login of an ssh-like URL (`ssh://git@host/path`, `git+ssh://git@host/path`) is not mail. */
const SSH_URL_BEFORE = /(?:ssh|sftp|rsync|git|svn)(?:\+\w+)*:\/\/$/iu;
/** An ssh-like command just before an address: the address is `user@host`, not mail. */
const SSH_BEFORE = /(?:^|[\s;&|(])(?:ssh|scp|sftp|rsync|mosh)(?:[ \t]+-\S+(?:[ \t]+[^\s-]\S*)?)*[ \t]+$/iu;
/** The ways an at sign is spelled that NFKC folds to "@" (fullwidth, small). */
const AT_SPELLINGS = /[@\uFF20\uFE6B]/u;
/** The ways an at sign is written out in a link or a page: percent-encoded (`%40`, and `%2540` once more), or an HTML reference (`&#64;`, `&#x40;`, `&commat;`). */
const ENCODED_AT = /%(?:25)?40|&#0*64;|&#x0*40;|&commat;/iu;
const ENCODED_AT_HERE = /(?:%(?:25)?40|&#0*64;|&#x0*40;|&commat;)/iuy;

/**
 * The text with every email address replaced by `EMAIL_HIDDEN`, for free text that reaches other people (a session card, a Slack message, a pull request, a decision card).
 * Unlike `withoutEmailAddresses` (which makes a name), this keeps the layout: line breaks, indentation, code fences and every other character stay as they were, so a code block still renders
 * and a text with no address comes back as the very same string. It uses the strict rule above, so code text (versions, modules, git remotes, ssh hosts) is left alone. A fullwidth spelling is
 * found by reading each character in its compatibility form; only the address itself is replaced, and every other character stays as it was.
 */
export function hideEmailAddresses(text: string): string {
  if (typeof text !== "string" || !(AT_SPELLINGS.test(text) || ENCODED_AT.test(text))) return text;
  // The text in compatibility form, with where each folded character came from, so the address (and nothing else) can be replaced in the original.
  // An at sign written out (`%40`, `&#64;`) is read as "@" here, so the same rule finds it: the address in `?email=maya%40example.test` is hidden, and a scope in `/%40scope%2Fpkg` is not an address.
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  while (index < text.length) {
    ENCODED_AT_HERE.lastIndex = index;
    const written = ENCODED_AT_HERE.exec(text);
    if (written !== null) {
      folded += "@";
      starts.push(index);
      ends.push(index + written[0].length);
      index += written[0].length;
      continue;
    }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    const next = index + character.length;
    // A zero-width or other format character is invisible, so it is no part of what a person reads as an address: a pull request text makes a mention inert with one after the at sign
    // (`user@\u200Dexample.test`), and one placed inside the domain would otherwise split the address. The folded text leaves them out; the replaced span still covers them.
    if (/^\p{Cf}$/u.test(character)) { index = next; continue; }
    for (const piece of character.normalize("NFKC")) {
      for (let unit = 0; unit < piece.length; unit += 1) { starts.push(index); ends.push(next); }
      folded += piece;
    }
    index = next;
  }
  let out = "";
  let from = 0;
  for (const match of folded.matchAll(STRICT_ADDRESS)) {
    const begin = starts[match.index]!;
    const finish = ends[match.index + match[0].length - 1]!;
    if (begin < from) continue;
    const before = text.slice(Math.max(0, text.lastIndexOf("\n", begin - 1) + 1), begin);
    if (SSH_BEFORE.test(before) || SSH_URL_BEFORE.test(before)) continue;
    out += text.slice(from, begin) + EMAIL_HIDDEN;
    from = finish;
  }
  return from === 0 && out === "" ? text : out + text.slice(from);
}

/**
 * A person's name as others may see it (release 0.4.16): `cleanDisplayName`, and when the name holds an email address, the name without it; undefined when
 * nothing with a letter or a number is left (the sign-in email-code names a person by their address). Callers show a placeholder for undefined.
 */
export function emailSafeName(name: string): string | undefined {
  const cleaned = cleanDisplayName(name);
  if (cleaned === undefined || !containsEmailAddress(cleaned)) return cleaned;
  const stripped = withoutEmailAddresses(cleaned);
  return /[\p{L}\p{N}]/u.test(stripped) ? cleanDisplayName(stripped) : undefined;
}

/** The placeholder name of a person with no real name: "Member" and eight characters of a hash of their id (the broker makes it; `isPlaceholderDisplayName` knows its shape). */
const PLACEHOLDER_DISPLAY_NAME = /^Member [0-9a-f]{4,8}$/u;
/** Every spelling of that shape, whatever the case or spacing: no person or provider may use one as a name, so nobody reads as another person's placeholder. */
const RESERVED_DISPLAY_NAME = /^member\s+[0-9a-f]{4,8}$/iu;

/** Whether the name has the shape of a placeholder, which is reserved: a chosen name or a provider's name of this shape is refused or ignored. */
export function isReservedDisplayName(name: string): boolean {
  return RESERVED_DISPLAY_NAME.test(name.trim());
}

/** Whether the name is a placeholder, not a name a person or a sign-in provider gave. */
export function isPlaceholderDisplayName(name: string): boolean {
  return PLACEHOLDER_DISPLAY_NAME.test(name);
}
