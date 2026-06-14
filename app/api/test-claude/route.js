// Diagnostic endpoint — bypasses the agent loop and tool schemas to test
// if the raw Claude API call works.
//   GET /api/test-claude        -> minimal call, no tools
//   GET /api/test-claude?tools=1 -> with our tool schemas, no cache
//   GET /api/test-claude?cache=1 -> with tools AND cache_control
export const dynamic = "force-dynamic";

export async function GET(req) {
  const url = new URL(req.url);
  const withTools = url.searchParams.get("tools") === "1";
  const withCache = url.searchParams.get("cache") === "1";

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ ok: false, error: "ANTHROPIC_API_KEY not set in environment" }, { status: 400 });
  }

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const body = {
      model: process.env.CLAUDE_FORCE_MODEL || "claude-haiku-4-5",
      max_tokens: 50,
      messages: [{ role: "user", content: "Say the word OK and nothing else." }],
    };

    if (withTools) {
      const { llmTools } = await import("@/lib/tools.js").catch(() => ({ llmTools: [] }));
      const allTools = [];
      try {
        const ui = await import("@/lib/ui-tools.js");
        if (ui.UI_TOOL_SCHEMAS) allTools.push(...ui.UI_TOOL_SCHEMAS);
      } catch {}
      try {
        const meta = await import("@/lib/meta-tools.js");
        if (meta.META_TOOL_SCHEMAS) allTools.push(...meta.META_TOOL_SCHEMAS);
      } catch {}
      body.tools = allTools.map((t) => {
        const f = t.function || t;
        return { name: f.name, description: f.description, input_schema: f.parameters || { type: "object", properties: {} } };
      });
      if (withCache && body.tools.length) {
        body.tools[body.tools.length - 1] = { ...body.tools[body.tools.length - 1], cache_control: { type: "ephemeral" } };
      }
    }

    const r = await client.messages.create(body);
    return Response.json({
      ok: true,
      model: r.model,
      content: r.content?.[0]?.text || r.content,
      usage: r.usage,
      tested: { withTools, withCache, tool_count: body.tools?.length || 0 },
    });
  } catch (e) {
    return Response.json({
      ok: false,
      error: e?.message || String(e),
      status: e?.status,
      type: e?.error?.type,
      details: e?.error || null,
      stack: e?.stack?.split("\n").slice(0, 5),
    }, { status: 500 });
  }
}
