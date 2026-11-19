import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: 'message_id', type: 'string' })
  messageId!: string;

  @PrimaryKey({ fieldName: 'consumer_name', type: 'string' })
  consumerName!: string;

  @Property({ fieldName: 'payload_hash', type: 'string' })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', type: 'date' })
  receivedAt: Date = new Date();

  @Property({ fieldName: 'processed_at', type: 'date', nullable: true })
  processedAt?: Date;
}
