import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/core';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Message } from '@aws-sdk/client-sqs';
import {
  type ProcessWagerCommand,
  type ProcessWagerResult,
  ProcessWagerHandler,
} from '../../application/commands/process-wager.handler.js';
import { hashWagerPayload } from '../../application/commands/wager-payload.js';
import { WagerTransactionKind } from '../../domain/wager-transaction.entity.js';
import { OutboxMessageEntity } from '../../../shared/infrastructure/database/entities/outbox-message.entity.js';
import {
  type OutboxEventEnvelope,
  SqsMessagingService,
} from '../../../shared/infrastructure/messaging/sqs-messaging.service.js';
import {
  outboxPublishFailures,
  sqsCommandFailures,
} from '../../../shared/infrastructure/observability/metrics-registry.js';

interface ClaimedOutboxMessage {
  id: string;
  eventType: string;
  aggregateId: string;
  correlationId: string | null;
  causationId: string | null;
  occurredAt: Date | string;
  version: number;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class SqsWagerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerWorker.name);
  private readonly workerId = randomUUID();
  private readonly shutdownTimeoutMs = getShutdownTimeoutMs(
    process.env.SQS_WORKER_SHUTDOWN_TIMEOUT_MS,
  );
  private commandTimer?: NodeJS.Timeout;
  private outboxTimer?: NodeJS.Timeout;
  private commandPoll?: Promise<void>;
  private outboxPoll?: Promise<void>;
  private referencePoll?: Promise<void>;
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private readonly testAckDelayMs = getTestAckDelayMs(
    process.env.NODE_ENV,
    process.env.SQS_TEST_ACK_DELAY_MS,
  );

  constructor(
    private readonly sqs: SqsMessagingService,
    private readonly handler: ProcessWagerHandler,
    private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    if (process.env.SQS_WORKERS_ENABLED === 'false') return;
    this.commandTimer = setInterval(() => {
      void this.pollCommands();
    }, 1000);
    this.outboxTimer = setInterval(() => {
      void this.publishOutbox();
      void this.retryPendingReferences();
    }, 1000);
    void this.pollCommands();
    void this.publishOutbox();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
    this.sqs.close();
  }

  async stop(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    if (this.commandTimer) clearInterval(this.commandTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);

    this.shutdownPromise = this.drainActiveOperations();
    return this.shutdownPromise;
  }

  private async drainActiveOperations(): Promise<void> {
    const activeOperations = [
      this.commandPoll,
      this.outboxPoll,
      this.referencePoll,
    ].filter((operation): operation is Promise<void> => !!operation);
    let timeout: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.allSettled(activeOperations).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!drained) {
      this.logger.error({
        event: 'worker.shutdown.drain_timeout',
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
        timeoutMs: this.shutdownTimeoutMs,
      });
    }
  }

  private pollCommands(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.commandPoll) return this.commandPoll;
    const operation = this.runCommandPoll();
    const tracked = operation.finally(() => {
      if (this.commandPoll === tracked) this.commandPoll = undefined;
    });
    this.commandPoll = tracked;
    return tracked;
  }

  private async runCommandPoll(): Promise<void> {
    try {
      const messages = await this.sqs.receiveWagerCommands();
      for (const message of messages) {
        await this.processMessage(message);
      }
    } catch (error) {
      if (!this.stopping) {
        sqsCommandFailures.inc();
        this.logger.error(
          {
            event: 'sqs.command.poll_failed',
            correlationId: null,
            messageId: null,
            transactionId: null,
            walletId: null,
            providerId: null,
          },
          error,
        );
      }
    }
  }

  private async processMessage(message: Message): Promise<void> {
    if (!message.Body || !message.MessageId || !message.ReceiptHandle) {
      sqsCommandFailures.inc();
      this.logger.error({
        event: 'sqs.command.invalid_message_metadata',
        correlationId: null,
        messageId: message.MessageId ?? null,
        transactionId: null,
        walletId: null,
        providerId: null,
      });
      return;
    }
    let command: ProcessWagerCommand | undefined;
    let result: ProcessWagerResult | undefined;
    try {
      command = parseCommand(message.Body);
      const correlationId = command.correlationId ?? command.payloadHash;
      result = await this.handler.execute({
        ...command,
        correlationId,
        causationId: command.causationId ?? message.MessageId,
        inboxMessage: {
          consumerName: 'wager-command-consumer',
          messageId: message.MessageId,
        },
      });
      await this.delayBeforeAck();
      await this.sqs.deleteWagerCommand(message.ReceiptHandle);
      this.logger.log({
        event: 'sqs.command.processed',
        correlationId,
        messageId: message.MessageId,
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        status: result.status,
      });
    } catch (error) {
      sqsCommandFailures.inc();
      this.logger.error(
        {
          event: 'sqs.command.processing_failed',
          correlationId: command?.correlationId ?? command?.payloadHash ?? null,
          messageId: message.MessageId,
          transactionId: result?.transactionId ?? null,
          walletId: command?.walletId ?? null,
          providerId: command?.providerId ?? null,
        },
        error,
      );
    }
  }

  private async delayBeforeAck(): Promise<void> {
    if (this.testAckDelayMs === 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.testAckDelayMs));
  }

  private publishOutbox(): Promise<void> {
    if (this.stopping || process.env.SQS_WORKERS_ENABLED === 'false') {
      return Promise.resolve();
    }
    if (this.outboxPoll) return this.outboxPoll;
    const operation = this.runOutboxPoll();
    const tracked = operation.finally(() => {
      if (this.outboxPoll === tracked) this.outboxPoll = undefined;
    });
    this.outboxPoll = tracked;
    return tracked;
  }

  private async runOutboxPoll(): Promise<void> {
    try {
      const messages = await this.claimOutboxMessages();
      for (const message of messages) {
        try {
          const envelope = this.toOutboxEnvelope(message);
          await this.sqs.sendWagerEvent(envelope);
          await this.em.nativeUpdate(
            OutboxMessageEntity,
            { id: message.id, lockedBy: this.workerId },
            {
              publishedAt: new Date(),
              lockedUntil: null,
              lockedBy: null,
            },
          );
          this.logger.log({
            event: 'outbox.published',
            correlationId: envelope.correlationId,
            messageId: null,
            transactionId: message.payload.transactionId ?? null,
            walletId: message.aggregateId,
            providerId: message.payload.providerId ?? null,
            eventId: envelope.eventId,
          });
        } catch (error) {
          outboxPublishFailures.inc();
          const attempts = message.attempts + 1;
          const delaySeconds = Math.min(2 ** attempts, 300);
          await this.em.nativeUpdate(
            OutboxMessageEntity,
            { id: message.id, lockedBy: this.workerId },
            {
              attempts,
              nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
              lockedUntil: null,
              lockedBy: null,
            },
          );
          this.logger.error(
            {
              event: 'outbox.publish_failed',
              messageId: message.id,
              correlationId: message.correlationId ?? message.aggregateId,
              transactionId: message.payload.transactionId ?? null,
              walletId: message.aggregateId,
              providerId: message.payload.providerId ?? null,
              retryDelaySeconds: delaySeconds,
            },
            error,
          );
        }
      }
    } catch (error) {
      outboxPublishFailures.inc();
      this.logger.error(
        {
          event: 'outbox.poll_failed',
          correlationId: null,
          messageId: null,
          transactionId: null,
          walletId: null,
          providerId: null,
        },
        error,
      );
    }
  }

  private retryPendingReferences(): Promise<void> {
    if (this.stopping || process.env.SQS_WORKERS_ENABLED === 'false') {
      return Promise.resolve();
    }
    if (this.referencePoll) return this.referencePoll;
    const operation = this.runPendingReferencePoll();
    const tracked = operation.finally(() => {
      if (this.referencePoll === tracked) this.referencePoll = undefined;
    });
    this.referencePoll = tracked;
    return tracked;
  }

  private async runPendingReferencePoll(): Promise<void> {
    try {
      await this.handler.retryPendingReferences();
    } catch (error) {
      this.logger.error(
        {
          event: 'wager.pending_reference.retry_failed',
          correlationId: null,
          messageId: null,
          transactionId: null,
          walletId: null,
          providerId: null,
        },
        error,
      );
    }
  }

  private async claimOutboxMessages(): Promise<ClaimedOutboxMessage[]> {
    const rows: ClaimedOutboxMessage[] = await this.em.transactional((em) =>
      em.getConnection().execute(
        `
          WITH candidates AS (
            SELECT id
            FROM outbox_messages
            WHERE published_at IS NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
              AND (locked_until IS NULL OR locked_until <= now())
            ORDER BY occurred_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 20
          )
          UPDATE outbox_messages AS message
          SET locked_until = now() + interval '60 seconds',
              locked_by = ?
          FROM candidates
          WHERE message.id = candidates.id
          RETURNING message.id,
                    message.event_type AS "eventType",
                    message.aggregate_id AS "aggregateId",
                    message.correlation_id AS "correlationId",
                    message.causation_id AS "causationId",
                    message.occurred_at AS "occurredAt",
                    message.version,
                    message.payload,
                    message.attempts
        `,
        [this.workerId],
        'all',
        em.getTransactionContext(),
      ),
    );
    return rows;
  }

  private toOutboxEnvelope(message: ClaimedOutboxMessage): OutboxEventEnvelope {
    return {
      eventId: message.id,
      eventType: message.eventType,
      aggregateId: message.aggregateId,
      correlationId: message.correlationId ?? message.id,
      ...(message.causationId ? { causationId: message.causationId } : {}),
      occurredAt: new Date(message.occurredAt).toISOString(),
      version: message.version,
      data: message.payload,
    };
  }
}

function getShutdownTimeoutMs(value?: string): number {
  const timeoutMs = Number(value ?? '25000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new Error(
      'SQS_WORKER_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000.',
    );
  }
  return timeoutMs;
}

function getTestAckDelayMs(nodeEnvironment?: string, value?: string): number {
  if (nodeEnvironment?.trim().toLowerCase() !== 'test') return 0;
  const delayMs = Number(value ?? '0');
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 120_000) {
    throw new Error('SQS_TEST_ACK_DELAY_MS must be between 0 and 120000.');
  }
  return delayMs;
}

function parseCommand(body: string): ProcessWagerCommand {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error('SQS command body is not valid JSON.', { cause: error });
  }
  if (!isWagerCommand(value)) {
    throw new Error(
      'SQS command body does not match the wager command schema.',
    );
  }
  if (value.payloadHash !== hashWagerPayload(value)) {
    throw new Error('SQS command payload hash does not match its contents.');
  }
  return value;
}

function isWagerCommand(value: unknown): value is ProcessWagerCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  const money = command.money;
  return (
    typeof command.idempotencyKey === 'string' &&
    typeof command.providerId === 'string' &&
    typeof command.externalTransactionId === 'string' &&
    typeof command.payloadHash === 'string' &&
    typeof command.walletId === 'string' &&
    typeof command.playerId === 'string' &&
    typeof command.roundId === 'string' &&
    typeof command.gameId === 'string' &&
    isOptionalTraceId(command.correlationId) &&
    isOptionalTraceId(command.causationId) &&
    Object.values(WagerTransactionKind).includes(
      command.kind as WagerTransactionKind,
    ) &&
    command.kind !== WagerTransactionKind.Opening &&
    !!money &&
    typeof money === 'object' &&
    typeof (money as Record<string, unknown>).amount === 'string' &&
    typeof (money as Record<string, unknown>).currency === 'string' &&
    (command.referenceExternalTransactionId === undefined ||
      typeof command.referenceExternalTransactionId === 'string')
  );
}

function isOptionalTraceId(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length <= 128 &&
      /^[A-Za-z0-9._:-]+$/.test(value))
  );
}
