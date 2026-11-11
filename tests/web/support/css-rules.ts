// A tiny CSS reader for tests that compare style sheets: flattens rules (including those inside @media) into selector + declarations.
export interface CssRule { context: string; selector: string; declarations: Array<[property: string, value: string]> }
const squash = (text: string) => text.replace(/\s+/gu, " ").trim();
export function readCssRules(source: string): CssRule[] {
 const text = source.replace(/\/\*[\s\S]*?\*\//gu, ""), rules: CssRule[] = [];
 function walk(start: number, end: number, context: string): void {
  let position = start;
  while (position < end) {
   const open = text.indexOf("{", position);
   if (open === -1 || open >= end) return;
   const prelude = squash(text.slice(position, open));
   let depth = 1, close = open + 1;
   while (depth > 0 && close < end) { const char = text[close++];if (char === "{") depth++;else if (char === "}") depth--; }
   const body = text.slice(open + 1, close - 1);
   if (prelude.startsWith("@")) { if (prelude.startsWith("@media") || prelude.startsWith("@keyframes")) walk(open + 1, close - 1, `${context}${prelude} `); } else rules.push({ context: context.trim(), selector: prelude, declarations: declarations(body) });
   position = close;
  }
 }
 walk(0, text.length, "");
 return rules;
}
function declarations(body: string): Array<[string, string]> {
 const result: Array<[string, string]> = [];
 let depth = 0, current = "";
 const flush = () => { const colon = current.indexOf(":");if (colon > 0) result.push([current.slice(0, colon).trim(), squash(current.slice(colon + 1))]);current = ""; };
 for (const char of body) { if (char === "(") depth++;if (char === ")") depth--;if (char === ";" && depth === 0) flush();else current += char; }
 flush();
 return result;
}
/** Replace `var(--name, fallback)` by its fallback for every name in `names` (nesting handled). A bare `var(--name)` of such a name is left as it is, so it shows up as a difference. */
export function resolveFallbacks(value: string, names: ReadonlySet<string>): string {
 let result = value;
 for (let guard = 0; guard < 20; guard++) {
  let replaced = false;
  for (const found of result.matchAll(/var\((--[a-z0-9-]+),/gu)) {
   if (!names.has(found[1]!)) continue;
   const from = found.index, argsStart = from + found[0].length;
   let depth = 1, index = argsStart;
   while (depth > 0 && index < result.length) { if (result[index] === "(") depth++;if (result[index] === ")") depth--;index++; }
   result = result.slice(0, from) + result.slice(argsStart, index - 1).trim() + result.slice(index);replaced = true;break;
  }
  if (!replaced) break;
 }
 return squash(result);
}
