// The graph canvas. Everything the agent looked at is drawn; the path behind the answer
// is drawn in full ink and everything else steps back.
import { useEffect, useRef } from "react";
import cytoscape, { type Core } from "cytoscape";
import type { EdgeRef, NodeRef } from "./types";

export const KIND_COLOR: Record<string, string> = {
  person: "#2E7D6B",
  pr: "#4A4CC0",
  issue: "#B4741A",
  module: "#5E6E7E",
  file: "#7D8B98",
  label: "#8A6FB0",
};

interface Props {
  nodes: NodeRef[];
  edges: EdgeRef[];
  highlight: Set<string> | null;
  onSelect: (n: NodeRef | null) => void;
}

function displayLabel(n: NodeRef) {
  if (n.kind === "file" || n.kind === "module") {
    const parts = n.label.split("/");
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : n.label;
  }
  return n.label;
}

/** Frame the lit path if there is one, otherwise everything. */
function fitView(c: Core) {
  const lit = c.elements(".lit");
  c.stop(true, true);
  c.fit(lit.nonempty() ? lit : c.elements(), lit.nonempty() ? 60 : 36);
}

export function Graph({ nodes, edges, highlight, onSelect }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const byId = useRef(new Map<string, NodeRef>());

  useEffect(() => {
    if (!box.current) return;
    cy.current = cytoscape({
      container: box.current,
      minZoom: 0.3,
      maxZoom: 1.5,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(text)",
            color: "#1A2633",
            "font-family": "IBM Plex Mono, monospace",
            "font-size": 10,
            "text-valign": "bottom",
            "text-margin-y": 5,
            "text-background-color": "#EDF0F3",
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            width: "data(size)",
            height: "data(size)",
            "border-width": 0,
            "transition-property": "opacity, border-width",
            "transition-duration": 250,
          },
        },
        { selector: "node[kind = 'pr']", style: { shape: "round-rectangle" } },
        { selector: "node[kind = 'issue']", style: { shape: "diamond" } },
        { selector: "node[kind = 'module'], node[kind = 'file']", style: { shape: "round-tag" } },
        {
          selector: "edge",
          style: {
            width: 1.2,
            "line-color": "#AEB8C2",
            "target-arrow-color": "#AEB8C2",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.7,
            "curve-style": "bezier",
            label: "",
            "font-size": 8,
            "font-family": "IBM Plex Mono, monospace",
            color: "#5E6E7E",
            "text-rotation": "autorotate",
            "text-background-color": "#EDF0F3",
            "text-background-opacity": 1,
            "transition-property": "opacity, line-color, width",
            "transition-duration": 250,
          },
        },
        { selector: ".dim", style: { opacity: 0.18 } },
        { selector: "node.lit", style: { "border-width": 3, "border-color": "#1A2633", "font-weight": 600 } },
        { selector: "edge.lit", style: { width: 2.6, "line-color": "#1A2633", "target-arrow-color": "#1A2633", label: "data(type)" } },
        { selector: "node:selected", style: { "border-width": 4, "border-color": "#1A2633", "overlay-opacity": 0 } },
      ],
    });
    cy.current.on("tap", "node", (e) => onSelect(byId.current.get(e.target.id()) ?? null));
    cy.current.on("tap", (e) => { if (e.target === cy.current) onSelect(null); });
    // The canvas is sized by CSS after mount, and again on every window resize.
    const observer = new ResizeObserver(() => { if (!cy.current) return; cy.current.resize(); fitView(cy.current); });
    observer.observe(box.current);
    return () => { observer.disconnect(); cy.current?.destroy(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Add what is new; keep what is already placed so the picture grows instead of jumping.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    const wanted = new Set(nodes.map((n) => n.id));
    c.nodes().filter((n) => !wanted.has(n.id())).remove();
    const added: cytoscape.ElementDefinition[] = [];
    for (const n of nodes) {
      byId.current.set(n.id, n);
      if (c.getElementById(n.id).nonempty()) continue;
      // New nodes start scattered near the centre; the layout cannot separate nodes that share one point.
      added.push({ group: "nodes", position: { x: 300 + (Math.random() - 0.5) * 300, y: 250 + (Math.random() - 0.5) * 300 }, data: { id: n.id, kind: n.kind, text: displayLabel(n), color: KIND_COLOR[n.kind] ?? "#5E6E7E", size: n.kind === "person" ? 22 : n.kind === "module" ? 20 : 16 } });
    }
    for (const e of edges) {
      const id = `${e.from}>${e.type}>${e.to}`;
      if (c.getElementById(id).nonempty() || !wanted.has(e.from) || !wanted.has(e.to)) continue;
      added.push({ group: "edges", data: { id, source: e.from, target: e.to, type: e.type.toLowerCase() } });
    }
    c.edges().filter((e) => !wanted.has(e.source().id()) || !wanted.has(e.target().id())).remove();
    if (added.length) {
      c.add(added);
      c.resize();
      const layout = c.layout({ name: "cose", animate: false, fit: false, padding: 36, nodeRepulsion: () => 12000, idealEdgeLength: () => 80, randomize: false } as cytoscape.LayoutOptions);
      layout.one("layoutstop", () => fitView(c));
      layout.run();
    }
  }, [nodes, edges]);

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.elements().removeClass("dim lit");
    if (!highlight || !highlight.size) return;
    const litNodes = c.nodes().filter((n) => highlight.has(n.id()));
    const litEdges = c.edges().filter((e) => highlight.has(e.source().id()) && highlight.has(e.target().id()));
    c.elements().not(litNodes).not(litEdges).addClass("dim");
    litNodes.addClass("lit");
    litEdges.addClass("lit");
    fitView(c);
  }, [highlight, nodes]);

  return <div ref={box} className="graph-canvas" role="img" aria-label="Graph of the people, pull requests, issues and code the agent looked at" />;
}
