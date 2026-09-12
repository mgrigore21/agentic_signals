import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const corpusPlots = path.resolve(process.cwd(), "../..", "corpus", "plots", "runs");

export async function GET(_: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^run_\d{3}$/.test(runId)) return new NextResponse("Not found", { status: 404 });
  try {
    const image = await readFile(path.join(corpusPlots, `${runId}.png`));
    return new NextResponse(image, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return new NextResponse("Plot unavailable", { status: 404 });
  }
}
