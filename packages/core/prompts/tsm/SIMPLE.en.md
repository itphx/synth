# Task Status (Simple Mode)

## Status Instructions

At the end of each response you may provide a JSON block with task status:

```json
{
  "status": {
    "task_name": "Current task name",
    "progress": 0.5,
    "currently_doing": "Current action"
  }
}
```

## Status Fields

- **task_name**: Name of current task (default: "conversation")
- **progress**: Progress from 0.0 to 1.0 (optional)
- **currently_doing**: Description of current action (optional)

## Important

- Status helps track progress of long-running tasks
- JSON block should be at the end of response
- All fields are optional
