const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function Money({ usd, estimated = false }: { usd: number; estimated?: boolean }) { if (!Number.isFinite(usd) || usd < 0) return <span>Unavailable</span>;return <span className="rv-money">{estimated ? "Estimated " : ""}{USD.format(usd)}</span>; }
