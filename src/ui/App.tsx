import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import jsonLanguage from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdownLanguage from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { AgentTraceGraph, TraceEdge, TraceEntry, TraceMessage, TraceNode, TraceToolDef } from "../shared/types.js";

type DetailState = {
  node: TraceNode;
  entry?: TraceEntry;
  loading: boolean;
  error?: string;
};

SyntaxHighlighter.registerLanguage("json", jsonLanguage);
SyntaxHighlighter.registerLanguage("markdown", markdownLanguage);

const nodeTypes = { traceNode: TraceFlowNode };
const NODE_X_GAP = 285;
const NODE_Y_GAP = 220;
const NODE_X_START = 80;
const NODE_Y_START = 72;
const COLLAPSED_BLOCK_HEIGHT = 260;

function roleColor(agentId: string): string {
  if (agentId.startsWith("lead")) return "#3b82f6";
  if (agentId.startsWith("sub")) return "#10b981";
  return "#64748b";
}

function edgeStyle(edge: TraceEdge) {
  if (edge.type === "spawn") return { stroke: "#f59e0b", strokeWidth: 2.6, strokeDasharray: edge.inferred ? "8 5" : undefined };
  if (edge.type === "result") return { stroke: "#a855f7", strokeWidth: 2.2, strokeDasharray: edge.inferred ? "6 4" : undefined };
  return { stroke: "#94a3b8", strokeWidth: 1.4 };
}

function TraceFlowNode(props: NodeProps) {
  const data = props.data as unknown as TraceNode;
  const color = roleColor(data.agentId);
  const title = data.taskDescription || data.stage || data.type;
  return (
    <div className={`trace-node ${data.type} ${data.isFinalForAgent ? "final" : ""}`} style={{ borderColor: color }}>
      <div className="trace-node-top">
        <span className="trace-node-turn">turn {data.agentSeq}</span>
        <span className="trace-node-agent" style={{ background: color }}>{data.agentLabel}</span>
      </div>
      <div className="trace-node-raw">raw seq #{data.seq}{data.turnId ? ` · ${data.turnId}` : ""}</div>
      <div className="trace-node-title" title={title}>{title}</div>
      <div className="trace-node-meta">
        {typeof data.messageCount === "number" ? `${data.messageCount} msgs` : ""}
        {data.subagentType ? ` · ${data.subagentType}` : ""}
      </div>
      {data.parentToolCallId ? <div className="trace-node-parent">from {data.parentToolCallId}</div> : null}
      {data.toolCalls?.length ? <div className="trace-node-tools">{data.toolCalls.map((tool) => tool.name).join(", ")}</div> : null}
      {data.preview ? <div className="trace-node-preview">{data.preview}</div> : null}
      {data.isFinalForAgent ? <div className="trace-node-final">final snapshot</div> : null}
    </div>
  );
}

function computeLaneStarts(nodes: TraceNode[], edges: TraceEdge[]): Map<string, number> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const laneStart = new Map<string, number>();
  for (const node of nodes) laneStart.set(node.agentId, Math.min(laneStart.get(node.agentId) ?? 0, 0));

  const xIndexOf = (node: TraceNode) => (laneStart.get(node.agentId) ?? 0) + node.agentSeq - 1;
  const spawnEdges = edges.filter((edge) => edge.type === "spawn").sort((a, b) => {
    const aSource = nodeById.get(a.source)?.seq ?? 0;
    const bSource = nodeById.get(b.source)?.seq ?? 0;
    return aSource - bSource;
  });

  for (let i = 0; i < 4; i += 1) {
    let changed = false;
    for (const edge of spawnEdges) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) continue;
      const desiredStart = xIndexOf(source) + 1 - (target.agentSeq - 1);
      const currentStart = laneStart.get(target.agentId) ?? 0;
      if (desiredStart > currentStart) {
        laneStart.set(target.agentId, desiredStart);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return laneStart;
}

function makeFlow(graph: AgentTraceGraph, enabledAgents: Set<string>): { nodes: FlowNode[]; edges: Edge[] } {
  const laneIndex = new Map(graph.agents.map((agent, index) => [agent.id, index]));
  const visibleNodes = graph.nodes.filter((node) => enabledAgents.has(node.agentId));
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleTraceEdges = graph.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const laneStarts = computeLaneStarts(visibleNodes, visibleTraceEdges);

  const nodes: FlowNode[] = visibleNodes.map((node) => {
    const xIndex = (laneStarts.get(node.agentId) ?? 0) + node.agentSeq - 1;
    return {
      id: node.id,
      type: "traceNode",
      data: node as unknown as Record<string, unknown>,
      position: { x: NODE_X_START + xIndex * NODE_X_GAP, y: NODE_Y_START + (laneIndex.get(node.agentId) ?? 0) * NODE_Y_GAP },
    };
  });

  const edges: Edge[] = visibleTraceEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.type === "next" ? undefined : `${edge.label || edge.type}${edge.inferred ? " (inferred)" : ""}`,
    type: "smoothstep",
    animated: edge.type !== "next",
    style: edgeStyle(edge),
    labelStyle: { fill: "#475569", fontSize: 11, fontWeight: 600 },
    labelBgStyle: { fill: "#fff", fillOpacity: 0.9 },
  }));

  return { nodes, edges };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function downloadJson(entry: TraceEntry) {
  const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `trace-${entry.seq}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)#{1,6}\s+\S/.test(text)
    || /(^|\n)```/.test(text)
    || /(^|\n)\s*[-*+]\s+\S/.test(text)
    || /\[[^\]]+\]\([^)]+\)/.test(text)
    || /(^|\n)\|.+\|\s*\n\|[-:\s|]+\|/.test(text);
}

function detectLanguage(text: string, explicit?: string): string {
  if (explicit) return explicit;
  if (looksLikeJson(text)) return "json";
  if (looksLikeMarkdown(text)) return "markdown";
  return "text";
}

export function App() {
  const [graph, setGraph] = useState<AgentTraceGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enabledAgents, setEnabledAgents] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DetailState | null>(null);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextGraph = await fetchJson<AgentTraceGraph>("/api/graph");
      setGraph(nextGraph);
      setEnabledAgents(new Set(nextGraph.agents.map((agent) => agent.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadGraph(); }, [loadGraph]);

  const flow = useMemo(() => (graph ? makeFlow(graph, enabledAgents) : { nodes: [], edges: [] }), [graph, enabledAgents]);

  const handleNodeClick = useCallback(async (_event: unknown, node: FlowNode) => {
    const traceNode = node.data as unknown as TraceNode;
    setDetail({ node: traceNode, loading: true });
    try {
      const payload = await fetchJson<{ entry: TraceEntry }>(`/api/entry/${traceNode.seq}`);
      setDetail({ node: traceNode, entry: payload.entry, loading: false });
    } catch (err) {
      setDetail({ node: traceNode, loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Trace Lens</h1>
          <p>{graph ? graph.file : "Loading trace graph..."}</p>
        </div>
        <button className="button" onClick={() => void loadGraph()}>Refresh</button>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <main className="app-main">
        <aside className="sidebar">
          <div className="panel">
            <h2>Agents</h2>
            {loading ? <p className="muted">Loading...</p> : null}
            {graph?.agents.map((agent) => (
              <label key={agent.id} className="agent-toggle">
                <input
                  type="checkbox"
                  checked={enabledAgents.has(agent.id)}
                  onChange={(event) => {
                    const next = new Set(enabledAgents);
                    if (event.target.checked) next.add(agent.id);
                    else next.delete(agent.id);
                    setEnabledAgents(next);
                  }}
                />
                <span className={`agent-dot ${agent.role}`} />
                <span title={agent.id}>{agent.label}</span>
                <small>{agent.nodeCount} turns · final raw #{agent.lastSeq}</small>
              </label>
            ))}
          </div>

          <div className="panel compact">
            <h2>Legend</h2>
            <p><span className="legend-line next" /> same-agent order</p>
            <p><span className="legend-line spawn" /> task spawn</p>
            <p><span className="legend-line result" /> task result</p>
          </div>
        </aside>

        <section className="graph-wrap">
          <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} onNodeClick={handleNodeClick} fitView minZoom={0.2} maxZoom={1.8}>
            <Background />
            <Controls />
            <MiniMap pannable zoomable nodeColor={(node) => roleColor((node.data as unknown as TraceNode).agentId)} />
          </ReactFlow>
        </section>

        <DetailPanel detail={detail} onClose={() => setDetail(null)} />
      </main>
    </div>
  );
}

function DetailPanel({ detail, onClose }: { detail: DetailState | null; onClose: () => void }) {
  if (!detail) return null;
  const { node, entry, loading, error } = detail;
  const systemContent = typeof entry?.system === "string" ? entry.system : entry?.system != null ? JSON.stringify(entry.system, null, 2) : null;
  return (
    <div className="detail-overlay" onClick={onClose}>
      <aside className="detail-modal" onClick={(event) => event.stopPropagation()}>
        <div className="detail-header">
          <div>
            <div className="detail-title-row">
              <span className="seq-badge">turn {node.agentSeq}</span>
              <span className="raw-seq-badge">raw #{node.seq}</span>
              <span className="session-badge">{node.agentLabel}</span>
              <span className="stage-badge">{entry?.stage || node.stage}</span>
            </div>
            <p>{new Date(node.ts).toLocaleString()}</p>
          </div>
          <div className="detail-actions">
            {entry ? <button className="button small" onClick={() => downloadJson(entry)}>Download</button> : null}
            <button className="icon-button" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="detail-body">
          <section className="trace-meta-section">
            <Meta label="Turn" value={node.turnId || String(node.agentSeq)} />
            <Meta label="Raw Seq" value={`#${node.seq}`} />
            <Meta label="Agent" value={`${node.agentLabel} (${node.agentId})`} />
            <Meta label="Run ID" value={entry?.runId || node.runId} />
            <Meta label="Parent Run" value={entry?.parentRunId || node.parentRunId || undefined} />
            <Meta label="Parent Tool" value={entry?.parentToolCallId || node.parentToolCallId} />
            <Meta label="Provider" value={entry?.provider} />
            <Meta label="Model" value={entry?.modelId} />
            <Meta label="Task" value={entry?.taskDescription || node.taskDescription} full />
          </section>

          {loading ? <p className="muted">Loading entry...</p> : null}
          {error ? <div className="error-banner small">{error}</div> : null}

          {systemContent ? <FlatSection title="System Prompt"><CollapsiblePre text={systemContent} language={detectLanguage(systemContent)} /></FlatSection> : null}
          {entry?.prompt ? <FlatSection title="Prompt"><CollapsiblePre text={entry.prompt} language={detectLanguage(entry.prompt)} /></FlatSection> : null}
          {entry?.messages?.length ? (
            <FlatSection title={`Messages (${entry.messages.length})`}>
              <div className="messages-list">{entry.messages.map((message, index) => <MessageCard key={index} message={message} index={index} />)}</div>
            </FlatSection>
          ) : null}
          {entry?.tools?.length ? <FlatSection title={`Tools (${entry.tools.length})`}><ToolList tools={entry.tools} /></FlatSection> : null}
          {entry?.error ? <FlatSection title="Error"><CollapsibleBlock className="content-block error-block">{entry.error}</CollapsibleBlock></FlatSection> : null}
          {entry ? <details className="raw-details"><summary>Raw JSON</summary><CollapsiblePre text={JSON.stringify(entry, null, 2)} language="json" dark /></details> : null}
        </div>
      </aside>
    </div>
  );
}

function Meta({ label, value, full = false }: { label: string; value?: string | number | null; full?: boolean }) {
  if (value == null || value === "") return null;
  return <div className={`meta-item ${full ? "full" : ""}`}><span>{label}</span><code title={String(value)}>{String(value)}</code></div>;
}

function FlatSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flat-section"><h3>{title}</h3>{children}</section>;
}

function CollapsibleBlock({ children, className = "", defaultExpanded = false }: { children: ReactNode; className?: string; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [measuredHeight, setMeasuredHeight] = useState(COLLAPSED_BLOCK_HEIGHT);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      requestAnimationFrame(() => {
        const nextHeight = Math.max(COLLAPSED_BLOCK_HEIGHT, outer.scrollHeight + 8);
        setMeasuredHeight(nextHeight);
      });
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [children]);

  const canExpand = measuredHeight > COLLAPSED_BLOCK_HEIGHT + 12;
  const toggle = () => {
    if (canExpand) setExpanded((value) => !value);
  };
  return (
    <div className="collapsible-wrap">
      <div
        ref={outerRef}
        className={`collapsible-content ${expanded ? "expanded" : "collapsed"} ${canExpand ? "can-expand" : ""} ${className}`}
        style={{ maxHeight: expanded ? measuredHeight : COLLAPSED_BLOCK_HEIGHT }}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        title={canExpand ? (expanded ? "Double-click to collapse" : "Double-click to expand") : undefined}
        onDoubleClick={toggle}
        onKeyDown={(event) => {
          if (canExpand && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <div ref={innerRef} className="collapsible-inner">
          {children}
        </div>
      </div>
      {canExpand ? <div className="expand-hint">{expanded ? "Double-click content to collapse ↑" : "Double-click content to expand ↓"}</div> : null}
    </div>
  );
}

function CollapsiblePre({ text, dark = false, language }: { text: string; dark?: boolean; language?: string }) {
  const detectedLanguage = detectLanguage(text, language);
  return (
    <CollapsibleBlock className={`content-block highlighted-code ${dark ? "json-block" : ""}`}>
      <SyntaxHighlighter
        language={detectedLanguage}
        style={dark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          padding: 0,
          background: "transparent",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
          overflowX: "hidden",
        }}
        codeTagProps={{ style: { whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" } }}
        wrapLongLines
      >
        {text}
      </SyntaxHighlighter>
    </CollapsibleBlock>
  );
}

function CollapsibleText({ text, className = "" }: { text: string; className?: string }) {
  return <CollapsibleBlock className={`content-block plain-text-block ${className}`}><p>{text}</p></CollapsibleBlock>;
}

function MessageCard({ message, index }: { message: TraceMessage; index: number }) {
  const role = message.role || "unknown";
  return (
    <div className={`message-card role-${role}`}>
      <div className="message-header">
        <span className="message-index">[{index}]</span>
        <span className="message-role">{role}</span>
        {message.name ? <span className="message-name">{message.name}</span> : null}
        {message.toolCallId ? <code className="message-tool-id">{message.toolCallId}</code> : null}
      </div>
      <div className="message-body"><ContentView value={message.content} /></div>
    </div>
  );
}

function ContentView({ value }: { value: unknown }) {
  if (value == null) return <span className="muted">null</span>;
  if (typeof value === "string") return <TextBlock text={value} />;
  if (Array.isArray(value)) {
    return <div className="content-array">{value.map((item, index) => <div key={index} className="array-item"><span className="array-index">[{index}]</span><ContentView value={item} /></div>)}</div>;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = String(obj.type || "");
    if (type === "text") return <TextBlock text={String(obj.text || "")} label="[text]" />;
    if (type === "thinking") return <TextBlock text={String(obj.text || obj.thinking || "")} label="[thinking]" variant="thinking" />;
    if (type === "image" && typeof obj.data === "string") return <img className="content-image" src={`data:${obj.mimeType || "image/png"};base64,${obj.data}`} alt="trace" />;
    if (type === "tool_use" || type === "toolCall") {
      return (
        <div className="tool-call-block">
          <span className="content-type">[{type}: {String(obj.name || obj.toolName || "unknown")}]</span>
          <CollapsiblePre text={JSON.stringify(obj.input ?? obj.arguments ?? obj, null, 2)} language="json" />
        </div>
      );
    }
    return <CollapsiblePre text={JSON.stringify(obj, null, 2)} language="json" />;
  }
  return <span>{String(value)}</span>;
}

function TextBlock({ text, label, variant }: { text: string; label?: string; variant?: "thinking" }) {
  return (
    <CollapsibleBlock className={`content-block text-block highlighted-code ${variant || ""}`}>
      {label ? <span className="content-type">{label}</span> : null}
      <SyntaxHighlighter
        language={detectLanguage(text)}
        style={oneLight}
        customStyle={{ margin: 0, padding: 0, background: "transparent", fontSize: 12, lineHeight: 1.5 }}
        wrapLongLines
      >
        {text}
      </SyntaxHighlighter>
    </CollapsibleBlock>
  );
}

function ToolList({ tools }: { tools: TraceToolDef[] }) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="tools-section">
      <div className="tools-summary">
        <div className="tool-name-list" aria-label="Tool names">
          {tools.map((tool, index) => <code key={`${tool.name}-${index}`} className="tool-name-chip">{tool.name}</code>)}
        </div>
        <button className="button small tool-details-toggle" onClick={() => setShowDetails((value) => !value)}>
          {showDetails ? "Hide details" : "Show details"}
        </button>
      </div>
      {showDetails ? <div className="tools-list">{tools.map((tool, index) => <ToolItem key={`${tool.name}-${index}`} tool={tool} index={index} />)}</div> : null}
    </div>
  );
}

function ToolItem({ tool, index }: { tool: TraceToolDef; index: number }) {
  const properties = tool.parameters && typeof tool.parameters === "object" ? (tool.parameters.properties as Record<string, unknown> | undefined) : undefined;
  return (
    <div className="tool-def">
      <div className="tool-def-header"><span>#{index + 1}</span><code>{tool.name}</code></div>
      {tool.description ? <CollapsibleText text={tool.description} className="tool-description" /> : null}
      {properties ? <CollapsiblePre text={JSON.stringify(properties, null, 2)} language="json" /> : null}
    </div>
  );
}
