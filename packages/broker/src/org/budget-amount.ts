// One exact decimal boundary for persisted monthly-base reads and legacy PUT input.
// Return undefined rather than rounding/clamping an amount into another policy.
export function usdToWholeMicrodollars(value: unknown): number | undefined {
 if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) return undefined;
 const [coefficient = "", exponent = "0"] = value.toString().toLowerCase().split("e");
 const [whole = "", fraction = ""] = coefficient.split(".");
 const digits = BigInt(whole + fraction), shift = 6 + Number(exponent) - fraction.length;
 if (shift >= 0) return Number(digits * 10n ** BigInt(shift));
 const divisor = 10n ** BigInt(-shift);
 return digits % divisor === 0n ? Number(digits / divisor) : undefined;
}
