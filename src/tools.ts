import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { constants as FsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_MINUTES, DEFAULT_TOKEN_BUDGET, MIN_AUDIT_CHARS, STATE_VERSION } from "./constants";
import { goalEvidenceObligations, newId, now } from "./format";
import { buildCheckpoint, goalIsLive, legacyGoalSpec } from "./state";
import type { GoalCheckpointUpdate, GoalEvent, GoalSpec, GoalState, PauseReason } from "./types";

const phaseSchema = StringEnum(["orienting", "researching", "experimenting", "implementing", "verifying", "blocked"] as const);
const planStatusSchema = StringEnum(["pending", "in_progress", "completed", "blocked", "superseded"] as const);
const experimentStatusSchema = StringEnum(["planned", "running", "succeeded", "failed", "inconclusive"] as const);
const artifactStatusSchema = StringEnum(["authoritative", "supporting", "superseded"] as const);
const evidenceStatusSchema = StringEnum(["met", "partial", "unmet", "deferred"] as const);

const planItemSchema = Type.Object({
  text: Type.String({ description: "Milestone or work item" }),
  status: planStatusSchema,
  evidence: Type.Optional(Type.String({ description: "Concise evidence for this item" })),
});

const factSchema = Type.Object({
  text: Type.String({ description: "Observed or verified fact, not a guess" }),
  evidence: Type.Optional(Type.String({ description: "Source, command, file, URL, or result supporting the fact" })),
});

const decisionSchema = Type.Object({
  text: Type.String({ description: "Current decision" }),
  rationale: Type.Optional(Type.String({ description: "Why this decision follows from current evidence" })),
  status: StringEnum(["active", "superseded"] as const),
});

const experimentSchema = Type.Object({
  question: Type.String({ description: "Question or hypothesis tested" }),
  status: experimentStatusSchema,
  method: Type.Optional(Type.String({ description: "Command, probe, prototype, or procedure" })),
  result: Type.Optional(Type.String({ description: "Observed result, including negative or inconclusive results" })),
  evidence: Type.Optional(Type.String({ description: "Artifact path or compact output reference" })),
});

const artifactSchema = Type.Object({
  path: Type.String({ description: "Local path or URL" }),
  description: Type.Optional(Type.String({ description: "Why this artifact matters" })),
  status: artifactStatusSchema,
});

const criterionEvidenceSchema = Type.Object({
  criterion: Type.String({ description: "Exact explicit requirement, hard constraint, or success criterion from the goal spec" }),
  status: evidenceStatusSchema,
  proof: Type.Array(Type.String({ description: "Concrete file, command, runtime, or URL evidence" })),
});

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

export function isGoalBoundaryTool(toolName: string) {
  return toolName === "create_goal" || toolName === "checkpoint_goal" || toolName === "complete_goal";
}

export function isProgressTool(toolName: string) {
  return toolName === "checkpoint_goal" || toolName === "complete_goal";
}

function cleanStringList(value: string[] | undefined) {
  return (value ?? []).map((item) => item.trim()).filter(Boolean);
}

function latestUserEntryIds(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") return [entry.id];
  }
  return [];
}

function normalizeCriterion(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function unmetStructuredObligations(goal: GoalState) {
  if (goal.spec.provenance !== "structured") return [];
  const evidence = goal.checkpoint?.evidence ?? [];
  return goalEvidenceObligations(goal).filter((criterion) => {
    const match = evidence.find((item) => normalizeCriterion(item.criterion) === normalizeCriterion(criterion));
    return !match || match.status !== "met" || match.proof.length === 0;
  });
}

function auditLooksIncomplete(audit: string) {
  return /not complete|not completed|not verified|could not verify|couldn't verify|tests? still fail|failing tests?|remaining work|incomplete|blocked|cannot verify|can't verify/i.test(audit);
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "goal";
}

async function resolveRunLogDir(ctx: ExtensionContext) {
  const configured = process.env.PI_GOAL_RUN_LOG_DIR;
  if (configured) {
    const dir = isAbsolute(configured) ? configured : resolve(ctx.cwd, configured);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  const dir = join(ctx.cwd, "runs", "agentic-loops");
  try {
    await access(dir, FsConstants.W_OK);
    return dir;
  } catch {
    return undefined;
  }
}

async function formatGoalStateOutput(goal: GoalState) {
  const json = JSON.stringify(goal, null, 2);
  const truncation = truncateHead(json, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return truncation.content;

  const path = join(tmpdir(), `${goal.id}-state.json`);
  await withFileMutationQueue(path, async () => {
    await writeFile(path, json, { encoding: "utf8", mode: 0o600 });
  });
  return `${truncation.content}\n\n[Goal state truncated: ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}. Full state: ${path}]`;
}

async function writeRunLogIfEnabled(ctx: ExtensionContext, goal: GoalState, audit: string, summary?: string) {
  const dir = await resolveRunLogDir(ctx);
  if (!dir) return undefined;
  const date = new Date().toISOString();
  const path = join(dir, `${date.slice(0, 10)}-${goal.id}-${slugify(goal.objective)}.md`);
  const body = [
    `# ${goal.objective}`,
    "",
    `- Goal ID: ${goal.id}`,
    `- Completed: ${date}`,
    `- Status: ${goal.status}`,
    `- Checkpoints: ${goal.checkpointCount}`,
    summary ? `- Summary: ${summary}` : undefined,
    "",
    "## Source brief",
    "",
    goal.spec.sourceBrief,
    goal.checkpoint ? "" : undefined,
    goal.checkpoint ? "## Final checkpoint" : undefined,
    goal.checkpoint ? "" : undefined,
    goal.checkpoint ? `- Phase: ${goal.checkpoint.phase}` : undefined,
    goal.checkpoint ? `- Summary: ${goal.checkpoint.summary}` : undefined,
    goal.checkpoint ? `- Next action at completion: ${goal.checkpoint.nextAction}` : undefined,
    goal.checkpoint?.artifacts.length ? `- Artifacts: ${goal.checkpoint.artifacts.map((item) => item.path).join(", ")}` : undefined,
    "",
    "## Audit",
    "",
    audit,
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
  await withFileMutationQueue(path, async () => {
    await writeFile(path, body, "utf8");
  });
  return path;
}

type ToolDeps = {
  refresh: (ctx: ExtensionContext) => GoalState | undefined;
  append: (event: GoalEvent) => void;
  pause: (ctx: ExtensionContext, goal: GoalState, reason: PauseReason, question?: string) => void;
  queueContinuation: (ctx: ExtensionContext, goal: GoalState, reason: string) => void;
  dispatchPostGoalActions: (ctx: ExtensionContext, goal: GoalState) => void;
  getCachedGoal: () => GoalState | undefined;
  render: (ctx: ExtensionContext) => void;
};

export function registerGoalTools(pi: ExtensionAPI, deps: ToolDeps) {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current persistent Pi goal for this session. Output is capped at 50KB/2000 lines; oversized full JSON is saved to a local temporary file.",
    promptSnippet: "Read the active persistent Pi goal state",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const goal = deps.refresh(ctx);
      return {
        content: [{ type: "text", text: goal ? await formatGoalStateOutput(goal) : "No active goal." }],
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
      objective: Type.String({ description: "Concrete outcome to achieve; do not embed a fixed execution plan" }),
      sourceBrief: Type.Optional(Type.String({ description: "The user's original task request verbatim, preserving named inputs and details" })),
      why: Type.Optional(Type.String({ description: "Why the outcome matters to the user" })),
      context: Type.Optional(Type.Array(Type.String({ description: "User-provided context anchor" }))),
      requirements: Type.Optional(Type.Array(Type.String({ description: "Explicit user requirement only" }))),
      constraints: Type.Optional(Type.Array(Type.String({ description: "Explicit task-specific hard constraint or non-goal" }))),
      suggestedApproaches: Type.Optional(Type.Array(Type.String({ description: "Non-binding avenue or example; never a mandatory plan step" }))),
      successCriteria: Type.Optional(Type.Array(Type.String({ description: "Observable outcome or evidence criterion, not a prescribed method" }))),
      autonomy: Type.Optional(Type.Array(Type.String({ description: "Within-scope actions the agent may take without asking" }))),
      maxIterations: Type.Optional(Type.Number({ description: "Optional max continuation iterations" })),
      tokenBudget: Type.Optional(Type.Number({ description: "Optional token budget. Omit to leave budget enforcement off." })),
      maxMinutes: Type.Optional(Type.Number({ description: "Deprecated no-op wall-clock budget; use tokenBudget" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const existing = deps.refresh(ctx);
      if (goalIsLive(existing)) throw new Error("cannot create a new goal because this session already has a live goal");
      const t = now();
      const objective = params.objective.trim();
      if (!objective) throw new Error("goal objective must not be empty");

      const isStructured = params.sourceBrief !== undefined
        || params.why !== undefined
        || params.context !== undefined
        || params.requirements !== undefined
        || params.constraints !== undefined
        || params.suggestedApproaches !== undefined
        || params.successCriteria !== undefined
        || params.autonomy !== undefined;
      const spec: GoalSpec = isStructured
        ? {
            provenance: "structured",
            sourceBrief: params.sourceBrief && params.sourceBrief.trim() ? params.sourceBrief : objective,
            sourceEntryIds: latestUserEntryIds(ctx),
            outcome: objective,
            why: params.why?.trim() || undefined,
            context: cleanStringList(params.context),
            requirements: cleanStringList(params.requirements),
            constraints: cleanStringList(params.constraints),
            suggestedApproaches: cleanStringList(params.suggestedApproaches),
            successCriteria: cleanStringList(params.successCriteria),
            autonomy: cleanStringList(params.autonomy),
          }
        : { ...legacyGoalSpec(objective), sourceEntryIds: latestUserEntryIds(ctx) };

      const goal: GoalState = {
        version: STATE_VERSION,
        id: newId(),
        objective,
        spec,
        checkpointCount: 0,
        status: "active",
        createdAt: t,
        updatedAt: t,
        startedAt: t,
        iteration: 0,
        maxIterations: Math.max(1, Math.floor(params.maxIterations ?? DEFAULT_MAX_ITERATIONS)),
        maxMinutes: params.maxMinutes === undefined ? DEFAULT_MAX_MINUTES : Math.max(1, Math.floor(params.maxMinutes)),
        tokenBudget: params.tokenBudget === undefined ? DEFAULT_TOKEN_BUDGET : Math.max(1, Math.floor(params.tokenBudget)),
        tokensUsed: 0,
        workTimeSeconds: 0,
        turnCount: 0,
        noProgressCount: 0,
        consecutiveErrors: 0,
      };
      deps.append({ kind: "set", goal });
      deps.render(ctx);
      return {
        content: [{ type: "text", text: `Goal created: ${goal.objective}\nToken budget: ${goal.tokenBudget === undefined ? "off" : goal.tokenBudget}` }],
        details: { goal },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "checkpoint_goal",
    label: "Checkpoint Goal",
    description: "Persist the active goal's current working state after one bounded semantic slice, then end the run so the next continuation starts from this checkpoint.",
    promptSnippet: "Persist facts, plan, experiments, artifacts, evidence, and the next action for the active goal",
    promptGuidelines: [
      "Call checkpoint_goal as the sole final tool call after each bounded research, experiment, implementation, synthesis, or verification slice.",
      "Use checkpoint_goal to record semantic progress; ordinary tool activity is not durable goal progress by itself.",
      "Keep the checkpoint compact and current. Omitted list sections preserve their previous values except evidence, which clears when omitted so stale proof cannot survive later work; pass an empty list to clear any section.",
    ],
    parameters: Type.Object({
      phase: phaseSchema,
      summary: Type.String({ description: "What is now true or materially changed in this slice" }),
      currentAction: Type.Optional(Type.String({ description: "Current focus if work remains in-flight; pass an empty string to clear" })),
      nextAction: Type.String({ description: "Exact highest-value next bounded action for a fresh agent" }),
      plan: Type.Optional(Type.Array(planItemSchema, { description: "Full current living plan; replaces the prior plan when supplied" })),
      facts: Type.Optional(Type.Array(factSchema, { description: "Full current set of verified facts; replaces prior facts when supplied" })),
      unknowns: Type.Optional(Type.Array(Type.String(), { description: "Full current unknowns or assumptions needing validation" })),
      decisions: Type.Optional(Type.Array(decisionSchema, { description: "Full current decision ledger, including superseded decisions" })),
      experiments: Type.Optional(Type.Array(experimentSchema, { description: "Full current experiment ledger, including negative results" })),
      artifacts: Type.Optional(Type.Array(artifactSchema, { description: "Full current artifact manifest" })),
      evidence: Type.Optional(Type.Array(criterionEvidenceSchema, { description: "Fresh evidence for this checkpoint. Omission clears prior evidence to prevent stale completion proof." })),
      reflection: Type.Optional(Type.String({ description: "What the evidence implies for strategy or why the plan remains best" })),
      strategyChanged: Type.Optional(Type.Boolean({ description: "Whether this checkpoint replaced or materially revised the strategy" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const goal = deps.refresh(ctx);
      if (!goal || goal.status !== "active") throw new Error("no active goal to checkpoint");
      if (!params.summary.trim()) throw new Error("checkpoint summary must not be empty");
      if (!params.nextAction.trim()) throw new Error("checkpoint nextAction must not be empty");

      const update: GoalCheckpointUpdate = {
        phase: params.phase,
        summary: params.summary,
        currentAction: params.currentAction,
        nextAction: params.nextAction,
        plan: params.plan,
        facts: params.facts,
        unknowns: params.unknowns,
        decisions: params.decisions,
        experiments: params.experiments,
        artifacts: params.artifacts,
        evidence: params.evidence,
        reflection: params.reflection,
        strategyChanged: params.strategyChanged,
      };
      const checkpoint = buildCheckpoint(goal, update, now());
      deps.append({ kind: "checkpoint", id: goal.id, checkpoint, at: checkpoint.createdAt });
      deps.render(ctx);
      return {
        content: [{
          type: "text",
          text: `Checkpoint #${checkpoint.sequence} saved · ${checkpoint.phase}\nNext: ${checkpoint.nextAction}`,
        }],
        details: { goal: deps.getCachedGoal(), checkpoint },
        terminate: true,
      };
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
      if (!goal || goal.status === "complete" || goal.status === "cleared") throw new Error("no live goal to complete");
      if (params.goalId && params.goalId !== goal.id) throw new Error("goal id mismatch; call get_goal and audit the current goal");
      const audit = params.audit.trim();
      if (audit.length < MIN_AUDIT_CHARS) throw new Error(`audit too short; provide at least ${MIN_AUDIT_CHARS} characters of concrete evidence`);
      if (auditLooksIncomplete(audit)) throw new Error("audit says the goal is not fully verified/complete; keep working or pause instead");
      if (goal.spec.provenance === "structured" && goal.checkpoint?.phase !== "verifying") {
        throw new Error("structured goals require a latest verifying checkpoint before completion");
      }
      const unmetObligations = unmetStructuredObligations(goal);
      if (unmetObligations.length > 0) {
        throw new Error(`structured goal obligations still lack met evidence with proof:\n- ${unmetObligations.join("\n- ")}\nUpdate the checkpoint evidence map before completion.`);
      }
      const summary = params.summary?.trim();
      deps.append({ kind: "complete", id: goal.id, audit, summary, at: now() });
      const completedGoal = deps.getCachedGoal() ?? goal;
      const runLogPath = await writeRunLogIfEnabled(ctx, completedGoal, audit, summary);
      deps.dispatchPostGoalActions(ctx, completedGoal);
      deps.render(ctx);
      return {
        content: [{ type: "text", text: `Goal complete. Audit recorded:\n${audit}${runLogPath ? `\nRun log: ${runLogPath}` : ""}` }],
        details: { goal: deps.getCachedGoal(), audit, runLogPath },
        terminate: true,
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
