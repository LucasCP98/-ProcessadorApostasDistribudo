import { Type } from 'class-transformer';
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
  @IsString()
  @Matches(/^\d{1,13}(?:\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;
}

export class WagerRequestDto {
  @IsString()
  @Length(1, 64)
  providerId!: string;

  @IsString()
  @Length(1, 128)
  externalTransactionId!: string;

  @IsString()
  @Length(1, 64)
  playerId!: string;

  @IsString()
  @Length(1, 36)
  walletId!: string;

  @IsString()
  @Length(1, 128)
  roundId!: string;

  @IsString()
  @Length(1, 128)
  gameId!: string;

  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

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
  @IsString()
  @Length(1, 64)
  playerId!: string;

  @IsString()
  @Matches(/^\d{1,13}(?:\.\d{1,2})?$/)
  initialBalance!: string;

  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;
}

export class ReconciliationDto {
  @IsOptional()
  @IsString()
  @Length(1, 36)
  walletId?: string;
}

export class LedgerQueryDto {
  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  offset?: string;
}
