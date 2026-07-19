import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeGoal } from "../src/state";
import { renderGoal, showGoalDashboard } from "../src/ui";
import type { GoalState } from "../src/types";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function trackedGoal(): GoalState {
  return normalizeGoal({
    version: 3,
    id: "goal-ui",
    objective: "Make progress visible without reading chat",
    spec: {
      provenance: "structured",
      sourceBrief: "Make progress visible without reading chat",
      sourceEntryIds: [],
      outcome: "Make progress visible without reading chat",
      context: [],
      requirements: [],
      constraints: [],
      suggestedApproaches: [],
      successCriteria: ["Current and next actions are visible", "Evidence progress is visible"],
      autonomy: [],
    },
    checkpointCount: 2,
    checkpoint: {
      sequence: 2,
      phase: "implementing",
      summary: "The dashboard is implemented",
      currentAction: "Verify the compact widget",
      nextAction: "Run the UI contract test",
      plan: [
        { text: "Implement dashboard", status: "completed" },
        { text: "Verify dashboard", status: "in_progress" },
      ],
      facts: [{ text: "The widget renders without chat history", evidence: "UI contract test" }],
      unknowns: [],
      decisions: [{ text: "Use real plan/evidence counts", rationale: "Avoid fake percentages", status: "active" }],
      experiments: [{ question: "Does the compact widget expose the next action?", status: "succeeded", result: "Yes" }],
      artifacts: [{ path: "src/ui.ts", description: "Progress UI", status: "authoritative" }],
      evidence: [
        { criterion: "Current and next actions are visible", status: "met", proof: ["widget render"] },
        { criterion: "Agent-only extra signal", status: "met", proof: ["must not inflate contract progress"] },
      ],
      strategyChanged: false,
      createdAt: Date.now(),
    },
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    iteration: 2,
    maxIterations: 25,
    tokenBudget: undefined,
    tokensUsed: 1234,
    workTimeSeconds: 30,
    turnCount: 2,
    noProgressCount: 0,
    consecutiveErrors: 0,
  });
}

test("persistent widget shows phase, real plan/evidence progress, current/next action, and budget off", () => {
  let status = "";
  let widgetFactory: any;
  const ctx = {
    ui: {
      setStatus: (_key: string, value: string) => { status = value; },
      setWidget: (_key: string, value: any) => { widgetFactory = value; },
    },
  } as unknown as ExtensionContext;

  renderGoal(ctx, trackedGoal());
  assert.match(status, /goal:active · implementing/);
  assert.match(status, /1\/2 plan/);
  assert.match(status, /1\/2 evidence/);

  const component = widgetFactory({}, theme);
  const text = component.render(140).join("\n");
  assert.match(text, /Verify the compact widget/);
  assert.match(text, /Run the UI contract test/);
  assert.match(text, /budget off/);
  assert.match(text, /checkpoint 2/);
});

test("goal dashboard exposes plan, evidence, artifacts, and recent checkpoint history", async () => {
  let rendered = "";
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: any) => {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(140).join("\n");
      },
    },
  } as unknown as ExtensionContext;

  await showGoalDashboard(ctx, trackedGoal(), [
    { sequence: 1, phase: "orienting", summary: "Established initial state", createdAt: Date.now() - 1000 },
    { sequence: 2, phase: "implementing", summary: "The dashboard is implemented", createdAt: Date.now() },
  ]);

  assert.match(rendered, /Current state/);
  assert.match(rendered, /Living plan \(1\/2\)/);
  assert.match(rendered, /Contract evidence \(1\/2\)/);
  assert.match(rendered, /Experiments \(1\)/);
  assert.match(rendered, /Verified facts \(1\)/);
  assert.match(rendered, /Active decisions \(1\)/);
  assert.match(rendered, /src\/ui\.ts/);
  assert.match(rendered, /Recent checkpoints/);
  assert.match(rendered, /Established initial state/);
});
