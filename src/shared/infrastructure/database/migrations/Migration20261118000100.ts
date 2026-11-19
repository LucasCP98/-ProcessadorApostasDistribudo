import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallets (
        id varchar(36) PRIMARY KEY,
        player_id varchar(64) NOT NULL,
        currency varchar(3) NOT NULL,
        balance numeric(15, 2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_player_currency UNIQUE (player_id, currency)
      );

      CREATE TABLE IF NOT EXISTS wager_transactions (
        id varchar(36) PRIMARY KEY,
        provider_id varchar(64) NOT NULL,
        external_transaction_id varchar(128) NOT NULL,
        idempotency_key varchar(128) NOT NULL UNIQUE,
        payload_hash varchar(64) NOT NULL,
        wallet_id varchar(36) NOT NULL REFERENCES wallets(id),
        player_id varchar(64) NOT NULL,
        round_id varchar(128) NOT NULL,
        game_id varchar(128) NOT NULL,
        kind varchar(32) NOT NULL,
        amount numeric(15, 2) NOT NULL CHECK (amount > 0),
        currency varchar(3) NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id varchar(36) REFERENCES wager_transactions(id),
        status varchar(32) NOT NULL,
        failure_code varchar(64),
        processed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        resulting_balance numeric(15, 2),
        resulting_currency varchar(3),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        CONSTRAINT uq_provider_external_tx UNIQUE (provider_id, external_transaction_id)
      );

      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id varchar(36) PRIMARY KEY,
        wallet_id varchar(36) NOT NULL REFERENCES wallets(id),
        transaction_id varchar(36) NOT NULL REFERENCES wager_transactions(id),
        direction varchar(6) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount numeric(15, 2) NOT NULL CHECK (amount > 0),
        currency varchar(3) NOT NULL,
        balance_before numeric(15, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(15, 2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'DEBIT' AND balance_before - amount = balance_after)
          OR
          (direction = 'CREDIT' AND balance_before + amount = balance_after)
        )
      );

      CREATE TABLE IF NOT EXISTS inbox_messages (
        consumer_name varchar(64) NOT NULL,
        message_id varchar(256) NOT NULL,
        payload_hash varchar(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE IF NOT EXISTS outbox_messages (
        id varchar(36) PRIMARY KEY,
        aggregate_id varchar(36) NOT NULL,
        event_type varchar(128) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        locked_until timestamptz,
        locked_by varchar(128)
      );

      ALTER TABLE wager_transactions
        ADD COLUMN IF NOT EXISTS resulting_balance numeric(15, 2),
        ADD COLUMN IF NOT EXISTS resulting_currency varchar(3),
        ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

      ALTER TABLE outbox_messages
        ADD COLUMN IF NOT EXISTS locked_until timestamptz,
        ADD COLUMN IF NOT EXISTS locked_by varchar(128);

      ALTER TABLE inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_pkey;
      ALTER TABLE inbox_messages
        ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id);

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_wager_amount_positive'
            AND conrelid = 'wager_transactions'::regclass
        ) THEN
          ALTER TABLE wager_transactions
            ADD CONSTRAINT ck_wager_amount_positive CHECK (amount > 0);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_ledger_arithmetic'
            AND conrelid = 'wallet_ledger_entries'::regclass
        ) THEN
          ALTER TABLE wallet_ledger_entries
            ADD CONSTRAINT ck_ledger_arithmetic CHECK (
              (direction = 'DEBIT' AND balance_before - amount = balance_after)
              OR
              (direction = 'CREDIT' AND balance_before + amount = balance_after)
            );
        END IF;
      END $$;

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM wallets w
          LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
          GROUP BY w.id
          HAVING w.balance - COALESCE(SUM(
            CASE WHEN l.direction = 'CREDIT' THEN l.amount
                 WHEN l.direction = 'DEBIT' THEN -l.amount
                 ELSE 0 END
          ), 0) < 0
        ) THEN
          RAISE EXCEPTION 'Cannot migrate: existing wallet balances are below their ledger totals';
        END IF;
      END $$;

      WITH opening_balances AS (
        SELECT
          w.*,
          w.balance - COALESCE(SUM(
            CASE WHEN l.direction = 'CREDIT' THEN l.amount
                 WHEN l.direction = 'DEBIT' THEN -l.amount
                 ELSE 0 END
          ), 0) AS opening_amount
        FROM wallets w
        LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        GROUP BY w.id
      )
      INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
        processed_at, created_at, resulting_balance, resulting_currency
      )
      SELECT
        md5('migration-opening:' || w.id),
        'internal',
        'migration-opening:' || w.id,
        'migration-opening:' || w.id,
        'schema-backfill-opening-v1',
        w.id,
        w.player_id,
        'wallet-opening',
        'internal',
        'OPENING',
        w.opening_amount,
        w.currency,
        'PROCESSED',
        w.created_at,
        w.created_at,
        w.opening_amount,
        w.currency
      FROM opening_balances w
      WHERE w.opening_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM wager_transactions t
          WHERE t.wallet_id = w.id AND t.kind = 'OPENING'
        );

      INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at
      )
      SELECT
        md5('migration-opening-ledger:' || t.wallet_id),
        t.wallet_id,
        t.id,
        'CREDIT',
        t.amount,
        t.currency,
        0,
        t.amount,
        t.created_at
      FROM wager_transactions t
      WHERE t.payload_hash = 'schema-backfill-opening-v1'
        AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries l WHERE l.transaction_id = t.id
        );

      UPDATE wager_transactions t
      SET resulting_balance = COALESCE(
        (SELECT l.balance_after FROM wallet_ledger_entries l WHERE l.transaction_id = t.id LIMIT 1),
        (SELECT l.balance_after FROM wallet_ledger_entries l
          WHERE l.wallet_id = t.wallet_id AND l.created_at <= t.created_at
          ORDER BY l.created_at DESC, l.id DESC LIMIT 1),
        (SELECT l.balance_before FROM wallet_ledger_entries l
          WHERE l.wallet_id = t.wallet_id AND l.created_at > t.created_at
          ORDER BY l.created_at, l.id LIMIT 1),
        (SELECT w.balance FROM wallets w WHERE w.id = t.wallet_id)
      ),
      resulting_currency = t.currency
      WHERE t.resulting_balance IS NULL OR t.resulting_currency IS NULL;

      ALTER TABLE wager_transactions
        ALTER COLUMN resulting_balance SET NOT NULL,
        ALTER COLUMN resulting_currency SET NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_transaction_wallet
        ON wallet_ledger_entries (transaction_id, wallet_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rollback_reference
        ON wager_transactions (provider_id, reference_transaction_id)
        WHERE kind = 'ROLLBACK' AND reference_transaction_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pending_reference_due
        ON wager_transactions (next_attempt_at, created_at)
        WHERE status = 'PENDING_REFERENCE';
      CREATE INDEX IF NOT EXISTS idx_outbox_due
        ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL;

      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $fn$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries are immutable and cannot be updated or deleted.';
      END;
      $fn$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;
      CREATE TRIGGER trg_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;
      DELETE FROM wallet_ledger_entries
      WHERE transaction_id IN (
        SELECT id FROM wager_transactions
        WHERE payload_hash = 'schema-backfill-opening-v1'
      );
      DELETE FROM wager_transactions WHERE payload_hash = 'schema-backfill-opening-v1';

      DROP INDEX IF EXISTS idx_outbox_due;
      DROP INDEX IF EXISTS idx_pending_reference_due;
      DROP INDEX IF EXISTS uq_rollback_reference;
      DROP INDEX IF EXISTS uq_ledger_transaction_wallet;

      ALTER TABLE wager_transactions
        DROP COLUMN IF EXISTS resulting_balance,
        DROP COLUMN IF EXISTS resulting_currency,
        DROP COLUMN IF EXISTS attempts,
        DROP COLUMN IF EXISTS next_attempt_at;
      ALTER TABLE outbox_messages
        DROP COLUMN IF EXISTS locked_until,
        DROP COLUMN IF EXISTS locked_by;

      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS ck_wager_amount_positive;
      ALTER TABLE wallet_ledger_entries
        DROP CONSTRAINT IF EXISTS ck_ledger_arithmetic;

      ALTER TABLE inbox_messages DROP CONSTRAINT IF EXISTS inbox_messages_pkey;
      ALTER TABLE inbox_messages
        ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (message_id);

      CREATE TRIGGER trg_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
    `);
  }
}
