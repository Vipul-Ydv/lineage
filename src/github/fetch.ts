// Pulls a repository's pull requests and issues from the GitHub GraphQL API into
// data/raw/<owner>__<repo>.json. Everything here is public data. Re-running with
// --since=<ISO date> fetches only what changed, which is how the graph stays current.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface RawPR {
  number: number; title: string; body: string; url: string; state: string;
  createdAt: string; mergedAt: string | null; closedAt: string | null; updatedAt: string;
  author: string | null; mergedBy: string | null; labels: string[];
  files: { path: string; additions: number; deletions: number }[];
  reviews: { author: string | null; state: string; submittedAt: string | null }[];
  fixes: number[];
}
export interface RawIssue {
  number: number; title: string; body: string; url: string; state: string;
  createdAt: string; closedAt: string | null; updatedAt: string;
  author: string | null; labels: string[]; commenters: string[];
}
export interface RawRepo { repo: string; fetchedAt: string; prs: RawPR[]; issues: RawIssue[] }

const BODY_CHARS = 1500;

function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (res.ok && json.data && !json.errors) return json.data;
    // GitHub sometimes times out on big pages; back off and retry a few times.
    if (attempt >= 4) throw new Error(`GitHub GraphQL failed: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const PR_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(first:40,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title body url state createdAt mergedAt closedAt updatedAt
        author{login} mergedBy{login}
        labels(first:10){nodes{name}}
        files(first:100){nodes{path additions deletions}}
        reviews(first:30){nodes{author{login} state submittedAt}}
        closingIssuesReferences(first:5){nodes{number}}
      }
    }
  }
}`;

const ISSUE_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    issues(first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title body url state createdAt closedAt updatedAt
        author{login}
        labels(first:10){nodes{name}}
        comments(first:30){nodes{author{login}}}
      }
    }
  }
}`;

type Page<N> = { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: N[] };
const login = (a: { login: string } | null) => a?.login ?? null;
const trim = (s: string | null) => (s ?? "").replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, BODY_CHARS);

async function pages<N>(query: string, key: "pullRequests" | "issues", owner: string, name: string, since?: string): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { repository: Record<string, Page<N & { updatedAt: string }>> } =
      await gql(query, { owner, name, after });
    const page = data.repository[key];
    for (const n of page.nodes) {
      // Pages are ordered by updatedAt, newest first: stop at the first item older than `since`.
      if (since && n.updatedAt < since) return out;
      out.push(n);
    }
    process.stdout.write(`\r${key}: ${out.length}`);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  process.stdout.write("\n");
  return out;
}

export async function fetchRepo(repo: string, since?: string): Promise<RawRepo> {
  const [owner, name] = repo.split("/");
  const fetchedAt = new Date().toISOString();
  const prs = (await pages<any>(PR_QUERY, "pullRequests", owner, name, since)).map((p): RawPR => ({
    number: p.number, title: p.title, body: trim(p.body), url: p.url, state: p.state,
    createdAt: p.createdAt, mergedAt: p.mergedAt, closedAt: p.closedAt, updatedAt: p.updatedAt,
    author: login(p.author), mergedBy: login(p.mergedBy),
    labels: p.labels.nodes.map((l: { name: string }) => l.name),
    files: p.files?.nodes ?? [],
    reviews: p.reviews.nodes.map((r: { author: { login: string } | null; state: string; submittedAt: string | null }) => ({ author: login(r.author), state: r.state, submittedAt: r.submittedAt })),
    fixes: p.closingIssuesReferences.nodes.map((i: { number: number }) => i.number),
  }));
  const issues = (await pages<any>(ISSUE_QUERY, "issues", owner, name, since)).map((i): RawIssue => ({
    number: i.number, title: i.title, body: trim(i.body), url: i.url, state: i.state,
    createdAt: i.createdAt, closedAt: i.closedAt, updatedAt: i.updatedAt,
    author: login(i.author), labels: i.labels.nodes.map((l: { name: string }) => l.name),
    commenters: [...new Set<string>(i.comments.nodes.map((c: { author: { login: string } | null }) => c.author?.login).filter(Boolean))],
  }));
  return { repo, fetchedAt, prs, issues };
}

export function rawPath(repo: string) {
  return `data/raw/${repo.replace("/", "__")}.json`;
}

// CLI: npm run fetch -- FalkorDB/FalkorDB
if (process.argv[1]?.endsWith("fetch.ts")) {
  const repo = process.argv[2] ?? "FalkorDB/FalkorDB";
  mkdirSync("data/raw", { recursive: true });
  const path = rawPath(repo);
  const old: RawRepo | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const fresh = await fetchRepo(repo, old?.fetchedAt);
  // Merge: newer copies of a PR or issue replace older ones.
  const merged: RawRepo = old
    ? {
        repo, fetchedAt: fresh.fetchedAt,
        prs: [...new Map([...old.prs, ...fresh.prs].map((p) => [p.number, p])).values()],
        issues: [...new Map([...old.issues, ...fresh.issues].map((i) => [i.number, i])).values()],
      }
    : fresh;
  writeFileSync(path, JSON.stringify(merged));
  console.log(`${repo}: ${merged.prs.length} PRs, ${merged.issues.length} issues (${fresh.prs.length + fresh.issues.length} new or updated) -> ${path}`);
}
