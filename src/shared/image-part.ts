/** An image content part, whichever wire format it came from. */
export interface ImagePart {
  /** Usable as `<img src>`: a data URL or a remote URL. */
  src: string;
  mimeType: string;
  /** Base64 payload when the image is embedded rather than linked. */
  base64?: string;
}

const IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);

export function isImageType(type: unknown): boolean {
  return typeof type === "string" && IMAGE_TYPES.has(type);
}

/**
 * Recognises:
 * - `{ type: "image", data, mimeType }`
 * - Anthropic `{ type: "image", source: { type: "base64", media_type, data } | { type: "url", url } }`
 * - OpenAI Chat `{ type: "image_url", image_url: { url } | url }`
 * - OpenAI Responses `{ type: "input_image", image_url }`
 */
export function imagePart(value: unknown): ImagePart | null {
  const part = asRecord(value);
  if (!part || !isImageType(part.type)) return null;
  if (typeof part.data === "string" && part.data) {
    return fromBase64(part.data, str(part.mimeType) || str(part.media_type) || str(part.mediaType));
  }
  const source = asRecord(part.source);
  if (source) {
    if (typeof source.data === "string" && source.data) return fromBase64(source.data, str(source.media_type) || str(source.mediaType));
    if (typeof source.url === "string" && source.url) return fromUrl(source.url);
  }
  const imageUrl = part.image_url ?? part.url;
  const url = typeof imageUrl === "string" ? imageUrl : str(asRecord(imageUrl)?.url);
  return url ? fromUrl(url) : null;
}

export function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  return /^[a-z0-9]{2,5}$/.test(subtype) ? subtype : "img";
}

export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fromBase64(data: string, mimeType: string): ImagePart {
  if (data.startsWith("data:")) return fromUrl(data);
  const mime = mimeType || "image/png";
  return { src: `data:${mime};base64,${data}`, mimeType: mime, base64: data };
}

function fromUrl(url: string): ImagePart {
  if (!url.startsWith("data:")) return { src: url, mimeType: "" };
  const comma = url.indexOf(",");
  const header = comma > 0 ? url.slice(5, comma) : "";
  return {
    src: url,
    mimeType: header.split(";")[0] || "image/png",
    base64: comma > 0 && header.endsWith(";base64") ? url.slice(comma + 1) : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
