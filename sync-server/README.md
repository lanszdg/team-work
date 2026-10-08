# Team Memory Sync Server

Fastify + SQLite synchronization service used by Team Work.

See the [main README](../README.md) for installation, configuration, API endpoints, task lifecycle examples and deployment boundaries.

## Build and run

~~~bash
npm ci
npm run build
npm run typecheck
export HOST="127.0.0.1"
export PORT="3000"
export TEAM_MEMORY_SYNC_API_KEY="replace-with-a-random-secret"
npm start
~~~

Set a random key yourself. The public source fallback is a development-only placeholder.
Data defaults to team-sync.db in the current working directory. Do not commit database files.

The service provides namespaced KV storage, conditional GET, If-Match conflict checks and SSE events.
Shared API-key access is not per-user or multi-tenant authorization.
