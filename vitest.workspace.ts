import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/core',
  'packages/storage-postgres',
  'packages/backend',
  'packages/ui',
]);
