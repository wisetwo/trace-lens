export type ExportKind = "full" | "ai";

export function formatExportTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Basename shared by a JSON download and the agent bundle directory. */
export function exportBaseName(seq: number | string, date: Date, kind: ExportKind): string {
  return `trace-${formatExportTimestamp(date)}-${seq}-${kind}`;
}
