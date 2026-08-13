import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");

function packagePathSegments(packageName) {
  return packageName.split("/");
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function candidateRoots() {
  const roots = new Set();
  roots.add(localNodeModules);

  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.add(globalRoot);

  const voltaPiRoot = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "packages",
    "@earendil-works",
    "pi-coding-agent",
    "lib",
    "node_modules",
  );
  roots.add(voltaPiRoot);
  roots.add(join(voltaPiRoot, "@earendil-works", "pi-coding-agent", "node_modules"));

  return [...roots];
}

function resolveInstalledPackageDir(packageName) {
  const segments = packagePathSegments(packageName);
  for (const root of candidateRoots()) {
    const dir = join(root, ...segments);
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      return dir;
    }
  }
  return undefined;
}

function ensureLocalPeerLink(packageName) {
  const localDir = join(localNodeModules, ...packagePathSegments(packageName));
  if (existsSync(join(localDir, "package.json"))) {
    return;
  }

  const targetDir = resolveInstalledPackageDir(packageName);
  if (!targetDir) {
    throw new Error(
      `Unable to locate peer dependency ${packageName}. Install Pi or add the package locally before running smoke.`,
    );
  }

  mkdirSync(dirname(localDir), { recursive: true });
  if (existsSync(localDir)) {
    const stat = lstatSync(localDir);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(localDir, { recursive: true, force: true });
    }
  }
  symlinkSync(targetDir, localDir, "dir");
}

for (const packageName of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]) {
  ensureLocalPeerLink(packageName);
}

const {
  default: extensionFactory,
  mergeCompactionResults,
} = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");
const { buildSessionContext, convertToLlm } = await import("@earendil-works/pi-coding-agent");

const {
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildPortableSummaryPrompt,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  extractRemoteCompactionDetails,
  isValidRemoteReplacementHistory,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  clearAllRuntimeState,
  getRemoteCompactionState,
  setRemoteCompactionState,
} = await import(pathToFileURL(join(repoRoot, "src", "state.ts")).href);

const targetModelKey = "openai:openai-responses:gpt-5.4-nano";
const mergeModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5.4-nano",
};
const portableSummary = {
  summary: "Portable state",
  firstKeptEntryId: "keep-1",
  tokensBefore: 100,
  estimatedTokensAfter: 20,
  details: { readFiles: ["README.md"] },
};
const remoteSuccess = {
  status: "fulfilled",
  value: { output: [{ type: "compaction", encrypted_content: "MERGE_ENCRYPTED" }] },
};
assert.equal(
  mergeCompactionResults(
    mergeModel,
    { status: "rejected", reason: new Error("summary failed") },
    remoteSuccess,
  ),
  undefined,
  "remote compaction must be discarded without a portable summary",
);
assert.deepEqual(
  mergeCompactionResults(
    mergeModel,
    { status: "fulfilled", value: portableSummary },
    { status: "rejected", reason: new Error("remote failed") },
  ),
  portableSummary,
  "portable summary must survive a remote failure",
);
const mergedCompaction = mergeCompactionResults(
  mergeModel,
  { status: "fulfilled", value: portableSummary },
  remoteSuccess,
);
assert.ok(mergedCompaction);
assert.equal(mergedCompaction.estimatedTokensAfter, 20);
assert.deepEqual(mergedCompaction.details.localSummaryDetails, portableSummary.details);
assert.equal(
  mergedCompaction.details.remoteCompaction.replacementHistory.at(-1).encrypted_content,
  "MERGE_ENCRYPTED",
);
const repeatedSummaryPrompt = buildPortableSummaryPrompt(
  "NEW_WINDOW_STATE",
  "PREVIOUS_PORTABLE_STATE",
  "Preserve exact identifiers.",
);
assert.match(repeatedSummaryPrompt, /NEW_WINDOW_STATE/);
assert.match(repeatedSummaryPrompt, /PREVIOUS_PORTABLE_STATE/);
assert.match(repeatedSummaryPrompt, /Preserve exact identifiers/);

const reconstructed = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-1",
      details: {
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compact",
          modelKey: targetModelKey,
          replacementHistory: [
            {
              type: "compaction",
              encrypted_content: "ENCRYPTED",
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "user-a1",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_ONE" }],
      },
    },
    {
      type: "message",
      id: "assistant-a1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_ONE" }],
      },
    },
    {
      type: "message",
      id: "user-b1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_ME" }],
      },
    },
    {
      type: "message",
      id: "assistant-b1",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "DROP_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-c1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_WRONG_API" }],
      },
    },
    {
      type: "message",
      id: "assistant-c1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-codex-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "DROP_WRONG_API_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-a2",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_TWO" }],
      },
    },
    {
      type: "message",
      id: "assistant-a2",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_TWO" }],
      },
    },
  ],
});
assert.ok(reconstructed, "expected reconstructed remote compaction state");
const reconstructedJson = JSON.stringify(reconstructed.explicitHistory);
assert.match(reconstructedJson, /KEEP_ME_ONE/);
assert.match(reconstructedJson, /KEEP_REPLY_ONE/);
assert.match(reconstructedJson, /KEEP_ME_TWO/);
assert.match(reconstructedJson, /KEEP_REPLY_TWO/);
assert.doesNotMatch(reconstructedJson, /DROP_ME/);
assert.doesNotMatch(reconstructedJson, /DROP_REPLY/);
assert.doesNotMatch(reconstructedJson, /DROP_WRONG_API/);

const failureBoundaryDetails = {
  remoteCompaction: buildRemoteCompactionDetails(
    mergeModel,
    [{ type: "compaction", encrypted_content: "FAILURE_BOUNDARY" }],
  ),
};
const reconstructedAfterAbort = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    { type: "compaction", id: "cmp-abort", details: failureBoundaryDetails },
    {
      type: "message",
      id: "aborted-user",
      message: { role: "user", content: [{ type: "text", text: "ABORTED_USER" }] },
    },
    {
      type: "message",
      id: "aborted-assistant",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [],
        stopReason: "aborted",
      },
    },
    {
      type: "message",
      id: "fresh-user",
      message: { role: "user", content: [{ type: "text", text: "FRESH_USER" }] },
    },
    {
      type: "message",
      id: "fresh-assistant",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "FRESH_ASSISTANT" }],
        stopReason: "stop",
      },
    },
  ],
});
assert.ok(reconstructedAfterAbort);
assert.match(JSON.stringify(reconstructedAfterAbort.explicitHistory), /FRESH_USER|FRESH_ASSISTANT/);
assert.doesNotMatch(JSON.stringify(reconstructedAfterAbort.explicitHistory), /ABORTED_USER/);

const reconstructedAfterRetry = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    { type: "compaction", id: "cmp-retry", details: failureBoundaryDetails },
    {
      type: "message",
      id: "retry-user",
      message: { role: "user", content: [{ type: "text", text: "RETRY_USER" }] },
    },
    {
      type: "message",
      id: "retry-error",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [],
        stopReason: "error",
      },
    },
    {
      type: "message",
      id: "retry-success",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "RETRY_SUCCESS" }],
        stopReason: "stop",
      },
    },
  ],
});
assert.ok(reconstructedAfterRetry);
assert.match(JSON.stringify(reconstructedAfterRetry.explicitHistory), /RETRY_USER|RETRY_SUCCESS/);

const requestBody = buildRemoteCompactionRequestBody({
  model: {
    id: "gpt-5.4-nano",
  },
  input: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.equal(requestBody.model, "gpt-5.4-nano");
assert.equal(requestBody.stream, true);
assert.equal(requestBody.store, false);
assert.equal(requestBody.tool_choice, "auto");
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  }),
  "https://api.openai.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  }),
  "https://chatgpt.com/backend-api/codex/responses",
);

const parsedV2Events = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "V2_ENCRYPTED" },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedV2Events.compactionItem.type, "compaction");
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");
assert.throws(
  () => buildRemoteCompactionV2History(
    [{ type: "message", role: "user", content: "invalid persisted content" }],
    parsedV2Events.compactionItem,
  ),
  /invalid replacement history/,
);

const normalizedPromptItems = normalizeResponseItemsForPrompt(
  [
    { type: "ghost_snapshot", data: "hidden" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
    { type: "function_call", name: "read", call_id: "call-1", arguments: "{}" },
    { type: "function_call_output", call_id: "orphan", output: "drop" },
    { type: "image_generation_call", result: "base64" },
  ],
  { input: ["text"] },
);
assert.equal(normalizedPromptItems[0].type, "message");
assert.deepEqual(normalizedPromptItems[0].content, [
  { type: "input_text", text: "image content omitted because you do not support image input" },
]);
assert.deepEqual(normalizedPromptItems[2], {
  type: "function_call_output",
  call_id: "call-1",
  output: "aborted",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(compactedHistory.map((item) => item.type), ["message", "message", "compaction"]);
assert.equal(compactedHistory[0].role, "user");
assert.equal(compactedHistory[1].role, "assistant");

const compactionHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  apiKey: "sk-test",
  sessionId: "session-123",
  headers: {
    "x-extra": "yes",
    Authorization: "Bearer stale-uppercase",
    authorization: "Bearer stale-lowercase",
    session_id: "stale-session",
    "X-Codex-Window-Id": "stale-window",
    "x-codex-installation-id": "stale-installation",
  },
});
assert.equal(compactionHeaders.authorization, "Bearer sk-test");
assert.deepEqual(
  Object.keys(compactionHeaders).filter((name) => name.toLowerCase() === "authorization"),
  ["authorization"],
);
assert.equal(compactionHeaders.session_id, "session-123");
assert.equal(compactionHeaders["x-codex-window-id"], "session-123:0");
assert.match(compactionHeaders["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
assert.doesNotMatch(JSON.stringify(compactionHeaders), /stale-session|stale-window|stale-installation/);
assert.equal(compactionHeaders["x-extra"], "yes");
assert.equal(compactionHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(compactionHeaders.accept, "text/event-stream");

const detailsRoundTrip = extractRemoteCompactionDetails({
  remoteCompaction: buildRemoteCompactionDetails(
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.4-nano",
    },
    [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);

const portableContextWithoutExtension = buildSessionContext([
  {
    type: "message",
    id: "portable-old",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: "discarded transcript" }],
      timestamp: 1,
    },
  },
  {
    type: "message",
    id: "portable-kept",
    parentId: "portable-old",
    timestamp: new Date(2).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: "kept transcript" }],
      timestamp: 2,
    },
  },
  {
    type: "compaction",
    id: "portable-compaction",
    parentId: "portable-kept",
    timestamp: new Date(3).toISOString(),
    summary: "PORTABLE_SUMMARY_SURVIVES_UNINSTALL",
    firstKeptEntryId: "portable-kept",
    tokensBefore: 100,
    details: {
      remoteCompaction: {
        version: 2,
        provider: "openai-responses-compaction",
        modelKey: targetModelKey,
        replacementHistory: [{ type: "compaction", encrypted_content: "OPAQUE_ONLY" }],
      },
    },
  },
]).messages;
const portableContextJson = JSON.stringify(portableContextWithoutExtension);
assert.match(portableContextJson, /PORTABLE_SUMMARY_SURVIVES_UNINSTALL/);
assert.doesNotMatch(portableContextJson, /OPAQUE_ONLY/);
const portableResponseItems = messagesToResponseItems(convertToLlm(portableContextWithoutExtension));
assert.match(
  JSON.stringify(portableResponseItems),
  /PORTABLE_SUMMARY_SURVIVES_UNINSTALL/,
  "remote compaction without prior remote state must include Pi's existing summary",
);

assert.equal(isValidRemoteReplacementHistory([
  { type: "message", role: "user", content: [{ type: "input_text", text: "retain" }] },
  { type: "compaction", encrypted_content: "ENCRYPTED" },
], 2), true);
assert.equal(isValidRemoteReplacementHistory([
  { type: "compaction", encrypted_content: "" },
], 2), false);
assert.equal(extractRemoteCompactionDetails({
  remoteCompaction: {
    version: 2,
    provider: "openai-responses-compaction",
    modelKey: targetModelKey,
    replacementHistory: [{ type: "compaction" }],
  },
}), undefined);
assert.equal(extractRemoteCompactionDetails({
  remoteCompaction: {
    version: 2,
    provider: "openai-responses-compaction",
    modelKey: "malformed",
    replacementHistory: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  },
}), undefined);
assert.equal(extractRemoteCompactionDetails({
  remoteCompaction: {
    version: 2,
    provider: "openai-responses-compaction",
    modelKey: `${targetModelKey}:extra`,
    replacementHistory: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  },
}), undefined);
assert.throws(() => parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction" },
  },
  { type: "response.completed", response: {} },
]), /malformed compaction item/);

const secondHistory = buildRemoteCompactionV2History(
  [
    ...reconstructed.explicitHistory,
    { type: "message", role: "user", content: [{ type: "input_text", text: "SECOND_WINDOW" }] },
  ],
  { type: "compaction", encrypted_content: "SECOND_ENCRYPTED" },
);
assert.equal(secondHistory.at(-1).encrypted_content, "SECOND_ENCRYPTED");
assert.equal(isValidRemoteReplacementHistory(secondHistory, 2), true);
const reconstructedRepeated = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-old",
      details: {
        remoteCompaction: buildRemoteCompactionDetails(
          { provider: "openai", api: "openai-responses", id: "gpt-5.4-nano" },
          [{ type: "compaction", encrypted_content: "OLD_ENCRYPTED" }],
        ),
      },
    },
    {
      type: "compaction",
      id: "cmp-new",
      details: {
        remoteCompaction: buildRemoteCompactionDetails(
          { provider: "openai", api: "openai-responses", id: "gpt-5.4-nano" },
          secondHistory,
        ),
      },
    },
    {
      type: "message",
      id: "tail-user",
      message: { role: "user", content: [{ type: "text", text: "TAIL_USER" }] },
    },
    {
      type: "message",
      id: "tail-assistant",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "TAIL_ASSISTANT" }],
      },
    },
  ],
});
assert.ok(reconstructedRepeated);
assert.equal(reconstructedRepeated.compactionEntryId, "cmp-new");
assert.match(JSON.stringify(reconstructedRepeated.explicitHistory), /SECOND_ENCRYPTED|TAIL_USER|TAIL_ASSISTANT/);
assert.doesNotMatch(JSON.stringify(reconstructedRepeated.explicitHistory), /OLD_ENCRYPTED/);

const extensionHandlers = new Map();
let providerRegistrations = 0;
extensionFactory({
  on(name, handler) {
    extensionHandlers.set(name, handler);
  },
  registerProvider() {
    providerRegistrations += 1;
  },
  getAllTools() {
    return [];
  },
  getActiveTools() {
    return [];
  },
  getThinkingLevel() {
    return "medium";
  },
});
assert.equal(providerRegistrations, 0, "extension must preserve Pi's native OpenAI provider");

const beforeProviderRequest = extensionHandlers.get("before_provider_request");
assert.equal(typeof beforeProviderRequest, "function");
const messageEnd = extensionHandlers.get("message_end");
assert.equal(typeof messageEnd, "function");
const agentSettled = extensionHandlers.get("agent_settled");
assert.equal(typeof agentSettled, "function");
const replayModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5.4-nano",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
};
const replayContext = {
  cwd: repoRoot,
  model: replayModel,
  hasUI: false,
  ui: { notify() {} },
  sessionManager: {
    getSessionId() { return "replay-session"; },
    getBranch() { return []; },
  },
};
setRemoteCompactionState("replay-session", {
  compactionEntryId: "cmp-runtime-abort",
  modelKey: targetModelKey,
  replacementHistory: [{ type: "compaction", encrypted_content: "RUNTIME_BOUNDARY" }],
  explicitHistory: [{ type: "compaction", encrypted_content: "RUNTIME_BOUNDARY" }],
});
await messageEnd(
  { message: { role: "user", content: [{ type: "text", text: "RUNTIME_ABORTED_USER" }] } },
  replayContext,
);
await messageEnd(
  {
    message: {
      role: "assistant",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4-nano",
      content: [],
      stopReason: "aborted",
    },
  },
  replayContext,
);
await messageEnd(
  { message: { role: "user", content: [{ type: "text", text: "RUNTIME_FRESH_USER" }] } },
  replayContext,
);
await messageEnd(
  {
    message: {
      role: "assistant",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4-nano",
      content: [{ type: "text", text: "RUNTIME_FRESH_ASSISTANT" }],
      stopReason: "stop",
    },
  },
  replayContext,
);
const runtimeAfterAbort = JSON.stringify(getRemoteCompactionState("replay-session")?.explicitHistory);
assert.match(runtimeAfterAbort, /RUNTIME_FRESH_USER|RUNTIME_FRESH_ASSISTANT/);
assert.doesNotMatch(runtimeAfterAbort, /RUNTIME_ABORTED_USER/);

setRemoteCompactionState("replay-session", {
  compactionEntryId: "cmp-runtime-retry",
  modelKey: targetModelKey,
  replacementHistory: [{ type: "compaction", encrypted_content: "RUNTIME_RETRY_BOUNDARY" }],
  explicitHistory: [{ type: "compaction", encrypted_content: "RUNTIME_RETRY_BOUNDARY" }],
});
await messageEnd(
  { message: { role: "user", content: [{ type: "text", text: "RUNTIME_RETRY_USER" }] } },
  replayContext,
);
await messageEnd(
  {
    message: {
      role: "assistant",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4-nano",
      content: [],
      stopReason: "error",
    },
  },
  replayContext,
);
await messageEnd(
  {
    message: {
      role: "assistant",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4-nano",
      content: [{ type: "text", text: "RUNTIME_RETRY_SUCCESS" }],
      stopReason: "stop",
    },
  },
  replayContext,
);
assert.match(
  JSON.stringify(getRemoteCompactionState("replay-session")?.explicitHistory),
  /RUNTIME_RETRY_USER|RUNTIME_RETRY_SUCCESS/,
);

setRemoteCompactionState("replay-session", {
  compactionEntryId: "cmp-runtime-final-error",
  modelKey: targetModelKey,
  replacementHistory: [{ type: "compaction", encrypted_content: "RUNTIME_ERROR_BOUNDARY" }],
  explicitHistory: [{ type: "compaction", encrypted_content: "RUNTIME_ERROR_BOUNDARY" }],
});
await messageEnd(
  { message: { role: "user", content: [{ type: "text", text: "RUNTIME_FINAL_ERROR_USER" }] } },
  replayContext,
);
await messageEnd(
  {
    message: {
      role: "assistant",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4-nano",
      content: [],
      stopReason: "error",
    },
  },
  replayContext,
);
assert.match(
  JSON.stringify(getRemoteCompactionState("replay-session")?.explicitHistory),
  /RUNTIME_FINAL_ERROR_USER/,
);
await agentSettled({}, replayContext);
assert.doesNotMatch(
  JSON.stringify(getRemoteCompactionState("replay-session")?.explicitHistory),
  /RUNTIME_FINAL_ERROR_USER/,
);

setRemoteCompactionState("replay-session", {
  compactionEntryId: "cmp-replay",
  modelKey: targetModelKey,
  replacementHistory: [{ type: "compaction", encrypted_content: "REPLAY_ENCRYPTED" }],
  explicitHistory: [
    { type: "compaction", encrypted_content: "REPLAY_ENCRYPTED" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "CURRENT_USER" }] },
  ],
});
const originalEnabled = process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED;
try {
  process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "1";
  const replayPayload = await beforeProviderRequest(
    {
      payload: {
        model: replayModel.id,
        input: [{ type: "message", role: "user", content: "portable" }],
        previous_response_id: "stale-response",
        conversation: "stale-conversation",
      },
    },
    replayContext,
  );
  assert.match(JSON.stringify(replayPayload.input), /REPLAY_ENCRYPTED|CURRENT_USER/);
  assert.equal(replayPayload.previous_response_id, undefined);
  assert.equal(replayPayload.conversation, undefined);

  process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = "0";
  const disabledPayload = await beforeProviderRequest(
    { payload: { model: replayModel.id, input: [{ type: "message", role: "user", content: "portable" }] } },
    replayContext,
  );
  assert.equal(disabledPayload, undefined, "disabled extension must leave Pi's portable payload unchanged");
} finally {
  if (originalEnabled === undefined) delete process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED;
  else process.env.PI_OPENAI_SERVER_COMPACTION_ENABLED = originalEnabled;
  clearAllRuntimeState();
}

const successSse = [
  `data: ${JSON.stringify({
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "FETCH_ENCRYPTED" },
  })}`,
  `data: ${JSON.stringify({ type: "response.completed", response: {} })}`,
  "",
].join("\n\n");
const remoteCallParams = {
  model: replayModel,
  apiKey: "sk-test",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact me" }] }],
  tools: [],
  parallelToolCalls: true,
  timeoutMs: 1_000,
  retryDelayMs: 0,
};
const originalFetch = globalThis.fetch;
try {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("temporary", { status: 503 })
      : new Response(successSse, { status: 200 });
  };
  const retried = await callRemoteCompactionEndpoint({ ...remoteCallParams, maxRetries: 1 });
  assert.equal(attempts, 2, "transient failure should be retried once");
  assert.equal(retried.output.at(-1).encrypted_content, "FETCH_ENCRYPTED");

  attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("bad request", { status: 400 });
  };
  await assert.rejects(
    callRemoteCompactionEndpoint({ ...remoteCallParams, maxRetries: 2 }),
    /failed \(400\)/,
  );
  assert.equal(attempts, 1, "permanent HTTP failure must not be retried");

  attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("temporary", { status: 503 });
  };
  await assert.rejects(
    callRemoteCompactionEndpoint({ ...remoteCallParams, maxRetries: 99 }),
    /failed \(503\)/,
  );
  assert.equal(attempts, 3, "retry overrides must not exceed two retries");

  attempts = 0;
  globalThis.fetch = async (_url, init) => {
    attempts += 1;
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  await assert.rejects(
    callRemoteCompactionEndpoint({ ...remoteCallParams, timeoutMs: 10, maxRetries: 0 }),
    /timed out after 10ms/,
  );
  assert.equal(attempts, 1, "timeout should stay within the configured attempt bound");

  attempts = 0;
  const callerAbort = new AbortController();
  globalThis.fetch = async (_url, init) => {
    attempts += 1;
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  const abortedCall = callRemoteCompactionEndpoint({
    ...remoteCallParams,
    maxRetries: 2,
    signal: callerAbort.signal,
  });
  callerAbort.abort(new Error("caller cancelled"));
  await assert.rejects(abortedCall, /caller cancelled/);
  assert.equal(attempts, 1, "caller cancellation must not be retried");

  globalThis.fetch = async () => new Response(
    "data: {not-json}\n\ndata: [DONE]\n\n",
    { status: 200 },
  );
  await assert.rejects(
    callRemoteCompactionEndpoint({ ...remoteCallParams, maxRetries: 2 }),
    /malformed SSE JSON/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("smoke ok");
