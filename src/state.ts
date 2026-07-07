import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EVENT_TYPE, STATE_VERSION } from "./constants";
import type { GoalEvent, GoalState } from "./types";

export function goalIsLive(goal: GoalState | undefined) {
  return !!goal && goal.status !== "complete" && goal.status !== "cleared";
}

export function normalizeGoal(goal: GoalState): GoalState {
  return {
    ...goal,
    version: goal.version ?? 1,
    tokensUsed: Math.max(0, Number(goal.tokensUsed ?? 0)),
    workTimeSeconds: Math.max(0, Number(goal.workTimeSeconds ?? 0)),
    turnCount: Math.max(0, Number(goal.turnCount ?? 0)),
    noProgressCount: Math.max(0, Number(goal.noProgressCount ?? 0)),
    consecutiveErrors: Math.max(0, Number(goal.consecutiveErrors ?? 0)),
    amendments: Array.isArray(goal.amendments) ? goal.amendments : [],
    afterActions: Array.isArray(goal.afterActions) ? goal.afterActions : [],
  };
}

export function withEventVersion<T extends GoalEvent>(event: T): T {
  return { version: STATE_VERSION, ...event };
}

export function applyEvent(goal: GoalState | undefined, rawEvent: GoalEvent): GoalState | undefined {
  const event = rawEvent;
  switch (event.kind) {
    case "set":
      return normalizeGoal({ ...event.goal, version: event.goal.version ?? event.version ?? STATE_VERSION });
    case "status":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        status: event.status,
        pauseReason: event.status === "paused" ? event.reason : undefined,
        awaitingQuestion: event.status === "paused" && event.reason === "need_user_input" ? event.question : undefined,
        noProgressCount: event.status === "active" ? 0 : goal.noProgressCount,
        consecutiveErrors: event.status === "active" ? 0 : goal.consecutiveErrors,
        updatedAt: event.at,
      });
    case "iteration_queued":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({ ...goal, iteration: Math.max(goal.iteration, event.iteration), updatedAt: event.at });
    case "amend":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        amendments: [...(goal.amendments ?? []), { id: event.amendmentId, text: event.text, createdAt: event.at }],
        updatedAt: event.at,
      });
    case "extend":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        maxIterations: Math.max(goal.maxIterations, event.maxIterations),
        updatedAt: event.at,
      });
    case "budget":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        tokenBudget: event.tokenBudget,
        pauseReason: goal.status === "paused" && goal.pauseReason === "token_budget" && (event.tokenBudget === undefined || goal.tokensUsed < event.tokenBudget) ? undefined : goal.pauseReason,
        updatedAt: event.at,
      });
    case "after":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        afterActions: [...(goal.afterActions ?? []), { id: event.actionId, text: event.text, createdAt: event.at }],
        updatedAt: event.at,
      });
    case "after_dispatched":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        afterActions: (goal.afterActions ?? []).map((action) =>
          event.actionIds.includes(action.id) ? { ...action, dispatchedAt: event.at } : action,
        ),
        updatedAt: event.at,
      });
    case "iteration_result":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        tokensUsed: goal.tokensUsed + Math.max(0, Math.floor(event.tokenUsage ?? 0)),
        workTimeSeconds: goal.workTimeSeconds + Math.max(0, Math.floor(event.workSeconds ?? 0)),
        turnCount: goal.turnCount + 1,
        lastAssistantStopReason: event.stopReason,
        lastErrorMessage: event.errorMessage,
        lastTurnHadProgressTool: event.hadProgressTool,
        lastContinuationHadProgressTool: event.isContinuation ? event.hadProgressTool : goal.lastContinuationHadProgressTool,
        noProgressCount: event.isContinuation && !event.hadProgressTool ? goal.noProgressCount + 1 : 0,
        consecutiveErrors: event.stopReason === "error" ? goal.consecutiveErrors + 1 : 0,
        updatedAt: event.at,
      });
    case "complete":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        status: "complete",
        completedAt: event.at,
        completionAudit: event.audit,
        completionSummary: event.summary,
        pauseReason: undefined,
        awaitingQuestion: undefined,
        updatedAt: event.at,
      });
    case "clear":
      if (!goal) return undefined;
      if (event.id && goal.id !== event.id) return goal;
      return normalizeGoal({ ...goal, status: "cleared", updatedAt: event.at });
  }
}

export function reconstruct(ctx: ExtensionContext): GoalState | undefined {
  let goal: GoalState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== EVENT_TYPE) continue;
    goal = applyEvent(goal, entry.data as GoalEvent);
  }
  return goal && goal.status !== "cleared" ? normalizeGoal(goal) : undefined;
}
