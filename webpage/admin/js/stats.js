// ── stats ──
let currentStatsData = null;

async function loadStats() {
  document.getElementById('s-error').textContent = '';
  try {
    const d = await api('GET', '/api/stats');
    if (d.error) { document.getElementById('s-error').textContent = d.error; return; }
    currentStatsData = d;
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

async function exportStatsCSV() {
  if (!currentStatsData) {
    try {
      const d = await api('GET', '/api/stats');
      if (d && !d.error) {
        currentStatsData = d;
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (!currentStatsData) {
    if (typeof showToast === 'function') {
      showToast('❌ 尚無統計數據可供下載', 'fail');
    } else {
      alert('尚無統計數據可供下載');
    }
    return;
  }

  const d = currentStatsData;
  const rows = [
    ['統計項目', '數值 / 比例', '說明'],
    ['病患總數', d.total_patients ?? 0, '系統中已建立就診紀錄的獨特病患總數'],
    ['LINE Bot 使用率', (d.bot_usage_rate ?? 0) + '%', '已開始聊天對話的病患比例'],
    ['LINE 好友總數', d.total_friends ?? 0, '已綁定 LINE 帳號之好友總數'],
    ['已對話病患數', d.patients_chatted ?? 0, '已有 LINE Bot 對話紀錄之病患人數'],
    ['病歷表單總數', d.total_forms ?? 0, '系統中建立的出院衛教表單總筆數'],
    ['複診總次數', d.return_visits ?? 0, '扣除首就診後的複診紀錄次數'],
    ['最後更新時間', d.last_updated || '—', '統計數據最後更新時間']
  ];

  const csvContent = '\uFEFF' + rows.map(row =>
    row.map(val => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  link.setAttribute('href', url);
  link.setAttribute('download', `EDDI_統計數據報表_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  if (typeof showToast === 'function') {
    showToast('✅ 統計數據 CSV 報表已成功下載', 'ok');
  }
}
