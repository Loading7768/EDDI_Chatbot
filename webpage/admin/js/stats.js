// ── stats ──
async function loadStats() {
  document.getElementById('s-error').textContent = '';
  try {
    const d = await api('GET', '/api/stats');
    if (d.error) { document.getElementById('s-error').textContent = d.error; return; }
    const friendsEl = document.getElementById('s-friends');
    if (friendsEl) friendsEl.textContent = d.total_friends ?? '—';
    const patientsEl = document.getElementById('s-patients');
    if (patientsEl) patientsEl.textContent = d.total_patients ?? '—';
    const usageEl = document.getElementById('s-usage');
    if (usageEl) usageEl.textContent = (d.bot_usage_rate ?? '—') + '%';
    const returnEl = document.getElementById('s-return');
    if (returnEl) returnEl.textContent = d.return_visits ?? '—';
    document.getElementById('s-updated').textContent =
      d.last_updated ? '最後更新：' + d.last_updated : '';
  } catch (err) {
    console.error(err);
    document.getElementById('s-error').textContent = '無法載入統計資料';
  }
}

