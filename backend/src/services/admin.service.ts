import { createHash, randomBytes } from 'crypto';
import db from '../db/schema.js';
import { getTradeAuditTrail as getTradeAuditTrailRows, insertTradeAuditEvent } from '../db/audit-log.model.js';
import { logAuditEvent } from './audit.service.js';
import { callRefundOnChain } from './stellar.service.js';
import { escrowContractForTrade } from './escrowContract.js';
import { config } from '../config.js';
import { NotFoundError, ConflictError, ValidationError, UpstreamError } from '../utils/errors.js';

export interface AdminDisputeItem {
  id: string;
  trade_id: string;
  reported_by: string;
  reason: string;
  evidence_urls: string[];
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  trade: {
    id: string;
    amount_mxn: number;
    amount_stroops: string;
    platform_fee_mxn: number;
    status: string;
    secret_hash: string;
    lock_tx_hash: string | null;
    release_tx_hash: string | null;
    created_at: string;
    expires_at: string;
  } | null;
  parties: {
    buyer: { id: string; username: string; stellar_address: string; is_banned: boolean } | null;
    seller: { id: string; username: string; stellar_address: string; is_banned: boolean } | null;
    reporter: { id: string; username: string; stellar_address: string } | null;
  };
  evidence_and_messages: {
    evidence_urls: string[];
    audit_trail: any[];
  };
}

export interface ResolveDisputeInput {
  disputeIdOrTradeId: string;
  adminUserId: string;
  resolution: string;
  note?: string;
  banTarget?: string;
  outcome?: 'refund_buyer' | 'release_seller';
}

function parseEvidenceUrls(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return raw ? [raw] : [];
    }
  }
  return [];
}

const fallbackLogger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args),
};

export async function listAdminDisputes(
  status = 'open',
  page = 1,
  limit = 20,
): Promise<{ disputes: AdminDisputeItem[]; total: number; page: number; limit: number }> {
  let query = `
    SELECT id, trade_id, opener_id AS reported_by, reason, evidence_urls, status,
           resolution, resolution_note, resolved_by, resolved_at, created_at
    FROM trade_disputes
  `;
  const params: any[] = [];

  if (status !== 'all') {
    query += ' WHERE status = $1';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const rawDisputes = await db.getMany(query, params);
  const total = rawDisputes.length;

  const offset = (page - 1) * limit;
  const pagedDisputes = rawDisputes.slice(offset, offset + limit);

  const formattedDisputes: AdminDisputeItem[] = await Promise.all(
    pagedDisputes.map(async (d) => {
      const trade = await db.getOne(
        `SELECT id, amount_mxn, amount_stroops, platform_fee_mxn, status, secret_hash,
                lock_tx_hash, release_tx_hash, created_at, expires_at, seller_id, buyer_id
         FROM trades WHERE id = $1`,
        [d.trade_id],
      );

      let buyer = null;
      let seller = null;
      let reporter = null;

      if (trade) {
        buyer = await db.getOne(
          'SELECT id, username, stellar_address, COALESCE(is_banned, false) as is_banned FROM users WHERE id = $1',
          [trade.buyer_id],
        );
        seller = await db.getOne(
          'SELECT id, username, stellar_address, COALESCE(is_banned, false) as is_banned FROM users WHERE id = $1',
          [trade.seller_id],
        );
      }

      const reportedBy = d.reported_by || d.opener_id;

      if (reportedBy) {
        reporter = await db.getOne(
          'SELECT id, username, stellar_address FROM users WHERE id = $1',
          [reportedBy],
        );
      }

      const auditTrail = await getTradeAuditTrailRows(d.trade_id);
      const evidenceUrls = parseEvidenceUrls(d.evidence_urls);

      return {
        id: d.id,
        trade_id: d.trade_id,
        reported_by: reportedBy,
        reason: d.reason,
        evidence_urls: evidenceUrls,
        status: d.status,
        resolution: d.resolution ?? null,
        resolution_note: d.resolution_note ?? null,
        resolved_by: d.resolved_by ?? null,
        resolved_at: d.resolved_at ?? null,
        created_at: d.created_at,
        trade: trade ? {
          id: trade.id,
          amount_mxn: Number(trade.amount_mxn),
          amount_stroops: String(trade.amount_stroops),
          platform_fee_mxn: Number(trade.platform_fee_mxn),
          status: trade.status,
          secret_hash: trade.secret_hash,
          lock_tx_hash: trade.lock_tx_hash ?? null,
          release_tx_hash: trade.release_tx_hash ?? null,
          created_at: trade.created_at,
          expires_at: trade.expires_at,
        } : null,
        parties: {
          buyer: buyer ? {
            id: buyer.id,
            username: buyer.username || 'buyer',
            stellar_address: buyer.stellar_address || '',
            is_banned: Boolean(buyer.is_banned),
          } : null,
          seller: seller ? {
            id: seller.id,
            username: seller.username || 'seller',
            stellar_address: seller.stellar_address || '',
            is_banned: Boolean(seller.is_banned),
          } : null,
          reporter: reporter ? {
            id: reporter.id,
            username: reporter.username || 'user',
            stellar_address: reporter.stellar_address || '',
          } : null,
        },
        evidence_and_messages: {
          evidence_urls: evidenceUrls,
          audit_trail: auditTrail,
        },
      };
    }),
  );

  return {
    disputes: formattedDisputes,
    total,
    page,
    limit,
  };
}

export async function resolveAdminDispute(input: ResolveDisputeInput) {
  const { disputeIdOrTradeId, adminUserId, resolution, note = '', banTarget, outcome } = input;

  let dispute = await db.getOne<any>(
    `SELECT id, trade_id, opener_id AS reported_by, reason, evidence_urls, status,
            resolution, resolution_note, resolved_by, resolved_at, created_at
     FROM trade_disputes
     WHERE id = $1 OR trade_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [disputeIdOrTradeId],
  );

  if (!dispute) {
    throw new NotFoundError('DISPUTE_NOT_FOUND', 'La disputa no fue encontrada', 'Dispute not found');
  }

  if (dispute.status === 'resolved') {
    throw new ConflictError('DISPUTE_ALREADY_RESOLVED', 'La disputa ya ha sido resuelta', 'Dispute has already been resolved');
  }

  const trade = await db.getOne<any>('SELECT * FROM trades WHERE id = $1', [dispute.trade_id]);
  if (!trade) {
    throw new NotFoundError('TRADE_NOT_FOUND', 'El intercambio no fue encontrado', 'Trade not found');
  }

  let finalTradeStatus = 'refunded';
  let resolutionType = resolution;
  let bannedUserId: string | null = null;

  if (resolution === 'refund_buyer' || resolution === 'buyer_wins') {
    finalTradeStatus = 'refunded';
    resolutionType = 'refund_buyer';
  } else if (resolution === 'release_seller' || resolution === 'seller_wins') {
    finalTradeStatus = 'completed';
    resolutionType = 'release_seller';
  } else if (['ban_party', 'ban_buyer', 'ban_seller'].includes(resolution)) {
    let targetRole: 'buyer' | 'seller' = 'seller';

    if (resolution === 'ban_seller' || banTarget === 'seller' || banTarget === trade.seller_id) {
      targetRole = 'seller';
      bannedUserId = trade.seller_id;
    } else if (resolution === 'ban_buyer' || banTarget === 'buyer' || banTarget === trade.buyer_id) {
      targetRole = 'buyer';
      bannedUserId = trade.buyer_id;
    } else {
      bannedUserId = dispute.reported_by === trade.buyer_id ? trade.seller_id : trade.buyer_id;
      targetRole = bannedUserId === trade.seller_id ? 'seller' : 'buyer';
    }

    // Ban user account
    await db.execute('UPDATE users SET is_banned = true WHERE id = $1', [bannedUserId]);

    // Trade outcome when banning
    if (outcome === 'release_seller') {
      finalTradeStatus = 'completed';
    } else {
      finalTradeStatus = 'refunded';
    }
    resolutionType = `ban_${targetRole}`;
  } else {
    throw new ValidationError(
      'INVALID_RESOLUTION',
      'Resolución no válida',
      'Resolution must be refund_buyer, release_seller, or ban_party',
    );
  }

  // --- On-chain Execution ---
  let releaseTxHash: string | null = trade.release_tx_hash || null;

  if (!config.mockStellar && trade.secret_hash && !trade.secret_hash.startsWith('hash_test_')) {
    try {
      const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
      const tradeIdBytes = createHash('sha256').update(secretHashBytes).digest();
      const onChainResult = await callRefundOnChain({
        request: { log: fallbackLogger },
        contractId: escrowContractForTrade(trade),
        tradeIdBytes,
      });
      releaseTxHash = onChainResult.txHash;
    } catch (onChainErr: any) {
      throw new UpstreamError(
        'ON_CHAIN_RESOLUTION_FAILED',
        'Error al ejecutar la resolución en la blockchain.',
        `On-chain resolution error: ${onChainErr?.message || onChainErr}`,
      );
    }
  } else {
    releaseTxHash = resolutionType.includes('release') || finalTradeStatus === 'completed'
      ? `mock_release_${Date.now()}_${randomBytes(4).toString('hex')}`
      : `mock_refund_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  // Update dispute record in trade_disputes
  await db.execute(
    `UPDATE trade_disputes
     SET status = 'resolved',
         resolution = $1,
         resolution_note = $2,
         resolved_by = $3,
         resolved_at = NOW()
     WHERE id = $4`,
    [resolutionType, note, adminUserId, dispute.id],
  );

  // Update trade record — clear encrypted secret ONLY after on-chain call completes
  await db.execute(
    `UPDATE trades
     SET status = $1,
         release_tx_hash = COALESCE($2, release_tx_hash),
         completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
         secret_enc = NULL,
         secret_nonce = NULL
     WHERE id = $3`,
    [finalTradeStatus, releaseTxHash, trade.id],
  );

  // Record trade transition audit event
  await insertTradeAuditEvent({
    tradeId: trade.id,
    fromState: trade.status,
    toState: finalTradeStatus,
    actor: adminUserId,
    metadata: {
      resolution: resolutionType,
      dispute_id: dispute.id,
      resolution_note: note,
      banned_user_id: bannedUserId,
      release_tx_hash: releaseTxHash,
    },
  });

  // System audit log entry via audit.service.ts
  await logAuditEvent({
    action: 'DISPUTE_RESOLVED',
    actorUserId: adminUserId,
    entityType: 'dispute',
    entityId: dispute.id,
    details: {
      trade_id: trade.id,
      resolution: resolutionType,
      final_trade_status: finalTradeStatus,
      resolution_note: note,
      banned_user_id: bannedUserId,
      release_tx_hash: releaseTxHash,
    },
  });

  const updatedDispute = await db.getOne(
    `SELECT id, trade_id, opener_id AS reported_by, reason, evidence_urls, status,
            resolution, resolution_note, resolved_by, resolved_at, created_at
     FROM trade_disputes WHERE id = $1`,
    [dispute.id],
  );
  const updatedTrade = await db.getOne(
    'SELECT id, seller_id, buyer_id, amount_mxn, amount_stroops, status, release_tx_hash, created_at FROM trades WHERE id = $1',
    [trade.id],
  );

  return {
    dispute: updatedDispute,
    trade: updatedTrade,
    banned_user_id: bannedUserId,
  };
}
