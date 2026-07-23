// ════════════════════════════════════════════════════════════════════════
// 衛教資料管理（管理員）
// 列表 API：/api/education → [{bodypart, category, filename}, ...]（不含內容）
// 內容 API：/api/education-content/<filename> → {filename, content}
// 儲存的 test.json 結構：{ 部位: { 類別: {filename} } }
// 畫面採「部位」分組的手風琴樣式，預設收合，點部位標題展開/收合。
// ════════════════════════════════════════════════════════════════════════

let educationList = [];               // [{bodypart, category, filename}, ...]
let educationEditingBodypart = null;  // 編輯中的原始部位（null 代表「新增」模式）
let educationEditingCategory = null;  // 編輯中的原始類別
let educationDeleteTarget = null;     // {bodypart, category}
let expandedBodyparts = new Set();    // 目前展開中的部位名稱，重新 render 後會保留狀態

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

// ── 載入列表 ──────────────────────────────────────────────────────────────

async function loadEducationList() {
  const container = document.getElementById('education-groups');
  if (!container) return;

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

// ── 依部位分組並渲染成手風琴 ─────────────────────────────────────────────

function groupByBodypart(list) {
  const map = new Map();
  for (const item of list) {
    if (!map.has(item.bodypart)) map.set(item.bodypart, []);
    map.get(item.bodypart).push(item);
  }
  return map;
}

function renderEducationTable() {
  const container = document.getElementById('education-groups');
  const emptyState = document.getElementById('education-empty');
  const tableWrap = document.getElementById('education-table-wrap');
  if (!container) return;

  if (!educationList.length) {
    container.innerHTML = '';
    if (tableWrap) tableWrap.style.display = 'none';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }

  if (tableWrap) tableWrap.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  const grouped = groupByBodypart(educationList);

  container.innerHTML = Array.from(grouped.entries()).map(([bodypart, items]) => {
    const isOpen = expandedBodyparts.has(bodypart);

    const rows = items.map((item) => {
      const idx = educationList.indexOf(item);
      return `
        <tr>
          <td><strong>${escapeHtml(item.category)}</strong></td>
          <td style="color:var(--muted); font-family:monospace;">${escapeHtml(item.filename)}</td>
          <td>
            <button class="btn btn-gray btn-xs" data-action="edit" data-idx="${idx}">編輯</button>
            <button class="btn btn-danger btn-xs" data-action="delete" data-idx="${idx}">刪除</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="bodypart-group" style="margin-bottom:8px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
        <div class="bodypart-header" data-toggle="${escapeHtml(bodypart)}"
             style="display:flex; align-items:center; gap:8px; padding:12px 16px; cursor:pointer; background:#f8f9fb;">
          <span style="display:inline-block; transition:transform .15s; transform:rotate(${isOpen ? '90deg' : '0deg'});">▶</span>
          <strong>${escapeHtml(bodypart)}</strong>
          <span style="color:var(--muted); font-size:13px;">（${items.length} 個類別）</span>
        </div>
        <div class="bodypart-body" style="display:${isOpen ? 'block' : 'none'}; padding:8px 16px 12px 16px;">
          <table style="width:100%;">
            <thead>
              <tr>
                <th style="width:200px;">類別</th>
                <th style="width:200px;">md 檔名</th>
                <th style="width:150px;">操作</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  // 點部位標題展開/收合
  container.querySelectorAll('.bodypart-header').forEach(header => {
    header.addEventListener('click', () => {
      const bp = header.dataset.toggle;
      if (expandedBodyparts.has(bp)) {
        expandedBodyparts.delete(bp);
      } else {
        expandedBodyparts.add(bp);
      }
      renderEducationTable();
    });
  });

  // 編輯 / 刪除按鈕
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = educationList[Number(btn.dataset.idx)];
      if (!item) return;
      if (btn.dataset.action === 'edit') {
        openEducationEditModal(item.bodypart, item.category);
      } else {
        openEducationDeleteModal(item.bodypart, item.category);
      }
    });
  });
}

// ── 新增 / 編輯 Modal ────────────────────────────────────────────────────

function openEducationCreateModal() {
  educationEditingBodypart = null;
  educationEditingCategory = null;
  document.getElementById('education-modal-title-text').textContent = '新增衛教類別';
  document.getElementById('education-input-bodypart').value = '';
  document.getElementById('education-input-category').value = '';
  document.getElementById('education-input-filename').value = '';
  document.getElementById('education-input-content').value = '';
  hideEducationModalError();
  openModal('modal-education-edit');
}

async function openEducationEditModal(bodypart, category) {
  const item = educationList.find(i => i.bodypart === bodypart && i.category === category);
  if (!item) {
    eduToast('找不到此類別的資料', false);
    return;
  }

  educationEditingBodypart = bodypart;
  educationEditingCategory = category;
  document.getElementById('education-modal-title-text').textContent = '編輯衛教類別';
  document.getElementById('education-input-bodypart').value = item.bodypart;
  document.getElementById('education-input-category').value = item.category;
  document.getElementById('education-input-filename').value = item.filename;
  document.getElementById('education-input-content').value = '載入中...';
  hideEducationModalError();
  openModal('modal-education-edit');

  // content 不在列表 API 裡，另外抓 md 檔實際內容帶入
  try {
    const res = await fetch(`/api/education-content/${encodeURIComponent(item.filename)}`, { credentials: 'same-origin' });
    const data = await res.json();
    document.getElementById('education-input-content').value = res.ok ? data.content : '';
    if (!res.ok) {
      showEducationModalError(data.error || '讀取衛教內容失敗');
    }
  } catch (err) {
    document.getElementById('education-input-content').value = '';
    showEducationModalError('讀取衛教內容時發生錯誤');
    console.error('[education] read content error', err);
  }
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
  const bodypart = document.getElementById('education-input-bodypart').value.trim();
  const category = document.getElementById('education-input-category').value.trim();
  const filename = document.getElementById('education-input-filename').value.trim();
  const content = document.getElementById('education-input-content').value.trim();

  if (!bodypart || !category || !filename || !content) {
    showEducationModalError('部位、類別名稱、檔名與衛教內容皆不可空白');
    return;
  }

  const saveBtn = document.getElementById('education-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  eduShowLoading();

  try {
    let res;
    if (educationEditingCategory === null) {
      // 新增
      res = await fetch('/api/education', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ bodypart, category, content, filename })
      });
    } else {
      // 編輯（含可能的部位/類別改名）
      res = await fetch(
        `/api/education/${encodeURIComponent(educationEditingBodypart)}/${encodeURIComponent(educationEditingCategory)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ bodypart, category, content, filename })
        }
      );
    }
    const data = await res.json();

    if (!res.ok) {
      showEducationModalError(data.error || '儲存失敗，請稍後再試');
      return;
    }

    // 存檔後如果部位有變動，記得展開新的部位，讓使用者馬上看到剛存的資料
    if (educationEditingBodypart && educationEditingBodypart !== bodypart) {
      expandedBodyparts.delete(educationEditingBodypart);
    }
    expandedBodyparts.add(bodypart);

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

function openEducationDeleteModal(bodypart, category) {
  educationDeleteTarget = { bodypart, category };
  document.getElementById('education-delete-target').textContent = `${bodypart} / ${category}`;
  openModal('modal-education-delete');
}

async function confirmDeleteEducation() {
  if (!educationDeleteTarget) return;
  const { bodypart, category } = educationDeleteTarget;

  eduShowLoading();
  try {
    const res = await fetch(
      `/api/education/${encodeURIComponent(bodypart)}/${encodeURIComponent(category)}`,
      { method: 'DELETE', credentials: 'same-origin' }
    );
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

// ── 初始載入 ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadEducationList();
});