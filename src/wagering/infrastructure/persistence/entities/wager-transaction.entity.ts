import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'string' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'string' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'string' })
  @Unique()
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'string' })
  payloadHash!: string;

  @Property({ fieldName: 'correlation_id', type: 'string', nullable: true })
  correlationId?: string;

  @Property({ fieldName: 'causation_id', type: 'string', nullable: true })
  causationId?: string;

  @Property({ fieldName: 'wallet_id', type: 'string' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'string' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'string' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'string' })
  gameId!: string;

  @Property({ type: 'string' })
  kind!: string;

  @Property({ type: 'numeric', columnType: 'decimal(15,2)' })
  amount!: string;

  @Property({ type: 'string' })
  currency!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'string',
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({
    fieldName: 'reference_transaction_id',
    type: 'string',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({ type: 'string' })
  status!: string;

  @Property({ fieldName: 'failure_code', type: 'string', nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'processed_at', type: 'date', nullable: true })
  processedAt?: Date;

  @Property({ fieldName: 'created_at', type: 'date' })
  createdAt: Date = new Date();

  @Property({
    fieldName: 'resulting_balance',
    type: 'numeric',
    columnType: 'decimal(15,2)',
  })
  resultingBalance!: string;

  @Property({ fieldName: 'resulting_currency', type: 'string' })
  resultingCurrency!: string;

  @Property({ type: 'number' })
  attempts = 0;

  @Property({ fieldName: 'next_attempt_at', type: 'date', nullable: true })
  nextAttemptAt?: Date | null;
}
