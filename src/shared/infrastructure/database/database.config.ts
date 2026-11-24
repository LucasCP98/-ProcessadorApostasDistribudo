import { readFileSync } from 'node:fs';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { resolve } from 'node:path';
import {
  isLocalEnvironment,
  parseBooleanEnvironmentVariable,
} from '../config/runtime-environment.js';
import { WalletEntity } from '../../../wagering/infrastructure/persistence/entities/wallet.entity.js';
import { WalletLedgerEntity } from '../../../wagering/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../../wagering/infrastructure/persistence/entities/wager-transaction.entity.js';
import { InboxMessageEntity } from './entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './entities/outbox-message.entity.js';

const migrationPath = resolve(import.meta.dirname, 'migrations');

export function createDatabaseOptions(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const localEnvironment = isLocalEnvironment(environment.NODE_ENV);
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!localEnvironment && !databaseUrl) {
    throw new Error(
      'DATABASE_URL is required when NODE_ENV is not development or test.',
    );
  }

  const poolMin = readIntegerEnvironmentVariable(
    environment,
    'POSTGRES_POOL_MIN',
    0,
    0,
    1000,
  );
  const poolMax = readIntegerEnvironmentVariable(
    environment,
    'POSTGRES_POOL_MAX',
    10,
    1,
    1000,
  );
  if (poolMin > poolMax) {
    throw new Error('POSTGRES_POOL_MIN cannot exceed POSTGRES_POOL_MAX.');
  }

  const sslSetting = parseBooleanEnvironmentVariable(
    'POSTGRES_SSL',
    environment.POSTGRES_SSL,
  );
  const sslEnabled = sslSetting ?? !localEnvironment;
  if (!localEnvironment && !sslEnabled) {
    throw new Error(
      'POSTGRES_SSL cannot be disabled outside development or test.',
    );
  }
  if (databaseUrl && sslEnabled) {
    validateDatabaseUrlTlsOptions(databaseUrl);
  }
  const caFile = environment.POSTGRES_SSL_CA_FILE?.trim();
  if (caFile && !sslEnabled) {
    throw new Error(
      'POSTGRES_SSL_CA_FILE requires PostgreSQL SSL to be enabled.',
    );
  }
  const ssl = sslEnabled
    ? {
        rejectUnauthorized: true,
        ...(caFile ? { ca: readFileSync(caFile, 'utf8') } : {}),
      }
    : sslSetting === false
      ? false
      : undefined;

  const connectionOptions = databaseUrl
    ? { clientUrl: databaseUrl }
    : {
        dbName: environment.POSTGRES_DB?.trim() || 'wagering_db',
        host: environment.POSTGRES_HOST?.trim() || 'localhost',
        port: readIntegerEnvironmentVariable(
          environment,
          'POSTGRES_PORT',
          5433,
          1,
          65535,
        ),
        user: environment.POSTGRES_USER?.trim() || 'postgres',
        password: environment.POSTGRES_PASSWORD ?? 'postgres',
      };

  const driverOptions = {
    connectionTimeoutMillis: readIntegerEnvironmentVariable(
      environment,
      'POSTGRES_CONNECTION_TIMEOUT_MS',
      5000,
      1,
    ),
    query_timeout: readIntegerEnvironmentVariable(
      environment,
      'POSTGRES_QUERY_TIMEOUT_MS',
      30_000,
      1,
    ),
    statement_timeout: readIntegerEnvironmentVariable(
      environment,
      'POSTGRES_STATEMENT_TIMEOUT_MS',
      30_000,
      1,
    ),
    lock_timeout: readIntegerEnvironmentVariable(
      environment,
      'POSTGRES_LOCK_TIMEOUT_MS',
      5000,
      1,
    ),
    ...(ssl === undefined ? {} : { ssl }),
  };

  return defineConfig({
    driver: PostgreSqlDriver,
    ...connectionOptions,
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ],
    extensions: [Migrator],
    persistOnCreate: false,
    pool: {
      min: poolMin,
      max: poolMax,
      idleTimeoutMillis: readIntegerEnvironmentVariable(
        environment,
        'POSTGRES_POOL_IDLE_TIMEOUT_MS',
        30_000,
        1,
      ),
    },
    driverOptions,
    migrations: {
      path: migrationPath,
      pathTs: migrationPath,
      glob: '!(*.d).{js,ts}',
    },
    debug: localEnvironment,
  });
}

function readIntegerEnvironmentVariable(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum = 2_147_483_647,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return defaultValue;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function validateDatabaseUrlTlsOptions(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get('sslmode')?.trim().toLowerCase();
  const ssl = url.searchParams.get('ssl')?.trim().toLowerCase();

  if (sslMode && sslMode !== 'verify-full') {
    throw new Error(
      'DATABASE_URL sslmode must be verify-full; configure PostgreSQL TLS with POSTGRES_SSL and POSTGRES_SSL_CA_FILE.',
    );
  }
  if (ssl && !['true', '1'].includes(ssl)) {
    throw new Error(
      'DATABASE_URL cannot disable PostgreSQL TLS; configure it with POSTGRES_SSL.',
    );
  }
}

export const databaseOptions = createDatabaseOptions();
