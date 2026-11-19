import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'string' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'string' })
  eventType!: string;

  @Property({ fieldName: 'correlation_id', type: 'string', nullable: true })
  correlationId?: string;

  @Property({ fieldName: 'causation_id', type: 'string', nullable: true })
  causationId?: string;

  @Property({ type: 'number' })
  version = 1;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', type: 'date' })
  occurredAt: Date = new Date();

  @Property({ type: 'number' })
  attempts = 0;

  @Property({ fieldName: 'next_attempt_at', type: 'date', nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: 'published_at', type: 'date', nullable: true })
  publishedAt?: Date;

  @Property({ fieldName: 'locked_until', type: 'date', nullable: true })
  lockedUntil?: Date;

  @Property({ fieldName: 'locked_by', type: 'string', nullable: true })
  lockedBy?: string;
}
