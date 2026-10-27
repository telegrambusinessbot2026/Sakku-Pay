/* ==============================================================================
   SakkuPay — Payment Lifecycle & Reconciliation State Machine
   Guarantees:
   1. Explicit, validated transaction state transitions.
   2. Terminal status lock on settled payments (success cannot be overwritten).
   3. Strict avoidance of ambiguous amount-only matching.
   4. Duplicate UTR detection and collision prevention.
   5. Structured audit logs and reconciliation diagnostic tracking.
   ============================================================================== */
'use strict';

const crypto = require('node:crypto');

// Permitted state transitions
const VALID_TRANSITIONS = {
  'pending': new Set(['pending', 'success', 'failed', 'under_review', 'expired']),
  'under_review': new Set(['under_review', 'success', 'failed', 'expired', 'pending']),
  'failed': new Set(['failed']),
  'success': new Set(['success']), // TERMINAL! Once success, never reverts
  'expired': new Set(['expired'])
};

// Reconciliation Statuses
const RECON_STATUS = {
  UNRECONCILED: 'unreconciled',
  SETTLED: 'settled',
  FLAGGED_AMBIGUOUS: 'flagged_ambiguous',
  DUPLICATE_UTR: 'duplicate_utr',
  UNVERIFIED_EVIDENCE: 'unverified_evidence'
};

/**
 * Validates if a state transition from `fromStatus` to `toStatus` is permitted.
 */
function isValidTransition(fromStatus, toStatus) {
  if (!fromStatus) return toStatus === 'pending';
  const allowed = VALID_TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.has(toStatus);
}

/**
 * Safely appends an audit event to a transaction's audit log.
 * Sanitizes entries and bounds log length to prevent unbounded growth.
 * Supports both appendAuditLog(log, eventObject) and appendAuditLog(log, actionString, detailsOrObject).
 */
function appendAuditLog(existingLogJson, actionOrEvent, maybeDetails) {
  let log = [];
  if (existingLogJson) {
    try {
      const parsed = typeof existingLogJson === 'string' ? JSON.parse(existingLogJson) : existingLogJson;
      if (Array.isArray(parsed)) log = parsed;
    } catch (_) {}
  }

  let event = {};
  if (typeof actionOrEvent === 'string') {
    if (typeof maybeDetails === 'object' && maybeDetails !== null) {
      event = { action: actionOrEvent, ...maybeDetails };
    } else {
      event = { action: actionOrEvent, details: maybeDetails ? String(maybeDetails) : '' };
    }
  } else if (typeof actionOrEvent === 'object' && actionOrEvent !== null) {
    event = actionOrEvent;
  }

  // Sanitize: ensure no secrets or sensitive auth tokens are logged
  const sanitized = {
    timestamp: event.timestamp || new Date().toISOString(),
    action: String(event.action || 'state_update').slice(0, 100),
    fromStatus: event.fromStatus || null,
    toStatus: event.toStatus || null,
    reconciliationStatus: event.reconciliationStatus || null,
    source: String(event.source || 'system').slice(0, 50),
    details: String(event.details || '').slice(0, 300)
  };

  if (event.providerReference) {
    sanitized.providerReference = String(event.providerReference).slice(0, 50);
  }
  if (event.utr) {
    sanitized.utr = String(event.utr).slice(0, 30);
  }
  if (event.ambiguityReason) {
    sanitized.ambiguityReason = String(event.ambiguityReason).slice(0, 200);
  }

  log.push(sanitized);

  // Keep last 30 events maximum
  if (log.length > 30) {
    log = log.slice(-30);
  }

  return JSON.stringify(log);
}

/**
 * Reconciles an incoming Android Companion verification event.
 * Avoids ambiguous auto-confirmation when multiple pending orders match.
 * Detects duplicate UTR replays.
 */
function reconcileCompanionPayment({
  repository,
  merchantId,
  amount,
  utr,
  customerUpi,
  timestamp
}) {
  const sanitizedUtr = String(utr || '').trim().replace(/[^a-zA-Z0-9]/g, '');
  const rawUtr = String(utr || '').trim();
  const parsedAmount = Number(amount);
  const eventTime = timestamp && !isNaN(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : new Date().toISOString();

  // 1. Check for Duplicate UTR in already settled transactions
  const settledWithUtr = repository.transactions.findByUtr(merchantId, sanitizedUtr) || (rawUtr ? repository.transactions.findByUtr(merchantId, rawUtr) : null);
  if (settledWithUtr && settledWithUtr.status === 'success') {
    return {
      success: true,
      verified: true,
      duplicate: true,
      status: 'success',
      transaction: settledWithUtr,
      message: 'Payment with this UTR has already been verified and settled.'
    };
  }

  // 2. Fetch all pending transactions for this merchant
  const pendingList = repository.transactions.findPendingForCompanion(merchantId);

  // 3. Attempt match by exact UTR pre-submitted by customer
  const exactUtrMatches = pendingList.filter(t => t.utr && (
    t.utr === sanitizedUtr ||
    t.utr === rawUtr ||
    String(t.utr).replace(/[^a-zA-Z0-9]/g, '') === sanitizedUtr
  ));
  if (exactUtrMatches.length === 1) {
    const candidate = exactUtrMatches[0];

    // Verify amount matches candidate order
    if (Math.abs(candidate.amount - parsedAmount) > 0.01) {
      // Conflicting amount for same UTR: Flag for manual review!
      const updated = repository.transactions.update(candidate.id, {
        reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
        ambiguityReason: `Amount mismatch: expected ₹${candidate.amount}, received ₹${parsedAmount}`,
        auditLog: appendAuditLog(candidate.auditLog, {
          action: 'ambiguous_amount_mismatch',
          fromStatus: candidate.status,
          toStatus: candidate.status,
          reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
          source: 'android-companion',
          utr: sanitizedUtr,
          details: `Incoming payment ₹${parsedAmount} differs from order amount ₹${candidate.amount}`
        })
      });
      return {
        success: false,
        verified: false,
        ambiguous: true,
        reason: 'amount_mismatch',
        transaction: updated,
        message: `Amount mismatch for UTR ${sanitizedUtr}. Expected ₹${candidate.amount}, received ₹${parsedAmount}. Kept pending and flagged for review.`
      };
    }

    // Exact UTR match with matching amount: Safe to confirm
    const updated = repository.transactions.update(candidate.id, {
      status: 'success',
      utr: sanitizedUtr,
      paidAt: eventTime,
      verifiedAt: eventTime,
      verifiedBy: 'android-companion',
      reconciliationStatus: RECON_STATUS.SETTLED,
      ambiguityReason: null,
      customerUpi: (customerUpi && !candidate.customerUpi) ? customerUpi : candidate.customerUpi,
      auditLog: appendAuditLog(candidate.auditLog, {
        action: 'settled_by_exact_utr',
        fromStatus: candidate.status,
        toStatus: 'success',
        reconciliationStatus: RECON_STATUS.SETTLED,
        source: 'android-companion',
        utr: sanitizedUtr,
        details: 'Payment settled via verified UTR match from Android Companion.'
      })
    });

    return {
      success: true,
      verified: true,
      matched: true,
      transaction: updated
    };
  }

  // 4. If multiple pending orders share this exact pre-submitted UTR (suspicious collision):
  if (exactUtrMatches.length > 1) {
    for (const c of exactUtrMatches) {
      repository.transactions.update(c.id, {
        reconciliationStatus: RECON_STATUS.DUPLICATE_UTR,
        ambiguityReason: `Duplicate UTR ${sanitizedUtr} pre-submitted across multiple orders (${exactUtrMatches.map(x => x.reference).join(', ')})`,
        auditLog: appendAuditLog(c.auditLog, {
          action: 'duplicate_utr_collision',
          fromStatus: c.status,
          toStatus: c.status,
          reconciliationStatus: RECON_STATUS.DUPLICATE_UTR,
          source: 'android-companion',
          utr: sanitizedUtr,
          details: `Collision: UTR ${sanitizedUtr} claimed by multiple orders.`
        })
      });
    }

    return {
      success: false,
      verified: false,
      ambiguous: true,
      reason: 'duplicate_utr_collision',
      message: `Duplicate UTR collision: ${sanitizedUtr} is claimed by multiple pending orders. Flagged for review.`
    };
  }

  // 5. Amount-only fallback within 30-minute window
  const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
  const amountMatches = pendingList.filter(t =>
    Math.abs(t.amount - parsedAmount) < 0.01 &&
    new Date(t.createdAt).getTime() >= thirtyMinsAgo &&
    (!t.utr || t.utr === sanitizedUtr) // Not already bound to an incompatible UTR
  );

  // AMBIGUITY GUARD: If multiple pending orders match this amount, DO NOT CONFIRM!
  if (amountMatches.length > 1) {
    for (const c of amountMatches) {
      repository.transactions.update(c.id, {
        reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
        ambiguityReason: `Ambiguous match: multiple pending orders (${amountMatches.map(x => x.reference).join(', ')}) with identical amount ₹${parsedAmount}`,
        auditLog: appendAuditLog(c.auditLog, {
          action: 'flagged_multiple_amount_candidates',
          fromStatus: c.status,
          toStatus: c.status,
          reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
          source: 'android-companion',
          utr: sanitizedUtr,
          details: `Payment ₹${parsedAmount} received without order reference while ${amountMatches.length} pending orders qualify.`
        })
      });
    }

    return {
      success: false,
      verified: false,
      ambiguous: true,
      reason: 'multiple_amount_candidates',
      candidateCount: amountMatches.length,
      candidateReferences: amountMatches.map(x => x.reference),
      message: `Ambiguous payment: ${amountMatches.length} pending orders found for ₹${parsedAmount}. Transactions kept pending and flagged for manual review.`
    };
  }

  // Exactly 1 qualifying candidate: Safe amount-based match
  if (amountMatches.length === 1) {
    const candidate = amountMatches[0];
    const updated = repository.transactions.update(candidate.id, {
      status: 'success',
      utr: sanitizedUtr,
      paidAt: eventTime,
      verifiedAt: eventTime,
      verifiedBy: 'android-companion',
      reconciliationStatus: RECON_STATUS.SETTLED,
      ambiguityReason: null,
      customerUpi: (customerUpi && !candidate.customerUpi) ? customerUpi : candidate.customerUpi,
      auditLog: appendAuditLog(candidate.auditLog, {
        action: 'settled_by_unique_amount_match',
        fromStatus: candidate.status,
        toStatus: 'success',
        reconciliationStatus: RECON_STATUS.SETTLED,
        source: 'android-companion',
        utr: sanitizedUtr,
        details: `Payment settled by unique ₹${parsedAmount} candidate within 30-min window.`
      })
    });

    return {
      success: true,
      verified: true,
      matched: true,
      transaction: updated
    };
  }

  // 6. Direct Payment (No pending order candidate found)
  // Create direct transaction record without misattributing to unrelated orders
  const directTx = {
    id: `txn_${crypto.randomBytes(8).toString('hex')}`,
    merchantId,
    reference: 'SP' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    customerName: customerUpi ? customerUpi.split('@')[0] : 'UPI Customer',
    customerEmail: '',
    amount: parsedAmount,
    status: 'success',
    utr: sanitizedUtr,
    customerUpi,
    paidAt: eventTime,
    verifiedAt: eventTime,
    verifiedBy: 'android-companion',
    reconciliationStatus: RECON_STATUS.SETTLED,
    ambiguityReason: null,
    createdAt: new Date().toISOString(),
    auditLog: appendAuditLog(null, {
      action: 'direct_companion_payment',
      fromStatus: null,
      toStatus: 'success',
      reconciliationStatus: RECON_STATUS.SETTLED,
      source: 'android-companion',
      utr: sanitizedUtr,
      details: 'Direct payment recorded from Android Companion alert (no pending order was open).'
    })
  };

  const created = repository.transactions.create(directTx);
  return {
    success: true,
    verified: true,
    matched: false,
    direct: true,
    transaction: created
  };
}

/**
 * Reconciles an authoritative webhook from PhonePe or Paytm.
 * Prevents out-of-order stale events from reverting terminal 'success' status.
 */
function reconcileProviderWebhook({
  repository,
  tx,
  isSuccess,
  provider,
  providerRef,
  utr
}) {
  const now = new Date().toISOString();
  const targetStatus = isSuccess ? 'success' : 'failed';

  // 1. Terminal State Guard: Once success, NEVER revert to failed or pending!
  if (tx.status === 'success') {
    if (targetStatus === 'success') {
      // Idempotent retry of success event
      return {
        success: true,
        verified: true,
        duplicate: true,
        status: 'success',
        transaction: tx,
        message: 'Duplicate provider confirmation received. Transaction already settled.'
      };
    } else {
      // Stale / out-of-order failure event arriving after payment already succeeded
      const updatedLog = appendAuditLog(tx.auditLog, {
        action: 'stale_failure_event_rejected',
        fromStatus: tx.status,
        toStatus: tx.status,
        source: `${provider}-direct`,
        providerReference: providerRef,
        details: `Out-of-order ${provider} failure notification was rejected because transaction is already permanently settled.`
      });
      const updated = repository.transactions.update(tx.id, { auditLog: updatedLog });

      return {
        success: true,
        verified: true,
        staleEventRejected: true,
        status: 'success',
        transaction: updated,
        message: 'Stale failure event rejected. Prior settlement preserved.'
      };
    }
  }

  // 2. Validate state transition
  if (!isValidTransition(tx.status, targetStatus)) {
    const updatedLog = appendAuditLog(tx.auditLog, {
      action: 'invalid_transition_rejected',
      fromStatus: tx.status,
      toStatus: targetStatus,
      source: `${provider}-direct`,
      providerReference: providerRef,
      details: `Illegal state transition from ${tx.status} to ${targetStatus} rejected.`
    });
    const updated = repository.transactions.update(tx.id, { auditLog: updatedLog });

    return {
      success: false,
      error: `Invalid transaction state transition from ${tx.status} to ${targetStatus}`,
      transaction: updated
    };
  }

  // 3. Apply state transition
  if (isSuccess) {
    const finalUtr = utr || providerRef || tx.utr || (provider === 'phonepe' ? 'PP' : 'PTM') + crypto.randomBytes(4).toString('hex').toUpperCase();
    const updated = repository.transactions.update(tx.id, {
      status: 'success',
      verifiedBy: `${provider}-direct`,
      providerReference: providerRef || null,
      utr: finalUtr,
      paidAt: tx.paidAt || now,
      verifiedAt: now,
      reconciliationStatus: RECON_STATUS.SETTLED,
      ambiguityReason: null,
      auditLog: appendAuditLog(tx.auditLog, {
        action: 'settled_by_provider_webhook',
        fromStatus: tx.status,
        toStatus: 'success',
        reconciliationStatus: RECON_STATUS.SETTLED,
        source: `${provider}-direct`,
        providerReference: providerRef,
        utr: finalUtr,
        details: `Cryptographically verified ${provider} webhook confirmed settlement.`
      })
    });

    return {
      success: true,
      verified: true,
      transaction: updated
    };
  } else {
    const updated = repository.transactions.update(tx.id, {
      status: 'failed',
      verifiedBy: `${provider}-direct`,
      providerReference: providerRef || null,
      reconciliationStatus: RECON_STATUS.UNRECONCILED,
      auditLog: appendAuditLog(tx.auditLog, {
        action: 'failed_by_provider_webhook',
        fromStatus: tx.status,
        toStatus: 'failed',
        source: `${provider}-direct`,
        providerReference: providerRef,
        details: `Authoritative ${provider} webhook reported payment failure.`
      })
    });

    return {
      success: true,
      verified: true,
      status: 'failed',
      transaction: updated
    };
  }
}

module.exports = {
  VALID_TRANSITIONS,
  RECON_STATUS,
  isValidTransition,
  appendAuditLog,
  reconcileCompanionPayment,
  reconcileProviderWebhook
};
