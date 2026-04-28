import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentLane,
  AgentRole,
  AgentTraceGraph,
  ToolCallSummary,
  TraceEdge,
  TraceEntry,
  TraceMessage,
  TraceNode,
} from "../shared/types.js";

function parseTraceLine(line: string): TraceEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as TraceEntry;
    return obj && typeof obj === "object" && typeof obj.seq === "number" ? obj : null;
  } catch {
    return null;
  }
}

export async function resolveTraceFile(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Path does not exist: ${resolved}`);
  if (stat.isFile()) return resolved;
  if (!stat.isDirectory()) throw new Error(`Invalid path: ${resolved}`);

  const files = await fs.readdir(resolved);
  const candidates = await Promise.all(
    files
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const file = path.join(resolved, name);
        const fileStat = await fs.stat(file);
        return { file, mtimeMs: fileStat.mtimeMs };
      }),
  );
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  if (!candidates.length) throw new Error(`No .jsonl files found in directory: ${resolved}`);
  return candidates[0].file;
}

export async function readTraceEntries(file: string): Promise<TraceEntry[]> {
  const content = await fs.readFile(file, "utf8").catch(() => "");
  return content
    .split("\n")
    .map(parseTraceLine)
    .filter((entry): entry is TraceEntry => entry !== null)
    .sort((a, b) => a.seq - b.seq);
}

function roleOf(agentId: string, explicit?: string): AgentRole {
  if (explicit === "lead" || explicit === "sub" || explicit === "unknown") return explicit;
  if (agentId.startsWith("lead")) return "lead";
  if (agentId.startsWith("sub")) return "sub";
  return "unknown";
}

function textPreview(value: unknown, max = 180): string | undefined {
  if (value == null) return undefined;
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const partText = record.text ?? record.thinking ?? record.content;
        if (typeof partText === "string") parts.push(partText);
      }
    }
    text = parts.join("\n");
  } else {
    text = JSON.stringify(value);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) + (text.length > max ? "…" : "") : undefined;
}

function extractToolCalls(message: TraceMessage | undefined): ToolCallSummary[] {
  const calls: ToolCallSummary[] = [];
  const content = message?.content;
  if (!Array.isArray(content)) return calls;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = record.type;
    if (type !== "tool_use" && type !== "toolCall") continue;
    const id = typeof record.id === "string" ? record.id : `tool:${calls.length + 1}`;
    const name = typeof record.name === "string" ? record.name : typeof record.toolName === "string" ? record.toolName : "tool";
    const input = record.input ?? record.arguments;
    const description =
      input && typeof input === "object" && "description" in input && typeof (input as { description?: unknown }).description === "string"
        ? (input as { description: string }).description
        : undefined;
    calls.push({ id, name, input, description });
  }
  return calls;
}

function lastAssistantMessage(entry: TraceEntry): TraceMessage | undefined {
  const messages = entry.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function hasTaskResult(entry: TraceEntry | undefined, toolCallId: string): boolean {
  return (entry?.messages ?? []).some((message) => message.role === "toolResult" && message.name === "task" && message.toolCallId === toolCallId);
}

function visibleEntries(entries: TraceEntry[]): TraceEntry[] {
  return entries.filter((entry) => {
    if (entry.turnStage) return entry.turnStage === "end" || entry.turnStage === "error";
    return entry.stage !== "prompt:before";
  });
}

function entryAgentId(entry: TraceEntry): string {
  return entry.agentId || entry.sessionKey || "unknown";
}

function entryAgentLabel(entry: TraceEntry): string {
  return entry.agentLabel || entry.sessionKey || entry.agentId || "unknown";
}

export function buildGraph(file: string, entries: TraceEntry[]): AgentTraceGraph {
  const visible = visibleEntries(entries);
  const entriesBySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  const agents = new Map<string, AgentLane>();
  const fallbackAgentSeq = new Map<string, number>();
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  const lastNodeByAgent = new Map<string, TraceNode>();
  const taskCallById = new Map<string, { sourceNode: TraceNode; call: ToolCallSummary }>();

  for (const entry of visible) {
    const agentId = entryAgentId(entry);
    const agentLabel = entryAgentLabel(entry);
    const role = roleOf(agentId, entry.agentRole);
    const nextFallbackSeq = (fallbackAgentSeq.get(agentId) ?? 0) + 1;
    fallbackAgentSeq.set(agentId, nextFallbackSeq);
    const currentAgentSeq = typeof entry.agentSeq === "number" ? entry.agentSeq : nextFallbackSeq;

    const lane = agents.get(agentId) ?? {
      id: agentId,
      label: agentLabel,
      role,
      firstSeq: entry.seq,
      lastSeq: entry.seq,
      nodeCount: 0,
    };
    lane.firstSeq = Math.min(lane.firstSeq, entry.seq);
    lane.lastSeq = Math.max(lane.lastSeq, entry.seq);
    lane.nodeCount += 1;
    lane.label = agentLabel;
    agents.set(agentId, lane);

    const assistant = lastAssistantMessage(entry);
    const toolCalls = extractToolCalls(assistant);
    const preview = textPreview(assistant?.content) ?? textPreview((entry.messages ?? []).at(-1)?.content);
    const isError = Boolean(entry.error) || entry.stage === "prompt:error" || entry.turnStage === "error";
    const node: TraceNode = {
      id: `entry:${entry.seq}`,
      type: isError ? "error" : "llm",
      agentId,
      agentLabel,
      agentSeq: currentAgentSeq,
      seq: entry.seq,
      ts: entry.ts,
      stage: entry.stage,
      label: `#${entry.seq}`,
      subtitle: entry.eventType || entry.stage,
      runId: entry.runId,
      parentRunId: entry.parentRunId ?? null,
      parentAgentId: entry.parentAgentId,
      parentToolCallId: entry.parentToolCallId,
      taskId: entry.taskId,
      taskDescription: entry.taskDescription,
      taskPromptPreview: entry.taskPromptPreview,
      subagentType: entry.subagentType,
      turnId: entry.turnId,
      turnStage: entry.turnStage,
      messageCount: entry.messageCount,
      toolCount: entry.toolCount,
      toolCalls,
      preview,
    };
    nodes.push(node);

    const previous = lastNodeByAgent.get(agentId);
    if (previous) {
      edges.push({ id: `next:${previous.id}:${node.id}`, source: previous.id, target: node.id, type: "next" });
    }
    lastNodeByAgent.set(agentId, node);

    for (const call of toolCalls) {
      if (call.name === "task") taskCallById.set(call.id, { sourceNode: node, call });
    }
  }

  for (const node of lastNodeByAgent.values()) node.isFinalForAgent = true;

  const subAgents = [...agents.values()].filter((agent) => agent.role === "sub");
  for (const subAgent of subAgents) {
    const firstSubNode = nodes
      .filter((node) => node.agentId === subAgent.id)
      .sort((a, b) => a.seq - b.seq)[0];
    if (!firstSubNode?.parentToolCallId) continue;
    const task = taskCallById.get(firstSubNode.parentToolCallId);
    if (task) {
      edges.push({
        id: `spawn:${firstSubNode.parentToolCallId}:${firstSubNode.id}`,
        source: task.sourceNode.id,
        target: firstSubNode.id,
        type: "spawn",
        label: firstSubNode.taskDescription || task.call.description || firstSubNode.subagentType || "task",
      });
    }
  }

  for (const subAgent of subAgents) {
    const subNodes = nodes.filter((node) => node.agentId === subAgent.id).sort((a, b) => a.seq - b.seq);
    const firstSubNode = subNodes[0];
    const lastSubNode = subNodes.at(-1);
    if (!firstSubNode || !lastSubNode) continue;
    const parentToolCallId = firstSubNode.parentToolCallId;
    if (!parentToolCallId) continue;
    const resultNode = nodes.find((node) => node.seq > lastSubNode.seq && hasTaskResult(entriesBySeq.get(node.seq), parentToolCallId));
    if (resultNode) {
      edges.push({
        id: `result:${lastSubNode.id}:${resultNode.id}`,
        source: lastSubNode.id,
        target: resultNode.id,
        type: "result",
        label: "result",
      });
    }
  }

  if (![...nodes].some((node) => node.parentToolCallId)) {
    const taskStarts = [...taskCallById.values()].sort((a, b) => a.sourceNode.seq - b.sourceNode.seq || a.call.id.localeCompare(b.call.id));
    const subAgentsByTime = [...agents.values()].filter((agent) => agent.role === "sub").sort((a, b) => a.firstSeq - b.firstSeq);
    for (let i = 0; i < Math.min(taskStarts.length, subAgentsByTime.length); i += 1) {
      const task = taskStarts[i];
      const subAgent = subAgentsByTime[i];
      const firstSubNode = nodes.find((node) => node.agentId === subAgent.id && node.seq === subAgent.firstSeq);
      const lastSubNode = nodes.find((node) => node.agentId === subAgent.id && node.seq === subAgent.lastSeq);
      const resultNode = nodes.find((node) => node.agentId === task.sourceNode.agentId && node.seq > task.sourceNode.seq && hasTaskResult(entriesBySeq.get(node.seq), task.call.id));
      if (firstSubNode) {
        firstSubNode.inferred = true;
        edges.push({ id: `spawn:${task.call.id}:${firstSubNode.id}`, source: task.sourceNode.id, target: firstSubNode.id, type: "spawn", label: task.call.description || "task", inferred: true });
      }
      if (lastSubNode && resultNode) {
        edges.push({ id: `result:${lastSubNode.id}:${resultNode.id}`, source: lastSubNode.id, target: resultNode.id, type: "result", label: "result", inferred: true });
      }
    }
  }

  return {
    file: path.basename(file),
    totalEntries: entries.length,
    totalNodes: nodes.length,
    agents: [...agents.values()].sort((a, b) => a.firstSeq - b.firstSeq),
    nodes,
    edges,
  };
}

export class TraceStore {
  private entriesCache: TraceEntry[] | null = null;
  private mtimeMs = 0;

  constructor(private readonly filePath: string) {}

  getFilePath(): string {
    return this.filePath;
  }

  invalidate(): void {
    this.entriesCache = null;
    this.mtimeMs = 0;
  }

  async getEntries(): Promise<TraceEntry[]> {
    const stat = await fs.stat(this.filePath).catch(() => null);
    const mtimeMs = stat?.mtimeMs ?? 0;
    if (this.entriesCache && this.mtimeMs === mtimeMs) return this.entriesCache;
    this.entriesCache = await readTraceEntries(this.filePath);
    this.mtimeMs = mtimeMs;
    return this.entriesCache;
  }

  async getGraph(): Promise<AgentTraceGraph> {
    return buildGraph(this.filePath, await this.getEntries());
  }

  async getEntry(seq: number): Promise<TraceEntry | null> {
    const entries = await this.getEntries();
    return entries.find((entry) => entry.seq === seq) ?? null;
  }
}
