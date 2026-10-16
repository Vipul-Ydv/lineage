// Loads data/raw/<repo>.json into FalkorDB. Every write is a MERGE, so loading the
// same data twice changes nothing, and loading a fresh fetch only adds what is new.
//
//   (:Person)-[:AUTHORED|MERGED]->(:PR)        (:Person)-[:REVIEWED {state, at}]->(:PR)
//   (:Person)-[:OPENED|COMMENTED]->(:Issue)    (:PR)-[:FIXES]->(:Issue)
//   (:PR)-[:TOUCHED {added, deleted}]->(:File)-[:IN]->(:Module)-[:IN]->(:Module)...
//   (:PR|Issue)-[:LABELED]->(:Label)
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Graph } from "falkordb";
import { graphFor, closeDb } from "./db.ts";
import { rawPath, type RawRepo } from "../github/fetch.ts";

const BOTS = /\[bot\]$|bot$|^(coderabbitai|copilot-pull-request-reviewer|copilot-swe-agent|dependabot|github-actions|github-code-quality|github-advanced-security|cubic-dev-ai)$/i;
export const isBot = (login: string) => BOTS.test(login);
const MODULE_DEPTH = 4;

/** "src/a/b/c/d.c" -> ["src", "src/a", "src/a/b", "src/a/b/c"] (at most MODULE_DEPTH levels). */
export function modulesOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1).slice(0, MODULE_DEPTH);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

async function batched<T>(g: Graph, query: string, rows: T[], size = 500) {
  for (let i = 0; i < rows.length; i += size) await g.query(query, { params: { rows: rows.slice(i, i + size) as never } });
}

export async function loadRepo(raw: RawRepo) {
  const g = await graphFor(raw.repo);
  for (const q of [
    "CREATE INDEX FOR (p:Person) ON (p.login)",
    "CREATE INDEX FOR (p:PR) ON (p.number)",
    "CREATE INDEX FOR (i:Issue) ON (i.number)",
    "CREATE INDEX FOR (f:File) ON (f.path)",
    "CREATE INDEX FOR (m:Module) ON (m.path)",
    "CREATE INDEX FOR (l:Label) ON (l.name)",
  ]) await g.query(q).catch(() => {}); // already exists

  const people = new Set<string>();
  const addPerson = (l: string | null) => { if (l) people.add(l); };
  for (const p of raw.prs) { addPerson(p.author); addPerson(p.mergedBy); p.reviews.forEach((r) => addPerson(r.author)); }
  for (const i of raw.issues) { addPerson(i.author); i.commenters.forEach(addPerson); }
  await batched(g, "UNWIND $rows AS r MERGE (p:Person {login: r.login}) SET p.bot = r.bot",
    [...people].map((login) => ({ login, bot: isBot(login) })));

  // Modules and the File -> Module -> parent Module chain.
  const files = new Set(raw.prs.flatMap((p) => p.files.map((f) => f.path)));
  const modules = new Set<string>();
  for (const f of files) modulesOf(f).forEach((m) => modules.add(m));
  await batched(g, "UNWIND $rows AS r MERGE (m:Module {path: r.path}) SET m.name = r.name, m.depth = r.depth",
    [...modules].map((path) => ({ path, name: path.split("/").at(-1), depth: path.split("/").length })));
  await batched(g, "UNWIND $rows AS r MATCH (c:Module {path: r.child}), (p:Module {path: r.parent}) MERGE (c)-[:IN]->(p)",
    [...modules].filter((m) => m.includes("/")).map((m) => ({ child: m, parent: m.split("/").slice(0, -1).join("/") })));
  await batched(g, "UNWIND $rows AS r MERGE (f:File {path: r.path}) SET f.name = r.name",
    [...files].map((path) => ({ path, name: path.split("/").at(-1) })));
  await batched(g, "UNWIND $rows AS r MATCH (f:File {path: r.path}), (m:Module {path: r.module}) MERGE (f)-[:IN]->(m)",
    [...files].map((path) => ({ path, module: modulesOf(path).at(-1) })).filter((r) => r.module));

  // Pull requests and what they touched, who wrote, reviewed and merged them.
  await batched(g, `UNWIND $rows AS r MERGE (p:PR {number: r.number})
    SET p.title = r.title, p.body = r.body, p.url = r.url, p.state = r.state,
        p.createdAt = r.createdAt, p.mergedAt = r.mergedAt, p.closedAt = r.closedAt`,
    raw.prs.map(({ number, title, body, url, state, createdAt, mergedAt, closedAt }) => ({ number, title, body, url, state, createdAt, mergedAt: mergedAt ?? "", closedAt: closedAt ?? "" })));
  await batched(g, "UNWIND $rows AS r MATCH (a:Person {login: r.login}), (p:PR {number: r.number}) MERGE (a)-[:AUTHORED]->(p)",
    raw.prs.filter((p) => p.author).map((p) => ({ login: p.author, number: p.number })));
  await batched(g, "UNWIND $rows AS r MATCH (a:Person {login: r.login}), (p:PR {number: r.number}) MERGE (a)-[:MERGED]->(p)",
    raw.prs.filter((p) => p.mergedBy).map((p) => ({ login: p.mergedBy, number: p.number })));
  // One REVIEWED edge per reviewer per PR, keeping their last verdict.
  const reviews = new Map<string, { login: string; number: number; state: string; at: string }>();
  for (const p of raw.prs) for (const r of p.reviews) {
    if (!r.author || r.author === p.author) continue;
    const k = `${r.author}#${p.number}`;
    const prev = reviews.get(k);
    if (!prev || (r.submittedAt ?? "") >= prev.at) reviews.set(k, { login: r.author, number: p.number, state: r.state, at: r.submittedAt ?? "" });
  }
  await batched(g, "UNWIND $rows AS r MATCH (a:Person {login: r.login}), (p:PR {number: r.number}) MERGE (a)-[e:REVIEWED]->(p) SET e.state = r.state, e.at = r.at",
    [...reviews.values()]);
  await batched(g, "UNWIND $rows AS r MATCH (p:PR {number: r.number}), (f:File {path: r.path}) MERGE (p)-[e:TOUCHED]->(f) SET e.added = r.added, e.deleted = r.deleted",
    raw.prs.flatMap((p) => p.files.map((f) => ({ number: p.number, path: f.path, added: f.additions, deleted: f.deletions }))), 1000);

  // Issues, who opened and discussed them, and which PRs fixed them.
  await batched(g, `UNWIND $rows AS r MERGE (i:Issue {number: r.number})
    SET i.title = r.title, i.body = r.body, i.url = r.url, i.state = r.state, i.createdAt = r.createdAt, i.closedAt = r.closedAt`,
    raw.issues.map(({ number, title, body, url, state, createdAt, closedAt }) => ({ number, title, body, url, state, createdAt, closedAt: closedAt ?? "" })));
  await batched(g, "UNWIND $rows AS r MATCH (a:Person {login: r.login}), (i:Issue {number: r.number}) MERGE (a)-[:OPENED]->(i)",
    raw.issues.filter((i) => i.author).map((i) => ({ login: i.author, number: i.number })));
  await batched(g, "UNWIND $rows AS r MATCH (a:Person {login: r.login}), (i:Issue {number: r.number}) MERGE (a)-[:COMMENTED]->(i)",
    raw.issues.flatMap((i) => i.commenters.map((login) => ({ login, number: i.number }))));
  await batched(g, "UNWIND $rows AS r MATCH (p:PR {number: r.pr}), (i:Issue {number: r.issue}) MERGE (p)-[:FIXES]->(i)",
    raw.prs.flatMap((p) => p.fixes.map((issue) => ({ pr: p.number, issue }))));

  // Labels on both.
  const labels = new Set([...raw.prs, ...raw.issues].flatMap((x) => x.labels));
  await batched(g, "UNWIND $rows AS r MERGE (:Label {name: r.name})", [...labels].map((name) => ({ name })));
  await batched(g, "UNWIND $rows AS r MATCH (p:PR {number: r.number}), (l:Label {name: r.name}) MERGE (p)-[:LABELED]->(l)",
    raw.prs.flatMap((p) => p.labels.map((name) => ({ number: p.number, name }))));
  await batched(g, "UNWIND $rows AS r MATCH (i:Issue {number: r.number}), (l:Label {name: r.name}) MERGE (i)-[:LABELED]->(l)",
    raw.issues.flatMap((i) => i.labels.map((name) => ({ number: i.number, name }))));

  await g.query("MERGE (m:Meta {repo: $repo}) SET m.syncedAt = $at", { params: { repo: raw.repo, at: raw.fetchedAt } });
  return g;
}

if (process.argv[1]?.endsWith("load.ts")) {
  const repo = process.argv[2] ?? "FalkorDB/FalkorDB";
  const t = Date.now();
  // A fresh fetch if there is one, otherwise the snapshot committed with the code.
  const path = existsSync(rawPath(repo)) ? rawPath(repo) : `data/snapshot/${repo.replace("/", "__")}.json.gz`;
  const bytes = readFileSync(path);
  const g = await loadRepo(JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")));
  console.log(`from ${path}`);
  const counts = await g.query<{ label: string; n: number }>("MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY n DESC");
  const edges = await g.query<{ type: string; n: number }>("MATCH ()-[e]->() RETURN type(e) AS type, count(e) AS n ORDER BY n DESC");
  console.log(counts.data?.map((r) => `${r.label}:${r.n}`).join("  "));
  console.log(edges.data?.map((r) => `${r.type}:${r.n}`).join("  "));
  console.log(`loaded in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  await closeDb();
}
