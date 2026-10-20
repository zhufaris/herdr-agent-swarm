import { describe, expect, it } from "vitest";
import { projectAnswerCardHeader } from "../src/cards/answer-card-header.js";

describe("Answer Card header projection", () => {
  it("uses only conversation identity in the title and reply context in the subtitle", () => {
    expect(projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "YX0C",
      requestText: "  从 DDD 的角度\n继续优化  ",
      title: "不应进入标题"
    })).toEqual({
      title: "herdr-agent-swarm / yx0c",
      subtitle: "Reply to 👤 从 DDD 的角度 继续优化"
    });
  });

  it("adds only the page number to continuation titles", () => {
    expect(projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "yx0c",
      requestText: "继续",
      title: "Prompt title"
    }, 2).title).toBe("herdr-agent-swarm / yx0c · 第 2 页");
  });

  it("never substitutes an internal pane reference for a missing native token", () => {
    const header = projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "wN:p4E",
      requestText: "继续",
      title: "Prompt title"
    });
    expect(header.title).toBe("herdr-agent-swarm / —");
    expect(header.title).not.toContain("wN:p4E");
  });

  it("redacts reply context before bounding it", () => {
    const header = projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "yx0c",
      requestText: "deploy token=super-secret now",
      title: "Prompt title"
    });
    expect(header.subtitle).toBe("Reply to 👤 deploy token=[REDACTED] now");
    expect(header.subtitle).not.toContain("super-secret");
  });

  it("prefers explicit Reply Context over a Native Input Batch execution body", () => {
    const header = projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "6duh",
      requestText: "[Feishu message 1/1]\n进展",
      replyContext: "进展",
      title: "进展"
    });
    expect(header.subtitle).toBe("Reply to 👤 进展");
  });

  it("unwraps complete historical Native Input Batch request text", () => {
    const header = projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "6duh",
      requestText: "[Feishu message 1/2]\nfirst\n\n[Feishu message 2/2]\nsecond",
      title: "first"
    });
    expect(header.subtitle).toBe("Reply to 👤 first second");
  });

  it("preserves nested user text and malformed batch lookalikes", () => {
    expect(projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "6duh",
      requestText: "[Feishu message 1/1]\n[Feishu message 1/1]\nuser text",
      title: "user text"
    }).subtitle).toBe("Reply to 👤 [Feishu message 1/1] user text");
    expect(projectAnswerCardHeader({
      spaceName: "herdr-agent-swarm",
      paneToken: "6duh",
      requestText: "[Feishu message 1/2]\nfirst",
      title: "first"
    }).subtitle).toBe("Reply to 👤 [Feishu message 1/2] first");
  });
});
