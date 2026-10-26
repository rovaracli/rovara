/** The backend's blank-line paragraph boundaries, preserving offsets into the unchanged Markdown. This makes no ids. */
export function planParts(markdown: string): Array<{ start: number; end: number }> {
 const parts: Array<{ start: number; end: number }> = [];
 const add = (start: number, end: number) => { const raw = markdown.slice(start, end);if (raw.trim() !== "") parts.push({ start: start + raw.length - raw.trimStart().length, end: end - (raw.length - raw.trimEnd().length) }); };
 let start = 0;
 for (const split of markdown.matchAll(/\r?\n(?:[ \t]*\r?\n)+/gu)) { add(start, split.index);start = split.index + split[0].length; }
 add(start, markdown.length);return parts.slice(0, 200);
}
