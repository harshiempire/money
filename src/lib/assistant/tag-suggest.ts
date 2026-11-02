/**
 * One model call that suggests categories for rows history could not place.
 * It returns names only. The caller turns them into a draft and never writes.
 */
import { callAgentStep, type FunctionTool } from "@/lib/ai/chatgpt/responses";
import type { AiFailure } from "@/lib/ai/failure";
import { parseModelGuesses, type ModelGuess, type ModelTagRow } from "./tag-batch";

const SUBMIT_TOOL: FunctionTool = {
  type: "function",
  name: "submit_tag_suggestions",
  description: "Return one category suggestion per transaction ref. Use a category from the list, or null when you would not tag it.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "category_name", "confidence", "reason"],
          properties: {
            ref: { type: "string", description: "The ref from the input, unchanged." },
            category_name: { type: ["string", "null"], description: "A category name from the list, or null." },
            confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
            reason: { type: "string", description: "Under 80 characters. No account numbers or handles." },
          },
        },
      },
    },
  },
};

export async function suggestTagNames(input: {
  accessToken: string;
  accountId: string;
  model: string;
  categories: string[];
  standingNotes: string[];
  rows: ModelTagRow[];
}): Promise<{ guesses: ModelGuess[]; failure: AiFailure | null }> {
  if (input.rows.length === 0) return { guesses: [], failure: null };
  const result = await callAgentStep({
    accessToken: input.accessToken,
    accountId: input.accountId,
    model: input.model,
    instructions: `You suggest a category for each untagged payment. Reply only by calling submit_tag_suggestions.
Categories you may use: ${input.categories.join(", ") || "none"}.
Standing notes, already checked: ${input.standingNotes.join(" | ") || "none"}.
Use the amount, direction, channel and payee. A transfer flag means the payment was detected as moving between the user's own accounts. Prefer none over a wild guess. confidence high only when the payee kind is obvious (a known merchant type). Never invent a payee, an amount, or a category that is not in the list. Do not include handles or long numbers in the reason.`,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify({ rows: input.rows }) }],
      },
    ],
    tools: [SUBMIT_TOOL],
    toolChoice: { type: "function", name: "submit_tag_suggestions" },
    sessionId: crypto.randomUUID(),
    timeoutMs: 30_000,
  });
  if (!result.ok) return { guesses: [], failure: result.failure };
  const call = result.calls.find((c) => c.name === "submit_tag_suggestions");
  return { guesses: call ? parseModelGuesses(call.arguments) : [], failure: null };
}
