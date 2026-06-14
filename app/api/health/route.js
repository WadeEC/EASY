// Health + provider control endpoint.
//   GET  /api/health                      -> status of LLM providers, rate limits
//   POST /api/health { force: "groq"|"ollama"|"auto" } -> manually pick which to use
//   POST /api/health { probe: true }      -> live ping each provider (~2s)
import { llmStatus, setPrimaryOverride, chat } from "@/lib/llm.js";
import { guardStatus } from "@/lib/guard.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: true,
    llm: llmStatus(),
    guard: guardStatus(),
    node: process.version,
    uptime_sec: Math.round(process.uptime()),
  });
}

export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  if (b.force) return Response.json(setPrimaryOverride(b.force));
  if (b.probe) {
    const results = {};
    for (const provider of ["groq", "ollama"]) {
      setPrimaryOverride(provider);
      try {
        const t0 = Date.now();
        const r = await chat({ messages: [{ role: "user", content: "Reply with the single word: ok" }], temperature: 0 });
        results[provider] = { ok: true, ms: Date.now() - t0, model: r.model, reply: r.message.content?.slice(0, 40) };
      } catch (e) {
        results[provider] = { ok: false, error: e.message };
      }
    }
    setPrimaryOverride("auto");
    return Response.json({ probe: results });
  }
  return Response.json({ error: "Pass { force: 'groq'|'ollama'|'auto' } or { probe: true }" }, { status: 400 });
}
