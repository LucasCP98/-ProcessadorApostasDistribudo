import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WalletEntity } from './infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from './infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntity } from './infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import {
  WalletReconciliationController,
  WageringController,
} from './infrastructure/http/wagering.controller.js';
import { ProcessWagerHandler } from './application/commands/process-wager.handler.js';
import { CreateWalletHandler } from './application/commands/create-wallet.handler.js';
import { WageringQueriesHandler } from './application/queries/wagering-queries.handler.js';
import { InboxMessageEntity } from '../shared/infrastructure/database/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../shared/infrastructure/database/entities/outbox-message.entity.js';
import { MessagingModule } from '../shared/infrastructure/messaging/messaging.module.js';
import { SqsWagerWorker } from './infrastructure/messaging/sqs-wager-worker.service.js';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ]),
    MessagingModule,
  ],
  controllers: [WageringController, WalletReconciliationController],
  providers: [
    ProcessWagerHandler,
    CreateWalletHandler,
    WageringQueriesHandler,
    SqsWagerWorker,
  ],
  exports: [ProcessWagerHandler],
})
export class WageringModule {}
