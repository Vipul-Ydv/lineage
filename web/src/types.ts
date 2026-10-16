export type Kind = "person" | "pr" | "issue" | "file" | "module" | "label";
export interface NodeRef { id: string; kind: Kind; label: string; url?: string; title?: string }
export interface EdgeRef { from: string; to: string; type: string }

export type AgentEvent =
  | { type: "queued"; ahead: number }
  | { type: "thinking"; turn: number }
  | { type: "tool"; name: string; args: Record<string, unknown>; text: string; nodes: NodeRef[]; edges: EdgeRef[]; ms: number }
  | { type: "rejected"; reasons: string[] }
  | { type: "answer"; text: string; checked: boolean; cited: string[]; ms: number }
  | { type: "error"; message: string };

export interface Meta {
  repo: string;
  syncedAt: string | null;
  counts: Record<string, number>;
  edges: number;
}
