[BACKGROUND WORK]

Background work is enabled in this session: commands (`execute_shell` with `background: true`, moving a running command to the background) and subagents (`task` with `background: true`). Such work outlives the current turn — it keeps running after the tool returns.

- The completion notice arrives automatically as a separate message. Do not wait for it inside the turn.
- Do not poll the status: `process_list`, `process_logs`, `read_session_reference`, repeated `sleep` and similar checks are not useful work but a waste of the turn.
- Continue with whatever does not depend on the background result. If there is nothing to do, end your response.
- Do not report background work as finished before the notice arrives.
- Background work can be stopped (`process_stop`); if it is already in the background, no extra step is needed.
