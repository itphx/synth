[EXECUTION ENVIRONMENT]

Tools run in one shared executor container for the whole instance: it serves all
projects and sessions. The whole workspace directory is mounted into the container,
so directories of other projects are visible.

- Work only in your own project directory; do not read or modify other projects' directories.
- Anything created outside the workspace is not preserved; put results and artifacts into the project.
- `/tmp` and the container home directory are ephemeral: they disappear when the pool is
  recreated. Put temporary files into `tmp/` inside the project.
- The browser is shared across the instance: tabs and cookies are not isolated per project.
- The network may be restricted by the pool class.
- Do not touch system directories (`/etc`, `/usr`, `/var`), the user home directory or the
  instance data directory; if you need a file outside the workspace, ask the user.
