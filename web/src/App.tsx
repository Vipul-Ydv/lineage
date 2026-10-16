import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Graph, KIND_COLOR } from "./Graph";
import type { AgentEvent, EdgeRef, Meta, NodeRef } from "./types";

const EXAMPLES = [
  "Who should I ask about the execution plan code?",
  "Why were unique constraint inserts slow in 6.0.0, and who fixed it?",
  "Which parts of src would we lose knowledge of if swilly22 left?",
  "What changed recently in the serializers, and why?",
];

type Step = Extract<AgentEvent, { type: "tool" }>;
type Answer = Extract<AgentEvent, { type: "answer" }>;

function describe(s: Step): string {
  const a = s.args as Record<string, string | number | undefined>;
  switch (s.name) {
    case "search": return `Searched the graph for “${a.query}”`;
    case "who_knows": return `Ranked who knows ${a.path}`;
    case "change_history": return `Read the change history of ${a.path}`;
    case "explain_pr": return `Opened pull request #${a.number}`;
    case "explain_issue": return `Opened issue #${a.number}`;
    case "person_profile": return `Looked up @${String(a.login ?? "").replace(/^@/, "")}`;
    case "knowledge_risk": return `Looked for code that only one person knows${a.path ? ` in ${a.path}` : ""}`;
    case "connection": return `Traced how @${String(a.login ?? "").replace(/^@/, "")} connects to ${a.path}`;
    default: return s.name;
  }
}

function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function mergeNodes(a: NodeRef[], b: NodeRef[]) {
  const m = new Map(a.map((n) => [n.id, n]));
  for (const n of b) if (!m.has(n.id)) m.set(n.id, n);
  return [...m.values()];
}
function mergeEdges(a: EdgeRef[], b: EdgeRef[]) {
  const m = new Map(a.map((e) => [`${e.from}>${e.type}>${e.to}`, e]));
  for (const e of b) m.set(`${e.from}>${e.type}>${e.to}`, e);
  return [...m.values()];
}

/** The nodes the answer stands on: what it cites, the targets the tools were run on, and anything linking two of those. */
function pathOf(answer: Answer, steps: Step[], nodes: NodeRef[], edges: EdgeRef[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const lit = new Set<string>();
  for (const c of answer.cited) {
    if (c.startsWith("#")) {
      const n = c.slice(1);
      if (ids.has(`pr:${n}`)) lit.add(`pr:${n}`);
      if (ids.has(`issue:${n}`)) lit.add(`issue:${n}`);
    } else {
      const hit = nodes.find((x) => x.kind === "person" && x.label.toLowerCase() === c.toLowerCase());
      if (hit) lit.add(hit.id);
    }
  }
  if (!lit.size) return lit;
  // What the agent deliberately opened (a PR, an issue, a folder) is part of the path too; search results are not.
  for (const s of steps) {
    const target = s.nodes[0];
    if (target && s.name !== "search" && s.name !== "knowledge_risk" && s.edges.length) lit.add(target.id);
  }
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!neighbours.has(e.from)) neighbours.set(e.from, new Set());
    if (!neighbours.has(e.to)) neighbours.set(e.to, new Set());
    neighbours.get(e.from)!.add(e.to);
    neighbours.get(e.to)!.add(e.from);
  }
  for (const [id, ns] of neighbours) {
    if (!lit.has(id) && [...ns].filter((n) => lit.has(n)).length >= 2) lit.add(id);
  }
  return lit;
}

function AnswerText({ text, nodes }: { text: string; nodes: NodeRef[] }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/#(\d+)|@([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
    parts.push(text.slice(last, m.index));
    const node = m[1]
      ? nodes.find((n) => n.id === `pr:${m[1]}`) ?? nodes.find((n) => n.id === `issue:${m[1]}`)
      : nodes.find((n) => n.kind === "person" && n.label.toLowerCase() === m[0].toLowerCase());
    parts.push(node?.url
      ? <a key={m.index} className={`ref ref-${node.kind}`} href={node.url} target="_blank" rel="noreferrer" title={node.title}>{m[0]}</a>
      : <span key={m.index} className="ref">{m[0]}</span>);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className="answer-text">{parts}</p>;
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [rejections, setRejections] = useState<string[][]>([]);
  const [nodes, setNodes] = useState<NodeRef[]>([]);
  const [edges, setEdges] = useState<EdgeRef[]>([]);
  const [overview, setOverview] = useState(true);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/meta").then((r) => r.json()).then(setMeta).catch(() => {});
    fetch("/api/overview").then((r) => r.json()).then((o: { nodes: NodeRef[]; edges: EdgeRef[] }) => { setNodes(o.nodes); setEdges(o.edges); }).catch(() => {});
    return () => source.current?.close();
  }, []);

  const highlight = useMemo(() => (answer?.checked ? pathOf(answer, steps, nodes, edges) : null), [answer, steps, nodes, edges]);

  function run(q: string) {
    const text = q.trim();
    if (!text || status === "working") return;
    source.current?.close();
    setAsked(text); setSteps([]); setAnswer(null); setRejections([]); setNote(""); setSelected(null); setOpen(null);
    setNodes([]); setEdges([]); setOverview(false); setStatus("working");
    const es = new EventSource(`/api/ask?q=${encodeURIComponent(text)}`);
    source.current = es;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AgentEvent;
      if (e.type === "queued") setNote(`Another question is running. Yours is next${e.ahead > 1 ? ` after ${e.ahead}` : ""}.`);
      else if (e.type === "thinking") setNote(e.turn === 0 ? "Reading the question" : "Deciding what to look at next");
      else if (e.type === "tool") {
        setSteps((s) => [...s, e]);
        // Only connected evidence goes on the canvas; search hits are leads, listed in the step instead.
        if (e.edges.length) {
          const linked = new Set(e.edges.flatMap((x) => [x.from, x.to]));
          setNodes((n) => mergeNodes(n, e.nodes.filter((x) => linked.has(x.id))));
          setEdges((x) => mergeEdges(x, e.edges));
        }
      } else if (e.type === "rejected") setRejections((r) => [...r, e.reasons]);
      else if (e.type === "answer") { setAnswer(e); setStatus("done"); setNote(""); es.close(); }
      else if (e.type === "error") { setStatus("error"); setNote(`The agent stopped: ${e.message}. Try again in a minute.`); es.close(); }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      es.close();
      setStatus((s) => (s === "working" ? "error" : s));
      setNote((n) => n || "Lost the connection to the server. Ask again.");
    };
  }

  function submit(e: FormEvent) { e.preventDefault(); run(question); }

  const counts = meta?.counts ?? {};
  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#1A2633" /><path d="M9 23 L16 9 L23 23" fill="none" stroke="#EDF0F3" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9" cy="23" r="3" fill="#2E7D6B" /><circle cx="16" cy="9" r="3" fill="#4A4CC0" /><circle cx="23" cy="23" r="3" fill="#B4741A" /></svg>
          <h1>Lineage</h1>
        </div>
        {meta && (
          <p className="repo-line">
            The company brain for <a href={`https://github.com/${meta.repo}`} target="_blank" rel="noreferrer"><code>{meta.repo}</code></a>:{" "}
            {(counts.Person ?? 0).toLocaleString()} people, {(counts.PR ?? 0).toLocaleString()} pull requests, {(counts.Issue ?? 0).toLocaleString()} issues and {(counts.File ?? 0).toLocaleString()} files in one FalkorDB graph
            {meta.syncedAt ? `, synced ${timeAgo(meta.syncedAt)}` : ""}.
          </p>
        )}
      </header>

      <form className="ask" onSubmit={submit}>
        <label htmlFor="q" className="ask-label">Ask about the code, the people or a decision</label>
        <div className="ask-row">
          <input id="q" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Who should I ask about the query planner?" maxLength={300} autoComplete="off" />
          <button type="submit" disabled={status === "working" || !question.trim()}>{status === "working" ? "Asking…" : "Ask"}</button>
        </div>
        <div className="examples">
          <span>Try:</span>
          {EXAMPLES.map((q) => (
            <button type="button" key={q} className="example" disabled={status === "working"} onClick={() => { setQuestion(q); run(q); }}>{q}</button>
          ))}
        </div>
      </form>

      <main className="work">
        <section className="answer-col" aria-live="polite">
          {status === "idle" && (
            <div className="intro">
              <h2>Every answer comes with its path</h2>
              <p>Lineage reads who wrote, reviewed and fixed what in this repository. Ask a question and an AI agent follows the graph to answer it. Code then checks every person, PR and number in the answer against what the agent actually found.</p>
              <p className="muted">On the right: the folders in <code>src</code> where one person wrote most of the merged pull requests.</p>
            </div>
          )}
          {status !== "idle" && (
            <>
              <h2 className="asked">{asked}</h2>
              {answer ? (
                <div className={`answer ${answer.checked ? "is-checked" : "is-unchecked"}`}>
                  <AnswerText text={answer.text} nodes={nodes} />
                  <p className="verdict">
                    {answer.checked
                      ? `Checked: every person, PR and number above came from the graph. ${steps.length} ${steps.length === 1 ? "step" : "steps"}, ${(answer.ms / 1000).toFixed(0)} s.`
                      : "Not checked: the answer did not match the evidence, so it is not shown."}
                  </p>
                </div>
              ) : status === "working" ? (
                <p className="working"><span className="pulse" aria-hidden="true" />{note || "Working"}</p>
              ) : null}
              {status === "error" && <p className="error">{note}</p>}

              {steps.length > 0 && (
                <ol className="steps">
                  {steps.map((s, i) => (
                    <li key={i} className="step">
                      <button type="button" className="step-head" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                        <span className="step-title">{describe(s)}</span>
                        <span className="step-meta">{s.nodes.length} nodes, {s.ms} ms</span>
                      </button>
                      {open === i && <pre className="step-body">{s.text}</pre>}
                    </li>
                  ))}
                </ol>
              )}
              {rejections.length > 0 && (
                <p className="rejected">The first draft was sent back: {rejections[0].join("; ")}.</p>
              )}
            </>
          )}
        </section>

        <section className="graph-col" aria-label="Graph">
          <div className="graph-frame">
            <Graph nodes={nodes} edges={edges} highlight={highlight} onSelect={setSelected} />
            <ul className="legend" aria-label="Legend">
              {[["person", "Person"], ["pr", "Pull request"], ["issue", "Issue"], ["module", "Folder or file"]].map(([k, l]) => (
                <li key={k}><span className={`swatch swatch-${k}`} style={{ background: KIND_COLOR[k] }} />{l}</li>
              ))}
            </ul>
            {overview && nodes.length > 0 && <p className="graph-caption">Who holds the knowledge in <code>src</code></p>}
            {selected && (
              <div className="selected">
                <strong>{selected.label}</strong>
                {selected.title && <span>{selected.title}</span>}
                {selected.url && <a href={selected.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="foot">
        Built for Graph Hacks with FalkorDB. Data is public GitHub history. <a href="https://github.com/Vipul-Ydv/lineage" target="_blank" rel="noreferrer">Source</a>
      </footer>
    </div>
  );
}
