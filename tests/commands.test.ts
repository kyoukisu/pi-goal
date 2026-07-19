import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "../src/commands";
import { applyEvent } from "../src/state";
import type { GoalEvent, GoalState } from "../src/types";

test("direct /goal creation also leaves token budget off by default", async () => {
  let command: any;
  let goal: GoalState | undefined;
  let continuations = 0;
  const pi = {
    registerCommand(_name: string, definition: any) {
      command = definition;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "print",
    hasUI: false,
    isIdle: () => true,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
    },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;

  registerGoalCommand(pi, {
    refresh: () => goal,
    append: (event: GoalEvent) => { goal = applyEvent(goal, event); },
    pause: () => {},
    queueContinuation: () => { continuations++; },
    getCachedGoal: () => goal,
    setCachedGoal: (value) => { goal = value; },
  });

  await command.handler("Investigate the failure and verify the result", ctx);
  assert.ok(goal);
  assert.equal(goal.tokenBudget, undefined);
  assert.equal(goal.spec.provenance, "legacy");
  assert.equal(goal.spec.sourceBrief, "Investigate the failure and verify the result");
  assert.equal(continuations, 1);
});
