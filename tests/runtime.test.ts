import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoalRuntime } from "../src/runtime";

function runtimeHandlers() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    appendEntry() {},
    getAllTools: () => [],
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const runtime = createGoalRuntime(pi);
  runtime.registerLifecycle();
  return {
    emit: async (name: string, event: any, ctx: any = {}) => {
      let result: any;
      for (const handler of handlers.get(name) ?? []) {
        result = await handler(event, ctx) ?? result;
      }
      return result;
    },
  };
}

test("a successful checkpoint blocks every later tool in the same agent run", async () => {
  const runtime = runtimeHandlers();
  await runtime.emit("tool_result", {
    toolName: "checkpoint_goal",
    isError: false,
    details: {},
    content: [{ type: "text", text: "saved" }],
  });
  const result = await runtime.emit("tool_call", { toolName: "bash", input: { command: "echo too-late" } });
  assert.equal(result.block, true);
  assert.match(result.reason, /checkpoint_goal already persisted the goal boundary/i);
});

test("failed boundary tools do not block recovery tools", async () => {
  const runtime = runtimeHandlers();
  await runtime.emit("tool_result", {
    toolName: "checkpoint_goal",
    isError: true,
    details: {},
    content: [{ type: "text", text: "failed" }],
  });
  const result = await runtime.emit("tool_call", { toolName: "read", input: { path: "README.md" } });
  assert.equal(result, undefined);
});

test("completion is blocked after other work so stale checkpoint evidence cannot be reused", async () => {
  const runtime = runtimeHandlers();
  const readResult = await runtime.emit("tool_call", { toolName: "read", input: { path: "artifact.txt" } });
  assert.equal(readResult, undefined);
  const completeResult = await runtime.emit("tool_call", { toolName: "complete_goal", input: { audit: "proof" } });
  assert.equal(completeResult.block, true);
  assert.match(completeResult.reason, /verifying checkpoint/i);
});

test("get_goal may precede completion because it does not change or inspect external state", async () => {
  const runtime = runtimeHandlers();
  await runtime.emit("tool_call", { toolName: "get_goal", input: {} });
  const completeResult = await runtime.emit("tool_call", { toolName: "complete_goal", input: { audit: "proof" } });
  assert.equal(completeResult, undefined);
});

test("goal creation is also a hard boundary before autonomous execution", async () => {
  const runtime = runtimeHandlers();
  await runtime.emit("tool_result", {
    toolName: "create_goal",
    isError: false,
    details: {},
    content: [{ type: "text", text: "created" }],
  });
  const result = await runtime.emit("tool_call", { toolName: "bash", input: { command: "start work" } });
  assert.equal(result.block, true);
  assert.match(result.reason, /create_goal already persisted the goal boundary/i);
});
