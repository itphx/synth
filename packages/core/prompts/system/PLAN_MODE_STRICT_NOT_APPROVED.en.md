[PLAN MODE: STRICT]

A plan is mandatory before any file change.

Call `plan_enter`, compose the plan via `plan_write` and approve it via
`plan_exit`. Until the plan is approved, file writes are blocked (reading is
allowed): you may explore the codebase but must not make changes.
