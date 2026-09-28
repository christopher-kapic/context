import { type AgentTool, UNTRUSTED_CONTENT_SYSTEM_RULES } from "@starter/agent-runtime";

/**
 * Base system prompt for a chat session.
 *
 * Deliberately generic — it describes how to behave, not what the product is.
 * Replace or extend it with your domain instructions; the honesty and
 * tool-discipline clauses are the parts worth keeping, because they are what
 * stop the model from inventing a tool result it never received.
 */
export const CHAT_SYSTEM_PROMPT = `You are a helpful assistant embedded in this application.

Answer clearly and concisely. Prefer plain prose over bullet lists unless the user asks for a list. Use Markdown for code, and never for decoration.

When a tool can answer a question, call it instead of guessing — and when no tool can, say what you do not know rather than filling the gap. Never state or imply that you called a tool you did not call, and never present a tool's output as more certain than it is: report what it returned, including when it returned nothing.

If a request is ambiguous enough that a wrong assumption would waste the user's time, ask one clarifying question before acting.`;

/**
 * Compose the system prompt for a run.
 *
 * The untrusted-content rules are appended IF AND ONLY IF at least one
 * registered tool is marked `untrusted`. That coupling is the point: the rules
 * explain markers the model would otherwise never see, so emitting them
 * unconditionally trains it to ignore a section of its own prompt — and
 * omitting them when an untrusted tool IS registered leaves fetched content
 * indistinguishable from instructions. Deriving the decision from the tool list
 * means registering an untrusted tool (see `defineUntrustedTool` in
 * chat-tools.ts) turns the defense on automatically, with nothing to remember.
 */
export function buildChatSystemPrompt(tools: readonly AgentTool[]): string {
  const hasUntrustedTool = tools.some((tool) => tool.untrusted === true);
  return hasUntrustedTool
    ? `${CHAT_SYSTEM_PROMPT}\n\n${UNTRUSTED_CONTENT_SYSTEM_RULES}`
    : CHAT_SYSTEM_PROMPT;
}
