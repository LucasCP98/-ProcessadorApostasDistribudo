import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../../domain/wager-transaction.entity.js';

export class MoneyDto {
  @ApiProperty({
    description: 'Decimal monetary amount with at most two fractional digits.',
    example: '100.50',
    pattern: '^\\d{1,13}(?:\\.\\d{1,2})?$',
  })
  @IsString()
  @Matches(/^\d{1,13}(?:\.\d{1,2})?$/)
  amount!: string;

  @ApiProperty({
    description: 'Three-letter currency code.',
    example: 'BRL',
    pattern: '^[A-Za-z]{3}$',
  })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;
}

export class WagerRequestDto {
  @ApiProperty({ example: 'provider-a', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  providerId!: string;

  @ApiProperty({ example: 'external-transaction-001', maxLength: 128 })
  @IsString()
  @Length(1, 128)
  externalTransactionId!: string;

  @ApiProperty({ example: 'player-001', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  playerId!: string;

  @ApiProperty({ example: 'wallet-001', maxLength: 36 })
  @IsString()
  @Length(1, 36)
  walletId!: string;

  @ApiProperty({ example: 'round-001', maxLength: 128 })
  @IsString()
  @Length(1, 128)
  roundId!: string;

  @ApiProperty({ example: 'game-001', maxLength: 128 })
  @IsString()
  @Length(1, 128)
  gameId!: string;

  @ApiProperty({
    enum: [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ],
    example: WagerTransactionKind.Bet,
  })
  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @ApiProperty({ type: () => MoneyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiPropertyOptional({
    description:
      'Required for REFUND and ROLLBACK; identifies the referenced external transaction.',
    example: 'external-transaction-001',
    maxLength: 128,
  })
  @ValidateIf(
    (dto: WagerRequestDto) =>
      dto.kind === WagerTransactionKind.Refund ||
      dto.kind === WagerTransactionKind.Rollback,
  )
  @IsString()
  @Length(1, 128)
  referenceExternalTransactionId?: string;
}

export class CreateWalletDto {
  @ApiProperty({ example: 'player-001', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  playerId!: string;

  @ApiProperty({
    description: 'Initial decimal balance with at most two fractional digits.',
    example: '100.00',
    pattern: '^\\d{1,13}(?:\\.\\d{1,2})?$',
  })
  @IsString()
  @Matches(/^\d{1,13}(?:\.\d{1,2})?$/)
  initialBalance!: string;

  @ApiProperty({
    description: 'Three-letter currency code.',
    example: 'BRL',
    pattern: '^[A-Za-z]{3}$',
  })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;
}

export class ReconciliationDto {
  @ApiPropertyOptional({
    description: 'Optional wallet ID to reconcile; omit to reconcile every wallet.',
    example: 'wallet-001',
    maxLength: 36,
  })
  @IsOptional()
  @IsString()
  @Length(1, 36)
  walletId?: string;
}

export class LedgerQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum number of entries to return.',
    example: '100',
    default: '100',
  })
  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;

  @ApiPropertyOptional({
    description: 'Number of entries to skip.',
    example: '0',
    default: '0',
  })
  @IsOptional()
  @Matches(/^\d{1,6}$/)
  offset?: string;
}
