import type { FinalAnswerElement } from "./final-answer-content.js";

export function attachActiveAnswerSlot(elements: FinalAnswerElement[], elementId: string, active: boolean, tailIsAgentMessage: boolean): void {
  if (!active) return;
  if (tailIsAgentMessage) {
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index]!;
      if (element.tag === "markdown") {
        element.element_id = elementId;
        return;
      }
    }
  }
  elements.push({ tag: "markdown", content: "", element_id: elementId });
}
