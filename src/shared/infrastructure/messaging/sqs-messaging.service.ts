import { createHash } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  isLocalEnvironment,
  parseBooleanEnvironmentVariable,
} from '../config/runtime-environment.js';
import { ProcessWagerCommand } from '../../../wagering/application/commands/process-wager.handler.js';

export interface OutboxEventEnvelope {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}

@Injectable()
export class SqsMessagingService implements OnModuleInit {
  private readonly logger = new Logger(SqsMessagingService.name);
  private readonly autoCreateQueues = shouldAutoCreateQueues();
  private readonly client: SQSClient;
  private closed = false;
  private queuesPromise?: Promise<void>;
  private commandQueueUrl?: string;
  private eventQueueUrl?: string;

  constructor() {
    const endpoint = process.env.SQS_ENDPOINT;
    this.client = new SQSClient({
      region:
        process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
            },
          }
        : {}),
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.SQS_WORKERS_ENABLED === 'false') return;
    try {
      await this.ensureQueues();
    } catch (error) {
      this.logger.error(
        {
          event: 'sqs.queues.initialization_failed',
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.destroy();
  }

  async sendWagerCommand(
    command: ProcessWagerCommand,
  ): Promise<string | undefined> {
    await this.ensureQueues();
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.requiredUrl(this.commandQueueUrl),
        MessageBody: JSON.stringify(command),
        MessageGroupId: command.walletId,
        MessageDeduplicationId: getMessageDeduplicationId(
          command.idempotencyKey,
          command.payloadHash,
        ),
      }),
    );
    return result.MessageId;
  }

  async checkReadiness(): Promise<void> {
    await this.ensureQueues();
  }

  async receiveWagerCommands() {
    await this.ensureQueues();
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.requiredUrl(this.commandQueueUrl),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
        VisibilityTimeout: getWagerVisibilityTimeout(),
      }),
    );
    return result.Messages ?? [];
  }

  async deleteWagerCommand(receiptHandle: string): Promise<void> {
    await this.ensureQueues();
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.requiredUrl(this.commandQueueUrl),
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async sendWagerEvent(event: OutboxEventEnvelope): Promise<void> {
    await this.ensureQueues();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.requiredUrl(this.eventQueueUrl),
        MessageBody: JSON.stringify(event),
      }),
    );
  }

  private async ensureQueues(): Promise<void> {
    if (!this.queuesPromise) {
      this.queuesPromise = this.createQueues();
    }
    try {
      await this.queuesPromise;
    } catch (error) {
      this.queuesPromise = undefined;
      throw error;
    }
  }

  private async createQueues(): Promise<void> {
    const commandQueueName =
      process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo';
    const eventQueueName =
      process.env.SQS_EVENT_QUEUE_NAME ?? 'wagering-events';
    const deadLetterQueueName =
      process.env.SQS_WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo';

    if (!this.autoCreateQueues) {
      this.commandQueueUrl = await this.getQueueUrl(commandQueueName);
      this.eventQueueUrl = await this.getQueueUrl(eventQueueName);
      const deadLetterQueueUrl = await this.getQueueUrl(deadLetterQueueName);
      const [commandAttributes, deadLetterAttributes] = await Promise.all([
        this.getQueueAttributes(this.commandQueueUrl),
        this.getQueueAttributes(deadLetterQueueUrl),
      ]);
      this.assertFifoQueue(commandQueueName, commandAttributes);
      this.assertFifoQueue(deadLetterQueueName, deadLetterAttributes);
      this.assertRedriveTarget(
        commandQueueName,
        commandAttributes,
        deadLetterAttributes.QueueArn,
      );
      return;
    }

    const deadLetterQueueUrl = await this.createQueue(deadLetterQueueName, {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
    });
    const visibilityTimeout = getWagerVisibilityTimeout();
    const attributes = await this.client.send(
      new CreateQueueCommand({
        QueueName: commandQueueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: await this.getQueueArn(deadLetterQueueUrl),
            maxReceiveCount: '5',
          }),
          VisibilityTimeout: String(visibilityTimeout),
        },
      }),
    );
    this.commandQueueUrl =
      attributes.QueueUrl ?? (await this.getQueueUrl(commandQueueName));
    const [commandAttributes, deadLetterAttributes] = await Promise.all([
      this.getQueueAttributes(this.commandQueueUrl),
      this.getQueueAttributes(deadLetterQueueUrl),
    ]);
    this.assertFifoQueue(commandQueueName, commandAttributes);
    this.assertFifoQueue(deadLetterQueueName, deadLetterAttributes);
    this.assertRedriveTarget(
      commandQueueName,
      commandAttributes,
      deadLetterAttributes.QueueArn,
    );
    this.eventQueueUrl = await this.createQueue(eventQueueName);
  }

  private async createQueue(
    queueName: string,
    attributes?: Record<string, string>,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateQueueCommand({ QueueName: queueName, Attributes: attributes }),
    );
    const queueUrl = result.QueueUrl ?? (await this.getQueueUrl(queueName));
    return this.requiredUrl(queueUrl);
  }

  private async getQueueUrl(queueName: string): Promise<string> {
    const result = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );
    return this.requiredUrl(result.QueueUrl);
  }

  private async getQueueArn(queueUrl: string): Promise<string> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const arn = result.Attributes?.QueueArn;
    if (!arn) throw new Error('Unable to resolve SQS dead-letter queue ARN.');
    return arn;
  }

  private async getQueueAttributes(
    queueUrl: string,
  ): Promise<Record<string, string | undefined>> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['FifoQueue', 'QueueArn', 'RedrivePolicy'],
      }),
    );
    return result.Attributes ?? {};
  }

  private assertFifoQueue(
    queueName: string,
    attributes: Record<string, string | undefined>,
  ): void {
    if (attributes.FifoQueue !== 'true') {
      throw new Error(`SQS queue "${queueName}" must be a FIFO queue.`);
    }
  }

  private assertRedriveTarget(
    queueName: string,
    commandAttributes: Record<string, string | undefined>,
    expectedDeadLetterArn: string | undefined,
  ): void {
    let redrivePolicy: { deadLetterTargetArn?: string } | undefined;
    try {
      redrivePolicy = JSON.parse(commandAttributes.RedrivePolicy ?? '') as {
        deadLetterTargetArn?: string;
      };
    } catch (error) {
      throw new Error(
        `SQS queue "${queueName}" must have a valid redrive policy.`,
        { cause: error },
      );
    }
    if (
      !expectedDeadLetterArn ||
      redrivePolicy.deadLetterTargetArn !== expectedDeadLetterArn
    ) {
      throw new Error(
        `SQS queue "${queueName}" must redrive to the configured FIFO DLQ.`,
      );
    }
  }

  private requiredUrl(url: string | undefined): string {
    if (!url) throw new Error('SQS did not return a queue URL.');
    return url;
  }
}

export function getMessageDeduplicationId(
  idempotencyKey: string,
  payloadHash: string,
): string {
  return createHash('sha256')
    .update(`${idempotencyKey}\0${payloadHash}`)
    .digest('hex');
}

function getWagerVisibilityTimeout(): number {
  const timeout = Number(
    process.env.SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS ?? '45',
  );
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 43_200) {
    throw new Error(
      'SQS_WAGER_VISIBILITY_TIMEOUT_SECONDS must be an integer between 0 and 43200.',
    );
  }
  return timeout;
}

export function shouldAutoCreateQueues(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const localEnvironment = isLocalEnvironment(environment.NODE_ENV);
  const setting = parseBooleanEnvironmentVariable(
    'SQS_QUEUES_AUTO_CREATE',
    environment.SQS_QUEUES_AUTO_CREATE,
  );
  if (!localEnvironment && setting === true) {
    throw new Error(
      'SQS_QUEUES_AUTO_CREATE=true is allowed only in development or test.',
    );
  }
  return localEnvironment && setting !== false;
}
