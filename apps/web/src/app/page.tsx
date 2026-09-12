import { TriageConsole } from "@/components/triage-console";
import { loadBatch } from "@/lib/batch";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <TriageConsole batch={await loadBatch()} />;
}
