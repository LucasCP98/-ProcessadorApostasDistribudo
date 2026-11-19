import {
  getMessageDeduplicationId,
  shouldAutoCreateQueues,
} from './sqs-messaging.service.js';

describe('SQS queue auto-creation configuration', () => {
  it('creates stable FIFO deduplication IDs that change with the payload', () => {
    const first = getMessageDeduplicationId('idem-key', 'payload-hash');

    expect(first).toHaveLength(64);
    expect(getMessageDeduplicationId('idem-key', 'payload-hash')).toBe(first);
    expect(getMessageDeduplicationId('idem-key', 'different-hash')).not.toBe(
      first,
    );
  });

  it.each(['development', 'test', 'DEVELOPMENT'])(
    'defaults to auto-creation in local environment %s',
    (nodeEnvironment) => {
      expect(shouldAutoCreateQueues({ NODE_ENV: nodeEnvironment })).toBe(true);
    },
  );

  it.each([undefined, 'staging', 'production', 'STAGING'])(
    'disables auto-creation by default when NODE_ENV is %s',
    (nodeEnvironment) => {
      expect(shouldAutoCreateQueues({ NODE_ENV: nodeEnvironment })).toBe(false);
    },
  );

  it.each(['FALSE', 'No', '0', 'off'])(
    'respects case-insensitive false setting %s',
    (setting) => {
      expect(
        shouldAutoCreateQueues({
          NODE_ENV: 'development',
          SQS_QUEUES_AUTO_CREATE: setting,
        }),
      ).toBe(false);
    },
  );

  it('rejects enabling queue creation outside development and test', () => {
    expect(() =>
      shouldAutoCreateQueues({
        NODE_ENV: 'staging',
        SQS_QUEUES_AUTO_CREATE: 'TrUe',
      }),
    ).toThrow('SQS_QUEUES_AUTO_CREATE=true is allowed only');
  });

  it('rejects ambiguous boolean values', () => {
    expect(() =>
      shouldAutoCreateQueues({
        NODE_ENV: 'test',
        SQS_QUEUES_AUTO_CREATE: 'sometimes',
      }),
    ).toThrow('SQS_QUEUES_AUTO_CREATE must be a boolean value');
  });
});
