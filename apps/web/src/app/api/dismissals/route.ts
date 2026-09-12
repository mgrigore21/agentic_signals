import { NextResponse } from "next/server";
import { z } from "zod";
import { appendDismissal, readDismissals } from "@/lib/server/dismissals";

const dismissalSchema = z.object({
  run_id: z.string().regex(/^run_\d{3}$/),
  reason: z.string().trim().min(1, "A one-line reason is required.").max(500),
});

export async function GET() {
  return NextResponse.json(await readDismissals());
}

export async function POST(request: Request) {
  const parsed = dismissalSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  return NextResponse.json(await appendDismissal({ ...parsed.data, timestamp: new Date().toISOString() }));
}
