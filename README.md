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
