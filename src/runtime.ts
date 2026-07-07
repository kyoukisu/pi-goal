import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_IDLE_RETRY_MS, CONTINUATION_TYPE, EVENT_TYPE, PROVIDER_RETRY_DELAYS_MS } from "./constants";
import { formatDuration, formatTokenBudget, now } from "./format";
import { activeGoalSystemPrompt, continuationPrompt } from "./prompts";
import { applyEvent, reconstruct, withEventVersion } from "./state";
import { availableQuestionTool, isProgressTool, isQuestionTool } from "./tools";
import type { GoalEvent, GoalState, PauseReason } from "./types";
import { renderGoal } from "./ui";

function lastAssistant(messages: AgentMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.role === "assistant") return msg;
  }
  return undefined;
}

const NO_PROGRESS_LIMIT = 2;

function isNonRetryableProviderError(message?: string) {
  if (!message) return false;
  return /usage[_\s-]*limit|monthly usage limit|available balance|insufficient[_\s-]*quota|out of budget|quota exceeded|billing|unauthori[sz]ed|invalid api key|forbidden|permission denied/i.test(message);
}

function isRetryableProviderError(message?: string) {
  if (!message || isNonRetryableProviderError(message)) return false;
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay|unable to load site|try again later|status\.openai\.com|ray id|cloudflare|vpn/i.test(message);
}

function isContextOverflowError(message?: string) {
  if (!message) return false;
  return /context.?length.?exceeded|context.?window|input exceeds the context|too many tokens|maximum context/i.test(message);
}

function isRecoverableConversationShapeError(message?: string) {
  if (!message) return false;
  return /no tool call found for function call output|function_call_output.*without.*tool|tool result.*without.*tool call|orphan.*tool/i.test(message);
}

function providerRetryDelayMs(attempt: number) {
  return PROVIDER_RETRY_DELAYS_MS[Math.max(0, Math.min(PROVIDER_RETRY_DELAYS_MS.length - 1, attempt - 1))];
}

function tokenUsageFromMessage(message: any) {
  if (message?.role !== "assistant") return 0;
  const usage = message.usage ?? {};
  const total = Number(usage.totalTokens ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(usage.input ?? 0);
  const output = Number(usage.output ?? 0);
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

function tokenUsageFromMessages(messages: AgentMessage[]) {
  return messages.reduce((sum, message) => sum + tokenUsageFromMessage(message), 0);
}

function tokenBudgetReached(goal: GoalState) {
  return goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
}

export function createGoalRuntime(pi: ExtensionAPI) {
  let cachedGoal: GoalState | undefined;
  let continuationQueued = false;
  let continuationTimer: ReturnType<typeof setTimeout> | undefined;
  let questionToolInFlight = false;
  let awaitingContinuation: { goalId: string; iteration: number } | undefined;
  let turnStartedAt: number | undefined;
  let currentTurnIsContinuation = false;
  let currentTurnHadProgressTool = false;
  let currentRunTokenUsage = 0;
  let finalizedTurnSequence: number | undefined;
  let turnSequence = 0;

  function clearContinuationTimer() {
    if (!continuationTimer) return;
    clearTimeout(continuationTimer);
    continuationTimer = undefined;
  }

  function clearQueuedContinuation() {
    clearContinuationTimer();
    continuationQueued = false;
    awaitingContinuation = undefined;
  }

  function append(event: GoalEvent) {
    const versioned = withEventVersion(event);
    pi.appendEntry(EVENT_TYPE, versioned);
    cachedGoal = applyEvent(cachedGoal, versioned);
    if (event.kind === "clear" || event.kind === "complete" || (event.kind === "status" && event.status === "paused")) {
      clearQueuedContinuation();
    }
  }

  function renderCurrent(ctx: ExtensionContext) {
    renderGoal(ctx, cachedGoal, { activeWorkStartedAt: turnStartedAt });
  }

  function refresh(ctx: ExtensionContext) {
    cachedGoal = reconstruct(ctx);
    renderCurrent(ctx);
    return cachedGoal;
  }

  function pause(ctx: ExtensionContext, goal: GoalState, reason: PauseReason, question?: string) {
    append({ kind: "status", id: goal.id, status: "paused", reason, question, at: now() });
    renderCurrent(ctx);
  }

  function queueContinuation(
    ctx: ExtensionContext,
    goal: GoalState,
    reason: string,
    options: { delayMs?: number; sameIteration?: boolean; cancelIfTurnStarts?: number } = {},
  ) {
    if (continuationQueued) return;
    if (goal.status !== "active") return;
    const nextIteration = options.sameIteration ? Math.max(1, goal.iteration) : goal.iteration > goal.turnCount ? goal.iteration : goal.iteration + 1;
    if (goal.iteration < nextIteration) {
      append({ kind: "iteration_queued", id: goal.id, iteration: nextIteration, at: now() });
    }
    continuationQueued = true;
    awaitingContinuation = { goalId: goal.id, iteration: nextIteration };

    renderCurrent(ctx);

    const tool = availableQuestionTool(pi);
    const message = {
      customType: CONTINUATION_TYPE,
      content: continuationPrompt({ ...goal, iteration: nextIteration - 1 }, tool),
      display: false,
      details: { goalId: goal.id, iteration: nextIteration, reason },
    };

    const schedule = (delayMs: number) => {
      clearContinuationTimer();
      continuationTimer = setTimeout(() => {
        continuationTimer = undefined;
        if (cachedGoal?.id !== goal.id || cachedGoal.status !== "active" || cachedGoal.iteration < nextIteration) return;
        if (options.cancelIfTurnStarts !== undefined && turnSequence !== options.cancelIfTurnStarts) return;
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          schedule(CONTINUATION_IDLE_RETRY_MS);
          return;
        }
        pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      }, delayMs);
      continuationTimer.unref?.();
    };

    schedule(options.delayMs ?? 0);
  }

  function dispatchPostGoalActions(ctx: ExtensionContext, goal: GoalState) {
    const pending = (goal.afterActions ?? []).filter((action) => !action.dispatchedAt);
    if (pending.length === 0) return;
    append({ kind: "after_dispatched", id: goal.id, actionIds: pending.map((action) => action.id), at: now() });
    renderCurrent(ctx);

    const content = [
      "The active Pi goal has been completed. Now run these post-goal action(s) exactly once:",
      ...pending.map((action, index) => `${index + 1}. ${action.text}`),
    ].join("\n");

    setTimeout(() => {
      pi.sendMessage(
        {
          customType: "pi-goal:after",
          content,
          display: true,
          details: { goalId: goal.id, actionIds: pending.map((action) => action.id) },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }, 0);
  }

  function resetTurnTracking() {
    turnStartedAt = undefined;
    currentTurnIsContinuation = false;
    currentTurnHadProgressTool = false;
    currentRunTokenUsage = 0;
  }

  function finalizeGoalTurn(ctx: ExtensionContext, assistant: any, tokenUsage: number, continuationReason: string) {
    if (finalizedTurnSequence === turnSequence) return;
    finalizedTurnSequence = turnSequence;
    clearContinuationTimer();
    continuationQueued = false;
    if (currentTurnIsContinuation) awaitingContinuation = undefined;

    let goal = refresh(ctx);
    if (!goal) {
      resetTurnTracking();
      return;
    }

    const stopReason = assistant?.stopReason as string | undefined;
    const errorMessage = assistant?.errorMessage as string | undefined;
    const workSeconds = turnStartedAt ? Math.max(0, Math.round((now() - turnStartedAt) / 1000)) : 0;
    const providerErrorHadProgress = currentTurnHadProgressTool || tokenUsage > 0;

    if (goal.status !== "active") {
      if (workSeconds > 0 || tokenUsage > 0) {
        append({
          kind: "iteration_result",
          id: goal.id,
          stopReason,
          errorMessage,
          hadProgressTool: currentTurnHadProgressTool,
          isContinuation: currentTurnIsContinuation,
          workSeconds,
          tokenUsage,
          at: now(),
        });
        resetTurnTracking();
        renderCurrent(ctx);
        return;
      }
      resetTurnTracking();
      return;
    }

    append({
      kind: "iteration_result",
      id: goal.id,
      stopReason,
      errorMessage,
      hadProgressTool: currentTurnHadProgressTool,
      isContinuation: currentTurnIsContinuation,
      workSeconds,
      tokenUsage,
      at: now(),
    });
    goal = cachedGoal;
    if (!goal || goal.status !== "active") {
      resetTurnTracking();
      return;
    }

    if (stopReason === "error") {
      if (isContextOverflowError(errorMessage)) {
        const expectedTurnSequence = turnSequence;
        resetTurnTracking();
        ctx.ui.notify("Goal hit context overflow; waiting for Pi compaction/retry.", "warning");
        queueContinuation(ctx, goal, "context_overflow_retry", { delayMs: 5_000, sameIteration: true, cancelIfTurnStarts: expectedTurnSequence });
        return;
      }
      if (isRecoverableConversationShapeError(errorMessage)) {
        const expectedTurnSequence = turnSequence;
        resetTurnTracking();
        ctx.ui.notify("Goal hit recoverable post-compaction tool-call mismatch; retrying after context settles.", "warning");
        queueContinuation(ctx, goal, "conversation_shape_retry", { delayMs: 5_000, sameIteration: true, cancelIfTurnStarts: expectedTurnSequence });
        return;
      }
      if (isRetryableProviderError(errorMessage)) {
        if (!providerErrorHadProgress && goal.consecutiveErrors > PROVIDER_RETRY_DELAYS_MS.length) {
          resetTurnTracking();
          pause(ctx, goal, "provider_error");
          ctx.ui.notify(`Goal paused after repeated empty provider errors (${goal.consecutiveErrors}). Last error: ${errorMessage ?? "unknown"}. Run /goal resume to retry.`, "error");
          return;
        }
        const delayMs = providerRetryDelayMs(providerErrorHadProgress ? 1 : goal.consecutiveErrors);
        const expectedTurnSequence = turnSequence;
        resetTurnTracking();
        ctx.ui.notify(
          providerErrorHadProgress
            ? `Goal provider error after progress; retrying in ${formatDuration(Math.ceil(delayMs / 1000))} without increasing outage counter.`
            : `Goal provider error: retrying in ${formatDuration(Math.ceil(delayMs / 1000))}.`,
          "warning",
        );
        queueContinuation(ctx, goal, "provider_error_retry", { delayMs, sameIteration: true, cancelIfTurnStarts: expectedTurnSequence });
        return;
      }
      resetTurnTracking();
      pause(ctx, goal, "error");
      ctx.ui.notify("Goal paused after non-retryable agent error. Run /goal resume to retry.", "error");
      return;
    }

    if (currentTurnIsContinuation && !currentTurnHadProgressTool) {
      if (goal.noProgressCount < NO_PROGRESS_LIMIT) {
        resetTurnTracking();
        ctx.ui.notify("Goal continuation made no tool-backed progress; retrying once with stricter instructions.", "warning");
        queueContinuation(ctx, goal, "no_progress_retry");
        return;
      }
      resetTurnTracking();
      pause(ctx, goal, "no_progress");
      ctx.ui.notify("Goal paused: repeated continuations made no tool-backed progress. Run /goal resume to continue.", "warning");
      return;
    }

    resetTurnTracking();

    if (questionToolInFlight) return;
    if (ctx.hasPendingMessages()) return;

    if (stopReason === "aborted") {
      pause(ctx, goal, "abort");
      ctx.ui.notify("Goal paused after abort. Run /goal resume to continue.", "warning");
      return;
    }
    if (goal.iteration >= goal.maxIterations) {
      pause(ctx, goal, "max_iterations");
      ctx.ui.notify(`Goal paused after ${goal.maxIterations} iterations. Run /goal extend <N> to continue.`, "warning");
      return;
    }
    if (tokenBudgetReached(goal)) {
      pause(ctx, goal, "token_budget");
      ctx.ui.notify(`Goal paused after token budget ${formatTokenBudget(goal)}. Use /goal budget +50k, /goal budget <tokens>, or /goal budget off.`, "warning");
      return;
    }

    const current = cachedGoal;
    if (!current || current.status !== "active") return;
    queueContinuation(ctx, current, continuationReason);
  }

  function registerLifecycle() {
    pi.on("session_start", async (_event, ctx) => {
      clearQueuedContinuation();
      questionToolInFlight = false;
      resetTurnTracking();
      refresh(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
      clearQueuedContinuation();
      questionToolInFlight = false;
      resetTurnTracking();
      refresh(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      clearQueuedContinuation();
      ctx.ui.setStatus("pi-goal", undefined);
      ctx.ui.setWidget("pi-goal", undefined);
    });

    pi.on("context", (event) => {
      const goal = cachedGoal;
      const messages = event.messages as any[];
      return {
        messages: messages.filter((message) => {
          if (message?.customType !== CONTINUATION_TYPE) return true;
          if (!goal || goal.status !== "active") return false;
          return message.details?.goalId === awaitingContinuation?.goalId && message.details?.iteration === awaitingContinuation?.iteration;
        }),
      };
    });

    pi.on("session_before_compact", async (_event, ctx) => {
      clearQueuedContinuation();
      refresh(ctx);
    });

    pi.on("session_compact", async (event, ctx) => {
      const goal = refresh(ctx);
      if (!goal || goal.status !== "active") return;
      if ((event as any).willRetry) return;
      if (ctx.hasPendingMessages()) return;
      queueContinuation(ctx, goal, "post_compact");
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const goal = refresh(ctx);
      resetTurnTracking();
      if (!goal || goal.status !== "active") return;

      turnSequence++;
      finalizedTurnSequence = undefined;
      turnStartedAt = now();
      currentTurnIsContinuation = awaitingContinuation?.goalId === goal.id || goal.iteration > goal.turnCount;
      renderCurrent(ctx);

      return { systemPrompt: event.systemPrompt + activeGoalSystemPrompt(goal, availableQuestionTool(pi)) };
    });

    pi.on("tool_call", async (event) => {
      if (event.toolName === "create_goal" && !turnStartedAt) {
        turnSequence++;
        finalizedTurnSequence = undefined;
        turnStartedAt = now();
        currentTurnIsContinuation = false;
        currentRunTokenUsage = 0;
      }
      if (isQuestionTool(event.toolName)) questionToolInFlight = true;
      if (isProgressTool(event.toolName)) currentTurnHadProgressTool = true;
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return;
      const text = event.text.trim();
      if (text.startsWith("/goal")) return;
      const goal = refresh(ctx);
      if (!goal) return;
      if (goal.status === "paused" && goal.pauseReason === "need_user_input") {
        append({ kind: "status", id: goal.id, status: "active", at: now() });
        renderCurrent(ctx);
        ctx.ui.notify("Goal resumed with user answer.", "info");
        return;
      }
      if (goal.status !== "active") return;
      pause(ctx, goal, "user");
      clearQueuedContinuation();
      ctx.ui.notify("Goal paused after user input. Run /goal resume to continue.", "warning");
    });

    pi.on("tool_result", async (event, ctx) => {
      if (!isQuestionTool(event.toolName)) return;
      questionToolInFlight = false;
      const goal = refresh(ctx);
      if (!goal || goal.status !== "active") return;
      const detailsText = JSON.stringify(event.details ?? {});
      const contentText = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      if (event.isError || /\"cancelled\"\s*:\s*true/i.test(detailsText) || /cancelled|timed out|timeout/i.test(contentText)) {
        pause(ctx, goal, "need_user_input", "User question was cancelled or timed out.");
      }
    });

    pi.on("turn_start", async (_event, ctx) => {
      if (turnStartedAt) return;
      const goal = refresh(ctx);
      if (!goal || goal.status !== "active") return;
      turnSequence++;
      finalizedTurnSequence = undefined;
      turnStartedAt = now();
      currentTurnIsContinuation = awaitingContinuation?.goalId === goal.id || goal.iteration > goal.turnCount;
      renderCurrent(ctx);
    });

    pi.on("turn_end", async (event, ctx) => {
      const assistant = (event as any).message;
      if (assistant?.role !== "assistant") return;
      currentRunTokenUsage += tokenUsageFromMessage(assistant);
      if (assistant.stopReason === "toolUse") return;
      finalizeGoalTurn(ctx, assistant, currentRunTokenUsage, "turn_end");
    });

    pi.on("agent_end", async (event, ctx) => {
      if (finalizedTurnSequence === turnSequence) return;
      const assistant = lastAssistant(event.messages);
      const tokenUsage = currentRunTokenUsage || tokenUsageFromMessages(event.messages);
      finalizeGoalTurn(ctx, assistant, tokenUsage, "agent_end");
    });
  }

  return {
    append,
    refresh,
    pause,
    queueContinuation,
    dispatchPostGoalActions,
    registerLifecycle,
    getCachedGoal: () => cachedGoal,
    render: renderCurrent,
    setCachedGoal: (goal: GoalState | undefined) => {
      cachedGoal = goal;
    },
  };
}
