# Distributed Wager Processor

NestJS service for processing wallet wagers with PostgreSQL, an immutable ledger, idempotency, and SQS-based command/event delivery.

## Requirements

- Bun 1.x
- Docker Compose

## Local setup

```powershell
bun install
docker compose up -d
$env:NODE_ENV = "development"
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/wagering_db"
$env:SQS_ENDPOINT = "http://localhost:4566"
bun run db:migrate
bun run start:dev
```

The app reads environment variables from the process; it does not load `.env` files itself. See [.env.example](./.env.example) for local-only values. Never copy its credentials to staging or production.

The service creates the FIFO `wager-transactions.fifo` queue and its FIFO DLQ `wager-transactions-dlq.fifo`, plus the standard `wagering-events` queue in LocalStack. Commands are grouped by wallet and deduplicated by idempotency key plus payload hash. `db:migrate` upgrades the existing schema and backfills an `OPENING` transaction and ledger entry for each legacy wallet's unaccounted opening balance. It does not reset or delete existing wallet or wager data.

For AWS, omit `SQS_ENDPOINT`, set `SQS_QUEUES_AUTO_CREATE=false`, and configure the normal AWS region and credentials through the AWS SDK credential chain. Set `DATABASE_URL` for the target PostgreSQL instance.

## API

- `POST /wagering/wallets` creates a wallet and, when the initial balance is positive, records it as an `OPENING` transaction and ledger credit.
- `POST /wagering/transactions` synchronously processes a transaction.
- `POST /wagering/transactions/queue` accepts a command with HTTP `202`; the SQS worker processes it asynchronously.
- `GET /wagering/wallets/:walletId` returns wallet state.
- `GET /wagering/wallets/:walletId/ledger?limit=100&offset=0` returns a page of immutable ledger entries.
- `GET /wagering/transactions/:transactionId` returns a transaction and its stored result.
- `POST /wagering/reconcile` checks all wallets; pass `{"walletId":"..."}` to check one wallet.
- `POST /wallets/:walletId/reconciliation` compares the stored wallet balance with the ledger without changing either. It returns `walletId`, `storedBalance`, `calculatedBalance`, `difference` (stored minus calculated), `consistent`, and `checkedEntries`; money amounts are decimal strings with two fractional digits.
- `GET /health/live` checks process liveness.
- `GET /health/ready` checks PostgreSQL and SQS readiness.
- `GET /metrics` exposes Prometheus process, HTTP, wallet, wager, SQS, and outbox metrics.

Transaction requests accept `BET`, `WIN`, `LOSS`, `REFUND`, or `ROLLBACK`. `REFUND` and `ROLLBACK` require `referenceExternalTransactionId`. The optional `Idempotency-Key` header defaults to the provider and external transaction IDs. Reusing an identity with a different payload returns HTTP `409`.

The service does not implement application authentication. Put it behind the approved identity-aware API gateway or add the deployment's standard NestJS authentication module before exposing it publicly.

## Production deployment

Before public or production use:

- Configure the identity-aware gateway and restrict direct access to the service.
- Use TLS for PostgreSQL and AWS-managed credentials with least-privilege SQS access; do not commit credentials or expose the LocalStack endpoint.
- Set `NODE_ENV` explicitly to `staging` or `production` and set `DATABASE_URL`; an unset `NODE_ENV` is treated as non-local too. `POSTGRES_SSL` defaults to enabled outside development/test and cannot be disabled there; set `POSTGRES_SSL_CA_FILE` when a private CA is required. Avoid disabling or weakening TLS through `DATABASE_URL` query parameters (`sslmode` is accepted only as `verify-full`). SQL debug logging is enabled only in development/test.
- Tune `POSTGRES_POOL_MIN`, `POSTGRES_POOL_MAX`, `POSTGRES_POOL_IDLE_TIMEOUT_MS`, `POSTGRES_CONNECTION_TIMEOUT_MS`, `POSTGRES_QUERY_TIMEOUT_MS`, `POSTGRES_STATEMENT_TIMEOUT_MS`, and `POSTGRES_LOCK_TIMEOUT_MS` to the staging database capacity and migration duration.
- Pre-create FIFO `wager-transactions.fifo` and `wager-transactions-dlq.fifo`, plus the event queue, through infrastructure-as-code and set `SQS_QUEUES_AUTO_CREATE=false`. The service verifies the command/DLQ FIFO attributes and redrive target. Grant the service only `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`, `sqs:SendMessage`, `sqs:ReceiveMessage`, and `sqs:DeleteMessage` on the configured queues. Configure the command queue's redrive policy to the FIFO DLQ with a maximum receive count of five and a 45-second visibility timeout.
- Keep the queue visibility timeout aligned with `SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS` (default `45`); the worker applies this value when receiving messages.
- On shutdown, the worker stops polling and drains in-flight work for up to `SQS_WORKER_SHUTDOWN_TIMEOUT_MS` (default `25000`) before closing SQS; configure the orchestrator's termination grace period accordingly.
- Monitor `/health/ready`, transaction result counters, SQS command failures, outbox publish failures, and the command DLQ. Configure alerts and retention in the deployment platform.
- Add the deployment's tracing/APM integration if distributed traces are required; this repository exposes metrics and structured worker error logs but does not provision an Observe/APM account or credentials.

## Database migrations

```powershell
bun run db:migrate
bun run db:migrate:down
```

Review and back up a production database before applying or reverting migrations. `db:migrate:down` reverts the latest migration; the current migration removes only correlation/causation/version columns. Reverting the foundational migration also removes generated opening entries and schema features, so it is intended only for a controlled rollback, not routine local cleanup.

## Tests and checks

```powershell
bun run test
bun run test:e2e
bun run test:all
bun run lint
bun run typecheck
bun run build
```

`test:all` runs unit tests and then E2E tests. E2E tests require the migrated PostgreSQL database and LocalStack; they create uniquely named test wallets and transactions and leave those records in the database. The suite covers concurrent wagers against a shared wallet, reconciliation, LOSS and out-of-order ROLLBACK, SQS retry/DLQ behavior, redelivery after a simulated crash before ACK, competing Outbox publishers, and worker restart recovery.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for consistency and messaging details.
