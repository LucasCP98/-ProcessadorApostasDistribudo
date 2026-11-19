# Architecture

## Runtime and persistence

The application is a NestJS ESM service. HTTP handlers, SQS workers, and scheduled retry work share the wagering application handlers and MikroORM persistence layer. PostgreSQL is the source of truth; LocalStack is used for SQS integration tests.

MikroORM is used for entity mapping, migrations, and transaction-scoped entity managers. Wallet changes use PostgreSQL row locks and a persisted `version`, so concurrent updates serialize at the wallet rather than relying on process-local locks. Inbox, transaction, wallet, ledger, and outbox writes for a wager are committed in the same SQL transaction. Outbox claiming uses row locks with `SKIP LOCKED`, allowing multiple publishers to work without claiming the same row.

Automatic schema synchronization is disabled. Apply checked-in migrations before starting a non-local environment. Non-development and non-test environments require an explicit `DATABASE_URL`; SSL, pool limits, and database timeouts are configurable through the environment.

## Money and ledger

`Money` stores decimal values and serializes amounts as decimal strings with exactly two fractional digits. Inputs must be decimal strings with at most two fractional digits, no more than 13 integer digits, and a three-letter currency code; the maximum is `9,999,999,999,999.99`. Arithmetic requires matching currencies; transaction-specific handlers also enforce positive amounts where required. The implementation is intended for ordinary wallet amounts and does not provide arbitrary-precision fractional currencies.

`WalletLedgerEntry` is append-only. Database constraints reject invalid amounts and protect ledger invariants; database triggers prevent updates and deletes. The wallet balance is the current aggregate value and must equal the opening balance plus the ledger effects. Reconciliation checks this invariant and reports divergence without silently changing either value.

## Wager processing and idempotency

Each incoming command is validated before processing. An Inbox record and the transaction's financial effects are protected by database transactions and uniqueness constraints. The `payloadHash` is SHA-256 over a JSON object with fixed field order: provider ID, external transaction ID, player ID, wallet ID, round ID, game ID, kind, money, and referenced external transaction ID. Transport metadata such as correlation IDs is excluded. Reusing an idempotency key with the same hash is a replay; reusing it with a different hash is a conflict.

Wager effects are serialized by wallet row locking. Successful BET, WIN, REFUND, and ROLLBACK operations create their corresponding ledger effects. LOSS is an explicit accepted transaction that does not change the balance and does not create a ledger entry. A REFUND is limited by the remaining refundable amount and credits the wallet; a later ROLLBACK reverses the referenced effect according to the existing transaction rules. Reversals arriving before their referenced transaction remain `PENDING_REFERENCE` and are retried by the worker rather than being treated as completed.

`failureCode` values are stable machine-readable outcomes, not free-form exception text. They distinguish invalid payloads, wallet/reference lookup failures, currency mismatch, insufficient funds, duplicate/idempotency conflicts, and invalid or excessive reversals. Validation and business failures are persisted as transaction outcomes; infrastructure failures are thrown so the transport can retry or route the message to a DLQ.

## Inbox, outbox, and event delivery

Inbox deduplication and Outbox insertion occur within the same SQL transaction as the wallet, transaction, and ledger changes. Outbox delivery is at-least-once: a publisher claims a batch, sends each event, then marks it published. Temporary send failures record the attempt and error while retaining the row for retry. Consumers must deduplicate by `eventId`.

Published event bodies use this envelope:

```json
{
  "eventId": "uuid",
  "eventType": "wager.transaction.processed",
  "aggregateId": "wallet-id",
  "correlationId": "uuid",
  "causationId": "optional-id",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "version": 1,
  "data": {
    "money": { "amount": "10.00", "currency": "BRL" },
    "balance": { "amount": "90.00", "currency": "BRL" }
  }
}
```

`data` is event-specific; money values are represented as `{ amount, currency }` with decimal-string amounts. `causationId` is omitted when unavailable. The outbox persists correlation/causation metadata and the aggregate version with the event.

## SQS

The wager command queue is `wager-transactions.fifo`; its dead-letter queue is `wager-transactions-dlq.fifo`. Both are FIFO. The command queue uses a redrive policy to the DLQ. Messages use `walletId` as `MessageGroupId`, serializing delivery for a wallet, and a SHA-256 `MessageDeduplicationId` derived from the idempotency key and payload hash. The event queue remains standard because event consumers can process independent aggregates concurrently.

Queue creation is opt-in for local/test environments and disabled by default elsewhere. Configure queue names, endpoint, visibility timeout, and worker behavior through the SQS environment variables in `.env.example`. The worker throws on malformed or invalid commands so SQS redelivery and the configured redrive policy can take effect; it does not acknowledge them as successful.

## HTTP and reconciliation

The API exposes wallet creation and wager processing, wallet/ledger/transaction queries, and health endpoints. `GET /health/live` reports process liveness; `GET /health/ready` verifies readiness dependencies.

`POST /wallets/:walletId/reconciliation` is read-only and returns:

```json
{
  "walletId": "wallet-id",
  "storedBalance": { "amount": "100.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "100.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 3
}
```

`difference` is stored balance minus calculated ledger balance. The legacy `POST /wagering/reconcile` endpoint remains available for compatibility.

Authentication is delegated to the identity gateway. The service validates request data and trace headers but does not implement a competing internal sign-in flow; deployments must ensure the gateway is the trusted network edge.

## Shutdown and observability

The Nest application enables signal shutdown hooks. On `SIGTERM`, the worker stops starting polls, waits for tracked work up to `SQS_WORKER_SHUTDOWN_TIMEOUT_MS`, and then closes SQS and database resources through Nest lifecycle hooks. Work exceeding the timeout may be retried by SQS or the Outbox lease/retry mechanism.

Application logs use JSON output and include available `correlationId`, `messageId`, `transactionId`, `walletId`, and `providerId` fields. They must not include credentials, full payloads, or financial values. Debug SQL logging is disabled by default outside development/test. Prometheus metrics are exposed at `GET /metrics`.

## Trade-offs and limitations

- FIFO command ordering reduces same-wallet contention at the transport, while database locks remain necessary for HTTP requests, redeliveries, and multiple service instances.
- Outbox delivery is at-least-once, not exactly-once. A crash after send but before marking the row published can produce a duplicate event.
- SQS FIFO deduplication is time-bounded; database Inbox/idempotency constraints remain authoritative.
- `PENDING_REFERENCE` retry is eventual and bounded by worker configuration; operators must monitor messages that continue failing and the DLQ.
- REFUND credits the wallet only up to the remaining refundable amount. This implementation does not model external provider settlement or partial settlement beyond its transaction/reference rules.
- Currency validation enforces the supported code format and same-currency arithmetic; it is not an ISO-4217 metadata service and does not infer non-two-decimal currencies.
- The service assumes a trusted identity gateway and does not independently authenticate callers.
- LocalStack integration gives realistic queue behavior for automated tests but does not replace staging verification against AWS IAM, queue policies, encryption, or network configuration.
