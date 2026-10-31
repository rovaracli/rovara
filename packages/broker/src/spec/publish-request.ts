// K1 lane D: the title of the spec pull request. (The spec is published by the broker itself: see publish.ts.)

/** The title of the spec pull request: the task's title as one inert line. */
export function specPullRequestTitle(taskTitle: string): string {
  const plain = taskTitle.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").replace(/[@<>`]/gu, "").trim().slice(0, 200);
  return `Rovara spec: ${plain === "" ? "task" : plain}`.slice(0, 256);
}
