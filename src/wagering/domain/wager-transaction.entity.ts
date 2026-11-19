import { Money } from '../../shared/domain/value-objects/money.js';
import { LedgerDirection } from './wallet-ledger-entry.entity.js';

export enum WagerTransactionKind {
    Opening = "OPENING",
    Bet = "BET",
    Win = "WIN",
    Loss = "LOSS",
    Refund = "REFUND",
    Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
    Pending = "PENDING",
    PendingReference = "PENDING_REFERENCE",
    Processed = "PROCESSED",
    Rejected = "REJECTED",
    Failed = "FAILED",
}

export enum FailureCode {
    InsufficientFunds = "INSUFFICIENT_FUNDS",
    ReferenceNotFound = "REFERENCE_NOT_FOUND",
    InvalidReferenceType = "INVALID_REFERENCE_TYPE",
    AlreadyReversed = "ALREADY_REVERSED",
    PayloadConflict = "PAYLOAD_CONFLICT",
    NegativeBalanceViolation = "NEGATIVE_BALANCE_VIOLATION",
    CurrencyMismatch = "CURRENCY_MISMATCH",
    InvalidAmount = "INVALID_AMOUNT",
}

export interface WagerTransactionState {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    amount: string;
    currency: string;
    referenceExternalTransactionId?: string;
    referenceTransactionId?: string;
    createdAt: Date | string;
    status: WagerTransactionStatus;
    failureCode?: FailureCode;
    processedAt?: Date | string;
}

export class WagerTransaction {
    private constructor(
        public readonly id: string,
        public readonly providerId: string,
        public readonly externalTransactionId: string,
        public readonly idempotencyKey: string,
        public readonly payloadHash: string,
        public readonly walletId: string,
        public readonly playerId: string,
        public readonly roundId: string,
        public readonly gameId: string,
        public readonly kind: WagerTransactionKind,
        public readonly money: Money,
        public readonly referenceExternalTransactionId: string | undefined,
        public readonly createdAt: Date,
        private _status: WagerTransactionStatus,
        private _referenceTransactionId?: string,
        private _failureCode?: FailureCode,
        private _processedAt?: Date,
    ) { }

    static create(props: {
        id: string;
        providerId: string;
        externalTransactionId: string;
        idempotencyKey: string;
        payloadHash: string;
        walletId: string;
        playerId: string;
        roundId: string;
        gameId: string;
        kind: WagerTransactionKind;
        money: Money;
        referenceExternalTransactionId?: string;
    }): WagerTransaction {
        if (props.kind === WagerTransactionKind.Opening) {
            throw new Error('OPENING transactions can only be created by wallet creation.');
        }
        if (!Object.values(WagerTransactionKind).includes(props.kind)) {
            throw new Error(`Unsupported transaction kind: ${props.kind}`);
        }
        if (!props.money.isPositive()) {
            throw new Error('Wager transactions require a positive amount.');
        }
        if ((props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) && !props.referenceExternalTransactionId) {
            throw new Error(`Transaction kind ${props.kind} requires a referenceExternalTransactionId.`);
        }

        return new WagerTransaction(
            props.id,
            props.providerId,
            props.externalTransactionId,
            props.idempotencyKey,
            props.payloadHash,
            props.walletId,
            props.playerId,
            props.roundId,
            props.gameId,
            props.kind,
            props.money,
            props.referenceExternalTransactionId,
            new Date(),
            WagerTransactionStatus.Pending,
        );
    }

    static createOpening(props: {
        id: string;
        walletId: string;
        playerId: string;
        money: Money;
    }): WagerTransaction {
        if (!props.money.isPositive()) {
            throw new Error('Opening transactions require a positive amount.');
        }

        return new WagerTransaction(
            props.id,
            'internal',
            props.walletId,
            `opening:${props.walletId}`,
            'internal-opening',
            props.walletId,
            props.playerId,
            'wallet-opening',
            'internal',
            WagerTransactionKind.Opening,
            props.money,
            undefined,
            new Date(),
            WagerTransactionStatus.Pending,
        );
    }

    static rehydrate(state: WagerTransactionState): WagerTransaction {
        return new WagerTransaction(
            state.id,
            state.providerId,
            state.externalTransactionId,
            state.idempotencyKey,
            state.payloadHash,
            state.walletId,
            state.playerId,
            state.roundId,
            state.gameId,
            state.kind,
            Money.from({ amount: state.amount, currency: state.currency }),
            state.referenceExternalTransactionId,
            state.createdAt instanceof Date ? state.createdAt : new Date(state.createdAt),
            state.status,
            state.referenceTransactionId,
            state.failureCode,
            state.processedAt
                ? state.processedAt instanceof Date
                    ? state.processedAt
                    : new Date(state.processedAt)
                : undefined,
        );
    }

    get status(): WagerTransactionStatus { return this._status; }
    get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
    get failureCode(): FailureCode | undefined { return this._failureCode; }
    get processedAt(): Date | undefined { return this._processedAt; }

    isTerminal(): boolean {
        return [
            WagerTransactionStatus.Processed,
            WagerTransactionStatus.Rejected,
            WagerTransactionStatus.Failed,
        ].includes(this._status);
    }

    affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }

    requiresReference(): boolean {
        return [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(this.kind);
    }

    ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
        switch (this.kind) {
            case WagerTransactionKind.Bet:
                return LedgerDirection.Debit;
            case WagerTransactionKind.Win:
            case WagerTransactionKind.Refund:
            case WagerTransactionKind.Opening:
                return LedgerDirection.Credit;
            case WagerTransactionKind.Rollback:
                if (!reference) {
                    throw new Error('ROLLBACK requires its referenced transaction.');
                }
                if (reference.kind === WagerTransactionKind.Bet) {
                    return LedgerDirection.Credit;
                }
                if (
                    reference.kind === WagerTransactionKind.Win ||
                    reference.kind === WagerTransactionKind.Refund
                ) {
                    return LedgerDirection.Debit;
                }
                throw new Error(`ROLLBACK cannot reverse ${reference.kind}.`);
            case WagerTransactionKind.Loss:
                return undefined;
        }
    }

    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    markProcessed(referenceTransactionId: string | undefined, at: Date = new Date()): void {
        if (this.isTerminal()) {
            throw new Error(`Cannot transition transaction ${this.id} from terminal state ${this._status}.`);
        }
        this._status = WagerTransactionStatus.Processed;
        this._referenceTransactionId = referenceTransactionId;
        this._processedAt = at;
    }

    markPendingReference(): void {
        if (this.isTerminal()) {
            throw new Error(`Cannot transition transaction ${this.id} from terminal state ${this._status}.`);
        }
        if (!this.requiresReference()) {
            throw new Error(`${this.kind} does not require a reference.`);
        }
        this._status = WagerTransactionStatus.PendingReference;
    }

    reject(code: FailureCode): void {
        if (this.isTerminal()) {
            throw new Error(`Cannot transition transaction ${this.id} from terminal state ${this._status}.`);
        }
        this._status = WagerTransactionStatus.Rejected;
        this._failureCode = code;
        this._processedAt = new Date();
    }

    fail(code: FailureCode): void {
        if (this.isTerminal()) {
            throw new Error(`Cannot transition transaction ${this.id} from terminal state ${this._status}.`);
        }
        this._status = WagerTransactionStatus.Failed;
        this._failureCode = code;
        this._processedAt = new Date();
    }
}