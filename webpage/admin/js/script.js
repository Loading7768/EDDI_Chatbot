// Helper to parse date strings securely
function parseDate(str) {
  if (!str) return null;
  return new Date(str.trim().replace(' ', 'T'));
}

// ── state ──
const state = { isAdmin: false, currentMrn: null, formCurrentMrn: null, doctors: [], currentForms: [], currentSessions: [], allPatients: [], allFormPatients: [] };

// ── api ──
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json();
}

function loading(on) {
  document.getElementById('loading').classList.toggle('active', on);
}

// ── toast ──
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ── modal ──
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── sidebar ──
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const app = document.getElementById('app');
  if (sb.classList.contains('open')) {
    closeSidebar();
  } else {
    sb.classList.add('open');
    ov.classList.add('open');
    app.classList.add('sidebar-open');
  }
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  document.getElementById('app').classList.remove('sidebar-open');
}

// ── auth ──
async function checkAuth() {
  const me = await api('GET', '/api/me');
  me.logged_in ? initApp(me) : showLogin();
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function initApp(me) {
  state.isAdmin = me.is_admin;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  document.getElementById('header-name').textContent = me.doctor_name;
  const roleEl = document.getElementById('header-role');
  roleEl.textContent = me.is_admin ? '管理員' : '醫師';
  roleEl.className   = 'role-tag ' + (me.is_admin ? 'role-admin' : 'role-doctor');

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = me.is_admin ? '' : 'none';
  });

  loadStats();
}

async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';

  if (!username || !password) { errEl.textContent = '請填寫帳號和密碼'; return; }

  const btn = document.getElementById('login-btn');
  btn.innerHTML = '<span class="spinner-white"></span> 登入中…';
  btn.disabled  = true;

  try {
    const res = await api('POST', '/api/login', { username, password });
    if (res.success) {
      initApp({ doctor_name: res.doctor_name, is_admin: res.is_admin });
    } else {
      errEl.textContent = res.error || '登入失敗';
    }
  } catch { errEl.textContent = '無法連線至伺服器'; }
  finally  { btn.innerHTML = '登入'; btn.disabled = false; }
}

async function executeLogout() {
  closeModal('modal-confirm-logout');
  await api('POST', '/api/logout');
  state.currentMrn = null;
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  showLogin();
}

async function doLogout() {
  if (!confirm('確定要登出系統嗎？')) {
    return;
  }
  await api('POST', '/api/logout');
  state.currentMrn = null;
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  showLogin();
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// ── navigation ──
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('section-' + name).classList.add('active');
  document.querySelector(`[data-sec="${name}"]`).classList.add('active');
  closeSidebar();

  if (name === 'stats')   loadStats();
  if (name === 'chats')   loadChats();
  if (name === 'forms')   loadFormsPatientList();
  if (name === 'prompt')  loadPrompt();
  if (name === 'doctors') loadDoctors();
}


// ── utils ──
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── init ──
initBodyDiagramEvents();
checkAuth();
