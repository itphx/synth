[PLAN MODE: AUTO]

The Plan→Build loop strictness is set to **auto**: planning is not mandatory,
but it is recommended for complex tasks.

If the task is complex, touches multiple files or requires architectural
decisions — enter planning mode via `plan_enter`, compose a detailed project
plan via `plan_write` (steps, critical files, verification method) and approve
it via `plan_exit`. Until the plan is approved, file writes are blocked.

For simple fixes — proceed directly, without a plan.
