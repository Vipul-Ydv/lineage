// The agent loop. Our own model (Qwen3-4B on llama.cpp, OpenAI-compatible API) decides
// which graph tools to call; the tools run Cypher on FalkorDB; the answer is checked
// against what the tools returned before anyone sees it. Every step is reported as an
// event, so the UI can show the agent working and draw the path it followed.
import type { Graph } from "falkordb";
import { TOOLS, type ToolName, type NodeRef, type EdgeRef } from "./tools.ts";
import { emptySeen, remember, problems } from "./validate.ts";

export type AgentEvent =
  | { type: "tool"; name: string; args: Record<string, unknown>; text: string; nodes: NodeRef[]; edges: EdgeRef[]; ms: number }
  | { type: "thinking"; turn: number }
  | { type: "rejected"; reasons: string[] }
  | { type: "answer"; text: string; checked: boolean; cited: string[]; ms: number }
  | { type: "error"; message: string };

const MAX_TURNS = 6;

const systemPrompt = (repo: string) => `You are Lineage, the company brain for the GitHub repository ${repo}. You answer questions about who knows what, why code changed, and how people, PRs, issues and code connect.
Rules:
1. Call tools to get evidence before answering. Use search first when the question names a topic instead of an exact path, PR or issue number.
2. Use ONLY facts from tool results. Never guess a person, PR, issue or number.
3. Write people as @login and PRs or issues as #number, exactly as they appear in tool results. Refer to people only by @login, never as he, she or they.
4. search only finds things. When it finds a matching issue or PR, open it with explain_issue or explain_pr; when it finds a module, use who_knows or change_history on it.
5. Answer in at most 120 words, plain text, no headings. Name the evidence (the PRs or issues) behind each claim.
6. If the tools do not answer the question, say what you found and what is missing.`;

const toolSpecs = Object.entries(TOOLS).map(([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: { type: "object", properties: t.params, required: t.required } },
}));

async function chat(body: unknown, timeoutMs = 120_000) {
  const base = process.env.AI_BASE_URL;
  if (!base) throw new Error("AI_BASE_URL is not set");
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_API_KEY ?? ""}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  return (await res.json()) as { choices: { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
}

export async function ask(g: Graph, repo: string, question: string, emit: (e: AgentEvent) => void) {
  const started = Date.now();
  const seen = emptySeen();
  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt(repo) },
    { role: "user", content: question },
  ];
  let retried = false;
  let nudged = false;
  const used = new Set<string>();
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      emit({ type: "thinking", turn });
      const data = await chat({
        model: process.env.AI_MODEL ?? "qwen3-4b",
        temperature: 0.1,
        max_tokens: 400,
        messages,
        tools: toolSpecs,
        tool_choice: "auto",
        chat_template_kwargs: { enable_thinking: false },
      });
      const msg = data.choices[0]?.message ?? {};
      const calls = msg.tool_calls ?? [];
      if (calls.length) {
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
        for (const c of calls) {
          const t0 = Date.now();
          const name = c.function.name as ToolName;
          used.add(name);
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* model sent bad JSON; tool sees no args */ }
          const tool = TOOLS[name];
          const result = tool
            ? await (tool.fn as (g: Graph, a: Record<string, unknown>) => ReturnType<typeof TOOLS.search.fn>)(g, args)
            : { text: `There is no tool called ${name}.`, nodes: [], edges: [] };
          remember(seen, result.text);
          emit({ type: "tool", name, args, ...result, ms: Date.now() - t0 });
          messages.push({ role: "tool", tool_call_id: c.id, content: result.text });
        }
        continue;
      }
      const answer = (msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!seen.refs.size && !seen.people.size && turn < MAX_TURNS - 1) {
        // Answered without looking anything up: send it back to the graph.
        messages.push({ role: "assistant", content: answer }, { role: "user", content: "Use the tools to find evidence in the graph first, then answer." });
        continue;
      }
      if (used.size === 1 && used.has("search") && !nudged) {
        // A search result is a lead, not an answer: make the agent follow it.
        nudged = true;
        messages.push({ role: "assistant", content: answer }, { role: "user", content: "You have only searched. Open the most relevant result with explain_issue, explain_pr, who_knows or change_history, then answer." });
        continue;
      }
      const wrong = problems(answer, seen);
      if (wrong.length && !retried) {
        retried = true;
        emit({ type: "rejected", reasons: wrong });
        messages.push({ role: "assistant", content: answer }, { role: "user", content: `Your answer is not supported by the tool results: ${wrong.join("; ")}. Rewrite it using only facts from the tool results.` });
        continue;
      }
      if (wrong.length) {
        // Second miss: never show claims the graph does not support.
        emit({ type: "answer", text: "I could not write an answer that matches the evidence exactly, so I am not giving one. The graph results the agent used are shown below.", checked: false, cited: [], ms: Date.now() - started });
        return;
      }
      const cited = [...new Set([...answer.matchAll(/#(\d+)|@([A-Za-z0-9][A-Za-z0-9-]*)/g)].map((m) => m[0]))];
      emit({ type: "answer", text: answer, checked: true, cited, ms: Date.now() - started });
      return;
    }
    emit({ type: "answer", text: "I ran out of steps before I could write a checked answer. The evidence the graph returned is shown below.", checked: false, cited: [], ms: Date.now() - started });
  } catch (e) {
    emit({ type: "error", message: (e as Error).message });
  }
}
