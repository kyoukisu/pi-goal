import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "../src/commands";
import { createGoalRuntime } from "../src/runtime";
import { registerGoalTools } from "../src/tools";

export default function piGoal(pi: ExtensionAPI) {
  const runtime = createGoalRuntime(pi);
  runtime.registerLifecycle();
  registerGoalTools(pi, runtime);
  registerGoalCommand(pi, runtime);
}
