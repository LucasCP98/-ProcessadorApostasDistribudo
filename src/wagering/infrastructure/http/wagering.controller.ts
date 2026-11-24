import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Headers,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ProcessWagerHandler,
  ProcessWagerCommand,
} from '../../application/commands/process-wager.handler.js';
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { hashWagerPayload } from '../../application/commands/wager-payload.js';
import { CreateWalletHandler } from '../../application/commands/create-wallet.handler.js';
import { WageringQueriesHandler } from '../../application/queries/wagering-queries.handler.js';
import {
  CreateWalletDto,
  LedgerQueryDto,
  ReconciliationDto,
  WagerRequestDto,
} from './wagering.dto.js';
import { SqsMessagingService } from '../../../shared/infrastructure/messaging/sqs-messaging.service.js';
import { sqsCommandsEnqueued } from '../../../shared/infrastructure/observability/metrics-registry.js';

@ApiTags('Wagering')
@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processWagerHandler: ProcessWagerHandler,
    private readonly createWalletHandler: CreateWalletHandler,
    private readonly queries: WageringQueriesHandler,
    private readonly messaging: SqsMessagingService,
  ) {}

  @Post('wallets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a wallet' })
  @ApiHeader({
    name: 'X-Correlation-Id',
    required: false,
    description: 'Optional correlation identifier.',
  })
  @ApiHeader({
    name: 'X-Causation-Id',
    required: false,
    description: 'Optional causation identifier.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Wallet created.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid body or header.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Wallet already exists.' })
  async createWallet(
    @Body() dto: CreateWalletDto,
    @Headers('x-correlation-id') correlationId: string,
    @Headers('x-causation-id') causationId: string,
  ) {
    return await this.createWalletHandler.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
      currency: dto.currency,
      correlationId:
        normalizeTraceId(correlationId, 'X-Correlation-Id') ?? randomUUID(),
      causationId: normalizeTraceId(causationId, 'X-Causation-Id'),
    });
  }

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Process a wager transaction synchronously' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional key. Defaults to providerId:externalTransactionId and must not exceed 128 characters.',
  })
  @ApiHeader({ name: 'X-Correlation-Id', required: false })
  @ApiHeader({ name: 'X-Causation-Id', required: false })
  @ApiResponse({ status: HttpStatus.OK, description: 'Transaction processed or replayed.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid payload.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Idempotency payload conflict.' })
  async processTransaction(
    @Headers('idempotency-key') headerIdempotencyKey: string,
    @Headers('x-correlation-id') correlationId: string,
    @Headers('x-causation-id') causationId: string,
    @Body() dto: WagerRequestDto,
  ) {
    const command = this.toCommand(
      dto,
      headerIdempotencyKey,
      correlationId,
      causationId,
    );

    const result = await this.processWagerHandler.execute(command);

    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Post('transactions/queue')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue a wager transaction for asynchronous processing' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional key. Defaults to providerId:externalTransactionId and must not exceed 128 characters.',
  })
  @ApiHeader({ name: 'X-Correlation-Id', required: false })
  @ApiHeader({ name: 'X-Causation-Id', required: false })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: 'Command accepted by SQS.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid payload or header.' })
  async queueTransaction(
    @Headers('idempotency-key') headerIdempotencyKey: string,
    @Headers('x-correlation-id') correlationId: string,
    @Headers('x-causation-id') causationId: string,
    @Body() dto: WagerRequestDto,
  ) {
    const messageId = await this.messaging.sendWagerCommand(
      this.toCommand(dto, headerIdempotencyKey, correlationId, causationId),
    );
    if (!messageId) {
      throw new Error(
        'SQS accepted the command without returning a message ID.',
      );
    }
    sqsCommandsEnqueued.inc();
    return { queued: true, messageId };
  }

  @Get('wallets/:walletId')
  @ApiOperation({ summary: 'Get wallet state' })
  @ApiParam({ name: 'walletId', description: 'Wallet identifier.', example: 'wallet-001' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Wallet state.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Wallet not found.' })
  async getWallet(@Param('walletId') walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get('wallets/:walletId/ledger')
  @ApiOperation({ summary: 'Get wallet ledger entries' })
  @ApiParam({ name: 'walletId', description: 'Wallet identifier.', example: 'wallet-001' })
  @ApiQuery({ name: 'limit', required: false, type: String, example: '100' })
  @ApiQuery({ name: 'offset', required: false, type: String, example: '0' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Paged ledger entries.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Wallet not found.' })
  async getLedger(
    @Param('walletId') walletId: string,
    @Query() query: LedgerQueryDto,
  ) {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 100), 500));
    const offset = Number(query.offset ?? 0);
    return this.queries.getLedger(walletId, limit, offset);
  }

  @Get('transactions/:transactionId')
  @ApiOperation({ summary: 'Get a wager transaction' })
  @ApiParam({ name: 'transactionId', description: 'Transaction identifier.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Transaction state.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Transaction not found.' })
  async getTransaction(@Param('transactionId') transactionId: string) {
    return this.queries.getTransaction(transactionId);
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile wallets without changing balances' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Reconciliation result.' })
  async reconcile(@Body() dto?: ReconciliationDto) {
    return this.queries.reconcile(dto?.walletId);
  }

  private toCommand(
    dto: WagerRequestDto,
    headerIdempotencyKey?: string,
    correlationId?: string,
    causationId?: string,
  ): ProcessWagerCommand {
    const idempotencyKey =
      headerIdempotencyKey || `${dto.providerId}:${dto.externalTransactionId}`;
    if (idempotencyKey.length > 128) {
      throw new BadRequestException(
        'Idempotency-Key must not exceed 128 characters.',
      );
    }
    const payload = {
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    };
    const payloadHash = hashWagerPayload(payload);

    return {
      idempotencyKey,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      payloadHash,
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      correlationId:
        normalizeTraceId(correlationId, 'X-Correlation-Id') ?? randomUUID(),
      causationId: normalizeTraceId(causationId, 'X-Causation-Id'),
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    };
  }
}

function normalizeTraceId(
  value: string | undefined,
  headerName: string,
): string | undefined {
  const traceId = value?.trim();
  if (!traceId) return undefined;
  if (traceId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(traceId)) {
    throw new BadRequestException(
      `${headerName} must contain at most 128 safe identifier characters.`,
    );
  }
  return traceId;
}

@ApiTags('Reconciliation')
@Controller('wallets')
export class WalletReconciliationController {
  constructor(private readonly queries: WageringQueriesHandler) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile one wallet without changing balances' })
  @ApiParam({ name: 'walletId', description: 'Wallet identifier.', example: 'wallet-001' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Single-wallet reconciliation result.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Wallet not found.' })
  async reconcileWallet(@Param('walletId') walletId: string) {
    return this.queries.reconcileWallet(walletId);
  }
}
