import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ReviewDecision } from "../batch-types";

const dataDirectory = path.resolve(process.cwd(), "../..", ".data");
const decisionsPath = path.join(dataDirectory, "review-decisions.json");

export async function readReviewDecisions(): Promise<ReviewDecision[]> {
  try {
    const contents = await readFile(decisionsPath, "utf8");
    const parsed: unknown = JSON.parse(contents);
    return Array.isArray(parsed) ? parsed as ReviewDecision[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveReviewDecision(decision: ReviewDecision): Promise<ReviewDecision[]> {
  const existing = await readReviewDecisions();
  const withoutPrevious = existing.filter((item) => item.runId !== decision.runId);
  const next = [...withoutPrevious, decision];
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = path.join(dataDirectory, `review-decisions.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporaryPath, decisionsPath);
  return next;
}
