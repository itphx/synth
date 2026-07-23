# Synth Integration Tests

## API Smoke Tests

```bash
./test/api-smoke.sh                    # localhost:5000, admin-key-123
./test/api-smoke.sh http://host:5000   # custom host
API_KEY=your-key ./test/api-smoke.sh   # custom key
```

## UI E2E Tests

```bash
node test/ui-e2e.mjs                          # localhost:5002, admin-key-123
node test/ui-e2e.mjs http://myhost:5002 my-key
```

## Vitest Unit Tests

```bash
cd synth && pnpm test
```
