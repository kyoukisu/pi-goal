import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEvent } from "../src/state";
import { registerGoalTools } from "../src/tools";
import type { GoalEvent, GoalState } from "../src/types";

function harness() {
  const registered = new Map<string, any>();
  let goal: GoalState | undefined;
  const pi = {
    registerTool(definition: any) {
      registered.set(definition.name, definition);
    },
    getAllTools() {
      return [...registered.values()];
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/pi-goal-tests-no-run-log",
    hasUI: false,
    mode: "print",
    sessionManager: {
      getBranch() {
        return [{ id: "entry-user-1", type: "message", message: { role: "user", content: "start goal" } }];
      },
    },
  } as unknown as ExtensionContext;

  registerGoalTools(pi, {
    refresh: () => goal,
    append: (event: GoalEvent) => {
      goal = applyEvent(goal, event);
    },
    pause: () => {},
    queueContinuation: () => {},
    dispatchPostGoalActions: () => {},
    getCachedGoal: () => goal,
    render: () => {},
  });

  return { registered, ctx, getGoal: () => goal };
}

test("create_goal leaves token budget off by default and captures structured provenance", async () => {
  const { registered, ctx, getGoal } = harness();
  const create = registered.get("create_goal");
  const createResult = await create.execute("create", {
    objective: "Produce an evidence-backed result",
    sourceBrief: "\nOriginal brief verbatim\n",
    requirements: ["Preserve input details"],
    suggestedApproaches: ["Try a probe"],
    successCriteria: ["The result is backed by a reproducible artifact"],
  }, undefined, undefined, ctx);

  const goal = getGoal();
  assert.ok(goal);
  assert.equal(createResult.terminate, true);
  assert.equal(goal.tokenBudget, undefined);
  assert.equal(goal.spec.provenance, "structured");
  assert.equal(goal.spec.sourceBrief, "\nOriginal brief verbatim\n");
  assert.deepEqual(goal.spec.sourceEntryIds, ["entry-user-1"]);
  assert.deepEqual(goal.spec.suggestedApproaches, ["Try a probe"]);
});

test("structured completion rejects proof from a non-verifying checkpoint", async () => {
  const { registered, ctx } = harness();
  const create = registered.get("create_goal");
  const checkpoint = registered.get("checkpoint_goal");
  const complete = registered.get("complete_goal");
  await create.execute("create", {
    objective: "Produce a verified result",
    sourceBrief: "Produce a verified result",
    successCriteria: ["Artifact passes"],
  }, undefined, undefined, ctx);
  await checkpoint.execute("checkpoint", {
    phase: "implementing",
    summary: "Artifact changed",
    nextAction: "Verify it",
    evidence: [{ criterion: "Artifact passes", status: "met", proof: ["stale proof"] }],
  }, undefined, undefined, ctx);
  await assert.rejects(
    complete.execute("complete", {
      audit: "The artifact has proof recorded, but the latest phase is implementation.",
    }, undefined, undefined, ctx),
    /latest verifying checkpoint/i,
  );
});

test("checkpoint_goal terminates the slice and structured completion requires contract proof", async () => {
  const { registered, ctx, getGoal } = harness();
  const create = registered.get("create_goal");
  const checkpoint = registered.get("checkpoint_goal");
  const complete = registered.get("complete_goal");
  assert.equal(create.executionMode, "sequential");
  assert.equal(checkpoint.executionMode, "sequential");
  assert.equal(complete.executionMode, "sequential");

  await create.execute("create", {
    objective: "Produce an evidence-backed result",
    sourceBrief: "Original brief verbatim",
    requirements: ["Preserve input details"],
    constraints: ["Do not deploy"],
    successCriteria: ["The result is backed by a reproducible artifact"],
  }, undefined, undefined, ctx);

  const checkpointResult = await checkpoint.execute("checkpoint-1", {
    phase: "verifying",
    summary: "Produced the artifact",
    nextAction: "Map the success criterion to fresh evidence",
    artifacts: [{ path: "/tmp/result.md", status: "authoritative" }],
  }, undefined, undefined, ctx);
  assert.equal(checkpointResult.terminate, true);
  assert.equal(getGoal()?.checkpointCount, 1);

  await assert.rejects(
    complete.execute("complete-1", {
      audit: "Ran the reproducer and inspected the resulting artifact successfully.",
    }, undefined, undefined, ctx),
    /obligations still lack met evidence/i,
  );

  await checkpoint.execute("checkpoint-2", {
    phase: "verifying",
    summary: "Mapped fresh proof to the criterion",
    nextAction: "Complete the goal",
    evidence: [
      {
        criterion: "Preserve input details",
        status: "met",
        proof: ["/tmp/result.md retains the named input"],
      },
      {
        criterion: "Do not deploy",
        status: "met",
        proof: ["No deployment command or production mutation occurred"],
      },
      {
        criterion: "The result is backed by a reproducible artifact",
        status: "met",
        proof: ["/tmp/result.md and command exit 0"],
      },
    ],
  }, undefined, undefined, ctx);

  const completeResult = await complete.execute("complete-2", {
    audit: "Criterion verified with /tmp/result.md and a fresh command that exited zero.",
  }, undefined, undefined, ctx);
  assert.equal(completeResult.terminate, true);
  assert.equal(getGoal()?.status, "complete");
});
