import { seedStandardPlayers } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json(seedStandardPlayers());
}
