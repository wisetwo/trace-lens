import crypto from "node:crypto";
import type { TraceEntry, TraceMessage, TraceToolDef } from "../shared/types.js";

/**
 * Compact trace format (traceVersion 3).
 *
 * LLM requests resend the whole history, system prompt and tool definitions on every call, so storing each
 * entry verbatim grows quadratically. In a compact file every message and every tool list is written once as
 *   {"kind":"blob","id":"<hash>","value":<json>}
 * and entries reference them via `messageRefs` / `toolsRef`. Blobs always precede the entries that use them.
 */
export const COMPACT_TRACE_VERSION = 3;

interface BlobLine {
  kind: "blob";
  id: string;
  value: unknown;
}

function blobId(json: string): string {
  return crypto.createHash("sha1").update(json).digest("hex").slice(0, 16);
}

/** Encodes entries for one file; remembers which blobs that file already contains. */
export class CompactWriter {
  private readonly written = new Set<string>();

  encode(entry: TraceEntry): string {
    const lines: string[] = [];
    const ref = (value: unknown): string => {
      const json = JSON.stringify(value);
      const id = blobId(json);
      if (!this.written.has(id)) {
        this.written.add(id);
        lines.push(`{"kind":"blob","id":"${id}","value":${json}}`);
      }
      return id;
    };

    const { messages, tools, ...rest } = entry;
    const compact: TraceEntry = { ...rest, traceVersion: COMPACT_TRACE_VERSION };
    if (messages) compact.messageRefs = messages.map(ref);
    if (tools) compact.toolsRef = ref(tools);
    lines.push(JSON.stringify(compact));
    return `${lines.join("\n")}\n`;
  }
}

function isBlob(value: unknown): value is BlobLine {
  if (value == null || typeof value !== "object") return false;
  const record = value as { kind?: unknown; id?: unknown; seq?: unknown };
  return record.kind === "blob" && typeof record.id === "string" && record.seq === undefined;
}

/** Turns parsed JSON lines (compact or verbatim) into full entries. Hydrated entries share blob objects. */
export function hydrateLines(values: unknown[]): TraceEntry[] {
  const blobs = new Map<string, unknown>();
  const entries: TraceEntry[] = [];
  for (const value of values) {
    if (isBlob(value)) {
      blobs.set(value.id, value.value);
      continue;
    }
    if (!value || typeof value !== "object" || typeof (value as { seq?: unknown }).seq !== "number") continue;
    const entry = value as TraceEntry;
    const { messageRefs, toolsRef } = entry as { messageRefs?: unknown; toolsRef?: unknown };
    // Only proxy-written entries are compact; client-written logs pass through untouched.
    if (entry.traceVersion === COMPACT_TRACE_VERSION && (Array.isArray(messageRefs) || typeof toolsRef === "string")) {
      const { messageRefs: _m, toolsRef: _t, ...rest } = entry;
      const full: TraceEntry = { ...rest };
      if (Array.isArray(messageRefs)) {
        full.messages = messageRefs.map((id) => (blobs.get(String(id)) ?? { role: "unknown", content: `[missing blob ${String(id)}]` }) as TraceMessage);
      }
      if (typeof toolsRef === "string") full.tools = (blobs.get(toolsRef) ?? []) as TraceToolDef[];
      entries.push(full);
    } else {
      entries.push(entry);
    }
  }
  return entries;
}
