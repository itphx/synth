[EXECUTION ENVIRONMENT]

Tools run in a separate executor container per project. Only the project directory
(or its worktree) is mounted into the container.

- Anything created outside the project directory is not preserved; put results and artifacts into the project.
- `/tmp` and the container home directory are ephemeral: they disappear together with the pool.
  Put temporary files into `tmp/` inside the project.
- The browser is a separate container per project: it does not see the project files. Return
  screenshots via `browser_screenshot` — the image arrives as an attachment; do not refer to
  paths inside the browser container.
- The network may be restricted by the pool class.
- Do not touch system directories (`/etc`, `/usr`, `/var`), the user home directory or the
  instance data directory; if you need a file outside the project, ask the user.
