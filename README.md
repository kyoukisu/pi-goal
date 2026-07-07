# pi-goal 🚀

Persistent `/goal` loop for Pi.

Give Pi one objective. It keeps going across follow-up turns until done, paused, blocked, or out of limits.

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
/goal fix the bug and verify it
```

With limits:

```text
/goal --max 10 --tokens 200k migrate auth tests
```

`--max-minutes` is deprecated compatibility metadata; runtime no longer enforces wall-clock budgets because they break across pauses/reloads.

Controls:

```text
/goal status
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

## What it does 🧠

- stores goal state in the current Pi session branch
- injects the active goal and `/goal add` requirements into future turns
- queues hidden continuation turns
- runs `/goal after` actions only after successful completion
- retries transient provider errors with bounded short delays, then pauses
- waits through context-overflow and post-compaction recovery instead of pausing immediately
- tracks token usage and pauses on token budget
- optionally writes completion run logs to `$PI_GOAL_RUN_LOG_DIR` or existing `runs/agentic-loops/`
- pauses on user input, non-retryable errors, aborts, limits, or repeated no-progress turns
- requires a completion audit before marking done

## Tools 🔧

For the model:

- `get_goal`
- `create_goal`
- `complete_goal`
- `goal_need_user_input`

You usually do not call these manually.

## Notes ⚠️

- one live goal per branch
- not a daemon; Pi must be running
- audit is model-enforced, not a formal proof
- git install works; npm is not required
