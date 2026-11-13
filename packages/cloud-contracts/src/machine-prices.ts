/** Release-refreshed reference rates, not an AWS invoice. Verified 2026-11-13 from AWS's public pricing-page data. */
export const MACHINE_PRICES = {
  asOf: "2026-11-13",
  region: "us-west-2",
  source: "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20West%20%28Oregon%29/Linux/index.json",
  sourceNote: "AWS EC2 On-Demand, US West (Oregon), Linux, no preinstalled software. Measured seconds × reference hourly rate; excludes minimum billing duration, discounts, EBS, network, taxes and other services.",
  // m6g.large: production-foundation.ts; m7i.xlarge: swebench-eval.ts. Custom launch-template types stay unpriced.
  // AWS rate codes: YD35UKCJ3R87S3NE.JRTCKXETXF.6YS6EN2CT7; XBHFT8FZNSVBBZTU.JRTCKXETXF.6YS6EN2CT7.
  usdPerHour: new Map<string, number>([["m6g.large", 0.077], ["m7i.xlarge", 0.2016]]) as ReadonlyMap<string, number>,
} as const;

/** An absent type or a different/unknown region has unknown dollars, never a zero-price fallback. */
export function machineHourlyUsd(instanceType: string, region: string): number | undefined {
  return region === MACHINE_PRICES.region ? MACHINE_PRICES.usdPerHour.get(instanceType) : undefined;
}
