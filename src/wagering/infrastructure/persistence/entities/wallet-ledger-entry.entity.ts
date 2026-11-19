import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntity {
    @PrimaryKey({ type: 'string' })
    id!: string;

    @Property({ fieldName: 'wallet_id', type: 'string' })
    walletId!: string;

    @Property({ fieldName: 'transaction_id', type: 'string' })
    transactionId!: string;

    @Property({ type: 'string' })
    direction!: string;

    @Property({ type: 'numeric', columnType: 'decimal(15,2)' })
    amount!: string;

    @Property({ type: 'string' })
    currency!: string;

    @Property({ fieldName: 'balance_before', type: 'numeric', columnType: 'decimal(15,2)' })
    balanceBefore!: string;

    @Property({ fieldName: 'balance_after', type: 'numeric', columnType: 'decimal(15,2)' })
    balanceAfter!: string;

    @Property({ fieldName: 'created_at', type: 'date' })
    createdAt: Date = new Date();
}