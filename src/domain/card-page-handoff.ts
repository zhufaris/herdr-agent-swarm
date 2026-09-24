export function continuationSummary(nextPageIndex: number): string {
  return `回答将在第 ${nextPageIndex + 1} 页继续`;
}

export function currentPageActionLabel(kind: "answer" | "task"): string {
  return kind === "answer" ? "打开当前回复" : "打开当前 Task";
}
