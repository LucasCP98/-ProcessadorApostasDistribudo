-- Extensão para UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabela de Wallets com constraint de saldo não-negativo
CREATE TABLE IF NOT EXISTS wallets (
    id VARCHAR(36) PRIMARY KEY,
    player_id VARCHAR(64) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
    balance NUMERIC(15, 2) NOT NULL CHECK (balance >= 0.00),
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_player_currency UNIQUE (player_id, currency)
);

-- 2. Tabela de Transações de Aposta (Wager Transactions)
CREATE TABLE IF NOT EXISTS wager_transactions (
    id VARCHAR(36) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    external_transaction_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    payload_hash VARCHAR(64) NOT NULL,
    wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id),
    player_id VARCHAR(64) NOT NULL,
    round_id VARCHAR(128) NOT NULL,
    game_id VARCHAR(128) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    amount NUMERIC(15, 2) NOT NULL CHECK (amount >= 0.00),
    currency VARCHAR(3) NOT NULL,
    reference_external_transaction_id VARCHAR(128),
    reference_transaction_id VARCHAR(36) REFERENCES wager_transactions(id),
    status VARCHAR(32) NOT NULL,
    failure_code VARCHAR(64),
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_provider_external_tx UNIQUE (provider_id, external_transaction_id)
);

-- 3. Tabela de Ledger (Append-Only rigoroso)
CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
    id VARCHAR(36) PRIMARY KEY,
    wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id),
    transaction_id VARCHAR(36) NOT NULL REFERENCES wager_transactions(id),
    direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0.00),
    currency VARCHAR(3) NOT NULL,
    balance_before NUMERIC(15, 2) NOT NULL CHECK (balance_before >= 0.00),
    balance_after NUMERIC(15, 2) NOT NULL CHECK (balance_after >= 0.00),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Trigger de Imutabilidade Estrita para o Ledger (Restrição Inviolável #5)
CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Wallet ledger entries are immutable and cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;
CREATE TRIGGER trg_ledger_immutable
BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- 4. Tabelas Inbox e Outbox para Mensageria Confiável
CREATE TABLE IF NOT EXISTS inbox_messages (
    message_id VARCHAR(64) PRIMARY KEY,
    consumer_name VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS outbox_messages (
    id VARCHAR(36) PRIMARY KEY,
    aggregate_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE,
    published_at TIMESTAMP WITH TIME ZONE
);