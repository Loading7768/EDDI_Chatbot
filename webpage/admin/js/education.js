// ════════════════════════════════════════════════════════════════════════
// 衛教資料管理（管理員）
// 資料來源／目的地：/api/education，儲存格式為 { 類別: 衛教內容文字 } 的 JSON
// ════════════════════════════════════════════════════════════════════════

let educationList = [];       // 目前載入的衛教資料列表 [{category, content}, ...]
let educationEditingCategory = null;  // 編輯中的原始類別名稱（null 代表「新增」模式）
let educationDeleteTarget = null;     // 準備刪除的類別名稱

// ── 共用小工具（若 script.js 已提供同名函式則優先使用，否則使用以下備援實作）──

function eduShowLoading() {
  if (typeof showLoading === 'function') { showLoading(); return; }
  const el = document.getElementById('loading');
  if (el) el.classList.add('active');
}

function eduHideLoading() {
  if (typeof hideLoading === 'function') { hideLoading(); return; }
  const el = document.getElementById('loading');
  if (el) el.classList.remove('active');
}

function eduToast(message, isOk) {
  if (typeof showToast === 'function') { showToast(message, isOk ? 'ok' : 'fail'); return; }
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('ok', 'fail');
  el.classList.add(isOk ? 'ok' : 'fail', 'show');
  clearTimeout(el._eduTimer);
  el._eduTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function truncateText(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

// ── 載入列表 ──────────────────────────────────────────────────────────────

async function loadEducationList() {
  const tbody = document.getElementById('education-tbody');
  const emptyState = document.getElementById('education-empty');
  const tableWrap = document.getElementById('education-table-wrap');
  if (!tbody) return;

  eduShowLoading();
  try {
    const res = await fetch('/api/education', { credentials: 'same-origin' });
    const data = await res.json();

    if (!res.ok) {
      eduToast(data.error || '載入衛教資料失敗', false);
      return;
    }

    educationList = Array.isArray(data) ? data : [];
    renderEducationTable();
  } catch (err) {
    eduToast('載入衛教資料時發生錯誤', false);
    console.error('[education] load error', err);
  } finally {
    eduHideLoading();
  }
}

function renderEducationTable() {
  const tbody = document.getElementById('education-tbody');
  const emptyState = document.getElementById('education-empty');
  const tableWrap = document.getElementById('education-table-wrap');
  if (!tbody) return;

  if (!educationList.length) {
    tbody.innerHTML = '';
    if (tableWrap) tableWrap.style.display = 'none';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }

  if (tableWrap) tableWrap.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  tbody.innerHTML = educationList.map((item, idx) => `
    <tr>
      <td><strong>${escapeHtml(item.category)}</strong></td>
      <td style="color:var(--muted);">${escapeHtml(truncateText(item.content, 60))}</td>
      <td>
        <button class="btn btn-gray btn-xs" data-action="edit" data-idx="${idx}">編輯</button>
        <button class="btn btn-danger btn-xs" data-action="delete" data-idx="${idx}">刪除</button>
      </td>
    </tr>
  `).join('');

  // 用 data-idx 查表後再呼叫對應函式，避免把類別名稱直接塞進 inline onclick
  // 屬性造成引號衝突（例如類別名稱裡剛好含有雙引號時會整個屬性壞掉）。
  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = educationList[Number(btn.dataset.idx)];
      if (!item) return;
      if (btn.dataset.action === 'edit') {
        openEducationEditModal(item.category);
      } else {
        openEducationDeleteModal(item.category);
      }
    });
  });
}

// ── 新增 / 編輯 Modal ────────────────────────────────────────────────────

function openEducationCreateModal() {
  educationEditingCategory = null;
  document.getElementById('education-modal-title-text').textContent = '新增衛教類別';
  document.getElementById('education-input-category').value = '';
  document.getElementById('education-input-category').disabled = false;
  document.getElementById('education-input-content').value = '';
  hideEducationModalError();
  openModal('modal-education-edit');
}

function openEducationEditModal(category) {
  const item = educationList.find(i => i.category === category);
  if (!item) {
    eduToast('找不到此類別的資料', false);
    return;
  }
  educationEditingCategory = category;
  document.getElementById('education-modal-title-text').textContent = '編輯衛教類別';
  document.getElementById('education-input-category').value = item.category;
  document.getElementById('education-input-category').disabled = false;
  document.getElementById('education-input-content').value = item.content;
  hideEducationModalError();
  openModal('modal-education-edit');
}

function closeEducationEditModal() {
  closeModal('modal-education-edit');
  hideEducationModalError();
}

function showEducationModalError(msg) {
  const el = document.getElementById('education-modal-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideEducationModalError() {
  const el = document.getElementById('education-modal-error');
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

async function submitEducationForm() {
  const category = document.getElementById('education-input-category').value.trim();
  const content = document.getElementById('education-input-content').value.trim();

  if (!category || !content) {
    showEducationModalError('類別名稱與衛教內容皆不可空白');
    return;
  }

  const saveBtn = document.getElementById('education-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  eduShowLoading();

  try {
    let res, data;
    if (educationEditingCategory === null) {
      // 新增
      res = await fetch('/api/education', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ category, content })
      });
    } else {
      // 編輯（含可能的改名）
      res = await fetch(`/api/education/${encodeURIComponent(educationEditingCategory)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ category, content })
      });
    }
    data = await res.json();

    if (!res.ok) {
      showEducationModalError(data.error || '儲存失敗，請稍後再試');
      return;
    }

    closeEducationEditModal();
    eduToast('衛教資料已儲存', true);
    await loadEducationList();
  } catch (err) {
    showEducationModalError('儲存時發生錯誤，請稍後再試');
    console.error('[education] save error', err);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    eduHideLoading();
  }
}

// ── 刪除 ─────────────────────────────────────────────────────────────────

function openEducationDeleteModal(category) {
  educationDeleteTarget = category;
  document.getElementById('education-delete-target').textContent = category;
  openModal('modal-education-delete');
}

async function confirmDeleteEducation() {
  if (!educationDeleteTarget) return;

  eduShowLoading();
  try {
    const res = await fetch(`/api/education/${encodeURIComponent(educationDeleteTarget)}`, {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    const data = await res.json();

    if (!res.ok) {
      eduToast(data.error || '刪除失敗', false);
      return;
    }

    closeModal('modal-education-delete');
    eduToast('已刪除衛教類別', true);
    educationDeleteTarget = null;
    await loadEducationList();
  } catch (err) {
    eduToast('刪除時發生錯誤', false);
    console.error('[education] delete error', err);
  } finally {
    eduHideLoading();
  }
}

// ── 載入 ──────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadEducationList();
});