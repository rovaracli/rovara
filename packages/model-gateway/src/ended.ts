export interface EndedTasks { isEnded(issuer: string, task: string, signal?: AbortSignal): Promise<boolean> }
/** No notice endpoint in R3a. Issuer scopes task IDs exactly as TC-1's ended-task port specifies. */
export class InMemoryEndedTasks implements EndedTasks {
  readonly #ended = new Set<string>();
  end(issuer: string, task: string): void { this.#ended.add(JSON.stringify([issuer, task])); }
  async isEnded(issuer: string, task: string): Promise<boolean> { return this.#ended.has(JSON.stringify([issuer, task])); }
}
