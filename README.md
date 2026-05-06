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
/goal --max 10 --max-minutes 30 migrate auth tests
```

Controls:

```text
/goal status
/goal pause
/goal resume
/goal clear
/goal list
```

## What it does 🧠

- stores goal state in the current Pi session branch
- injects the active goal into future turns
- queues hidden continuation turns
- pauses on user input, errors, aborts, limits, or no tool-backed progress
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
