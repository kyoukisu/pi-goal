import assert from "node:assert/strict";
import test from "node:test";
import { activeGoalSystemPrompt, continuationPrompt } from "../src/prompts";
import { normalizeGoal } from "../src/state";
import type { GoalState } from "../src/types";

function structuredGoal(): GoalState {
  return normalizeGoal({
    version: 3,
    id: "goal-structured",
    objective: "Produce an evidence-backed recommendation",
    spec: {
      provenance: "structured",
      sourceBrief: "Keep abilities, fixed builds, and the Stockfish/genetic examples in context exactly.",
      sourceEntryIds: ["entry-user"],
      outcome: "Produce an evidence-backed recommendation",
      context: ["Abilities may be placeholders", "Builds are fixed"],
      requirements: ["Research before choosing the implementation"],
      constraints: ["Do not deploy"],
      suggestedApproaches: ["Stockfish-like search", "Genetic search"],
      successCriteria: ["A durable recommendation cites reproducible evidence"],
      autonomy: ["Run reversible probes"],
    },
    checkpointCount: 1,
    checkpoint: {
      sequence: 1,
      phase: "researching",
      summary: "Confirmed the abilities are incomplete",
      nextAction: "Run one solver-readiness probe",
      plan: [{ text: "Assess readiness", status: "in_progress" }],
      facts: [{ text: "Abilities are incomplete", evidence: "probe.json" }],
      unknowns: ["Which search family fits the simulator"],
      decisions: [],
      experiments: [],
      artifacts: [{ path: "probe.json", status: "authoritative" }],
      evidence: [],
      strategyChanged: false,
      createdAt: Date.now(),
    },
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    iteration: 1,
    maxIterations: 25,
    tokenBudget: undefined,
    tokensUsed: 100,
    workTimeSeconds: 10,
    turnCount: 1,
    noProgressCount: 0,
    consecutiveErrors: 0,
  });
}

test("system prompt preserves the source brief while keeping the plan provisional", () => {
  const prompt = activeGoalSystemPrompt(structuredGoal());
  assert.match(prompt, /Keep abilities, fixed builds, and the Stockfish\/genetic examples in context exactly\./);
  assert.match(prompt, /suggested approaches, examples, old plans, or your own inferences/i);
  assert.match(prompt, /checkpoint and plan are provisional and replaceable/i);
  assert.match(prompt, /Run one solver-readiness probe/);
});

test("continuation prompt requires a bounded checkpoint and shows budget off", () => {
  const prompt = continuationPrompt(structuredGoal());
  assert.match(prompt, /finish with checkpoint_goal as the sole final tool call/i);
  assert.match(prompt, /call complete_goal immediately before any other tool/i);
  assert.match(prompt, /budget off/);
  assert.match(prompt, /The contract is stable; the plan is provisional/);
});
