export type TraceStage = string & {};

export interface TraceEntry {
  ts: string;
  seq: number;
  stage?: TraceStage;
  runId?: string;
  parentRunId?: string | null;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  system?: unknown;
  prompt?: string;
  tools?: TraceToolDef[];
  toolCount?: number;
  messages?: TraceMessage[];
  messageCount?: number;
  note?: string;
  error?: string;
  traceVersion?: number;
  eventType?: string;
  agentRole?: AgentRole;
  agentId?: string;
  agentLabel?: string;
  agentSeq?: number;
  turnId?: string;
  turnStage?: string;
  isFinalForTurn?: boolean;
  parentAgentId?: string;
  parentToolCallId?: string;
  taskId?: string;
  taskDescription?: string;
  taskPromptPreview?: string;
  subagentType?: string;
  [key: string]: unknown;
}

export interface TraceToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TraceMessage {
  role?: string;
  name?: string;
  toolCallId?: string;
  content?: unknown;
  [key: string]: unknown;
}

export type AgentRole = "lead" | "sub" | "unknown";
export type GraphNodeType = "llm" | "tool" | "agent" | "error";
export type GraphEdgeType = "next" | "spawn" | "result";

export interface AgentLane {
  id: string;
  label: string;
  role: AgentRole;
  firstSeq: number;
  lastSeq: number;
  nodeCount: number;
}

export interface ToolCallSummary {
  id: string;
  name: string;
  description?: string;
  input?: unknown;
}

export interface TraceNode {
  id: string;
  type: GraphNodeType;
  agentId: string;
  agentLabel: string;
  agentSeq: number;
  seq: number;
  ts: string;
  stage?: string;
  label: string;
  subtitle?: string;
  runId?: string;
  parentRunId?: string | null;
  parentAgentId?: string;
  parentToolCallId?: string;
  taskId?: string;
  taskDescription?: string;
  taskPromptPreview?: string;
  subagentType?: string;
  turnId?: string;
  turnStage?: string;
  messageCount?: number;
  toolCount?: number;
  toolCalls?: ToolCallSummary[];
  preview?: string;
  isFinalForAgent?: boolean;
  inferred?: boolean;
}

export interface TraceEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  label?: string;
  inferred?: boolean;
}

export interface AgentTraceGraph {
  file: string;
  totalEntries: number;
  totalNodes: number;
  agents: AgentLane[];
  nodes: TraceNode[];
  edges: TraceEdge[];
}
