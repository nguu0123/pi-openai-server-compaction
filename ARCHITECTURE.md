# Architecture

## Design goal

The extension adds OpenAI Responses compaction without taking ownership of Pi's provider transport. It maintains two context representations:

1. **Portable Pi state**
   - normal session JSONL entries;
   - a readable text summary;
   - usable after disable, uninstall, model switch, fork, tree navigation, and export.

2. **OpenAI-native state**
   - bounded retained user messages;
   - one opaque Responses `compaction` item;
   - reusable only by the exact provider, API, and model that created it.

Pi's local session remains authoritative.

## Normal turn

Before the first remote compaction, the extension does not change provider requests.

After a remote compaction:

1. `message_end` appends compatible user, assistant, and tool-result messages to runtime replay state.
2. Pi builds its normal Responses request with the portable summary.
3. `before_provider_request` records the current reasoning and text request settings.
4. If validated remote state matches the active model, the hook replaces `input` with the explicit remote history.
5. Pi's built-in provider sends and streams the request.

The extension does not register a provider. It does not implement WebSocket streaming, set `store: true`, add `context_management`, or use `previous_response_id`.

## Compaction turn

1. Pi emits `session_before_compact`.
2. The extension verifies that it is enabled and that the selected model is a supported direct OpenAI or OpenAI Codex Responses model.
3. It converts the current compatible history to Responses input items.
4. It starts two operations in parallel:
   - portable summary generation;
   - remote Responses compaction v2.
5. The remote request appends `{ "type": "compaction_trigger" }` and uses `stream: true`, `store: false`, current tools, system instructions, reasoning settings, and text settings.
6. The response must complete and contain exactly one well-formed `compaction` item.
7. The extension retains recent user messages within a 20K approximate token budget and places the opaque item last.
8. Pi stores the portable summary and validated remote details in one compaction entry.

## Failure matrix

| Portable summary | Remote result | Action |
|---|---|---|
| Success | Success | Store summary and remote details |
| Success | Failure | Store summary only |
| Failure | Success | Discard remote result; use Pi's default compactor |
| Failure | Failure | Use Pi's default compactor |

An opaque artifact is never accepted as the only portable context.

## Remote request bounds

Each remote attempt has a five-minute timeout. The request can retry twice after the initial attempt.

Retryable conditions:

- network `TypeError` failures;
- internal timeout;
- HTTP `408`, `409`, `425`, `429`, or `5xx`.

Non-retryable conditions:

- caller cancellation;
- malformed SSE JSON;
- missing or malformed compaction items;
- provider error events;
- authentication errors and other permanent `4xx` responses.

The selected API key is authoritative. Case-insensitive inherited `Authorization` headers are removed before the final bearer header is set.

## Persistence schema

Remote state is stored under `CompactionEntry.details.remoteCompaction`:

```json
{
  "version": 2,
  "provider": "openai-responses-compaction",
  "implementation": "responses_compaction_v2",
  "modelKey": "openai:openai-responses:gpt-5.4",
  "replacementHistory": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "..." }]
    },
    {
      "type": "compaction",
      "encrypted_content": "..."
    }
  ],
  "usage": {}
}
```

Version 1 legacy entries remain readable if they pass the same strict message and artifact validation.

Validation rejects the complete remote state when:

- `modelKey` is malformed;
- an item has an unknown persisted type;
- a message has an invalid role or content shape;
- encrypted content is absent or empty;
- there is not exactly one artifact;
- the artifact is not the final item;
- a version 2 artifact is not type `compaction`.

Pi then continues with the readable summary.

## Runtime state

`src/state.ts` keeps two maps keyed by Pi session ID:

- reconstructed remote compaction state;
- the last observed Responses reasoning and text request shape, including its model key.

Lifecycle behavior:

- session start: clear request shape and reconstruct persisted remote state;
- switch, fork, or tree change before navigation: clear runtime state;
- tree navigation or compaction completion: reconstruct remote state;
- model selection: clear request shape;
- agent settled after a final error: discard the failed pending turn;
- shutdown: clear all maps.

## Cross-model behavior

Remote state uses a model key composed of provider, API, and model ID.

- A different model cannot receive the artifact.
- While another model is active, its messages are not appended to the artifact history.
- Aborted turns are discarded immediately. Error turns remain pending for an immediate automatic retry, but a new user turn discards the failed turn before replay.
- Switching back to the original model restores same-process replay.
- Resume reconstruction includes a post-compaction turn only when its assistant message matches the artifact model. This prevents an intervening other-model turn from entering replay.

## Key modules

### `src/index.ts`

Owns extension hooks, lifecycle synchronization, local/remote result policy, and payload replay.

### `src/remote-compaction.ts`

Owns message conversion, request construction, headers, timeout/retry, SSE parsing, strict validation, persisted details, and resume reconstruction.

### `src/openai.ts`

Owns supported-model detection, model keys, request-shape extraction, and remote input replacement.

### `src/config.ts`

Loads `enabled` and `notify` from global config, project config, and environment overrides.

### `src/state.ts`

Stores ephemeral runtime state only. It does not write session data.

## Verification

- `npm test` runs TypeScript checks and the offline smoke suite.
- `npm run test:live` runs credential-backed Pi RPC scenarios.

The offline suite covers provider non-override, disabled behavior, request replay, malformed state, malformed SSE, authorization precedence, retry bounds, timeout, repeated compaction reconstruction, and existing serialization behavior.
