/* SakkuPay Admin Control Center — admin.js
   Enterprise Dark Fintech Operations & Governance Controller
   Milestone 5 Implementation
*/
'use strict';

const TOKEN_KEY = 'sakku-admin-token';
const ROLE_KEY = 'sakku-admin-role';
const NAME_KEY = 'sakku-admin-name';

let adminToken = localStorage.getItem(TOKEN_KEY);
let adminRole = localStorage.getItem(ROLE_KEY) || 'SuperAdmin';
let adminName = localStorage.getItem(NAME_KEY) || 'Administrator';

let allUsers = [];
let allTransactions = [];
let allInvestigationResults = [];
let allAuditEntries = [];
let allStaff = [];
let currentOpenTxId = null;
let currentInvestigationData = null;
let waPolling = null;

/* ─── API Helper ─────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (adminToken) opts.headers['Authorization'] = 'Bearer ' + adminToken;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch('/api/admin' + path, opts);
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ─── Toast Notifications ────────────────────────────────────── */
let toastTimer;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.background = isError ? 'rgba(239, 68, 68, 0.95)' : 'rgba(30, 41, 59, 0.95)';
  el.style.borderColor = isError ? 'rgba(248, 113, 113, 0.6)' : 'rgba(129, 140, 248, 0.5)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/* ─── Confirm Dialog Modal ───────────────────────────────────── */
function adminConfirm(title, msg, okLabel) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = msg;
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = okLabel || 'Confirm';
    const overlay = document.getElementById('confirm-overlay');
    overlay.classList.remove('hidden');
    const cleanup = (val) => { overlay.classList.add('hidden'); resolve(val); };
    document.getElementById('confirm-cancel').onclick = () => cleanup(false);
    okBtn.onclick = () => cleanup(true);
  });
}

/* ─── Formatters & Utility Functions ─────────────────────────── */
function fmtAmt(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function escape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPill(status, extraClass) {
  const map = {
    success: 'pill success',
    pending: 'pill pending',
    failed: 'pill failed',
    flagged_ambiguous: 'pill ambiguous',
    unverified_evidence: 'pill unverified',
    settled: 'pill success',
    unreconciled: 'pill unreconciled'
  };
  const cls = map[status] || 'pill pending';
  const label = status.replace(/_/g, ' ').toUpperCase();
  return `<span class="${cls} ${extraClass || ''}"><span class="dot"></span>${escape(label)}</span>`;
}

function roleBadge(role) {
  if (role === 'SuperAdmin') return '<span class="role-pill pill-superadmin">SUPERADMIN</span>';
  if (role === 'OperationsSupport') return '<span class="role-pill pill-operations">OPERATIONS SUPPORT</span>';
  if (role === 'ComplianceAuditor') return '<span class="role-pill pill-auditor">COMPLIANCE AUDITOR</span>';
  return `<span class="role-pill">${escape(role)}</span>`;
}

/* ─── Modal Management ───────────────────────────────────────── */
function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('show');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
}

// Global modal close handlers (for close buttons and clicking on backdrops)
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('close') || e.target.closest('.close')) {
    const backdrop = e.target.closest('.backdrop');
    if (backdrop) backdrop.classList.remove('show');
  } else if (e.target.classList.contains('backdrop')) {
    e.target.classList.remove('show');
  }
});

/* ─── Role-Based UI Adaptation (RBAC) ────────────────────────── */
function applyRoleRestrictions(role) {
  adminRole = role || 'SuperAdmin';
  localStorage.setItem(ROLE_KEY, adminRole);

  const sidebarBadge = document.getElementById('sidebar-role-badge');
  if (sidebarBadge) {
    sidebarBadge.textContent = adminRole.toUpperCase();
    sidebarBadge.className = 'role-pill ' + (
      adminRole === 'SuperAdmin' ? 'pill-superadmin' :
      adminRole === 'OperationsSupport' ? 'pill-operations' : 'pill-auditor'
    );
  }

  const headerTag = document.getElementById('header-role-tag');
  if (headerTag) headerTag.textContent = 'Role: ' + adminRole;

  const displayName = document.getElementById('admin-display-name');
  if (displayName) displayName.textContent = adminName;

  const displayRole = document.getElementById('admin-display-role');
  if (displayRole) displayRole.textContent = adminRole;

  const avatar = document.getElementById('admin-avatar');
  if (avatar) {
    const initials = adminName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() || 'AD';
    avatar.textContent = initials;
  }

  // Navigation and Action visibility according to RBAC
  const navAudit = document.getElementById('nav-audit');
  const navStaff = document.getElementById('nav-staff');
  const navWa = document.getElementById('nav-whatsapp');

  if (adminRole === 'OperationsSupport') {
    if (navAudit) navAudit.style.display = 'none';
    if (navStaff) navStaff.style.display = 'none';
    if (navWa) navWa.style.display = 'none';
  } else if (adminRole === 'ComplianceAuditor') {
    if (navAudit) navAudit.style.display = 'flex';
    if (navStaff) navStaff.style.display = 'none';
    if (navWa) navWa.style.display = 'none';
  } else {
    // SuperAdmin
    if (navAudit) navAudit.style.display = 'flex';
    if (navStaff) navStaff.style.display = 'flex';
    if (navWa) navWa.style.display = 'flex';
  }

  // Adjust investigation reconcile button for ComplianceAuditor (read-only)
  const recBtn = document.getElementById('inv-reconcile-btn');
  if (recBtn) {
    if (adminRole === 'ComplianceAuditor') {
      recBtn.style.display = 'none';
    } else {
      recBtn.style.display = 'block';
    }
  }

  // Adjust merchant suspension button in drawer
  const suspBtn = document.getElementById('mdtl-suspend-btn');
  if (suspBtn) {
    if (adminRole !== 'SuperAdmin') {
      suspBtn.style.display = 'none';
    } else {
      suspBtn.style.display = 'block';
    }
  }
}

/* ─── Authentication ─────────────────────────────────────────── */
const authOverlay = document.getElementById('auth-overlay');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

function checkAuth() {
  if (!adminToken) {
    authOverlay.classList.remove('hidden');
  } else {
    authOverlay.classList.add('hidden');
    applyRoleRestrictions(adminRole);
    loadOverview();
  }
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginError.textContent = '';
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const submitBtn = document.getElementById('login-submit-btn');

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying Credentials…';

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      loginError.textContent = data.error || 'Authentication failed';
      return;
    }

    adminToken = data.token;
    adminRole = data.role || 'SuperAdmin';
    adminName = data.name || 'Administrator';

    localStorage.setItem(TOKEN_KEY, adminToken);
    localStorage.setItem(ROLE_KEY, adminRole);
    localStorage.setItem(NAME_KEY, adminName);

    authOverlay.classList.add('hidden');
    applyRoleRestrictions(adminRole);
    loadOverview();
  } catch {
    loginError.textContent = 'Network connection failed. Is the server reachable?';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Authenticate →';
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  adminToken = null;
  adminRole = 'SuperAdmin';
  adminName = 'Administrator';
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(NAME_KEY);
  allUsers = [];
  allTransactions = [];
  allInvestigationResults = [];
  allAuditEntries = [];
  allStaff = [];
  stopWaPolling();
  authOverlay.classList.remove('hidden');
});

/* ─── Navigation ─────────────────────────────────────────────── */
const pages = {
  overview: 'Overview & Platform Health',
  merchants: 'Merchant Directory',
  transactions: 'Platform Settlement Ledger',
  investigation: 'Payment Investigation Workspace',
  audit: 'Administrative Audit Trail',
  staff: 'Staff & Role-Based Access Control',
  errors: 'Diagnostics & Client Error Logs',
  whatsapp: 'WhatsApp Gateway Integration'
};

function navigate(page) {
  // Gate restricted pages on client side
  if ((page === 'staff' || page === 'whatsapp') && adminRole !== 'SuperAdmin') {
    toast('Access restricted: Role ' + adminRole + ' cannot access this module.', true);
    return;
  }
  if (page === 'audit' && adminRole === 'OperationsSupport') {
    toast('Access restricted: OperationsSupport cannot view the audit trail.', true);
    return;
  }

  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));

  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');

  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = pages[page] || page;

  const refreshEl = document.getElementById('last-refresh');
  if (refreshEl) refreshEl.textContent = 'Last refresh: ' + new Date().toLocaleTimeString();

  stopWaPolling();

  if (page === 'overview') loadOverview();
  else if (page === 'merchants') loadUsers();
  else if (page === 'transactions') loadTransactions();
  else if (page === 'investigation') runInvestigationSearch();
  else if (page === 'audit') loadAuditTrail();
  else if (page === 'staff') loadStaffUsers();
  else if (page === 'errors') loadErrors();
  else if (page === 'whatsapp') { loadWaStatus(); startWaPollingIfNeeded(); }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

/* ─── Page 1: Overview & Health ──────────────────────────────── */
async function loadOverview() {
  try {
    // 1. Fetch statistics
    const stats = await api('GET', '/stats');
    document.getElementById('s-volume').textContent = fmtAmt(stats.totalVolume);
    document.getElementById('s-volume-paise').textContent = (stats.totalVolumePaise || 0).toLocaleString() + ' paise';
    document.getElementById('s-tx').textContent = Number(stats.totalTransactions || 0).toLocaleString();
    document.getElementById('s-tx-success').textContent = Number(stats.successfulTransactions || 0).toLocaleString();
    document.getElementById('s-merchants').textContent = Number(stats.totalMerchants || 0).toLocaleString();
    document.getElementById('s-suspended').textContent = Number(stats.suspendedMerchants || 0).toLocaleString();
    document.getElementById('s-links').textContent = Number(stats.activeLinks || 0).toLocaleString();
    document.getElementById('s-total-links').textContent = Number(stats.totalLinks || 0).toLocaleString();

    // 2. Fetch architecture and system health
    try {
      const health = await api('GET', '/system/health');
      if (health) {
        document.getElementById('db-health-badge').textContent = '● ' + (health.status || 'HEALTHY').toUpperCase();
        document.getElementById('h-engine').textContent = health.database?.engine || 'SQLite (better-sqlite3)';
        document.getElementById('h-journal').textContent = health.database?.journalMode || 'wal';
        document.getElementById('h-fk').textContent = health.database?.foreignKeys ? 'Enforced (1)' : 'Disabled (0)';
        document.getElementById('h-timeout').textContent = (health.database?.busyTimeoutMs || 5000) + ' ms';
        document.getElementById('h-memory').textContent = (health.process?.memoryRssMb || 0) + ' MB';
        document.getElementById('h-heap').textContent = 'Heap: ' + (health.process?.heapUsedMb || 0) + ' MB';
        document.getElementById('h-uptime').textContent = formatUptime(health.uptimeSeconds);
        document.getElementById('h-node').textContent = 'Node: ' + (health.process?.nodeVersion || process?.version || 'v20+');

        const tc = health.database?.tableCounts || {};
        document.getElementById('cnt-merchants').textContent = tc.merchants || 0;
        document.getElementById('cnt-transactions').textContent = tc.transactions || 0;
        document.getElementById('cnt-links').textContent = tc.links || 0;
        document.getElementById('cnt-upis').textContent = tc.upis || 0;
        document.getElementById('cnt-admins').textContent = tc.adminUsers || 0;
        document.getElementById('cnt-audit').textContent = tc.auditTrail || 0;
        document.getElementById('cnt-errors').textContent = tc.errors || 0;
      }
    } catch (_) {}

    // 3. Activity feed from recent platform transactions
    const txs = await api('GET', '/transactions?limit=8');
    const feed = document.getElementById('activity-feed');
    if (!txs || !txs.length) {
      feed.innerHTML = '<div class="empty-state"><p>No transaction activity recorded yet.</p></div>';
    } else {
      feed.innerHTML = '<div class="activity-list">' + txs.map(tx => `
        <div class="activity-item">
          <div class="activity-dot ${tx.status === 'success' ? 'green' : tx.status === 'failed' ? 'orange' : ''}"></div>
          <div class="activity-body">
            <p class="activity-text">
              <b style="font-family:monospace;color:#818CF8">${escape(tx.reference)}</b> —
              ${escape(tx.customerName || 'Anonymous Customer')} paid <b>${fmtAmt(tx.amount)}</b>
              <span style="color:var(--muted)">via ${escape(tx.merchantBusiness || tx.merchantEmail || 'Merchant')}</span>
            </p>
            <div class="activity-time">
              ${fmtDateTime(tx.createdAt)} · ${renderPill(tx.status)}
              ${tx.utr ? `<code style="margin-left:8px;font-size:10.5px;color:#A5B4FC">UTR: ${escape(tx.utr)}</code>` : ''}
            </div>
          </div>
        </div>`).join('') + '</div>';
    }
  } catch (e) {
    if (e.status === 401) {
      adminToken = null;
      localStorage.removeItem(TOKEN_KEY);
      checkAuth();
      return;
    }
    toast('Failed to load overview: ' + e.message, true);
  }
}

function formatUptime(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ─── Page 2: Merchant Directory ─────────────────────────────── */
async function loadUsers() {
  const tbody = document.getElementById('user-tbody');
  tbody.innerHTML = '<tr><td colspan="9" class="loading">Loading merchant directory…</td></tr>';
  try {
    allUsers = await api('GET', '/users');
    renderUsers();
  } catch (e) {
    toast('Failed to load merchants: ' + e.message, true);
  }
}

function filterUsers() {
  renderUsers();
}

function renderUsers() {
  const q = document.getElementById('user-search').value.toLowerCase();
  const sf = document.getElementById('user-status-filter').value;

  let list = allUsers.filter(u => {
    if (q && !`${u.email} ${u.businessName} ${u.phone || ''} ${u.primaryUpi || ''}`.toLowerCase().includes(q)) return false;
    if (sf === 'active' && u.suspended) return false;
    if (sf === 'suspended' && !u.suspended) return false;
    return true;
  });

  const tbody = document.getElementById('user-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)">No merchants found matching query.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(u => {
    const isSuper = adminRole === 'SuperAdmin';
    return `
    <tr>
      <td>
        <div style="font-weight:600;font-size:13px;color:#FFFFFF">${escape(u.email)}</div>
        ${u.phone ? `<div style="font-size:11.5px;color:#34D399;margin-top:2px;font-family:monospace">📱 +91 ${escape(u.phone)}</div>` : '<div style="font-size:11px;color:var(--subtle)">No phone linked</div>'}
      </td>
      <td>
        <div style="font-weight:600;color:#FFFFFF">${escape(u.businessName || 'Unnamed Store')}</div>
        ${u.primaryUpi ? `<div style="font-size:11.5px;color:#818CF8;font-family:monospace;margin-top:2px">${escape(u.primaryUpi)}</div>` : ''}
      </td>
      <td style="text-align:center">${u.upiCount || 0}</td>
      <td style="text-align:center">${u.linkCount || 0}</td>
      <td style="text-align:center">${u.txCount || 0}</td>
      <td style="font-weight:600;color:#10B981">${fmtAmt(u.txVolume || 0)}</td>
      <td>${u.suspended ? '<span class="badge badge-suspended">Suspended</span>' : '<span class="badge badge-active">Active</span>'}</td>
      <td style="color:var(--muted);font-size:12px">${fmtDate(u.createdAt)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-outline" onclick="openMerchantDrawer('${u.id}')">Inspect</button>
          ${isSuper ? (
            u.suspended
              ? `<button class="btn btn-sm btn-success" onclick="openSuspendModal('${u.id}', true)">Unsuspend</button>`
              : `<button class="btn btn-sm btn-warn" onclick="openSuspendModal('${u.id}', false)">Suspend</button>`
          ) : ''}
          ${isSuper ? `<button class="btn btn-sm btn-danger" onclick="deleteMerchant('${u.id}', '${escape(u.email)}')">Delete</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* ─── Merchant Detail Drawer & Governance ────────────────────── */
async function openMerchantDrawer(id) {
  try {
    const data = await api('GET', '/merchants/' + id);
    const m = data.merchant;

    document.getElementById('mdtl-biz-name').textContent = m.businessName || m.email;
    document.getElementById('mdtl-status-badge').innerHTML = data.suspended
      ? '<span class="badge badge-suspended">SUSPENDED</span>'
      : '<span class="badge badge-active">ACTIVE</span>';

    document.getElementById('mdtl-id').textContent = m.id;
    document.getElementById('mdtl-email').textContent = m.email;
    document.getElementById('mdtl-phone').textContent = m.phone ? '+91 ' + m.phone : 'Not set';
    document.getElementById('mdtl-created').textContent = fmtDateTime(m.createdAt);

    // Connected UPI accounts
    const upisBox = document.getElementById('mdtl-upis-container');
    if (!data.upis || !data.upis.length) {
      upisBox.innerHTML = '<span style="font-size:12.5px;color:var(--muted)">No receiving UPI accounts registered.</span>';
    } else {
      upisBox.innerHTML = data.upis.map(u => `
        <div style="display:flex;justify-content:space-between;align-items:center;background:var(--card-inner);padding:8px 12px;border-radius:8px;border:1px solid var(--line);font-size:12.5px">
          <div><code style="color:#818CF8;font-weight:700">${escape(u.upiId)}</code> ${u.default ? '<span class="badge badge-active" style="font-size:9.5px;padding:2px 6px">DEFAULT</span>' : ''}</div>
          <span style="color:var(--muted);font-size:11.5px">${u.phoneNumber ? '+91 ' + escape(u.phoneNumber) : ''}</span>
        </div>
      `).join('');
    }

    // Payment Links
    const linksBox = document.getElementById('mdtl-links-container');
    if (!data.links || !data.links.length) {
      linksBox.innerHTML = '<span style="font-size:12.5px;color:var(--muted)">No payment links generated.</span>';
    } else {
      linksBox.innerHTML = data.links.map(l => `
        <div style="display:flex;justify-content:space-between;align-items:center;background:var(--card-inner);padding:8px 12px;border-radius:8px;border:1px solid var(--line);font-size:12.5px">
          <div>
            <strong style="color:#FFFFFF">${escape(l.title || 'Untitled Link')}</strong>
            <div style="font-size:11px;color:var(--muted)">Slug: /pay/${escape(l.slug)}</div>
          </div>
          <div style="text-align:right">
            <b style="color:#10B981">${fmtAmt(l.amount)}</b>
            <div style="font-size:10px">${l.active ? '<span style="color:#34D399">ACTIVE</span>' : '<span style="color:#F87171">INACTIVE</span>'}</div>
          </div>
        </div>
      `).join('');
    }

    // Recent transactions
    const txsBox = document.getElementById('mdtl-txs-container');
    if (!data.recentTransactions || !data.recentTransactions.length) {
      txsBox.innerHTML = '<span style="font-size:12.5px;color:var(--muted)">No transactions recorded for this merchant.</span>';
    } else {
      txsBox.innerHTML = data.recentTransactions.map(t => `
        <div style="display:flex;justify-content:space-between;align-items:center;background:var(--card-inner);padding:8px 12px;border-radius:8px;border:1px solid var(--line);font-size:12.5px">
          <div>
            <code style="color:#818CF8;font-weight:700">${escape(t.reference)}</code>
            <div style="font-size:11px;color:var(--muted)">${escape(t.customerName || 'Customer')} · ${fmtDateTime(t.createdAt)}</div>
          </div>
          <div style="text-align:right">
            <b style="color:#10B981">${fmtAmt(t.amount)}</b>
            <div>${renderPill(t.status)}</div>
          </div>
        </div>
      `).join('');
    }

    // Wire up suspend button
    const suspBtn = document.getElementById('mdtl-suspend-btn');
    if (adminRole === 'SuperAdmin') {
      suspBtn.style.display = 'block';
      suspBtn.textContent = data.suspended ? 'Unsuspend Account…' : 'Suspend Account…';
      suspBtn.className = data.suspended ? 'btn btn-success' : 'btn btn-warn';
      suspBtn.onclick = () => {
        closeModal('merchant-drawer');
        openSuspendModal(m.id, data.suspended);
      };
    } else {
      suspBtn.style.display = 'none';
    }

    showModal('merchant-drawer');
  } catch (e) {
    toast('Failed to load merchant details: ' + e.message, true);
  }
}

function openSuspendModal(id, currentSuspended) {
  const targetSuspended = !currentSuspended;
  document.getElementById('susp-merchant-id').value = id;
  document.getElementById('susp-target-state').value = String(targetSuspended);

  document.getElementById('susp-modal-eyebrow').textContent = targetSuspended
    ? 'AUDITED MERCHANT SUSPENSION'
    : 'AUDITED MERCHANT UNSUSPENSION';
  document.getElementById('susp-modal-title').textContent = targetSuspended
    ? 'Suspend Merchant Account'
    : 'Unsuspend & Restore Merchant Access';
  document.getElementById('susp-modal-desc').textContent = targetSuspended
    ? 'Suspending this account will immediately revoke API keys and disable checkout payment processing. This operation is permanently recorded in the audit trail.'
    : 'Restoring this account will re-enable merchant access and checkout links. This action is permanently recorded in the audit trail.';

  document.getElementById('susp-submit-btn').textContent = targetSuspended
    ? 'Confirm & Suspend Account →'
    : 'Confirm & Restore Access →';
  document.getElementById('susp-justification').value = '';

  showModal('audited-suspend-modal');
}

document.getElementById('audited-suspend-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('susp-merchant-id').value;
  const targetSuspended = document.getElementById('susp-target-state').value === 'true';
  const reasonCode = document.getElementById('susp-reason-code').value;
  const justification = document.getElementById('susp-justification').value.trim();

  if (justification.length < 10) {
    toast('Written justification must be at least 10 characters long.', true);
    return;
  }

  const submitBtn = document.getElementById('susp-submit-btn');
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Executing Audit Directive…';

    await api('POST', `/merchants/${id}/suspend`, {
      suspended: targetSuspended,
      reasonCode,
      justification
    });

    closeModal('audited-suspend-modal');
    toast(`Merchant ${targetSuspended ? 'suspended' : 'unsuspended'} successfully.`);
    loadUsers();
    loadOverview();
  } catch (err) {
    toast('Action failed: ' + err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});

async function deleteMerchant(id, email) {
  const ok = await adminConfirm(
    'Delete Merchant?',
    `Are you sure you want to permanently delete merchant "${email}"? This action cannot be undone.`,
    'Delete'
  );
  if (!ok) return;

  try {
    await api('DELETE', '/users/' + id);
    toast('Merchant deleted successfully.');
    loadUsers();
    loadOverview();
  } catch (e) {
    if (e.status === 400) {
      toast('Cannot delete merchant: Account has existing financial records. Suspend merchant instead.', true);
    } else {
      toast('Failed to delete merchant: ' + e.message, true);
    }
  }
}

/* ─── Page 3: Global Transactions Ledger ─────────────────────── */
async function loadTransactions() {
  const tbody = document.getElementById('tx-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Loading platform transactions…</td></tr>';
  try {
    allTransactions = await api('GET', '/transactions?limit=200');

    // Populate merchant dropdown filter
    const sel = document.getElementById('tx-merchant-filter');
    const existing = new Set([...sel.options].map(o => o.value));
    const merchants = [...new Map(allTransactions.map(t => [t.merchantId, t])).values()];
    merchants.forEach(t => {
      if (t.merchantId && !existing.has(t.merchantId)) {
        const opt = document.createElement('option');
        opt.value = t.merchantId;
        opt.textContent = t.merchantBusiness || t.merchantEmail || t.merchantId;
        sel.appendChild(opt);
      }
    });

    renderTransactions();
  } catch (e) {
    toast('Failed to load transactions: ' + e.message, true);
  }
}

function filterTransactions() {
  renderTransactions();
}

function renderTransactions() {
  const q = document.getElementById('tx-search').value.toLowerCase();
  const sf = document.getElementById('tx-status-filter').value;
  const mf = document.getElementById('tx-merchant-filter').value;

  let list = allTransactions.filter(t => {
    if (q && !`${t.reference} ${t.customerName || ''} ${t.customerEmail || ''} ${t.utr || ''}`.toLowerCase().includes(q)) return false;
    if (sf && sf !== 'all' && t.status !== sf) return false;
    if (mf && t.merchantId !== mf) return false;
    return true;
  });

  const tbody = document.getElementById('tx-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted)">No platform transactions found.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(t => `
    <tr>
      <td>
        <code style="font-size:12px;color:#818CF8;font-weight:700">${escape(t.reference)}</code>
        ${t.utr ? `<div style="font-size:11px;color:#A5B4FC;font-family:monospace">UTR: ${escape(t.utr)}</div>` : ''}
      </td>
      <td>
        <div style="font-size:12.5px;font-weight:600;color:#FFFFFF">${escape(t.merchantBusiness || 'Store')}</div>
        <div style="font-size:11px;color:var(--muted)">${escape(t.merchantEmail)}</div>
      </td>
      <td>
        <div style="font-size:12.5px;color:#FFFFFF">${escape(t.customerName || 'Anonymous Customer')}</div>
        <div style="font-size:11px;color:var(--muted)">${escape(t.customerEmail || '—')}</div>
      </td>
      <td style="font-weight:700;color:#10B981">${fmtAmt(t.amount)}</td>
      <td>${renderPill(t.status)}</td>
      <td>${renderPill(t.reconciliationStatus || 'unreconciled')}</td>
      <td style="color:var(--muted);font-size:11.5px">${fmtDateTime(t.createdAt)}</td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="openInvestigationDrawer('${t.id}')">Inspect →</button>
      </td>
    </tr>
  `).join('');
}

/* ─── Page 4: Payment Investigation Workspace ────────────────── */
async function runInvestigationSearch() {
  const tbody = document.getElementById('inv-tbody');
  tbody.innerHTML = '<tr><td colspan="9" class="loading">Searching investigation workspace…</td></tr>';

  const q = document.getElementById('inv-query').value.trim();
  const utr = document.getElementById('inv-utr').value.trim();
  const provRef = document.getElementById('inv-prov-ref').value.trim();
  const reconStatus = document.getElementById('inv-recon-filter').value;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (utr) params.set('utr', utr);
  if (provRef) params.set('providerReference', provRef);
  if (reconStatus && reconStatus !== 'all') params.set('reconciliationStatus', reconStatus);
  params.set('limit', '50');

  try {
    const data = await api('GET', '/investigation/search?' + params.toString());
    allInvestigationResults = data.items || [];
    renderInvestigationResults();
  } catch (e) {
    toast('Investigation query failed: ' + e.message, true);
  }
}

function applyInvQuickFilter(val) {
  document.getElementById('inv-recon-filter').value = val;
  runInvestigationSearch();
}

function renderInvestigationResults() {
  const tbody = document.getElementById('inv-tbody');
  if (!allInvestigationResults.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:36px;color:var(--muted)">No transactions matching forensic search criteria.</td></tr>';
    return;
  }

  tbody.innerHTML = allInvestigationResults.map(t => {
    const isAmbiguous = t.reconciliationStatus === 'flagged_ambiguous';
    return `
    <tr style="${isAmbiguous ? 'background:rgba(245,158,11,0.06)' : ''}">
      <td>
        <code style="font-size:12px;color:#818CF8;font-weight:700">${escape(t.reference)}</code>
        ${isAmbiguous ? '<div style="font-size:10.5px;color:#FBBF24;font-weight:700">⚠️ COLLISION FLAGGED</div>' : ''}
      </td>
      <td>
        <div style="font-size:12.5px;font-weight:600;color:#FFFFFF">${escape(t.merchantBusiness || 'Store')}</div>
        <div style="font-size:11px;color:var(--muted)">${escape(t.merchantEmail)}</div>
      </td>
      <td>
        <div style="font-size:12.5px;color:#FFFFFF">${escape(t.customerName || 'Anonymous')}</div>
        <div style="font-size:11px;color:var(--muted)">${escape(t.customerPhone || t.customerEmail || '—')}</div>
      </td>
      <td style="font-weight:700;color:#10B981">${fmtAmt(t.amount)}</td>
      <td>${renderPill(t.status)}</td>
      <td>${renderPill(t.reconciliationStatus || 'unreconciled')}</td>
      <td><code style="font-size:11.5px;color:#F8FAFC">${escape(t.utr || '—')}</code></td>
      <td style="color:var(--muted);font-size:11.5px">${fmtDateTime(t.createdAt)}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="openInvestigationDrawer('${t.id}')">Forensics &amp; Timeline →</button>
      </td>
    </tr>`;
  }).join('');
}

/* ─── Investigation Timeline Drawer ──────────────────────────── */
async function openInvestigationDrawer(txId) {
  currentOpenTxId = txId;
  const container = document.getElementById('inv-timeline-container');
  container.innerHTML = '<div class="loading">Loading lifecycle timeline…</div>';

  try {
    const data = await api('GET', `/transactions/${txId}/timeline`);
    currentInvestigationData = data;
    const tx = data.transaction;
    const diag = data.diagnostics || {};

    document.getElementById('inv-dtl-ref').textContent = tx.reference;
    document.getElementById('inv-dtl-status-pill').innerHTML = renderPill(tx.status);
    document.getElementById('inv-dtl-recon-pill').innerHTML = renderPill(diag.reconciliationStatus || tx.reconciliationStatus || 'unreconciled');

    // Ambiguity diagnostic alert box
    const ambBox = document.getElementById('inv-dtl-ambiguity-box');
    const ambText = document.getElementById('inv-dtl-ambiguity-text');
    if (diag.isAmbiguous) {
      ambBox.style.display = 'block';
      ambText.textContent = diag.ambiguityReason || 'Multiple transactions matched this UTR/amount or an ambiguous companion event was received.';
    } else {
      ambBox.style.display = 'none';
    }

    // Stats grid
    document.getElementById('inv-dtl-amount').textContent = fmtAmt(tx.amount);
    document.getElementById('inv-dtl-paise').textContent = (tx.amountPaise || Math.round(tx.amount * 100)) + ' paise';
    document.getElementById('inv-dtl-utr').textContent = tx.utr || 'None submitted';
    document.getElementById('inv-dtl-utr-sub').textContent = tx.verifiedBy ? `Verified by: ${tx.verifiedBy}` : 'Unverified evidence';
    document.getElementById('inv-dtl-provider-ref').textContent = tx.providerReference || 'None';
    document.getElementById('inv-dtl-merchant').textContent = (data.merchant?.businessName || data.merchant?.email || tx.merchantId);

    // Reconcile button wiring
    const recBtn = document.getElementById('inv-reconcile-btn');
    if (adminRole === 'ComplianceAuditor') {
      recBtn.style.display = 'none';
    } else {
      recBtn.style.display = 'block';
      recBtn.onclick = () => {
        openReconcileModal(tx.id, tx.reference, tx.amount, tx.status);
      };
    }

    // Chronological Lifecycle Timeline
    const timeline = data.timeline || [];
    if (!timeline.length) {
      container.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px 0">No lifecycle events recorded for this transaction.</div>';
    } else {
      container.innerHTML = timeline.map(ev => {
        let dotCls = 'timeline-dot';
        if (ev.type === 'STATUS_CHANGE_SUCCESS' || ev.type === 'TRANSACTION_SETTLED' || ev.title?.includes('Settled')) {
          dotCls += ' success';
        } else if (ev.type === 'STATUS_CHANGE_FAILED' || ev.title?.includes('Failed')) {
          dotCls += ' danger';
        } else if (ev.type === 'AMBIGUITY_DETECTED' || ev.type === 'COLLISION_FLAGGED' || ev.title?.includes('Ambiguous')) {
          dotCls += ' warning';
        }

        let detailsHtml = '';
        if (ev.details && Object.keys(ev.details).length > 0) {
          detailsHtml = `<div class="timeline-details">${escape(JSON.stringify(ev.details, null, 2))}</div>`;
        }

        return `
          <div class="timeline-node">
            <div class="${dotCls}"></div>
            <div class="timeline-content">
              <div class="timeline-header">
                <span class="timeline-title">${escape(ev.title || ev.type)}</span>
                <span class="timeline-time">${fmtDateTime(ev.timestamp)}</span>
              </div>
              <p class="timeline-desc">${escape(ev.description || '')}</p>
              ${detailsHtml}
            </div>
          </div>
        `;
      }).join('');
    }

    showModal('investigation-drawer');
  } catch (e) {
    toast('Failed to load transaction forensics: ' + e.message, true);
  }
}

/* ─── Audited Manual Reconciliation Modal ────────────────────── */
function openReconcileModal(txId, reference, amount, currentStatus) {
  document.getElementById('rec-tx-id').value = txId;
  document.getElementById('rec-expected-status').value = currentStatus;
  document.getElementById('rec-target-ref').textContent = reference;
  document.getElementById('rec-target-amount').textContent = fmtAmt(amount);

  document.getElementById('rec-action-select').value = 'force_settle_with_proof';
  document.getElementById('rec-utr').value = '';
  document.getElementById('rec-prov-ref').value = '';
  document.getElementById('rec-justification').value = '';
  handleRecActionChange();

  showModal('reconcile-modal');
}

function handleRecActionChange() {
  const act = document.getElementById('rec-action-select').value;
  const utrGroup = document.getElementById('rec-proof-utr-group');
  const refGroup = document.getElementById('rec-proof-ref-group');

  if (act === 'force_settle_with_proof') {
    utrGroup.style.display = 'grid';
    refGroup.style.display = 'grid';
  } else {
    utrGroup.style.display = 'none';
    refGroup.style.display = 'none';
  }
}

document.getElementById('reconcile-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const txId = document.getElementById('rec-tx-id').value;
  const action = document.getElementById('rec-action-select').value;
  const reasonCode = document.getElementById('rec-reason-code').value;
  const justification = document.getElementById('rec-justification').value.trim();
  const expectedCurrentStatus = document.getElementById('rec-expected-status').value;
  const utr = document.getElementById('rec-utr').value.trim();
  const providerReference = document.getElementById('rec-prov-ref').value.trim();

  if (justification.length < 10) {
    toast('Written justification must be at least 10 characters long.', true);
    return;
  }
  if (action === 'force_settle_with_proof' && !utr && !providerReference) {
    toast('Proof of settlement is mandatory: provide Bank UTR or Provider Reference.', true);
    return;
  }

  const submitBtn = document.getElementById('rec-submit-btn');
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Executing Audited Reconciliation…';

    await api('POST', `/transactions/${txId}/reconcile`, {
      action,
      reasonCode,
      justification,
      expectedCurrentStatus,
      utr: utr || undefined,
      providerReference: providerReference || undefined
    });

    closeModal('reconcile-modal');
    toast('Transaction reconciliation executed and audited.');

    // Refresh investigation drawer & workspace tables
    if (currentOpenTxId === txId) openInvestigationDrawer(txId);
    runInvestigationSearch();
    loadTransactions();
    loadOverview();
  } catch (err) {
    if (err.status === 409) {
      toast('Concurrency Conflict (409): Transaction status was updated by another process. Please re-open.', true);
    } else {
      toast('Reconciliation failed: ' + err.message, true);
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Execute & Log Reconciliation →';
  }
});

/* ─── Page 5: Administrative Audit Trail ─────────────────────── */
async function loadAuditTrail() {
  if (adminRole === 'OperationsSupport') {
    toast('Access denied: OperationsSupport cannot read audit logs.', true);
    return;
  }

  const tbody = document.getElementById('audit-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Loading administrative audit records…</td></tr>';

  const action = document.getElementById('audit-action-filter').value.trim();
  const outcome = document.getElementById('audit-outcome-filter').value;

  const params = new URLSearchParams();
  if (action) params.set('action', action);
  if (outcome && outcome !== 'all') params.set('outcome', outcome);
  params.set('limit', '100');

  try {
    const data = await api('GET', '/audit-trail?' + params.toString());
    allAuditEntries = data.items || [];
    renderAuditTrail();
  } catch (e) {
    toast('Failed to load audit trail: ' + e.message, true);
  }
}

function renderAuditTrail() {
  const tbody = document.getElementById('audit-tbody');
  if (!allAuditEntries.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:36px;color:var(--muted)">No audit trail records found.</td></tr>';
    return;
  }

  tbody.innerHTML = allAuditEntries.map((a, idx) => {
    let outcomePill = '<span class="badge badge-active">SUCCESS</span>';
    if (a.outcome === 'failed') outcomePill = '<span class="badge badge-suspended">FAILED</span>';
    if (a.outcome === 'denied') outcomePill = '<span class="badge badge-pending">DENIED</span>';

    return `
      <tr>
        <td style="color:var(--muted);font-size:11.5px;white-space:nowrap">${fmtDateTime(a.createdAt)}</td>
        <td>
          <div style="font-weight:600;font-size:12.5px;color:#FFFFFF">${escape(a.actorEmail)}</div>
          <div style="font-size:10.5px;color:#818CF8">${escape(a.actorRole || 'SuperAdmin')} · ${escape(a.ipAddress || '127.0.0.1')}</div>
        </td>
        <td><code style="font-family:monospace;color:#FBBF24;font-size:12px">${escape(a.action)}</code></td>
        <td>
          <span style="font-size:12px;color:#CBD5E1">${escape(a.targetType || '—')}</span>
          ${a.targetId ? `<div style="font-size:10.5px;font-family:monospace;color:var(--muted)">${escape(a.targetId)}</div>` : ''}
        </td>
        <td><code style="font-size:11px;color:#A5B4FC">${escape(a.reasonCode || '—')}</code></td>
        <td style="font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis" title="${escape(a.justification)}">
          ${escape(a.justification || '—')}
        </td>
        <td>${outcomePill}</td>
        <td>
          <button class="btn btn-sm btn-outline" onclick="openAuditInspectModal(${idx})">Inspect Diff</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openAuditInspectModal(idx) {
  const item = allAuditEntries[idx];
  if (!item) return;

  document.getElementById('aud-insp-action').textContent = item.action;
  document.getElementById('aud-insp-actor').textContent = `${item.actorEmail} (${item.actorRole || 'SuperAdmin'}) [${item.ipAddress || '127.0.0.1'}]`;
  document.getElementById('aud-insp-reason').textContent = item.reasonCode || 'N/A';
  document.getElementById('aud-insp-justification').textContent = item.justification || 'No justification submitted.';

  const beforePre = document.getElementById('aud-insp-before');
  const afterPre = document.getElementById('aud-insp-after');

  beforePre.textContent = item.beforeState ? JSON.stringify(item.beforeState, null, 2) : 'null (None / Created)';
  afterPre.textContent = item.afterState ? JSON.stringify(item.afterState, null, 2) : 'null (None / Deleted)';

  showModal('audit-inspect-modal');
}

/* ─── Page 6: Staff & RBAC Governance ────────────────────────── */
async function loadStaffUsers() {
  if (adminRole !== 'SuperAdmin') {
    toast('Access denied: Only SuperAdmin can manage personnel.', true);
    return;
  }

  const tbody = document.getElementById('staff-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading administrative staff…</td></tr>';

  try {
    allStaff = await api('GET', '/staff');
    renderStaffUsers();
  } catch (e) {
    toast('Failed to load staff list: ' + e.message, true);
  }
}

function renderStaffUsers() {
  const tbody = document.getElementById('staff-tbody');
  if (!allStaff.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted)">No staff accounts created yet.</td></tr>';
    return;
  }

  tbody.innerHTML = allStaff.map(s => {
    const isSelf = s.email === (adminName?.includes('@') ? adminName : 'admin@sakkupay.local');
    return `
      <tr>
        <td>
          <div style="font-weight:700;font-size:13px;color:#FFFFFF">${escape(s.name)}</div>
          <div style="font-size:11.5px;color:var(--muted)">${escape(s.email)}</div>
        </td>
        <td>${roleBadge(s.role)}</td>
        <td>${s.active ? '<span class="badge badge-active">ACTIVE</span>' : '<span class="badge badge-suspended">DISABLED</span>'}</td>
        <td style="color:var(--muted);font-size:12px">${fmtDate(s.createdAt)}</td>
        <td style="color:var(--muted);font-size:12px">${s.lastLoginAt ? fmtDateTime(s.lastLoginAt) : 'Never'}</td>
        <td>
          <div class="action-btns">
            ${isSelf ? '<span style="font-size:11px;color:var(--subtle)">Current User</span>' : (
              s.active
                ? `<button class="btn btn-sm btn-warn" onclick="toggleStaffActive('${s.id}', false)">Disable</button>`
                : `<button class="btn btn-sm btn-success" onclick="toggleStaffActive('${s.id}', true)">Enable</button>`
            )}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function openStaffModal() {
  if (adminRole !== 'SuperAdmin') {
    toast('Access denied: SuperAdmin permission required.', true);
    return;
  }
  document.getElementById('staff-name').value = '';
  document.getElementById('staff-email').value = '';
  document.getElementById('staff-pass').value = '';
  document.getElementById('staff-role').value = 'OperationsSupport';
  showModal('staff-modal');
}

document.getElementById('staff-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('staff-name').value.trim();
  const email = document.getElementById('staff-email').value.trim();
  const password = document.getElementById('staff-pass').value;
  const role = document.getElementById('staff-role').value;

  const submitBtn = document.getElementById('staff-submit-btn');
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Onboarding Staff Account…';

    await api('POST', '/staff', { name, email, password, role });
    closeModal('staff-modal');
    toast(`Staff account for ${email} created.`);
    loadStaffUsers();
    loadOverview();
  } catch (err) {
    toast('Failed to create staff member: ' + err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Staff User →';
  }
});

async function toggleStaffActive(id, newActive) {
  const ok = await adminConfirm(
    newActive ? 'Enable Staff Member?' : 'Disable Staff Member?',
    `Are you sure you want to ${newActive ? 'enable' : 'disable'} access for this account?`,
    newActive ? 'Enable' : 'Disable'
  );
  if (!ok) return;

  try {
    await api('PATCH', `/staff/${id}`, { active: newActive });
    toast(`Staff user ${newActive ? 'enabled' : 'disabled'}.`);
    loadStaffUsers();
  } catch (e) {
    toast('Error updating staff account: ' + e.message, true);
  }
}

/* ─── Page 7: Diagnostics & Client Error Logs ────────────────── */
async function loadErrors() {
  const tbody = document.getElementById('err-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading error telemetry…</td></tr>';
  try {
    const errors = await api('GET', '/errors?limit=200');
    if (!errors.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--muted)">No client errors logged.</td></tr>';
      return;
    }
    tbody.innerHTML = errors.map(e => `
      <tr>
        <td style="color:var(--muted);font-size:11.5px;white-space:nowrap">${fmtDateTime(e.createdAt)}</td>
        <td style="font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;color:#FFFFFF">${escape(e.merchantEmail || 'Anonymous')}</td>
        <td style="font-size:12px;max-width:280px">
          <div style="font-weight:600;color:#F87171">${escape(e.message)}</div>
          ${e.stack ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">Stack trace</summary><pre style="font-size:10px;white-space:pre-wrap;margin:4px 0;color:var(--subtle)">${escape(e.stack)}</pre></details>` : ''}
        </td>
        <td style="font-size:11.5px;color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${escape(e.url)}">${escape(e.url)}</td>
        <td style="font-size:11.5px;color:var(--muted)">${e.line != null ? e.line + (e.col != null ? ':' + e.col : '') : '—'}</td>
      </tr>
    `).join('');
  } catch (e) {
    toast('Failed to load error telemetry: ' + e.message, true);
  }
}

async function clearErrors() {
  const ok = await adminConfirm('Clear All Errors?', 'This will permanently delete all error log entries from SQLite.', 'Clear All');
  if (!ok) return;
  try {
    await api('DELETE', '/errors');
    toast('Error logs cleared.');
    loadErrors();
    loadOverview();
  } catch (e) {
    toast('Error clearing logs: ' + e.message, true);
  }
}

/* ─── Page 8: WhatsApp Gateway Integration ───────────────────── */
async function loadWaStatus() {
  if (adminRole !== 'SuperAdmin') return null;
  try {
    const s = await api('GET', '/whatsapp/status');
    updateWaUI(s);
    return s;
  } catch {
    return null;
  }
}

function updateWaUI(s) {
  if (!s) return;
  const dot = document.getElementById('wa-dot');
  const statusText = document.getElementById('wa-status-text');
  const phoneText = document.getElementById('wa-phone-text');
  const availText = document.getElementById('wa-available-text');
  const sendForm = document.getElementById('wa-send-form');
  const installNote = document.getElementById('wa-install-note');
  const connectBtn = document.getElementById('wa-connect-btn');
  const disconnectBtn = document.getElementById('wa-disconnect-btn');

  availText.textContent = s.available ? '✓ Baileys library installed' : '✗ Library not installed';
  availText.style.color = s.available ? '#34D399' : '#F87171';
  installNote.style.display = s.available ? 'none' : 'block';

  if (s.connected) {
    dot.className = 'dot dot-green';
    statusText.textContent = 'Active & Connected';
    phoneText.textContent = s.phone ? '+' + s.phone : 'Connected';
    sendForm.style.display = 'grid';
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
    updateQrBox(null, 'connected');
  } else if (s.qrReady) {
    dot.className = 'dot dot-orange';
    statusText.textContent = 'Awaiting QR Scan…';
    phoneText.textContent = '—';
    sendForm.style.display = 'none';
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
  } else {
    dot.className = 'dot dot-grey';
    statusText.textContent = s.available ? 'Disconnected' : 'Unavailable';
    phoneText.textContent = '—';
    sendForm.style.display = 'none';
    connectBtn.style.display = s.available ? 'block' : 'none';
    disconnectBtn.style.display = 'none';
  }
}

function updateQrBox(qrDataUrl, mode) {
  const box = document.getElementById('qr-box');
  if (mode === 'connected') {
    box.innerHTML = '<div style="font-size:48px;color:#10B981">✓</div><p style="color:#34D399;font-weight:700;margin:0">WhatsApp Session Connected!</p>';
    return;
  }
  if (qrDataUrl) {
    box.innerHTML = `<img src="${qrDataUrl}" alt="WhatsApp QR Code"><p id="qr-hint">Scan with WhatsApp on your phone</p>`;
  } else {
    box.innerHTML = '<div class="qr-placeholder">💬</div><p id="qr-hint">Click "Connect WhatsApp" to begin</p>';
  }
}

async function waConnect() {
  const btn = document.getElementById('wa-connect-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    await api('POST', '/whatsapp/start');
    toast('WhatsApp session initialized. Scan QR code.');
    startWaPollingIfNeeded();
  } catch (e) {
    toast('Failed to start WhatsApp: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect WhatsApp';
  }
}

async function waDisconnect() {
  const ok = await adminConfirm('Disconnect WhatsApp?', 'This will log out the active WhatsApp session.', 'Disconnect');
  if (!ok) return;
  try {
    await api('POST', '/whatsapp/disconnect');
    toast('WhatsApp session disconnected.');
    stopWaPolling();
    await loadWaStatus();
    updateQrBox(null, 'idle');
  } catch (e) {
    toast('Error disconnecting: ' + e.message, true);
  }
}

async function waSend() {
  const to = document.getElementById('wa-to').value.trim();
  const message = document.getElementById('wa-msg').value.trim();
  if (!to || !message) {
    toast('Please enter both recipient number and message text.', true);
    return;
  }
  try {
    const r = await api('POST', '/whatsapp/send', { to, message });
    if (r.sent) {
      toast('WhatsApp message sent successfully.');
      document.getElementById('wa-msg').value = '';
    } else {
      toast(r.error || 'Message send failed.', true);
    }
  } catch (e) {
    toast('Error sending message: ' + e.message, true);
  }
}

function startWaPollingIfNeeded() {
  stopWaPolling();
  waPolling = setInterval(async () => {
    const s = await loadWaStatus();
    if (s && s.connected) {
      stopWaPolling();
      return;
    }
    if (s && s.qrReady) {
      try {
        const qr = await api('GET', '/whatsapp/qr');
        if (qr && qr.qr) updateQrBox(qr.qr);
      } catch (_) {}
    }
  }, 3000);
}

function stopWaPolling() {
  if (waPolling) {
    clearInterval(waPolling);
    waPolling = null;
  }
}

/* ─── Application Bootstrap ──────────────────────────────────── */
checkAuth();
