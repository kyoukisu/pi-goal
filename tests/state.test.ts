import assert from "node:assert/strict";
import test from "node:test";
import { STATE_VERSION } from "../src/constants";
import { applyEvent, buildCheckpoint, normalizeGoal } from "../src/state";
import type { GoalCheckpointUpdate, GoalState } from "../src/types";

function legacyState(): GoalState {
  return {
    version: 2,
    id: "goal-legacy",
    objective: "Preserve this exact legacy objective",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    iteration: 0,
    maxIterations: 25,
    tokenBudget: undefined,
    tokensUsed: 0,
    workTimeSeconds: 0,
    turnCount: 0,
    noProgressCount: 0,
    consecutiveErrors: 0,
  } as GoalState;
}

test("normalizes v2 state into a source-preserving v3 legacy spec", () => {
  const goal = normalizeGoal(legacyState());
  assert.equal(goal.version, STATE_VERSION);
  assert.equal(goal.spec.provenance, "legacy");
  assert.equal(goal.spec.sourceBrief, "Preserve this exact legacy objective");
  assert.equal(goal.spec.outcome, "Preserve this exact legacy objective");
  assert.equal(goal.checkpointCount, 0);
  assert.equal(goal.tokenBudget, undefined);
});

test("buildCheckpoint creates a full snapshot and preserves omitted sections", () => {
  let goal = normalizeGoal(legacyState());
  const first: GoalCheckpointUpdate = {
    phase: "researching",
    summary: "Established the baseline",
    nextAction: "Run the discriminating probe",
    plan: [
      { text: "Inspect baseline", status: "completed", evidence: "baseline.txt" },
      { text: "Run probe", status: "in_progress" },
    ],
    facts: [{ text: "Baseline is reproducible", evidence: "baseline.txt" }],
    unknowns: ["Whether the probe changes the result"],
    decisions: [{ text: "Use the smaller probe first", status: "active", rationale: "Cheaper discriminating evidence" }],
    experiments: [],
    artifacts: [{ path: "baseline.txt", status: "authoritative" }],
    evidence: [],
  };
  const checkpoint1 = buildCheckpoint(goal, first, 100);
  goal = applyEvent(goal, { kind: "checkpoint", id: goal.id, checkpoint: checkpoint1, at: 100 })!;

  const checkpoint2 = buildCheckpoint(goal, {
    phase: "experimenting",
    summary: "Probe disproved the first hypothesis",
    currentAction: "",
    nextAction: "Replace the provisional strategy",
    experiments: [{
      question: "Does the first hypothesis survive the probe?",
      status: "failed",
      result: "No",
      evidence: "probe.txt",
    }],
    reflection: "The previous strategy no longer follows from evidence.",
    strategyChanged: true,
  }, 200);

  assert.equal(checkpoint2.sequence, 2);
  assert.equal(checkpoint2.plan.length, 2);
  assert.equal(checkpoint2.facts[0]?.text, "Baseline is reproducible");
  assert.equal(checkpoint2.currentAction, undefined);
  assert.equal(checkpoint2.experiments[0]?.status, "failed");
  assert.equal(checkpoint2.strategyChanged, true);
});

test("supplying an empty section clears the previous checkpoint section", () => {
  let goal = normalizeGoal(legacyState());
  const checkpoint1 = buildCheckpoint(goal, {
    phase: "researching",
    summary: "Found one unknown",
    nextAction: "Resolve it",
    unknowns: ["Unknown A"],
  }, 100);
  goal = applyEvent(goal, { kind: "checkpoint", id: goal.id, checkpoint: checkpoint1, at: 100 })!;
  const checkpoint2 = buildCheckpoint(goal, {
    phase: "verifying",
    summary: "Resolved all unknowns",
    nextAction: "Verify completion evidence",
    unknowns: [],
  }, 200);
  assert.deepEqual(checkpoint2.unknowns, []);
});

test("later checkpoints clear omitted evidence instead of retaining stale proof", () => {
  let goal = normalizeGoal(legacyState());
  const checkpoint1 = buildCheckpoint(goal, {
    phase: "verifying",
    summary: "Verified the original artifact",
    nextAction: "Continue implementation",
    evidence: [{ criterion: "Artifact works", status: "met", proof: ["old artifact hash"] }],
  }, 100);
  goal = applyEvent(goal, { kind: "checkpoint", id: goal.id, checkpoint: checkpoint1, at: 100 })!;

  const checkpoint2 = buildCheckpoint(goal, {
    phase: "implementing",
    summary: "Changed the artifact after verification",
    nextAction: "Re-run verification",
  }, 200);
  assert.deepEqual(checkpoint2.evidence, []);
});
