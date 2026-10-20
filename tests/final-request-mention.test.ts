import { describe, expect, it } from "vitest";
import { projectFinalRequestMention } from "../src/domain/final-request-mention.js";

describe("projectFinalRequestMention", () => {
  it("projects one terminal native mention without exposing its embedded identity", () => {
    expect(projectFinalRequestMention("Done.\n\n<at id=ou_1234567890abcdef></at>")).toEqual({
      markdown: "Done.", requested: true, request: { kind: "native-mention" }
    });
  });

  it("projects a native mention from the complete terminal choice protocol", () => {
    const markdown = [
      "Done.",
      "",
      "<at id=ou_1234567890abcdef></at>",
      "",
      "$herdr-choice-list:herdr-choice-list",
      "```herdr-choice-list",
      '{"version":2,"intent":"none"}',
      "```"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({
      markdown: "Done.", requested: true, request: { kind: "native-mention" }
    });
  });

  it("removes a malformed legacy choice tail before projecting a native mention", () => {
    const markdown = [
      "Done.",
      "",
      "<at id=ou_1234567890abcdef></at>",
      "",
      "$herdr-choice-list:herdr-choice-list",
      '{"intent":"choose","options":[{"id":"A","label":"Approve","message":"default"}]}'
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({
      markdown: "Done.", requested: true, request: { kind: "native-mention" }
    });
  });

  it.each([
    "Done. <at id=ou_1234567890abcdef></at>",
    "<at id=ou_1234567890abcdef></at>\nDone.",
    "`<at id=ou_1234567890abcdef></at>`",
    "```text\n<at id=ou_1234567890abcdef></at>\n```",
    "<at id=ou_1234567890abcdef></at>\n<at id=ou_abcdef1234567890></at>",
    "<at id=ou_1234567890abcdef></at>\n\n$herdr-choice-list:herdr-choice-list\ntrailing",
    "<at id=invalid></at>"
  ])("fails closed for an ineligible native candidate", (markdown) => {
    expect(projectFinalRequestMention(markdown)).toEqual({ markdown, requested: false });
  });

  it("removes repeated exact requester markers outside Markdown code", () => {
    expect(projectFinalRequestMention("Done @_user_1.\n\n@_user_1 Please review.")).toEqual({
      markdown: "Done.\n\nPlease review.",
      requested: true
    });
  });

  it("does not recognize other users, prefixes, inline code, or fenced code", () => {
    const markdown = [
      "Keep @_user_2 and x@_user_1 and @_user_10.",
      "`@_user_1`",
      "```text",
      "@_user_1",
      "```",
      "~~~",
      "@_user_1",
      "~~~"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({ markdown, requested: false });
  });

  it("recognizes punctuation-delimited markers after code", () => {
    expect(projectFinalRequestMention("```text\ncode\n```\n`code` (@_user_1)")).toEqual({
      markdown: "```text\ncode\n```\n`code` ()",
      requested: true
    });
  });

  it("keeps markers inside blockquoted fences and invalid closing-fence prefixes", () => {
    const markdown = [
      "> ```text",
      "> @_user_1",
      "> ```not-a-close",
      "> @_user_1",
      "> ```",
      "outside @_user_1"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({
      markdown: [
        "> ```text",
        "> @_user_1",
        "> ```not-a-close",
        "> @_user_1",
        "> ```",
        "outside"
      ].join("\n"),
      requested: true
    });
  });

  it("keeps markers inside list-nested fenced code", () => {
    const markdown = [
      "- ```text",
      "  @_user_1",
      "  ```",
      "outside @_user_1"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({
      markdown: ["- ```text", "  @_user_1", "  ```", "outside"].join("\n"),
      requested: true
    });
  });

  it("keeps markers inside a fenced continuation of a list item", () => {
    const markdown = [
      "- item",
      "",
      "    ```text",
      "    @_user_1",
      "    ```",
      "outside @_user_1"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({
      markdown: ["- item", "", "    ```text", "    @_user_1", "    ```", "outside"].join("\n"),
      requested: true
    });
  });

  it("does not mistake sibling list or blockquote fence openers for closers", () => {
    const markdown = [
      "- ```",
      "  first",
      "- ```",
      "  @_user_1",
      "  ```",
      "> ```",
      "> first",
      ">> ```",
      ">> @_user_1",
      ">> ```"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({ markdown, requested: false });
  });

  it("treats list-like fences inside a fenced container as code content", () => {
    const markdown = [
      "- ```",
      "  - ```",
      "       ```",
      "  @_user_1",
      "  ```"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({ markdown, requested: false });
  });

  it("tracks list and blockquote containers in their Markdown order", () => {
    const markdown = [
      "- > ```",
      "  > @_user_1",
      "  > ```",
      "> - ```",
      ">   @_user_1",
      ">   ```",
      "outside @_user_1"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({
      markdown: ["- > ```", "  > @_user_1", "  > ```", "> - ```", ">   @_user_1", ">   ```", "outside"].join("\n"),
      requested: true
    });
  });

  it("uses Markdown tab stops for list-contained fences", () => {
    const markdown = [
      "-\t```",
      "\t@_user_1",
      "\t```",
      "> -\t```",
      "> \t@_user_1",
      "> \t```",
      "outside @_user_1"
    ].join("\n");
    expect(projectFinalRequestMention(markdown)).toEqual({
      markdown: ["-\t```", "\t@_user_1", "\t```", "> -\t```", "> \t@_user_1", "> \t```", "outside"].join("\n"),
      requested: true
    });
  });
});
