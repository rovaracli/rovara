// "Knowledge stays in Rovara" (the company) and "local coding tools can fetch lessons" (a project), L4-JA7. Cloud passes both to Rovara Code as the signed-in person (cloud-server/src/knowledge-switch-routes.ts) and
// answers in these exact shapes. Until the Code in use serves the routes, Cloud answers 501 and the settings screens hide the setting.
//   GET/PUT /v1/app/company/lessons/local-tools { stays }              -> { stays }
//   GET/PUT /v1/app/projects/{p}/lessons/local-tools { enabled }       -> { enabled, own?, reason?, preset, companyStays, canChange }
export const KNOWLEDGE_STAYS_PATH = "/v1/app/company/lessons/local-tools";
export const localToolsPath = (project: string): string => `/v1/app/projects/${encodeURIComponent(project)}/lessons/local-tools`;
export type LocalToolsReason = "company_stays" | "regulated" | "project_setting";
export interface LocalToolsView { enabled: boolean; own?: boolean; reason?: LocalToolsReason; preset: "standard" | "regulated"; companyStays: boolean; canChange: boolean }
const rec = (value: unknown): Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a setting"); return value as Record<string, unknown>; };
export function readKnowledgeStays(body: unknown): { stays: boolean } {
 const v = rec(body);
 if (typeof v["stays"] !== "boolean") throw new Error("not the Knowledge stays switch");
 return { stays: v["stays"] };
}
export function readLocalTools(body: unknown): LocalToolsView {
 const v = rec(body);
 if (typeof v["enabled"] !== "boolean" || typeof v["companyStays"] !== "boolean" || typeof v["canChange"] !== "boolean" || (v["preset"] !== "standard" && v["preset"] !== "regulated") || (v["own"] !== undefined && typeof v["own"] !== "boolean")) throw new Error("not the local tools setting");
 const reason = v["reason"] === "company_stays" || v["reason"] === "regulated" || v["reason"] === "project_setting" ? v["reason"] : undefined;
 return { enabled: v["enabled"], ...(v["own"] === undefined ? {} : { own: v["own"] }), ...(reason === undefined ? {} : { reason }), preset: v["preset"], companyStays: v["companyStays"], canChange: v["canChange"] };
}
