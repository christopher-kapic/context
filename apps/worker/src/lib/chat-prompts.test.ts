import { type AgentTool, defineTool, UNTRUSTED_CONTENT_SYSTEM_RULES } from "@starter/agent-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildChatSystemPrompt, CHAT_SYSTEM_PROMPT } from "./chat-prompts.js";

const tool = (untrusted?: boolean): AgentTool =>
  defineTool({
    name: untrusted ? "fetch_page" : "current_time",
    description: "test",
    inputSchema: z.object({}),
    untrusted,
    execute: () => "ok",
  });

describe("CHAT_SYSTEM_PROMPT", () => {
  it("forbids claiming a tool call that never happened", () => {
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain(
      "never state or imply that you called a tool you did not call",
    );
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain("say what you do not know");
  });
});

describe("buildChatSystemPrompt", () => {
  it("omits the untrusted-content rules when no tool returns untrusted data", () => {
    const prompt = buildChatSystemPrompt([tool()]);
    expect(prompt).toBe(CHAT_SYSTEM_PROMPT);
    expect(prompt).not.toContain(UNTRUSTED_CONTENT_SYSTEM_RULES);
  });

  it("omits them for an empty tool list", () => {
    expect(buildChatSystemPrompt([])).toBe(CHAT_SYSTEM_PROMPT);
  });

  // The security property: registering an untrusted tool must turn the defense
  // on by itself. If this ever needs a second manual flag, fetched content and
  // instructions become indistinguishable to the model.
  it("appends the untrusted-content rules as soon as one tool is untrusted", () => {
    const prompt = buildChatSystemPrompt([tool(), tool(true)]);
    expect(prompt).toContain(CHAT_SYSTEM_PROMPT);
    expect(prompt).toContain(UNTRUSTED_CONTENT_SYSTEM_RULES);
  });
});
