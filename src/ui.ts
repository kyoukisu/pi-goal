import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { STATUS_KEY } from "./constants";
import { formatDuration, formatTokenBudget, oneLine, statusLabel } from "./format";
import type { GoalState } from "./types";

type RenderGoalOptions = {
  activeWorkStartedAt?: number;
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
  const work = formatDuration(displayedWorkSeconds(goal, options.activeWorkStartedAt));
  const wall = formatDuration(displayedElapsedSeconds(goal));
  const displayedTurnCount = goal.turnCount + (options.activeWorkStartedAt ? 1 : 0);
  const color = goal.status === "active" ? "accent" : goal.status === "complete" ? "success" : "warning";
  const title = truncateToWidth(`${theme.fg(color, statusIcon(goal))} ${theme.fg(color, `Goal ${label}`)}`, width, "…");

  const activity = [`⏱️  ${work}`];
  if (wall !== work) activity.push(`⌛  ${wall}`);
  activity.push(`↻ ${turnText(displayedTurnCount)}`);
  if (goal.status !== "complete" || goal.iteration > 0) activity.push(`🔁 ${goal.iteration}/${goal.maxIterations}`);

  const lines = [title];
  const summary = goal.status === "complete" && goal.completionSummary ? goal.completionSummary : goal.objective;
  const details: string[] = [activity.join(" · "), `🪙 ${formatTokenBudget(goal)}`, oneLine(summary, Math.max(24, width * 2))];
  if (goal.awaitingQuestion) details.push(`❓ ${oneLine(goal.awaitingQuestion, width)}`);
  if (goal.noProgressCount > 0) details.push(`🧊 no-progress ${goal.noProgressCount}`);
  if (goal.status === "active") details.push("▶ auto · /goal pause");
  if (goal.status === "paused") details.push("▶ /goal resume · 🗑 /goal clear");

  details.forEach((text, index) => {
    lines.push(line(theme, width, index === details.length - 1 ? "└─" : "├─", text));
  });
  return lines;
}

export function renderGoal(ctx: ExtensionContext, goal: GoalState | undefined, options: RenderGoalOptions = {}) {
  if (!goal || goal.status === "cleared") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
    return;
  }

  const label = statusLabel(goal);
  const work = formatDuration(displayedWorkSeconds(goal, options.activeWorkStartedAt));
  ctx.ui.setStatus(STATUS_KEY, `${statusIcon(goal)} goal:${label} · ${work}`);
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
