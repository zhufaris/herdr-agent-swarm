import type { TopicViewState } from "../topic-view.js";
import type { OutboundWorkClass } from "../types.js";

export interface AnswerPageConvergencePort {
  converge(promptId: string, workClass?: OutboundWorkClass): Promise<void>;
}

export interface MainCardConvergencePort {
  converge(bindingId: string, workClass?: OutboundWorkClass): Promise<void>;
  project(view: TopicViewState, workClass?: OutboundWorkClass): Promise<void>;
}
