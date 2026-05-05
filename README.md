# @kyoukisu/pi-goal

Codex-style persistent `/goal` loop for [Pi](https://github.com/badlogic/pi-mono).

## Install from git

Add the package to Pi settings:

```json
{
  "packages": [
    "git:github.com/kyoukisu/pi-goal"
  ]
}
```

No npm publish is required. Pi supports git packages directly.

For Nix/Home Manager setups, keep that package entry in the declarative Pi `settings.json` source and rebuild/apply your config.

## Commands

- `/goal <objective>` — start a persistent goal and queue the first continuation.
- `/goal status` — show current goal state.
- `/goal pause` or `/goal stop` — pause active goal.
- `/goal resume` — resume and queue a continuation.
- `/goal clear` — clear current goal.
- `/goal list` — show goals recorded in the current branch.

Options:

```text
/goal --max 25 --max-minutes 60 <objective>
```

## Tools

The extension registers these tools:

- `get_goal` — inspect active goal state.
- `create_goal` — create a persistent goal only when explicitly requested.
- `complete_goal` — mark complete only after a real evidence audit.
- `goal_need_user_input` — pause when a concrete user answer is required.

## Behavior

- Stores goal events as Pi custom session entries, scoped to the active branch.
- Adds an active-goal system prompt while a goal is running.
- Queues hidden follow-up continuation turns until completion or pause.
- Pauses on user interruption, abort, final error, iteration/time limit, cancelled question, or no tool-backed progress.
- Requires `complete_goal` to include a concrete audit before marking the goal complete.

## Development

```bash
npm install
npm run typecheck
```

The package intentionally keeps Pi runtime packages as peer dependencies.
