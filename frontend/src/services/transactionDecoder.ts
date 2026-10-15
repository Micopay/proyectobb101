import { TransactionBuilder, Operation, Asset, Networks, Transaction } from '@stellar/stellar-sdk';

export interface DecodedPaymentDetails {
  type: 'payment';
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  destination: string;
  memo?: string;
  sourceAccount?: string;
}

export interface DecodedUnsupportedDetails {
  type: 'unsupported';
  operationTypes: string[];
  memo?: string;
  sourceAccount?: string;
  warningKey: string;
}

export interface DecodedUnknownDetails {
  type: 'unknown';
  error: string;
  warningKey: string;
}

export type DecodedTransaction =
  | DecodedPaymentDetails
  | DecodedUnsupportedDetails
  | DecodedUnknownDetails;

/**
 * Safely decodes an unsigned Stellar transaction XDR.
 * Returns structured human-readable transaction details if it can be parsed.
 * Defaults to 'unknown' or 'unsupported' with security warning keys if decoding fails or isn't a simple payment.
 */
export function decodeTransactionXdr(
  xdr: string,
  networkPassphrase: string = Networks.TESTNET
): DecodedTransaction {
  if (!xdr || typeof xdr !== 'string' || !xdr.trim()) {
    return {
      type: 'unknown',
      error: 'Empty or invalid XDR string',
      warningKey: 'signatureApproval.warnings.invalidXdr',
    };
  }

  try {
    const parsedTx = TransactionBuilder.fromXDR(xdr.trim(), networkPassphrase);

    if (!(parsedTx instanceof Transaction)) {
      return {
        type: 'unsupported',
        operationTypes: ['FeeBumpTransaction'],
        warningKey: 'signatureApproval.warnings.unsupportedOperations',
      };
    }

    const tx = parsedTx as Transaction;
    
    // Extract optional memo
    let memo: string | undefined;
    if (tx.memo) {
      if (tx.memo.type === 'text' && tx.memo.value) {
        memo = tx.memo.value.toString();
      } else if (tx.memo.type === 'id' && tx.memo.value) {
        memo = tx.memo.value.toString();
      } else if (tx.memo.type === 'hash' && tx.memo.value) {
        memo = (tx.memo.value as Buffer).toString('hex');
      }
    }

    const sourceAccount = tx.source;
    const operations = tx.operations;

    if (!operations || operations.length === 0) {
      return {
        type: 'unknown',
        error: 'Transaction contains no operations',
        warningKey: 'signatureApproval.warnings.emptyOperations',
      };
    }

    // Check if it's a single payment operation
    if (operations.length === 1 && operations[0].type === 'payment') {
      const paymentOp = operations[0] as Operation.Payment;
      
      let assetCode = 'XLM';
      let assetIssuer: string | undefined;

      if (paymentOp.asset) {
        if (paymentOp.asset.isNative()) {
          assetCode = 'XLM';
        } else {
          assetCode = paymentOp.asset.getCode();
          assetIssuer = paymentOp.asset.getIssuer();
        }
      }

      return {
        type: 'payment',
        amount: paymentOp.amount,
        assetCode,
        assetIssuer,
        destination: paymentOp.destination,
        memo,
        sourceAccount,
      };
    }

    // If multiple operations or non-payment operations
    const opTypes = operations.map((op) => op.type);
    return {
      type: 'unsupported',
      operationTypes: opTypes,
      memo,
      sourceAccount,
      warningKey: 'signatureApproval.warnings.unsupportedOperations',
    };
  } catch (err: any) {
    return {
      type: 'unknown',
      error: err?.message || 'Failed to parse transaction XDR',
      warningKey: 'signatureApproval.warnings.failedToDecode',
    };
  }
}
