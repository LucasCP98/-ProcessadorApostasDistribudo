import { Migration } from '@mikro-orm/migrations';

export class Migration20261119000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN IF NOT EXISTS correlation_id varchar(128),
        ADD COLUMN IF NOT EXISTS causation_id varchar(128);

      ALTER TABLE outbox_messages
        ADD COLUMN IF NOT EXISTS correlation_id varchar(128),
        ADD COLUMN IF NOT EXISTS causation_id varchar(128),
        ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE outbox_messages
        DROP COLUMN IF EXISTS version,
        DROP COLUMN IF EXISTS causation_id,
        DROP COLUMN IF EXISTS correlation_id;

      ALTER TABLE wager_transactions
        DROP COLUMN IF EXISTS causation_id,
        DROP COLUMN IF EXISTS correlation_id;
    `);
  }
}
