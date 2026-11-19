import { createDatabaseOptions } from './database.config.js';

describe('database configuration', () => {
  it.each([undefined, 'staging', 'production'])(
    'requires DATABASE_URL when NODE_ENV is %s',
    (nodeEnvironment) => {
      expect(() =>
        createDatabaseOptions({ NODE_ENV: nodeEnvironment }),
      ).toThrow('DATABASE_URL is required');
    },
  );

  it('keeps localhost defaults and SQL debug limited to development and test', () => {
    const development = createDatabaseOptions({ NODE_ENV: ' Development ' });
    const test = createDatabaseOptions({ NODE_ENV: 'test' });

    expect(development).toMatchObject({
      dbName: 'wagering_db',
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      debug: true,
    });
    expect(test.debug).toBe(true);
    expect(development.driverOptions).not.toHaveProperty('ssl');
  });

  it('uses secure non-local defaults for TLS, pool, and timeouts', () => {
    const options = createDatabaseOptions({
      NODE_ENV: 'staging',
      DATABASE_URL:
        'postgresql://stage-user:stage-pass@db.example:5432/wagering',
    });

    expect(options).toMatchObject({
      clientUrl: 'postgresql://stage-user:stage-pass@db.example:5432/wagering',
      debug: false,
      pool: { min: 0, max: 10, idleTimeoutMillis: 30_000 },
      driverOptions: {
        connectionTimeoutMillis: 5000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
        lock_timeout: 5000,
        ssl: { rejectUnauthorized: true },
      },
    });
  });

  it('rejects attempts to disable TLS outside development and test', () => {
    expect(() =>
      createDatabaseOptions({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgresql://stage-user:stage-pass@db.example:5432/wagering',
        POSTGRES_SSL: 'FaLsE',
      }),
    ).toThrow('POSTGRES_SSL cannot be disabled');
  });

  it.each(['disable', 'no-verify'])(
    'rejects DATABASE_URL sslmode=%s outside development and test',
    (sslMode) => {
      expect(() =>
        createDatabaseOptions({
          NODE_ENV: 'staging',
          DATABASE_URL: `postgresql://stage-user:stage-pass@db.example:5432/wagering?sslmode=${sslMode}`,
        }),
      ).toThrow('DATABASE_URL sslmode must be verify-full');
    },
  );

  it('rejects DATABASE_URL ssl=false outside development and test', () => {
    expect(() =>
      createDatabaseOptions({
        NODE_ENV: 'staging',
        DATABASE_URL:
          'postgresql://stage-user:stage-pass@db.example:5432/wagering?ssl=0',
      }),
    ).toThrow('DATABASE_URL cannot disable PostgreSQL TLS');
  });

  it('validates pool bounds and boolean TLS settings', () => {
    expect(() =>
      createDatabaseOptions({
        NODE_ENV: 'test',
        POSTGRES_POOL_MIN: '11',
        POSTGRES_POOL_MAX: '10',
      }),
    ).toThrow('POSTGRES_POOL_MIN cannot exceed POSTGRES_POOL_MAX');

    expect(() =>
      createDatabaseOptions({
        NODE_ENV: 'test',
        POSTGRES_SSL: 'sometimes',
      }),
    ).toThrow('POSTGRES_SSL must be a boolean value');
  });
});
