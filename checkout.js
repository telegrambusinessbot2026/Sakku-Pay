/* ==============================================================================
   SakkuPay — Customer Checkout Logic
   Handles:
   1. Loading state with visible spinner animation and status text.
   2. Success state rendering 5 distinct templates (Classic, Minimal, Premium Dark,
      Modern Gradient, Compact UPI Express).
   3. Not Found state (404) with clear explanation when link does not exist.
   4. Inactive/Expired state (410/404 code: LINK_INACTIVE) when merchant closed link.
   5. Server / Network error state (500 or offline) with Retry button.
   6. Connection timeout state (10s abort) with Retry button.
   7. QR code rendering with asynchronous library loader fallback.
   ============================================================================== */
'use strict';

const $ = s => document.querySelector(s);
const REQUEST_TIMEOUT_MS = 10000; // 10 second timeout

let payment = null;
let currentTx = null;
let pollTimer = null;
let qrRetryTimer = null;

function getSlug() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts[0] === 'pay') {
    return parts[1] || '';
  }
  return parts[parts.length - 1] || '';
}

function rupee(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function intentUri(amount) {
  if (!payment) return '';
  const amParam = amount ? `&am=${encodeURIComponent(amount)}` : '';
  return `upi://pay?pa=${encodeURIComponent(payment.upiId)}&pn=${encodeURIComponent(payment.businessName)}${amParam}&cu=INR&tn=${encodeURIComponent(payment.name)}`;
}

/* ─── State 1: Loading State ─────────────────────────────────────────────────── */
function renderLoadingState() {
  const container = $('#pay-content');
  if (!container) return;
  container.innerHTML = `
    <div class="checkout-loading-box" id="checkout-loading-state">
      <div class="checkout-spinner" role="status" aria-label="Loading"></div>
      <p class="loading-title">Loading payment link…</p>
      <p class="loading-subtitle">Connecting securely to SakkuPay gateway</p>
    </div>
  `;
}

/* ─── State 3: Not Found State ───────────────────────────────────────────────── */
function renderNotFoundState(slug) {
  const container = $('#pay-content');
  if (!container) return;
  document.title = 'Payment Link Not Found — SakkuPay';
  container.innerHTML = `
    <div class="checkout-state-card">
      <div class="checkout-state-icon">🔍</div>
      <span class="checkout-state-badge badge-not-found">Link Not Found</span>
      <h1 class="checkout-state-title">Payment Link Unavailable</h1>
      <p class="checkout-state-desc">
        The payment link <strong>/pay/${escapeHtml(slug || 'unknown')}</strong> does not exist or may have been mistyped.
        Please verify the URL or ask the merchant to generate a new checkout link.
      </p>
      <a href="/" class="checkout-retry-btn" style="text-decoration:none">Back to SakkuPay</a>
    </div>
  `;
}

/* ─── State 4: Expired / Inactive State ───────────────────────────────────────── */
function renderInactiveState(msg) {
  const container = $('#pay-content');
  if (!container) return;
  document.title = 'Payment Link Inactive — SakkuPay';
  container.innerHTML = `
    <div class="checkout-state-card">
      <div class="checkout-state-icon">🛑</div>
      <span class="checkout-state-badge badge-inactive">Link Closed</span>
      <h1 class="checkout-state-title">Payment Link Inactive</h1>
      <p class="checkout-state-desc">
        ${escapeHtml(msg || 'This payment link has expired or has been deactivated by the merchant. It can no longer accept new payments.')}
      </p>
      <a href="/" class="checkout-retry-btn" style="text-decoration:none">Back to SakkuPay</a>
    </div>
  `;
}

/* ─── State 5: Server / Network Error State ─────────────────────────────────── */
function renderServerErrorState(msg, retryFn) {
  const container = $('#pay-content');
  if (!container) return;
  document.title = 'Checkout Error — SakkuPay';
  container.innerHTML = `
    <div class="checkout-state-card">
      <div class="checkout-state-icon">🔌</div>
      <span class="checkout-state-badge badge-error">Connection Error</span>
      <h1 class="checkout-state-title">Unable to Load Checkout</h1>
      <p class="checkout-state-desc">
        ${escapeHtml(msg || 'An unexpected error occurred while communicating with the payment server. Please verify your connection and try again.')}
      </p>
      <button id="checkout-action-retry" class="checkout-retry-btn">↻ Try Again</button>
    </div>
  `;
  const btn = $('#checkout-action-retry');
  if (btn && typeof retryFn === 'function') {
    btn.onclick = () => retryFn();
  }
}

/* ─── State 6: Timeout State ─────────────────────────────────────────────────── */
function renderTimeoutState(retryFn) {
  const container = $('#pay-content');
  if (!container) return;
  document.title = 'Connection Timeout — SakkuPay';
  container.innerHTML = `
    <div class="checkout-state-card">
      <div class="checkout-state-icon">⏱️</div>
      <span class="checkout-state-badge badge-not-found">Request Timed Out</span>
      <h1 class="checkout-state-title">Connection Timed Out</h1>
      <p class="checkout-state-desc">
        The request to fetch this payment link took longer than expected. No payment has been processed. Please check your connection and retry.
      </p>
      <button id="checkout-action-retry" class="checkout-retry-btn">↻ Retry Connection</button>
    </div>
  `;
  const btn = $('#checkout-action-retry');
  if (btn && typeof retryFn === 'function') {
    btn.onclick = () => retryFn();
  }
}

/* ─── State 2: Success State (5 Templates) ──────────────────────────────────── */
function templateLabel(t) {
  const labels = {
    'classic': 'SakkuPay Classic',
    'minimal': 'Minimal Clean',
    'premium-dark': 'Premium Onyx',
    'modern-gradient': 'Cyberpunk Gradient',
    'compact-upi': 'UPI Express'
  };
  return labels[t] || 'Direct Checkout';
}

function renderStandardSection() {
  return `
    <div class="qr-container">
      <div id="qrcode"></div>
      <button id="download" class="download-qr-btn">⇩ Download QR Code</button>
    </div>

    <p class="or-divider"><span>OR TAP YOUR UPI APP TO PAY</span></p>

    <div class="apps-grid">
      <a id="gpay" class="app-btn gpay-btn" title="Pay with Google Pay">
        <span class="app-icon">G</span>
        <span>Google Pay</span>
      </a>
      <a id="phonepe" class="app-btn phonepe-btn" title="Pay with PhonePe">
        <span class="app-icon">पे</span>
        <span>PhonePe</span>
      </a>
      <a id="paytm" class="app-btn paytm-btn" title="Pay with Paytm">
        <span class="app-icon">paytm</span>
        <span>Paytm</span>
      </a>
      <a id="bhim" class="app-btn bhim-btn" title="Pay with BHIM UPI">
        <span class="app-icon">◉</span>
        <span>BHIM UPI</span>
      </a>
    </div>
  `;
}

function renderCompactUpiSection() {
  return `
    <p class="or-divider" style="margin-top:12px"><span>INSTANT 1-TAP UPI APPS</span></p>

    <div class="apps-grid apps-grid-express">
      <a id="gpay" class="app-btn gpay-btn" title="Pay with Google Pay">
        <span class="app-icon">G</span>
        <span>Google Pay</span>
      </a>
      <a id="phonepe" class="app-btn phonepe-btn" title="Pay with PhonePe">
        <span class="app-icon">पे</span>
        <span>PhonePe</span>
      </a>
      <a id="paytm" class="app-btn paytm-btn" title="Pay with Paytm">
        <span class="app-icon">paytm</span>
        <span>Paytm</span>
      </a>
      <a id="bhim" class="app-btn bhim-btn" title="Pay with BHIM UPI">
        <span class="app-icon">◉</span>
        <span>BHIM UPI</span>
      </a>
    </div>

    <details class="qr-accordion" style="margin:16px 0;text-align:center">
      <summary style="font-size:12px;font-weight:600;cursor:pointer;color:var(--muted);padding:8px">▶ Or scan QR Code on desktop</summary>
      <div class="qr-container" style="margin-top:12px">
        <div id="qrcode"></div>
        <button id="download" class="download-qr-btn" style="margin-top:8px">⇩ Download QR Code</button>
      </div>
    </details>
  `;
}

function renderSuccessState(p) {
  const container = $('#pay-content');
  if (!container) return;

  const template = p.template || 'classic';
  document.body.className = `checkout-page template-${template}`;
  document.title = `${p.name} — Pay ${escapeHtml(p.businessName)} securely`;

  const isOpen = p.amountType === 'open';

  container.innerHTML = `
    <div class="checkout-card-inner">
      <div class="checkout-header">
        <div class="badge-row">
          <span class="template-badge">${templateLabel(template)}</span>
          <span class="upi-secure-badge">● Direct UPI</span>
        </div>
        <p class="eyebrow">PAYING TO</p>
        <h2 class="merchant-title">${escapeHtml(p.businessName)}</h2>
        <h1 class="item-title">${escapeHtml(p.name)}</h1>
        ${p.description ? `<p class="pay-desc">${escapeHtml(p.description)}</p>` : ''}
      </div>

      <div class="public-amount">
        ${isOpen ? `
          <label>
            <span>ENTER AMOUNT TO PAY</span>
            <div class="amount-input-wrap">
              <span class="currency-prefix">₹</span>
              <input id="pay-amount" inputmode="decimal" type="number" min="1" placeholder="0" autofocus>
            </div>
          </label>
        ` : `
          <span>AMOUNT TO PAY</span>
          <strong id="display-amount">${rupee(p.amount)}</strong>
        `}
      </div>

      ${template === 'compact-upi' ? renderCompactUpiSection() : renderStandardSection()}

      <div class="status-indicator">
        <p id="status" class="public-status">
          <span class="status-dot"></span>
          <span id="status-text">Ready to pay</span>
        </p>
      </div>

      <div class="utr-section" id="utr-section">
        <button class="toggle-utr-btn" id="toggle-utr-btn">I've completed this payment →</button>
        <div class="utr-form hidden" id="utr-form">
          <p style="font-size:12px;margin:0 0 8px" class="utr-help-text">Enter the 12-digit UPI reference (UTR) from your payment receipt:</p>
          <div style="display:flex;gap:8px">
            <input id="utr-input" placeholder="e.g. 428938192831" maxlength="22">
            <button id="submit-utr" class="btn-submit-utr">Confirm</button>
          </div>
        </div>
      </div>

      ${p.whatsappNumber ? `
        <div class="merchant-support">
          <a href="https://wa.me/91${p.whatsappNumber}?text=${encodeURIComponent('Hi, I am contacting you regarding payment for ' + p.name)}" target="_blank" class="wa-support-link">
            💬 Need help? Contact ${escapeHtml(p.businessName)} on WhatsApp
          </a>
        </div>
      ` : ''}
    </div>
  `;

  function getAmount() {
    if (!isOpen) return p.amount;
    const val = Number($('#pay-amount')?.value);
    return val > 0 ? val : 0;
  }

  function update() {
    const amt = getAmount();
    const uri = intentUri(amt);

    ['gpay', 'phonepe', 'paytm', 'bhim'].forEach(id => {
      const el = $('#' + id);
      if (el) el.href = uri;
    });

    const q = $('#qrcode');
    if (q) {
      q.innerHTML = '';
      if (window.QRCode) {
        if (qrRetryTimer) { clearInterval(qrRetryTimer); qrRetryTimer = null; }
        const isMinimal = template === 'minimal';
        new QRCode(q, {
          text: uri,
          width: 172,
          height: 172,
          colorDark: isMinimal ? '#0F172A' : '#1e1d34',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H
        });
      } else {
        // Fallback: QRCode library loading asynchronously
        if (!qrRetryTimer) {
          let attempts = 0;
          qrRetryTimer = setInterval(() => {
            attempts++;
            if (window.QRCode) {
              clearInterval(qrRetryTimer);
              qrRetryTimer = null;
              update();
            } else if (attempts > 30) {
              clearInterval(qrRetryTimer);
              qrRetryTimer = null;
            }
          }, 100);
        }
      }
    }
  }

  if (isOpen) {
    $('#pay-amount').addEventListener('input', update);
  }
  update();

  // QR Download
  const downloadBtn = $('#download');
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      const img = $('#qrcode img') || $('#qrcode canvas');
      if (!img) return;
      const a = document.createElement('a');
      a.href = img.tagName === 'CANVAS' ? img.toDataURL('image/png') : img.src;
      a.download = `sakkupay-${p.slug}-qr.png`;
      a.click();
    };
  }

  function pollPaymentStatus(txId, ref) {
    if (pollTimer) clearInterval(pollTimer);
    const slug = p.slug;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/checkout/' + encodeURIComponent(slug) + '/status?txId=' + encodeURIComponent(txId || '') + '&ref=' + encodeURIComponent(ref || ''));
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'success') {
            clearInterval(pollTimer);
            pollTimer = null;
            $('#status-text').textContent = 'Payment verified & completed successfully!';
            $('#status').className = 'public-status success';
            if (utrForm) {
              utrForm.innerHTML = '<div style="color:#10B981;font-weight:700;font-size:13.5px;padding:14px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);border-radius:10px;margin-top:14px;text-align:center">✓ Payment Successfully Verified & Received!</div>';
            }
          }
        }
      } catch (_) {}
    }, 3000);
  }

  // Track attempt on app click
  document.querySelectorAll('.apps-grid a').forEach(a => {
    a.addEventListener('click', async () => {
      const amt = getAmount();
      if (isOpen && !amt) {
        const inp = $('#pay-amount');
        if (inp) {
          inp.focus();
          inp.style.borderColor = '#F87171';
          setTimeout(() => { inp.style.borderColor = ''; }, 2000);
        }
        $('#status-text').textContent = 'Please enter an amount above before opening UPI app';
        $('#status').className = 'public-status';
        return;
      }
      $('#status-text').textContent = 'Payment initiated — complete it in your UPI app';
      $('#status').className = 'public-status initiated';

      try {
        const r = await fetch('/api/checkout/' + encodeURIComponent(p.slug) + '/attempt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: amt })
        });
        if (r.ok) {
          const data = await r.json();
          currentTx = data.transaction;
          if (currentTx) pollPaymentStatus(currentTx.id, currentTx.reference);
        }
      } catch { /* ignore */ }
    });
  });

  // UTR toggle
  const toggleUtr = $('#toggle-utr-btn');
  const utrForm = $('#utr-form');
  if (toggleUtr && utrForm) {
    toggleUtr.onclick = () => {
      utrForm.classList.toggle('hidden');
    };
  }

  // Submit UTR
  const submitUtr = $('#submit-utr');
  if (submitUtr) {
    submitUtr.onclick = async () => {
      const utr = ($('#utr-input')?.value || '').trim();
      if (!utr) return;
      submitUtr.disabled = true;
      submitUtr.textContent = 'Saving…';
      try {
        const res = await fetch('/api/checkout/' + encodeURIComponent(p.slug) + '/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            utr,
            transactionId: currentTx?.id,
            reference: currentTx?.reference,
            amount: getAmount()
          })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.transaction) currentTx = data.transaction;
          utrForm.innerHTML = '<p style="color:#10B981;font-weight:600;font-size:13px;margin:10px 0;background:rgba(16,185,129,0.12);padding:10px 14px;border-radius:8px;border:1px solid rgba(16,185,129,0.25)">✓ Reference submitted! Awaiting companion app verification…</p>';
          $('#status-text').textContent = 'Receipt submitted — verifying transaction…';
          $('#status').className = 'public-status confirmed';
          if (currentTx) pollPaymentStatus(currentTx.id, currentTx.reference);
        } else {
          submitUtr.disabled = false;
          submitUtr.textContent = 'Confirm';
        }
      } catch {
        submitUtr.disabled = false;
        submitUtr.textContent = 'Confirm';
      }
    };
  }
}

/* ─── Main Load Function ─────────────────────────────────────────────────────── */
async function load() {
  const container = $('#pay-content');
  if (!container) return;

  renderLoadingState();

  const currentSlug = getSlug();
  if (!currentSlug) {
    renderNotFoundState('');
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('/api/checkout/' + encodeURIComponent(currentSlug), {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeoutId);

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      renderServerErrorState('Invalid response received from payment server.', () => load());
      return;
    }

    if (res.status === 404) {
      if (data?.code === 'LINK_INACTIVE' || data?.code === 'LINK_DEACTIVATED') {
        renderInactiveState(data?.error);
      } else {
        renderNotFoundState(currentSlug);
      }
      return;
    }

    if (res.status === 410) {
      renderInactiveState(data?.error);
      return;
    }

    if (!res.ok) {
      const is5xx = res.status >= 500;
      renderServerErrorState(is5xx ? 'Payment gateway temporarily unavailable. Please try again.' : (data?.error || 'Unable to load payment link.'), () => load());
      return;
    }

    payment = data;
    renderSuccessState(payment);

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      renderTimeoutState(() => load());
    } else {
      renderServerErrorState('Network error: Unable to reach SakkuPay payment gateway.', () => load());
    }
  }
}

// Guaranteed DOM ready execution
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', load);
} else {
  load();
}
