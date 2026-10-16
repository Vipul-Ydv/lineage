// HTTP server: the agent as a Server-Sent Events stream, a few read endpoints, and the
// built web app. One question runs at a time because the model is a single CPU server.
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { graphFor } from "./graph/db.ts";
import { ask } from "./agent/agent.ts";
import { knowledgeRisk } from "./agent/tools.ts";

const REPO = process.env.REPO ?? "FalkorDB/FalkorDB";
const PORT = Number(process.env.PORT ?? 8787);
const WEB = join(process.cwd(), "web", "dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

let busy: Promise<void> = Promise.resolve();
let waiting = 0;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function meta() {
  const g = await graphFor(REPO);
  const counts = await g.query<{ label: string; n: number }>("MATCH (n) WHERE NOT n:Meta RETURN labels(n)[0] AS label, count(n) AS n");
  const edges = await g.query<{ n: number }>("MATCH ()-[e]->() RETURN count(e) AS n");
  const m = await g.query<{ at: string }>("MATCH (m:Meta {repo: $repo}) RETURN m.syncedAt AS at", { params: { repo: REPO } });
  return {
    repo: REPO,
    syncedAt: m.data?.[0]?.at ?? null,
    counts: Object.fromEntries((counts.data ?? []).map((r) => [r.label, r.n])),
    edges: edges.data?.[0]?.n ?? 0,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/health") return json(res, 200, { ok: true });
    if (url.pathname === "/api/meta") return json(res, 200, await meta());
    if (url.pathname === "/api/overview") {
      // The opening picture: where one person holds most of the knowledge.
      return json(res, 200, await knowledgeRisk(await graphFor(REPO), { path: "src" }));
    }
    if (url.pathname === "/api/ask") {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
      if (!q) return json(res, 400, { error: "Write a question first." });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      let open = true;
      req.on("close", () => { open = false; });
      const send = (e: unknown) => { if (open) res.write(`data: ${JSON.stringify(e)}\n\n`); };
      const ahead = waiting++;
      if (ahead > 0) send({ type: "queued", ahead });
      const run = busy.then(async () => {
        waiting--;
        if (!open) return;
        await ask(await graphFor(REPO), REPO, q, send);
      });
      busy = run.catch(() => {});
      await run;
      res.end();
      return;
    }
    // Static web app, with index.html for any other path.
    const file = normalize(join(WEB, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(WEB)) return json(res, 404, { error: "Not found" });
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" });
      return res.end(body);
    } catch {
      const body = await readFile(join(WEB, "index.html")).catch(() => null);
      if (!body) return json(res, 404, { error: "The web app is not built. Run npm run build in web/." });
      res.writeHead(200, { "content-type": TYPES[".html"] });
      return res.end(body);
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`Lineage on http://localhost:${PORT} for ${REPO}`));
