import {
  Counter,
  Histogram,
  collectDefaultMetrics,
  register,
} from 'prom-client';

collectDefaultMetrics();

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests handled by this service.',
  labelNames: ['method', 'route', 'status_code'],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const wagerTransactionResults = new Counter({
  name: 'wager_transaction_results_total',
  help: 'Wager transaction results by kind and status.',
  labelNames: ['kind', 'status'],
});

export const walletsCreated = new Counter({
  name: 'wallets_created_total',
  help: 'Number of wallets created by currency.',
  labelNames: ['currency'],
});

export const sqsCommandFailures = new Counter({
  name: 'sqs_command_failures_total',
  help: 'Number of SQS command processing failures.',
});

export const sqsCommandsEnqueued = new Counter({
  name: 'sqs_commands_enqueued_total',
  help: 'Number of wager commands accepted by SQS.',
});

export const outboxPublishFailures = new Counter({
  name: 'outbox_publish_failures_total',
  help: 'Number of outbox publish failures.',
});

export { register };
