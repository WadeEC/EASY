import { addFieldOption } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const b = await req.json();
  return Response.json(addFieldOption(b.record_type, b.field, b.option));
}
