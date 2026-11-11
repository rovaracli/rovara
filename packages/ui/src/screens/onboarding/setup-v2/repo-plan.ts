// Project setup, step "Repos": what the existing create routes accept. One repository on its own is created the old way; several need a meta repo (the route's rule, kept here so the page says it before the press).
export type CreatePlan =
 | { kind: "single"; repository: string }
 | { kind: "meta"; metaRepository: string; codeRepositories: string[] }
 | { kind: "invalid"; reason: string };

export function planCreate(input: { codeRepositories: readonly string[]; metaRepository: string }): CreatePlan {
 const meta = input.metaRepository, code = input.codeRepositories.filter(name => name !== meta);
 if (meta !== "") return { kind: "meta", metaRepository: meta, codeRepositories: code };
 if (code.length === 0) return { kind: "invalid", reason: "Choose at least one repository." };
 if (code.length === 1) return { kind: "single", repository: code[0]! };
 return { kind: "invalid", reason: "With several repositories, choose the meta repo that holds your shared plans, rules and lessons." };
}
export const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
/** The name the person typed, or why it can't be used. An empty name is fine: the project takes its repository's name. */
export function nameProblem(name: string): string | undefined {
 return name === "" || PROJECT_NAME_PATTERN.test(name) ? undefined : "Use lowercase letters, numbers and hyphens, starting with a letter (up to 63 characters).";
}
