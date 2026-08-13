# Test plan

## Goals

1. Verify Responses compaction v2 request and replay behavior.
2. Verify that Pi retains its native provider transport.
3. Verify that every accepted opaque artifact has a portable summary.
4. Verify fail-closed handling for malformed or incompatible persisted state.
5. Verify bounded network failure behavior.
6. Verify resume, fork, tree, repeated compaction, and model-switch safety.

## Offline automated checks

Run:

```bash
npm test
```

The smoke suite must verify:

- the extension factory does not call `registerProvider`;
- Pi `0.84.1` imports and types compile;
- direct OpenAI and OpenAI Codex endpoints are correct;
- requests include `store: false` and one trailing `compaction_trigger`;
- inherited `Authorization` headers cannot replace the selected credential;
- response normalization removes stale developer/ghost state and repairs tool-call pairs;
- unsupported images are replaced safely;
- returned and persisted opaque items require non-empty encrypted content;
- malformed persisted details fail closed as a complete unit;
- version 2 history has exactly one final `compaction` item;
- repeat compaction uses the newest artifact;
- cross-model turns do not enter reconstructed replay;
- failed or aborted turns are dropped before a new user turn, while immediate automatic retries keep their original user input;
- enabled replay replaces provider input through `before_provider_request`;
- disabled mode leaves Pi's portable payload unchanged;
- Pi core projects the readable summary while ignoring opaque extension details;
- transient HTTP failure retries within the configured bound;
- permanent `4xx` failure does not retry;
- timeout aborts an attempt;
- malformed SSE does not retry.

## Live automated checks

Live tests use real provider credentials and incur API usage:

```bash
npm run test:live
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai/gpt-5.4 npm run test:live
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.4 npm run test:live
```

The current RPC harness covers:

- same-process opaque continuity after compaction;
- recovery of information absent from visible retained plaintext;
- model switch away and back;
- fork after compaction;
- resume after compaction;
- resume after a model round trip.

## Required release regressions

Before releasing 0.2, add or run these scenarios against Pi `0.84.x`:

### Repeated compaction

1. Store a fact.
2. Compact.
3. Add another fact.
4. Compact again.
5. Verify both facts on the original model.
6. Restart and verify both facts again.
7. Confirm the latest session entry contains one final artifact and no obsolete artifact.

### Disabled extension

1. Compact with the extension enabled and without instructions that omit the test fact.
2. Set `PI_OPENAI_SERVER_COMPACTION_ENABLED=0`.
3. Restart the same session with the extension still loaded.
4. Verify that the portable summary supports continuation.
5. Inspect the outgoing request and confirm no opaque history injection.

### Extension absent

1. Compact with the extension enabled and preserve a test fact in the summary.
2. Restart the same session without loading this extension.
3. Verify that Pi continues from the portable summary.
4. Confirm session loading does not depend on extension-specific code.

### Malformed persisted details

1. Copy a test session.
2. Remove `encrypted_content`, add an unknown item, and corrupt `modelKey` in separate copies.
3. Resume each copy.
4. Verify that Pi uses the readable summary and does not send malformed opaque data.

### Model switch and tree safety

1. Compact on model A.
2. Complete a turn on model B.
3. Navigate the tree and restart.
4. Switch back to model A.
5. Verify that model B's turn is absent from model A's remote replay.

### Native transport

For direct OpenAI models, confirm:

- Pi's normal streaming UI accumulates text correctly;
- usage and cost come from Pi's provider;
- no custom WebSocket connection is opened;
- the extension does not force `store: true`, `context_management`, or `previous_response_id`.

## Manual failure checks

- Cancel compaction and confirm no retry occurs after caller abort.
- Return HTTP `429` or `503` from a proxy and confirm no more than three total attempts.
- Stall a proxy response and confirm each attempt stops at five minutes.
- Return malformed SSE and confirm immediate fallback to the portable summary.
- Cause both portable summary methods to fail and confirm no remote details are persisted.

## Evidence recording

For each credential-backed run, record:

- Pi version;
- provider and model;
- exact command;
- pass/fail result;
- session fixture or redacted JSONL evidence;
- API cost when available;
- any residual risk.

Do not update `VALIDATION.md` with a live-pass claim until the credential-backed suite completes on the stated Pi version.
