import { createHash } from 'node:crypto';
import type { ProcessWagerCommand } from './process-wager.handler.js';

export function hashWagerPayload(
  command: Pick<
    ProcessWagerCommand,
    | 'providerId'
    | 'externalTransactionId'
    | 'playerId'
    | 'walletId'
    | 'roundId'
    | 'gameId'
    | 'kind'
    | 'money'
    | 'referenceExternalTransactionId'
  >,
): string {
  const canonicalPayload = JSON.stringify({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonicalPayload).digest('hex');
}
