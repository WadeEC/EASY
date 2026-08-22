import {
  listLinks, createLink, addLinkMember, removeLinkMember, deleteLink, setLinkReason,
} from "@/lib/tools.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  if (b.action === "list") return Response.json({ links: listLinks() });
  if (b.action === "create") return Response.json(createLink({ kind: b.kind, playerIds: b.playerIds || [], coachIds: b.coachIds || [], reason: b.reason || "" }));
  if (b.action === "add_member") return Response.json(addLinkMember(b.link_id, { playerId: b.playerId || null, coachId: b.coachId || null }));
  if (b.action === "remove_member") return Response.json(removeLinkMember(b.link_id, { playerId: b.playerId || null, coachId: b.coachId || null }));
  if (b.action === "delete") return Response.json(deleteLink(b.link_id));
  if (b.action === "set_reason") return Response.json(setLinkReason(b.link_id, b.reason || ""));
  return Response.json({ error: "unknown action" });
}
