// The project page's Spending tab (`project` scenario, switch `rovara.spending` = "v2"): the one read it makes, GET /v1/web/projects/payments/spend. Amounts have the broker's shape: committedUsd is spent plus open holds.
// Variants (POST /__mock/project-spend?variant=): "ok" (the default: a limit), "nolimit" (no allowance), "over" (committed past the limit), "forbidden" (the broker's 403 for a non-maintainer), "missing" (404).
export type ProjectSpendVariant = "ok" | "nolimit" | "over" | "forbidden" | "missing";
let variant: ProjectSpendVariant = "ok";
export function setProjectSpendVariant(value: string | null): void { variant = value === "nolimit" || value === "over" || value === "forbidden" || value === "missing" ? value : "ok"; }
export function projectSpendAnswer(url: URL): { status: number; body: unknown } | undefined {
 if (url.pathname !== "/v1/web/projects/payments/spend") return undefined;
 if (variant === "forbidden") return { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a maintainer of payments can see its spend." } } };
 if (variant === "missing") return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 const figures = variant === "nolimit" ? { spentUsd: 12.5, committedUsd: 13.5 } : variant === "over" ? { spentUsd: 480, committedUsd: 540, limitUsd: 500 } : { spentUsd: 150, committedUsd: 180, limitUsd: 500 };
 return { status: 200, body: { month: "2026-11", project: "payments", ...figures, requestId: "mock-gateway-request" } };
}
