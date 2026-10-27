/* ==============================================================================
   SakkuPay Milestone 3 — Payment Lifecycle & Reconciliation Hardening Test Suite
   ============================================================================== */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const {
  server,
  repository: serverRepo,
  encryptToken,
  token,
  adminToken,
  VALID_TRANSITIONS,
  RECON_STATUS,
  isValidTransition,
  appendAuditLog,
  reconcileCompanionPayment,
  reconcileProviderWebhook,
  verifyPaytmChecksum
} = require('./server');

let passedTests = 0;
let failedTests = 0;
const results = [];

function assert(condition, message) {
  if (!condition) {
    failedTests++;
    results.push({ name: message, status: 'FAILED' });
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passedTests++;
    results.push({ name: message, status: 'PASSED' });
    console.log(`  ✅ PASSED: ${message}`);
  }
}

async function request(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  const headers = { ...(options.headers || {}) };
  let body = options.body;

  if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const res = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: body || undefined
  });

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => '');
  }

  return {
    status: res.status,
    headers: res.headers,
    data
  };
}

// Compute official Paytm Checksum for tests
function calculatePaytmChecksum(params, key) {
  const sortedKeys = Object.keys(params).filter(k => k !== 'CHECKSUMHASH').sort();
  const paramStr = sortedKeys.map(k => `${k}=${params[k]}`).join('|');
  return crypto.createHmac('sha256', key).update(paramStr).digest('hex');
}

async function runMilestone3Tests() {
  console.log('==============================================================================');
  console.log('SakkuPay Milestone 3: Payment Lifecycle & Reconciliation Hardening Test Suite');
  console.log('==============================================================================');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 1: STATE MACHINE & TRANSITION MATRIX
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 1: State Machine & Permitted/Forbidden Transitions ---');

  // Permitted initial & progression transitions
  assert(isValidTransition(null, 'pending') === true, 'Initial transition to pending is allowed');
  assert(isValidTransition('pending', 'success') === true, 'Transition pending -> success is allowed');
  assert(isValidTransition('pending', 'failed') === true, 'Transition pending -> failed is allowed');
  assert(isValidTransition('pending', 'under_review') === true, 'Transition pending -> under_review is allowed');
  assert(isValidTransition('pending', 'expired') === true, 'Transition pending -> expired is allowed');
  assert(isValidTransition('under_review', 'success') === true, 'Transition under_review -> success is allowed');
  assert(isValidTransition('under_review', 'failed') === true, 'Transition under_review -> failed is allowed');
  assert(isValidTransition('under_review', 'expired') === true, 'Transition under_review -> expired is allowed');

  // Forbidden terminal mutations (Terminal State Lock)
  assert(isValidTransition('success', 'failed') === false, 'TERMINAL LOCK: Transition success -> failed is strictly forbidden');
  assert(isValidTransition('success', 'pending') === false, 'TERMINAL LOCK: Transition success -> pending is strictly forbidden');
  assert(isValidTransition('success', 'expired') === false, 'TERMINAL LOCK: Transition success -> expired is strictly forbidden');
  assert(isValidTransition('success', 'under_review') === false, 'TERMINAL LOCK: Transition success -> under_review is strictly forbidden');

  assert(isValidTransition('failed', 'success') === false, 'TERMINAL LOCK: Transition failed -> success is forbidden');
  assert(isValidTransition('failed', 'pending') === false, 'TERMINAL LOCK: Transition failed -> pending is forbidden');
  assert(isValidTransition('expired', 'success') === false, 'TERMINAL LOCK: Transition expired -> success is forbidden');
  assert(isValidTransition('expired', 'pending') === false, 'TERMINAL LOCK: Transition expired -> pending is forbidden');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 2: AUDIT LOG LENGTH BOUNDING & SECRET SANITIZATION
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 2: Audit Log Length Bounding & Secret Sanitization ---');

  let testLog = appendAuditLog(null, {
    action: 'init_test',
    fromStatus: null,
    toStatus: 'pending',
    reconciliationStatus: RECON_STATUS.UNRECONCILED,
    source: 'test-runner',
    details: 'Initial order created'
  });

  const parsedLog1 = JSON.parse(testLog);
  assert(Array.isArray(parsedLog1) && parsedLog1.length === 1, 'Audit log initialized as valid JSON array of 1 item');
  assert(parsedLog1[0].action === 'init_test', 'Action string correctly recorded in audit log');
  assert(Boolean(parsedLog1[0].timestamp), 'Timestamp automatically attached to audit event');

  // Append 40 events to verify capping at 30
  for (let i = 0; i < 40; i++) {
    testLog = appendAuditLog(testLog, {
      action: `event_${i}`,
      details: `Detail message ${i}`,
      secretToken: 'SUPER_SECRET_TOKEN_DO_NOT_LOG', // should be excluded
      saltKey: 'PHONEPE_SALT_DO_NOT_LOG'           // should be excluded
    });
  }

  const parsedLogCapped = JSON.parse(testLog);
  assert(parsedLogCapped.length === 30, `Audit log correctly capped at 30 items (actual: ${parsedLogCapped.length})`);
  assert(parsedLogCapped[29].action === 'event_39', 'Most recent audit event is preserved in bounded log');
  assert(!parsedLogCapped[29].secretToken, 'Sensitive secret token excluded from sanitized audit log');
  assert(!parsedLogCapped[29].saltKey, 'Sensitive salt key excluded from sanitized audit log');

  /* ────────────────────────────────────────────────────────────────────────────
     LIVE SERVER INTEGRATION TESTS SETUP
     ──────────────────────────────────────────────────────────────────────────── */
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\nLive HTTP test server running at ${baseUrl}`);

  try {
    // Setup test merchant
    const merchantId = 'mer_m3_test';
    serverRepo.merchants.delete(merchantId);
    const m3Merchant = serverRepo.merchants.create({
      id: merchantId,
      email: 'm3_test@sakkupay.in',
      businessName: 'M3 Reconciliation Test Store',
      supportEmail: 'm3_test@sakkupay.in'
    });
    const merchantJwt = token(m3Merchant);
    const adminJwt = adminToken('admin_user_m3');

    // Setup Companion API Key
    const apiKeyPlain = 'sk_live_m3_companion_test_key_12345';
    const apiKeyHash = crypto.createHash('sha256').update(apiKeyPlain).digest('hex');
    serverRepo.apiKeys.create({
      id: 'key_m3_companion',
      merchantId,
      name: 'M3 Test Companion Key',
      prefix: apiKeyPlain.slice(0, 12),
      hash: apiKeyHash
    });

    // Setup PhonePe Business Account
    const phonePeMid = 'PHONEPE_M3_MID';
    const phonePeSalt = 'm3_phonepe_salt_secret_1234567890';
    serverRepo.businessAccounts.create({
      id: 'biz_m3_phonepe',
      merchantId,
      provider: 'phonepe',
      accountName: 'PhonePe M3',
      phoneNumber: '9876543210',
      merchantIdRef: phonePeMid,
      token: encryptToken(phonePeSalt),
      saltIndex: '1',
      status: 'connected'
    });

    // Setup Paytm Business Account
    const paytmMid = 'PAYTM_M3_MID';
    const paytmKey = '1234567890123456';
    serverRepo.businessAccounts.create({
      id: 'biz_m3_paytm',
      merchantId,
      provider: 'paytm',
      accountName: 'Paytm M3',
      phoneNumber: '9876543210',
      merchantIdRef: paytmMid,
      token: encryptToken(paytmKey),
      status: 'connected'
    });

    // Setup Payment Link
    const upiAcc = serverRepo.upis.create({
      id: 'upi_m3',
      merchantId,
      upiId: 'm3test@upi',
      label: 'M3 Test UPI',
      is_default: 1
    });
    const paymentLink = serverRepo.links.create({
      id: 'lnk_m3_checkout',
      merchantId,
      upiId: upiAcc.upiId,
      name: 'M3 Checkout Link',
      slug: 'm3-pay-test',
      amount: 499.00,
      amountType: 'fixed',
      active: true
    });

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 3: TERMINAL STATE LOCK & OUT-OF-ORDER WEBHOOK DELIVERY
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 3: Terminal State Lock & Out-of-Order Webhook Delivery ---');

    // Create pending transaction for PhonePe webhook test
    const txPhonePe = serverRepo.transactions.create({
      id: 'txn_m3_terminal_pp',
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_PP_TERM',
      amount: 500,
      status: 'pending'
    });

    // 1. Authoritative PhonePe payment success delivery
    const ppSuccessPayload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: {
          merchantId: phonePeMid,
          merchantTransactionId: txPhonePe.reference,
          transactionId: 'PP_REF_SUCCESS_111',
          amount: 50000
        }
      })).toString('base64')
    };
    const ppSuccessXVerify = crypto.createHash('sha256').update(ppSuccessPayload.response + phonePeSalt).digest('hex') + '###1';

    const ppRes1 = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': ppSuccessXVerify },
      body: ppSuccessPayload
    });

    assert(ppRes1.status === 200, 'Initial PhonePe success webhook returns HTTP 200');
    assert(ppRes1.data.verified === true, 'PhonePe webhook marks verified: true');
    const txAfterPpSuccess = serverRepo.transactions.findById(txPhonePe.id);
    assert(txAfterPpSuccess.status === 'success', 'Transaction transitioned to success');
    assert(txAfterPpSuccess.reconciliationStatus === RECON_STATUS.SETTLED, 'Transaction reconciliationStatus set to settled');
    assert(Boolean(txAfterPpSuccess.verifiedAt), 'Transaction recorded verifiedAt timestamp');

    // 2. Out-of-order delayed failure webhook arrives for the SAME settled transaction
    const ppDelayedFailPayload = {
      response: Buffer.from(JSON.stringify({
        success: false,
        code: 'PAYMENT_ERROR',
        data: {
          merchantId: phonePeMid,
          merchantTransactionId: txPhonePe.reference,
          transactionId: 'PP_REF_STALE_FAIL',
          amount: 50000
        }
      })).toString('base64')
    };
    const ppFailXVerify = crypto.createHash('sha256').update(ppDelayedFailPayload.response + phonePeSalt).digest('hex') + '###1';

    const ppRes2 = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': ppFailXVerify },
      body: ppDelayedFailPayload
    });

    assert(ppRes2.status === 200, 'Out-of-order PhonePe failure returns HTTP 200 (graceful acknowledgement)');
    assert(ppRes2.data.staleEventRejected === true, 'Response indicates stale failure event was rejected');
    const txAfterPpStale = serverRepo.transactions.findById(txPhonePe.id);
    assert(txAfterPpStale.status === 'success', 'TERMINAL LOCK: Transaction status remains success (never reverted to failed)');
    assert(txAfterPpStale.reconciliationStatus === RECON_STATUS.SETTLED, 'Reconciliation status remains settled');
    const ppAuditParsed = JSON.parse(txAfterPpStale.auditLog);
    const stalePpEvent = ppAuditParsed.find(e => e.action === 'stale_failure_event_rejected');
    assert(Boolean(stalePpEvent), 'Audit log records stale_failure_event_rejected with diagnostic details');

    // 3. Repeat for Paytm: Success then out-of-order failure
    const txPaytm = serverRepo.transactions.create({
      id: 'txn_m3_terminal_ptm',
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_PTM_TERM',
      amount: 300,
      status: 'pending'
    });

    const ptmSuccessParams = {
      MID: paytmMid,
      ORDERID: txPaytm.reference,
      TXNID: 'PTM_TXN_SUCCESS_222',
      STATUS: 'TXN_SUCCESS',
      TXNAMOUNT: '300.00'
    };
    ptmSuccessParams.CHECKSUMHASH = calculatePaytmChecksum(ptmSuccessParams, paytmKey);

    const ptmRes1 = await request(baseUrl, '/api/v1/webhook/paytm', {
      method: 'POST',
      body: ptmSuccessParams
    });
    assert(ptmRes1.status === 200, 'Paytm success webhook returns HTTP 200');
    assert(ptmRes1.data.verified === true, 'Paytm webhook marks verified: true');
    const txAfterPtmSuccess = serverRepo.transactions.findById(txPaytm.id);
    assert(txAfterPtmSuccess.status === 'success', 'Paytm transaction transitioned to success');

    // Out-of-order failure notification arrives for Paytm
    const ptmFailParams = {
      MID: paytmMid,
      ORDERID: txPaytm.reference,
      TXNID: 'PTM_TXN_FAIL_STALE',
      STATUS: 'TXN_FAILURE',
      TXNAMOUNT: '300.00'
    };
    ptmFailParams.CHECKSUMHASH = calculatePaytmChecksum(ptmFailParams, paytmKey);

    const ptmRes2 = await request(baseUrl, '/api/v1/webhook/paytm', {
      method: 'POST',
      body: ptmFailParams
    });
    assert(ptmRes2.status === 200, 'Out-of-order Paytm failure returns HTTP 200');
    assert(ptmRes2.data.staleEventRejected === true, 'Response indicates Paytm stale failure was rejected');
    const txAfterPtmStale = serverRepo.transactions.findById(txPaytm.id);
    assert(txAfterPtmStale.status === 'success', 'TERMINAL LOCK: Paytm status remains success');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 4: DUPLICATE WEBHOOK IDEMPOTENCY
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 4: Duplicate Webhook Idempotency ---');

    // Re-delivering exact success PhonePe webhook
    const ppDupRes = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': ppSuccessXVerify },
      body: ppSuccessPayload
    });
    assert(ppDupRes.status === 200, 'Duplicate PhonePe success webhook returns HTTP 200');
    assert(ppDupRes.data.duplicate === true, 'Duplicate notification returns duplicate: true');

    // Re-delivering exact success Paytm webhook
    const ptmDupRes = await request(baseUrl, '/api/v1/webhook/paytm', {
      method: 'POST',
      body: ptmSuccessParams
    });
    assert(ptmDupRes.status === 200, 'Duplicate Paytm success webhook returns HTTP 200');
    assert(ptmDupRes.data.duplicate === true, 'Duplicate Paytm notification returns duplicate: true');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 5: ANDROID COMPANION AMBIGUITY GUARD (MULTIPLE PENDING SAME AMOUNT)
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 5: Android Companion Ambiguity Guard ---');

    // Create 2 pending transactions for the SAME merchant with exact SAME amount ₹499.00
    const txAmbig1 = serverRepo.transactions.create({
      id: 'txn_m3_ambig_1',
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_AMBIG_1',
      amount: 499.00,
      status: 'pending'
    });
    const txAmbig2 = serverRepo.transactions.create({
      id: 'txn_m3_ambig_2',
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_AMBIG_2',
      amount: 499.00,
      status: 'pending'
    });

    const txCountBefore = serverRepo.transactions.findByMerchant(merchantId).length;

    // Companion webhook delivers payment notification for ₹499.00 without pre-submitted UTR
    const ambigUtr = 'UTR_AMBIG_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const companionAmbigRes = await request(baseUrl, '/api/v1/webhook/verify-payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKeyPlain },
      body: {
        amount: 499.00,
        utr: ambigUtr,
        customerUpi: 'payer@okaxis',
        timestamp: new Date().toISOString()
      }
    });

    assert(companionAmbigRes.status === 200, 'Ambiguous Companion notification returns HTTP 200');
    assert(companionAmbigRes.data.verified === false, 'Ambiguous payment marks verified: false');
    assert(companionAmbigRes.data.ambiguous === true, 'Ambiguous payment marks ambiguous: true');
    assert(companionAmbigRes.data.reason === 'multiple_amount_candidates', 'Ambiguity reason indicates multiple_amount_candidates');

    // Verify neither transaction was auto-confirmed
    const txAmbig1After = serverRepo.transactions.findById(txAmbig1.id);
    const txAmbig2After = serverRepo.transactions.findById(txAmbig2.id);

    assert(txAmbig1After.status === 'pending', 'First candidate transaction remains strictly pending');
    assert(txAmbig2After.status === 'pending', 'Second candidate transaction remains strictly pending');
    assert(txAmbig1After.reconciliationStatus === RECON_STATUS.FLAGGED_AMBIGUOUS, 'First candidate flagged as flagged_ambiguous');
    assert(txAmbig2After.reconciliationStatus === RECON_STATUS.FLAGGED_AMBIGUOUS, 'Second candidate flagged as flagged_ambiguous');
    assert(txAmbig1After.ambiguityReason.includes('Ambiguous match'), 'Ambiguity reason recorded on transaction 1');
    assert(txAmbig2After.ambiguityReason.includes('Ambiguous match'), 'Ambiguity reason recorded on transaction 2');

    // Verify NO phantom 3rd direct transaction was created!
    const txCountAfter = serverRepo.transactions.findByMerchant(merchantId).length;
    assert(txCountAfter === txCountBefore, 'NO phantom direct transaction created during ambiguous collision');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 6: ANDROID COMPANION DUPLICATE UTR DETECTION (REPLAY PROTECTION)
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 6: Android Companion Duplicate UTR Detection ---');

    // Create an already-settled transaction with unique UTR
    const settledUtr = 'UTR_SETTLED_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const settledTxId = 'txn_m3_settled_' + crypto.randomBytes(4).toString('hex');
    serverRepo.transactions.create({
      id: settledTxId,
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_SETTLED_' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      amount: 250,
      status: 'success',
      utr: settledUtr,
      paidAt: new Date().toISOString(),
      reconciliationStatus: RECON_STATUS.SETTLED
    });

    // Companion receives same settled UTR again
    const companionDupRes = await request(baseUrl, '/api/v1/webhook/verify-payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKeyPlain },
      body: {
        amount: 250,
        utr: settledUtr,
        customerUpi: 'payer@paytm'
      }
    });

    assert(companionDupRes.status === 200, 'Replay of settled UTR returns HTTP 200');
    assert(companionDupRes.data.verified === true, 'Replay of settled UTR returns verified: true');
    assert(companionDupRes.data.duplicate === true, 'Replay of settled UTR flags duplicate: true');
    assert(companionDupRes.data.transaction && companionDupRes.data.transaction.id === settledTxId, 'Duplicate response references settled transaction');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 7: EXACT PRE-SUBMITTED UTR MATCHING & AMOUNT DISCREPANCY GUARD
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 7: Exact Pre-submitted UTR Matching & Discrepancy Guard ---');

    // 1. Exact match with matching amount (Safe confirmation)
    const exactUtr = 'UTR_EXACT_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const txExact = serverRepo.transactions.create({
      id: 'txn_m3_exact_' + crypto.randomBytes(4).toString('hex'),
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_EXACT_' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      amount: 750.00,
      status: 'pending',
      utr: exactUtr,
      reconciliationStatus: RECON_STATUS.UNVERIFIED_EVIDENCE
    });

    const companionExactRes = await request(baseUrl, '/api/v1/webhook/verify-payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKeyPlain },
      body: {
        amount: 750.00,
        utr: exactUtr,
        customerUpi: 'exactpayer@upi'
      }
    });

    assert(companionExactRes.status === 200, 'Companion exact UTR match returns HTTP 200');
    assert(companionExactRes.data.verified === true, 'Companion exact UTR match marks verified: true');
    assert(companionExactRes.data.matched === true, 'Companion exact UTR match marks matched: true');
    const txExactAfter = serverRepo.transactions.findById(txExact.id);
    assert(txExactAfter.status === 'success', 'Transaction with pre-submitted UTR transitioned to success');
    assert(txExactAfter.reconciliationStatus === RECON_STATUS.SETTLED, 'Reconciliation status is settled');
    assert(txExactAfter.verifiedBy === 'android-companion', 'Verified by android-companion');

    // 2. Conflicting Amount for pre-submitted UTR (Amount Mismatch Guard)
    const mismatchUtr = 'UTR_MISMATCH_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const txMismatch = serverRepo.transactions.create({
      id: 'txn_m3_mismatch_' + crypto.randomBytes(4).toString('hex'),
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_MISMATCH_' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      amount: 1000.00, // Order expected ₹1000.00
      status: 'pending',
      utr: mismatchUtr,
      reconciliationStatus: RECON_STATUS.UNVERIFIED_EVIDENCE
    });

    // Companion notification arrives with ₹500.00 instead of ₹1000.00!
    const companionMismatchRes = await request(baseUrl, '/api/v1/webhook/verify-payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKeyPlain },
      body: {
        amount: 500.00,
        utr: mismatchUtr,
        customerUpi: 'underpayer@upi'
      }
    });

    assert(companionMismatchRes.status === 200, 'Amount mismatch returns HTTP 200');
    assert(companionMismatchRes.data.verified === false, 'Amount mismatch marks verified: false');
    assert(companionMismatchRes.data.ambiguous === true, 'Amount mismatch flags ambiguous: true');
    assert(companionMismatchRes.data.reason === 'amount_mismatch', 'Reason specifies amount_mismatch');
    const txMismatchAfter = serverRepo.transactions.findById(txMismatch.id);
    assert(txMismatchAfter.status === 'pending', 'Underpaid transaction remains strictly pending');
    assert(txMismatchAfter.reconciliationStatus === RECON_STATUS.FLAGGED_AMBIGUOUS, 'Reconciliation status marked flagged_ambiguous');
    assert(txMismatchAfter.ambiguityReason.includes('Amount mismatch'), 'Ambiguity reason contains details');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 8: UNIQUE CANDIDATE AUTO-MATCH & DIRECT UNMATCHED PAYMENT
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 8: Unique Candidate Auto-Match & Direct Payment ---');

    // 1. Unique candidate match: only 1 pending order exists for a unique amount
    const uniqueAmount = 654.32;
    const uniqueUtr = 'UTR_UNIQUE_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const txUnique = serverRepo.transactions.create({
      id: 'txn_m3_unique_' + crypto.randomBytes(4).toString('hex'),
      merchantId,
      linkId: paymentLink.id,
      reference: 'SP_M3_UNIQUE_' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      amount: uniqueAmount,
      status: 'pending'
    });

    const companionUniqueRes = await request(baseUrl, '/api/v1/webhook/verify-payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKeyPlain },
      body: {
        amount: uniqueAmount,
        utr: uniqueUtr,
        customerUpi: 'uniquepayer@axis'
      }
    });

    assert(companionUniqueRes.status === 200, 'Unique candidate match returns HTTP 200');
    assert(companionUniqueRes.data.verified === true, 'Unique candidate match marks verified: true');
    assert(companionUniqueRes.data.matched === true, 'Unique candidate match marks matched: true');
    const txUniqueAfter = serverRepo.transactions.findById(txUnique.id);
    assert(txUniqueAfter.status === 'success', 'Unique candidate safely settled to success');
    assert(txUniqueAfter.reconciliationStatus === RECON_STATUS.SETTLED, 'Reconciliation status marked settled');

    // 2. Direct payment: Zero pending orders exist for ₹123.45
    const directUtr = 'UTR_DIRECT_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const companionDirectRes = await request(baseUrl, '/api/v1/webhook/verify-payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKeyPlain },
      body: {
        amount: 123.45,
        utr: directUtr,
        customerUpi: 'directpayer@ybl'
      }
    });

    assert(companionDirectRes.status === 200, 'Direct companion payment returns HTTP 200');
    assert(companionDirectRes.data.verified === true, 'Direct payment marks verified: true');
    assert(companionDirectRes.data.direct === true, 'Direct payment marks direct: true');
    assert(companionDirectRes.data.matched === false, 'Direct payment marks matched: false');
    const directTxId = companionDirectRes.data.transaction.id;
    const directTxAfter = serverRepo.transactions.findById(directTxId);
    assert(directTxAfter !== null, 'Direct transaction stored in SQLite');
    assert(directTxAfter.status === 'success', 'Direct transaction status is success');
    assert(directTxAfter.amount === 123.45, 'Direct transaction amount matches payload');
    assert(directTxAfter.amount_paise === 12345, 'Paise accounting exact: 12345');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 9: CUSTOMER & MERCHANT EVIDENCE REGISTRATION GUARD
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 9: Customer & Merchant Evidence Registration Guard ---');

    // 1. Customer submits UTR on checkout confirmation
    const checkoutConfirmRes = await request(baseUrl, `/api/checkout/${paymentLink.slug}/confirm`, {
      method: 'POST',
      body: {
        amount: 499.00,
        utr: 'UTR_CUSTOMER_SUBMITTED_987',
        customerName: 'Evidence Test Customer'
      }
    });

    assert(checkoutConfirmRes.status === 200, 'Customer UTR confirm returns HTTP 200');
    assert(checkoutConfirmRes.data.success === true, 'Customer UTR confirm marks success: true');
    const customerTx = checkoutConfirmRes.data.transaction;
    assert(customerTx.status === 'pending', 'Customer UTR submission keeps transaction pending');
    assert(customerTx.reconciliationStatus === RECON_STATUS.UNVERIFIED_EVIDENCE, 'Reconciliation status marked unverified_evidence');

    // 2. Merchant calls direct-verify with UTR
    const directVerifyRes = await request(baseUrl, '/api/business-accounts/direct-verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${merchantJwt}` },
      body: {
        transactionId: customerTx.id,
        utr: 'UTR_MERCHANT_DIRECT_VERIFY_456',
        provider: 'phonepe'
      }
    });

    assert(directVerifyRes.status === 200, 'Merchant direct-verify returns HTTP 200');
    assert(directVerifyRes.data.verified === false, 'Direct-verify without webhook returns verified: false');
    assert(directVerifyRes.data.pending === true, 'Direct-verify returns pending: true');
    const merchantTxAfter = serverRepo.transactions.findById(customerTx.id);
    assert(merchantTxAfter.status === 'pending', 'Transaction remains strictly pending until webhook delivery');
    assert(merchantTxAfter.reconciliationStatus === RECON_STATUS.UNVERIFIED_EVIDENCE, 'Reconciliation status remains unverified_evidence');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 10: PUBLIC CHECKOUT API INFORMATION LEAK PREVENTION
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 10: Public Checkout API Information Leak Prevention ---');

    const publicStatusRes = await request(baseUrl, `/api/checkout/${paymentLink.slug}/status?ref=${customerTx.reference}`);
    assert(publicStatusRes.status === 200, 'Customer polling status returns HTTP 200');
    assert(publicStatusRes.data.status === 'pending', 'Public status reports pending');
    assert(publicStatusRes.data.reference === customerTx.reference, 'Public status reports reference');

    // Verification of zero internal/sensitive leakage in public endpoint
    assert(publicStatusRes.data.auditLog === undefined, 'Public checkout status strictly hides internal auditLog');
    assert(publicStatusRes.data.ambiguityReason === undefined, 'Public checkout status strictly hides ambiguityReason');
    assert(publicStatusRes.data.providerReference === undefined, 'Public checkout status strictly hides providerReference');
    assert(publicStatusRes.data.token === undefined, 'Public checkout status does not leak tokens');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 11: MERCHANT & ADMIN DASHBOARD RECONCILIATION VISIBILITY
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 11: Merchant & Admin Dashboard Reconciliation Visibility ---');

    // Merchant transactions list
    const merchantTxRes = await request(baseUrl, '/api/transactions', {
      headers: { Authorization: `Bearer ${merchantJwt}` }
    });
    assert(merchantTxRes.status === 200, 'Merchant transactions list returns HTTP 200');
    assert(Array.isArray(merchantTxRes.data), 'Merchant transactions returns array');
    const foundInMerchantList = merchantTxRes.data.find(t => t.id === customerTx.id);
    assert(Boolean(foundInMerchantList), 'Transaction present in merchant transactions list');
    assert(foundInMerchantList.reconciliationStatus === RECON_STATUS.UNVERIFIED_EVIDENCE, 'Merchant can see reconciliationStatus');

    // Admin transactions list
    const adminTxRes = await request(baseUrl, '/api/admin/transactions', {
      headers: { Authorization: `Bearer ${adminJwt}` }
    });
    assert(adminTxRes.status === 200, 'Admin transactions list returns HTTP 200');
    assert(Array.isArray(adminTxRes.data), 'Admin transactions returns array');
    const foundInAdminList = adminTxRes.data.find(t => t.id === customerTx.id);
    assert(Boolean(foundInAdminList), 'Transaction present in admin transactions list');
    assert(foundInAdminList.reconciliationStatus === RECON_STATUS.UNVERIFIED_EVIDENCE, 'Admin can see reconciliationStatus');
    assert(Boolean(foundInAdminList.auditLog), 'Admin can inspect transaction auditLog');

    /* ────────────────────────────────────────────────────────────────────────────
       CLEANUP
       ──────────────────────────────────────────────────────────────────────────── */
    serverRepo.merchants.delete(merchantId);

  } finally {
    await new Promise(resolve => server.close(resolve));
    console.log('\nLive HTTP test server closed cleanly.');
  }

  /* ────────────────────────────────────────────────────────────────────────────
     FINAL RESULTS REPORT
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n==============================================================================');
  console.log(`TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('==============================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runMilestone3Tests().catch(err => {
  console.error('\n❌ Unhandled exception during Milestone 3 tests:', err);
  process.exit(1);
});
