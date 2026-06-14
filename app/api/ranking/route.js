import { ensureRankingFields, rankingStatus, setBalanceByRank, finalizeSeason } from "@/lib/tools.js";
import { setActorFromReq } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  setActorFromReq(req);
  const b = await req.json();
  if (b.action === "ensure") return Response.json(ensureRankingFields());
  if (b.action === "status") return Response.json(rankingStatus());
  if (b.action === "balance") return Response.json(setBalanceByRank(!!b.on));
  if (b.action === "finalize") return Response.json(finalizeSeason(b.label || ""));
  return Response.json({ error: "unknown action" });
}
