# pi-goal 🚀

Persistent adaptive `/goal` loop for Pi.

A goal keeps the original brief and outcome stable while its working plan, facts, experiments, decisions, evidence, and artifacts evolve through durable checkpoints.

## Install ⚙️

```json
{
  "packages": ["git:github.com/kyoukisu/pi-goal"]
}
```

Then:

```text
/reload
```

## Use 🎯

```text
/goal investigate the failure, fix it, and verify the real behavior
```

Token-budget enforcement is **off by default**. Add a limit only when wanted:

```text
/goal --max 10 --tokens 200k migrate auth tests
```

`--max-minutes` is deprecated compatibility metadata; runtime does not enforce wall-clock budgets because they break across pauses/reloads.

## Track progress 👀

An active goal keeps a compact widget above the editor with:

- phase and status;
- living-plan and contract-evidence counts;
- current and exact next action;
- checkpoint, turn, time, iteration, and token state.

Open the non-chat dashboard at any time:

```text
/goal status
```

The dashboard shows the living plan, criterion evidence, authoritative artifacts, unknowns, and recent checkpoint timeline. `/goal debug` remains available for the full raw state.

Other controls:

```text
/goal add also verify the migration
/goal extend 25
/goal budget 300k
/goal budget +50k
/goal budget off
/goal after send the final summary to me on Telegram
/goal pause
/goal resume
/goal clear
/goal list
```

## State model 🧠

- **GoalSpec** — source brief, outcome, explicit requirements, constraints, optional suggested approaches, success criteria, and autonomy envelope.
- **GoalCheckpoint** — current phase, facts, unknowns, decisions, living plan, experiments, artifacts, evidence, reflection, and next action.
- **Goal journal** — append-only checkpoint events on the current session branch.
- **Lifecycle** — status, continuation limits, optional token budget, retries, pause/resume, completion audit, and post-goal actions.

The source contract stays stable. Agent-authored methods and plans are provisional and may be replaced when evidence changes.

## Model tools 🔧

- `get_goal` — read the current contract and checkpoint.
- `create_goal` — start a legacy objective or a structured GoalSpec.
- `checkpoint_goal` — persist one bounded semantic slice and terminate the run.
- `complete_goal` — complete only after structured contract evidence and a fresh audit.
- `goal_need_user_input` — pause for genuinely blocking user input.

`checkpoint_goal` is the durable progress boundary. Ordinary tool activity alone is not considered goal progress. Once a goal-boundary tool succeeds, later tools in that agent run are blocked even if it was accidentally batched with another tool.

Evidence is checkpoint-specific: omitting it from a later checkpoint clears previous proof. `complete_goal` must be the first action of the clean continuation immediately after a verifying checkpoint, preventing implementation after verification from reusing stale evidence.

## Runtime behavior

- stores branch-correct goal events outside model context;
- reconstructs legacy v2 goals as source-preserving v3 legacy specs;
- injects the stable goal contract and latest mutable checkpoint into each run;
- queues hidden continuation turns after checkpoints;
- prompts periodic strategy review and review after failed/inconclusive experiments;
- retries transient provider errors with bounded short delays, then pauses;
- waits through context-overflow and post-compaction recovery;
- optionally enforces a user-selected token budget;
- optionally writes completion logs to `$PI_GOAL_RUN_LOG_DIR` or an existing `runs/agentic-loops/` directory;
- runs `/goal after` actions exactly once after successful completion.

## Notes ⚠️

- one live goal per session branch;
- not a daemon; Pi must be running;
- `/compact`, reload, resume, and branch navigation restore state;
- cross-session `/goal handoff` is not yet part of this MVP;
- completion evidence remains model-supplied, though structured goals require each explicit requirement, hard constraint, and success criterion to be marked `met` with concrete proof.
