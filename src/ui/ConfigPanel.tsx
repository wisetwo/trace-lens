import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ProxyConfigSnapshot } from "../shared/types.js";

type EndpointDraft = {
  name?: string;
  upstream?: string;
  port?: number;
  format?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
};

type ConfigDraft = {
  host?: string;
  port?: number;
  dataDir?: string;
  sessionIdleMinutes?: number;
  ui?: { enabled?: boolean; port?: number; host?: string; auth?: string; [key: string]: unknown };
  endpoints?: EndpointDraft[];
  [key: string]: unknown;
};

const FORMATS = ["openai-chat", "openai-responses", "anthropic-messages"];

/** Returns a copy with `key` set, or removed when the value is empty, so optional fields fall back to defaults. */
function withField<T extends Record<string, unknown>>(object: T, key: string, value: unknown): T {
  const next: Record<string, unknown> = { ...object };
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next as T;
}

function toNumber(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return Object.keys(headers).length ? headers : undefined;
}

function toText(draft: ConfigDraft): string {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

function sameJson(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}

export function ConfigPanel({ apiBase, onClose }: { apiBase: string; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ProxyConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<ConfigDraft>({});
  const [jsonText, setJsonText] = useState("");
  const [mode, setMode] = useState<"form" | "json">("form");
  // Bumped whenever the draft is replaced wholesale, so fields with local text state re-initialise.
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const adopt = useCallback((next: ProxyConfigSnapshot) => {
    setSnapshot(next);
    setJsonText(next.text);
    try {
      setDraft(JSON.parse(next.text) as ConfigDraft);
    } catch {
      setMode("json");
    }
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    fetch(`${apiBase}/api/proxy/config`)
      .then(async (response) => {
        const payload = await response.json() as ProxyConfigSnapshot & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? response.statusText);
        adopt(payload);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [apiBase, adopt]);

  const currentText = mode === "json" ? jsonText : toText(draft);
  const dirty = snapshot !== null && !sameJson(currentText, snapshot.text);

  const switchMode = (next: "form" | "json") => {
    if (next === mode) return;
    if (next === "json") {
      setJsonText(toText(draft));
    } else {
      try {
        setDraft(JSON.parse(jsonText) as ConfigDraft);
        setGeneration((value) => value + 1);
      } catch (err) {
        setError(`Fix the JSON before switching to the form: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setError(null);
    setMode(next);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/api/proxy/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: currentText }),
      });
      const payload = await response.json() as ProxyConfigSnapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? response.statusText);
      const previousUi = snapshot?.ui;
      adopt(payload);
      setNotice(
        payload.ui === previousUi
          ? "Saved and applied. In-flight requests finished on the previous listeners."
          : payload.ui
            ? `Saved and applied. The viewer moved to ${payload.ui}`
            : "Saved and applied. The viewer is now disabled; this page will stop working.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: (draft: ConfigDraft) => ConfigDraft) => setDraft((current) => patch(current));
  const setField = (key: string, value: unknown) => update((current) => withField(current, key, value));
  const setUi = (key: string, value: unknown) => update((current) => ({ ...current, ui: withField(current.ui ?? {}, key, value) }));
  const endpoints = draft.endpoints ?? [];
  const setEndpoint = (index: number, key: string, value: unknown) =>
    update((current) => ({ ...current, endpoints: (current.endpoints ?? []).map((endpoint, i) => (i === index ? withField(endpoint, key, value) : endpoint)) }));
  const removeEndpoint = (index: number) => {
    update((current) => ({ ...current, endpoints: (current.endpoints ?? []).filter((_, i) => i !== index) }));
    setGeneration((value) => value + 1);
  };
  const addEndpoint = () => update((current) => ({ ...current, endpoints: [...(current.endpoints ?? []), { name: "", upstream: "" }] }));
  const uiEnabled = draft.ui?.enabled ?? true;

  return (
    <div className="detail-overlay" onClick={onClose}>
      <aside className="detail-modal config-modal" onClick={(event) => event.stopPropagation()}>
        <div className="detail-header">
          <div>
            <h2 className="config-title">Proxy config</h2>
            <p>{snapshot ? <code>{snapshot.path}</code> : "Loading…"}</p>
          </div>
          <div className="detail-actions">
            <div className="segmented">
              <button className={mode === "form" ? "active" : ""} onClick={() => switchMode("form")}>Form</button>
              <button className={mode === "json" ? "active" : ""} onClick={() => switchMode("json")}>JSON</button>
            </div>
            <button className="icon-button" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="detail-body">
          {snapshot ? (
            <section className="config-section">
              <h3>Running</h3>
              {snapshot.warnings.map((warning) => <div key={warning} className="config-warning">{warning}</div>)}
              <div className="config-listeners">
                {snapshot.listeners.map((listener) => (
                  <div key={listener.url} className="config-listener">
                    <span>{listener.name}</span>
                    <code>{listener.url}</code>
                    <button className="button small" onClick={() => void navigator.clipboard?.writeText(listener.url)}>Copy</button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {mode === "json" ? (
            <textarea className="config-json" spellCheck={false} value={jsonText} onChange={(event) => setJsonText(event.target.value)} />
          ) : (
            <>
              <section className="config-section">
                <h3>Proxy</h3>
                <div className="config-grid">
                  <Field label="Host" hint="0.0.0.0 to listen on all interfaces">
                    <input value={draft.host ?? ""} placeholder="127.0.0.1" onChange={(event) => setField("host", event.target.value)} />
                  </Field>
                  <Field label="Port" hint="Moves to the next free port when busy">
                    <input type="number" value={draft.port ?? ""} placeholder="8600" onChange={(event) => setField("port", toNumber(event.target.value))} />
                  </Field>
                  <Field label="Captures directory" hint="Relative to the config file">
                    <input value={draft.dataDir ?? ""} placeholder="./captures" onChange={(event) => setField("dataDir", event.target.value)} />
                  </Field>
                  <Field label="Session idle (minutes)" hint="Longer gaps start a new trace file">
                    <input type="number" value={draft.sessionIdleMinutes ?? ""} placeholder="30" onChange={(event) => setField("sessionIdleMinutes", toNumber(event.target.value))} />
                  </Field>
                </div>
              </section>

              <section className="config-section">
                <h3>Viewer</h3>
                <label className="config-check">
                  <input type="checkbox" checked={uiEnabled} onChange={(event) => setUi("enabled", event.target.checked)} /> Serve this viewer
                </label>
                <div className="config-grid">
                  <Field label="Port">
                    <input type="number" disabled={!uiEnabled} value={draft.ui?.port ?? ""} placeholder="3117" onChange={(event) => setUi("port", toNumber(event.target.value))} />
                  </Field>
                  <Field label="Host" hint="Defaults to the proxy host">
                    <input disabled={!uiEnabled} value={draft.ui?.host ?? ""} placeholder={draft.host || "127.0.0.1"} onChange={(event) => setUi("host", event.target.value)} />
                  </Field>
                  <Field label="Basic auth" hint="user:password; required to edit config from a non-loopback host">
                    <input disabled={!uiEnabled} value={draft.ui?.auth ?? ""} placeholder="(none)" autoComplete="off" onChange={(event) => setUi("auth", event.target.value)} />
                  </Field>
                </div>
              </section>

              <section className="config-section">
                <h3>Endpoints</h3>
                {endpoints.map((endpoint, index) => (
                  <div key={`${generation}-${index}`} className="config-endpoint">
                    <div className="config-endpoint-row">
                      <Field label="Name" hint="Route: /<name>/...">
                        <input value={endpoint.name ?? ""} placeholder="openai" onChange={(event) => setEndpoint(index, "name", event.target.value)} />
                      </Field>
                      <Field label="Upstream" wide>
                        <input value={endpoint.upstream ?? ""} placeholder="https://api.openai.com" onChange={(event) => setEndpoint(index, "upstream", event.target.value)} />
                      </Field>
                      <Field label="Dedicated port" hint="Optional">
                        <input type="number" value={endpoint.port ?? ""} placeholder="(shared)" onChange={(event) => setEndpoint(index, "port", toNumber(event.target.value))} />
                      </Field>
                      <Field label="Format">
                        <select value={endpoint.format ?? ""} onChange={(event) => setEndpoint(index, "format", event.target.value)}>
                          <option value="">auto-detect</option>
                          {FORMATS.map((format) => <option key={format} value={format}>{format}</option>)}
                        </select>
                      </Field>
                      <button className="button small config-remove" title="Remove endpoint" onClick={() => removeEndpoint(index)}>Remove</button>
                    </div>
                    <HeadersField value={endpoint.headers} onChange={(headers) => setEndpoint(index, "headers", headers)} />
                  </div>
                ))}
                <button className="button small" onClick={addEndpoint}>+ Add endpoint</button>
              </section>
            </>
          )}
        </div>

        <div className="config-footer">
          <div className="config-footer-message">
            {error ? <div className="error-banner small config-error">{error}</div> : null}
            {notice && !error ? <div className="organize-note">{notice}</div> : null}
          </div>
          <button className="button" disabled={!dirty || saving} onClick={() => snapshot && adopt(snapshot)}>Revert</button>
          <button className="button primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Applying…" : "Save & apply"}</button>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`config-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function HeadersField({ value, onChange }: { value?: Record<string, string>; onChange: (headers: Record<string, string> | undefined) => void }) {
  const [text, setText] = useState(() => formatHeaders(value));
  return (
    <label className="config-field wide">
      <span>Extra upstream headers</span>
      <textarea
        rows={Math.max(1, text.split("\n").length)}
        spellCheck={false}
        value={text}
        placeholder="Authorization: Bearer sk-... (one per line)"
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseHeaders(event.target.value));
        }}
      />
    </label>
  );
}
