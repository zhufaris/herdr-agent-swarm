import type { PromptAcceptanceReceipt } from "../domain/ports/prompt-acceptance.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";

export async function executePromptAcceptanceEffects(
  receipt: PromptAcceptanceReceipt,
  dependencies: { lifecycleEvents: LifecycleEventPublisher; outboundWork: OutboundWorkNotifier; scheduler: PromptWorkScheduler }
): Promise<void> {
  for (const effect of receipt.consumeEffects()) {
    if (effect.kind === "outbound-wake") dependencies.outboundWork.wake();
    else if (effect.kind === "prompt-wake") dependencies.scheduler.wake({ kind: "prompt-ready", bindingId: effect.bindingId });
    else await dependencies.lifecycleEvents.publish(effect.event);
  }
}
