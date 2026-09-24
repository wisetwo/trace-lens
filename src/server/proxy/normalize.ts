import type { TraceMessage, TraceToolDef } from "../../shared/types.js";

export type WireFormat = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface NormalizedCall {
  format: WireFormat;
  model?: string;
  stream: boolean;
  /** Request messages, with system/instructions folded in as leading `system` messages. */
  messages: TraceMessage[];
  tools: TraceToolDef[];
  /** Assistant message assembled from the (possibly streamed) response. */
  response?: TraceMessage;
  usage?: Record<string, unknown>;
  stopReason?: string;
  error?: string;
}

type Json = Record<string, unknown>;

export function detectFormat(pathname: string): WireFormat | null {
  const clean = pathname.replace(/\/+$/, "");
  if (clean.endsWith("/chat/completions")) return "openai-chat";
  if (clean.endsWith("/responses")) return "openai-responses";
  if (clean.endsWith("/messages")) return "anthropic-messages";
  return null;
}

export function normalizeCall(format: WireFormat, requestBody: unknown, status: number, responseText: string): NormalizedCall {
  const req = isObject(requestBody) ? requestBody : {};
  const base: NormalizedCall = {
    format,
    model: typeof req.model === "string" ? req.model : undefined,
    stream: req.stream === true,
    messages: [],
    tools: [],
  };

  if (format === "openai-chat") {
    base.messages = normalizeChatMessages(req.messages);
    base.tools = normalizeTools(req.tools);
  } else if (format === "openai-responses") {
    base.messages = normalizeResponsesInput(req.instructions, req.input);
    base.tools = normalizeTools(req.tools);
  } else {
    base.messages = normalizeAnthropicMessages(req.system, req.messages);
    base.tools = normalizeTools(req.tools);
  }

  if (status >= 400) {
    base.error = `HTTP ${status}: ${responseText.slice(0, 4000)}`;
    return base;
  }

  const isSse = looksLikeSse(responseText);
  try {
    const parsed = format === "openai-chat"
      ? (isSse ? assembleChatStream(responseText) : parseChatResponse(JSON.parse(responseText)))
      : format === "openai-responses"
        ? (isSse ? assembleResponsesStream(responseText) : parseResponsesResponse(JSON.parse(responseText)))
        : (isSse ? assembleAnthropicStream(responseText) : parseAnthropicResponse(JSON.parse(responseText)));
    Object.assign(base, parsed);
    if (isSse) base.stream = true;
  } catch (error) {
    base.error = `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`;
  }
  return base;
}

// ---------- shared helpers ----------

function isObject(value: unknown): value is Json {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeTools(tools: unknown): TraceToolDef[] {
  if (!Array.isArray(tools)) return [];
  const out: TraceToolDef[] = [];
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    const fn = isObject(tool.function) ? tool.function : tool;
    const name = typeof fn.name === "string" ? fn.name : typeof tool.type === "string" ? tool.type : "tool";
    const def: TraceToolDef = { name };
    if (typeof fn.description === "string") def.description = fn.description;
    const parameters = fn.parameters ?? fn.input_schema;
    if (isObject(parameters)) def.parameters = parameters;
    if (typeof tool.type === "string" && tool.type !== "function") def.type = tool.type;
    out.push(def);
  }
  return out;
}

function toolUsePart(id: string, name: string, input: unknown): Json {
  return { type: "tool_use", id, name, input: parseMaybeJson(input) };
}

/** Assign tool names to toolResult messages by looking up the matching tool_use id. */
function fillToolResultNames(messages: TraceMessage[]): TraceMessage[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isObject(part) && part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
          names.set(part.id, part.name);
        }
      }
    }
    if (message.role === "toolResult" && !message.name && message.toolCallId) {
      const name = names.get(message.toolCallId);
      if (name) message.name = name;
    }
  }
  return messages;
}

// ---------- OpenAI Chat Completions ----------

function normalizeChatMessages(messages: unknown): TraceMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: TraceMessage[] = [];
  for (const raw of messages) {
    if (!isObject(raw)) continue;
    const role = typeof raw.role === "string" ? raw.role : "user";
    if (role === "system" || role === "developer") {
      out.push({ role: "system", content: raw.content });
    } else if (role === "tool") {
      out.push({
        role: "toolResult",
        toolCallId: typeof raw.tool_call_id === "string" ? raw.tool_call_id : undefined,
        name: typeof raw.name === "string" ? raw.name : undefined,
        content: raw.content,
      });
    } else if (role === "assistant") {
      out.push(chatAssistantMessage(raw));
    } else {
      out.push({ role, content: raw.content });
    }
  }
  return fillToolResultNames(out);
}

function chatAssistantMessage(raw: Json): TraceMessage {
  const parts: Json[] = [];
  const reasoning = raw.reasoning_content ?? raw.reasoning;
  if (typeof reasoning === "string" && reasoning) parts.push({ type: "thinking", thinking: reasoning });
  if (typeof raw.content === "string") {
    if (raw.content) parts.push({ type: "text", text: raw.content });
  } else if (Array.isArray(raw.content)) {
    parts.push(...raw.content.filter(isObject));
  }
  if (Array.isArray(raw.tool_calls)) {
    for (const call of raw.tool_calls) {
      if (!isObject(call)) continue;
      const fn = isObject(call.function) ? call.function : {};
      parts.push(toolUsePart(String(call.id ?? ""), String(fn.name ?? "tool"), fn.arguments));
    }
  }
  return { role: "assistant", content: parts };
}

function parseChatResponse(body: unknown): Partial<NormalizedCall> {
  const res = isObject(body) ? body : {};
  const choice = Array.isArray(res.choices) && isObject(res.choices[0]) ? res.choices[0] : {};
  const message = isObject(choice.message) ? choice.message : {};
  return {
    model: typeof res.model === "string" ? res.model : undefined,
    response: chatAssistantMessage(message),
    usage: isObject(res.usage) ? res.usage : undefined,
    stopReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

function assembleChatStream(text: string): Partial<NormalizedCall> {
  let content = "";
  let reasoning = "";
  let model: string | undefined;
  let usage: Json | undefined;
  let stopReason: string | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for (const event of parseSse(text)) {
    if (event.data === "[DONE]") continue;
    const chunk = parseMaybeJson(event.data);
    if (!isObject(chunk)) continue;
    if (typeof chunk.model === "string") model = chunk.model;
    if (isObject(chunk.usage)) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : null;
    if (!choice) continue;
    if (typeof choice.finish_reason === "string") stopReason = choice.finish_reason;
    const delta = isObject(choice.delta) ? choice.delta : {};
    if (typeof delta.content === "string") content += delta.content;
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === "string") reasoning += r;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!isObject(tc)) continue;
        const index = typeof tc.index === "number" ? tc.index : calls.size;
        const current = calls.get(index) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string") current.id = tc.id;
        const fn = isObject(tc.function) ? tc.function : {};
        if (typeof fn.name === "string") current.name += fn.name;
        if (typeof fn.arguments === "string") current.args += fn.arguments;
        calls.set(index, current);
      }
    }
  }

  const parts: Json[] = [];
  if (reasoning) parts.push({ type: "thinking", thinking: reasoning });
  if (content) parts.push({ type: "text", text: content });
  for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(toolUsePart(call.id, call.name || "tool", call.args));
  }
  return { model, usage, stopReason, response: { role: "assistant", content: parts } };
}

// ---------- OpenAI Responses ----------

function responsesContentToParts(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isObject(part)) return part;
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    return part;
  });
}

function responsesItemsToMessages(items: unknown[], out: TraceMessage[]): void {
  let pendingAssistant: Json[] | null = null;
  const flush = () => {
    if (pendingAssistant?.length) out.push({ role: "assistant", content: pendingAssistant });
    pendingAssistant = null;
  };
  const assistantParts = () => (pendingAssistant ??= []);

  for (const item of items) {
    if (!isObject(item)) continue;
    const type = typeof item.type === "string" ? item.type : "message";
    if (type === "message") {
      const role = typeof item.role === "string" ? item.role : "user";
      if (role === "assistant") {
        const content = responsesContentToParts(item.content);
        if (Array.isArray(content)) assistantParts().push(...content.filter(isObject));
        else if (typeof content === "string") assistantParts().push({ type: "text", text: content });
        continue;
      }
      flush();
      out.push({ role: role === "developer" ? "system" : role, content: responsesContentToParts(item.content) });
    } else if (type === "function_call") {
      assistantParts().push(toolUsePart(String(item.call_id ?? item.id ?? ""), String(item.name ?? "tool"), item.arguments));
    } else if (type === "reasoning") {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s) => (isObject(s) && typeof s.text === "string" ? s.text : "")).join("\n")
        : "";
      if (summary) assistantParts().push({ type: "thinking", thinking: summary });
    } else if (type === "function_call_output") {
      flush();
      out.push({ role: "toolResult", toolCallId: String(item.call_id ?? ""), content: item.output });
    } else {
      assistantParts().push(item);
    }
  }
  flush();
}

function normalizeResponsesInput(instructions: unknown, input: unknown): TraceMessage[] {
  const out: TraceMessage[] = [];
  if (typeof instructions === "string" && instructions) out.push({ role: "system", content: instructions });
  if (typeof input === "string") out.push({ role: "user", content: input });
  else if (Array.isArray(input)) responsesItemsToMessages(input, out);
  return fillToolResultNames(out);
}

function parseResponsesResponse(body: unknown): Partial<NormalizedCall> {
  const res = isObject(body) ? body : {};
  const messages: TraceMessage[] = [];
  responsesItemsToMessages(Array.isArray(res.output) ? res.output : [], messages);
  const parts = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  return {
    model: typeof res.model === "string" ? res.model : undefined,
    usage: isObject(res.usage) ? res.usage : undefined,
    stopReason: typeof res.status === "string" ? res.status : undefined,
    response: { role: "assistant", content: parts },
    error: isObject(res.error) ? JSON.stringify(res.error) : undefined,
  };
}

function assembleResponsesStream(text: string): Partial<NormalizedCall> {
  let text_ = "";
  for (const event of parseSse(text)) {
    const data = parseMaybeJson(event.data);
    if (!isObject(data)) continue;
    const type = data.type ?? event.event;
    if ((type === "response.completed" || type === "response.incomplete" || type === "response.failed") && isObject(data.response)) {
      return parseResponsesResponse(data.response);
    }
    if (type === "response.output_text.delta" && typeof data.delta === "string") text_ += data.delta;
  }
  return { response: { role: "assistant", content: text_ ? [{ type: "text", text: text_ }] : [] } };
}

// ---------- Anthropic Messages ----------

function normalizeAnthropicMessages(system: unknown, messages: unknown): TraceMessage[] {
  const out: TraceMessage[] = [];
  if (typeof system === "string" ? system : Array.isArray(system) && system.length) {
    out.push({ role: "system", content: system });
  }
  if (!Array.isArray(messages)) return out;
  for (const raw of messages) {
    if (!isObject(raw)) continue;
    const role = typeof raw.role === "string" ? raw.role : "user";
    if (role === "user" && Array.isArray(raw.content)) {
      const rest: unknown[] = [];
      for (const part of raw.content) {
        if (isObject(part) && part.type === "tool_result") {
          if (rest.length) out.push({ role: "user", content: rest.splice(0) });
          out.push({
            role: "toolResult",
            toolCallId: typeof part.tool_use_id === "string" ? part.tool_use_id : undefined,
            content: part.content,
            ...(part.is_error === true ? { isError: true } : {}),
          });
        } else {
          rest.push(part);
        }
      }
      if (rest.length) out.push({ role: "user", content: rest });
    } else {
      out.push({ role, content: raw.content });
    }
  }
  return fillToolResultNames(out);
}

function parseAnthropicResponse(body: unknown): Partial<NormalizedCall> {
  const res = isObject(body) ? body : {};
  return {
    model: typeof res.model === "string" ? res.model : undefined,
    usage: isObject(res.usage) ? res.usage : undefined,
    stopReason: typeof res.stop_reason === "string" ? res.stop_reason : undefined,
    response: { role: "assistant", content: Array.isArray(res.content) ? res.content : [] },
  };
}

function assembleAnthropicStream(text: string): Partial<NormalizedCall> {
  let model: string | undefined;
  let usage: Json = {};
  let stopReason: string | undefined;
  let error: string | undefined;
  const blocks: Json[] = [];
  const partialJson = new Map<number, string>();

  for (const event of parseSse(text)) {
    const data = parseMaybeJson(event.data);
    if (!isObject(data)) continue;
    const type = data.type ?? event.event;
    if (type === "message_start" && isObject(data.message)) {
      if (typeof data.message.model === "string") model = data.message.model;
      if (isObject(data.message.usage)) usage = { ...usage, ...data.message.usage };
    } else if (type === "content_block_start" && typeof data.index === "number" && isObject(data.content_block)) {
      blocks[data.index] = { ...data.content_block };
    } else if (type === "content_block_delta" && typeof data.index === "number" && isObject(data.delta)) {
      const block = (blocks[data.index] ??= { type: "text", text: "" });
      const delta = data.delta;
      if (delta.type === "text_delta") block.text = String(block.text ?? "") + String(delta.text ?? "");
      else if (delta.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + String(delta.thinking ?? "");
      else if (delta.type === "signature_delta") block.signature = String(block.signature ?? "") + String(delta.signature ?? "");
      else if (delta.type === "input_json_delta") partialJson.set(data.index, (partialJson.get(data.index) ?? "") + String(delta.partial_json ?? ""));
    } else if (type === "message_delta") {
      if (isObject(data.delta) && typeof data.delta.stop_reason === "string") stopReason = data.delta.stop_reason;
      if (isObject(data.usage)) usage = { ...usage, ...data.usage };
    } else if (type === "error") {
      error = JSON.stringify(data.error ?? data);
    }
  }

  for (const [index, json] of partialJson) {
    if (blocks[index]) blocks[index].input = json ? parseMaybeJson(json) : {};
  }
  return {
    model,
    usage: Object.keys(usage).length ? usage : undefined,
    stopReason,
    error,
    response: { role: "assistant", content: blocks.filter(Boolean) },
  };
}

// ---------- SSE ----------

export interface SseEvent {
  event?: string;
  data: string;
}

function looksLikeSse(text: string): boolean {
  return /^(event|data|:|id|retry)[^\n]*\n/.test(text.trimStart());
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event: string | undefined;
  let data: string[] = [];
  const flush = () => {
    if (data.length) events.push({ event, data: data.join("\n") });
    event = undefined;
    data = [];
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flush();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
  }
  flush();
  return events;
}
