import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { WagerTransactionStatus } from '../src/wagering/domain/wager-transaction.entity.js';
import { InboxMessageEntity } from '../src/shared/infrastructure/database/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../src/shared/infrastructure/database/entities/outbox-message.entity.js';
import { SqsMessagingService } from '../src/shared/infrastructure/messaging/sqs-messaging.service.js';
import { SqsWagerWorker } from '../src/wagering/infrastructure/messaging/sqs-wager-worker.service.js';
import { WalletLedgerEntity } from '../src/wagering/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../src/wagering/infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../src/wagering/infrastructure/persistence/entities/wager-transaction.entity.js';

describe('Wagering concurrency and idempotency (E2E)', () => {
  let app: INestApplication;
  let testQueueNames!: {
    command: string;
    deadLetter: string;
    events: string;
  };
  const originalQueueEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    if (!process.env.SQS_ENDPOINT) {
      throw new Error(
        'SQS_ENDPOINT must point to a local SQS-compatible service for E2E tests.',
      );
    }
    const suffix = randomUUID().replace(/-/g, '');
    testQueueNames = {
      command: `wager-transactions-test-${suffix}.fifo`,
      deadLetter: `wager-transactions-dlq-test-${suffix}.fifo`,
      events: `wagering-events-test-${suffix}`,
    };
    for (const variable of [
      'SQS_WAGER_QUEUE_NAME',
      'SQS_WAGER_DLQ_NAME',
      'SQS_EVENT_QUEUE_NAME',
      'SQS_QUEUES_AUTO_CREATE',
      'SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS',
      'SQS_TEST_ACK_DELAY_MS',
    ]) {
      originalQueueEnvironment.set(variable, process.env[variable]);
    }
    process.env.SQS_WAGER_QUEUE_NAME = testQueueNames.command;
    process.env.SQS_WAGER_DLQ_NAME = testQueueNames.deadLetter;
    process.env.SQS_EVENT_QUEUE_NAME = testQueueNames.events;
    process.env.SQS_QUEUES_AUTO_CREATE = 'true';
    process.env.SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS = '1';
    process.env.SQS_TEST_ACK_DELAY_MS = '1500';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.get(SqsMessagingService).checkReadiness();
  });

  afterAll(async () => {
    try {
      await app.close();
      const client = createSqsTestClient();
      try {
        for (const queueName of [
          testQueueNames.command,
          testQueueNames.events,
          testQueueNames.deadLetter,
        ]) {
          const queueUrl = await getQueueUrl(client, queueName);
          await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        }
      } finally {
        client.destroy();
      }
    } finally {
      for (const [variable, value] of originalQueueEnvironment) {
        if (value === undefined) delete process.env[variable];
        else process.env[variable] = value;
      }
    }
  });

  it('processes 50 duplicate requests exactly once and replays the original balance', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const body = wagerBody(
      playerId,
      walletId,
      `duplicate_${randomUUID()}`,
      '20.00',
    );
    const idempotencyKey = `duplicate_${randomUUID()}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('idempotency-key', idempotencyKey)
          .send(body),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      new Set(responses.map((response) => response.body.transactionId)).size,
    ).toBe(1);
    expect(
      responses.filter((response) => response.body.idempotentReplay),
    ).toHaveLength(49);
    expect(
      responses.every((response) => response.body.balance.amount === '80.00'),
    ).toBe(true);

    const wallet = await request(app.getHttpServer()).get(
      `/wagering/wallets/${walletId}`,
    );
    expect(wallet.body.balance).toBe('80.00');

    const ledger = await request(app.getHttpServer()).get(
      `/wagering/wallets/${walletId}/ledger`,
    );
    expect(ledger.body.total).toBe(2);
    expect(
      ledger.body.entries.map(
        (entry: { direction: string }) => entry.direction,
      ),
    ).toEqual(['CREDIT', 'DEBIT']);

    const reconciliation = await request(app.getHttpServer())
      .post('/wagering/reconcile')
      .send({ walletId });
    expect(reconciliation.body.reconciled).toBe(true);

    const metrics = await request(app.getHttpServer()).get('/metrics');
    expect(metrics.text).toContain('wallets_created_total{currency="BRL"}');
    expect(metrics.text).toMatch(
      /wager_transaction_results_total\{kind="BET",status="PROCESSED"\} [1-9]\d*/,
    );
  });

  it('serializes 50 distinct parallel bets without breaking the ledger invariant', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('idempotency-key', `parallel_bet_${randomUUID()}_${index}`)
          .send(
            wagerBody(
              playerId,
              walletId,
              `parallel_bet_external_${randomUUID()}_${index}`,
              '3.00',
            ),
          ),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.filter(
        (response) => response.body.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(33);
    expect(
      responses.filter(
        (response) => response.body.status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(17);

    const reconciliation = await request(app.getHttpServer()).post(
      `/wallets/${walletId}/reconciliation`,
    );
    expect(reconciliation.body).toMatchObject({
      storedBalance: { amount: '1.00', currency: 'BRL' },
      calculatedBalance: { amount: '1.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 34,
    });
  }, 30_000);

  it('prevents two concurrent debits from spending the same balance', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const requests = [0, 1].map((index) =>
      request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('idempotency-key', `race_${randomUUID()}_${index}`)
        .send(
          wagerBody(
            playerId,
            walletId,
            `race_external_${randomUUID()}_${index}`,
            '80.00',
          ),
        ),
    );

    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.filter(
        (response) => response.body.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);
    expect(
      responses.filter(
        (response) => response.body.status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(1);

    const wallet = await request(app.getHttpServer()).get(
      `/wagering/wallets/${walletId}`,
    );
    expect(wallet.body.balance).toBe('20.00');
    const reconciliation = await request(app.getHttpServer())
      .post('/wagering/reconcile')
      .send({ walletId });
    expect(reconciliation.body.reconciled).toBe(true);
  });

  it('serializes five concurrent bets against a 60.00 balance', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '60.00');
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('idempotency-key', `concurrent_${randomUUID()}_${index}`)
          .send(
            wagerBody(
              playerId,
              walletId,
              `concurrent_external_${randomUUID()}_${index}`,
              '20.00',
            ),
          ),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.filter(
        (response) => response.body.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(3);
    expect(
      responses.filter(
        (response) => response.body.status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(2);
    const wallet = await request(app.getHttpServer()).get(
      `/wagering/wallets/${walletId}`,
    );
    expect(wallet.body.balance).toBe('0.00');
  });

  it('prevents overspending across service processes using pre-created queues', async () => {
    const firstPort = await getAvailablePort();
    let secondPort = await getAvailablePort();
    while (secondPort === firstPort) secondPort = await getAvailablePort();
    const firstService = await startServiceProcess(firstPort);
    let secondService: RunningService | undefined;

    try {
      secondService = await startServiceProcess(secondPort);
      const readiness = await Promise.all([
        request(`http://127.0.0.1:${firstPort}`).get('/health/ready'),
        request(`http://127.0.0.1:${secondPort}`).get('/health/ready'),
      ]);
      expect(readiness.every((response) => response.status === 200)).toBe(true);

      const playerId = `player_${randomUUID()}`;
      const walletId = await createWallet(app, playerId, '100.00');
      const bodies = [0, 1].map((index) =>
        wagerBody(
          playerId,
          walletId,
          `multi_instance_external_${randomUUID()}_${index}`,
          '80.00',
        ),
      );
      const responses = await Promise.all([
        request(`http://127.0.0.1:${firstPort}`)
          .post('/wagering/transactions')
          .set('idempotency-key', `multi_instance_${randomUUID()}_0`)
          .send(bodies[0]),
        request(`http://127.0.0.1:${secondPort}`)
          .post('/wagering/transactions')
          .set('idempotency-key', `multi_instance_${randomUUID()}_1`)
          .send(bodies[1]),
      ]);

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(
        responses.filter(
          (response) =>
            response.body.status === WagerTransactionStatus.Processed,
        ),
      ).toHaveLength(1);
      expect(
        responses.filter(
          (response) =>
            response.body.status === WagerTransactionStatus.Rejected,
        ),
      ).toHaveLength(1);
      const wallet = await request(app.getHttpServer()).get(
        `/wagering/wallets/${walletId}`,
      );
      expect(wallet.body.balance).toBe('20.00');
    } finally {
      await stopServiceProcess(firstService.child);
      if (secondService) await stopServiceProcess(secondService.child);
    }
  }, 30_000);

  it('limits partial refunds, permits refund rollback, and prevents wager reversal after refund', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const betExternalId = `refund_bet_${randomUUID()}`;
    const bet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `refund_bet_${randomUUID()}`)
      .send(wagerBody(playerId, walletId, betExternalId, '50.00'));
    expect(bet.body.status).toBe(WagerTransactionStatus.Processed);

    const refundExternalId = `partial_refund_${randomUUID()}`;
    const refund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `partial_refund_${randomUUID()}`)
      .send({
        ...wagerBody(playerId, walletId, refundExternalId, '20.00'),
        kind: 'REFUND',
        referenceExternalTransactionId: betExternalId,
      });
    expect(refund.body.status).toBe(WagerTransactionStatus.Processed);

    const excessiveRefund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `excessive_refund_${randomUUID()}`)
      .send({
        ...wagerBody(
          playerId,
          walletId,
          `excessive_refund_${randomUUID()}`,
          '40.00',
        ),
        kind: 'REFUND',
        referenceExternalTransactionId: betExternalId,
      });
    expect(excessiveRefund.body.status).toBe(WagerTransactionStatus.Rejected);

    const refundRollback = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `refund_rollback_${randomUUID()}`)
      .send({
        ...wagerBody(
          playerId,
          walletId,
          `refund_rollback_${randomUUID()}`,
          '20.00',
        ),
        kind: 'ROLLBACK',
        referenceExternalTransactionId: refundExternalId,
      });
    expect(refundRollback.body.status).toBe(WagerTransactionStatus.Processed);

    const laterRefund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `later_refund_${randomUUID()}`)
      .send({
        ...wagerBody(
          playerId,
          walletId,
          `later_refund_${randomUUID()}`,
          '20.00',
        ),
        kind: 'REFUND',
        referenceExternalTransactionId: betExternalId,
      });
    expect(laterRefund.body.status).toBe(WagerTransactionStatus.Processed);

    const betRollback = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `bet_rollback_${randomUUID()}`)
      .send({
        ...wagerBody(
          playerId,
          walletId,
          `bet_rollback_${randomUUID()}`,
          '50.00',
        ),
        kind: 'ROLLBACK',
        referenceExternalTransactionId: betExternalId,
      });
    expect(betRollback.body.status).toBe(WagerTransactionStatus.Rejected);

    const wallet = await request(app.getHttpServer()).get(
      `/wagering/wallets/${walletId}`,
    );
    expect(wallet.body.balance).toBe('70.00');
    const reconciliation = await request(app.getHttpServer())
      .post('/wagering/reconcile')
      .send({ walletId });
    expect(reconciliation.body.reconciled).toBe(true);
  });

  it('retries a reference transaction after its wager arrives out of order', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const betExternalId = `late_bet_${randomUUID()}`;
    const refundExternalId = `early_refund_${randomUUID()}`;
    const refundResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `refund_${randomUUID()}`)
      .send({
        ...wagerBody(playerId, walletId, refundExternalId, '50.00'),
        kind: 'REFUND',
        referenceExternalTransactionId: betExternalId,
      });

    expect(refundResponse.status).toBe(200);
    expect(refundResponse.body.status).toBe('PENDING_REFERENCE');

    const betResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `bet_${randomUUID()}`)
      .send(wagerBody(playerId, walletId, betExternalId, '50.00'));
    expect(betResponse.body.status).toBe(WagerTransactionStatus.Processed);

    const em = app.get(EntityManager).fork();
    let refund: WagerTransactionEntity | null = null;
    for (
      let attempt = 0;
      attempt < 40 && refund?.status !== WagerTransactionStatus.Processed;
      attempt += 1
    ) {
      refund = await em.findOne(WagerTransactionEntity, {
        externalTransactionId: refundExternalId,
      });
      if (refund?.status !== WagerTransactionStatus.Processed) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    expect(refund?.status).toBe(WagerTransactionStatus.Processed);
    const wallet = await request(app.getHttpServer()).get(
      `/wagering/wallets/${walletId}`,
    );
    expect(wallet.body.balance).toBe('100.00');
    const reconciliation = await request(app.getHttpServer())
      .post('/wagering/reconcile')
      .send({ walletId });
    expect(reconciliation.body.reconciled).toBe(true);
  });

  it('reprocesses a ROLLBACK that arrives before its referenced BET', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const betExternalId = `late_rollback_bet_${randomUUID()}`;
    const rollbackExternalId = `early_rollback_${randomUUID()}`;

    const rollback = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `early_rollback_${randomUUID()}`)
      .send({
        ...wagerBody(playerId, walletId, rollbackExternalId, '20.00'),
        kind: 'ROLLBACK',
        referenceExternalTransactionId: betExternalId,
      });
    expect(rollback.body.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `late_rollback_bet_${randomUUID()}`)
      .send(wagerBody(playerId, walletId, betExternalId, '20.00'));
    expect(bet.body.status).toBe(WagerTransactionStatus.Processed);

    const em = app.get(EntityManager).fork();
    let reversed: WagerTransactionEntity | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      reversed = await em.findOne(WagerTransactionEntity, {
        externalTransactionId: rollbackExternalId,
      });
      if (reversed?.status === WagerTransactionStatus.Processed) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(reversed?.status).toBe(WagerTransactionStatus.Processed);
    const reconciliation = await request(app.getHttpServer()).post(
      `/wallets/${walletId}/reconciliation`,
    );
    expect(reconciliation.body).toMatchObject({
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  }, 30_000);

  it('processes LOSS without changing the balance or writing a ledger entry', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const loss = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `loss_${randomUUID()}`)
      .send({
        ...wagerBody(
          playerId,
          walletId,
          `loss_external_${randomUUID()}`,
          '25.00',
        ),
        kind: 'LOSS',
      });

    expect(loss.status).toBe(200);
    expect(loss.body.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const ledger = await request(app.getHttpServer()).get(
      `/wagering/wallets/${walletId}/ledger`,
    );
    expect(ledger.body.total).toBe(1);
    const reconciliation = await request(app.getHttpServer()).post(
      `/wallets/${walletId}/reconciliation`,
    );
    expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.checkedEntries).toBe(1);
  });

  it('reconciles a wallet with its ledger using the required route and MoneyProps', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '50.00');

    const response = await request(app.getHttpServer()).post(
      `/wallets/${walletId}/reconciliation`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId,
      storedBalance: { amount: '50.00', currency: 'BRL' },
      calculatedBalance: { amount: '50.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });

  it('reports ledger drift without changing the stored wallet or ledger', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '50.00');
    const em = app.get(EntityManager).fork();

    try {
      await em.nativeUpdate(
        WalletEntity,
        { id: walletId },
        { balance: '47.00' },
      );
      const response = await request(app.getHttpServer()).post(
        `/wallets/${walletId}/reconciliation`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        walletId,
        storedBalance: { amount: '47.00', currency: 'BRL' },
        calculatedBalance: { amount: '50.00', currency: 'BRL' },
        difference: { amount: '-3.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
      });
      em.clear();
      expect(
        (await em.findOneOrFail(WalletEntity, { id: walletId })).balance,
      ).toBe('47.00');
    } finally {
      await em.nativeUpdate(
        WalletEntity,
        { id: walletId },
        { balance: '50.00' },
      );
    }
  });

  it('consumes an SQS command with inbox deduplication and publishes its outbox event', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '50.00');
    const externalTransactionId = `queued_${randomUUID()}`;
    const body = wagerBody(playerId, walletId, externalTransactionId, '10.00');
    const response = await request(app.getHttpServer())
      .post('/wagering/transactions/queue')
      .set('idempotency-key', `queued_${randomUUID()}`)
      .send(body);

    expect(response.status).toBe(202);

    const em = app.get(EntityManager).fork();
    let transaction: WagerTransactionEntity | null = null;
    for (let attempt = 0; attempt < 40 && !transaction; attempt += 1) {
      transaction = await em.findOne(WagerTransactionEntity, {
        externalTransactionId,
      });
      if (!transaction)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(transaction?.status).toBe(WagerTransactionStatus.Processed);
    const inboxMessage = await em.findOne(InboxMessageEntity, {
      consumerName: 'wager-command-consumer',
      messageId: response.body.messageId as string,
    });
    expect(inboxMessage).not.toBeNull();
    expect(inboxMessage?.processedAt).toBeTruthy();

    let outboxMessage: OutboxMessageEntity | null = null;
    for (
      let attempt = 0;
      attempt < 40 && !outboxMessage?.publishedAt;
      attempt += 1
    ) {
      outboxMessage = await em.findOne(
        OutboxMessageEntity,
        { aggregateId: walletId, eventType: 'wager.transaction.processed' },
        { orderBy: { occurredAt: 'DESC' } },
      );
      if (!outboxMessage?.publishedAt) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    expect(outboxMessage?.publishedAt).toBeTruthy();
    expect(outboxMessage?.payload.transactionId).toBe(transaction?.id);
  });

  it('retries malformed SQS commands and redrives them to the DLQ', async () => {
    const client = createSqsTestClient();
    const commandQueueUrl = await getQueueUrl(
      client,
      process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
    );
    const deadLetterQueueUrl = await getQueueUrl(
      client,
      process.env.SQS_WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
    );
    const queueAttributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: commandQueueUrl,
        AttributeNames: ['VisibilityTimeout'],
      }),
    );
    const originalVisibilityTimeout =
      queueAttributes.Attributes?.VisibilityTimeout ?? '45';
    const invalidBody = '{not-json';
    let deadLetterReceiptHandle: string | undefined;

    try {
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl: commandQueueUrl,
          Attributes: { VisibilityTimeout: '1' },
        }),
      );
      await client.send(
        new SendMessageCommand({
          QueueUrl: commandQueueUrl,
          MessageBody: invalidBody,
          MessageGroupId: 'invalid-message-test',
          MessageDeduplicationId: randomUUID(),
        }),
      );

      let deadLetterMessage:
        { Body?: string; ReceiptHandle?: string } | undefined;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && !deadLetterMessage) {
        const result = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: deadLetterQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 1,
          }),
        );
        deadLetterMessage = result.Messages?.find(
          (message) => message.Body === invalidBody,
        );
        if (!deadLetterMessage) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }

      expect(deadLetterMessage?.Body).toBe(invalidBody);
      deadLetterReceiptHandle = deadLetterMessage?.ReceiptHandle;

      const metrics = await request(app.getHttpServer()).get('/metrics');
      expect(metrics.text).toMatch(/sqs_command_failures_total [1-9]\d*/);
    } finally {
      if (deadLetterReceiptHandle) {
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: deadLetterQueueUrl,
            ReceiptHandle: deadLetterReceiptHandle,
          }),
        );
      }
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl: commandQueueUrl,
          Attributes: { VisibilityTimeout: originalVisibilityTimeout },
        }),
      );
      client.destroy();
    }
  }, 30_000);

  it('retains failed outbox events and retries the same event without duplication', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '0.00');
    const eventId = randomUUID();
    const em = app.get(EntityManager).fork();
    const client = createSqsTestClient();
    const eventQueueName =
      process.env.SQS_EVENT_QUEUE_NAME ?? 'wagering-events';
    let eventQueueUrl = await getQueueUrl(client, eventQueueName);

    try {
      await client.send(new DeleteQueueCommand({ QueueUrl: eventQueueUrl }));
      em.persist(
        em.create(OutboxMessageEntity, {
          id: eventId,
          aggregateId: walletId,
          eventType: 'test.outbox.retry',
          version: 1,
          payload: { testId: eventId },
          occurredAt: new Date(),
          attempts: 0,
        }),
      );
      await em.flush();

      let outboxMessage: OutboxMessageEntity | null = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        em.clear();
        outboxMessage = await em.findOne(OutboxMessageEntity, { id: eventId });
        if (outboxMessage?.attempts === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      expect(outboxMessage?.attempts).toBe(1);
      expect(outboxMessage?.publishedAt).toBeFalsy();
      expect(
        new Date(String(outboxMessage?.nextAttemptAt)).getTime(),
      ).toBeGreaterThan(Date.now());
      expect(outboxMessage?.lockedBy).toBeFalsy();

      const recreatedQueue = await client.send(
        new CreateQueueCommand({ QueueName: eventQueueName }),
      );
      eventQueueUrl =
        recreatedQueue.QueueUrl ?? (await getQueueUrl(client, eventQueueName));
      for (
        let attempt = 0;
        attempt < 60 && !outboxMessage?.publishedAt;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        em.clear();
        outboxMessage = await em.findOne(OutboxMessageEntity, { id: eventId });
      }

      expect(outboxMessage?.publishedAt).toBeTruthy();
      expect(outboxMessage?.attempts).toBe(1);
      em.clear();
      expect(await em.count(OutboxMessageEntity, { id: eventId })).toBe(1);
      const eventMessages = await receiveOutboxEvents(
        client,
        eventQueueUrl,
        new Set([eventId]),
      );
      const matchingEvents = eventMessages.filter(
        (event) => event.eventId === eventId,
      );
      expect(matchingEvents).toHaveLength(1);
      expect(matchingEvents[0]).toMatchObject({
        eventId,
        eventType: 'test.outbox.retry',
        aggregateId: walletId,
        correlationId: eventId,
        version: 1,
        data: { testId: eventId },
      });
      expect(new Date(matchingEvents[0].occurredAt).toISOString()).toBe(
        matchingEvents[0].occurredAt,
      );
    } finally {
      try {
        await client.send(
          new CreateQueueCommand({ QueueName: eventQueueName }),
        );
      } finally {
        client.destroy();
      }
    }
  }, 30_000);

  it('lets concurrent publishers claim distinct outbox rows and publish full envelopes', async () => {
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '0.00');
    await app.get(SqsWagerWorker).stop();

    const eventIds = Array.from({ length: 40 }, () => randomUUID());
    const em = app.get(EntityManager).fork();
    for (const [index, eventId] of eventIds.entries()) {
      em.persist(
        em.create(OutboxMessageEntity, {
          id: eventId,
          aggregateId: walletId,
          eventType: 'test.concurrent.publish',
          correlationId: `correlation-${eventId}`,
          causationId: `cause-${eventId}`,
          version: index + 2,
          payload: {
            transactionId: `transaction-${eventId}`,
            providerId: 'test_provider',
            money: { amount: '1.00', currency: 'BRL' },
          },
          occurredAt: new Date(),
          attempts: 0,
        }),
      );
    }
    await em.flush();

    const firstPort = await getAvailablePort();
    let secondPort = await getAvailablePort();
    while (secondPort === firstPort) secondPort = await getAvailablePort();
    let firstPublisher: RunningService | undefined;
    let secondPublisher: RunningService | undefined;
    const client = createSqsTestClient();
    const eventQueueUrl = await getQueueUrl(
      client,
      process.env.SQS_EVENT_QUEUE_NAME ?? 'wagering-events',
    );

    try {
      [firstPublisher, secondPublisher] = await Promise.all([
        startServiceProcess(firstPort, { workersEnabled: true }),
        startServiceProcess(secondPort, { workersEnabled: true }),
      ]);

      let publishedCount = 0;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        em.clear();
        publishedCount = await em.count(OutboxMessageEntity, {
          id: { $in: eventIds },
          publishedAt: { $ne: null },
        });
        if (publishedCount === eventIds.length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(publishedCount).toBe(eventIds.length);

      const events = await receiveOutboxEvents(
        client,
        eventQueueUrl,
        new Set<string>(eventIds),
      );
      const expectedIds = new Set<string>(eventIds);
      const publishedEvents = events.filter((event) =>
        expectedIds.has(event.eventId),
      );
      expect(publishedEvents).toHaveLength(eventIds.length);
      expect(new Set(publishedEvents.map((event) => event.eventId)).size).toBe(
        eventIds.length,
      );
      expect(publishedEvents[0]).toMatchObject({
        eventType: 'test.concurrent.publish',
        aggregateId: walletId,
        correlationId: `correlation-${publishedEvents[0].eventId}`,
        causationId: `cause-${publishedEvents[0].eventId}`,
        version: expect.any(Number),
        data: {
          money: { amount: '1.00', currency: 'BRL' },
        },
      });
      expect(new Date(publishedEvents[0].occurredAt).toISOString()).toBe(
        publishedEvents[0].occurredAt,
      );
    } finally {
      if (firstPublisher) await stopServiceProcess(firstPublisher.child);
      if (secondPublisher) await stopServiceProcess(secondPublisher.child);
      client.destroy();
    }
  }, 60_000);

  it('redelivers after a worker crash between database commit and SQS acknowledgement', async () => {
    await app.get(SqsWagerWorker).stop();
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const firstPort = await getAvailablePort();
    const recoveryPort = await getAvailablePort();
    let crashedWorker: RunningService | undefined;
    let recoveryWorker: RunningService | undefined;
    const externalTransactionId = `crash_ack_${randomUUID()}`;
    const idempotencyKey = `crash_ack_${randomUUID()}`;

    try {
      crashedWorker = await startServiceProcess(firstPort, {
        workersEnabled: true,
        ackDelayMs: 15_000,
      });
      const queued = await request(app.getHttpServer())
        .post('/wagering/transactions/queue')
        .set('idempotency-key', idempotencyKey)
        .send(wagerBody(playerId, walletId, externalTransactionId, '10.00'));
      expect(queued.status).toBe(202);

      const em = app.get(EntityManager).fork();
      let transaction: WagerTransactionEntity | null = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        transaction = await em.findOne(WagerTransactionEntity, {
          externalTransactionId,
        });
        if (transaction?.status === WagerTransactionStatus.Processed) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(transaction?.status).toBe(WagerTransactionStatus.Processed);

      await killServiceProcess(crashedWorker.child);
      crashedWorker = undefined;

      recoveryWorker = await startServiceProcess(recoveryPort, {
        workersEnabled: true,
      });
      const client = createSqsTestClient();
      let visibleMessages = 1;
      try {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const queueUrl = await getQueueUrl(
            client,
            process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
          );
          const attributes = await client.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
              ],
            }),
          );
          visibleMessages =
            Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '1') +
            Number(
              attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ??
                '1',
            );
          if (visibleMessages === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        client.destroy();
      }
      expect(visibleMessages).toBe(0);

      em.clear();
      expect(
        await em.count(WagerTransactionEntity, { externalTransactionId }),
      ).toBe(1);
      expect(
        await em.count(InboxMessageEntity, {
          consumerName: 'wager-command-consumer',
          messageId: queued.body.messageId as string,
        }),
      ).toBe(1);
      expect(
        await em.count(WalletLedgerEntity, {
          walletId,
          direction: 'DEBIT',
        }),
      ).toBe(1);
      const wallet = await request(app.getHttpServer()).get(
        `/wagering/wallets/${walletId}`,
      );
      expect(wallet.body.balance).toBe('90.00');
    } finally {
      if (crashedWorker) await killServiceProcess(crashedWorker.child);
      if (recoveryWorker) await stopServiceProcess(recoveryWorker.child);
    }
  }, 60_000);

  it('drains an in-flight command before closing SQS on graceful shutdown', async () => {
    await app.get(SqsWagerWorker).stop();
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const gracefulApp = moduleFixture.createNestApplication();
    const externalTransactionId = `graceful_shutdown_${randomUUID()}`;

    try {
      await gracefulApp.init();
      const queued = await request(app.getHttpServer())
        .post('/wagering/transactions/queue')
        .send(wagerBody(playerId, walletId, externalTransactionId, '10.00'));
      expect(queued.status).toBe(202);

      const em = app.get(EntityManager).fork();
      let transaction: WagerTransactionEntity | null = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        transaction = await em.findOne(WagerTransactionEntity, {
          externalTransactionId,
        });
        if (transaction?.status === WagerTransactionStatus.Processed) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(transaction?.status).toBe(WagerTransactionStatus.Processed);

      await gracefulApp.close();

      const client = createSqsTestClient();
      try {
        const queueUrl = await getQueueUrl(
          client,
          process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
        );
        const attributes = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
            ],
          }),
        );
        expect(
          Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '0') +
            Number(
              attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ??
                '0',
            ),
        ).toBe(0);
      } finally {
        client.destroy();
      }

      em.clear();
      expect(
        await em.count(InboxMessageEntity, {
          consumerName: 'wager-command-consumer',
          messageId: queued.body.messageId as string,
        }),
      ).toBe(1);
      const wallet = await request(app.getHttpServer()).get(
        `/wagering/wallets/${walletId}`,
      );
      expect(wallet.body.balance).toBe('90.00');
    } finally {
      await gracefulApp.close();
    }
  }, 30_000);

  it('recovers persisted PENDING_REFERENCE work after a worker restart', async () => {
    await app.get(SqsWagerWorker).stop();
    const playerId = `player_${randomUUID()}`;
    const walletId = await createWallet(app, playerId, '100.00');
    const betExternalId = `restart_bet_${randomUUID()}`;
    const rollbackExternalId = `restart_rollback_${randomUUID()}`;
    const rollback = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `restart_rollback_${randomUUID()}`)
      .send({
        ...wagerBody(playerId, walletId, rollbackExternalId, '15.00'),
        kind: 'ROLLBACK',
        referenceExternalTransactionId: betExternalId,
      });
    expect(rollback.body.status).toBe(WagerTransactionStatus.PendingReference);

    const port = await getAvailablePort();
    const restartedWorker = await startServiceProcess(port, {
      workersEnabled: true,
    });
    try {
      const bet = await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('idempotency-key', `restart_bet_${randomUUID()}`)
        .send(wagerBody(playerId, walletId, betExternalId, '15.00'));
      expect(bet.body.status).toBe(WagerTransactionStatus.Processed);

      const em = app.get(EntityManager).fork();
      let transaction: WagerTransactionEntity | null = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        transaction = await em.findOne(WagerTransactionEntity, {
          externalTransactionId: rollbackExternalId,
        });
        if (transaction?.status === WagerTransactionStatus.Processed) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(transaction?.status).toBe(WagerTransactionStatus.Processed);
      const reconciliation = await request(app.getHttpServer()).post(
        `/wallets/${walletId}/reconciliation`,
      );
      expect(reconciliation.body).toMatchObject({
        storedBalance: { amount: '100.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        consistent: true,
      });
    } finally {
      await stopServiceProcess(restartedWorker.child);
    }
  }, 60_000);
});

async function createWallet(
  app: INestApplication,
  playerId: string,
  initialBalance: string,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/wagering/wallets')
    .send({ playerId, initialBalance, currency: 'BRL' });
  expect(response.status).toBe(201);
  return response.body.walletId as string;
}

function wagerBody(
  playerId: string,
  walletId: string,
  externalTransactionId: string,
  amount: string,
) {
  return {
    providerId: 'test_provider',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round_e2e',
    gameId: 'game_e2e',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function createSqsTestClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;
  if (!endpoint) {
    throw new Error('SQS_ENDPOINT must be set to run SQS E2E tests.');
  }
  return new SQSClient({
    region:
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

async function getQueueUrl(
  client: SQSClient,
  queueName: string,
): Promise<string> {
  const result = await client.send(
    new GetQueueUrlCommand({ QueueName: queueName }),
  );
  if (!result.QueueUrl) {
    throw new Error(`SQS did not return a URL for queue ${queueName}.`);
  }
  return result.QueueUrl;
}

interface RunningService {
  child: ChildProcess;
}

interface TestOutboxEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}

async function receiveOutboxEvents(
  client: SQSClient,
  queueUrl: string,
  expectedEventIds: Set<string>,
): Promise<TestOutboxEvent[]> {
  const events: TestOutboxEvent[] = [];
  let quietPolls = 0;
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    const messages = result.Messages ?? [];
    if (messages.length === 0) {
      quietPolls += 1;
      if (quietPolls >= 3 && expectedEventIds.size === 0) {
        return events;
      }
      if (
        quietPolls >= 3 &&
        [...expectedEventIds].every((id) =>
          events.some((event) => event.eventId === id),
        )
      ) {
        return events;
      }
      continue;
    }

    quietPolls = 0;
    for (const message of messages) {
      if (!message.Body || !message.ReceiptHandle) continue;
      events.push(JSON.parse(message.Body) as TestOutboxEvent);
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  }

  const missing = [...expectedEventIds].filter(
    (id) => !events.some((event) => event.eventId === id),
  );
  expect(missing).toEqual([]);
  return events;
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate a local TCP port for the E2E service.');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startServiceProcess(
  port: number,
  options: { workersEnabled?: boolean; ackDelayMs?: number } = {},
): Promise<RunningService> {
  const child = spawn('bun', ['src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SQS_WORKERS_ENABLED: options.workersEnabled ? 'true' : 'false',
      SQS_QUEUES_AUTO_CREATE: 'false',
      SQS_TEST_ACK_DELAY_MS: String(options.ackDelayMs ?? 0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let spawnError: Error | undefined;
  const appendOutput = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-4000);
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  child.on('error', (error) => {
    spawnError = error;
  });

  const runningService = { child };
  const deadline = Date.now() + 30_000;
  let lastConnectionError: unknown;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Could not start E2E service process. ${output}`, {
        cause: spawnError,
      });
    }
    if (child.exitCode !== null) {
      throw new Error(`E2E service exited before becoming ready. ${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.ok) return runningService;
    } catch (error) {
      lastConnectionError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await stopServiceProcess(child);
  throw new Error(`E2E service did not become ready. ${output}`, {
    cause: lastConnectionError,
  });
}

async function stopServiceProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('E2E service process did not stop after SIGKILL.');
  }
}

async function killServiceProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('E2E service process did not exit after SIGKILL.');
  }
}
