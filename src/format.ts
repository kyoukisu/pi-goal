import type { GoalState } from "./types";

export function now() {
  return Date.now();
}

export function newId() {
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function elapsedSeconds(goal: GoalState) {
  return Math.max(0, Math.round((Date.now() - goal.startedAt) / 1000));
}

export function oneLine(text: string, max = 120) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function formatDuration(seconds: number | undefined) {
  const whole = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

export function formatTokenCount(value: number | undefined) {
  const whole = Math.max(0, Math.floor(value ?? 0));
  if (whole < 1_000) return String(whole);
  if (whole < 1_000_000) return `${Number.isInteger(whole / 1_000) ? whole / 1_000 : (whole / 1_000).toFixed(1)}k`;
  return `${Number.isInteger(whole / 1_000_000) ? whole / 1_000_000 : (whole / 1_000_000).toFixed(1)}m`;
}

export function formatTokenBudget(goal: GoalState) {
  return goal.tokenBudget === undefined
    ? `${formatTokenCount(goal.tokensUsed)} · budget off`
    : `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
}

export function goalPlanCounts(goal: GoalState) {
  const plan = (goal.checkpoint?.plan ?? []).filter((item) => item.status !== "superseded");
  return {
    completed: plan.filter((item) => item.status === "completed").length,
    total: plan.length,
  };
}

function normalizeEvidenceKey(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function goalEvidenceObligations(goal: GoalState) {
  const seen = new Set<string>();
  const amendments = (goal.amendments ?? []).map((item) => item.text);
  return [...goal.spec.requirements, ...goal.spec.constraints, ...goal.spec.successCriteria, ...amendments].filter((item) => {
    const key = normalizeEvidenceKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function goalEvidenceCounts(goal: GoalState) {
  const evidence = goal.checkpoint?.evidence ?? [];
  const obligations = goalEvidenceObligations(goal);
  if (obligations.length === 0) {
    return { met: evidence.filter((item) => item.status === "met").length, total: evidence.length };
  }
  return {
    met: obligations.filter((criterion) =>
      evidence.some((item) => normalizeEvidenceKey(item.criterion) === normalizeEvidenceKey(criterion) && item.status === "met"),
    ).length,
    total: obligations.length,
  };
}

export function statusLabel(goal: GoalState) {
  if (goal.status === "paused" && goal.pauseReason) return `paused:${goal.pauseReason}`;
  return goal.status;
}

export function progressBar(goal: GoalState, width = 14) {
  const ratio = goal.maxIterations > 0 ? Math.min(1, goal.iteration / goal.maxIterations) : 0;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}
