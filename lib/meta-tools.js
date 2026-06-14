// Meta tools — primitives so the AI can THINK and COMMUNICATE, not just mutate.
// Each returns a tagged object the agent loop routes into the response shape.
//
// kind:
//   "plan"        -> output.plan = steps[]
//   "warning"     -> output.warnings.push({...})
//   "suggestion"  -> output.suggestions.push(...items)
//   "clarify"     -> output.clarify = {question, options}
//   "memory"      -> internal-only (already persisted by tool)
//   "done"        -> short-circuits the loop

import { remember as memRemember, recall as memRecall, listFacts } from "./memory.js";

const fn = (name, description, properties, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const META_TOOL_SCHEMAS = [
  fn("plan",
    "Output a brief multi-step plan BEFORE running any mutating tools. Use this for any task with 2+ steps so the user sees your thinking.",
    {
      steps: { type: "array", items: { type: "string" } },
      reasoning: { type: "string", description: "One-line why-this-plan rationale" },
    }, ["steps"]),

  fn("warn_user",
    "Warn the user about a side-effect, risk, or unintended consequence BEFORE running it. Use proactively for destructive or wide-impact actions (delete_record_type, delete many records, drop column, etc.). After warning, STOP and wait for the user to confirm in their next message.",
    {
      message: { type: "string" },
      severity: { type: "string", enum: ["info", "warn", "danger"] },
      affected_count: { type: "integer", description: "Rough number of records/things affected, if known" },
    }, ["message"]),

  fn("suggest",
    "Propose follow-up actions the user might want next. Use after finishing something so they know what's possible.",
    { items: { type: "array", items: { type: "string" } } }, ["items"]),

  fn("ask_clarification",
    "Ask the user a question before continuing. Use ONLY when truly ambiguous. Provide 2-4 concrete options.",
    {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    }, ["question"]),

  fn("save_preference",
    "Save a USER PREFERENCE or SETTING to memory (NOT for counting or looking up data). Examples: 'user prefers compact tables', 'season starts Sept 9'. Do NOT use this to answer 'how many' questions — use count_where or breakdown for that.",
    {
      key: { type: "string", description: "Short identifier" },
      value: { type: "string" },
      scope: { type: "string", enum: ["user", "league", "session"] },
    }, ["key", "value"]),

  fn("load_preference",
    "Look up a previously saved PREFERENCE/SETTING (NOT for counting players or data). For 'how many X' questions, use count_where. For grouping like 'players per league', use breakdown.",
    { query: { type: "string" } }, ["query"]),

  fn("finish",
    "Signal that the task is complete. Pass a one-sentence summary of what was done.",
    { summary: { type: "string" } }, ["summary"]),
];

export const META_TOOL_NAMES = META_TOOL_SCHEMAS.map((t) => t.function.name);

export function runMetaTool(name, args) {
  switch (name) {
    case "plan":
      return { kind: "plan", steps: args.steps || [], reasoning: args.reasoning };
    case "warn_user":
      return { kind: "warning", message: args.message, severity: args.severity || "warn", affected_count: args.affected_count };
    case "suggest":
      return { kind: "suggestion", items: args.items || [] };
    case "ask_clarification":
      return { kind: "clarify", question: args.question, options: args.options || [] };
    case "save_preference":
    case "remember": {
      memRemember(args.key, args.value, args.scope || "league");
      return { kind: "memory", op: "save_preference", key: args.key };
    }
    case "load_preference":
    case "recall": {
      const hits = memRecall(args.query, 5);
      return { kind: "memory", op: "load_preference", matches: hits };
    }
    case "finish":
      return { kind: "done", summary: args.summary || "Done." };
    default:
      return null;
  }
}

export function gatherMemoryHints(query) {
  // Used by the agent loop to inject relevant facts into the system prompt.
  const direct = memRecall(query, 3);
  if (direct.length) return direct;
  // Pull a small set of "always" facts so the AI has continuity
  return listFacts(5);
}
