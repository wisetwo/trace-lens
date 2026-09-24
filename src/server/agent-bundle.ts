import fs from "node:fs/promises";
import path from "node:path";
import { exportBaseName } from "../shared/export-name.js";

/**
 * Turn one trace JSON entry into a directory an agent can skim.
 *
 * The shape is inferred from the JSON itself (messages, tool_use blocks,
 * tool results, tool schemas). Nothing here imports the application that
 * produced the trace.
 *
 * `index.md` is the overview. Bodies past the inline limit are written
 * under `files/` and referenced from the overview.
 */

const TEXT_INLINE = 4000;
const TEXT_HEAD = 500;
const TEXT_TAIL = 0;
const TOOL_RESULT_INLINE = 1600;
const SYSTEM_INLINE = 800;
const TOOL_INPUT_INLINE = 400;
const MAIN_FILE = "index.md";

const META_KEYS = [
  "ts",
  "seq",
  "stage",
  "eventType",
  "turnId",
  "turnStage",
  "isFinalForTurn",
  "agentRole",
  "agentId",
  "agentLabel",
  "agentSeq",
  "sessionKey",
  "sessionId",
  "runId",
  "parentRunId",
  "provider",
  "modelId",
  "modelApi",
  "messageCount",
  "toolCount",
  "parentAgentId",
  "parentToolCallId",
  "taskId",
  "taskDescription",
  "taskPromptPreview",
  "subagentType",
  "responseCaptureSource",
  "promptLogKey",
  "traceVersion",
  "note",
] as const;

const HANDLED_KEYS = new Set<string>([
  ...META_KEYS,
  "system",
  "prompt",
  "messages",
  "tools",
  "error",
  "_traceLensExport",
]);

export interface BundleFile {
  relativePath: string;
  contents: string;
}

export interface AgentBundle {
  mainFile: string;
  files: BundleFile[];
}

interface SpillLimits {
  inline: number;
  head: number;
  tail: number;
}

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; id: string; input: unknown }
  | { kind: "image"; note: string }
  | { kind: "raw"; text: string };

export function buildAgentBundle(entry: unknown): AgentBundle {
  const record = asRecord(entry);
  const files: BundleFile[] = [];
  const lines: string[] = [];
  const seq = record?.seq ?? "?";
  const turn = typeof record?.turnId === "string" ? record.turnId : "";

  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const toolList = Array.isArray(record?.tools) ? record.tools : [];
  lines.push(`# Trace index · seq ${seq}${turn ? ` · ${turn}` : ""}`);
  lines.push("");
  lines.push("The table below is the whole turn. Open a `files/` path only when that row is not enough.");
  lines.push("");
  lines.push(introLine(record, seq, turn, messages.length, toolList.length));
  lines.push("");
  const identifiers = identifierLine(record);
  if (identifiers) {
    lines.push(identifiers);
    lines.push("");
  }

  if (record && "error" in record && record.error != null) {
    lines.push("## Error");
    lines.push("");
    const errorText = stringify(record.error);
    const errorSpill = spill(files, "files/error.txt", errorText, textLimits("text"), { omitPreview: true });
    lines.push(errorSpill.rel ? `\`${errorSpill.rel}\`` : fence(errorSpill.shown));
    lines.push("");
  }

  const systemText = record?.system != null ? stringify(record.system) : null;
  if (systemText) {
    const systemSpill = spill(files, "files/system.txt", systemText, textLimits("system"), { omitPreview: true });
    lines.push(systemSpill.rel ? `System prompt: \`${systemSpill.rel}\` (${systemText.length.toLocaleString()} chars)` : `System prompt: ${systemText.length.toLocaleString()} chars, inlined below.`);
    lines.push("");
    if (!systemSpill.rel) {
      lines.push(fence(systemSpill.shown));
      lines.push("");
    }
  }

  if (typeof record?.prompt === "string" && record.prompt) {
    const promptSpill = spill(files, "files/prompt.txt", record.prompt, textLimits("text"), { omitPreview: true });
    lines.push(promptSpill.rel ? `Prompt field: \`${promptSpill.rel}\`` : fence(promptSpill.shown));
    lines.push("");
  }

  lines.push(`## Turn`);
  lines.push("");
  if (!messages.length) {
    lines.push("_No messages._");
    lines.push("");
  } else {
    const rendered = messages.map((message, index) => renderMessage(message, index, files, systemText));
    lines.push("| # | Who | Chars | What | Detail |");
    lines.push("| --- | --- | ---: | --- | --- |");
    for (const item of rendered) {
      const who = item.name && item.name !== item.role ? `${item.role} ${item.name}` : item.role;
      lines.push(`| ${item.index} | ${cell(who)} | ${item.chars.toLocaleString()} | ${cell(item.summary)} | ${item.files.map((file) => `\`${file}\``).join(", ") || ""} |`);
    }
    lines.push("");
    lines.push(`## Messages`);
    lines.push("");
    for (const item of rendered) {
      lines.push(item.markdown);
    }
  }

  lines.push(...renderTools(record?.tools, files));

  lines.push(...renderOtherFields(record, files));

  lines.push("## Files");
  lines.push("");
  if (!files.length) {
    lines.push("_Nothing was long enough to split out._");
  } else {
    for (const file of files) {
      lines.push(`- \`${file.relativePath}\` (${file.contents.length.toLocaleString()} chars)`);
    }
  }
  lines.push("");

  files.unshift({ relativePath: MAIN_FILE, contents: `${lines.join("\n")}\n` });
  return { mainFile: MAIN_FILE, files };
}

export async function writeAgentBundle(traceFile: string, entry: unknown, date = new Date()): Promise<{
  directory: string;
  mainFile: string;
  files: string[];
}> {
  const parent = path.resolve(path.dirname(traceFile));
  const directory = path.resolve(parent, bundleDirName(entry, date));
  if (path.dirname(directory) !== parent) {
    throw new Error("Refusing to write the bundle outside the trace file's directory");
  }

  const bundle = buildAgentBundle(entry);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  for (const file of bundle.files) {
    const target = path.resolve(directory, file.relativePath);
    if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) {
      throw new Error(`Refusing to write ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.contents, "utf8");
  }
  return {
    directory,
    mainFile: bundle.mainFile,
    files: bundle.files.map((file) => file.relativePath),
  };
}

function bundleDirName(entry: unknown, date: Date): string {
  const seq = asRecord(entry)?.seq;
  const seqLabel = typeof seq === "number" || typeof seq === "string" ? seq : "entry";
  return exportBaseName(seqLabel, date, "full");
}

function renderTools(tools: unknown, files: BundleFile[]): string[] {
  if (!Array.isArray(tools) || !tools.length) return [];
  const lines = [`## Tools (${tools.length})`, ""];
  const full = JSON.stringify(tools, null, 2);
  const detailed = tools.some((tool) => toolHasDetails(tool));
  if (detailed || full.length > 1500) {
    lines.push(`Schemas: \`${spillRaw(files, "files/tools.json", full)}\`.`, "");
  }
  const names = tools.map((tool) => {
    const record = asRecord(tool);
    return `\`${record ? String(record.name ?? "?") : oneLine(stringify(tool), 80)}\``;
  });
  lines.push(names.join(", "));
  lines.push("");
  return lines;
}

function introLine(record: Record<string, unknown> | null, seq: unknown, turn: string, messageCount: number, toolCount: number): string {
  const bits = [
    typeof record?.modelId === "string" ? `\`${record.modelId}\`` : "",
    typeof record?.provider === "string" ? record.provider : "",
    turn ? `turn \`${turn}\`${typeof record?.turnStage === "string" ? ` ${record.turnStage}` : ""}` : "",
    typeof record?.agentLabel === "string" ? `agent \`${record.agentLabel}\`` : "",
    `seq ${seq}`,
    `${messageCount} messages`,
    toolCount ? `${toolCount} tools` : "",
    typeof record?.ts === "string" ? record.ts : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function identifierLine(record: Record<string, unknown> | null): string {
  if (!record) return "";
  const keys = ["runId", "parentRunId", "promptLogKey", "sessionId", "taskId", "parentToolCallId"] as const;
  const bits = keys.flatMap((key) => (isScalar(record[key]) && record[key] !== "" ? [`${key} \`${record[key]}\``] : []));
  return bits.length ? bits.join(" · ") : "";
}

function renderMessage(message: unknown, index: number, files: BundleFile[], topLevelSystem: string | null): {
  index: number;
  role: string;
  name: string;
  chars: number;
  summary: string;
  files: string[];
  markdown: string;
} {
  const record = asRecord(message) ?? {};
  const role = typeof record.role === "string" ? record.role : "unknown";
  const name = firstString(record, ["name"]);
  const toolCallId = firstString(record, ["toolCallId", "tool_call_id"]);
  const blocks = role === "system" ? mergeSystemText(messageBlocks(record)) : messageBlocks(record);
  const folded = index === 0 && role === "system" && topLevelSystem != null && stringify(record.content) === topLevelSystem;
  const spilled: string[] = [];
  const parts: string[] = [];
  let chars = 0;

  const extras = [
    name ? `name=\`${name}\`` : "",
    toolCallId ? `tool_call_id=\`${toolCallId}\`` : "",
  ].filter(Boolean);
  parts.push(`### m${index} · ${role}${extras.length ? ` · ${extras.join(" · ")}` : ""}`);
  parts.push("");

  if (folded) {
    chars = topLevelSystem.length;
    parts.push("_Same text as the system prompt linked above._");
    parts.push("");
    return { index, role, name, chars, summary: "system prompt, linked above", files: spilled, markdown: parts.join("\n") };
  }

  if (!blocks.length) {
    parts.push("_Empty content._");
    parts.push("");
  }

  const bodyKind = role === "system" ? "system" : role === "toolResult" || role === "tool" || role === "function" ? "tool" : "text";
  blocks.forEach((block, blockIndex) => {
    const slug = `files/m${String(index).padStart(2, "0")}-${slugPart(name || role)}`;
    if (block.kind === "text" || block.kind === "raw") {
      const pretty = block.kind === "text" ? maybePrettyJson(block.text) : { text: block.text, ext: "txt" as const };
      chars += pretty.text.length;
      const result = spill(files, `${slug}${blockIndex ? `-${blockIndex}` : ""}.${pretty.ext}`, pretty.text, textLimits(bodyKind), { omitPreview: bodyKind !== "text" });
      if (result.rel) {
        spilled.push(result.rel);
        parts.push(result.shown ? fence(result.shown, pretty.ext === "json" ? "json" : "") : `${pretty.text.length.toLocaleString()} chars → \`${result.rel}\``);
      } else {
        parts.push(fence(result.shown, pretty.ext === "json" ? "json" : ""));
      }
    } else if (block.kind === "thinking") {
      chars += block.text.length;
      const result = spill(files, `${slug}-thinking.txt`, block.text, textLimits("text"));
      if (result.rel) spilled.push(result.rel);
      parts.push(result.rel && !result.shown ? `${block.text.length.toLocaleString()} chars of thinking → \`${result.rel}\`` : "thinking:");
      if (!result.rel || result.shown) {
        parts.push("");
        parts.push(fence(result.shown));
      }
    } else if (block.kind === "tool_use") {
      const input = maybePrettyJson(typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}, null, 2));
      const inputText = input.ext === "json" ? input.text : stringify(block.input);
      chars += inputText.length;
      const toolSlug = slugPart(block.name || "tool");
      let shown = inputText;
      if (inputText.length > TOOL_INPUT_INLINE) {
        const rel = spillRaw(files, `files/m${String(index).padStart(2, "0")}-${toolSlug}.input.${input.ext === "json" ? "json" : "txt"}`, inputText);
        spilled.push(rel);
        shown = `${inputText.slice(0, TOOL_INPUT_INLINE)}\n… ⟪${(inputText.length - TOOL_INPUT_INLINE).toLocaleString()} chars omitted — full input in \`${rel}\`⟫`;
      }
      parts.push(`**tool_use** \`${block.name || "unknown"}\`${block.id ? ` · id \`${block.id}\`` : ""}`);
      parts.push("");
      parts.push(fence(shown, "json"));
    } else {
      chars += block.note.length;
      parts.push(`_${block.note}_`);
    }
    parts.push("");
  });

  const summary = summarize(role, name, blocks);
  return { index, role, name, chars, summary, files: spilled, markdown: parts.join("\n") };
}

function renderOtherFields(record: Record<string, unknown> | null, files: BundleFile[]): string[] {
  if (!record) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (HANDLED_KEYS.has(key) || value == null) continue;
    const text = stringify(value);
    if (!text) continue;
    if (!lines.length) {
      lines.push("## Other fields");
      lines.push("");
    }
    if (isScalar(value) && text.length <= 300) {
      lines.push(`- \`${key}\`: ${cell(text)}`);
      continue;
    }
    const pretty = maybePrettyJson(text);
    const result = spill(files, `files/field-${slugPart(key)}.${pretty.ext}`, pretty.text, textLimits("text"), { omitPreview: true });
    lines.push(`- \`${key}\`: ${result.rel ? `\`${result.rel}\`` : "included below"}`);
    if (!result.rel) {
      lines.push("");
      lines.push(fence(result.shown, pretty.ext === "json" ? "json" : ""));
    }
  }
  if (lines.length) lines.push("");
  return lines;
}

function mergeSystemText(blocks: Block[]): Block[] {
  const texts = blocks.filter((block) => block.kind === "text");
  if (texts.length < 2) return blocks;
  const rest = blocks.filter((block) => block.kind !== "text");
  return [{ kind: "text", text: texts.map((block) => block.text).join("\n\n") }, ...rest];
}

function summarize(role: string, name: string, blocks: Block[]): string {
  const toolUses = blocks.filter((block): block is Extract<Block, { kind: "tool_use" }> => block.kind === "tool_use");
  if (toolUses.length) return oneLine(toolUses.map((block) => toolUseSummary(block)).join("; "), 160);
  if (role === "system") return "system prompt";
  const texts = blocks.filter((block): block is Extract<Block, { kind: "text" | "raw" }> => (block.kind === "text" || block.kind === "raw") && block.text.trim().length > 0);
  if (role === "toolResult" || role === "tool" || role === "function" || name) {
    const label = name || role;
    const text = texts[0];
    return text ? `${label}: ${firstUsefulLine(text.text)}` : label;
  }
  const plain = texts.map((block) => block.text).filter((text) => !isWrapperChunk(text));
  if (role === "user") {
    const source = plain[plain.length - 1] ?? texts[0]?.text;
    return source ? visibleSummary(source) : role;
  }
  if (plain[0]) return openingLine(plain[0]);
  if (texts[0]) return openingLine(texts[0].text);
  const thinking = blocks.find((block) => block.kind === "thinking");
  if (thinking && thinking.kind === "thinking" && thinking.text.trim()) return `thinking: ${oneLine(thinking.text, 80)}`;
  const image = blocks.find((block) => block.kind === "image");
  if (image && image.kind === "image") return image.note;
  return role;
}

function toolUseSummary(block: Extract<Block, { kind: "tool_use" }>): string {
  const hint = inputHint(block.input);
  return hint ? `${block.name || "tool"} ${hint}` : block.name || "tool";
}

function inputHint(input: unknown): string {
  const record = asRecord(input);
  if (!record) return oneLine(stringify(input), 80);
  const preferred = ["query", "queries", "pattern", "path", "command", "url", "document_ids", "file", "filename", "start_line", "end_line"];
  const parts: string[] = [];
  for (const key of preferred) {
    if (record[key] != null && record[key] !== "") parts.push(`${key}=${compactValue(record[key])}`);
  }
  if (!parts.length) {
    for (const [key, value] of Object.entries(record).slice(0, 3)) {
      if (value != null && value !== "") parts.push(`${key}=${compactValue(value)}`);
    }
  }
  return oneLine(parts.join(" "), 120);
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value.length > 48 ? `${value.slice(0, 47)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const shown = value.slice(0, 2).map((item) => compactValue(item)).join(", ");
    return `[${shown}${value.length > 2 ? ", …" : ""}]`;
  }
  return oneLine(stringify(value), 48);
}

function openingLine(text: string): string {
  const chunks = text.split(/\n{2,}/).map((chunk) => chunk.trim()).filter((chunk) => chunk && !isWrapperChunk(chunk));
  const chunk = chunks[0] ?? text.trim();
  const line = chunk.split("\n").map((item) => item.trim()).find(Boolean) ?? chunk;
  return oneLine(line, 140);
}

function visibleSummary(text: string): string {
  const chunks = text.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  const plain = chunks.filter((chunk) => !isWrapperChunk(chunk));
  return oneLine((plain[plain.length - 1] ?? chunks[0] ?? text).replace(/\s+/g, " "), 140);
}

function isWrapperChunk(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (trimmed.startsWith("<") && trimmed.includes(">")) return true;
  return trimmed.startsWith("[KB ") || trimmed.startsWith("[System");
}

function firstUsefulLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("<!--") && !line.startsWith("<"));
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line));
  const lead = lines.find((line) => !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("|"));
  if (heading && lead) return oneLine(`${heading.replace(/^#+\s*/, "")} — ${lead}`, 140);
  return oneLine(lines[0] ?? text, 140);
}

function messageBlocks(message: Record<string, unknown>): Block[] {
  const fromContent = blocksFromContent(message.content);
  const seen = new Set(fromContent.filter((block) => block.kind === "tool_use" && block.id).map((block) => (block.kind === "tool_use" ? block.id : "")));
  const extras = toolUsesFromMessage(message).filter((block) => !block.id || !seen.has(block.id));
  return [...fromContent, ...extras];
}

function blocksFromContent(content: unknown): Block[] {
  if (content == null) return [];
  if (typeof content === "string") {
    const parsed = tryParseBlockList(content);
    if (parsed) return blocksFromContent(parsed);
    return content.trim() ? [{ kind: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    const blocks = content.map((item) => blockFromItem(item));
    const meaningful = blocks.filter((block) => !(block.kind === "text" && !block.text.trim()));
    return meaningful.length ? meaningful : blocks;
  }
  return [blockFromItem(content)];
}

function blockFromItem(item: unknown): Block {
  if (typeof item === "string") return { kind: "text", text: item };
  if (!item || typeof item !== "object") return { kind: "raw", text: stringify(item) };
  const obj = item as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "thinking" || type === "reasoning") {
    return { kind: "thinking", text: firstString(obj, ["text", "thinking", "reasoning"]) };
  }
  if (type === "tool_use" || type === "toolCall" || type === "tool_call") {
    return toolUseBlock(obj);
  }
  if (type === "tool_result" || type === "toolResult") {
    return { kind: "text", text: stringify(obj.content ?? obj.output ?? obj.text ?? "") };
  }
  if (type === "image" || type === "image_url" || type === "input_image") {
    const data = typeof obj.data === "string" ? obj.data : "";
    const mime = typeof obj.mimeType === "string" ? obj.mimeType : typeof obj.media_type === "string" ? obj.media_type : "";
    return { kind: "image", note: `image${mime ? ` ${mime}` : ""}${data ? ` (${data.length.toLocaleString()} chars of data, not inlined)` : ""}` };
  }
  if (typeof obj.text === "string") return { kind: "text", text: obj.text };
  return { kind: "raw", text: JSON.stringify(obj, null, 2) };
}

function toolUsesFromMessage(message: Record<string, unknown>): Array<Extract<Block, { kind: "tool_use" }>> {
  const calls = message.tool_calls ?? message.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => toolUseBlock(asRecord(call) ?? { input: call }));
}

function toolUseBlock(obj: Record<string, unknown>): Extract<Block, { kind: "tool_use" }> {
  const fn = asRecord(obj.function);
  let input: unknown = obj.input ?? obj.arguments ?? obj.args ?? fn?.arguments ?? {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      // Keep the raw argument string.
    }
  }
  return {
    kind: "tool_use",
    name: String(obj.name || fn?.name || obj.toolName || ""),
    id: String(obj.id || obj.toolCallId || obj.tool_call_id || ""),
    input,
  };
}

function tryParseBlockList(text: string): unknown[] | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("[")) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value) || !value.some((item) => item && typeof item === "object" && "type" in (item as object))) return null;
    return value;
  } catch {
    return null;
  }
}

function spill(files: BundleFile[], preferred: string, text: string, limits: SpillLimits, options?: { omitPreview?: boolean }): { shown: string; rel: string | null } {
  if (text.length <= limits.inline) return { shown: text, rel: null };
  const rel = spillRaw(files, preferred, text);
  if (options?.omitPreview || limits.head <= 0) return { shown: "", rel };
  let head = text.slice(0, limits.head);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > limits.head * 0.5) head = head.slice(0, headBreak);
  let tail = limits.tail > 0 ? text.slice(-limits.tail) : "";
  const tailBreak = tail.indexOf("\n");
  if (tail && tailBreak >= 0 && tailBreak < tail.length * 0.5) tail = tail.slice(tailBreak + 1);
  const omitted = Math.max(0, text.length - head.length - tail.length);
  const marker = `\n\n… ⟪${omitted.toLocaleString()} chars omitted — full text in \`${rel}\`⟫ …\n\n`;
  return { shown: `${head}${marker}${tail}`, rel };
}

function spillRaw(files: BundleFile[], preferred: string, contents: string): string {
  let relativePath = preferred;
  let suffix = 2;
  while (files.some((file) => file.relativePath === relativePath)) {
    const dot = preferred.lastIndexOf(".");
    relativePath = dot > 0 ? `${preferred.slice(0, dot)}-${suffix}${preferred.slice(dot)}` : `${preferred}-${suffix}`;
    suffix += 1;
  }
  files.push({ relativePath, contents });
  return relativePath;
}

function textLimits(kind: "system" | "tool" | "text"): SpillLimits {
  if (kind === "system") return { inline: SYSTEM_INLINE, head: 0, tail: 0 };
  if (kind === "tool") return { inline: TOOL_RESULT_INLINE, head: 0, tail: 0 };
  return { inline: TEXT_INLINE, head: TEXT_HEAD, tail: TEXT_TAIL };
}

function maybePrettyJson(text: string): { text: string; ext: "json" | "txt" } {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return { text, ext: "txt" };
  try {
    return { text: JSON.stringify(JSON.parse(trimmed) as unknown, null, 2), ext: "json" };
  } catch {
    return { text, ext: "txt" };
  }
}

function toolHasDetails(tool: unknown): boolean {
  const record = asRecord(tool);
  if (!record) return false;
  return Object.entries(record).some(([key, value]) => key !== "name" && value != null && value !== "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function fence(text: string, lang = ""): string {
  const tick = text.includes("```") ? "~~~~" : "```";
  return `${tick}${lang}\n${text}\n${tick}`;
}

function slugPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "x";
}
