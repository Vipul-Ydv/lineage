// One FalkorDB connection for the process, and one graph per repository.
import { FalkorDB, type Graph } from "falkordb";

let client: FalkorDB | null = null;

export async function graphFor(repo: string): Promise<Graph> {
  if (!client) {
    client = await FalkorDB.connect({
      socket: { host: process.env.FALKORDB_HOST ?? "localhost", port: Number(process.env.FALKORDB_PORT ?? 6379) },
      password: process.env.FALKORDB_PASSWORD || undefined,
    });
  }
  return client.selectGraph(graphName(repo));
}

/** "FalkorDB/FalkorDB" -> "lineage_falkordb_falkordb": each repo gets its own isolated graph. */
export function graphName(repo: string) {
  return "lineage_" + repo.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

export async function closeDb() {
  await client?.close();
  client = null;
}
