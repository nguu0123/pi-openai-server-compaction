/**
 * Main extension entrypoint.
 *
 * Wires together remote compaction, request replay, runtime state
 * reconstruction, and session lifecycle cleanup.
 */
import {
  buildSessionContext,
  convertToLlm,
  type CompactionResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRecord, loadConfig } from "./config.ts";
import {
  applyRemoteHistoryPayloadPatch,
  extractResponsesReasoningConfig,
  extractResponsesTextConfig,
  looksLikeResponsesPayload,
  messageMatchesModel,
  modelKey,
  supportsRemoteCompactionModel,
  thinkingLevelToResponsesReasoning,
} from "./openai.ts";
import {
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  generateBestEffortLocalSummary,
  messageToResponseItems,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  reconstructRemoteCompactionStateFromBranch,
  type RemoteCompactionResult,
} from "./remote-compaction.ts";
import {
  clearAllRuntimeState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
} from "./state.ts";

type TargetModel = Parameters<typeof modelKey>[0];
type CompactionModel = Parameters<typeof buildRemoteCompactionDetails>[0];

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
};

type SessionContextLike = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
  };
};

function getSessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function normalizeHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        entry[1] !== null && entry[0].toLowerCase() !== "authorization",
    ),
  );
}

function getBranchMessages(branchEntries: BranchEntry[]): AgentMessage[] {
  return branchEntries.flatMap((entry) =>
    entry.type === "message" && entry.message ? [entry.message as AgentMessage] : [],
  );
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
  }
  return undefined;
}

function clearSessionRuntimeState(sessionId: string | undefined): void {
  clearRemoteCompactionState(sessionId);
  clearResponsesRequestShapeState(sessionId);
}

function syncRemoteState(ctx: SessionContextLike): void {
  const sessionId = getSessionId(ctx);
  const branchEntries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    id: string;
    details?: unknown;
    message?: AgentMessage;
  }>;
  const state = reconstructRemoteCompactionStateFromBranch({ branchEntries });
  if (state) {
    setRemoteCompactionState(sessionId, state);
  } else {
    clearRemoteCompactionState(sessionId);
  }
}

function getMatchingRemoteState(
  sessionId: string,
  model: TargetModel | undefined,
): ReturnType<typeof getRemoteCompactionState> {
  if (!model) return undefined;
  const remoteState = getRemoteCompactionState(sessionId);
  return remoteState && remoteState.modelKey === modelKey(model) ? remoteState : undefined;
}

function extendRemoteHistoryIfCompatible(params: {
  sessionId: string;
  model: TargetModel | undefined;
  message: AgentMessage;
}): void {
  const remoteState = getMatchingRemoteState(params.sessionId, params.model);
  if (!remoteState || !params.model) return;
  if (params.message.role === "assistant" && params.message.stopReason === "aborted") {
    const explicitHistory = remoteState.pendingTurnStartIndex === undefined
      ? remoteState.explicitHistory
      : remoteState.explicitHistory.slice(0, remoteState.pendingTurnStartIndex);
    setRemoteCompactionState(params.sessionId, {
      ...remoteState,
      explicitHistory,
      pendingTurnStartIndex: undefined,
      pendingTurnFailed: false,
    });
    return;
  }
  if (params.message.role === "assistant" && params.message.stopReason === "error") {
    setRemoteCompactionState(params.sessionId, {
      ...remoteState,
      pendingTurnFailed: true,
    });
    return;
  }

  const items = messageToResponseItems(params.message);
  if (items.length === 0) return;

  if (params.message.role === "user") {
    const shouldDiscardFailedTurn =
      remoteState.pendingTurnFailed && remoteState.pendingTurnStartIndex !== undefined;
    const explicitHistory = shouldDiscardFailedTurn
      ? remoteState.explicitHistory.slice(0, remoteState.pendingTurnStartIndex)
      : remoteState.explicitHistory;
    setRemoteCompactionState(params.sessionId, {
      ...remoteState,
      explicitHistory: [...explicitHistory, ...items],
      pendingTurnStartIndex: shouldDiscardFailedTurn || remoteState.pendingTurnStartIndex === undefined
        ? explicitHistory.length
        : remoteState.pendingTurnStartIndex,
      pendingTurnFailed: false,
    });
    return;
  }

  if (params.message.role === "assistant") {
    if (!messageMatchesModel(params.message, params.model)) return;
    setRemoteCompactionState(params.sessionId, {
      ...remoteState,
      explicitHistory: [...remoteState.explicitHistory, ...items],
      pendingTurnStartIndex: params.message.stopReason === "toolUse"
        ? remoteState.pendingTurnStartIndex
        : undefined,
      pendingTurnFailed: false,
    });
    return;
  }

  setRemoteCompactionState(params.sessionId, {
    ...remoteState,
    explicitHistory: [...remoteState.explicitHistory, ...items],
  });
}

function discardSettledFailedTurn(sessionId: string): void {
  const remoteState = getRemoteCompactionState(sessionId);
  if (!remoteState?.pendingTurnFailed) return;
  const explicitHistory = remoteState.pendingTurnStartIndex === undefined
    ? remoteState.explicitHistory
    : remoteState.explicitHistory.slice(0, remoteState.pendingTurnStartIndex);
  setRemoteCompactionState(sessionId, {
    ...remoteState,
    explicitHistory,
    pendingTurnStartIndex: undefined,
    pendingTurnFailed: false,
  });
}

function maybeNotifyRequestFeatures(params: {
  notifiedModels: Set<string>;
  hasUI: boolean;
  notify: boolean;
  ui: { notify(message: string, level: "info" | "warning"): void };
  model: TargetModel;
  features: string[];
}): void {
  if (!params.notify || !params.hasUI || params.features.length === 0) return;

  const key = `${String(params.model.provider)}/${String(params.model.id)}`;
  const noticeKey = `${key}:${params.features.join(",")}`;
  if (params.notifiedModels.has(noticeKey)) return;

  params.notifiedModels.add(noticeKey);
  params.ui.notify(`OpenAI compaction active for ${key} (${params.features.join(", ")})`, "info");
}

export function mergeCompactionResults(
  model: CompactionModel,
  localResult: PromiseSettledResult<CompactionResult>,
  remoteResult: PromiseSettledResult<RemoteCompactionResult>,
): CompactionResult | undefined {
  if (localResult.status !== "fulfilled") return undefined;
  if (remoteResult.status !== "fulfilled") return localResult.value;

  const localSummary = localResult.value;
  return {
    ...localSummary,
    details: {
      ...(localSummary.details !== undefined ? { localSummaryDetails: localSummary.details } : {}),
      remoteCompaction: buildRemoteCompactionDetails(
        model,
        remoteResult.value.output,
        remoteResult.value.usage,
      ),
    },
  };
}

export default function openaiServerCompactionExtension(pi: ExtensionAPI) {
  const notifiedModels = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    clearResponsesRequestShapeState(sessionId);
    syncRemoteState(ctx);
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearSessionRuntimeState(getSessionId(ctx));
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearResponsesRequestShapeState(getSessionId(ctx));
    syncRemoteState(ctx);
  };
  pi.on("session_tree", syncAfterSessionChange);
  pi.on("session_compact", syncAfterSessionChange);

  pi.on("model_select", (_event, ctx) => {
    clearResponsesRequestShapeState(getSessionId(ctx));
  });

  pi.on("session_shutdown", () => {
    clearAllRuntimeState();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const model = ctx.model;
    if (!cfg.enabled || !model || !supportsRemoteCompactionModel(model)) return undefined;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;
    const headers = normalizeHeaders(auth.headers);

    const tools = buildToolsPayload(pi.getAllTools(), pi.getActiveTools());
    const sessionId = getSessionId(ctx);
    const branchEntries = event.branchEntries as BranchEntry[];
    const remoteState = getMatchingRemoteState(sessionId, model);
    const observedRequestShape = getResponsesRequestShapeState(sessionId);
    const matchingRequestShape = observedRequestShape?.modelKey === modelKey(model)
      ? observedRequestShape
      : undefined;
    const fullBranchMessages = getBranchMessages(branchEntries);
    const portableContextMessages = buildSessionContext(event.branchEntries).messages;
    const responseItems = remoteState
      ? remoteState.explicitHistory
      : messagesToResponseItems(convertToLlm(portableContextMessages) as AgentMessage[]);
    const promptResponseItems = normalizeResponseItemsForPrompt(responseItems, model);
    const thinkingLevel = pi.getThinkingLevel();
    const fallbackReasoning = model.reasoning
      ? thinkingLevelToResponsesReasoning(thinkingLevel ?? getBranchThinkingLevel(branchEntries))
      : undefined;
    const reasoning = matchingRequestShape?.reasoning ?? fallbackReasoning;
    const text = matchingRequestShape?.text;

    const remoteAbortController = new AbortController();
    const remoteSignal = AbortSignal.any([event.signal, remoteAbortController.signal]);
    const localSummaryPromise = generateBestEffortLocalSummary({
      preparation: event.preparation,
      messages: fullBranchMessages,
      model,
      apiKey: auth.apiKey,
      headers,
      customInstructions: event.customInstructions,
      signal: event.signal,
      thinkingLevel,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    });
    const remoteCompactionPromise = callRemoteCompactionEndpoint({
      model,
      apiKey: auth.apiKey,
      headers,
      sessionId,
      input: promptResponseItems,
      instructions: ctx.getSystemPrompt(),
      tools,
      parallelToolCalls: true,
      reasoning,
      text,
      signal: remoteSignal,
    });
    void localSummaryPromise.catch(() => {
      remoteAbortController.abort(
        new DOMException("Remote compaction cancelled because portable summary generation failed.", "AbortError"),
      );
    });

    const [localResult, remoteResult] = await Promise.allSettled([
      localSummaryPromise,
      remoteCompactionPromise,
    ]);

    if (localResult.status !== "fulfilled") {
      if (!event.signal.aborted && ctx.hasUI) {
        const message = localResult.reason instanceof Error ? localResult.reason.message : String(localResult.reason);
        ctx.ui.notify(
          `Portable summary generation failed; discarding remote compaction and falling back to Pi compaction. ${message}`,
          "warning",
        );
      }
      return undefined;
    }

    if (remoteResult.status !== "fulfilled") {
      if (!event.signal.aborted && ctx.hasUI) {
        const message = remoteResult.reason instanceof Error ? remoteResult.reason.message : String(remoteResult.reason);
        ctx.ui.notify(`OpenAI remote compaction failed; using the portable summary. ${message}`, "warning");
      }
      return { compaction: localResult.value };
    }

    const compaction = mergeCompactionResults(model, localResult, remoteResult);
    return compaction ? { compaction } : undefined;
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = getSessionId(ctx);
    const model = ctx.model;

    extendRemoteHistoryIfCompatible({
      sessionId,
      model,
      message: event.message,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    discardSettledFailedTurn(getSessionId(ctx));
  });

  pi.on("before_provider_request", (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return undefined;

    const model = ctx.model;
    if (
      !model ||
      !supportsRemoteCompactionModel(model) ||
      !isRecord(event.payload) ||
      !looksLikeResponsesPayload(event.payload)
    ) return undefined;

    const sessionId = getSessionId(ctx);
    setResponsesRequestShapeState(sessionId, {
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      reasoning: extractResponsesReasoningConfig(event.payload),
      text: extractResponsesTextConfig(event.payload),
    });
    const remoteState = getMatchingRemoteState(sessionId, model);

    if (!remoteState) return undefined;
    const payload = applyRemoteHistoryPayloadPatch({
      payload: event.payload,
      explicitHistory: normalizeResponseItemsForPrompt(remoteState.explicitHistory, model) as unknown[],
    });

    maybeNotifyRequestFeatures({
      notifiedModels,
      hasUI: ctx.hasUI,
      notify: cfg.notify,
      ui: ctx.ui,
      model,
      features: ["remote_compaction_history"],
    });

    return payload;
  });
}
