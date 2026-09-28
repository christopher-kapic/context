import { type AgentTool, defineTool, wrapUntrustedContent } from "@starter/agent-runtime";
import { z } from "zod";

/**
 * THE TOOL SEAM for durable chat.
 *
 * `buildChatTools()` is the single place a consuming project registers the tools
 * its chat agent can call. The template ships one deliberately boring default
 * (`current_time`) so the seam is exercised end to end — a real tool call, a
 * real tool result, rendered by the UI — without pretending to know what your
 * product's agent should be able to do.
 *
 * ── Adding your own tool ───────────────────────────────────────────────────
 *
 * ```ts
 * import prisma from "@starter/db";
 *
 * const findOrderTool = defineTool({
 *   name: "find_order",
 *   description: "Look up one order by its public order number",
 *   inputSchema: z.object({ orderNumber: z.string().min(1) }),
 *   execute: async ({ orderNumber }) =>
 *     prisma.order.findUnique({ where: { orderNumber } }),
 * });
 * ```
 *
 * Then add it to the array `buildChatTools()` returns. Notes that matter:
 *
 *   * `inputSchema` is a Zod schema and IS the validation boundary — the model
 *     supplies these arguments, so treat them exactly as you would a request
 *     body. Never interpolate one into raw SQL or a shell command.
 *   * The runtime bounds a result at `maxResultChars` (32k by default). Anything
 *     larger is offloaded to the Redis result store (`result-store.ts`) and the
 *     model pages the tail back; it is not silently truncated.
 *   * `execute` receives the run's `AbortSignal` as a second argument. Forward
 *     it to anything cancellable (`fetch(url, { signal })`, a driver, a child
 *     process): the runtime abandons a tool call the moment
 *     `CHAT_RUN_TIMEOUT_MS` elapses whether or not the tool cooperates, so a
 *     tool that ignores it keeps burning the worker after the run has ended.
 *     A one-argument `execute` — like `current_time` below — stays valid.
 *   * `buildChatTools` takes the session so tools can be scoped to the signed-in
 *     user. A tool that reads user data MUST filter by `session.ownerId` — the
 *     model decides the arguments, so a tool that trusts them to be safe hands
 *     every user's rows to whoever asks nicely.
 *   * Any tool whose result contains text from outside your system (a fetched
 *     page, a scraped document, a user-submitted file) must be defined with
 *     {@link defineUntrustedTool}, not `defineTool`.
 */

/** The shape `buildChatTools` needs from a ChatSession row. */
export type ChatToolSession = {
  id: string;
  ownerId: string;
};

/**
 * Define a tool whose result is untrusted source material — anything authored
 * outside your system that a prompt-injection payload could be hiding in.
 *
 * This does BOTH halves of the defense together, because doing one without the
 * other is the actual failure mode:
 *
 *   1. Wraps the body in the runtime's untrusted-content markers, so the model
 *      can see where attacker-controlled text starts and stops. Paired with the
 *      rules `buildChatSystemPrompt` injects (see chat-prompts.ts), that is what
 *      tells the model to treat the span as data, never instructions.
 *   2. Sets `untrusted: true`, which makes the runtime re-wrap every slice
 *      returned by `retrieve_tool_result` when the body overflows into the
 *      result store — otherwise a large page's tail would come back unmarked
 *      and the defense would silently end at the truncation point.
 *
 * `execute` returns the raw text; the wrapping is applied here so a tool author
 * cannot forget it.
 */
export function defineUntrustedTool<TSchema extends z.ZodType>(options: {
  name: string;
  description: string;
  inputSchema: TSchema;
  /**
   * Resolve the untrusted text plus a provenance label shown to the model.
   * The run's `AbortSignal` is forwarded as a second argument — an untrusted
   * tool is almost always a network fetch, which is exactly the case worth
   * cancelling when the run's deadline elapses.
   */
  execute: (
    input: z.output<TSchema>,
    signal: AbortSignal,
  ) => Promise<{ content: string; sourceUrl: string }>;
  maxResultChars?: number;
}): AgentTool<TSchema> {
  return defineTool({
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    maxResultChars: options.maxResultChars,
    untrusted: true,
    execute: async (input, signal) => {
      const { content, sourceUrl } = await options.execute(input, signal);
      return wrapUntrustedContent(content, { sourceUrl });
    },
  });
}

/**
 * Models have no clock — left to itself an agent will answer "today" with its
 * training cutoff. Cheap, side-effect-free, and useful in almost any product,
 * which is what makes it a reasonable default rather than a placeholder.
 */
const currentTimeTool = defineTool({
  name: "current_time",
  description:
    "Get the current date and time in UTC as an ISO-8601 timestamp. Use this whenever the answer depends on what 'now' is.",
  inputSchema: z.object({}),
  execute: () => ({ iso: new Date().toISOString(), timeZone: "UTC" }),
});

/**
 * Tools available to one chat session.
 *
 * Async because a real registration usually needs a query (which integrations
 * this owner has connected, which feature flags are on) before it knows what to
 * offer. Returning `[]` is valid — the chat still works, it just can't act.
 */
export function buildChatTools(_session: ChatToolSession): Promise<AgentTool[]> {
  return Promise.resolve([currentTimeTool]);
}
