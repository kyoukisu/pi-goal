import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { STATUS_KEY } from "./constants";
import { formatDuration, formatTokenBudget, goalEvidenceCounts, goalEvidenceObligations, goalPlanCounts, oneLine, statusLabel } from "./format";
import type { GoalCriterionEvidence, GoalPhase, GoalState } from "./types";

type RenderGoalOptions = {
  activeWorkStartedAt?: number;
};

export type GoalCheckpointHistoryItem = {
  sequence: number;
  phase: GoalPhase;
  summary: string;
  createdAt: number;
};

function statusIcon(goal: GoalState) {
  if (goal.status === "active") return "🚀";
  if (goal.status === "paused") return "⏸";
  return "✅";
}

function displayedWorkSeconds(goal: GoalState, activeWorkStartedAt?: number) {
  const liveSeconds = activeWorkStartedAt ? Math.max(0, Math.round((Date.now() - activeWorkStartedAt) / 1000)) : 0;
  return goal.workTimeSeconds + liveSeconds;
}

function displayedElapsedSeconds(goal: GoalState) {
  const end = goal.status === "complete" && goal.completedAt ? goal.completedAt : Date.now();
  return Math.max(0, Math.round((end - goal.startedAt) / 1000));
}

function turnText(count: number) {
  return count === 1 ? "1 turn" : `${count} turns`;
}

function line(theme: Theme, width: number, branch: "├─" | "└─", text: string) {
  return truncateToWidth(`${theme.fg("dim", branch)} ${text}`, width, "…");
}

function renderWidgetLines(goal: GoalState, options: RenderGoalOptions, theme: Theme, width: number) {
  const label = statusLabel(goal);
  const phase = goal.checkpoint?.phase ?? "orienting";
  const work = formatDuration(displayedWorkSeconds(goal, options.activeWorkStartedAt));
  const wall = formatDuration(displayedElapsedSeconds(goal));
  const displayedTurnCount = goal.turnCount + (options.activeWorkStartedAt ? 1 : 0);
  const color = goal.status === "active" ? "accent" : goal.status === "complete" ? "success" : "warning";
  const title = truncateToWidth(`${theme.fg(color, statusIcon(goal))} ${theme.fg(color, `Goal ${label}`)} ${theme.fg("dim", `· ${phase}`)}`, width, "…");

  const plan = goalPlanCounts(goal);
  const evidence = goalEvidenceCounts(goal);
  const details: string[] = [oneLine(goal.spec.outcome, Math.max(24, width * 2))];
  const progress = [
    plan.total > 0 ? `📋 ${plan.completed}/${plan.total}` : undefined,
    evidence.total > 0 ? `✅ ${evidence.met}/${evidence.total}` : undefined,
    `◇ checkpoint ${goal.checkpointCount}`,
    `↻ ${turnText(displayedTurnCount)}`,
  ].filter(Boolean).join(" · ");
  details.push(progress);

  if (goal.status === "complete") {
    details.push(`✓ ${oneLine(goal.completionSummary || goal.checkpoint?.summary || "Completed with recorded evidence", width * 2)}`);
  } else {
    if (goal.checkpoint?.currentAction) details.push(`▶ ${oneLine(goal.checkpoint.currentAction, width * 2)}`);
    details.push(`→ ${oneLine(goal.checkpoint?.nextAction ?? "orient against current authoritative state", width * 2)}`);
  }

  const activity = [`⏱️ ${work}`];
  if (wall !== work) activity.push(`⌛ ${wall}`);
  activity.push(`🔁 ${goal.iteration}/${goal.maxIterations}`, `🪙 ${formatTokenBudget(goal)}`);
  details.push(activity.join(" · "));
  if (goal.awaitingQuestion) details.push(`❓ ${oneLine(goal.awaitingQuestion, width)}`);
  if (goal.lastErrorMessage) details.push(`⚠ ${oneLine(goal.lastErrorMessage, width)}${goal.consecutiveErrors > 0 ? ` · empty errors ${goal.consecutiveErrors}` : ""}`);
  if (goal.noProgressCount > 0) details.push(`🧊 missing checkpoint ${goal.noProgressCount}`);
  if (goal.status === "active") details.push("/goal status · /goal pause");
  if (goal.status === "paused") details.push("/goal status · /goal resume · /goal clear");

  return [title, ...details.map((text, index) => line(theme, width, index === details.length - 1 ? "└─" : "├─", text))];
}

function normalizeCriterion(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function evidenceFor(goal: GoalState, criterion: string): GoalCriterionEvidence | undefined {
  return goal.checkpoint?.evidence.find((item) => normalizeCriterion(item.criterion) === normalizeCriterion(criterion));
}

function planIcon(status: string) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "→";
  if (status === "blocked") return "!";
  if (status === "superseded") return "×";
  return "○";
}

function evidenceIcon(status: string | undefined) {
  if (status === "met") return "✓";
  if (status === "partial") return "◐";
  if (status === "deferred") return "↷";
  return "○";
}

function age(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function dashboardLines(goal: GoalState, history: GoalCheckpointHistoryItem[], theme: Theme, width: number) {
  const plan = goalPlanCounts(goal);
  const evidence = goalEvidenceCounts(goal);
  const phase = goal.checkpoint?.phase ?? "orienting";
  const color = goal.status === "active" ? "accent" : goal.status === "complete" ? "success" : "warning";
  const lines: string[] = [
    theme.fg(color, theme.bold(`${statusIcon(goal)} Goal ${statusLabel(goal)} · ${phase}`)),
    theme.fg("dim", `${goal.id} · checkpoint ${goal.checkpointCount} · tokens ${formatTokenBudget(goal)}`),
    "",
    theme.fg("accent", theme.bold("Outcome")),
    goal.spec.outcome,
  ];

  if (goal.checkpoint) {
    lines.push(
      "",
      theme.fg("accent", theme.bold("Current state")),
      `${theme.fg("muted", "Summary:")} ${goal.checkpoint.summary}`,
      `${theme.fg("muted", "Now:")} ${goal.checkpoint.currentAction || "—"}`,
      `${theme.fg("muted", "Next:")} ${goal.checkpoint.nextAction}`,
      `${theme.fg("muted", "Progress:")} plan ${plan.completed}/${plan.total || 0} · evidence ${evidence.met}/${evidence.total || 0}`,
    );
  } else {
    lines.push("", theme.fg("warning", "No checkpoint yet — orientation is the next action."));
  }

  const activePlan = (goal.checkpoint?.plan ?? []).filter((item) => item.status !== "superseded");
  const visiblePlan = activePlan.slice(0, 8);
  if (visiblePlan.length > 0) {
    lines.push("", theme.fg("accent", theme.bold(`Living plan (${plan.completed}/${plan.total})`)));
    visiblePlan.forEach((item) => lines.push(`${planIcon(item.status)} ${item.text}${item.evidence ? theme.fg("dim", ` — ${item.evidence}`) : ""}`));
    if (activePlan.length > visiblePlan.length) lines.push(theme.fg("dim", `… ${activePlan.length - visiblePlan.length} more`));
  }

  const obligations = goalEvidenceObligations(goal);
  if (obligations.length > 0) {
    lines.push("", theme.fg("accent", theme.bold(`Contract evidence (${evidence.met}/${evidence.total})`)));
    obligations.slice(0, 8).forEach((criterion) => {
      const item = evidenceFor(goal, criterion);
      const proof = item?.proof[0] ? theme.fg("dim", ` — ${item.proof[0]}`) : "";
      lines.push(`${evidenceIcon(item?.status)} ${criterion}${proof}`);
    });
    if (obligations.length > 8) lines.push(theme.fg("dim", `… ${obligations.length - 8} more`));
  }

  const experiments = goal.checkpoint?.experiments ?? [];
  if (experiments.length > 0) {
    lines.push("", theme.fg("accent", theme.bold(`Experiments (${experiments.length})`)));
    experiments.slice(-5).forEach((item) => {
      const result = item.result ? theme.fg("dim", ` — ${item.result}`) : "";
      lines.push(`⚗ ${item.status} · ${item.question}${result}`);
    });
  }

  const facts = goal.checkpoint?.facts ?? [];
  if (facts.length > 0) {
    lines.push("", theme.fg("accent", theme.bold(`Verified facts (${facts.length})`)));
    facts.slice(-5).forEach((item) => lines.push(`• ${item.text}${item.evidence ? theme.fg("dim", ` — ${item.evidence}`) : ""}`));
  }

  const decisions = (goal.checkpoint?.decisions ?? []).filter((item) => item.status === "active");
  if (decisions.length > 0) {
    lines.push("", theme.fg("accent", theme.bold(`Active decisions (${decisions.length})`)));
    decisions.slice(-5).forEach((item) => lines.push(`◆ ${item.text}${item.rationale ? theme.fg("dim", ` — ${item.rationale}`) : ""}`));
  }

  const artifacts = (goal.checkpoint?.artifacts ?? []).filter((item) => item.status !== "superseded");
  if (artifacts.length > 0) {
    lines.push("", theme.fg("accent", theme.bold(`Artifacts (${artifacts.length})`)));
    artifacts.slice(-5).forEach((item) => lines.push(`${item.status === "authoritative" ? "◆" : "◇"} ${item.path}${item.description ? theme.fg("dim", ` — ${item.description}`) : ""}`));
  }

  if (history.length > 0) {
    lines.push("", theme.fg("accent", theme.bold("Recent checkpoints")));
    history.slice(-5).reverse().forEach((item) => lines.push(`#${item.sequence} ${item.phase} · ${age(item.createdAt)} · ${item.summary}`));
  }

  if (goal.checkpoint?.unknowns.length) {
    lines.push("", theme.fg("warning", theme.bold(`Open unknowns (${goal.checkpoint.unknowns.length})`)));
    goal.checkpoint.unknowns.slice(0, 5).forEach((item) => lines.push(`? ${item}`));
  }

  lines.push("", theme.fg("dim", "↑↓/PgUp/PgDn scroll · Esc close · /goal debug for full state"));
  return lines.map((text) => truncateToWidth(text, width, "…"));
}

export async function showGoalDashboard(ctx: ExtensionContext, goal: GoalState, history: GoalCheckpointHistoryItem[]) {
  if (ctx.mode !== "tui") return;
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let offset = 0;
      let lineCount = 0;
      return {
        render(width: number) {
          const lines = dashboardLines(goal, history, theme, width);
          lineCount = lines.length;
          return lines.slice(offset);
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") done(undefined);
          else if (matchesKey(data, "up") || data === "k") offset = Math.max(0, offset - 1);
          else if (matchesKey(data, "down") || data === "j") offset = Math.min(Math.max(0, lineCount - 1), offset + 1);
          else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - 8);
          else if (matchesKey(data, "pageDown")) offset = Math.min(Math.max(0, lineCount - 1), offset + 8);
          else if (matchesKey(data, "home")) offset = 0;
          else if (matchesKey(data, "end")) offset = Math.max(0, lineCount - 8);
          tui.requestRender();
        },
        invalidate() {},
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center", margin: 1 },
    },
  );
}

export function renderGoal(ctx: ExtensionContext, goal: GoalState | undefined, options: RenderGoalOptions = {}) {
  if (!goal || goal.status === "cleared") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
    return;
  }

  const phase = goal.checkpoint?.phase ?? "orienting";
  const plan = goalPlanCounts(goal);
  const evidence = goalEvidenceCounts(goal);
  const progress = [
    plan.total > 0 ? `${plan.completed}/${plan.total} plan` : undefined,
    evidence.total > 0 ? `${evidence.met}/${evidence.total} evidence` : undefined,
  ].filter(Boolean).join(" · ");
  ctx.ui.setStatus(STATUS_KEY, `${statusIcon(goal)} goal:${statusLabel(goal)} · ${phase}${progress ? ` · ${progress}` : ""}`);
  ctx.ui.setWidget(
    STATUS_KEY,
    (_tui, theme) => ({
      render(width: number) {
        return renderWidgetLines(goal, options, theme, width);
      },
      invalidate() {},
    }),
    { placement: "aboveEditor" },
  );
}
