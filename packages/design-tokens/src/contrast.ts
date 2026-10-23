import type { ColorTokens } from "./tokens.js";
type Pair = readonly [keyof ColorTokens, keyof ColorTokens];
const backgrounds = ["bg", "bgRaised", "bgSunken"] as const;
export const TEXT_PAIRS: readonly Pair[] = [
 ...(["text", "textMuted", "accentText"] as const).flatMap(color => backgrounds.map(background => [color, background] as const)), ["onAccent", "accent"], ["onDanger", "danger"],
];
export const UI_PAIRS: readonly Pair[] = (["borderStrong", "focus", "statusRunning", "statusNeedsYou", "statusFailed", "statusDone", "statusStopped", "statusPaused"] as const).flatMap(color => (["bg", "bgRaised"] as const).map(background => [color, background] as const));
function luminance(hex: string): number {
 if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Expected a six-digit hex color");
 const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
 return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
export function contrastRatio(foreground: string, background: string): number {
 const a = luminance(foreground), b = luminance(background);
 return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
