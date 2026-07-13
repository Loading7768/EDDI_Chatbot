// ── doctors ──
async function loadDoctors() {
  const tbody = document.getElementById('doctor-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">載入中…</td></tr>';
  try {
    const list = await api('GET', '/api/doctors');
    state.doctors = Array.isArray(list) ? list : [];
    if (!state.doctors.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">無資料</td></tr>';
      return;
    }
    tbody.innerHTML = state.doctors.map(dr => `
      <tr>
        <td><code>${esc(dr.account_name)}</code></td>
        <td>${esc(dr.doctor_name)}</td>
        <td><span class="badge badge-blue">${esc(dr.specialty || '急診科')}</span></td>
        <td>
          <span class="badge ${dr.is_active ? 'badge-green' : 'badge-gray'}">
            ${dr.is_active ? '啟用' : '停用'}
          </span>
        </td>
        <td>
          <span class="badge ${dr.is_admin ? 'badge-orange' : 'badge-blue'}">
            ${dr.is_admin ? '管理員' : '醫師'}
          </span>
        </td>
        <td>
          <button class="btn btn-warn btn-xs"
            onclick="openDoctorEditModal('${esc(dr.account_name)}','${esc(dr.doctor_name)}',${dr.is_active},${dr.is_admin},'${esc(dr.specialty || '急診科')}')">
            ✏️ 修改
          </button>
          <button class="btn btn-danger btn-xs"
            ${dr.can_delete ? '' : 'disabled title="已看過病人，無法刪除"'}
            onclick="deleteDoctor('${esc(dr.account_name)}','${esc(dr.doctor_name)}')">
            🗑️ 刪除
          </button>
        </td>
      </tr>`
    ).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);padding:16px">載入失敗：${esc(String(e))}</td></tr>`;
  }
}

function openDoctorEditModal(account, name, isActive, isAdmin, specialty) {
  document.getElementById('edit-doctor-account').value       = account;
  document.getElementById('edit-doctor-account-show').value  = account;
  document.getElementById('edit-doctor-name').value          = name;
  document.getElementById('edit-doctor-pw').value            = '';
  document.getElementById('edit-doctor-active').value        = String(isActive);
  document.getElementById('edit-doctor-admin').value         = String(isAdmin);
  document.getElementById('doctor-modal-error').textContent  = '';
  populateSpecialtySelect(
    'edit-doctor-specialty-select',
    'edit-doctor-specialty-custom-group',
    'edit-doctor-specialty',
    specialty || ''
  );
  openModal('modal-doctor');
}

async function saveDoctorEdit() {
  const account   = document.getElementById('edit-doctor-account').value;
  const name      = document.getElementById('edit-doctor-name').value.trim();
  const specialty = document.getElementById('edit-doctor-specialty').value.trim();
  const pw        = document.getElementById('edit-doctor-pw').value;
  const isActive  = parseInt(document.getElementById('edit-doctor-active').value);
  const isAdmin   = parseInt(document.getElementById('edit-doctor-admin').value);
  const errEl     = document.getElementById('doctor-modal-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = '姓名不可空白'; return; }
  if (!specialty) { errEl.textContent = '科別不可空白'; return; }

  const payload = { doctor_name: name, specialty: specialty, is_active: isActive, is_admin: isAdmin };
  if (pw) payload.new_password = pw;

  const res = await api('PUT', `/api/doctors/${encodeURIComponent(account)}`, payload);
  if (res.success) {
    closeModal('modal-doctor');
    showToast('✅ 醫師資料已更新', 'ok');
    loadDoctors();
  } else {
    errEl.textContent = res.error || '儲存失敗';
  }
}

function openAddDoctorModal() {
  document.getElementById('add-doctor-account').value = '';
  document.getElementById('add-doctor-name').value = '';
  document.getElementById('add-doctor-active').value = '1';
  document.getElementById('add-doctor-admin').value = '0';
  document.getElementById('add-doctor-modal-error').textContent = '';
  
  document.getElementById('add-doctor-form-container').style.display = 'block';
  document.getElementById('add-doctor-success-container').style.display = 'none';
  
  populateSpecialtySelect(
    'add-doctor-specialty-select',
    'add-doctor-specialty-custom-group',
    'add-doctor-specialty',
    ''
  );
  openModal('modal-add-doctor');
}

function closeAddDoctorModal(shouldReload = false) {
  closeModal('modal-add-doctor');
  if (shouldReload) {
    loadDoctors();
  }
}

async function submitAddDoctor() {
  const account = document.getElementById('add-doctor-account').value.trim();
  const name = document.getElementById('add-doctor-name').value.trim();
  const specialty = document.getElementById('add-doctor-specialty').value.trim();
  const active = parseInt(document.getElementById('add-doctor-active').value, 10);
  const admin = parseInt(document.getElementById('add-doctor-admin').value, 10);
  const errEl = document.getElementById('add-doctor-modal-error');
  errEl.textContent = '';

  if (!account || !name) {
    errEl.textContent = '帳號與姓名不可空白';
    return;
  }
  if (!specialty) {
    errEl.textContent = '科別不可空白';
    return;
  }
  
  try {
    const res = await api('POST', '/api/doctors', {
      account_name: account,
      doctor_name: name,
      specialty: specialty,
      is_active: active,
      is_admin: admin
    });

    if (res.error) {
      errEl.textContent = res.error;
      return;
    }

    if (res.success && res.password) {
      document.getElementById('success-doctor-account').textContent = account;
      document.getElementById('success-doctor-password').textContent = res.password;
      
      document.getElementById('add-doctor-form-container').style.display = 'none';
      document.getElementById('add-doctor-success-container').style.display = 'block';
    } else {
      errEl.textContent = '建立失敗';
    }
  } catch (e) {
    errEl.textContent = '連線失敗: ' + e;
  }
}

function copyGeneratedPassword() {
  const account = document.getElementById('success-doctor-account').textContent;
  const password = document.getElementById('success-doctor-password').textContent;
  const textToCopy = `${password}`;
  
  navigator.clipboard.writeText(textToCopy).then(() => {
    showToast('📋 密碼已複製到剪貼簿', 'ok');
  }).catch(() => {
    showToast('❌ 複製失敗，請手動選取複製', 'fail');
  });
}

async function deleteDoctor(account, name) {
  if (!confirm(`⚠️ 確定要刪除醫師「${name}」(${account}) 嗎？\n刪除後此動作將無法復原！`)) {
    return;
  }

  try {
    const res = await api('DELETE', `/api/doctors/${encodeURIComponent(account)}`);
    if (res.success) {
      showToast('🗑️ 醫師帳號已刪除', 'ok');
      loadDoctors();
    } else {
      showToast('❌ 刪除失敗: ' + (res.error || '未知錯誤'), 'fail');
    }
  } catch (e) {
    showToast('❌ 連線失敗: ' + e, 'fail');
  }
}

// ── 已回診與科別管理 ──
let pendingDeptName = '';
let pendingDeptAction = ''; // 'disable', 'enable', 'delete'
async function populateSpecialtySelect(selectId, customGroupId, inputId, selectedValue) {
  const selectEl = document.getElementById(selectId);
  const customGroup = document.getElementById(customGroupId);
  const inputEl = document.getElementById(inputId);
  
  selectEl.innerHTML = '<option value="">載入中…</option>';
  
  try {
    const deps = await api('GET', '/api/departments');
    selectEl.innerHTML = '';
    
    // Filter active ones
    const activeDeps = deps.filter(d => d.is_active);
    
    // If selectedValue is not in active list but was specified, append it to option list
    const hasSelected = activeDeps.some(d => d.name === selectedValue);
    
    activeDeps.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = d.name;
      selectEl.appendChild(opt);
    });
    
    if (selectedValue && !hasSelected && selectedValue !== '__custom__') {
      const opt = document.createElement('option');
      opt.value = selectedValue;
      opt.textContent = selectedValue;
      selectEl.appendChild(opt);
    }
    
    // Add custom option
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = '➕ 新增其他科別';
    selectEl.appendChild(customOpt);
    
    if (selectedValue) {
      const matched = deps.some(d => d.name === selectedValue);
      if (matched) {
        selectEl.value = selectedValue;
        customGroup.style.display = 'none';
        inputEl.value = selectedValue;
      } else {
        selectEl.value = '__custom__';
        customGroup.style.display = 'block';
        inputEl.value = selectedValue;
      }
    } else {
      if (activeDeps.length > 0) {
        selectEl.value = activeDeps[0].name;
        customGroup.style.display = 'none';
        inputEl.value = activeDeps[0].name;
      } else {
        selectEl.value = '__custom__';
        customGroup.style.display = 'block';
        inputEl.value = '';
      }
    }
  } catch (err) {
    console.error('Failed to populate departments', err);
    selectEl.innerHTML = '<option value="__custom__">➕ 新增其他科別</option>';
    selectEl.value = '__custom__';
    customGroup.style.display = 'block';
    inputEl.value = selectedValue || '';
  }
}

function handleSpecialtySelectChange(selectEl, customGroupId, inputId) {
  const customGroup = document.getElementById(customGroupId);
  const inputEl = document.getElementById(inputId);
  if (selectEl.value === '__custom__') {
    customGroup.style.display = 'block';
    inputEl.value = '';
    inputEl.focus();
  } else {
    customGroup.style.display = 'none';
    inputEl.value = selectEl.value;
  }
}

function openDepartmentModal() {
  document.getElementById('new-department-name').value = '';
  document.getElementById('department-modal-error').textContent = '';
  openModal('modal-departments');
  loadDepartmentsList();
}

function closeDepartmentModal() {
  closeModal('modal-departments');
}

async function loadDepartmentsList() {
  const tbody = document.getElementById('department-tbody');
  const errEl = document.getElementById('department-modal-error');
  tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;"><div class="spinner-dark"></div></td></tr>';
  errEl.textContent = '';
  
  try {
    const list = await api('GET', '/api/departments');
    if (list.error) {
      errEl.textContent = list.error;
      tbody.innerHTML = '';
      return;
    }
    
    tbody.innerHTML = list.map(d => {
      const activeBadge = d.is_active 
        ? '<span class="badge badge-green">啟用中</span>' 
        : '<span class="badge badge-gray">已停用</span>';
      
      let actionLabel = '';
      let actionType = '';
      let actionClass = '';
      
      if (d.is_used) {
        if (d.is_active) {
          actionLabel = '⏸️ 停用';
          actionType = 'disable';
          actionClass = 'btn-warn';
        } else {
          actionLabel = '▶️ 啟用';
          actionType = 'enable';
          actionClass = 'btn-accent';
        }
      } else {
        actionLabel = '🗑️ 刪除';
        actionType = 'delete';
        actionClass = 'btn-danger';
      }
      
      return `
        <tr style="border-bottom: 1px solid var(--border);">
          <td style="padding: 10px 12px; font-weight: 500;">${esc(d.name)}</td>
          <td style="padding: 10px 12px;">${activeBadge}</td>
          <td style="padding: 10px 12px; text-align: right; display: flex; gap: 6px; justify-content: flex-end;">
            <button class="btn btn-gray btn-xs" onclick="openRenameDeptModal('${esc(d.name)}')" style="display: inline-flex; align-items: center; gap: 4px;">
              ✏️ 修改
            </button>
            <button class="btn ${actionClass} btn-xs" onclick="confirmDeptAction('${esc(d.name)}', '${actionType}', ${d.is_used})" style="display: inline-flex; align-items: center; gap: 4px;">
              ${actionLabel}
            </button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error(err);
    errEl.textContent = '載入科別清單失敗';
    tbody.innerHTML = '';
  }
}

async function addDepartment() {
  const inputEl = document.getElementById('new-department-name');
  const name = inputEl.value.trim();
  const errEl = document.getElementById('department-modal-error');
  errEl.textContent = '';
  
  if (!name) {
    errEl.textContent = '科別名稱不可為空';
    return;
  }
  
  try {
    const res = await api('POST', '/api/departments', { name });
    if (res.error) {
      errEl.textContent = res.error;
    } else {
      inputEl.value = '';
      showToast(res.message || '✅ 新增成功', 'ok');
      loadDepartmentsList();
    }
  } catch (err) {
    errEl.textContent = '連線失敗: ' + err;
  }
}

function openRenameDeptModal(oldName) {
  document.getElementById('rename-dept-old-name').value = oldName;
  document.getElementById('rename-dept-old-name-show').value = oldName;
  document.getElementById('rename-dept-new-name').value = oldName;
  document.getElementById('rename-dept-error').textContent = '';
  openModal('modal-rename-department');
}

async function executeRenameDepartment() {
  const oldName = document.getElementById('rename-dept-old-name').value;
  const newName = document.getElementById('rename-dept-new-name').value.trim();
  const errEl = document.getElementById('rename-dept-error');
  errEl.textContent = '';
  
  if (!newName) {
    errEl.textContent = '科別名稱不可為空';
    return;
  }
  if (newName === oldName) {
    closeModal('modal-rename-department');
    return;
  }
  
  try {
    const res = await api('PUT', `/api/departments/${encodeURIComponent(oldName)}`, { name: newName });
    if (res.error) {
      errEl.textContent = res.error;
    } else {
      closeModal('modal-rename-department');
      showToast('✅ 科別已成功改名', 'ok');
      loadDepartmentsList();
      if (typeof loadDoctors === 'function') {
        loadDoctors();
      }
    }
  } catch (err) {
    errEl.textContent = '連線失敗: ' + err;
  }
}

function confirmDeptAction(name, action, isUsed) {
  pendingDeptName = name;
  pendingDeptAction = action;
  
  const titleEl = document.getElementById('dept-action-title');
  const bannerTextEl = document.getElementById('dept-action-banner-text');
  const subtitleEl = document.getElementById('dept-action-subtitle');
  const confirmBtnEl = document.getElementById('btn-dept-action-confirm');
  const iconWrapEl = document.getElementById('dept-action-icon-wrap');
  const bannerEl = document.getElementById('dept-action-banner');
  
  // Clean up previous classes
  iconWrapEl.className = 'modal-alert-icon-wrap';
  bannerEl.className = 'modal-alert-banner';
  
  if (action === 'delete') {
    titleEl.textContent = '確認刪除科別';
    iconWrapEl.classList.add('danger');
    bannerEl.classList.add('danger');
    bannerTextEl.textContent = `科別「${name}」將會被完全從系統中刪除。`;
    subtitleEl.textContent = `確定要刪除「${name}」科別嗎？此操作不可逆！`;
    confirmBtnEl.textContent = '確認刪除';
    confirmBtnEl.className = 'btn btn-danger';
  } else if (action === 'disable') {
    titleEl.textContent = '確認停用科別';
    iconWrapEl.classList.add('warning');
    bannerEl.classList.add('warning');
    bannerTextEl.textContent = `科別「${name}」目前已有關聯醫師，系統無法刪除，將變更為「已停用」狀態。`;
    subtitleEl.textContent = `確定要停用「${name}」科別嗎？`;
    confirmBtnEl.textContent = '確認停用';
    confirmBtnEl.className = 'btn btn-warn';
  } else if (action === 'enable') {
    titleEl.textContent = '確認啟用科別';
    iconWrapEl.classList.add('success');
    bannerEl.classList.add('success');
    bannerTextEl.textContent = `科別「${name}」將會重新啟用，並可供新增或修改醫師時選擇。`;
    subtitleEl.textContent = `確定要啟用「${name}」科別嗎？`;
    confirmBtnEl.textContent = '確認啟用';
    confirmBtnEl.className = 'btn btn-accent';
  }
  
  openModal('modal-confirm-dept-action');
}

async function executeDeptAction() {
  const name = pendingDeptName;
  const action = pendingDeptAction;
  if (!name || !action) return;
  
  closeModal('modal-confirm-dept-action');
  
  const errEl = document.getElementById('department-modal-error');
  errEl.textContent = '';
  
  try {
    let res;
    if (action === 'delete') {
      res = await api('DELETE', `/api/departments/${encodeURIComponent(name)}`);
    } else if (action === 'disable') {
      res = await api('PUT', `/api/departments/${encodeURIComponent(name)}`, { is_active: false });
    } else if (action === 'enable') {
      res = await api('PUT', `/api/departments/${encodeURIComponent(name)}`, { is_active: true });
    }
    
    if (res.error) {
      alert(res.error);
    } else {
      if (action === 'delete') {
        showToast(res.message || '✅ 刪除成功', 'ok');
      } else {
        showToast(`✅ 已${action === 'enable' ? '啟用' : '停用'}科別`, 'ok');
      }
      loadDepartmentsList();
    }
  } catch (err) {
    alert('連線失敗: ' + err);
  }
}

