# Changelog

## 0.2.0 - Unreleased

- target Pi `>=0.84.1 <0.85.0` and Node `>=22.19.0`
- preserve Pi's native OpenAI provider and remove the custom WebSocket transport override
- remove `previous_response_id`, forced `store: true`, and `context_management` request mutation
- replay validated opaque history for both direct OpenAI and OpenAI Codex through `before_provider_request`
- discard remote compaction when no non-empty portable summary is available
- fall back to the portable summary when only remote compaction fails
- strictly validate returned and persisted messages, model keys, encrypted content, artifact count, and artifact order
- reject malformed persisted remote details as a complete unit instead of filtering individual items
- include Pi's existing portable summary when creating the first remote artifact in an already-compacted session
- require provider, API, and model matches for post-compaction assistant turns
- quarantine aborted and settled failed turns while preserving automatic retry continuity
- make selected credentials and session-derived Codex identity headers authoritative over inherited headers
- add a five-minute per-attempt timeout and at most two retries for classified transient failures
- treat caller aborts, malformed output, provider errors, and permanent `4xx` responses as non-retryable
- key observed Responses request settings by model to prevent stale settings after model changes
- expand offline checks for provider ownership, disabled replay, malformed data, repeated compaction, header precedence, timeout, and retry behavior
- update package metadata and installation instructions for the maintained fork

This version also includes the upstream work after 0.1.0:

- replace legacy `/responses/compact` calls with Responses compaction v2 and a trailing `compaction_trigger`
- retain recent user messages with a 20K approximate token budget
- preserve version 1 session artifact compatibility
- mirror observed Responses reasoning and text settings into compaction requests
- persist compaction usage metadata
- add product-defaults and native-vs-text benchmark evidence and methodology corrections

## 0.1.0 - 2026-04-09

- initial public release
- add hybrid remote compaction for direct OpenAI Responses models
- add legacy `POST /v1/responses/compact` integration
- persist opaque replacement history in Pi compaction details
- reconstruct remote state across resume, reload, and tree navigation
- add a custom WebSocket transport and conservative `previous_response_id` reuse
- preserve portable Pi text summaries as the readable fallback
- filter post-compaction turns from other models during reconstruction
- add live Pi RPC and offline smoke harnesses
- add architecture, test, validation, benchmark, packaging, and license documentation
