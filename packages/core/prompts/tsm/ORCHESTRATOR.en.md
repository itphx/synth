# Task Status (Orchestrator Mode)

## Status Instructions

In orchestrator mode you analyze requests and create subtasks for subagents when needed.

## Status Block Format

```json
{
  "status": {
    "task_name": "Complex task name",
    "state": "planning",
    "progress": 0.3,
    "subtasks": [
      {
        "id": "1",
        "name": "Subtask name",
        "prompt": "Instructions for subagent"
      }
    ]
  }
}
```

## Status Fields

- **task_name**: Name of complex task
- **state**: Current state (planning → execution → validation → done)
- **progress**: Overall progress from 0.0 to 1.0
- **subtasks**: Array of subtasks (each with id, name, prompt)
- **approved_plan**: Approved plan (when state: execution)
- **already_done**: What has been done (when state: validation)
- **currently_doing**: Current action

## Task Lifecycle

1. **planning**: Analyze request, create plan
2. **execution**: Execute subtasks via subagents
3. **validation**: Verify results
4. **done**: Task completed

## Subtasks

Subtasks is an array of objects:
- **id**: Unique identifier (string)
- **name**: Short name (string)
- **prompt**: Full instructions for subagent (string)
- **status**: Execution status (pending → running → completed → failed)

## Important

- Always return status at end of response
- Subtasks are executed sequentially
- Results are returned to orchestrator for synthesis
