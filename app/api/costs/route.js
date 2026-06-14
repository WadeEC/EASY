// Cost dashboard endpoint.
//   GET /api/costs?days=30  -> totals, projection, cache hit rate, breakdown by model
//   GET /api/costs?recent=1 -> last 20 calls with per-call cost
import { getUsage, recentCalls } from "@/lib/usage.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const url = new URL(req.url);
  if (url.searchParams.get("recent")) {
    const limit = Number(url.searchParams.get("recent")) || 20;
    return Response.json({ recent: recentCalls(limit) });
  }
  const days = Number(url.searchParams.get("days")) || 30;
  return Response.json(getUsage({ days }));
}
