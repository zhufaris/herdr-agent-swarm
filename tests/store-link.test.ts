import { describe, expect, it } from "vitest";
import { StoreLink } from "../src/store/sqlite/store-link.js";

describe("StoreLink", () => {
  it("returns the connected store", () => {
    const link = new StoreLink<object>("outbox");
    const store = {};
    link.connect(store);
    expect(link.get()).toBe(store);
  });

  it("fails with the dependency name before connection", () => {
    expect(() => new StoreLink("card contexts").get()).toThrow("card contexts store link is not connected");
  });

  it("rejects replacement after connection", () => {
    const link = new StoreLink("prompts");
    link.connect({});
    expect(() => link.connect({})).toThrow("prompts store link is already connected");
  });
});
