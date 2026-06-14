// LLM transport — Claude primary with aggressive cost optimization.
//
// Priority (auto):  Claude -> Groq -> Ollama -> Gemini
// Set LLM_PRIMARY env to "claude" / "groq" / "ollama" / "auto" to override.
//
// Cost-saving tricks baked in:
//   1) Prompt caching on system prompt + tool definitions (90% discount on hits)
//   2) Smart model router: simple tasks -> Haiku, hard tasks -> Sonnet
//   3) Aggressive history truncation (last N messages only)
//   4) Per-message char cap to prevent runaway payloads
//   5) Smaller max_tokens for "fast" mode (dispatch after a plan is set)
//   6) Token usage logged to ai_usage_log for /api/costs dashboard

import ollama from "ollama";
import { logUsage } from "./usage.js";

// ── Models ────────────────────────────────────────────────────────────
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_FAST = process.env.GROQ_FAST_MODEL || "llama-3.1-8b-instant";

// Claude — Haiku default to keep costs near $15/mo; bump to Sonnet for hard tasks
const CLAUDE_HAIKU = process.env.CLAUDE_MODEL || "claude-haiku-4-5";
const CLAUDE_SONNET = process.env.CLAUDE_REASON_MODEL || "claude-sonnet-4-6";
// Allow user to force one specific Claude model regardless of routing
const CLAUDE_FORCE = process.env.CLAUDE_FORCE_MODEL || "";

const LLM_PRIMARY = (process.env.LLM_PRIMARY || "auto").toLowerCase();
const MAX_MESSAGES = Number(process.env.LLM_MAX_MESSAGES || 20);
const MAX_CHARS_PER_MSG = Number(process.env.LLM_MAX_CHARS_PER_MSG || 6000);
const MAX_TOKENS_REASON = Number(process.env.LLM_MAX_TOKENS || 2048);
const MAX_TOKENS_FAST = Number(process.env.LLM_MAX_TOKENS_FAST || 1024);
const CACHE_ENABLED = (process.env.LLM_CACHE_ENABLED ?? "true") !== "false";

const state = {
  groqDownUntil: 0,
  ollamaDownUntil: 0,
  claudeDownUntil: 0,
  lastProvider: null,
  lastModel: null,
  lastError: null,
  lastUsage: null,
  providerErrors: {}, // { claude: "...", groq: "...", ollama: "..." } — last error per provider, for debugging
};

// ── SDK getters (lazy + optional) ─────────────────────────────────────
let _groq = null;
async function getGroq() {
  if (_groq) return _groq;
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const { default: Groq } = await import("groq-sdk");
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    return _groq;
  } catch { return null; }
}

let _claude = null;
async function getClaude() {
  if (_claude) return _claude;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
  } catch (e) {
    console.warn("[llm] @anthropic-ai/sdk not installed:", e.message);
    return null;
  }
}

let _gemini = null;
async function getGemini() {
  if (_gemini) return _gemini;
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return _gemini;
  } catch { return null; }
}

// ── Message trimming (cost control) ───────────────────────────────────
function trimMessages(messages) {
  if (!messages?.length) return messages;
  const sys = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = sys.length ? messages.slice(1) : messages;
  const tail = rest.slice(-MAX_MESSAGES);
  return [...sys, ...tail].map((m) => {
    if (typeof m.content === "string" && m.content.length > MAX_CHARS_PER_MSG) {
      return { ...m, content: m.content.slice(0, MAX_CHARS_PER_MSG) + " …(truncated)" };
    }
    return m;
  });
}

// ── Routing ───────────────────────────────────────────────────────────
function whichOrder() {
  const now = Date.now();
  const claudeOk = now > state.claudeDownUntil && !!process.env.ANTHROPIC_API_KEY;
  const groqOk = now > state.groqDownUntil && !!process.env.GROQ_API_KEY;
  const ollamaOk = now > state.ollamaDownUntil;

  if (LLM_PRIMARY === "claude") return ["claude", "groq", "ollama"];
  if (LLM_PRIMARY === "ollama") return ollamaOk ? ["ollama", "claude", "groq"] : ["claude", "groq", "ollama"];
  if (LLM_PRIMARY === "groq")   return groqOk   ? ["groq", "claude", "ollama"] : ["claude", "ollama", "groq"];
  // auto — Claude wins if available, then Groq, then local Ollama
  if (claudeOk) return ["claude", "groq", "ollama"];
  if (groqOk)   return ["groq", "ollama"];
  return ["ollama", "groq"];
}

// Decide which Claude model to use based on what the request looks like.
//   - "fast" mode (post-plan dispatch) -> Haiku always
//   - Forced model -> use it
//   - Anything with "code_propose_edit" or "schema_*" in recent tool intent -> Sonnet
//   - Otherwise -> Haiku (the cheap default)
function pickClaudeModel(opts) {
  if (CLAUDE_FORCE) return CLAUDE_FORCE;
  if (opts.mode === "fast") return CLAUDE_HAIKU;
  if (opts.needsReasoning) return CLAUDE_SONNET;
  // Look for hard-task markers in the most recent user message
  const lastUser = [...(opts.messages || [])].reverse().find((m) => m.role === "user");
  const text = (lastUser?.content || "").toLowerCase();
  const hardMarkers = ["refactor", "redesign", "complicated", "architect", "rewrite", "explain why", "debug", "audit", "code"];
  if (hardMarkers.some((m) => text.includes(m))) return CLAUDE_SONNET;
  return CLAUDE_HAIKU;
}

// ── Main entry ────────────────────────────────────────────────────────
export async function chat(opts) {
  const messages = trimMessages(opts.messages);
  const order = whichOrder();
  let lastErr = null;

  for (const provider of order) {
    try {
      if (provider === "claude") {
        const c = await getClaude();
        if (!c) continue;
        return await callClaude(c, { ...opts, messages });
      }
      if (provider === "groq") {
        const g = await getGroq();
        if (!g) continue;
        const model = opts.mode === "fast" ? GROQ_FAST : GROQ_MODEL;
        const r = await g.chat.completions.create({
          model, messages, tools: opts.tools,
          tool_choice: opts.tools ? "auto" : undefined,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.mode === "fast" ? MAX_TOKENS_FAST : MAX_TOKENS_REASON,
        });
        const usage = {
          provider: "groq", model,
          input_tokens: r.usage?.prompt_tokens || 0,
          output_tokens: r.usage?.completion_tokens || 0,
          cache_read_tokens: 0, cache_write_tokens: 0,
          cost_usd: 0,  // Groq is free
        };
        logUsage(usage);
        state.lastProvider = "groq"; state.lastModel = model;
        state.lastUsage = usage; state.lastError = null;
        return { message: r.choices[0].message, provider: "groq", model, usage };
      }
      if (provider === "ollama") {
        // Ollama's local Go-SDK chokes on Anthropic/OpenAI-style tool schemas
        // (it expects required:[]string but receives required:true on properties
        // from some shapes, and can't round-trip nested objects). When it's a
        // fallback we drop the tools so the user at least gets a plain reply
        // describing what they asked for, rather than a parse-error from Go.
        const r = await ollama.chat({
          model: OLLAMA_MODEL, messages, // tools intentionally omitted
          options: { temperature: opts.temperature ?? 0.2 },
        });
        const usage = {
          provider: "ollama", model: OLLAMA_MODEL,
          input_tokens: r.prompt_eval_count || 0,
          output_tokens: r.eval_count || 0,
          cache_read_tokens: 0, cache_write_tokens: 0,
          cost_usd: 0,
        };
        logUsage(usage);
        state.lastProvider = "ollama"; state.lastModel = OLLAMA_MODEL;
        state.lastUsage = usage; state.lastError = null;
        return { message: r.message || {}, provider: "ollama", model: OLLAMA_MODEL, usage };
      }
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      state.lastError = msg;
      state.providerErrors[provider] = msg.slice(0, 500);
      // Rate-limit aware backoff. Anthropic returns 429 with a retry-after-ms
      // header (and the message body includes the limit details). When that
      // happens we honor it instead of marking Claude down for a flat 60s — a
      // ~12-second TPM reset shouldn't keep Claude offline for a full minute.
      let backoffMs = 60_000;
      const status = e?.status || e?.response?.status;
      if (status === 429) {
        const headers = e?.headers || e?.response?.headers || {};
        const retryMs = Number(headers["retry-after-ms"] || headers["x-ratelimit-reset-input-tokens"] || 0);
        const retrySec = Number(headers["retry-after"] || 0);
        backoffMs = retryMs || (retrySec * 1000) || 15_000;
      }
      if (provider === "claude") state.claudeDownUntil = Date.now() + backoffMs;
      if (provider === "groq")   state.groqDownUntil   = Date.now() + backoffMs;
      if (provider === "ollama") state.ollamaDownUntil = Date.now() + backoffMs;
      console.warn(`[llm] ${provider} failed:`, msg, status ? `(status ${status})` : "", `backing off ${Math.round(backoffMs/1000)}s`);
    }
  }

  const gem = await getGemini();
  if (gem) {
    try {
      const r = await callGemini(gem, { messages, tools: opts.tools, temperature: opts.temperature });
      state.lastProvider = "gemini";
      return r;
    } catch (e) { lastErr = e; }
  }

  // Surface per-provider errors so the chat UI can tell the user which provider
  // failed and why — much easier to diagnose than a single "last error" line.
  const summary = Object.entries(state.providerErrors)
    .filter(([, msg]) => msg)
    .map(([prov, msg]) => `${prov}: ${msg}`)
    .join(" | ");
  throw new Error(`No LLM available. ${summary || `Last error: ${lastErr?.message || lastErr || "unknown"}`}.`);
}

// ── Claude call with prompt caching ───────────────────────────────────
// Key savings:
//   - System prompt + tool definitions get cache_control breakpoints.
//     First call writes the cache (1.25x cost). Every call within 5 minutes
//     reads it at 0.1x cost (90% discount).
//   - 99% of repeat calls during a conversation are cache hits.

const CLAUDE_PRICING = {
  // Per million tokens — see https://docs.claude.com/en/docs/about-claude/pricing
  "claude-haiku-4-5":  { in: 1,  cacheWrite: 1.25, cacheRead: 0.10, out: 5 },
  "claude-sonnet-4-6": { in: 3,  cacheWrite: 3.75, cacheRead: 0.30, out: 15 },
  "claude-opus-4-8":   { in: 5,  cacheWrite: 6.25, cacheRead: 0.50, out: 25 },
};

async function callClaude(client, opts) {
  const model = pickClaudeModel(opts);

  // Convert OpenAI-style messages -> Claude format.
  // System role becomes the `system` parameter (separate from messages).
  // tool calls / tool results need to be normalized.
  const sysMsg = opts.messages.find((m) => m.role === "system");
  const restMsgs = opts.messages.filter((m) => m.role !== "system");
  const messages = convertToClaudeMessages(restMsgs);

  const system = sysMsg
    ? (CACHE_ENABLED
        ? [{ type: "text", text: String(sysMsg.content), cache_control: { type: "ephemeral" } }]
        : String(sysMsg.content))
    : undefined;

  // Convert tools and add cache breakpoint on the LAST tool definition
  // (caches the entire tool block in one breakpoint).
  let tools;
  if (opts.tools?.length) {
    tools = opts.tools.map((t) => {
      const f = t.function || t;
      return {
        name: f.name,
        description: f.description,
        input_schema: f.parameters || { type: "object", properties: {} },
      };
    });
    if (CACHE_ENABLED && tools.length) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
    }
  }

  const r = await client.messages.create({
    model,
    max_tokens: opts.mode === "fast" ? MAX_TOKENS_FAST : MAX_TOKENS_REASON,
    temperature: opts.temperature ?? 0.2,
    system,
    tools,
    messages,
  });

  // Normalize Claude response back to OpenAI-ish shape so the agent loop is unchanged.
  const out = normalizeClaudeResponse(r);
  const u = r.usage || {};
  const price = CLAUDE_PRICING[model] || CLAUDE_PRICING["claude-haiku-4-5"];
  const cost =
    (u.input_tokens || 0)             * price.in         / 1_000_000 +
    (u.cache_creation_input_tokens || 0) * price.cacheWrite / 1_000_000 +
    (u.cache_read_input_tokens || 0)  * price.cacheRead   / 1_000_000 +
    (u.output_tokens || 0)            * price.out        / 1_000_000;
  const usage = {
    provider: "claude", model,
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_write_tokens: u.cache_creation_input_tokens || 0,
    cost_usd: cost,
  };
  logUsage(usage);
  state.lastProvider = "claude"; state.lastModel = model;
  state.lastUsage = usage; state.lastError = null;
  return { message: out, provider: "claude", model, usage };
}

function convertToClaudeMessages(msgs) {
  const out = [];
  // Track tool_use ids that the assistant has just emitted; only matching
  // tool_results survive (Claude rejects orphans with 400).
  let pendingToolUseIds = new Set();
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: String(m.content || "") });
      pendingToolUseIds = new Set();
    } else if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        const parts = [];
        if (m.content) parts.push({ type: "text", text: String(m.content) });
        const ids = new Set();
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch {}
          const id = tc.id || `c_${Math.random().toString(36).slice(2,9)}`;
          ids.add(id);
          parts.push({ type: "tool_use", id, name: tc.function.name, input });
        }
        out.push({ role: "assistant", content: parts });
        pendingToolUseIds = ids;
      } else {
        out.push({ role: "assistant", content: String(m.content || "") });
        pendingToolUseIds = new Set();
      }
    } else if (m.role === "tool") {
      const id = m.tool_call_id;
      if (!id || !pendingToolUseIds.has(id)) {
        // Skip orphan tool_result — Claude will 400 on these
        continue;
      }
      // Group consecutive tool_results into a single user message (Claude prefers this)
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push({ type: "tool_result", tool_use_id: id, content: String(m.content || "") });
      } else {
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: String(m.content || "") }],
        });
      }
      pendingToolUseIds.delete(id);
    }
  }
  return out;
}

function normalizeClaudeResponse(r) {
  const textParts = [];
  const tool_calls = [];
  for (const block of r.content || []) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use") {
      tool_calls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }
  return {
    role: "assistant",
    content: textParts.join("\n").trim(),
    tool_calls: tool_calls.length ? tool_calls : undefined,
  };
}

// ── Gemini fallback (unchanged) ───────────────────────────────────────
async function callGemini(gem, opts) {
  const model = gem.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    tools: opts.tools?.length
      ? [{ functionDeclarations: opts.tools.map((t) => {
          const f = t.function || t;
          return { name: f.name, description: f.description, parameters: f.parameters };
        }) }]
      : undefined,
    generationConfig: { temperature: opts.temperature ?? 0.2 },
  });
  const history = opts.messages.slice(0, -1).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content ?? "" }],
  }));
  const chatSess = model.startChat({ history });
  const last = opts.messages[opts.messages.length - 1];
  const r = await chatSess.sendMessage(last.content ?? "");
  const resp = r.response;
  const calls = resp.functionCalls?.() ?? [];
  return {
    provider: "gemini",
    model: "gemini-2.0-flash-exp",
    message: {
      role: "assistant",
      content: resp.text?.() ?? "",
      tool_calls: calls.map((c, i) => ({
        id: `gem_${i}`,
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
    },
  };
}

// ── Status + manual override ──────────────────────────────────────────
export function llmStatus() {
  const now = Date.now();
  return {
    primary: LLM_PRIMARY,
    has_claude: !!process.env.ANTHROPIC_API_KEY,
    has_groq: !!process.env.GROQ_API_KEY,
    has_gemini: !!process.env.GEMINI_API_KEY,
    cache_enabled: CACHE_ENABLED,
    claude_down_until: state.claudeDownUntil > now ? new Date(state.claudeDownUntil).toISOString() : null,
    groq_down_until:   state.groqDownUntil   > now ? new Date(state.groqDownUntil).toISOString()   : null,
    ollama_down_until: state.ollamaDownUntil > now ? new Date(state.ollamaDownUntil).toISOString() : null,
    last_provider: state.lastProvider,
    last_model: state.lastModel,
    last_usage: state.lastUsage,
    last_error: state.lastError,
    models: { ollama: OLLAMA_MODEL, groq: GROQ_MODEL, groq_fast: GROQ_FAST,
              claude_default: CLAUDE_HAIKU, claude_reason: CLAUDE_SONNET, claude_forced: CLAUDE_FORCE || null },
    next_order: whichOrder(),
    provider_errors: state.providerErrors,
    limits: { max_messages: MAX_MESSAGES, max_chars_per_msg: MAX_CHARS_PER_MSG,
              max_tokens_reason: MAX_TOKENS_REASON, max_tokens_fast: MAX_TOKENS_FAST },
  };
}

export function setPrimaryOverride(provider) {
  state.claudeDownUntil = 0; state.groqDownUntil = 0; state.ollamaDownUntil = 0;
  if (provider === "claude") { state.groqDownUntil = Date.now() + 5*60_000; state.ollamaDownUntil = Date.now() + 5*60_000; }
  else if (provider === "groq") { state.claudeDownUntil = Date.now() + 5*60_000; state.ollamaDownUntil = Date.now() + 5*60_000; }
  else if (provider === "ollama") { state.claudeDownUntil = Date.now() + 5*60_000; state.groqDownUntil = Date.now() + 5*60_000; }
  return llmStatus();
}
