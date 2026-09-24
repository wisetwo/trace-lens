# Trace Lens

Interactive graph viewer for multi-agent LLM trace logs in JSONL format.

Trace Lens turns structured trace events into a graph that helps you inspect multi-agent execution flows:

- one lane per agent or session
- one node per completed LLM event or error event
- sequential edges within the same agent
- task spawn and result edges when graph metadata is available
- clickable nodes for inspecting the original JSONL entry

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Installation

```bash
# Install globally
npm install -g @wisetwo/trace-lens

# Or run without installing
npx @wisetwo/trace-lens ./logs/trace.jsonl
```

## Quick Start

```bash
# Open a trace JSONL file
trace-lens ./logs/trace.jsonl

# Open a directory and use the newest .jsonl file
trace-lens ./logs/

# Custom port
trace-lens ./logs/trace.jsonl --port 3117

# Do not open the browser automatically
trace-lens ./logs/trace.jsonl --no-open
```

## CLI Options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `<path>` | Path to a trace `.jsonl` file or a directory containing `.jsonl` files | — |
| `-v, --version` | Print version number | — |
| `-p, --port <port>` | Port to listen on | `3117` |
| `--no-open` | Do not open the browser automatically | `false` |

When a directory is provided, the viewer selects the newest `.jsonl` file by modification time.

## Trace JSONL Format

The viewer reads JSON Lines: one JSON object per line. Each entry should include a numeric `seq` field. Other fields are optional and are rendered when present.

### Minimal Example

```json
{"ts":"2026-04-29T10:30:00.000Z","seq":1,"stage":"stream:context","sessionKey":"agent:main","provider":"openai","modelId":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}
```

### Common Fields

| Field | Type | Description |
| ----- | ---- | ----------- |
| `ts` | `string` | ISO 8601 timestamp |
| `seq` | `number` | Monotonically increasing sequence number |
| `stage` | `string` | Event phase, such as `stream:context` or `error` |
| `runId` | `string` | Run identifier |
| `parentRunId` | `string \| null` | Parent run identifier |
| `sessionId` | `string` | Session identifier |
| `sessionKey` | `string` | Human-readable session key |
| `provider` | `string` | LLM provider name |
| `modelId` | `string` | Model identifier |
| `system` | `unknown` | System prompt or metadata |
| `prompt` | `string` | Prompt text |
| `messages` | `array` | Message history |
| `tools` | `array` | Tool definitions |
| `messageCount` | `number` | Pre-computed message count |
| `toolCount` | `number` | Pre-computed tool count |
| `error` | `string` | Error message |

### Optional Graph Metadata

For exact multi-agent graph rendering, trace entries can include these optional fields:

| Field | Description |
| ----- | ----------- |
| `agentId` | Stable agent identifier |
| `agentLabel` | Display label for the agent lane |
| `agentRole` | Agent role, such as `lead`, `sub`, or `unknown` |
| `agentSeq` | Sequence number within the agent |
| `turnId` | Turn identifier |
| `turnStage` | Turn phase, such as `end` or `error` |
| `parentAgentId` | Parent agent identifier |
| `parentToolCallId` | Tool call that spawned the child agent |
| `taskId` | Task identifier |
| `taskDescription` | Human-readable task description |
| `subagentType` | Child agent type label |

If explicit graph metadata is missing, the viewer falls back to best-effort inference from session order and task tool-call IDs.

## Capture Proxy

Instead of emitting trace logs from your application, you can point its LLM base URL at the Trace Lens proxy. The proxy forwards requests unchanged (streaming included), captures each request/response pair, links the calls into agent lanes, and writes one JSONL trace file per conversation.

```bash
trace-lens proxy start     # start in the background (creates ~/.trace-lens/proxy.json on first run)
trace-lens proxy status    # show pid, base URLs, UI URL
trace-lens proxy log       # tail the background log
trace-lens proxy restart   # reload the config
trace-lens proxy stop
trace-lens proxy run       # run in the foreground instead
```

Then configure your application, for example:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8600/openai/v1
export ANTHROPIC_BASE_URL=http://127.0.0.1:8600/anthropic
```

Open the UI URL shown by `status`. It lists the captured files, follows the newest file by default, and refreshes live.

### Config

`~/.trace-lens/proxy.json` (override with `--config <file>`; set `TRACE_LENS_HOME` to move the whole state directory):

```json
{
  "host": "127.0.0.1",
  "port": 8600,
  "dataDir": "./captures",
  "sessionIdleMinutes": 30,
  "ui": { "enabled": true, "port": 3117 },
  "endpoints": [
    { "name": "openai", "upstream": "https://api.openai.com" },
    { "name": "anthropic", "upstream": "https://api.anthropic.com" },
    { "name": "internal", "upstream": "http://llm-gateway.internal/v1", "port": 8601, "headers": { "x-app": "demo" } }
  ]
}
```

| Endpoint field | Description |
| -------------- | ----------- |
| `name` | Route name. The endpoint is served at `http://<host>:<port>/<name>/...` |
| `upstream` | Upstream base URL. The path after `/<name>` is appended to it |
| `port` | Optional dedicated port, served without the `/<name>` prefix (for clients that cannot use a path in the base URL) |
| `format` | Optional: `openai-chat`, `openai-responses` or `anthropic-messages`. Detected from the request path by default |
| `headers` | Optional headers added to every upstream request |

`ui.host` (defaults to `host`) and `ui.auth` (`"user:password"`, HTTP Basic auth) let you expose only the viewer, e.g. keep the proxy on `127.0.0.1` and set `"ui": { "host": "0.0.0.0", "port": 3117, "auth": "admin:change-me" }`. The viewer shows full prompts and responses, so do not expose it without auth. Captures never store request headers, so API keys sent by clients are not written to disk; but never expose the proxy port if an endpoint injects credentials via `headers`.

`dataDir` is resolved relative to the config file. Requests other than chat completions / responses / messages (e.g. `/models`) are proxied but not captured.

### How calls are linked

- **Same agent**: a request whose message history starts with a previous request plus its response continues that agent. Cache markers, thinking blocks and whitespace are ignored when comparing.
- **Sub-agent**: a new conversation whose first user message contains text from a recent tool call's arguments (or vice versa) becomes a sub-agent of the caller, with spawn/result edges.
- **Side calls**: a request that extends an agent's history but has both a different system prompt and a different tool set (e.g. title generation) goes to a separate `side-N` lane.
- **Auxiliary calls**: a new conversation whose user text quotes a recent reply of an agent (e.g. "Conversation Context: … Assistant: …" prompts for titles or follow-up suggestions) also goes to that agent's `side-N` lane.
- **New conversation**: anything else starts a new trace file. Conversations idle longer than `sessionIdleMinutes` are not continued.

Each entry records how it was linked in `capture.correlation`, plus `capture.retryOf` / `capture.branchFrom`, `toolsChanged` (tools added/removed since the agent's previous call) and `systemChanged`.

### Storage format

Captured files use a compact format (`traceVersion: 3`): every message and tool list is stored once per file as a `{"kind":"blob","id":...,"value":...}` line, and entries reference them via `messageRefs` / `toolsRef`. The viewer, downloads and Organize always see fully expanded entries. Client-written trace files are read as before.

For exact linking, send these optional headers (they are stripped before forwarding):

| Header | Description |
| ------ | ----------- |
| `x-trace-lens-session` | Group calls into one trace file |
| `x-trace-lens-agent` | Stable agent id; bypasses inference |
| `x-trace-lens-agent-label` | Display label for the agent lane |
| `x-trace-lens-parent-agent` | Parent agent id |
| `x-trace-lens-parent-tool-call` | Tool call id that spawned this agent |

## Development

```bash
# Install dependencies
npm install

# Start the Vite UI dev server
npm run dev

# In another terminal, start the API server against a sample trace file
npm run build:server
node ./dist/server/cli.js ./logs/trace.jsonl --port 3117 --no-open

# Build for production
npm run build

# Type check
npm run typecheck

# Publish a patch release (also supports minor, major, or an explicit version)
npm run release -- patch
```

The Vite dev server runs at `http://localhost:5173` and proxies API requests to `http://localhost:3117`.

## License

MIT
