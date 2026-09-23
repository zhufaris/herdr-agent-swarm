import { describe, expect, it } from "vitest";
import { RuntimeLink } from "../src/composition/runtime-link.js";

describe("RuntimeLink", () => {
  it("exposes a capability only after one explicit connection", () => {
    const link = new RuntimeLink<{ read(): string }>("primary runtime");
    expect(() => link.get()).toThrow(/not connected/);
    link.connect({ read: () => "ready" });
    expect(link.get().read()).toBe("ready");
    expect(() => link.connect({ read: () => "replacement" })).toThrow(/already connected/);
  });

  it("provides a stable deferred callable for a composition-time cycle", () => {
    const link = new RuntimeLink<(value: string) => string>("event consumer");
    const consume = link.callable();

    expect(() => consume("before")).toThrow("Runtime link is not connected: event consumer");
    link.connect((value) => `handled:${value}`);

    expect(consume("after")).toBe("handled:after");
  });
});
