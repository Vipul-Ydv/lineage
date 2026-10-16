// CLI: npm run ask -- "Who should I ask about the execution plan?"
import { graphFor, closeDb } from "./graph/db.ts";
import { ask } from "./agent/agent.ts";

const repo = process.env.REPO ?? "FalkorDB/FalkorDB";
const g = await graphFor(repo);
let last = Date.now();
await ask(g, repo, process.argv.slice(2).join(" "), (e) => {
  const dt = `${((Date.now() - last) / 1000).toFixed(1)}s`; last = Date.now();
  if (e.type === "tool") console.log(`[${dt}] ${e.name}(${JSON.stringify(e.args)}) -> ${e.nodes.length} nodes\n    ${e.text.split("\n").slice(0, 3).join("\n    ")}`);
  else if (e.type === "answer") console.log(`[${dt}] ANSWER (checked=${e.checked}, ${(e.ms / 1000).toFixed(1)}s total):\n${e.text}`);
  else if (e.type === "rejected") console.log(`[${dt}] REJECTED: ${e.reasons.join("; ")}`);
  else if (e.type === "error") console.log(`[${dt}] ERROR ${e.message}`);
});
await closeDb();
