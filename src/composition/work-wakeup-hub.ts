export type WorkWakeupChannels = Record<string, unknown>;

type Handler<Payload> = (payload: Payload) => void;
type KeyFor<Payload> = (payload: Payload) => string;

interface Registration<Payload> {
  handler: Handler<Payload>;
  keyFor: KeyFor<Payload>;
}

/**
 * Explicit composition-time wiring for best-effort process-local work hints.
 * Pre-seal hints are retained once per work key; durable state remains the
 * authority and callers must still provide their normal reconciliation scans.
 */
export class WorkWakeupHub<Channels extends WorkWakeupChannels> {
  private readonly registrations = new Map<keyof Channels, Registration<unknown>>();
  private readonly pending = new Map<keyof Channels, Map<string, unknown>>();
  private sealed = false;

  constructor(private readonly requiredChannels: readonly (keyof Channels)[]) {}

  register<Channel extends keyof Channels>(channel: Channel, handler: Handler<Channels[Channel]>, keyFor: KeyFor<Channels[Channel]> = () => "single"): void {
    if (this.sealed) throw new Error(`Cannot register wake-up channel after seal: ${String(channel)}`);
    if (this.registrations.has(channel)) throw new Error(`Wake-up channel already registered: ${String(channel)}`);
    this.registrations.set(channel, { handler, keyFor } as Registration<unknown>);
  }

  wake<Channel extends keyof Channels>(channel: Channel, payload: Channels[Channel]): void {
    if (this.sealed) {
      const registration = this.requireRegistration(channel);
      registration.handler(payload);
      return;
    }
    const registration = this.registrations.get(channel);
    const key = registration ? registration.keyFor(payload) : "single";
    const pending = this.pending.get(channel) ?? new Map<string, unknown>();
    pending.set(key, payload);
    this.pending.set(channel, pending);
  }

  seal(): void {
    if (this.sealed) return;
    const missing = this.requiredChannels.filter((channel) => !this.registrations.has(channel));
    if (missing.length > 0) throw new Error(`Missing wake-up channel registration: ${missing.map(String).join(", ")}`);
    this.sealed = true;
    for (const [channel, pending] of this.pending) {
      const registration = this.requireRegistration(channel) as Registration<unknown>;
      for (const payload of pending.values()) registration.handler(payload);
    }
    this.pending.clear();
  }

  private requireRegistration<Channel extends keyof Channels>(channel: Channel): Registration<Channels[Channel]> {
    const registration = this.registrations.get(channel);
    if (!registration) throw new Error(`Wake-up channel is not registered: ${String(channel)}`);
    return registration as Registration<Channels[Channel]>;
  }
}
