export type GoalStatus = "active" | "paused" | "complete" | "cleared";

export type PauseReason =
  | "user"
  | "abort"
  | "error"
  | "provider_error"
  | "max_iterations"
  | "max_minutes"
  | "token_budget"
  | "need_user_input"
  | "no_progress";

export type GoalAmendment = {
  id: string;
  text: string;
  createdAt: number;
};

export type GoalAfterAction = {
  id: string;
  text: string;
  createdAt: number;
  dispatchedAt?: number;
};

export type GoalState = {
  version?: number;
  id: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  iteration: number;
  maxIterations: number;
  /** Deprecated: wall-clock budgets are unsafe across pauses/reloads. Prefer tokenBudget. */
  maxMinutes?: number;
  tokenBudget?: number;
  tokensUsed: number;
  workTimeSeconds: number;
  turnCount: number;
  pauseReason?: PauseReason;
  completedAt?: number;
  completionAudit?: string;
  completionSummary?: string;
  awaitingQuestion?: string;
  lastAssistantStopReason?: string;
  lastErrorMessage?: string;
  lastTurnHadProgressTool?: boolean;
  lastContinuationHadProgressTool?: boolean;
  noProgressCount: number;
  consecutiveErrors: number;
  amendments?: GoalAmendment[];
  afterActions?: GoalAfterAction[];
};

export type GoalEvent =
  | { version?: number; kind: "set"; goal: GoalState }
  | { version?: number; kind: "status"; id: string; status: "active" | "paused"; reason?: PauseReason; question?: string; at: number }
  | { version?: number; kind: "iteration_queued"; id: string; iteration: number; at: number }
  | { version?: number; kind: "amend"; id: string; amendmentId: string; text: string; at: number }
  | { version?: number; kind: "extend"; id: string; maxIterations: number; at: number }
  | { version?: number; kind: "budget"; id: string; tokenBudget?: number; at: number }
  | { version?: number; kind: "after"; id: string; actionId: string; text: string; at: number }
  | { version?: number; kind: "after_dispatched"; id: string; actionIds: string[]; at: number }
  | {
      version?: number;
      kind: "iteration_result";
      id: string;
      stopReason?: string;
      errorMessage?: string;
      hadProgressTool?: boolean;
      isContinuation?: boolean;
      workSeconds?: number;
      tokenUsage?: number;
      at: number;
    }
  | { version?: number; kind: "complete"; id: string; audit: string; summary?: string; at: number }
  | { version?: number; kind: "clear"; id?: string; at: number };
