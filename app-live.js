/* ==============================================================================
   SakkuPay — Enterprise Merchant Client (app-live.js)
   Clean-slate SPA with SSE, UPI, payment links, and transaction ledger.
   ============================================================================== */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ─── Authentication Token Resolution ─────────────────────────────────────── */
function resolveAuthToken() {
  let foundToken = null;

  // 1. Check URL hash fragment (Google OAuth callback: /dashboard#access_token=...)
  if (window.location.hash) {
    const rawHash = window.location.hash.replace(/^#\/?/, '');
    const hashParams = new URLSearchParams(rawHash);
    foundToken = hashParams.get('access_token') || hashParams.get('token');
  }

  // 2. Check URL query params fallback (?token=... or ?access_token=...)
  if (!foundToken && window.location.search) {
    const searchParams = new URLSearchParams(window.location.search);
    foundToken = searchParams.get('access_token') || searchParams.get('token');
  }

  // 3. Persist to localStorage and clean address bar
  if (foundToken) {
    foundToken = foundToken.trim();
    try { localStorage.setItem('sakku-token', foundToken); } catch {}
    try { window.history.replaceState({}, document.title, window.location.pathname); } catch {}
    return foundToken;
  }

  // 4. Fall back to stored token
  try {
    return localStorage.getItem('sakku-token') || localStorage.getItem('sakku_token') || '';
  } catch {
    return '';
  }
}

/* ─── State ────────────────────────────────────────────────────────────────── */
let token = resolveAuthToken();
let links = [];
let upis = [];
let allTransactions = [];
let currentProfile = null;
let sseSource = null;

/* ─── API Client ───────────────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const currentToken = token || resolveAuthToken();
  if (currentToken) headers['Authorization'] = 'Bearer ' + currentToken;
  const res = await fetch('/api' + path, { ...options, headers });
  if (res.status === 401) {
    logout('session_expired');
    throw new Error('Session expired. Please sign in again.');
  }
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Access denied.');
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

/* ─── Toast ────────────────────────────────────────────────────────────────── */
let _toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = isError ? 'show error' : 'show';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

/* ─── Formatters ───────────────────────────────────────────────────────────── */
function money(v) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0);
}

function time(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pill(status, verifiedBy, reconStatus, ambiguityReason) {
  const s = status || 'pending';
  const recon = reconStatus || 'unreconciled';

  if (s === 'success') {
    if (verifiedBy === 'android-companion')
      return '<span class="pill companion-verified"><span class="dot"></span> Auto-Verified (Companion)</span>';
    if (verifiedBy === 'phonepe-direct' || verifiedBy === 'paytm-direct')
      return '<span class="pill direct-verified"><span class="dot"></span> Direct Gateway</span>';
    if (verifiedBy === 'admin-manual')
      return '<span class="pill manual-verified"><span class="dot"></span> Settled (Manual Proof)</span>';
    return '<span class="pill success"><span class="dot"></span> Confirmed</span>';
  }

  if (s === 'failed') {
    return '<span class="pill failed"><span class="dot"></span> Failed / Expired</span>';
  }

  if (s === 'expired') {
    return '<span class="pill inactive"><span class="dot"></span> Expired</span>';
  }

  // Pending with specific reconciliation diagnostics
  if (recon === 'flagged_ambiguous' || ambiguityReason) {
    return '<span class="pill ambiguous"><span class="dot"></span> Flagged Ambiguous</span>';
  }
  if (recon === 'unverified_evidence') {
    return '<span class="pill unverified"><span class="dot"></span> UTR Evidence (Unconfirmed)</span>';
  }

  return '<span class="pill pending"><span class="dot"></span> Awaiting Confirmation</span>';
}

function customer(t) {
  const name = t.customerName || 'UPI Customer';
  const email = t.customerEmail || t.reference || '';
  const initials = (name.trim().split(/\s+/).map(n => n[0]).join('') || 'UP').slice(0, 2).toUpperCase();
  return `<div class="customer"><i>${initials}</i><span><b>${escapeHtml(name)}</b><small>${escapeHtml(email)}</small></span></div>`;
}

function triggerButtonCopyFeedback(btn, originalText) {
  if (!btn) return;
  const initial = originalText || btn.textContent;
  btn.classList.add('copy-success-feedback');
  btn.textContent = '✓ Copied!';
  setTimeout(() => {
    btn.classList.remove('copy-success-feedback');
    btn.textContent = initial;
  }, 1800);
}

/* ─── SPA Router & Navigation ─────────────────────────────────────────────────── */
const VALID_PAGES = ['overview', 'links', 'upi', 'transactions', 'companion', 'developers', 'settings', 'support'];

function normalizePage(p) {
  if (!p) return 'overview';
  p = p.toLowerCase().trim();
  if (p === 'developer' || p === 'api') return 'developers';
  if (VALID_PAGES.includes(p)) return p;
  return 'overview';
}

function getActivePageFromUrl() {
  // 1. Check hash: e.g. #links, #settings, #transactions
  if (window.location.hash) {
    const h = window.location.hash.replace(/^#\/?/, '').trim();
    // If hash contains OAuth token params like access_token=..., do not treat as page
    if (!h.includes('=') && !h.includes('&')) {
      return normalizePage(h);
    }
  }
  // 2. Check query param: ?page=links
  if (window.location.search) {
    const sp = new URLSearchParams(window.location.search);
    const p = sp.get('page');
    if (p) return normalizePage(p);
  }
  // 3. Check pathname: /dashboard/links
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'dashboard') {
    return normalizePage(parts[1]);
  }
  return 'overview';
}

function go(page, pushHistory = true) {
  page = normalizePage(page);

  // ONLY toggle .active class — never innerHTML, never re-render DOM sections
  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $('#' + page);
  if (target) target.classList.add('active');

  $$('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === page));

  // Push / replace history state for browser Back / Forward support
  if (pushHistory) {
    const currentHash = (window.location.hash || '').replace(/^#\/?/, '').toLowerCase();
    if (currentHash !== page) {
      try {
        history.pushState({ page }, '', '#' + page);
      } catch {
        window.location.hash = '#' + page;
      }
    }
  }

  // Update document title
  const titleMap = {
    overview: 'Dashboard Overview',
    links: 'Payment Links',
    upi: 'UPI Accounts',
    transactions: 'Transactions',
    companion: 'Companion App',
    developers: 'Developer API',
    settings: 'Settings & Profile',
    support: 'Merchant Support'
  };
  document.title = (titleMap[page] || 'Merchant Portal') + ' — SakkuPay';

  // Lazy-load page data only when needed
  if (page === 'developers') loadApiKeys();
  if (page === 'transactions') loadTransactions();
  if (page === 'links') renderLinks();
  if (page === 'upi') renderUpis();
  if (page === 'support') loadSupportQueries();

  $('.sidebar')?.classList.remove('open');
  $('#sidebar-backdrop')?.classList.remove('active');
  window.scrollTo(0, 0);
}

// Browser Back & Forward event listeners
window.addEventListener('popstate', e => {
  const page = (e.state && e.state.page) ? e.state.page : getActivePageFromUrl();
  go(page, false);
});

window.addEventListener('hashchange', () => {
  const page = getActivePageFromUrl();
  if (page) go(page, false);
});

function handleLogoutClick(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (confirm('Are you sure you want to sign out of your SakkuPay merchant account?')) {
    logout('user_action');
  }
}

/* ─── Nav wiring ───────────────────────────────────────────────────────────── */
$$('.nav[data-page]').forEach(btn => { btn.onclick = () => go(btn.dataset.page); });
$$('[data-goto]').forEach(el => { el.onclick = () => go(el.dataset.goto); });

// Sidebar click-throughs
const _profileBtn = $('#profile-sidebar-btn');
if (_profileBtn) _profileBtn.onclick = () => go('settings');

/* ─── Modal Manager ────────────────────────────────────────────────────────── */
function modal(id, show) {
  const el = $('#' + id);
  if (!el) return;
  el.classList.toggle('open', show);
  if (show) {
    const firstInput = el.querySelector('input:not([type="hidden"]), select, textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 80);
  }
}

// Wire all .close buttons and backdrop click-to-close ONCE at boot
document.querySelectorAll('.backdrop .close').forEach(b => {
  b.onclick = () => b.closest('.backdrop').classList.remove('open');
});
document.querySelectorAll('.backdrop').forEach(b => {
  b.onclick = e => { if (e.target === b) b.classList.remove('open'); };
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.backdrop.open').forEach(b => b.classList.remove('open'));
});

/* ─── UPI Modal ────────────────────────────────────────────────────────────── */
function openUpiModal(editAcc = null) {
  const modalEl = $('#upi-modal');
  if (!modalEl) return;

  $('#upi-edit-id').value = editAcc ? editAcc.id : '';
  $('#upi-modal-vpa').value = editAcc ? editAcc.upiId : '';
  $('#upi-modal-phone').value = editAcc ? (editAcc.phoneNumber || '') : (currentProfile?.whatsappNumber || '');

  const defCheckbox = $('#upi-modal-default');
  if (defCheckbox) defCheckbox.checked = editAcc ? !!editAcc.default : (!upis || upis.length === 0);

  const title = $('#upi-modal-title');
  const submitBtn = $('#upi-submit-btn');
  if (title) title.textContent = editAcc ? 'Edit UPI Account' : 'Connect UPI Account';
  if (submitBtn) submitBtn.textContent = editAcc ? 'Update UPI Account →' : 'Connect UPI Account →';

  modal('upi-modal', true);
}

/* UPI Form Submit */
const upiForm = $('#upi-form');
if (upiForm) {
  upiForm.onsubmit = async e => {
    e.preventDefault();
    const editId = $('#upi-edit-id')?.value;
    const vpa = ($('#upi-modal-vpa')?.value || '').trim().toLowerCase();
    const phone = ($('#upi-modal-phone')?.value || '').replace(/\D/g, '');
    const isDefault = $('#upi-modal-default')?.checked;

    if (!/^[\w.-]+@[\w.-]+$/.test(vpa)) { toast('Enter a valid UPI ID (e.g. name@okaxis)', true); return; }
    if (!/^\d{10}$/.test(phone)) { toast('Enter a valid 10-digit mobile number', true); return; }

    const btn = $('#upi-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

    try {
      if (editId) {
        await api('/upis/' + editId, { method: 'PATCH', body: JSON.stringify({ upiId: vpa, phoneNumber: phone, default: isDefault }) });
        toast('UPI account updated successfully.');
      } else {
        await api('/upis', { method: 'POST', body: JSON.stringify({ upiId: vpa, phoneNumber: phone, default: isDefault }) });
        toast('🎉 UPI account connected!');
      }
      modal('upi-modal', false);
      await refresh();
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = editId ? 'Update UPI Account →' : 'Connect UPI Account →'; }
    }
  };
}

/* ─── Render UPI Accounts ──────────────────────────────────────────────────── */
function renderUpis() {
  const container = $('#upi-cards');
  const linkSelect = $('#link-upi-select');

  if (container) {
    if (!upis.length) {
      container.innerHTML = `
        <article class="panel" style="grid-column:1/-1;padding:0">
          <div class="empty-placeholder">
            <div class="empty-icon-wrap">◉</div>
            <h3>No receiving UPI accounts connected</h3>
            <p>Connect your primary Google Pay, PhonePe, Paytm, or BHIM UPI ID and 10-digit mobile number to collect customer payments with 0% gateway commission.</p>
            <button class="primary" onclick="openUpiModal(null)" style="margin-top:16px;padding:10px 22px;font-size:13px;border-radius:10px">+ Connect Your First UPI Account</button>
          </div>
        </article>
      `;
    } else {
      container.innerHTML = upis.map(u => {
        const initial = (u.upiId || 'U')[0].toUpperCase();
        return `
          <article class="panel upi-card" style="display:flex;flex-direction:column;justify-content:space-between">
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div class="upi-icon" style="font-weight:800">${initial}</div>
                ${u.default ? '<span class="pill success" style="font-size:11px"><span class="dot"></span> Primary Account</span>' : ''}
              </div>
              <h2 style="font-family:monospace;font-size:16px;color:#FFFFFF;margin-bottom:6px;word-break:break-all">${escapeHtml(u.upiId)}</h2>
              <p style="font-size:13px;color:var(--muted);margin:0">
                📱 Registered Mobile: <b style="color:#E2E8F0;font-family:monospace">+91 ${escapeHtml(u.phoneNumber || '—')}</b>
              </p>
            </div>
            <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
              <span>
                ${u.default ? '<span style="color:#34D399;font-size:12px;font-weight:600">★ Default Settlement</span>' : `<button class="text default-btn" data-id="${u.id}">Make Primary</button>`}
              </span>
              <span>
                <button class="text edit-upi-btn" data-id="${u.id}">Edit</button>
                <button class="text remove-upi" data-id="${u.id}" style="color:#FCA5A5">Remove</button>
              </span>
            </div>
          </article>
        `;
      }).join('');
    }
  }

  if (linkSelect) {
    if (!upis.length) {
      linkSelect.innerHTML = '<option value="">No UPI account connected — Add one first</option>';
    } else {
      linkSelect.innerHTML = upis.map(u => `
        <option value="${u.id}" ${u.default ? 'selected' : ''}>${escapeHtml(u.upiId)} ${u.phoneNumber ? '(+91 ' + escapeHtml(u.phoneNumber) + ')' : ''} ${u.default ? '— [Primary]' : ''}</option>
      `).join('');
    }
  }
}

/* ─── Payment Link Modal ───────────────────────────────────────────────────── */
function setLinkPricingType(type) {
  const hiddenType = $('#link-type');
  const btnFixed = $('#btn-type-fixed');
  const btnOpen = $('#btn-type-open');
  const amtWrap = $('#link-amount-wrap');
  const amtInput = $('#link-amount');

  if (hiddenType) hiddenType.value = type;
  if (btnFixed && btnOpen) {
    btnFixed.classList.toggle('active', type === 'fixed');
    btnOpen.classList.toggle('active', type === 'open');
  }
  if (amtWrap) {
    if (type === 'fixed') {
      amtWrap.style.display = 'block';
      if (amtInput) amtInput.required = true;
    } else {
      amtWrap.style.display = 'none';
      if (amtInput) { amtInput.required = false; amtInput.value = ''; }
    }
  }
}

function openLinkModal() {
  if (!upis || !upis.length) {
    toast('Please connect a receiving UPI account first before creating a link!', true);
    openUpiModal(null);
    return;
  }
  const form = $('#link-form');
  if (form) form.reset();
  setLinkPricingType('fixed');

  const prefixLabel = $('#slug-prefix-label');
  if (prefixLabel) prefixLabel.textContent = (window.location.host || 'sakkupay.onrender.com') + '/pay/';

  const nameInput = $('#link-name');
  const slugInput = $('#link-slug');
  if (nameInput && slugInput) {
    nameInput.oninput = () => {
      slugInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 35);
    };
  }

  modal('link-modal', true);
}

/* Template Gallery Helpers (Phase 2) */
function templateLabel(t) {
  const map = {
    'classic': 'SakkuPay Classic',
    'minimal': 'Minimal Clean',
    'premium-dark': 'Premium Onyx',
    'modern-gradient': 'Modern Gradient',
    'compact-upi': 'UPI Express'
  };
  return map[t] || 'SakkuPay Classic';
}

function selectLinkTemplate(template) {
  const hiddenInput = $('#link-template');
  if (hiddenInput) hiddenInput.value = template;
  $$('#template-options-grid .template-option-card').forEach(card => {
    card.classList.toggle('active', card.dataset.template === template);
  });
}

function previewCurrentTemplate() {
  const template = $('#link-template')?.value || 'classic';
  const name = ($('#link-name')?.value || '').trim() || 'Sample Product Checkout';
  const amountVal = $('#link-amount')?.value;
  const type = $('#link-type')?.value || 'fixed';
  const amountStr = type === 'fixed' && Number(amountVal) > 0 ? money(Number(amountVal)) : 'Customer Decides';

  renderInteractivePreview(template, name, amountStr);
}

function openSwitchTemplateModal(id) {
  const l = links.find(x => x.id === id);
  if (!l) return;
  const idInput = $('#switch-template-link-id');
  const nameLabel = $('#switch-template-link-name');
  const selInput = $('#switch-template-selected');

  if (idInput) idInput.value = l.id;
  if (nameLabel) nameLabel.textContent = l.name;
  const currentTemplate = l.template || 'classic';
  if (selInput) selInput.value = currentTemplate;

  $$('#switch-template-options-grid .template-option-card').forEach(card => {
    card.classList.toggle('active', card.dataset.template === currentTemplate);
  });

  modal('template-modal', true);
}

function selectSwitchTemplate(t) {
  const selInput = $('#switch-template-selected');
  if (selInput) selInput.value = t;
  $$('#switch-template-options-grid .template-option-card').forEach(card => {
    card.classList.toggle('active', card.dataset.template === t);
  });
}

async function saveSwitchedTemplate() {
  const id = $('#switch-template-link-id')?.value;
  const template = $('#switch-template-selected')?.value || 'classic';
  if (!id) return;

  const btn = $('#save-switch-template-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await api('/links/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ template })
    });
    modal('template-modal', false);
    toast('🎉 Checkout template updated successfully!');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Apply Template Changes'; }
  }
}

function renderInteractivePreview(template, name, amountStr) {
  const container = $('#template-preview-container');
  if (!container) return;

  const bizName = currentProfile?.businessName || 'SakkuPay Merchant';
  const isMinimal = template === 'minimal';
  const isDark = template === 'premium-dark';
  const isGradient = template === 'modern-gradient';

  container.innerHTML = `
    <div style="padding:26px 20px;text-align:center;background:${isMinimal ? '#FFFFFF' : isDark ? '#0D1117' : isGradient ? 'rgba(22, 27, 46, 0.95)' : '#111827'};color:${isMinimal ? '#0F172A' : '#FFFFFF'}">
      <div style="display:flex;justify-content:center;gap:6px;margin-bottom:12px">
        <span class="template-badge">${templateLabel(template)}</span>
        <span class="upi-secure-badge">● Direct UPI</span>
      </div>
      <p style="font-size:11px;font-weight:700;color:${isMinimal ? '#64748B' : 'var(--muted)'};margin:0;text-transform:uppercase;letter-spacing:1px">PAYING TO</p>
      <h3 style="font-size:14px;margin:2px 0 6px;color:${isMinimal ? '#0F172A' : isDark ? '#10B981' : isGradient ? '#C084FC' : '#818CF8'}">${escapeHtml(bizName)}</h3>
      <h2 style="font-size:19px;font-weight:800;margin:0 0 14px;color:${isMinimal ? '#0F172A' : '#FFFFFF'}">${escapeHtml(name)}</h2>

      <div style="background:${isMinimal ? '#F8FAFC' : isDark ? 'rgba(16,185,129,0.06)' : isGradient ? 'rgba(255,255,255,0.05)' : '#161F30'};border:1.5px ${isGradient ? 'dashed' : 'solid'} ${isMinimal ? '#E2E8F0' : isDark ? 'rgba(16,185,129,0.3)' : isGradient ? 'rgba(192,132,252,0.4)' : 'rgba(255,255,255,0.1)'};border-radius:14px;padding:12px;margin-bottom:14px">
        <span style="font-size:10px;text-transform:uppercase;color:${isMinimal ? '#64748B' : 'var(--muted)'};font-weight:700;display:block;margin-bottom:2px">AMOUNT TO PAY</span>
        <strong style="font-size:26px;font-weight:800;color:${isMinimal ? '#0F172A' : isDark ? '#34D399' : isGradient ? '#F472B6' : '#FFFFFF'}">${amountStr}</strong>
      </div>

      <div style="width:120px;height:120px;margin:0 auto 14px;background:#FFFFFF;border-radius:12px;padding:8px;display:grid;place-items:center;box-shadow:0 4px 14px rgba(0,0,0,0.3)">
        <div style="font-size:10.5px;font-weight:700;color:#0F172A;text-align:center">📱 Dynamic UPI QR</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">
        <div style="padding:6px 2px;border-radius:6px;background:${isMinimal ? '#F1F5F9' : '#161F30'};font-size:10.5px;font-weight:700">GPay</div>
        <div style="padding:6px 2px;border-radius:6px;background:${isMinimal ? '#F1F5F9' : '#161F30'};font-size:10.5px;font-weight:700">PhonePe</div>
        <div style="padding:6px 2px;border-radius:6px;background:${isMinimal ? '#F1F5F9' : '#161F30'};font-size:10.5px;font-weight:700">Paytm</div>
        <div style="padding:6px 2px;border-radius:6px;background:${isMinimal ? '#F1F5F9' : '#161F30'};font-size:10.5px;font-weight:700">BHIM</div>
      </div>
    </div>
  `;

  modal('template-preview-modal', true);
}

/* Link Form Submit */
const linkForm = $('#link-form');
if (linkForm) {
  linkForm.onsubmit = async e => {
    e.preventDefault();
    const name = ($('#link-name')?.value || '').trim();
    const description = ($('#link-description')?.value || '').trim();
    const type = $('#link-type')?.value || 'fixed';
    const amountVal = $('#link-amount')?.value;
    const slug = ($('#link-slug')?.value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const upiId = $('#link-upi-select')?.value;
    const template = $('#link-template')?.value || 'classic';

    if (!name) { toast('Please provide a title for what you are collecting for.', true); return; }
    if (type === 'fixed' && (!amountVal || Number(amountVal) <= 0)) { toast('Please enter a valid fixed amount in Rupees (₹).', true); return; }
    if (!slug) { toast('Please provide a custom URL slug.', true); return; }

    const submitBtn = $('#link-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Generating…'; }

    try {
      const payload = {
        name,
        description,
        amountType: type,
        amount: type === 'fixed' ? Number(amountVal) : null,
        slug,
        upiId,
        template
      };
      const created = await api('/links', { method: 'POST', body: JSON.stringify(payload) });
      toast('🎉 Payment link generated successfully!');
      modal('link-modal', false);
      await refresh();
      if (created) showQrModal(created);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Generate Payment Link & QR →'; }
    }
  };
}

/* ─── Render Payment Links ─────────────────────────────────────────────────── */
function renderLinks() {
  const tbody = $('#link-table');
  if (!tbody) return;

  const query = ($('#link-search-input')?.value || '').toLowerCase().trim();
  const statusFilter = $('#link-status-filter')?.value || 'all';
  const origin = window.location.origin || 'https://sakkupay.onrender.com';

  let filtered = links.filter(l => {
    if (query && !`${l.name} ${l.slug} ${l.amount || ''} ${l.template || ''}`.toLowerCase().includes(query)) return false;
    if (statusFilter === 'active' && !l.active) return false;
    if (statusFilter === 'inactive' && l.active) return false;
    return true;
  });

  if (!filtered.length) {
    if (!links.length) {
      tbody.innerHTML = `
        <tr><td colspan="7" style="padding:0">
          <div class="empty-placeholder">
            <div class="empty-icon-wrap">↗</div>
            <h3>No payment links created yet</h3>
            <p>Create your first custom payment link to start receiving direct UPI payments with 0% gateway commission.</p>
            <button class="primary" onclick="openLinkModal()" style="margin-top:16px;padding:10px 22px;font-size:13px;border-radius:10px">+ Create Your First Payment Link</button>
          </div>
        </td></tr>
      `;
    } else {
      tbody.innerHTML = `
        <tr><td colspan="7" style="padding:0">
          <div class="empty-placeholder">
            <div class="empty-icon-wrap" style="color:#A5B4FC">⌕</div>
            <h3>No matching payment links found</h3>
            <p>We couldn't find any links matching your current search query or filter.</p>
            <button class="outline" onclick="$('#link-search-input').value=''; $('#link-status-filter').value='all'; renderLinks();" style="margin-top:16px;padding:8px 18px">Reset Filters</button>
          </div>
        </td></tr>
      `;
    }
  } else {
    tbody.innerHTML = filtered.map(l => {
      const collected = (allTransactions || []).filter(t => t.linkId === l.id && t.status === 'success').reduce((s, t) => s + (t.amount || 0), 0);
      const statusBadge = l.active
        ? '<span class="pill success"><span class="dot"></span> Active</span>'
        : '<span class="pill inactive"><span class="dot"></span> Inactive</span>';
      const templateName = l.template || 'classic';
      const templateBadge = `<span class="pill" style="background:rgba(99,102,241,0.12);color:#A5B4FC;border:1px solid rgba(99,102,241,0.25)">🎨 ${escapeHtml(templateLabel(templateName))}</span>`;

      return `
        <tr>
          <td>
            <b>${escapeHtml(l.name)}</b><br>
            <small class="muted" style="font-family:monospace">${origin}/pay/${escapeHtml(l.slug)}</small>
          </td>
          <td>${templateBadge}</td>
          <td>${l.amountType === 'fixed' ? 'Fixed Price' : 'Customer Decides'}</td>
          <td><b>${l.amount ? money(l.amount) : 'Open Amount'}</b></td>
          <td><b style="color:#10B981">${money(collected)}</b></td>
          <td>${statusBadge}</td>
          <td>
            <button class="text copy-link" data-slug="${l.slug}" data-id="${l.id}">Copy Link</button>
            <button class="text view-qr" data-id="${l.id}">QR Code</button>
            <button class="text change-template" data-id="${l.id}">Template</button>
            <button class="text preview" data-slug="${l.slug}">Preview ↗</button>
            <button class="text toggle-link" data-id="${l.id}" data-active="${l.active}">${l.active ? 'Deactivate' : 'Activate'}</button>
            <button class="text delete-link" data-id="${l.id}" style="color:#FCA5A5">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  const activeCount = links.filter(x => x.active).length;
  if ($('#active-links')) $('#active-links').textContent = activeCount;
}

/* ─── QR Modal ─────────────────────────────────────────────────────────────── */
function showQrModal(l) {
  if (!l) return;
  const qrContainer = $('#modal-qrcode');
  if (!qrContainer) return;
  qrContainer.innerHTML = '';

  const originUrl = window.location.origin || 'https://sakkupay.onrender.com';
  const fullUrl = `${originUrl}/pay/${l.slug}`;

  if ($('#qr-modal-title')) $('#qr-modal-title').textContent = l.name;
  if ($('#qr-modal-sub')) $('#qr-modal-sub').textContent = `Checkout link ready for ${l.name}`;
  if ($('#qr-modal-url')) $('#qr-modal-url').value = fullUrl;
  if ($('#qr-modal-open-link')) $('#qr-modal-open-link').href = fullUrl;

  const amtPill = $('#qr-modal-amount-pill');
  if (amtPill) {
    amtPill.innerHTML = l.amountType === 'fixed'
      ? `<span class="dot"></span> Fixed Amount: ${money(l.amount)}`
      : '<span class="dot"></span> Customer Decides Amount (Open)';
  }

  const upiId = l.upiId || (upis.find(u => u.default)?.upiId) || (upis[0]?.upiId) || '';
  if ($('#qr-modal-upi-pill')) $('#qr-modal-upi-pill').textContent = 'Direct UPI: ' + (upiId || 'Connected Bank');
  if ($('#qr-modal-template-pill')) $('#qr-modal-template-pill').textContent = 'Template: ' + (l.template ? (l.template.charAt(0).toUpperCase() + l.template.slice(1)) : 'Classic');

  if (window.QRCode) {
    // Generate QR code directly from the actual payment URL returned by the backend (Phase 5)
    new QRCode(qrContainer, { text: fullUrl, width: 190, height: 190, colorDark: '#0B0F17', colorLight: '#FFFFFF', correctLevel: QRCode.CorrectLevel.H });
  }

  const dlBtn = $('#modal-download-qr-btn');
  if (dlBtn) {
    dlBtn.onclick = () => {
      const img = $('#modal-qrcode img') || $('#modal-qrcode canvas');
      if (!img) return;
      const a = document.createElement('a');
      a.href = img.tagName === 'CANVAS' ? img.toDataURL('image/png') : img.src;
      a.download = `sakkupay-${l.slug}-qr.png`;
      a.click();
    };
  }

  const copyBtn = $('#qr-modal-copy-btn');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(fullUrl);
        triggerButtonCopyFeedback(copyBtn, 'Copy Link');
        toast('Payment link URL copied to clipboard!');
      }
    };
  }

  modal('qr-modal', true);
}

/* ─── Transactions ─────────────────────────────────────────────────────────── */
async function loadTransactions() {
  const range = $('#tx-range-select')?.value || 'month';
  try {
    allTransactions = await api(`/transactions?range=${range}&status=all`);
    updateTransactionTabCounts();
    filterTransactionsLocal();
  } catch (err) {
    console.error('Failed to load transactions:', err);
  }
}

function updateTransactionTabCounts() {
  if ($('#count-all')) $('#count-all').textContent = allTransactions.length;
  if ($('#count-success')) $('#count-success').textContent = allTransactions.filter(t => t.status === 'success').length;
  if ($('#count-pending')) $('#count-pending').textContent = allTransactions.filter(t => t.status === 'pending').length;
  if ($('#count-failed')) $('#count-failed').textContent = allTransactions.filter(t => t.status === 'failed').length;
}

function filterTransactionsLocal() {
  const tbody = $('#transaction-table');
  if (!tbody) return;

  const activeTab = $('.tabs button.active');
  const tabFilter = activeTab?.dataset.filter || 'all';
  const query = ($('#tx-search-input')?.value || '').toLowerCase().trim();

  let filtered = allTransactions.filter(t => {
    if (tabFilter !== 'all' && t.status !== tabFilter) return false;
    if (query) {
      const searchBlob = `${t.reference} ${t.customerName} ${t.customerEmail} ${t.utr || ''} ${t.amount}`.toLowerCase();
      if (!searchBlob.includes(query)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr><td colspan="6" style="padding:0">
        <div class="empty-placeholder">
          <div class="empty-icon-wrap">▣</div>
          <h3>No transactions recorded</h3>
          <p>${allTransactions.length === 0 ? 'Customer payment records will automatically stream here in real time.' : 'No transactions match the selected tab or search query.'}</p>
        </div>
      </td></tr>
    `;
  } else {
    tbody.innerHTML = filtered.map(t => `
      <tr>
        <td>${customer(t)}</td>
        <td><b>${money(t.amount)}</b></td>
        <td>${pill(t.status, t.verifiedBy, t.reconciliationStatus, t.ambiguityReason)}</td>
        <td><code style="font-family:monospace;font-size:12px">${escapeHtml(t.utr || '—')}</code></td>
        <td>${time(t.createdAt)}</td>
        <td>
          <button class="btn btn-sm btn-outline view-tx-detail" data-id="${t.id}" style="padding:4px 10px;font-size:11.5px">View Details →</button>
        </td>
      </tr>
    `).join('');
  }

  // Render top 5 in Overview's recent table
  const recent = $('#recent');
  if (recent) {
    const top5 = allTransactions.slice(0, 5);
    if (!top5.length) {
      recent.innerHTML = `
        <tr><td colspan="6" style="padding:0">
          <div class="empty-placeholder" style="padding:32px 16px">
            <div class="empty-icon-wrap" style="width:44px;height:44px;font-size:18px;margin-bottom:10px">⏱</div>
            <h3 style="font-size:15px">Awaiting your first payment</h3>
            <p style="font-size:12.5px">When customers pay through your links, live transaction records will stream here.</p>
          </div>
        </td></tr>
      `;
    } else {
      recent.innerHTML = top5.map(t => {
        const lnk = links.find(l => l.id === t.linkId);
        return `
          <tr>
            <td>${customer(t)}</td>
            <td>${escapeHtml(lnk?.name || 'Payment Link')}</td>
            <td><b>${money(t.amount)}</b></td>
            <td>${pill(t.status, t.verifiedBy, t.reconciliationStatus, t.ambiguityReason)}</td>
            <td>${time(t.createdAt)}</td>
            <td>
              <button class="btn btn-sm btn-outline view-tx-detail" data-id="${t.id}" style="padding:3px 8px;font-size:11px">Inspect →</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }
}

/* Tab click wiring */
$$('.tabs button').forEach(btn => {
  btn.onclick = () => {
    $$('.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterTransactionsLocal();
  };
});

/* ─── CSV Export ───────────────────────────────────────────────────────────── */
function exportTransactionsCSV() {
  const activeTab = $('.tabs button.active');
  const tabFilter = activeTab?.dataset.filter || 'all';
  const query = ($('#tx-search-input')?.value || '').toLowerCase().trim();

  const listToExport = (allTransactions || []).filter(t => {
    if (tabFilter !== 'all' && t.status !== tabFilter) return false;
    if (query) {
      const searchBlob = `${t.reference} ${t.customerName} ${t.customerEmail} ${t.utr || ''} ${t.amount}`.toLowerCase();
      if (!searchBlob.includes(query)) return false;
    }
    return true;
  });

  if (!listToExport.length) { toast('No matching transactions available to export.', true); return; }

  const headers = ['Reference ID', 'Customer Name', 'Customer Email / Handle', 'Amount (INR)', 'Status', 'Verification Method', 'UTR Number', 'Date & Time'];
  const rows = listToExport.map(t => [
    `"${(t.reference || '').replace(/"/g, '""')}"`,
    `"${(t.customerName || '').replace(/"/g, '""')}"`,
    `"${(t.customerEmail || '').replace(/"/g, '""')}"`,
    t.amount || 0,
    t.status || '',
    `"${(t.verifiedBy || (t.status === 'success' ? 'verified' : 'pending')).replace(/"/g, '""')}"`,
    `"${(t.utr || '').replace(/"/g, '""')}"`,
    `"${new Date(t.createdAt).toLocaleString('en-IN')}"`
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
  const a = document.createElement('a');
  a.setAttribute('href', encodeURI(csvContent));
  a.setAttribute('download', `sakkupay-transactions-${tabFilter}-${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`Exported ${listToExport.length} transaction(s) to CSV!`);
}

/* ─── Delegated Table Click Handlers ──────────────────────────────────────── */
document.addEventListener('click', async e => {
  const id = e.target.dataset.id;

  if (e.target.classList.contains('view-qr')) {
    const l = links.find(x => x.id === id);
    if (l) showQrModal(l);
  }

  if (e.target.classList.contains('change-template')) {
    openSwitchTemplateModal(id);
  }

  if (e.target.classList.contains('copy-link')) {
    const slug = e.target.dataset.slug;
    const origin = window.location.origin || 'https://sakkupay.onrender.com';
    const linkUrl = `${origin}/pay/${slug}`;
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(linkUrl);
      triggerButtonCopyFeedback(e.target, 'Copy Link');
      toast('Payment link URL copied to clipboard!');
    }
  }

  if (e.target.classList.contains('preview')) {
    window.open('/pay/' + e.target.dataset.slug, '_blank');
  }

  if (e.target.classList.contains('toggle-link')) {
    try {
      await api('/links/' + id, { method: 'PATCH', body: JSON.stringify({ active: e.target.dataset.active !== 'true' }) });
      await refresh();
      toast('Payment link status updated.');
    } catch (err) { toast(err.message, true); }
  }

  if (e.target.classList.contains('delete-link')) {
    if (confirm('Permanently delete this payment link?')) {
      try {
        await api('/links/' + id, { method: 'DELETE' });
        await refresh();
        toast('Payment link deleted.');
      } catch (err) { toast(err.message, true); }
    }
  }

  if (e.target.classList.contains('default-btn')) {
    try {
      await api('/upis/' + id + '/default', { method: 'PATCH', body: JSON.stringify({ default: true }) });
      await refresh();
      toast('Primary receiving UPI account updated.');
    } catch (err) { toast(err.message, true); }
  }

  if (e.target.classList.contains('edit-upi-btn')) {
    const u = upis.find(x => x.id === id);
    if (u) openUpiModal(u);
  }

  if (e.target.classList.contains('remove-upi')) {
    if (confirm('Disconnect and remove this receiving UPI account?')) {
      try {
        await api('/upis/' + id, { method: 'DELETE' });
        await refresh();
        toast('UPI account removed.');
      } catch (err) { toast(err.message, true); }
    }
  }

  if (e.target.classList.contains('mark-paid-btn')) {
    toast('Direct merchant approval is restricted. Payments must be verified via companion webhook or payment gateway.', true);
  }

  if (e.target.classList.contains('view-tx-detail')) {
    openTransactionDetail(id);
  }
});

/* ─── Transaction Detail Drawer (Forensic Inspection) ─────────────────────── */
function openTransactionDetail(txId) {
  const t = allTransactions.find(x => x.id === txId);
  if (!t) return;

  if ($('#dtl-ref')) $('#dtl-ref').textContent = t.reference || t.id;

  const copyRefBtn = $('#dtl-copy-ref-btn');
  if (copyRefBtn) {
    copyRefBtn.onclick = async () => {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(t.reference || t.id);
        triggerButtonCopyFeedback(copyRefBtn, 'Copy Ref');
        toast('Reference ID copied to clipboard');
      }
    };
  }

  // Badges
  if ($('#dtl-status-pill')) {
    $('#dtl-status-pill').innerHTML = pill(t.status, t.verifiedBy, t.reconciliationStatus, t.ambiguityReason);
  }

  const reconPill = $('#dtl-recon-pill');
  if (reconPill) {
    const rStatus = t.reconciliationStatus || 'unreconciled';
    if (rStatus === 'settled') {
      reconPill.innerHTML = '<span class="pill success" style="font-size:11px"><span class="dot"></span> Reconciliation: Settled</span>';
    } else if (rStatus === 'flagged_ambiguous') {
      reconPill.innerHTML = '<span class="pill ambiguous" style="font-size:11px"><span class="dot"></span> Ambiguous Match</span>';
    } else if (rStatus === 'unverified_evidence') {
      reconPill.innerHTML = '<span class="pill unverified" style="font-size:11px"><span class="dot"></span> Unconfirmed UTR Evidence</span>';
    } else {
      reconPill.innerHTML = '<span class="pill unreconciled" style="font-size:11px"><span class="dot"></span> Unreconciled</span>';
    }
  }

  // Ambiguity notice box
  const ambBox = $('#dtl-ambiguity-box');
  const ambMsg = $('#dtl-ambiguity-msg');
  if (ambBox && ambMsg) {
    if (t.reconciliationStatus === 'flagged_ambiguous' || t.ambiguityReason) {
      ambBox.style.display = 'block';
      ambMsg.textContent = t.ambiguityReason || 'Multiple candidate orders matched this amount or an underpayment was detected.';
    } else if (t.reconciliationStatus === 'unverified_evidence') {
      ambBox.style.display = 'block';
      ambMsg.textContent = 'Customer submitted a UTR reference number. Awaiting bank webhook confirmation before status transitions to success.';
    } else {
      ambBox.style.display = 'none';
    }
  }

  // Amount & Paise
  if ($('#dtl-amount')) $('#dtl-amount').textContent = money(t.amount);
  const paise = Number.isFinite(t.amount_paise) ? t.amount_paise : Math.round((t.amount || 0) * 100);
  if ($('#dtl-paise')) $('#dtl-paise').textContent = `${paise.toLocaleString('en-IN')} paise exact`;

  // UTR & copy
  if ($('#dtl-utr')) $('#dtl-utr').textContent = t.utr || 'None submitted';
  const copyUtrBtn = $('#dtl-copy-utr-btn');
  if (copyUtrBtn) {
    copyUtrBtn.style.display = t.utr ? 'inline-flex' : 'none';
    copyUtrBtn.onclick = async () => {
      if (t.utr && navigator.clipboard) {
        await navigator.clipboard.writeText(t.utr);
        triggerButtonCopyFeedback(copyUtrBtn, 'Copy');
        toast('UTR number copied to clipboard');
      }
    };
  }

  const utrStatus = $('#dtl-utr-status');
  if (utrStatus) {
    if (!t.utr) utrStatus.textContent = 'Awaiting payment';
    else if (t.status === 'success') utrStatus.textContent = 'Verified & settled';
    else if (t.reconciliationStatus === 'unverified_evidence') utrStatus.textContent = 'Customer submitted (unverified)';
    else utrStatus.textContent = 'Under review';
  }

  // Details
  if ($('#dtl-customer-name')) $('#dtl-customer-name').textContent = t.customerName || 'UPI Customer';
  if ($('#dtl-customer-contact')) $('#dtl-customer-contact').textContent = t.customerEmail || '—';
  if ($('#dtl-customer-upi')) $('#dtl-customer-upi').textContent = t.customerUpi || '—';
  if ($('#dtl-verified-by')) $('#dtl-verified-by').textContent = t.verifiedBy ? `${t.verifiedBy}` : (t.status === 'success' ? 'Automated Gateway' : 'Pending Verification');
  if ($('#dtl-created-at')) $('#dtl-created-at').textContent = time(t.createdAt);

  const paidRow = $('#dtl-paid-row');
  if (paidRow) {
    if (t.paidAt) {
      paidRow.style.display = 'flex';
      if ($('#dtl-paid-at')) $('#dtl-paid-at').textContent = time(t.paidAt);
    } else {
      paidRow.style.display = 'none';
    }
  }

  const utrSubRow = $('#dtl-utr-sub-row');
  if (utrSubRow) {
    if (t.utrSubmittedAt) {
      utrSubRow.style.display = 'flex';
      if ($('#dtl-utr-sub-at')) $('#dtl-utr-sub-at').textContent = time(t.utrSubmittedAt);
    } else {
      utrSubRow.style.display = 'none';
    }
  }

  // Merchant internal note
  const noteInput = $('#dtl-merchant-note-input');
  if (noteInput) noteInput.value = t.merchantNote || '';

  const saveNoteBtn = $('#dtl-save-note-btn');
  if (saveNoteBtn) {
    saveNoteBtn.onclick = async () => {
      saveNoteBtn.disabled = true;
      saveNoteBtn.textContent = 'Saving…';
      try {
        const noteVal = (noteInput.value || '').trim();
        const updated = await api(`/transactions/${t.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ note: noteVal })
        });
        t.merchantNote = updated.merchantNote || noteVal;
        toast('Merchant note saved successfully.');
      } catch (err) {
        toast(err.message, true);
      } finally {
        saveNoteBtn.disabled = false;
        saveNoteBtn.textContent = 'Save Note';
      }
    };
  }

  // Checkout page link
  const chkLink = $('#dtl-checkout-link');
  if (chkLink) {
    const lnk = links.find(l => l.id === t.linkId);
    if (lnk && lnk.slug) {
      chkLink.href = `/pay/${lnk.slug}?ref=${encodeURIComponent(t.reference || t.id)}`;
      chkLink.style.display = 'inline-flex';
    } else {
      chkLink.style.display = 'none';
    }
  }

  modal('tx-detail-modal', true);
}

/* ─── Companion App Wiring ─────────────────────────────────────────────────── */
const copyMerchantIdBtn = $('#copy-merchant-id-btn');
if (copyMerchantIdBtn) {
  copyMerchantIdBtn.onclick = () => {
    const text = $('#companion-merchant-id')?.textContent?.trim();
    if (text && text !== '—') {
      navigator.clipboard?.writeText(text);
      triggerButtonCopyFeedback(copyMerchantIdBtn, 'Copy');
      toast('Merchant ID copied to clipboard!');
    }
  };
}

const copyWebhookUrlBtn = $('#copy-webhook-url-btn');
if (copyWebhookUrlBtn) {
  copyWebhookUrlBtn.onclick = () => {
    const text = $('#companion-server-url')?.textContent?.trim();
    if (text && text !== '—') {
      navigator.clipboard?.writeText(text);
      triggerButtonCopyFeedback(copyWebhookUrlBtn, 'Copy');
      toast('Webhook URL copied to clipboard!');
    }
  };
}

const directVerifyForm = $('#direct-verify-form');
if (directVerifyForm) {
  directVerifyForm.onsubmit = async e => {
    e.preventDefault();
    const ref = $('#direct-verify-ref')?.value?.trim();
    const utr = $('#direct-verify-utr')?.value?.trim();
    if (!ref) return;

    const btn = $('#direct-verify-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

    try {
      await api('/business-accounts/direct-verify', {
        method: 'POST',
        body: JSON.stringify({ reference: ref, transactionId: ref, utr })
      });
      toast('✅ Transaction verified successfully!');
      $('#direct-verify-ref').value = '';
      if ($('#direct-verify-utr')) $('#direct-verify-utr').value = '';
      await refresh();
    } catch (err) {
      toast('Verification notice: ' + err.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Verify Transaction'; }
    }
  };
}

/* ─── Developer API Keys ───────────────────────────────────────────────────── */
async function loadApiKeys() {
  const container = $('#keys-list-container');
  if (!container) return;
  try {
    const keys = await api('/keys');
    if (!keys || !keys.length) {
      container.innerHTML = `
        <div style="padding:16px 0;text-align:center;color:var(--muted);font-size:13px">
          No active API keys generated yet. Click "+ Generate New Key" above to create one.
        </div>
      `;
      return;
    }
    container.innerHTML = keys.map(k => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--card-inner);border:1px solid var(--line);border-radius:10px;margin-bottom:8px;gap:12px">
        <div>
          <code style="font-family:monospace;color:#FFFFFF;font-weight:600">${escapeHtml(k.prefix)}••••••••</code>
          <div style="font-size:11px;color:var(--muted);margin-top:3px">
            Created ${time(k.createdAt)} · ${k.lastUsedAt ? 'Last used ' + time(k.lastUsedAt) : 'Never used'}
          </div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="revokeApiKey('${k.id}')">Revoke</button>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div style="color:#EF4444;font-size:12px">Failed to load API keys: ${escapeHtml(err.message)}</div>`;
  }
}

async function generateApiKey() {
  try {
    const newKey = await api('/keys', { method: 'POST' });
    loadApiKeys();
    if ($('#new-key-display')) $('#new-key-display').textContent = newKey.key;
    const copyKeyBtn = $('#copy-new-key-btn');
    if (copyKeyBtn) {
      copyKeyBtn.onclick = () => {
        navigator.clipboard?.writeText(newKey.key);
        triggerButtonCopyFeedback(copyKeyBtn, 'Copy Key');
        toast('API key copied to clipboard!');
      };
    }
    modal('api-key-modal', true);
  } catch (err) {
    toast('Failed to generate key: ' + err.message, true);
  }
}

async function revokeApiKey(keyId) {
  if (!confirm('Revoke this API key? Any bots or external stores using this key will be disconnected.')) return;
  try {
    await api('/keys/' + keyId, { method: 'DELETE' });
    toast('API key revoked.');
    loadApiKeys();
  } catch (err) {
    toast('Error revoking key: ' + err.message, true);
  }
}

/* ─── Profile UI & Settings Tabs ─────────────────────────────────────────── */
function switchSettingsTab(tab) {
  const isProfile = tab === 'profile';
  $('#tab-btn-profile')?.classList.toggle('active', isProfile);
  $('#tab-btn-profile')?.setAttribute('aria-selected', isProfile ? 'true' : 'false');
  $('#tab-btn-security')?.classList.toggle('active', !isProfile);
  $('#tab-btn-security')?.setAttribute('aria-selected', !isProfile ? 'true' : 'false');

  $('#settings-tab-profile')?.classList.toggle('active', isProfile);
  $('#settings-tab-security')?.classList.toggle('active', !isProfile);
}

function updateProfilePreview() {
  const bName = ($('#business-name')?.value || '').trim() || currentProfile?.businessName || 'Merchant Store';
  const sEmail = ($('#support-email')?.value || '').trim() || currentProfile?.supportEmail || 'support@yourstore.in';
  const waNum = ($('#whatsapp-number')?.value || '').trim() || currentProfile?.whatsappNumber || 'Not configured';

  const avatarText = bName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'SK';

  if ($('#preview-avatar')) $('#preview-avatar').textContent = avatarText;
  if ($('#preview-biz-name')) $('#preview-biz-name').textContent = bName;
  if ($('#preview-support-email')) $('#preview-support-email').textContent = sEmail;
  if ($('#preview-whatsapp')) $('#preview-whatsapp').textContent = waNum;
}

let previewDebounceTimer = null;
function updateProfilePreviewDebounced() {
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(updateProfilePreview, 100);
}

function copyMerchantId() {
  const id = currentProfile?.id || $('#sec-id')?.textContent;
  if (!id || id === '—') return;
  const btn = $('#btn-copy-merchant-id');
  navigator.clipboard?.writeText(id).then(() => {
    triggerButtonCopyFeedback(btn, 'Copy ID');
    toast('Merchant ID copied to clipboard!');
  }).catch(() => {
    toast('Merchant ID: ' + id);
  });
}

function updateProfileUI(profile) {
  if (!profile) return;
  currentProfile = profile;

  // Workspace badge
  const wsName = $('#ws-name');
  const wsAvatar = $('#ws-avatar');
  if (wsName && profile.businessName) wsName.textContent = profile.businessName;
  if (wsAvatar && profile.businessName) {
    wsAvatar.textContent = profile.businessName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'SK';
  }

  // Sidebar profile
  const profName = $('#user-display-name');
  const profEmail = $('#user-display-email');
  const profAvatar = $('#user-avatar');
  if (profName && profile.businessName) profName.textContent = profile.businessName;
  if (profEmail && profile.email) profEmail.textContent = profile.email;
  if (profAvatar && profile.businessName) {
    profAvatar.textContent = profile.businessName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'AS';
  }

  // Topbar merchant name
  const headerName = $('#header-merchant-name');
  if (headerName && profile.businessName) headerName.textContent = profile.businessName;

  // Overview greeting
  const greeting = $('#overview-greeting');
  if (greeting && profile.businessName) greeting.textContent = `Welcome back, ${profile.businessName} 👋`;

  // Companion app info
  const compId = $('#companion-merchant-id');
  const compUrl = $('#companion-server-url');
  if (compId && profile.id) compId.textContent = profile.id;
  if (compUrl) compUrl.textContent = `${window.location.origin}/api/v1/webhook/verify-payment`;

  // Settings page inputs
  const bname = $('#business-name');
  const email = $('#support-email');
  const desc = $('#business-description');
  const wanum = $('#whatsapp-number');
  if (bname && profile.businessName) bname.value = profile.businessName;
  if (email && profile.supportEmail) email.value = profile.supportEmail;
  if (desc && profile.description) desc.value = profile.description;
  if (wanum && profile.whatsappNumber) wanum.value = profile.whatsappNumber;

  // Update checkout branding preview card
  updateProfilePreview();

  // Security card
  if ($('#sec-email')) $('#sec-email').textContent = profile.email || '—';
  if ($('#sec-id')) $('#sec-id').textContent = profile.id || '—';
  if ($('#sec-created')) $('#sec-created').textContent = time(profile.createdAt);
}

/* ─── Save Settings ────────────────────────────────────────────────────────── */
async function saveSettings() {
  const saveBtn = $('#save-settings-btn');
  const feedbackEl = $('#profile-inline-feedback');
  if (feedbackEl) {
    feedbackEl.style.display = 'none';
    feedbackEl.className = 'feedback-banner';
    feedbackEl.textContent = '';
  }

  const bName = ($('#business-name')?.value || '').trim();
  const sEmail = ($('#support-email')?.value || '').trim();
  const waRaw = ($('#whatsapp-number')?.value || '').replace(/\D/g, '');

  function showInlineError(msg) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.background = 'rgba(239, 68, 68, 0.12)';
      feedbackEl.style.border = '1px solid rgba(239, 68, 68, 0.3)';
      feedbackEl.style.color = '#FCA5A5';
      feedbackEl.textContent = '⚠ ' + msg;
    }
    toast(msg, true);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Profile Changes'; }
  }

  if (bName.length < 2) {
    showInlineError('Business display name must be at least 2 characters long.');
    return;
  }

  if (sEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sEmail)) {
    showInlineError('Please enter a valid customer support email address.');
    return;
  }

  if (waRaw && !/^\d{10}$/.test(waRaw)) {
    showInlineError('Please enter a valid 10-digit mobile number.');
    return;
  }

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  const body = {
    businessName: bName,
    supportEmail: sEmail,
    description: ($('#business-description')?.value || '').trim(),
    whatsappNumber: waRaw
  };

  try {
    const updated = await api('/profile', { method: 'PUT', body: JSON.stringify(body) });
    updateProfileUI(updated);
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.background = 'rgba(16, 185, 129, 0.12)';
      feedbackEl.style.border = '1px solid rgba(16, 185, 129, 0.3)';
      feedbackEl.style.color = '#6EE7B7';
      feedbackEl.textContent = '✓ Business profile saved successfully. Public checkout pages updated.';
    }
    toast('🎉 Business profile updated successfully!');
  } catch (err) {
    showInlineError(err.message || 'Failed to update business profile.');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Profile Changes'; }
  }
}

/* ─── Merchant Support Queries (Phase 4) ───────────────────────────────────── */
async function submitSupportQuery() {
  const btn = $('#support-submit-btn');
  const feedback = $('#support-submit-feedback');
  const category = $('#support-query-category')?.value || 'general';
  const subject = ($('#support-query-subject')?.value || '').trim();
  const message = ($('#support-query-message')?.value || '').trim();

  if (!subject) { toast('Please enter a subject for your inquiry.', true); return; }
  if (!message) { toast('Please write your support message.', true); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  if (feedback) feedback.textContent = '';

  try {
    const res = await api('/support/query', {
      method: 'POST',
      body: JSON.stringify({ category, subject, message })
    });
    toast(`Inquiry registered successfully! Ticket #${res.ticketId}`);
    if (feedback) {
      feedback.style.color = '#34D399';
      feedback.textContent = `✓ Ticket #${res.ticketId} Created`;
    }
    const subjEl = $('#support-query-subject');
    const msgEl = $('#support-query-message');
    if (subjEl) subjEl.value = '';
    if (msgEl) msgEl.value = '';
    await loadSupportQueries();
  } catch (err) {
    toast(err.message, true);
    if (feedback) {
      feedback.style.color = '#F87171';
      feedback.textContent = 'Submission failed';
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Support Inquiry →'; }
  }
}

async function loadSupportQueries() {
  const container = $('#support-ticket-list');
  if (!container) return;

  try {
    const list = await api('/support/queries');
    if (!Array.isArray(list) || !list.length) {
      container.innerHTML = '<p style="font-size:12px;color:var(--muted);margin:0">No registered support inquiries. Submit an inquiry above if you require engineering assistance.</p>';
      return;
    }

    container.innerHTML = list.map(q => `
      <div style="background:var(--card-inner);border:1px solid var(--line);border-radius:10px;padding:12px 14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-family:monospace;font-size:11.5px;color:#A5B4FC;font-weight:700">#${escapeHtml(q.id)}</span>
          <span class="pill" style="font-size:10px;padding:2px 8px;background:rgba(99,102,241,0.15);color:#A5B4FC">${escapeHtml(q.status || 'open')}</span>
        </div>
        <strong style="font-size:13px;color:#FFFFFF;display:block;margin-bottom:2px">${escapeHtml(q.subject)}</strong>
        <p style="font-size:12px;color:var(--muted);margin:0;line-height:1.4">${escapeHtml(q.message)}</p>
        <small style="font-size:10.5px;color:#64748B;display:block;margin-top:6px">${new Date(q.createdAt).toLocaleString()}</small>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<p style="font-size:12px;color:var(--muted);margin:0">Unable to load ticket history.</p>';
  }
}

/* ─── Companion APK Download (Phase 5) ─────────────────────────────────────── */
async function downloadCompanionApk() {
  const btn = $('#btn-download-apk');
  const initialText = btn ? btn.innerHTML : '<span>⇩ Download Android APK</span>';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>Authenticating & Downloading…</span>'; }

  try {
    const currentToken = token || resolveAuthToken();
    const headers = {};
    if (currentToken) {
      headers['Authorization'] = 'Bearer ' + currentToken;
    }

    const res = await fetch('/api/companion/download', { headers });
    const contentType = res.headers.get('content-type') || '';

    if (res.status === 401) {
      toast('🔒 Please sign in to download the Companion APK.');
      modal('login-modal', true);
      return;
    }

    if (res.ok && (contentType.includes('application/vnd.android.package-archive') || contentType.includes('octet-stream'))) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      a.download = (match && match[1]) ? match[1].trim() : 'sakkupay.apk';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast('🎉 SakkuPay Android APK (sakkupay.apk) downloaded successfully!');
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.message || 'Companion APK not yet available on server.');
      modal('companion-build-modal', true);
    }
  } catch (e) {
    modal('companion-build-modal', true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = initialText; }
  }
}

/* ─── Defensive Refresh ────────────────────────────────────────────────────── */
async function refresh() {
  const range = $('#overview-range-select')?.value || 'month';
  try {
    const [dash, linksData, upisData, profileData] = await Promise.all([
      api('/dashboard?range=' + range).catch(() => ({ stats: { volume: 0, successful: 0, pending: 0, activeLinks: 0 } })),
      api('/links').catch(() => []),
      api('/upis').catch(() => []),
      api('/profile').catch(() => null)
    ]);

    links = Array.isArray(linksData) ? linksData : [];
    upis = Array.isArray(upisData) ? upisData : [];

    renderLinks();
    renderUpis();
    if (profileData) updateProfileUI(profileData);

    const stats = dash?.stats || {};
    if ($('#stat-volume')) $('#stat-volume').innerHTML = money(stats.volume || 0);
    if ($('#stat-successful')) $('#stat-successful').textContent = stats.successful || 0;
    if ($('#stat-pending')) $('#stat-pending').textContent = stats.pending || 0;
    if ($('#active-links')) $('#active-links').textContent = stats.activeLinks || 0;

    await loadTransactions();
  } catch (e) {
    console.error('Refresh error:', e);
  }
}

/* ─── Real-Time SSE ────────────────────────────────────────────────────────── */
function setupSSE() {
  if (sseSource) { try { sseSource.close(); } catch {} sseSource = null; }
  const currentToken = token || resolveAuthToken();
  if (!currentToken) return;

  try {
    sseSource = new EventSource('/api/events?token=' + encodeURIComponent(currentToken));
    sseSource.addEventListener('transaction.created', e => {
      try {
        const tx = JSON.parse(e.data);
        allTransactions.unshift(tx);
        toast(`🔔 New incoming payment of ${money(tx.amount)} from ${tx.customerName || 'customer'}!`);
        refresh();
      } catch (err) { console.error('SSE parse error:', err); }
    });
    sseSource.addEventListener('transaction.updated', e => {
      try {
        const tx = JSON.parse(e.data);
        const idx = allTransactions.findIndex(x => x.id === tx.id);
        if (idx >= 0) allTransactions[idx] = tx;
        if (tx.status === 'success') toast(`✅ Payment of ${money(tx.amount)} verified!`);
        refresh();
      } catch (err) { console.error('SSE parse error:', err); }
    });
    sseSource.onerror = err => { console.warn('SSE stream status update:', err); };
  } catch (err) {
    console.error('SSE setup error:', err);
  }
}

/* ─── Logout ───────────────────────────────────────────────────────────────── */
function logout(reason = 'session_expired') {
  try { localStorage.removeItem('sakku-token'); } catch {}
  try { localStorage.removeItem('sakku_token'); } catch {}
  token = '';
  if (sseSource) { try { sseSource.close(); } catch {} sseSource = null; }
  window.location.replace('/login?' + encodeURIComponent(reason) + '=1');
}

/* ─── Boot ─────────────────────────────────────────────────────────────────── */
async function boot() {
  token = resolveAuthToken();
  if (!token) { logout('no_session'); return; }

  // Resolve and activate initial page from URL (hash, query, or path)
  const initialPage = getActivePageFromUrl();
  go(initialPage, false);

  try {
    const profile = await api('/profile');
    if (!profile || !profile.id) throw new Error('Merchant profile unauthenticated (401)');
    updateProfileUI(profile);
    await refresh();
    setupSSE();
  } catch (err) {
    console.error('Dashboard initialization error:', err);
    const msg = String(err?.message || '');
    if (msg.includes('401') || msg.includes('session') || msg.includes('expired')) {
      logout('session_expired');
    } else {
      toast('Notice: ' + (err?.message || 'Server connection issue'), true);
    }
  }
}

boot();
