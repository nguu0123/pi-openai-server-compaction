# pi-openai-server-compaction

This Pi extension adds Codex-style server-side compaction for supported OpenAI Responses models. It stores both:

- an opaque OpenAI `compaction` item for high-fidelity continuation on the same model; and
- a readable Pi summary for resume, export, model switching, disabling, and uninstall safety.

The extension uses the current Responses compaction v2 protocol. It sends a normal Responses request with a trailing `{ "type": "compaction_trigger" }`.

> **Status:** experimental. Version 0.2 targets Pi `0.84.x`. Install it project-local first and keep rollback easy.

## Why use it?

The retained upstream product-defaults benchmark measured 78% exact recall for native compaction and 48% for Pi's default compactor. Full context scored 100%. Native compaction also used substantially more tokens and had variable output size.

This result does not prove equal-budget superiority. See [`benchmarks/product-defaults/REPORT.md`](benchmarks/product-defaults/REPORT.md).

## Support matrix

| Provider/model family | Remote compaction | Opaque replay | Pi native transport |
|---|---:|---:|---:|
| `openai/*` Responses models | Yes | Exact model only | Preserved |
| `openai-codex/*` | Yes | Exact model only | Preserved |
| Azure OpenAI | No | No | Preserved |
| Other providers | No | Portable Pi summary only | Preserved |

The extension does not register or override a provider. Pi keeps ownership of normal HTTP streaming, retry behavior, usage accounting, and model options.

## Install

Project-local, recommended:

```bash
pi install -l git:github.com/nguu0123/pi-openai-server-compaction
```

Global:

```bash
pi install git:github.com/nguu0123/pi-openai-server-compaction
```

One-shot:

```bash
git clone https://github.com/nguu0123/pi-openai-server-compaction.git
cd pi-openai-server-compaction
npm install
pi -e ./src/index.ts --model openai/gpt-5.4
```

## Requirements

- Node `>=22.19.0`
- Pi `>=0.84.1 <0.85.0`
- Existing Pi authentication for the selected model
- A supported OpenAI Responses model

## How compaction works

On `session_before_compact`, the extension runs two operations in parallel:

1. Generate a portable text summary. It first summarizes the full branch. It then falls back to Pi's built-in compactor.
2. Request Responses compaction v2 with the current history, system instructions, tools, reasoning settings, text settings, and a trailing `compaction_trigger`.

When both operations succeed, Pi stores the text summary and `details.remoteCompaction`. The remote details contain bounded retained user messages followed by exactly one validated opaque `compaction` item.

On later requests to the exact same model, `before_provider_request` replaces Pi's summarized input with the validated remote history. Normal provider transport remains unchanged.

## Failure behavior

- If remote compaction fails, the extension stores only the portable summary.
- If portable summary generation fails, the extension discards any remote result and returns control to Pi's default compactor.
- If persisted remote data is malformed, the extension ignores it and Pi uses the portable summary.
- Remote requests have a five-minute timeout per attempt and at most two retries.
- Retries apply only to network failures, timeouts, HTTP `408`, `409`, `425`, `429`, and `5xx` responses.
- Caller cancellation, malformed output, authentication failures, and other permanent `4xx` responses are not retried.

This policy prevents an opaque artifact from becoming the only surviving context.

## Safety and portability

- Replay is restricted to the exact provider, API, and model that produced the artifact.
- Cross-model turns are not added to opaque replay history.
- Aborted turns are removed immediately. Error turns keep their user input for an automatic retry, then are removed when the agent settles or a new user turn starts.
- Session start, switch, fork, tree navigation, compaction, model selection, and shutdown synchronize or clear relevant runtime state.
- Disabling or removing the extension leaves Pi's readable summary as the active context.
- Persisted replacement history is validated as a complete unit. Invalid entries are not partially replayed.
- The selected credential replaces any inherited `Authorization` header for the compaction request.

## Data handling

- The full compacted context is sent to the selected OpenAI backend.
- Compaction requests set `store: false`.
- Opaque encrypted artifacts are stored in the local Pi session JSONL.
- Normal model requests use Pi's native provider behavior. This extension does not force `store: true` or use `previous_response_id`.

## Configuration

Configuration is read from:

- `~/.pi/agent/openai-server-compaction.json`
- `.pi/openai-server-compaction.json`, which takes precedence

```json
{
  "enabled": true,
  "notify": false
}
```

Environment overrides:

| Variable | Effect |
|---|---|
| `PI_OPENAI_SERVER_COMPACTION_ENABLED` | Enable or disable compaction and replay |
| `PI_OPENAI_SERVER_COMPACTION_NOTIFY` | Show one UI notice when remote replay activates |

## Troubleshooting

1. Disable: set `PI_OPENAI_SERVER_COMPACTION_ENABLED=0`.
2. Bypass all extensions: run Pi with `--no-extensions`.
3. Reload: run `/reload`.
4. Remove: run `pi remove pi-openai-server-compaction`.
5. Inspect the session JSONL for `compaction` entries with `details.remoteCompaction`.

## Testing

Offline verification covers strict validation, disabled replay, Pi-core summary projection with opaque details ignored, bounded retries, timeout, header precedence, and repeated reconstruction:

```bash
npm test
```

Live end-to-end verification requires working provider credentials and incurs API usage:

```bash
npm run test:live
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.4 npm run test:live
```

The live harness covers same-process replay, reduced-plaintext replay, model switching, fork, resume, and resume after a model round trip. See [`VALIDATION.md`](VALIDATION.md) for the distinction between current offline checks and retained upstream live evidence.

## Limitations

- Pi's session JSONL and tree remain authoritative.
- Opaque replay works only with the exact model that created it.
- Compaction usage is stored in details but is not added to Pi's session statistics.
- The current five-minute timeout applies to each attempt, so two retries can extend total compaction time.
- Current 0.2 changes require a fresh credential-backed live regression before release.

## Repository layout

| File | Purpose |
|---|---|
| `src/index.ts` | Extension hooks, lifecycle, summary policy, and replay |
| `src/remote-compaction.ts` | Request construction, validation, retry, persistence, and reconstruction |
| `src/openai.ts` | Supported-model detection and payload helpers |
| `src/config.ts` | Configuration loading |
| `src/state.ts` | Ephemeral session state |
| `scripts/smoke.mjs` | Offline compatibility and failure-mode tests |
| `tests/live/openai-compaction-rpc-live.ts` | Credential-backed Pi RPC regression suite |

## License

MIT. See [`LICENSE.md`](LICENSE.md).
