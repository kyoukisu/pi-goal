import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_MINUTES, MIN_AUDIT_CHARS, STATE_VERSION } from "./constants";
import { newId, now } from "./format";
import { goalIsLive } from "./state";
import type { GoalEvent, GoalState, PauseReason } from "./types";

export function hasTool(pi: ExtensionAPI, name: string) {
  return pi.getAllTools().some((tool) => tool.name === name);
}

export function availableQuestionTool(pi: ExtensionAPI) {
  if (hasTool(pi, "ask_user_question")) return "ask_user_question";
  if (hasTool(pi, "question")) return "question";
  if (hasTool(pi, "ask_user")) return "ask_user";
  return undefined;
}

export function isQuestionTool(toolName: string) {
  return ["ask_user_question", "question", "ask_user"].includes(toolName);
}

export function isProgressTool(toolName: string) {
  return !["get_goal", "goal_need_user_input"].includes(toolName);
}

type ToolDeps = {
  refresh: (ctx: ExtensionContext) => GoalState | undefined;
  append: (event: GoalEvent) => void;
  pause: (ctx: ExtensionContext, goal: GoalState, reason: PauseReason, question?: string) => void;
  queueContinuation: (ctx: ExtensionContext, goal: GoalState, reason: string) => void;
  getCachedGoal: () => GoalState | undefined;
  render: (ctx: ExtensionContext) => void;
};

export function registerGoalTools(pi: ExtensionAPI, deps: ToolDeps) {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current persistent Pi goal for this session, if any.",
    promptSnippet: "Read the active persistent Pi goal state",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const goal = deps.refresh(ctx);
      return {
        content: [{ type: "text", text: goal ? JSON.stringify(goal, null, 2) : "No active goal." }],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a persistent Pi goal only when explicitly requested by the user or system. Fails if a live goal already exists.",
    promptSnippet: "Create a persistent Pi goal when explicitly requested",
    promptGuidelines: [
      "Use create_goal only when the user explicitly asks to start a persistent/autonomous goal; do not infer goals from ordinary tasks.",
    ],
    parameters: Type.Object({
      objective: Type.String({ description: "Concrete objective to pursue" }),
      maxIterations: Type.Optional(Type.Number({ description: "Optional max continuation iterations" })),
      maxMinutes: Type.Optional(Type.Number({ description: "Optional max elapsed minutes" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const existing = deps.refresh(ctx);
      if (goalIsLive(existing)) throw new Error("cannot create a new goal because this session already has a live goal");
      const t = now();
      const goal: GoalState = {
        version: STATE_VERSION,
        id: newId(),
        objective: params.objective.trim(),
        status: "active",
        createdAt: t,
        updatedAt: t,
        startedAt: t,
        iteration: 0,
        maxIterations: Math.max(1, Math.floor(params.maxIterations ?? DEFAULT_MAX_ITERATIONS)),
        maxMinutes: params.maxMinutes ? Math.max(1, Math.floor(params.maxMinutes)) : DEFAULT_MAX_MINUTES,
        workTimeSeconds: 0,
        turnCount: 0,
        noProgressCount: 0,
        consecutiveErrors: 0,
      };
      if (!goal.objective) throw new Error("goal objective must not be empty");
      deps.append({ kind: "set", goal });
      deps.render(ctx);
      return { content: [{ type: "text", text: `Goal created: ${goal.objective}` }], details: { goal } };
    },
  });

  pi.registerTool({
    name: "complete_goal",
    label: "Complete Goal",
    description: "Mark the active Pi goal complete only after verifying every requirement with real evidence.",
    promptSnippet: "Mark the persistent Pi goal complete after an evidence audit",
    promptGuidelines: [
      "Use complete_goal only when the active Pi goal is achieved and the audit proves no required work remains.",
      "Do not call complete_goal merely because you are stopping, blocked, near an iteration limit, or have made substantial progress.",
    ],
    parameters: Type.Object({
      audit: Type.String({ description: "Concise evidence checklist proving the goal is complete" }),
      summary: Type.Optional(Type.String({ description: "Optional very short user-visible completion summary" })),
      goalId: Type.Optional(Type.String({ description: "Optional current goal id from get_goal" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const goal = deps.refresh(ctx);
      if (!goal || goal.status !== "active") throw new Error("no active goal to complete");
      if (params.goalId && params.goalId !== goal.id) throw new Error("goal id mismatch; call get_goal and audit the current goal");
      const audit = params.audit.trim();
      if (audit.length < MIN_AUDIT_CHARS) throw new Error(`audit too short; provide at least ${MIN_AUDIT_CHARS} characters of concrete evidence`);
      deps.append({ kind: "complete", id: goal.id, audit, summary: params.summary?.trim(), at: now() });
      deps.render(ctx);
      return {
        content: [{ type: "text", text: `Goal complete. Audit recorded:\n${audit}` }],
        details: { goal: deps.getCachedGoal(), audit },
      };
    },
  });

  pi.registerTool({
    name: "goal_need_user_input",
    label: "Need User Input",
    description: "Pause the active Pi goal when it cannot safely continue without a concrete user answer. Prefer ask_user_question/question/ask_user when available.",
    parameters: Type.Object({
      question: Type.String({ description: "The focused question that blocks progress" }),
      reason: Type.Optional(Type.String({ description: "Why this answer is required" })),
      options: Type.Optional(Type.Array(Type.String({ description: "Optional short choices" }))),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const goal = deps.refresh(ctx);
      if (!goal || goal.status !== "active") throw new Error("no active goal to pause for user input");

      let answer: string | undefined;
      if (ctx.hasUI) {
        const title = params.reason ? `${params.question}\n\n${params.reason}` : params.question;
        if (params.options && params.options.length > 0) {
          answer = await ctx.ui.select(title, [...params.options, "Other / freeform"]);
          if (answer === "Other / freeform") answer = await ctx.ui.input(params.question, "Type answer");
        } else {
          answer = await ctx.ui.input(title, "Type answer");
        }
      }

      if (answer && answer.trim()) {
        return {
          content: [{ type: "text", text: `User answered: ${answer.trim()}\nContinue working toward the active goal.` }],
          details: { answered: true, answer: answer.trim() },
        };
      }

      deps.pause(ctx, goal, "need_user_input", params.question);
      return {
        content: [{ type: "text", text: "Goal paused awaiting user input. The user can answer and run /goal resume." }],
        details: { answered: false, question: params.question, reason: params.reason },
      };
    },
  });
}
