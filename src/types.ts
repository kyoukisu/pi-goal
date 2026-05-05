export type GoalStatus = "active" | "paused" | "complete" | "cleared";

export type PauseReason =
  | "user"
  | "abort"
  | "error"
  | "max_iterations"
  | "max_minutes"
  | "need_user_input"
  | "no_progress";

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
  maxMinutes?: number;
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
};

export type GoalEvent =
  | { version?: number; kind: "set"; goal: GoalState }
  | { version?: number; kind: "status"; id: string; status: "active" | "paused"; reason?: PauseReason; question?: string; at: number }
  | { version?: number; kind: "iteration_queued"; id: string; iteration: number; at: number }
  | {
      version?: number;
      kind: "iteration_result";
      id: string;
      stopReason?: string;
      errorMessage?: string;
      hadProgressTool?: boolean;
      isContinuation?: boolean;
      workSeconds?: number;
      at: number;
    }
  | { version?: number; kind: "complete"; id: string; audit: string; summary?: string; at: number }
  | { version?: number; kind: "clear"; id?: string; at: number };
