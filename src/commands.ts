import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_MINUTES, DEFAULT_TOKEN_BUDGET, STATE_VERSION } from "./constants";
import { formatDuration, formatTokenBudget, formatTokenCount, newId, now, oneLine, statusLabel } from "./format";
import { applyEvent, goalIsLive } from "./state";
import type { GoalEvent, GoalState, PauseReason } from "./types";
import { renderGoal } from "./ui";

function goalElapsedSeconds(goal: GoalState) {
  const end = goal.status === "complete" && goal.completedAt ? goal.completedAt : Date.now();
  return Math.max(0, Math.round((end - goal.startedAt) / 1000));
}

function collectGoals(ctx: ExtensionContext) {
  const goals: GoalState[] = [];
  let current: GoalState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "pi-goal:event") continue;
    current = applyEvent(current, entry.data as GoalEvent);
    if (!current) continue;
    const index = goals.findIndex((item) => item.id === current!.id);
    if (index >= 0) goals[index] = current;
    else goals.push(current);
  }
  return goals.filter((item) => item.status !== "cleared");
}

function goalIcon(goal: GoalState) {
  if (goal.status === "complete") return "✅";
  if (goal.status === "paused") return "⏸";
  return "🚀";
}

function goalSummary(goal: GoalState) {
  return goal.completionSummary || goal.objective;
}

function goalListRow(goal: GoalState, index: number, selected: boolean, theme: Theme, width: number) {
  const prefix = selected ? theme.fg("accent", "→ ") : "  ";
  const status = theme.fg(goal.status === "complete" ? "success" : goal.status === "paused" ? "warning" : "accent", `${goalIcon(goal)} #${index + 1} ${statusLabel(goal)}`);
  const time = theme.fg("dim", ` ⏱️  ${formatDuration(goal.workTimeSeconds)} · ⌛  ${formatDuration(goalElapsedSeconds(goal))}`);
  return truncateToWidth(prefix + status + time + "  " + theme.fg("muted", oneLine(goalSummary(goal), 160)), width, "…");
}

async function showGoalList(ctx: ExtensionContext, goals: GoalState[]) {
  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      let selected = Math.max(0, goals.length - 1);
      return {
        render(width: number) {
          const lines = [theme.fg("accent", `Goals (${goals.length})`), ""];
          goals.forEach((goal, index) => lines.push(goalListRow(goal, index, selected === index, theme, width)));
          const selectedGoal = goals[selected];
          if (selectedGoal) {
            lines.push("", theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
            lines.push(truncateToWidth(theme.fg("muted", goalSummary(selectedGoal)), width, "…"));
          }
          lines.push("", theme.fg("dim", "↑↓ select · esc close"));
          return lines.map((line) => truncateToWidth(line, width, "…"));
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape") || data === "q") done(undefined);
          else if (matchesKey(data, "up") || data === "k") selected = Math.max(0, selected - 1);
          else if (matchesKey(data, "down") || data === "j") selected = Math.min(goals.length - 1, selected + 1);
        },
        invalidate() {},
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "70%", anchor: "center" },
    },
  );
}

function parseTokenBudget(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.floor(amount * multiplier);
}

function parseObjectiveArgs(args: string) {
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let maxMinutes = DEFAULT_MAX_MINUTES;
  let tokenBudget = DEFAULT_TOKEN_BUDGET;
  const parts = args.trim().split(/\s+/);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if ((part === "--max" || part === "--max-iterations") && parts[i + 1]) {
      const value = Number(parts[++i]);
      if (Number.isFinite(value) && value > 0) maxIterations = Math.floor(value);
      continue;
    }
    if (part === "--tokens" && parts[i + 1]) {
      tokenBudget = parseTokenBudget(parts[++i]) ?? tokenBudget;
      continue;
    }
    if (part === "--max-minutes" && parts[i + 1]) {
      // Deprecated compatibility: parse and store, but runtime no longer enforces wall-clock budgets.
      const value = Number(parts[++i]);
      if (Number.isFinite(value) && value > 0) maxMinutes = Math.floor(value);
      continue;
    }
    kept.push(part);
  }
  return { objective: kept.join(" ").trim(), maxIterations, maxMinutes, tokenBudget };
}

type CommandDeps = {
  refresh: (ctx: ExtensionContext) => GoalState | undefined;
  append: (event: GoalEvent) => void;
  pause: (ctx: ExtensionContext, goal: GoalState, reason: PauseReason, question?: string) => void;
  queueContinuation: (ctx: ExtensionContext, goal: GoalState, reason: string) => void;
  getCachedGoal: () => GoalState | undefined;
  setCachedGoal: (goal: GoalState | undefined) => void;
};

export function registerGoalCommand(pi: ExtensionAPI, deps: CommandDeps) {
  pi.registerCommand("goal", {
    description: "Set/show/extend/pause/resume/clear a persistent Codex-style goal",
    getArgumentCompletions(prefix) {
      const cmds = ["add", "extend", "budget", "after", "pause", "resume", "clear", "status", "list", "stop", "debug"];
      const items = cmds.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      let goal = deps.refresh(ctx);

      if (!trimmed || trimmed === "status") {
        if (!goal) {
          ctx.ui.notify("No goal set. Usage: /goal <objective>", "info");
          return;
        }
        const text = [
          `Goal ${statusLabel(goal)} · ${goal.iteration}/${goal.maxIterations}`,
          `Time: work ${formatDuration(goal.workTimeSeconds)} · elapsed ${formatDuration(goalElapsedSeconds(goal))}`,
          `Tokens: ${formatTokenBudget(goal)}`,
          goal.maxMinutes ? `Deprecated wall budget stored but not enforced: ${goal.maxMinutes}m` : undefined,
          goal.objective,
          goal.amendments?.length ? `Added requirements: ${goal.amendments.length}` : undefined,
          goal.afterActions?.length ? `Post-goal actions: ${goal.afterActions.length}` : undefined,
          goal.completionAudit ? `Audit: ${goal.completionAudit}` : undefined,
          goal.awaitingQuestion ? `Awaiting user: ${goal.awaitingQuestion}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        ctx.ui.notify(text, goal.status === "paused" ? "warning" : "info");
        renderGoal(ctx, goal);
        return;
      }

      if (trimmed === "debug") {
        ctx.ui.notify(JSON.stringify(goal ?? null, null, 2), "info");
        return;
      }

      if (trimmed === "list") {
        const goals = collectGoals(ctx);
        if (goals.length === 0) {
          ctx.ui.notify("No goals in this branch.", "info");
          return;
        }
        await showGoalList(ctx, goals);
        return;
      }

      if (trimmed.startsWith("add ")) {
        if (!goal || !goalIsLive(goal)) {
          ctx.ui.notify("No live goal to amend.", "warning");
          return;
        }
        const text = trimmed.slice(4).trim();
        if (!text) {
          ctx.ui.notify("Usage: /goal add <requirement>", "warning");
          return;
        }
        deps.append({ kind: "amend", id: goal.id, amendmentId: newId(), text, at: now() });
        renderGoal(ctx, deps.getCachedGoal());
        ctx.ui.notify(`Goal requirement added: ${oneLine(text)}`, "info");
        return;
      }

      if (trimmed === "extend" || trimmed.startsWith("extend ")) {
        if (!goal || !goalIsLive(goal)) {
          ctx.ui.notify("No live goal to extend.", "warning");
          return;
        }
        const value = Number(trimmed.slice(7).trim());
        if (!Number.isFinite(value) || value <= 0) {
          ctx.ui.notify("Usage: /goal extend <positive-iteration-count>", "warning");
          return;
        }
        const extra = Math.floor(value);
        const maxIterations = goal.maxIterations + extra;
        const shouldResume = goal.status === "paused" && goal.pauseReason === "max_iterations";
        deps.append({ kind: "extend", id: goal.id, maxIterations, at: now() });
        goal = deps.getCachedGoal();
        renderGoal(ctx, goal);
        if (shouldResume && goal) {
          if (!ctx.isIdle()) {
            ctx.ui.notify(`Goal limit extended to ${maxIterations}. Run /goal resume when idle.`, "info");
            return;
          }
          deps.append({ kind: "status", id: goal.id, status: "active", at: now() });
          goal = deps.getCachedGoal();
          renderGoal(ctx, goal);
          ctx.ui.notify(`Goal limit extended to ${maxIterations}; resuming.`, "info");
          if (goal) deps.queueContinuation(ctx, goal, "extend");
          return;
        }
        ctx.ui.notify(`Goal limit extended to ${maxIterations}.`, "info");
        return;
      }

      if (trimmed === "budget" || trimmed.startsWith("budget ")) {
        if (!goal || !goalIsLive(goal)) {
          ctx.ui.notify("No live goal to update budget.", "warning");
          return;
        }
        const raw = trimmed.slice("budget".length).trim();
        if (!raw) {
          ctx.ui.notify(`Goal token budget: ${formatTokenBudget(goal)}. Usage: /goal budget <tokens|off|+tokens>`, "info");
          return;
        }
        let tokenBudget: number | undefined;
        if (raw === "off" || raw === "none" || raw === "clear") {
          tokenBudget = undefined;
        } else if (raw.startsWith("+")) {
          const extra = parseTokenBudget(raw.slice(1));
          if (!extra) {
            ctx.ui.notify("Usage: /goal budget <tokens|off|+tokens>, e.g. /goal budget 200k or /goal budget +50k", "warning");
            return;
          }
          tokenBudget = Math.max(goal.tokenBudget ?? goal.tokensUsed, goal.tokensUsed) + extra;
        } else {
          tokenBudget = parseTokenBudget(raw);
          if (!tokenBudget) {
            ctx.ui.notify("Usage: /goal budget <tokens|off|+tokens>, e.g. /goal budget 200k or /goal budget +50k", "warning");
            return;
          }
        }
        deps.append({ kind: "budget", id: goal.id, tokenBudget, at: now() });
        goal = deps.getCachedGoal();
        renderGoal(ctx, goal);
        ctx.ui.notify(tokenBudget === undefined ? "Goal token budget disabled." : `Goal token budget set to ${formatTokenCount(tokenBudget)}.`, "info");
        return;
      }

      if (trimmed.startsWith("after ")) {
        if (!goal || !goalIsLive(goal)) {
          ctx.ui.notify("No live goal for post-goal action.", "warning");
          return;
        }
        const text = trimmed.slice(6).trim();
        if (!text) {
          ctx.ui.notify("Usage: /goal after <post-goal action>", "warning");
          return;
        }
        deps.append({ kind: "after", id: goal.id, actionId: newId(), text, at: now() });
        renderGoal(ctx, deps.getCachedGoal());
        ctx.ui.notify(`Post-goal action added: ${oneLine(text)}`, "info");
        return;
      }

      if (trimmed === "pause" || trimmed === "stop") {
        if (!goal || goal.status !== "active") {
          ctx.ui.notify("No active goal to pause.", "warning");
          return;
        }
        deps.pause(ctx, goal, "user");
        ctx.ui.notify("Goal paused.", "info");
        return;
      }

      if (trimmed === "resume") {
        if (!goal) {
          ctx.ui.notify("No goal to resume.", "warning");
          return;
        }
        if (goal.status === "complete") {
          ctx.ui.notify("Goal is already complete. Use /goal <objective> to start a new one.", "warning");
          return;
        }
        if (goal.status === "paused" && goal.pauseReason === "max_iterations" && goal.iteration >= goal.maxIterations) {
          ctx.ui.notify(`Goal hit its iteration limit (${goal.maxIterations}). Use /goal extend <N> to continue.`, "warning");
          return;
        }
        if (goal.status === "paused" && goal.pauseReason === "token_budget" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
          ctx.ui.notify(`Goal hit its token budget (${formatTokenBudget(goal)}). Use /goal budget +50k, /goal budget <tokens>, or /goal budget off.`, "warning");
          return;
        }
        deps.append({ kind: "status", id: goal.id, status: "active", at: now() });
        goal = deps.getCachedGoal();
        renderGoal(ctx, goal);
        if (goal) deps.queueContinuation(ctx, goal, "resume");
        return;
      }

      if (trimmed === "clear") {
        if (!goal) {
          ctx.ui.notify("No goal to clear.", "info");
          return;
        }
        deps.append({ kind: "clear", id: goal.id, at: now() });
        deps.setCachedGoal(undefined);
        renderGoal(ctx, undefined);
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Run /goal again when idle.", "warning");
        return;
      }

      const parsed = parseObjectiveArgs(trimmed);
      if (!parsed.objective) {
        ctx.ui.notify("Usage: /goal [--max N] [--tokens 200k] <objective>", "warning");
        return;
      }

      if (goalIsLive(goal)) {
        const ok = await ctx.ui.confirm("Replace active goal?", `Current: ${goal!.objective}\n\nNew: ${parsed.objective}`);
        if (!ok) return;
      }

      const t = now();
      const newGoal: GoalState = {
        version: STATE_VERSION,
        id: newId(),
        objective: parsed.objective,
        status: "active",
        createdAt: t,
        updatedAt: t,
        startedAt: t,
        iteration: 0,
        maxIterations: parsed.maxIterations,
        maxMinutes: parsed.maxMinutes,
        tokenBudget: parsed.tokenBudget,
        tokensUsed: 0,
        workTimeSeconds: 0,
        turnCount: 0,
        noProgressCount: 0,
        consecutiveErrors: 0,
      };
      deps.append({ kind: "set", goal: newGoal });
      renderGoal(ctx, deps.getCachedGoal());
      ctx.ui.notify(`Goal started: ${oneLine(newGoal.objective)}`, "info");
      deps.queueContinuation(ctx, newGoal, "slash_command");
    },
  });
}
