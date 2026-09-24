import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRole, TraceEntry, TraceMessage } from "../../shared/types.js";
import { CompactWriter } from "../compact-format.js";
import type { NormalizedCall } from "./normalize.js";

export const HEADER_PREFIX = "x-trace-lens-";
export const HEADERS = {
  session: `${HEADER_PREFIX}session`,
  agent: `${HEADER_PREFIX}agent`,
  agentLabel: `${HEADER_PREFIX}agent-label`,
  parentAgent: `${HEADER_PREFIX}parent-agent`,
  parentToolCall: `${HEADER_PREFIX}parent-tool-call`,
} as const;

export interface CaptureMeta {
  endpoint: string;
  method: string;
  url: string;
  status: number;
  startedAt: Date;
  durationMs: number;
  /** Lower-cased `x-trace-lens-*` headers sent by the client. */
  hints: Record<string, string>;
}

interface ToolCallRef {
  id: string;
  name: string;
  input: unknown;
}

interface CallNode {
  seq: number;
  /** Signatures of the request's non-system messages. */
  sigs: string[];
  /** `sigs` plus the assistant response: what the next request of this conversation should start with. */
  expected: string[];
  /** Normalised leading text of the assistant response, used to spot auxiliary calls that quote it. */
  responseSnippet: string;
}

interface Thread {
  agentId: string;
  label: string;
  role: AgentRole;
  session: Session;
  explicit: boolean;
  systemSig: string;
  toolsSig: string;
  toolNames: string[];
  nodes: CallNode[];
  parentAgentId?: string;
  parentToolCallId?: string;
  taskDescription?: string;
  subagentType?: string;
  sideThreads: Map<string, Thread>;
}

interface PendingToolCall {
  thread: Thread;
  call: ToolCallRef;
  claimed: boolean;
}

interface Session {
  id: string;
  file: string;
  seq: number;
  lastActive: number;
  threads: Thread[];
  toolCalls: PendingToolCall[];
  counters: Record<"lead" | "sub" | "side", number>;
  writer: CompactWriter;
}

export interface CorrelatorOptions {
  dataDir: string;
  idleMs: number;
}

const MAX_NODES_PER_THREAD = 400;
const MAX_TOOL_CALLS_PER_SESSION = 500;
const MIN_TASK_TEXT = 12;
const MIN_QUOTE_TEXT = 20;

export class Correlator {
  private sessions: Session[] = [];
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CorrelatorOptions) {}

  async record(call: NormalizedCall, meta: CaptureMeta): Promise<TraceEntry> {
    const now = meta.startedAt.getTime();
    this.expire(now);

    const nonSystem = call.messages.filter((message) => message.role !== "system");
    const sigs = nonSystem.map(messageSig);
    const systemSig = hash(call.messages.filter((m) => m.role === "system").map((m) => contentText(m.content)).join("\n"));
    const toolNames = call.tools.map((tool) => tool.name).sort();
    const toolsSig = hash(toolNames.join(","));
    const identity = { systemSig, toolsSig, toolNames };

    const placement = this.place(nonSystem, sigs, identity, meta, now);
    const { thread } = placement;
    const session = thread.session;
    session.lastActive = now;
    session.seq += 1;
    const seq = session.seq;

    const previousToolNames = thread.nodes.length ? thread.toolNames : undefined;
    const toolsChanged = previousToolNames ? diffNames(previousToolNames, toolNames) : undefined;
    const systemChanged = thread.nodes.length > 0 && thread.systemSig !== systemSig;
    thread.toolNames = toolNames;
    thread.toolsSig = toolsSig;
    thread.systemSig = systemSig;

    const responseSig = call.response ? messageSig(call.response) : null;
    const responseText = call.response ? quoteText(contentText(call.response.content)) : "";
    thread.nodes.push({
      seq,
      sigs,
      expected: responseSig ? [...sigs, responseSig] : sigs,
      responseSnippet: responseText.length >= MIN_QUOTE_TEXT ? responseText.slice(0, 60) : "",
    });
    if (thread.nodes.length > MAX_NODES_PER_THREAD) thread.nodes.shift();

    for (const toolCall of extractToolCalls(call.response)) {
      session.toolCalls.push({ thread, call: toolCall, claimed: false });
    }
    if (session.toolCalls.length > MAX_TOOL_CALLS_PER_SESSION) session.toolCalls.splice(0, session.toolCalls.length - MAX_TOOL_CALLS_PER_SESSION);

    const agentSeq = thread.nodes.length;
    const messages: TraceMessage[] = call.response ? [...call.messages, call.response] : [...call.messages];
    const entry: TraceEntry = {
      ts: meta.startedAt.toISOString(),
      seq,
      stage: "stream:context",
      traceVersion: 2,
      eventType: call.error ? "llm.error" : "llm.ended",
      sessionId: session.id,
      sessionKey: thread.label,
      provider: meta.endpoint,
      modelId: call.model,
      messages,
      messageCount: messages.length,
      tools: call.tools,
      toolCount: call.tools.length,
      agentId: thread.agentId,
      agentLabel: thread.label,
      agentRole: thread.role,
      agentSeq,
      turnId: `${thread.agentId}:${String(agentSeq).padStart(4, "0")}`,
      turnStage: call.error ? "error" : "end",
      isFinalForTurn: true,
      parentAgentId: thread.parentAgentId,
      parentToolCallId: thread.parentToolCallId,
      taskDescription: thread.taskDescription,
      subagentType: thread.subagentType,
      error: call.error,
      capture: {
        endpoint: meta.endpoint,
        method: meta.method,
        url: meta.url,
        status: meta.status,
        format: call.format,
        stream: call.stream,
        durationMs: meta.durationMs,
        usage: call.usage,
        stopReason: call.stopReason,
        correlation: placement.how,
        ...(placement.retryOf ? { retryOf: placement.retryOf } : {}),
        ...(placement.branchFrom ? { branchFrom: placement.branchFrom } : {}),
      },
      ...(toolsChanged ? { toolsChanged } : {}),
      ...(systemChanged ? { systemChanged: true } : {}),
    };

    await this.append(session.file, session.writer.encode(entry));
    return entry;
  }

  private place(
    nonSystem: TraceMessage[],
    sigs: string[],
    identity: { systemSig: string; toolsSig: string; toolNames: string[] },
    meta: CaptureMeta,
    now: number,
  ): { thread: Thread; how: string; retryOf?: number; branchFrom?: number } {
    const hints = meta.hints;
    const hintedSession = hints[HEADERS.session] ? this.sessionByKey(hints[HEADERS.session], meta, now) : undefined;

    const explicitAgent = hints[HEADERS.agent];
    if (explicitAgent) {
      const pool = hintedSession ? [hintedSession] : this.sessions;
      const existing = pool.flatMap((s) => s.threads).find((t) => t.explicit && t.agentId === explicitAgent);
      if (existing) return { thread: existing, how: "header" };
      const parentAgentId = hints[HEADERS.parentAgent];
      const parent = parentAgentId ? pool.flatMap((s) => s.threads).find((t) => t.agentId === parentAgentId) : undefined;
      const session = hintedSession ?? parent?.session ?? this.newSession(meta, now);
      const thread = this.newThread(session, parent || parentAgentId ? "sub" : "lead", identity, {
        agentId: explicitAgent,
        label: hints[HEADERS.agentLabel] || explicitAgent,
        explicit: true,
        parentAgentId,
        parentToolCallId: hints[HEADERS.parentToolCall],
      });
      if (thread.parentToolCallId && parent) {
        const pending = session.toolCalls.find((p) => p.call.id === thread.parentToolCallId);
        if (pending) Object.assign(thread, taskInfo(pending.call));
      }
      return { thread, how: "header" };
    }

    const pool = hintedSession ? [hintedSession] : this.sessions;

    // 1. Continue an existing conversation whose history is a prefix of this request.
    let best: { thread: Thread; node: CallNode; score: number; exact: boolean } | null = null;
    for (const session of pool) {
      for (const thread of session.threads) {
        if (thread.explicit) continue;
        for (let i = thread.nodes.length - 1; i >= 0; i -= 1) {
          const node = thread.nodes[i];
          let score = 0;
          let exact = false;
          if (node.expected.length > node.sigs.length && isPrefix(node.expected, sigs)) {
            score = node.expected.length * 2 + 1;
          } else if (node.sigs.length && isPrefix(node.sigs, sigs)) {
            score = node.sigs.length * 2;
            exact = node.sigs.length === sigs.length;
          }
          if (score > 0 && (!best || score > best.score || (score === best.score && node.seq > best.node.seq && thread.session === best.thread.session))) {
            best = { thread, node, score, exact };
          }
        }
      }
    }
    if (best) {
      const main = best.thread;
      const sameIdentity = main.systemSig === identity.systemSig || main.toolsSig === identity.toolsSig;
      const target = sameIdentity || main.role === "unknown" ? main : this.sideThread(main, identity);
      const isLast = target === main && main.nodes.at(-1) === best.node;
      return {
        thread: target,
        how: target === main ? "prefix" : "prefix-side",
        ...(best.exact ? { retryOf: best.node.seq } : {}),
        ...(target === main && !isLast && !best.exact ? { branchFrom: best.node.seq } : {}),
      };
    }

    // 2. A new conversation whose opening message comes from a recent tool call -> sub-agent.
    const firstUser = nonSystem.find((m) => m.role === "user");
    const opening = firstUser ? normText(contentText(firstUser.content)) : "";
    const spawn = opening ? this.findSpawningCall(pool, opening) : null;
    if (spawn) {
      spawn.claimed = true;
      const thread = this.newThread(spawn.thread.session, "sub", identity, {
        parentAgentId: spawn.thread.agentId,
        parentToolCallId: spawn.call.id,
        ...taskInfo(spawn.call),
      });
      return { thread, how: "spawn-text" };
    }

    // 3. An auxiliary call (title, suggestions, summary...) that quotes a recent reply -> side lane of that agent.
    const quoted = this.findQuotedThread(pool, nonSystem);
    if (quoted) return { thread: this.sideThread(quoted, identity), how: "quote-side" };

    // 4. Otherwise this is a new top-level conversation.
    const session = hintedSession ?? this.newSession(meta, now);
    return { thread: this.newThread(session, "lead", identity), how: "new" };
  }

  private findSpawningCall(pool: Session[], opening: string): PendingToolCall | null {
    let best: { pending: PendingToolCall; score: number } | null = null;
    for (const session of pool) {
      for (let i = session.toolCalls.length - 1; i >= 0; i -= 1) {
        const pending = session.toolCalls[i];
        let matched = 0;
        for (const leaf of stringLeaves(pending.call.input)) {
          const text = normText(leaf);
          if (text.length < MIN_TASK_TEXT) continue;
          if (opening.includes(text) || (opening.length >= MIN_TASK_TEXT && text.includes(opening))) {
            matched = Math.max(matched, Math.min(text.length, opening.length));
          }
        }
        if (!matched) continue;
        const score = matched + (pending.claimed ? 0 : 1_000_000);
        if (!best || score > best.score) best = { pending, score };
      }
    }
    return best?.pending ?? null;
  }

  private findQuotedThread(pool: Session[], nonSystem: TraceMessage[]): Thread | null {
    const text = quoteText(nonSystem.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n"));
    if (text.length < MIN_QUOTE_TEXT) return null;
    let best: { thread: Thread; seq: number; lastActive: number } | null = null;
    for (const session of pool) {
      for (const thread of session.threads) {
        if (thread.role === "unknown") continue;
        const node = [...thread.nodes].reverse().find((n) => n.responseSnippet && text.includes(n.responseSnippet));
        if (node && (!best || session.lastActive > best.lastActive || (session.lastActive === best.lastActive && node.seq > best.seq))) {
          best = { thread, seq: node.seq, lastActive: session.lastActive };
        }
      }
    }
    return best?.thread ?? null;
  }

  private sideThread(main: Thread, identity: { systemSig: string; toolsSig: string; toolNames: string[] }): Thread {
    const key = `${identity.systemSig}:${identity.toolsSig}`;
    const existing = main.sideThreads.get(key);
    if (existing) return existing;
    const thread = this.newThread(main.session, "unknown", identity, { parentAgentId: main.agentId });
    main.sideThreads.set(key, thread);
    return thread;
  }

  private newThread(
    session: Session,
    role: AgentRole,
    identity: { systemSig: string; toolsSig: string; toolNames: string[] },
    extra: Partial<Pick<Thread, "agentId" | "label" | "explicit" | "parentAgentId" | "parentToolCallId" | "taskDescription" | "subagentType">> = {},
  ): Thread {
    const kind = role === "lead" ? "lead" : role === "sub" ? "sub" : "side";
    session.counters[kind] += 1;
    const n = session.counters[kind];
    const agentId = extra.agentId ?? (kind === "lead" && n === 1 ? "lead" : `${kind}-${n}`);
    const label = extra.label ?? (kind === "sub" && extra.subagentType ? `${agentId} (${extra.subagentType})` : agentId);
    const thread: Thread = {
      agentId,
      label,
      role,
      session,
      explicit: extra.explicit ?? false,
      systemSig: identity.systemSig,
      toolsSig: identity.toolsSig,
      toolNames: identity.toolNames,
      nodes: [],
      parentAgentId: extra.parentAgentId,
      parentToolCallId: extra.parentToolCallId,
      taskDescription: extra.taskDescription,
      subagentType: extra.subagentType,
      sideThreads: new Map(),
    };
    session.threads.push(thread);
    return thread;
  }

  private sessionByKey(key: string, meta: CaptureMeta, now: number): Session {
    const id = sanitize(key);
    return this.sessions.find((s) => s.id === id) ?? this.newSession(meta, now, id);
  }

  private newSession(meta: CaptureMeta, now: number, key?: string): Session {
    const stamp = formatStamp(new Date(now));
    const id = key ?? `${stamp}-${sanitize(meta.endpoint)}-${crypto.randomBytes(3).toString("hex")}`;
    const fileName = key ? `${stamp}-${id}.jsonl` : `${id}.jsonl`;
    const session: Session = {
      id,
      file: path.join(this.options.dataDir, fileName),
      seq: 0,
      lastActive: now,
      threads: [],
      toolCalls: [],
      counters: { lead: 0, sub: 0, side: 0 },
      writer: new CompactWriter(),
    };
    this.sessions.push(session);
    return session;
  }

  private expire(now: number): void {
    this.sessions = this.sessions.filter((session) => now - session.lastActive <= this.options.idleMs);
  }

  private append(file: string, line: string): Promise<void> {
    const next = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line, "utf8");
    });
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

// ---------- signatures ----------

function hash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function normText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Whitespace- and markdown-insensitive form for "does this prompt quote that reply" checks. */
function quoteText(text: string): string {
  return normText(text.replace(/[*_#`>|~\-[\]()]+/g, " "));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
      return "";
    })
    .join("\n");
}

/**
 * A stable fingerprint of a message that survives client re-serialisation:
 * cache markers, thinking blocks and whitespace are ignored; tool calls are identified by id.
 */
function messageSig(message: TraceMessage): string {
  const role = message.role ?? "";
  if (role === "toolResult") return `toolResult:${message.toolCallId ?? hash(contentText(message.content))}`;
  const pieces: string[] = [];
  const content = message.content;
  if (typeof content === "string") {
    pieces.push(normText(content));
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        pieces.push(normText(part));
        continue;
      }
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type === "thinking" || record.type === "redacted_thinking" || record.type === "reasoning") continue;
      if (record.type === "tool_use" || record.type === "toolCall") {
        pieces.push(`tool:${String(record.id ?? "")}:${String(record.name ?? "")}`);
      } else if (typeof record.text === "string") {
        pieces.push(normText(record.text));
      } else if (typeof record.type === "string") {
        pieces.push(`[${record.type}]`);
      }
    }
  }
  const joined = pieces.filter(Boolean).join("\u0001");
  return `${role}:${hash(joined)}`;
}

function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (prefix[i] !== full[i]) return false;
  return true;
}

function extractToolCalls(message: TraceMessage | undefined): ToolCallRef[] {
  if (!message || !Array.isArray(message.content)) return [];
  const calls: ToolCallRef[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if ((record.type === "tool_use" || record.type === "toolCall") && typeof record.id === "string") {
      calls.push({ id: record.id, name: typeof record.name === "string" ? record.name : "tool", input: record.input ?? record.arguments });
    }
  }
  return calls;
}

function stringLeaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringLeaves(item, out, depth + 1);
  return out;
}

function taskInfo(call: ToolCallRef): { taskDescription?: string; subagentType?: string } {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const pick = (...keys: string[]) => {
    for (const key of keys) if (typeof input[key] === "string" && input[key]) return input[key] as string;
    return undefined;
  };
  return {
    taskDescription: pick("description", "title", "task", "name"),
    subagentType: pick("subagent_type", "subagentType", "agent_type", "agent") ?? call.name,
  };
}

function diffNames(before: string[], after: string[]): { added: string[]; removed: string[] } | undefined {
  const a = new Set(before);
  const b = new Set(after);
  const added = after.filter((name) => !a.has(name));
  const removed = before.filter((name) => !b.has(name));
  return added.length || removed.length ? { added, removed } : undefined;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "session";
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
