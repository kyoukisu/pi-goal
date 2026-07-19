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

export type GoalSpec = {
  provenance: "structured" | "legacy";
  sourceBrief: string;
  sourceEntryIds: string[];
  outcome: string;
  why?: string;
  context: string[];
  requirements: string[];
  constraints: string[];
  suggestedApproaches: string[];
  successCriteria: string[];
  autonomy: string[];
};

export type GoalPhase = "orienting" | "researching" | "experimenting" | "implementing" | "verifying" | "blocked";
export type GoalPlanStatus = "pending" | "in_progress" | "completed" | "blocked" | "superseded";
export type GoalExperimentStatus = "planned" | "running" | "succeeded" | "failed" | "inconclusive";
export type GoalArtifactStatus = "authoritative" | "supporting" | "superseded";
export type GoalEvidenceStatus = "met" | "partial" | "unmet" | "deferred";

export type GoalPlanItem = {
  text: string;
  status: GoalPlanStatus;
  evidence?: string;
};

export type GoalFact = {
  text: string;
  evidence?: string;
};

export type GoalDecision = {
  text: string;
  rationale?: string;
  status: "active" | "superseded";
};

export type GoalExperiment = {
  question: string;
  status: GoalExperimentStatus;
  method?: string;
  result?: string;
  evidence?: string;
};

export type GoalArtifact = {
  path: string;
  description?: string;
  status: GoalArtifactStatus;
};

export type GoalCriterionEvidence = {
  criterion: string;
  status: GoalEvidenceStatus;
  proof: string[];
};

export type GoalCheckpoint = {
  sequence: number;
  phase: GoalPhase;
  summary: string;
  currentAction?: string;
  nextAction: string;
  plan: GoalPlanItem[];
  facts: GoalFact[];
  unknowns: string[];
  decisions: GoalDecision[];
  experiments: GoalExperiment[];
  artifacts: GoalArtifact[];
  evidence: GoalCriterionEvidence[];
  reflection?: string;
  strategyChanged: boolean;
  createdAt: number;
};

export type GoalCheckpointUpdate = Omit<
  GoalCheckpoint,
  "sequence" | "createdAt" | "strategyChanged" | "plan" | "facts" | "unknowns" | "decisions" | "experiments" | "artifacts" | "evidence"
> & {
  plan?: GoalPlanItem[];
  facts?: GoalFact[];
  unknowns?: string[];
  decisions?: GoalDecision[];
  experiments?: GoalExperiment[];
  artifacts?: GoalArtifact[];
  evidence?: GoalCriterionEvidence[];
  reflection?: string;
  strategyChanged?: boolean;
};

export type GoalState = {
  version?: number;
  id: string;
  /** Backward-compatible one-line outcome. The source brief and contract live in spec. */
  objective: string;
  spec: GoalSpec;
  checkpoint?: GoalCheckpoint;
  checkpointCount: number;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  iteration: number;
  maxIterations: number;
  /** Deprecated: wall-clock budgets are unsafe across pauses/reloads. Prefer tokenBudget. */
  maxMinutes?: number;
  /** Undefined means budget enforcement is off. */
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
  | { version?: number; kind: "checkpoint"; id: string; checkpoint: GoalCheckpoint; at: number }
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
