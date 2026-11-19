/** Only static schema field names may reach diagnostics; record keys and values never do. */
const FIELDS = new Set(["project", "name", "repositories", "defaultBranch", "latestRevision", "setup", "status", "running", "agents", "you", "budget", "learning", "knownFailing", "orgId", "sessionId", "costUsd", "money"]);
export function logResponseShapeFailure(error: unknown): void {
 const issues: unknown[] = typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues) ? error.issues : [];
 const fields = [...new Set(issues.flatMap((issue: unknown): string[] => {
  if (typeof issue !== "object" || issue === null || !("path" in issue) || !Array.isArray(issue.path)) return [];
  const path: unknown[] = issue.path;
  // Only the root schema property is a field; nested record keys can contain customer data.
  const field = path[0];return typeof field === "string" && FIELDS.has(field) ? [field] : [];
 }))].slice(0, 12);
 console.warn("cloud.response_shape_failure", { fields });
}
