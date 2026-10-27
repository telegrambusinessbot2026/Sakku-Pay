/* SakkuPay — Customer Checkout Logic */
'use strict';

const slug = location.pathname.split('/').pop();
const $ = s => document.querySelector(s);
let payment = null;
let currentTx = null;

function rupee(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function intentUri(amount) {
  if (!payment) return '';
  const amParam = amount ? `&am=${encodeURIComponent(amount)}` : '';
  return `upi://pay?pa=${encodeURIComponent(payment.upiId)}&pn=${encodeURIComponent(payment.businessName)}${amParam}&cu=INR&tn=${encodeURIComponent(payment.name)}`;
}

async function load() {
  const container = $('#pay-content');
  try {
    const res = await fetch('/api/checkout/' + encodeURIComponent(slug));
    if (!res.ok) {
      container.innerHTML = `
        <div class="checkout-error">
          <div style="font-size:36px;margin-bottom:8px">⚠️</div>
          <h1 style="font-size:20px;margin:0 0 8px">Payment Link Unavailable</h1>
          <p style="color:#77768b;font-size:13px;line-height:1.5">This payment link may have expired, been deactivated by the merchant, or does not exist.</p>
        </div>
      `;
      return;
    }

    payment = await res.json();
    const isOpen = payment.amountType === 'open';

    container.innerHTML = `
      <div class="checkout-header">
        <p class="eyebrow">PAYING TO</p>
        <h2 class="merchant-title">${escapeHtml(payment.businessName)}</h2>
        <h1 class="item-title">${escapeHtml(payment.name)}</h1>
        ${payment.description ? `<p class="pay-desc">${escapeHtml(payment.description)}</p>` : ''}
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
          <strong id="display-amount">${rupee(payment.amount)}</strong>
        `}
      </div>

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

      <div class="status-indicator">
        <p id="status" class="public-status">
          <span class="status-dot"></span>
          <span id="status-text">Ready to pay</span>
        </p>
      </div>

      <div class="utr-section" id="utr-section">
        <button class="toggle-utr-btn" id="toggle-utr-btn">I've completed this payment →</button>
        <div class="utr-form hidden" id="utr-form">
          <p style="font-size:12px;color:#77768b;margin:0 0 8px">Enter the 12-digit UPI reference (UTR) from your payment receipt:</p>
          <div style="display:flex;gap:8px">
            <input id="utr-input" placeholder="e.g. 428938192831" maxlength="22" style="flex:1;padding:8px 10px;border:1px solid #dcdbe8;border-radius:6px;font-size:13px">
            <button id="submit-utr" class="btn-submit-utr">Confirm</button>
          </div>
        </div>
      </div>

      ${payment.whatsappNumber ? `
        <div class="merchant-support">
          <a href="https://wa.me/91${payment.whatsappNumber}?text=${encodeURIComponent('Hi, I am contacting you regarding payment for ' + payment.name)}" target="_blank" class="wa-support-link">
            💬 Need help? Contact ${escapeHtml(payment.businessName)} on WhatsApp
          </a>
        </div>
      ` : ''}
    `;

    function getAmount() {
      if (!isOpen) return payment.amount;
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
          new QRCode(q, {
            text: uri,
            width: 172,
            height: 172,
            colorDark: '#1e1d34',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
          });
        }
      }
    }

    if (isOpen) {
      $('#pay-amount').addEventListener('input', update);
    }
    update();

    // QR Download
    $('#download').onclick = () => {
      const img = $('#qrcode img') || $('#qrcode canvas');
      if (!img) return;
      const a = document.createElement('a');
      a.href = img.tagName === 'CANVAS' ? img.toDataURL('image/png') : img.src;
      a.download = `sakkupay-${payment.slug}-qr.png`;
      a.click();
    };

    let pollTimer = null;
    function pollPaymentStatus(txId, ref) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch('/api/checkout/' + slug + '/status?txId=' + encodeURIComponent(txId || '') + '&ref=' + encodeURIComponent(ref || ''));
          if (res.ok) {
            const data = await res.json();
            if (data.status === 'success') {
              clearInterval(pollTimer);
              pollTimer = null;
              $('#status-text').textContent = 'Payment verified & completed successfully!';
              $('#status').className = 'public-status success';
              if (utrForm) {
                utrForm.innerHTML = '<div style="color:#34D399;font-weight:700;font-size:13.5px;padding:14px;background:rgba(16,185,129,0.15);border:1px solid rgba(52,211,153,0.3);border-radius:10px;margin-top:14px;text-align:center">✓ Payment Successfully Verified & Received!</div>';
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
            setTimeout(() => { inp.style.borderColor = '#818CF8'; }, 2000);
          }
          $('#status-text').textContent = 'Please enter an amount above before opening UPI app';
          $('#status').className = 'public-status';
          return;
        }
        $('#status-text').textContent = 'Payment initiated — complete it in your UPI app';
        $('#status').className = 'public-status initiated';

        try {
          const r = await fetch('/api/checkout/' + slug + '/attempt', {
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
          const res = await fetch('/api/checkout/' + slug + '/confirm', {
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
            utrForm.innerHTML = '<p style="color:#34D399;font-weight:600;font-size:13px;margin:10px 0;background:rgba(16,185,129,0.12);padding:10px 14px;border-radius:8px;border:1px solid rgba(52,211,153,0.25)">✓ Reference submitted! Awaiting companion app verification…</p>';
            $('#status-text').textContent = 'Receipt submitted — verifying transaction…';
            $('#status').className = 'public-status confirmed';
            if (currentTx) pollPaymentStatus(currentTx.id, currentTx.reference);
          }
        } catch {
          submitUtr.disabled = false;
          submitUtr.textContent = 'Confirm';
        }
      };
    }

  } catch (e) {
    container.innerHTML = '<p class="checkout-error">Unable to load checkout. Please refresh.</p>';
  }
}

document.addEventListener('DOMContentLoaded', load);
