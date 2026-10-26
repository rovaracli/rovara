export function visibleText(text: string): string { return text.replace(/[\p{Cc}\p{Cf}]/gu, character => character === "\n" || character === "\t" ? character : `[U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`); }
export function VisibleText({ text }: { text: string }) { return <>{visibleText(text)}</>; }
