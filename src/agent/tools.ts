// The agent's tools. Each one is a Cypher query over the repo graph, and each returns
// two things: a short text for the model, and the exact nodes and edges it used, so
// the UI can draw the path behind the answer and the validator can check citations.
import type { Graph } from "falkordb";

export type Kind = "person" | "pr" | "issue" | "file" | "module" | "label";
export interface NodeRef { id: string; kind: Kind; label: string; url?: string; title?: string }
export interface EdgeRef { from: string; to: string; type: string }
export interface ToolResult { text: string; nodes: NodeRef[]; edges: EdgeRef[] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const RECENT_MONTHS = 18;
const since = () => new Date(Date.now() - RECENT_MONTHS * 30 * 86400e3).toISOString();
const person = (login: string): NodeRef => ({ id: `person:${login}`, kind: "person", label: `@${login}`, url: `https://github.com/${login}` });
const pr = (p: Row): NodeRef => ({ id: `pr:${p.number}`, kind: "pr", label: `#${p.number}`, title: p.title, url: p.url });
const issue = (i: Row): NodeRef => ({ id: `issue:${i.number}`, kind: "issue", label: `#${i.number}`, title: i.title, url: i.url });
const fileOrModule = (kind: "file" | "module", path: string): NodeRef => ({ id: `${kind}:${path}`, kind, label: path });
const day = (iso: string) => (iso ? iso.slice(0, 10) : "not merged");
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function rows(g: Graph, q: string, params: Record<string, unknown> = {}): Promise<Row[]> {
  const r = await g.query(q, { params: params as Record<string, never> });
  return (r.data ?? []) as Row[];
}

/** A target is a module (folder) or a file. Exact path first, then the best partial match. */
async function resolvePath(g: Graph, raw: string): Promise<{ kind: "file" | "module"; path: string } | { candidates: string[] }> {
  const path = raw.trim().replace(/^\/+|\/+$/g, "");
  const exact = await rows(g, `
    OPTIONAL MATCH (m:Module {path: $p}) OPTIONAL MATCH (f:File {path: $p})
    RETURN m.path AS m, f.path AS f`, { p: path });
  if (exact[0]?.m) return { kind: "module", path: exact[0].m };
  if (exact[0]?.f) return { kind: "file", path: exact[0].f };
  const needle = path.toLowerCase().replace(/\s+/g, "_");
  const mods = await rows(g, `
    MATCH (m:Module) WHERE toLower(m.path) CONTAINS $n AND NOT m.path STARTS WITH 'deps/'
    RETURN m.path AS path ORDER BY m.depth, size(m.path) LIMIT 5`, { n: needle });
  // One match, or several that all sit under the shallowest one ("execution_plan" -> src/execution_plan).
  if (mods.length && mods.every((m) => m.path === mods[0].path || m.path.startsWith(mods[0].path + "/"))) return { kind: "module", path: mods[0].path };
  const files = await rows(g, `
    MATCH (f:File) WHERE toLower(f.path) ENDS WITH $n OR toLower(f.name) = $n
    RETURN f.path AS path LIMIT 5`, { n: needle });
  if (!mods.length && files.length === 1) return { kind: "file", path: files[0].path };
  return { candidates: [...mods, ...files].map((r) => r.path) };
}

/** The PRs that touched a target: files directly, or any file under a module. */
const prsTouching = (kind: "file" | "module") => kind === "file"
  ? "MATCH (t:File {path: $p})<-[:TOUCHED]-(pr:PR)"
  : "MATCH (t:Module {path: $p})<-[:IN*0..4]-(:Module)<-[:IN]-(:File)<-[:TOUCHED]-(pr:PR)";

function notFound(raw: string, r: { candidates: string[] }): ToolResult {
  return {
    text: r.candidates.length
      ? `"${raw}" is not an exact path. Closest matches: ${r.candidates.join(", ")}. Call the tool again with one of these.`
      : `Nothing in the repository matches "${raw}". Try search with a different word.`,
    nodes: [], edges: [],
  };
}

export async function search(g: Graph, { query }: { query: string }): Promise<ToolResult> {
  const words = query.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length >= 3).slice(0, 4);
  if (!words.length) return { text: "Give a word or two to search for.", nodes: [], edges: [] };
  const w = words.join("_");
  const [mods, people, prs, issues] = await Promise.all([
    rows(g, `MATCH (m:Module) WHERE toLower(m.path) CONTAINS $w AND NOT m.path STARTS WITH 'deps/' RETURN m.path AS path ORDER BY m.depth LIMIT 5`, { w }),
    rows(g, `MATCH (p:Person) WHERE p.bot = false AND toLower(p.login) CONTAINS $w RETURN p.login AS login LIMIT 5`, { w }),
    rows(g, `MATCH (p:PR) WHERE all(x IN $words WHERE toLower(p.title) CONTAINS x)
             RETURN p.number AS number, p.title AS title, p.url AS url ORDER BY p.createdAt DESC LIMIT 6`, { words }),
    rows(g, `MATCH (i:Issue) WHERE all(x IN $words WHERE toLower(i.title) CONTAINS x)
             RETURN i.number AS number, i.title AS title, i.url AS url ORDER BY i.createdAt DESC LIMIT 6`, { words }),
  ]);
  const lines = [
    mods.length ? `Modules: ${mods.map((m) => m.path).join(", ")}` : "",
    people.length ? `People: ${people.map((p) => "@" + p.login).join(", ")}` : "",
    prs.length ? `PRs: ${prs.map((p) => `#${p.number} "${short(p.title, 70)}"`).join("; ")}` : "",
    issues.length ? `Issues: ${issues.map((i) => `#${i.number} "${short(i.title, 70)}"`).join("; ")}` : "",
  ].filter(Boolean);
  return {
    text: lines.length ? lines.join("\n") : `No module, person, PR or issue matches "${query}".`,
    nodes: [...mods.map((m) => fileOrModule("module", m.path)), ...people.map((p) => person(p.login)), ...prs.map(pr), ...issues.map(issue)],
    edges: [],
  };
}

export async function whoKnows(g: Graph, { path: raw }: { path: string }): Promise<ToolResult> {
  const t = await resolvePath(g, raw);
  if ("candidates" in t) return notFound(raw, t);
  const match = prsTouching(t.kind);
  const authors = await rows(g, `${match}<-[:AUTHORED]-(a:Person)
    WHERE a.bot = false AND pr.mergedAt <> ''
    WITH a, pr ORDER BY pr.mergedAt DESC
    WITH a, collect(DISTINCT pr) AS prs
    RETURN a.login AS login, size(prs) AS authored,
           size([x IN prs WHERE x.mergedAt >= $since]) AS recent,
           prs[0].mergedAt AS last,
           [x IN prs[0..2] | {number: x.number, title: x.title, url: x.url}] AS examples
    ORDER BY authored DESC LIMIT 8`, { p: t.path, since: since() });
  const reviewers = await rows(g, `${match}<-[:REVIEWED]-(a:Person)
    WHERE a.bot = false
    RETURN a.login AS login, count(DISTINCT pr) AS reviewed ORDER BY reviewed DESC LIMIT 8`, { p: t.path });
  const byLogin = new Map<string, { login: string; authored: number; recent: number; reviewed: number; last: string; examples: Row[] }>();
  for (const a of authors) byLogin.set(a.login, { login: a.login, authored: a.authored, recent: a.recent, reviewed: 0, last: a.last, examples: a.examples });
  for (const r of reviewers) {
    const e = byLogin.get(r.login) ?? { login: r.login, authored: 0, recent: 0, reviewed: 0, last: "", examples: [] };
    e.reviewed = r.reviewed;
    byLogin.set(r.login, e);
  }
  // Recent authorship counts most, then all authorship, then reviews.
  const ranked = [...byLogin.values()]
    .map((e) => ({ ...e, score: 3 * e.recent + 2 * e.authored + e.reviewed }))
    .sort((a, b) => b.score - a.score).slice(0, 5);
  if (!ranked.length) return { text: `No merged PRs have touched ${t.path}.`, nodes: [fileOrModule(t.kind, t.path)], edges: [] };

  const target = fileOrModule(t.kind, t.path);
  const nodes: NodeRef[] = [target];
  const edges: EdgeRef[] = [];
  const lines = ranked.map((e, i) => {
    nodes.push(person(e.login));
    for (const x of e.examples) {
      nodes.push(pr(x));
      edges.push({ from: `person:${e.login}`, to: `pr:${x.number}`, type: "AUTHORED" }, { from: `pr:${x.number}`, to: target.id, type: "TOUCHED" });
    }
    const ex = e.examples.map((x) => `#${x.number} "${short(x.title, 60)}"`).join("; ");
    return `${i + 1}. @${e.login}: authored ${e.authored} merged PRs here (${e.recent} in the last ${RECENT_MONTHS} months, last on ${day(e.last)}), reviewed ${e.reviewed}.${ex ? ` Recent: ${ex}` : ""}`;
  });
  return { text: `People who know ${t.kind} ${t.path}, ranked:\n${lines.join("\n")}`, nodes, edges };
}

export async function changeHistory(g: Graph, { path: raw, limit = 8 }: { path: string; limit?: number }): Promise<ToolResult> {
  const t = await resolvePath(g, raw);
  if ("candidates" in t) return notFound(raw, t);
  const prs = await rows(g, `${prsTouching(t.kind)}
    WHERE pr.mergedAt <> ''
    WITH DISTINCT pr ORDER BY pr.mergedAt DESC LIMIT $limit
    OPTIONAL MATCH (a:Person)-[:AUTHORED]->(pr)
    OPTIONAL MATCH (pr)-[:FIXES]->(i:Issue)
    RETURN pr.number AS number, pr.title AS title, pr.url AS url, pr.mergedAt AS mergedAt, a.login AS author,
           collect(DISTINCT {number: i.number, title: i.title, url: i.url}) AS fixes
    ORDER BY mergedAt DESC`, { p: t.path, limit: Math.min(Math.max(1, Number(limit) || 8), 15) });
  const target = fileOrModule(t.kind, t.path);
  const nodes: NodeRef[] = [target];
  const edges: EdgeRef[] = [];
  const lines = prs.map((p) => {
    nodes.push(pr(p));
    edges.push({ from: `pr:${p.number}`, to: target.id, type: "TOUCHED" });
    if (p.author) { nodes.push(person(p.author)); edges.push({ from: `person:${p.author}`, to: `pr:${p.number}`, type: "AUTHORED" }); }
    const fixes = (p.fixes as Row[]).filter((i) => i.number != null);
    for (const i of fixes) { nodes.push(issue(i)); edges.push({ from: `pr:${p.number}`, to: `issue:${i.number}`, type: "FIXES" }); }
    return `- ${day(p.mergedAt)} #${p.number} "${short(p.title, 80)}" by @${p.author ?? "unknown"}${fixes.length ? `, fixes ${fixes.map((i) => `#${i.number} "${short(i.title, 60)}"`).join(", ")}` : ""}`;
  });
  return { text: prs.length ? `Latest merged changes to ${t.path}:\n${lines.join("\n")}` : `No merged PRs have touched ${t.path}.`, nodes, edges };
}

export async function explainPr(g: Graph, { number }: { number: number }): Promise<ToolResult> {
  const [p] = await rows(g, `
    MATCH (pr:PR {number: $n})
    OPTIONAL MATCH (a:Person)-[:AUTHORED]->(pr)
    OPTIONAL MATCH (m:Person)-[:MERGED]->(pr)
    OPTIONAL MATCH (pr)-[:FIXES]->(i:Issue)
    OPTIONAL MATCH (opener:Person)-[:OPENED]->(i)
    OPTIONAL MATCH (pr)-[:LABELED]->(l:Label)
    RETURN pr.number AS number, pr.title AS title, pr.url AS url, pr.body AS body, pr.state AS state,
           pr.createdAt AS createdAt, pr.mergedAt AS mergedAt, a.login AS author, m.login AS mergedBy,
           collect(DISTINCT {number: i.number, title: i.title, url: i.url, body: i.body, opener: opener.login}) AS fixes,
           collect(DISTINCT l.name) AS labels`, { n: Number(number) });
  if (!p?.number) return { text: `There is no PR #${number} in this repository. It may be an issue: try explain_issue.`, nodes: [], edges: [] };
  const reviews = await rows(g, `MATCH (r:Person)-[e:REVIEWED]->(:PR {number: $n}) WHERE r.bot = false RETURN r.login AS login, e.state AS state`, { n: Number(number) });
  const mods = await rows(g, `MATCH (:PR {number: $n})-[:TOUCHED]->(:File)-[:IN]->(m:Module) RETURN m.path AS path, count(*) AS files ORDER BY files DESC LIMIT 4`, { n: Number(number) });
  const node = pr(p);
  const nodes: NodeRef[] = [node];
  const edges: EdgeRef[] = [];
  if (p.author) { nodes.push(person(p.author)); edges.push({ from: `person:${p.author}`, to: node.id, type: "AUTHORED" }); }
  for (const r of reviews) { nodes.push(person(r.login)); edges.push({ from: `person:${r.login}`, to: node.id, type: "REVIEWED" }); }
  for (const m of mods) { nodes.push(fileOrModule("module", m.path)); edges.push({ from: node.id, to: `module:${m.path}`, type: "TOUCHED" }); }
  const fixes = (p.fixes as Row[]).filter((i) => i.number != null);
  for (const i of fixes) {
    nodes.push(issue(i)); edges.push({ from: node.id, to: `issue:${i.number}`, type: "FIXES" });
    if (i.opener) { nodes.push(person(i.opener)); edges.push({ from: `person:${i.opener}`, to: `issue:${i.number}`, type: "OPENED" }); }
  }
  const text = [
    `PR #${p.number} "${p.title}" by @${p.author ?? "unknown"}, ${p.state.toLowerCase()}${p.mergedAt ? ` on ${day(p.mergedAt)}${p.mergedBy ? ` by @${p.mergedBy}` : ""}` : ""}.`,
    p.labels.length ? `Labels: ${p.labels.join(", ")}.` : "",
    reviews.length ? `Reviews: ${reviews.map((r) => `@${r.login} (${r.state.toLowerCase().replace("_", " ")})`).join(", ")}.` : "No human reviews recorded.",
    mods.length ? `Touched: ${mods.map((m) => `${m.path} (${m.files} files)`).join(", ")}.` : "",
    p.body ? `Description: ${short(p.body.replace(/\s+/g, " "), 600)}` : "No description.",
    ...fixes.map((i) => `Fixes issue #${i.number} "${i.title}" opened by @${i.opener ?? "unknown"}: ${short((i.body ?? "").replace(/\s+/g, " "), 400)}`),
  ].filter(Boolean).join("\n");
  return { text, nodes, edges };
}

export async function explainIssue(g: Graph, { number }: { number: number }): Promise<ToolResult> {
  const [i] = await rows(g, `
    MATCH (i:Issue {number: $n})
    OPTIONAL MATCH (o:Person)-[:OPENED]->(i)
    OPTIONAL MATCH (c:Person)-[:COMMENTED]->(i) WHERE c.bot = false
    OPTIONAL MATCH (pr:PR)-[:FIXES]->(i)
    OPTIONAL MATCH (a:Person)-[:AUTHORED]->(pr)
    RETURN i.number AS number, i.title AS title, i.url AS url, i.body AS body, i.state AS state,
           i.createdAt AS createdAt, i.closedAt AS closedAt, o.login AS opener,
           collect(DISTINCT c.login) AS commenters,
           collect(DISTINCT {number: pr.number, title: pr.title, url: pr.url, mergedAt: pr.mergedAt, author: a.login}) AS prs`, { n: Number(number) });
  if (!i?.number) return { text: `There is no issue #${number} in this repository. It may be a PR: try explain_pr.`, nodes: [], edges: [] };
  const node = issue(i);
  const nodes: NodeRef[] = [node];
  const edges: EdgeRef[] = [];
  if (i.opener) { nodes.push(person(i.opener)); edges.push({ from: `person:${i.opener}`, to: node.id, type: "OPENED" }); }
  const prs = (i.prs as Row[]).filter((p) => p.number != null);
  for (const p of prs) {
    nodes.push(pr(p)); edges.push({ from: `pr:${p.number}`, to: node.id, type: "FIXES" });
    if (p.author) { nodes.push(person(p.author)); edges.push({ from: `person:${p.author}`, to: `pr:${p.number}`, type: "AUTHORED" }); }
  }
  const text = [
    `Issue #${i.number} "${i.title}" opened by @${i.opener ?? "unknown"} on ${day(i.createdAt)}, ${i.state.toLowerCase()}${i.closedAt ? ` on ${day(i.closedAt)}` : ""}.`,
    i.commenters.length ? `Discussed by: ${i.commenters.slice(0, 8).map((c: string) => "@" + c).join(", ")}.` : "",
    prs.length ? `Fixed by: ${prs.map((p) => `#${p.number} "${short(p.title, 70)}" by @${p.author ?? "unknown"}${p.mergedAt ? `, merged ${day(p.mergedAt)}` : ", not merged"}`).join("; ")}.` : "No PR is linked as fixing it.",
    i.body ? `Description: ${short(i.body.replace(/\s+/g, " "), 600)}` : "",
  ].filter(Boolean).join("\n");
  return { text, nodes, edges };
}

export async function personProfile(g: Graph, { login }: { login: string }): Promise<ToolResult> {
  const name = login.replace(/^@/, "");
  const [p] = await rows(g, `MATCH (p:Person) WHERE toLower(p.login) = toLower($l) RETURN p.login AS login, p.bot AS bot`, { l: name });
  if (!p) return { text: `No contributor called @${name}. Try search.`, nodes: [], edges: [] };
  const areas = await rows(g, `
    MATCH (:Person {login: $l})-[:AUTHORED]->(pr:PR)-[:TOUCHED]->(:File)-[:IN]->(m:Module)
    WHERE pr.mergedAt <> '' AND NOT m.path STARTS WITH 'deps/'
    RETURN m.path AS path, count(DISTINCT pr) AS prs ORDER BY prs DESC LIMIT 5`, { l: p.login });
  const [counts] = await rows(g, `
    MATCH (a:Person {login: $l})
    OPTIONAL MATCH (a)-[:AUTHORED]->(x:PR) WITH a, count(x) AS authored
    OPTIONAL MATCH (a)-[:REVIEWED]->(y:PR) WITH a, authored, count(y) AS reviewed
    OPTIONAL MATCH (a)-[:OPENED]->(z:Issue)
    RETURN authored, reviewed, count(z) AS opened`, { l: p.login });
  const recent = await rows(g, `MATCH (:Person {login: $l})-[:AUTHORED]->(pr:PR) WHERE pr.mergedAt <> ''
    RETURN pr.number AS number, pr.title AS title, pr.url AS url, pr.mergedAt AS mergedAt ORDER BY pr.mergedAt DESC LIMIT 3`, { l: p.login });
  const me = person(p.login);
  const nodes: NodeRef[] = [me, ...areas.map((a) => fileOrModule("module", a.path)), ...recent.map(pr)];
  const edges: EdgeRef[] = [
    ...areas.map((a) => ({ from: me.id, to: `module:${a.path}`, type: "WORKS_ON" })),
    ...recent.map((r) => ({ from: me.id, to: `pr:${r.number}`, type: "AUTHORED" })),
  ];
  const text = [
    `@${p.login}${p.bot ? " (a bot)" : ""}: authored ${counts.authored} PRs, reviewed ${counts.reviewed}, opened ${counts.opened} issues.`,
    areas.length ? `Works most on: ${areas.map((a) => `${a.path} (${a.prs} merged PRs)`).join(", ")}.` : "",
    recent.length ? `Latest merged: ${recent.map((r) => `${day(r.mergedAt)} #${r.number} "${short(r.title, 60)}"`).join("; ")}.` : "",
  ].filter(Boolean).join("\n");
  return { text, nodes, edges };
}

export async function knowledgeRisk(g: Graph, { path }: { path?: string }): Promise<ToolResult> {
  const under = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  const found = await rows(g, `
    MATCH (m:Module)<-[:IN*0..4]-(:Module)<-[:IN]-(:File)<-[:TOUCHED]-(pr:PR)<-[:AUTHORED]-(a:Person)
    WHERE a.bot = false AND pr.mergedAt <> '' AND NOT m.path STARTS WITH 'deps/'
      AND ($under = '' OR m.path STARTS WITH $under) AND m.depth <= $maxDepth
    WITH m, a, count(DISTINCT pr) AS n
    WITH m, collect({who: a.login, n: n}) AS by, sum(n) AS total
    WHERE total >= 10
    WITH m, total, size(by) AS people,
         reduce(top = {who: '', n: 0}, x IN by | CASE WHEN x.n > top.n THEN x ELSE top END) AS top
    RETURN m.path AS path, total, people, top.who AS who, top.n AS n
    ORDER BY 1.0 * top.n / total DESC, total DESC LIMIT 6`,
    { under, maxDepth: under ? under.split("/").length + 1 : 2 });
  const nodes: NodeRef[] = [];
  const edges: EdgeRef[] = [];
  const lines = found.map((r) => {
    nodes.push(fileOrModule("module", r.path), person(r.who));
    edges.push({ from: `person:${r.who}`, to: `module:${r.path}`, type: "WORKS_ON" });
    return `- ${r.path}: @${r.who} wrote ${r.n} of ${r.total} merged PRs (${Math.round((100 * r.n) / r.total)}%), ${r.people} people in total`;
  });
  return {
    text: lines.length ? `Areas where one person holds most of the knowledge${under ? ` under ${under}` : ""}:\n${lines.join("\n")}` : "Not enough merged PRs to judge knowledge risk here.",
    nodes, edges,
  };
}

export async function connection(g: Graph, { login, path: raw }: { login: string; path: string }): Promise<ToolResult> {
  const t = await resolvePath(g, raw);
  if ("candidates" in t) return notFound(raw, t);
  const name = login.replace(/^@/, "");
  const label = t.kind === "file" ? "File" : "Module";
  // FalkorDB's shortestPath follows edge direction: Person -> PR -> File -> Module.
  const r = await rows(g, `
    MATCH (a:Person), (t:${label} {path: $p}) WHERE toLower(a.login) = toLower($l)
    WITH a, t RETURN shortestPath((a)-[:AUTHORED|REVIEWED|TOUCHED|IN*..7]->(t)) AS path`, { l: name, p: t.path });
  const path = r[0]?.path as { nodes: { labels: string[]; properties: Row }[]; edges: { relationshipType: string }[] } | null;
  if (!path?.nodes?.length) return { text: `@${name} has no authored or reviewed PR that touched ${t.path}.`, nodes: [], edges: [] };
  const nodes = path.nodes.map((n): NodeRef => {
    const p = n.properties;
    if (n.labels.includes("Person")) return person(p.login);
    if (n.labels.includes("PR")) return pr(p);
    if (n.labels.includes("File")) return fileOrModule("file", p.path);
    return fileOrModule("module", p.path);
  });
  const edges = path.edges.map((e, i) => ({ from: nodes[i].id, to: nodes[i + 1].id, type: e.relationshipType }));
  return { text: `Closest link: ${nodes.map((n, i) => (i ? ` -[${edges[i - 1].type}]-> ` : "") + (n.kind === "pr" ? `${n.label} "${short(n.title ?? "", 50)}"` : n.label)).join("")}`, nodes, edges };
}

export const TOOLS = {
  search: { fn: search, description: "Find modules (folders), people, PRs and issues whose name or title matches a few words. Use this first when the question names a topic rather than an exact path or number.", params: { query: { type: "string", description: "One to three keywords, e.g. 'execution plan' or 'bolt'" } }, required: ["query"] },
  who_knows: { fn: whoKnows, description: "Rank the people who know a module or file best, from merged PRs they wrote (recent ones count more) and PRs they reviewed. Use for 'who should I ask / who owns / who would review'.", params: { path: { type: "string", description: "Module or file path, e.g. 'src/execution_plan'" } }, required: ["path"] },
  change_history: { fn: changeHistory, description: "The latest merged PRs that changed a module or file, with their authors and the issues they fixed. Use for 'what changed / why does this keep changing'.", params: { path: { type: "string" }, limit: { type: "number", description: "How many PRs, default 8" } }, required: ["path"] },
  explain_pr: { fn: explainPr, description: "Everything about one PR: description, author, reviewers and verdicts, modules touched, and the issues it fixed with their descriptions. Use for 'why was this change made'.", params: { number: { type: "number" } }, required: ["number"] },
  explain_issue: { fn: explainIssue, description: "Everything about one issue: who reported and discussed it, and which PRs fixed it.", params: { number: { type: "number" } }, required: ["number"] },
  person_profile: { fn: personProfile, description: "What one person works on: their main modules, counts of PRs and reviews, and latest merged PRs.", params: { login: { type: "string", description: "GitHub login, e.g. 'swilly22'" } }, required: ["login"] },
  knowledge_risk: { fn: knowledgeRisk, description: "Find modules where one person wrote most of the merged PRs, i.e. where knowledge would be lost if they left. Optionally only under a path.", params: { path: { type: "string", description: "Optional folder to look under, e.g. 'src'" } }, required: [] },
  connection: { fn: connection, description: "The shortest chain of PRs and files linking a person to a module or file. Use to show how someone is connected to an area.", params: { login: { type: "string" }, path: { type: "string" } }, required: ["login", "path"] },
} as const;
export type ToolName = keyof typeof TOOLS;
