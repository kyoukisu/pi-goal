import assert from "node:assert/strict";
import test from "node:test";
import { goalEvidenceCounts, goalEvidenceObligations } from "../src/format";
import { normalizeGoal } from "../src/state";
import type { GoalState } from "../src/types";

test("contract progress counts only unique declared obligations, including amendments", () => {
  const goal = normalizeGoal({
    version: 3,
    id: "goal-evidence-count",
    objective: "Ship a verified result",
    spec: {
      provenance: "structured",
      sourceBrief: "Ship a verified result without deployment",
      sourceEntryIds: [],
      outcome: "Ship a verified result",
      context: [],
      requirements: ["Preserve the named input"],
      constraints: ["Do not deploy"],
      suggestedApproaches: [],
      successCriteria: ["Artifact passes the reproducer"],
      autonomy: [],
    },
    checkpointCount: 1,
    checkpoint: {
      sequence: 1,
      phase: "verifying",
      summary: "Verification checkpoint",
      nextAction: "Complete",
      plan: [],
      facts: [],
      unknowns: [],
      decisions: [],
      experiments: [],
      artifacts: [],
      evidence: [
        { criterion: "Preserve the named input", status: "met", proof: ["artifact"] },
        { criterion: "preserve   the named input", status: "met", proof: ["duplicate"] },
        { criterion: "Unrelated agent signal", status: "met", proof: ["irrelevant"] },
        { criterion: "Added user requirement", status: "met", proof: ["amendment proof"] },
      ],
      strategyChanged: false,
      createdAt: 1,
    },
    amendments: [{ id: "a1", text: "Added user requirement", createdAt: 1 }],
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    iteration: 1,
    maxIterations: 25,
    tokenBudget: undefined,
    tokensUsed: 0,
    workTimeSeconds: 0,
    turnCount: 1,
    noProgressCount: 0,
    consecutiveErrors: 0,
  } satisfies GoalState);

  assert.deepEqual(goalEvidenceObligations(goal), [
    "Preserve the named input",
    "Do not deploy",
    "Artifact passes the reproducer",
    "Added user requirement",
  ]);
  assert.deepEqual(goalEvidenceCounts(goal), { met: 2, total: 4 });
});
