export type ExportKind = "full" | "ai";

/** `20260929-143533-qwen38-ffbfa8.jsonl` → `20260929-143533-qwen38-ffbfa8`. */
export function traceStem(traceFile: string): string {
  const base = traceFile.split(/[\\/]/).pop() ?? traceFile;
  return base.replace(/\.jsonl?$/i, "") || "trace";
}

/** Organize output for one entry; shares the trace file's name so the two sort side by side. */
export function bundleDirName(traceFile: string, seq: number | string): string {
  return `${traceStem(traceFile)}-seq${String(seq).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

/** JSON download name; same prefix as the Organize directory of that entry. */
export function exportFileName(traceFile: string, seq: number | string, kind: ExportKind): string {
  return `${bundleDirName(traceFile, seq)}-${kind}.json`;
}
