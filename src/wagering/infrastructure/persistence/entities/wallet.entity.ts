import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'string' })
  playerId!: string;

  @Property({ type: 'string' })
  currency!: string;

  @Property({ type: 'numeric', columnType: 'decimal(15,2)' })
  balance!: string;

  @Property({ type: 'number' })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'date' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', type: 'date' })
  updatedAt: Date = new Date();
}