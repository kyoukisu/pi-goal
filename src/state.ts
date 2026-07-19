import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EVENT_TYPE, STATE_VERSION } from "./constants";
import type {
  GoalArtifact,
  GoalCheckpoint,
  GoalCheckpointUpdate,
  GoalCriterionEvidence,
  GoalDecision,
  GoalEvent,
  GoalExperiment,
  GoalFact,
  GoalPlanItem,
  GoalSpec,
  GoalState,
} from "./types";

const PHASES = new Set(["orienting", "researching", "experimenting", "implementing", "verifying", "blocked"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "blocked", "superseded"]);
const EXPERIMENT_STATUSES = new Set(["planned", "running", "succeeded", "failed", "inconclusive"]);
const ARTIFACT_STATUSES = new Set(["authoritative", "supporting", "superseded"]);
const EVIDENCE_STATUSES = new Set(["met", "partial", "unmet", "deferred"]);

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown) {
  const text = cleanText(value);
  return text || undefined;
}

function verbatimText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanText).filter(Boolean);
}

export function legacyGoalSpec(objective: string): GoalSpec {
  const outcome = cleanText(objective);
  return {
    provenance: "legacy",
    sourceBrief: outcome,
    sourceEntryIds: [],
    outcome,
    context: [],
    requirements: [],
    constraints: [],
    suggestedApproaches: [],
    successCriteria: [],
    autonomy: [],
  };
}

export function normalizeGoalSpec(value: GoalSpec | undefined, objective: string): GoalSpec {
  if (!value) return legacyGoalSpec(objective);
  const outcome = cleanText(value.outcome) || cleanText(objective);
  const sourceBrief = verbatimText(value.sourceBrief, outcome);
  return {
    provenance: value.provenance === "structured" ? "structured" : "legacy",
    sourceBrief,
    sourceEntryIds: stringList(value.sourceEntryIds),
    outcome,
    why: optionalText(value.why),
    context: stringList(value.context),
    requirements: stringList(value.requirements),
    constraints: stringList(value.constraints),
    suggestedApproaches: stringList(value.suggestedApproaches),
    successCriteria: stringList(value.successCriteria),
    autonomy: stringList(value.autonomy),
  };
}

function normalizePlan(value: unknown): GoalPlanItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<GoalPlanItem>;
    const text = cleanText(item.text);
    if (!text) return [];
    const status = PLAN_STATUSES.has(String(item.status)) ? item.status! : "pending";
    return [{ text, status, evidence: optionalText(item.evidence) }];
  });
}

function normalizeFacts(value: unknown): GoalFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<GoalFact>;
    const text = cleanText(item.text);
    return text ? [{ text, evidence: optionalText(item.evidence) }] : [];
  });
}

function normalizeDecisions(value: unknown): GoalDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<GoalDecision>;
    const text = cleanText(item.text);
    if (!text) return [];
    return [{ text, rationale: optionalText(item.rationale), status: item.status === "superseded" ? "superseded" : "active" }];
  });
}

function normalizeExperiments(value: unknown): GoalExperiment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<GoalExperiment>;
    const question = cleanText(item.question);
    if (!question) return [];
    const status = EXPERIMENT_STATUSES.has(String(item.status)) ? item.status! : "planned";
    return [{
      question,
      status,
      method: optionalText(item.method),
      result: optionalText(item.result),
      evidence: optionalText(item.evidence),
    }];
  });
}

function normalizeArtifacts(value: unknown): GoalArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<GoalArtifact>;
    const path = cleanText(item.path);
    if (!path) return [];
    const status = ARTIFACT_STATUSES.has(String(item.status)) ? item.status! : "supporting";
    return [{ path, description: optionalText(item.description), status }];
  });
}

function normalizeEvidence(value: unknown): GoalCriterionEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<GoalCriterionEvidence>;
    const criterion = cleanText(item.criterion);
    if (!criterion) return [];
    const status = EVIDENCE_STATUSES.has(String(item.status)) ? item.status! : "unmet";
    return [{ criterion, status, proof: stringList(item.proof) }];
  });
}

function normalizeCheckpoint(value: GoalCheckpoint | undefined, fallbackSequence = 0): GoalCheckpoint | undefined {
  if (!value) return undefined;
  const summary = cleanText(value.summary);
  const nextAction = cleanText(value.nextAction);
  if (!summary || !nextAction) return undefined;
  return {
    sequence: Math.max(1, Math.floor(Number(value.sequence) || fallbackSequence || 1)),
    phase: PHASES.has(String(value.phase)) ? value.phase : "orienting",
    summary,
    currentAction: optionalText(value.currentAction),
    nextAction,
    plan: normalizePlan(value.plan),
    facts: normalizeFacts(value.facts),
    unknowns: stringList(value.unknowns),
    decisions: normalizeDecisions(value.decisions),
    experiments: normalizeExperiments(value.experiments),
    artifacts: normalizeArtifacts(value.artifacts),
    evidence: normalizeEvidence(value.evidence),
    reflection: optionalText(value.reflection),
    strategyChanged: value.strategyChanged === true,
    createdAt: Math.max(0, Math.floor(Number(value.createdAt) || 0)),
  };
}

export function buildCheckpoint(goal: GoalState, update: GoalCheckpointUpdate, at: number): GoalCheckpoint {
  const previous = goal.checkpoint;
  return normalizeCheckpoint({
    sequence: goal.checkpointCount + 1,
    phase: update.phase ?? previous?.phase ?? "orienting",
    summary: update.summary,
    currentAction: update.currentAction === undefined ? previous?.currentAction : update.currentAction,
    nextAction: update.nextAction,
    plan: update.plan ?? previous?.plan ?? [],
    facts: update.facts ?? previous?.facts ?? [],
    unknowns: update.unknowns ?? previous?.unknowns ?? [],
    decisions: update.decisions ?? previous?.decisions ?? [],
    experiments: update.experiments ?? previous?.experiments ?? [],
    artifacts: update.artifacts ?? previous?.artifacts ?? [],
    // Evidence is checkpoint-specific: omission clears prior proof so a later
    // implementation/research slice cannot accidentally carry stale "met" state.
    evidence: update.evidence ?? [],
    reflection: update.reflection,
    strategyChanged: update.strategyChanged === true,
    createdAt: at,
  })!;
}

export function goalIsLive(goal: GoalState | undefined) {
  return !!goal && goal.status !== "complete" && goal.status !== "cleared";
}

export function normalizeGoal(goal: GoalState): GoalState {
  const objective = cleanText(goal.objective);
  const spec = normalizeGoalSpec((goal as Partial<GoalState>).spec, objective);
  const checkpoint = normalizeCheckpoint((goal as Partial<GoalState>).checkpoint, Number((goal as Partial<GoalState>).checkpointCount ?? 0));
  return {
    ...goal,
    version: STATE_VERSION,
    objective: objective || spec.outcome,
    spec,
    checkpoint,
    checkpointCount: Math.max(0, Math.floor(Number((goal as Partial<GoalState>).checkpointCount ?? checkpoint?.sequence ?? 0))),
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

function isEmptyProviderFailure(event: GoalEvent) {
  return event.kind === "iteration_result" && event.stopReason === "error" && !event.hadProgressTool && Math.max(0, Math.floor(event.tokenUsage ?? 0)) === 0;
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
    case "checkpoint":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({
        ...goal,
        checkpoint: event.checkpoint,
        checkpointCount: Math.max(goal.checkpointCount + 1, event.checkpoint.sequence),
        updatedAt: event.at,
      });
    case "extend":
      if (!goal || goal.id !== event.id) return goal;
      return normalizeGoal({ ...goal, maxIterations: Math.max(goal.maxIterations, event.maxIterations), updatedAt: event.at });
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
        afterActions: (goal.afterActions ?? []).map((action) => event.actionIds.includes(action.id) ? { ...action, dispatchedAt: event.at } : action),
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
        consecutiveErrors: isEmptyProviderFailure(event) ? goal.consecutiveErrors + 1 : 0,
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
