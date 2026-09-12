import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dismissal } from "../batch-types";

const dataDirectory = path.resolve(process.cwd(), "../..", "data");
const dismissalsPath = path.join(dataDirectory, "dismissals.json");

export async function readDismissals(): Promise<Dismissal[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(dismissalsPath, "utf8"));
    return Array.isArray(parsed) ? parsed as Dismissal[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendDismissal(dismissal: Dismissal): Promise<Dismissal[]> {
  const next = [...await readDismissals(), dismissal];
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = path.join(dataDirectory, `dismissals.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporaryPath, dismissalsPath);
  return next;
}
