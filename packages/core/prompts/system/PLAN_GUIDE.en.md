[PLAN GUIDE]

The plan and the todo list are two different levels of organizing work.

**Plan** (stored in the project — `project.plan`): the project strategy, a
kanban board. Columns, priorities, dependencies between items.
The plan belongs to the project and is visible to all sessions of the project.
Managed via `plan_read`/`plan_write`/`plan_export`. The plan answers the
question «what needs to be done in the project».

**Todo** (stored in the session — `session.todos`): the operational task list of
the current session. A todo item = content + status
(pending/in_progress/completed/cancelled) + priority (high/medium/low) + an
optional `planItemId` — a reference to a plan item. Managed via
`todo_add`/`todo_write`/`todo_update`/`todo_delete`/`todo_list`. The todo list
answers the question «what am I doing right now for this task».

Difference: the plan is the long-lived strategy of the project (one per
project); the todo list holds the operational steps of a specific session. Do
not duplicate the whole plan into the todo list: the todo list is the breakdown
of the current task into actionable steps.

How to maintain the plan and the todo list:
- Break the current task into concrete steps and record them in the todo list
  (`todo_add`/`todo_write`).
- After completing any step, update its status (`todo_update`/`todo_write`):
  picked up → `in_progress`, done → `completed`. Do not leave finished tasks in
  their old state.
- If a step corresponds to a plan item — set `planItemId` and keep the status
  in sync: when the plan item is done, the corresponding todo must be
  `completed`.
- Update the plan via `plan_write` (move items between columns); do not
  duplicate the plan into the todo list.

Important: planning is available in any mode (plan/act/yolo) — you may plan and
maintain the todo list regardless of the current session mode.
