import { bindRequest } from "@/lib/actor.js";
// Server-Sent Events stream. Each connected client gets a long-lived
// `text/event-stream` connection; whenever the event bus emits, the data is
// pushed to every active stream immediately.
//
// Clients (Board, anywhere else that wants live updates) connect with:
//   const es = new EventSource("/api/events");
//   es.addEventListener("checkin", (e) => { ... });
//
// We send a `retry: 5000` so EventSource auto-reconnects in 5s if the link
// drops, and a periodic comment keepalive every 25s so proxies don't time
// the connection out.
import { subscribe } from "@/lib/event-bus.js";

export const dynamic = "force-dynamic";
// Streaming responses need the Node runtime — Edge can't keep this kind of
// long-lived connection open against better-sqlite3 anyway.
export const runtime = "nodejs";

export async function GET() {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (chunk) => {
        try { controller.enqueue(enc.encode(chunk)); } catch {}
      };

      // Initial hello — sets the retry hint and confirms the link is up so
      // the client can flip its UI state out of "connecting" immediately.
      send("retry: 5000\n");
      send(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

      // Forward every emit to this client. Named event makes addEventListener
      // routing easy on the client side.
      const off = subscribe((e) => {
        send(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
      });

      // Keepalive comment every 25s so reverse proxies don't kill idle SSE.
      const ka = setInterval(() => send(":\n\n"), 25_000);

      // Cancel handler — fires when the client disconnects.
      // The ReadableStream's cancel callback is called by Next when the
      // request is aborted (browser tab closed, navigated away, etc.).
      (controller).__cleanup = () => { off(); clearInterval(ka); };
    },
    cancel() {
      try { this.__cleanup?.(); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Disable Next.js / proxy buffering for streaming responses.
      "X-Accel-Buffering": "no",
    },
  });
}
