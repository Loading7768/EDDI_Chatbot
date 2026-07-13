// ── prompt ──
function checkPromptModified() {
  const ta = document.getElementById('prompt-textarea');
  const btnSave = document.getElementById('btn-save-prompt');
  if (!btnSave) return;
  const modified = ta.value !== (state.originalPromptContent || '');
  btnSave.disabled = !modified;
}

async function loadPrompt(version) {
  const ta = document.getElementById('prompt-textarea');
  const activeTa = document.getElementById('prompt-active-textarea');
  const nickInput = document.getElementById('prompt-nickname-input');
  
  ta.value = '載入中…'; ta.disabled = true;
  if (activeTa) {
    activeTa.value = '載入中…';
  }
  if (nickInput) {
    nickInput.value = '';
    nickInput.disabled = true;
  }
  
  document.getElementById('save-status').textContent = '';
  document.getElementById('btn-rollback-prompt').style.display = 'none';
  document.getElementById('btn-next-prompt').style.display = 'none';
  document.getElementById('btn-delete-prompt').style.display = 'none';
  document.getElementById('btn-apply-prompt').disabled = true;
  
  const editingLabel = document.getElementById('editing-version-label');
  const activeLabel = document.getElementById('active-version-label');
  const activeBadge = document.getElementById('active-badge');
  
  if (editingLabel) editingLabel.textContent = '-';
  if (activeLabel) activeLabel.textContent = '-';
  if (activeBadge) activeBadge.style.display = 'none';
  
  try {
    let url = '/api/prompt';
    if (version) {
      url += '?version=' + encodeURIComponent(version);
    }
    const d = await api('GET', url);
    ta.value    = d.error ? '錯誤：' + d.error : (d.content || '');
    ta.disabled = !!d.error;
    
    if (d.error) return;
    
    const getDisplayLabel = (ver, nicknames) => {
      if (!ver) return '-';
      const nick = nicknames && nicknames[ver];
      return nick ? `${nick}(${ver})` : ver;
    };
    
    if (editingLabel) editingLabel.textContent = getDisplayLabel(d.current_version, d.nicknames);
    if (activeLabel) activeLabel.textContent = getDisplayLabel(d.active_version, d.nicknames);
    
    if (activeTa) {
      activeTa.value = d.active_content || '';
    }
    if (nickInput) {
      nickInput.disabled = false;
      nickInput.value = (d.nicknames && d.nicknames[d.current_version]) || '';
    }
    
    state.originalPromptContent = d.content || '';
    state.viewingVersion = d.current_version;
    state.activeVersion = d.active_version;
    state.prevVersion = d.prev_version;
    state.nextVersion = d.next_version;
    
    checkPromptModified();
    
    const activeCol = document.getElementById('prompt-active-column');
    const centerCol = document.querySelector('.prompt-col-center');
    
    if (d.current_version === d.active_version) {
      if (activeBadge) activeBadge.style.display = 'inline-block';
      document.getElementById('btn-apply-prompt').disabled = true;
      if (activeCol) activeCol.style.display = 'none';
      if (centerCol) centerCol.style.flex = '0 0 80%';
    } else {
      if (activeBadge) activeBadge.style.display = 'none';
      document.getElementById('btn-apply-prompt').disabled = false;
      if (activeCol) activeCol.style.display = 'flex';
      if (centerCol) centerCol.style.flex = '0 0 40%';
    }
    
    if (d.has_prev) {
      document.getElementById('btn-rollback-prompt').style.display = 'inline-block';
    }
    if (d.has_next) {
      document.getElementById('btn-next-prompt').style.display = 'inline-block';
    }
    if (d.current_version && d.current_version !== 'prompt_001.md') {
      document.getElementById('btn-delete-prompt').style.display = 'inline-block';
    }
    
    if (d.versions) {
      renderPromptVersionsList(d.versions, d.active_version, d.current_version, d.nicknames);
    }
  } catch (e) { 
    ta.value = '無法連線至伺服器'; 
    console.error(e);
  }
}

function renderPromptVersionsList(versions, activeVersion, viewingVersion, nicknames) {
  const listEl = document.getElementById('prompt-version-list');
  if (!listEl) return;
  listEl.innerHTML = versions.map(v => {
    const isActive = v === activeVersion;
    const isViewing = v === viewingVersion;
    const displayLabel = nicknames && nicknames[v] ? `${nicknames[v]}(${v})` : v;
    return `
      <div class="patient-item${isViewing ? ' active' : ''}" 
           style="padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer;"
           onclick="loadPrompt('${v}')">
        <div style="font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: space-between;">
          <span>${displayLabel}</span>
          ${isActive ? '<span class="badge badge-green" style="font-size: 9px; padding: 1px 4px;">使用中</span>' : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function savePromptNickname() {
  const version = state.viewingVersion;
  if (!version) return;
  const nickname = document.getElementById('prompt-nickname-input').value.trim();
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '儲存名稱中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt/nickname', { version, nickname });
    if (res.success) {
      statusEl.textContent = '✅ 已成功儲存版本名稱';
      statusEl.className   = 'save-status ok';
      loadPrompt(version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '儲存名稱失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch (err) {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
    console.error(err);
  }
}

function savePrompt() {
  doSavePrompt();
}

async function doSavePrompt() {
  const content = document.getElementById('prompt-textarea').value;
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '儲存中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt', { content });
    if (res.success) {
      statusEl.textContent = '✅ 已儲存並新增版本：' + (res.version || '');
      statusEl.className   = 'save-status ok';
      loadPrompt(res.version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '儲存失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
  }
}

function prevPromptVersion() {
  if (state.prevVersion) {
    loadPrompt(state.prevVersion);
  }
}

function nextPromptVersion() {
  if (state.nextVersion) {
    loadPrompt(state.nextVersion);
  }
}

function applyPrompt() {
  openModal('modal-confirm-apply-prompt');
}

async function doApplyPrompt() {
  closeModal('modal-confirm-apply-prompt');
  const version = state.viewingVersion;
  if (!version) return;
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '套用中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt/switch', { version });
    if (res.success) {
      statusEl.textContent = '✅ 已成功套用此 Prompt 版本';
      statusEl.className   = 'save-status ok';
      loadPrompt(version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '套用失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
  }
}

function deletePrompt() {
  openModal('modal-confirm-delete-prompt');
}

async function doDeletePrompt() {
  closeModal('modal-confirm-delete-prompt');
  const version = state.viewingVersion;
  if (!version) return;
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '刪除中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt/delete', { version });
    if (res.success) {
      statusEl.textContent = '✅ 已成功刪除版本';
      statusEl.className   = 'save-status ok';
      loadPrompt(res.version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '刪除失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
  }
}

