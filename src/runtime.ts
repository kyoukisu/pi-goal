import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CONTINUATION_TYPE, EVENT_TYPE } from "./constants";
import { formatDuration, now } from "./format";
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

const PROVIDER_RETRY_BASE_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
const NO_PROGRESS_LIMIT = 2;

function isRetryableProviderError(message?: string) {
  if (!message) return false;
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay|unable to load site|try again later|status\.openai\.com|ray id|cloudflare|vpn/i.test(message);
}

function isContextOverflowError(message?: string) {
  if (!message) return false;
  return /context.?length.?exceeded|context.?window|input exceeds the context|too many tokens|maximum context/i.test(message);
}

function providerRetryDelayMs(attempt: number) {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  return Math.min(MAX_TIMER_MS, PROVIDER_RETRY_BASE_MS * 2 ** exponent);
}

export function createGoalRuntime(pi: ExtensionAPI) {
  let cachedGoal: GoalState | undefined;
  let continuationQueued = false;
  let questionToolInFlight = false;
  let awaitingContinuation: { goalId: string; iteration: number } | undefined;
  let turnStartedAt: number | undefined;
  let currentTurnIsContinuation = false;
  let currentTurnHadProgressTool = false;
  let turnSequence = 0;

  function append(event: GoalEvent) {
    const versioned = withEventVersion(event);
    pi.appendEntry(EVENT_TYPE, versioned);
    cachedGoal = applyEvent(cachedGoal, versioned);
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

    setTimeout(() => {
      if (cachedGoal?.id !== goal.id || cachedGoal.status !== "active" || cachedGoal.iteration < nextIteration) return;
      if (options.cancelIfTurnStarts !== undefined && turnSequence !== options.cancelIfTurnStarts) return;
      if (options.delayMs && !ctx.isIdle()) return;
      pi.sendMessage(message, { triggerTurn: true });
    }, options.delayMs ?? 0);
  }

  function resetTurnTracking() {
    turnStartedAt = undefined;
    currentTurnIsContinuation = false;
    currentTurnHadProgressTool = false;
  }

  function registerLifecycle() {
    pi.on("session_start", async (_event, ctx) => {
      continuationQueued = false;
      questionToolInFlight = false;
      awaitingContinuation = undefined;
      resetTurnTracking();
      refresh(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
      continuationQueued = false;
      questionToolInFlight = false;
      awaitingContinuation = undefined;
      resetTurnTracking();
      refresh(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
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

    pi.on("before_agent_start", async (event, ctx) => {
      const goal = refresh(ctx);
      resetTurnTracking();
      if (!goal || goal.status !== "active") return;

      turnSequence++;
      turnStartedAt = now();
      currentTurnIsContinuation = awaitingContinuation?.goalId === goal.id || goal.iteration > goal.turnCount;
      renderCurrent(ctx);

      return { systemPrompt: event.systemPrompt + activeGoalSystemPrompt(goal, availableQuestionTool(pi)) };
    });

    pi.on("tool_call", async (event) => {
      if (event.toolName === "create_goal" && !turnStartedAt) turnStartedAt = now();
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
      continuationQueued = false;
      awaitingContinuation = undefined;
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

    pi.on("agent_end", async (event, ctx) => {
      continuationQueued = false;
      if (currentTurnIsContinuation) awaitingContinuation = undefined;
      let goal = refresh(ctx);
      if (!goal) {
        resetTurnTracking();
        return;
      }

      const assistant = lastAssistant(event.messages);
      const stopReason = assistant?.stopReason as string | undefined;
      const errorMessage = assistant?.errorMessage as string | undefined;
      const workSeconds = turnStartedAt ? Math.max(0, Math.round((now() - turnStartedAt) / 1000)) : 0;

      if (goal.status !== "active") {
        if (workSeconds > 0) {
          append({
            kind: "iteration_result",
            id: goal.id,
            stopReason,
            errorMessage,
            hadProgressTool: currentTurnHadProgressTool,
            isContinuation: currentTurnIsContinuation,
            workSeconds,
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
          queueContinuation(ctx, goal, "context_overflow_retry", { delayMs: 120_000, sameIteration: true, cancelIfTurnStarts: expectedTurnSequence });
          return;
        }
        if (isRetryableProviderError(errorMessage)) {
          const delayMs = providerRetryDelayMs(goal.consecutiveErrors);
          const expectedTurnSequence = turnSequence;
          resetTurnTracking();
          ctx.ui.notify(`Goal provider error: retrying in ${formatDuration(Math.ceil(delayMs / 1000))}.`, "warning");
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
        ctx.ui.notify(`Goal paused after ${goal.maxIterations} iterations. Run /goal resume to continue.`, "warning");
        return;
      }
      if (goal.maxMinutes && (Date.now() - goal.startedAt) / 60000 >= goal.maxMinutes) {
        pause(ctx, goal, "max_minutes");
        ctx.ui.notify(`Goal paused after ${goal.maxMinutes} minutes. Run /goal resume to continue.`, "warning");
        return;
      }

      const current = cachedGoal;
      if (!current || current.status !== "active") return;
      queueContinuation(ctx, current, "agent_end");
    });
  }

  return {
    append,
    refresh,
    pause,
    queueContinuation,
    registerLifecycle,
    getCachedGoal: () => cachedGoal,
    render: renderCurrent,
    setCachedGoal: (goal: GoalState | undefined) => {
      cachedGoal = goal;
    },
  };
}
