# Third-Party Notices

Synth is distributed under the MIT License — see [`LICENSE`](./LICENSE)
(English, legally binding) and [`LICENSE.ru.md`](./LICENSE.ru.md) (Russian
translation).

This file lists the **direct runtime dependencies** declared in
`packages/*/package.json` (`dependencies`, excluding `devDependencies`) and their
licenses, as reported by each installed package (`license` field of its
`package.json`).

Notes:

- Internal workspace packages (`@itphx/synth-shared`, `@itphx/synth-core`,
  `@itphx/synth-backend`, `@itphx/synth-ui`, `@itphx/synth-sdk`,
  `@itphx/synth`) are first-party and MIT-licensed; they are not repeated below.
- Only **direct** dependencies are listed. The **complete transitive dependency
  tree** (with exact versions) is pinned in [`pnpm-lock.yaml`](./pnpm-lock.yaml);
  each package also ships its own license metadata.
- Where a license could not be determined it is marked `см. пакет`.

## MIT

| Package | Used by |
| ------- | ------- |
| `@base-ui/react` | ui |
| `@dnd-kit/core` | ui |
| `@dnd-kit/sortable` | ui |
| `@dnd-kit/utilities` | ui |
| `@hono/node-server` | core, backend, synth |
| `@hono/zod-openapi` | core |
| `@modelcontextprotocol/sdk` | core |
| `@radix-ui/react-collapsible` | ui |
| `@radix-ui/react-dialog` | ui |
| `@radix-ui/react-dropdown-menu` | ui |
| `@radix-ui/react-popover` | ui |
| `@radix-ui/react-scroll-area` | ui |
| `@radix-ui/react-select` | ui |
| `@radix-ui/react-separator` | ui |
| `@radix-ui/react-slot` | ui |
| `@radix-ui/react-toggle` | ui |
| `@radix-ui/react-tooltip` | ui |
| `@tanstack/react-virtual` | ui |
| `clsx` | ui |
| `commander` | core, synth |
| `hono` | core, backend, synth |
| `hono-rate-limiter` | backend |
| `jose` | backend |
| `js-yaml` | shared, backend |
| `marked` | ui |
| `motion` | ui |
| `parse5` | core |
| `react` | ui |
| `react-dom` | ui |
| `react-toastify` | ui |
| `simple-git` | core |
| `tailwind-merge` | ui |
| `ws` | core, backend, synth |
| `zod` | shared, core, backend, synth |
| `zustand` | ui |

## Apache-2.0

| Package | Used by |
| ------- | ------- |
| `@pierre/diffs` | ui |
| `class-variance-authority` | ui |

## MPL-2.0 OR Apache-2.0

| Package | Used by |
| ------- | ------- |
| `dompurify` | ui |

## Remix Icon License 1.0

| Package | Used by |
| ------- | ------- |
| `@remixicon/react` | ui |
