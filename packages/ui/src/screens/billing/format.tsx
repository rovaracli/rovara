// Small formatting pieces shared by the trial and billing screens. Money goes through the existing Money component.
import { Money } from "../../design/Money.js";

/** An amount in dollars; a non-zero amount under half a cent says so instead of reading as $0.00. */
export function Usd({ usd }: { usd: number }) { return usd > 0 && usd < 0.005 ? <span className="rv-money">&lt;$0.01</span> : <Money usd={usd} />; }
function currencyText(value: number, currency: string): string | undefined { try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value); } catch { return undefined; } }
/** Invoice money is integer minor units (cents) plus a currency code. US dollars use Money; another currency is formatted by the browser; anything unreadable says so. */
export function MinorMoney({ minor, currency }: { minor: number; currency: string }) {
 if (!Number.isSafeInteger(minor) || minor < 0) return <span>Unavailable</span>;
 if (currency === "USD") return <Money usd={minor / 100} />;
 const text = currencyText(minor / 100, currency);
 return text === undefined ? <span>Unavailable</span> : <span className="rv-money">{text}</span>;
}
/** "Nov 10, 2026" (UTC, so the day never moves with the device's zone); "Unavailable" for a value that is not a date. */
export function dayText(value: string | null | undefined): string {
 const parsed = value === null || value === undefined ? Number.NaN : Date.parse(value);
 return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" }) : "Unavailable";
}
