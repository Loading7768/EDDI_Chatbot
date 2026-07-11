// ── forms section ──
async function loadFormsPatientList() {
  loading(true);
  try {
    const list = await api('GET', '/api/chats');
    state.allFormPatients = Array.isArray(list) ? list : [];
    const sortCriteria = document.getElementById('form-patient-sort-select').value;
    sortAndRenderFormPatients(sortCriteria);
  } catch { 
    state.allFormPatients = [];
    renderFormPatientList([]); 
  }
  finally  { loading(false); }
}

function sortAndRenderFormPatients(criteria) {
  if (!state.allFormPatients) return;
  const patients = [...state.allFormPatients];
  
  if (criteria === 'checkout_desc') {
    patients.sort((a, b) => {
      const dateA = a.latest_checkout || '';
      const dateB = b.latest_checkout || '';
      return dateB.localeCompare(dateA);
    });
  } else if (criteria === 'checkout_asc') {
    patients.sort((a, b) => {
      const dateA = a.latest_checkout || '';
      const dateB = b.latest_checkout || '';
      return dateA.localeCompare(dateB);
    });
  } else if (criteria === 'mrn_desc') {
    patients.sort((a, b) => {
      const mrnA = a.medical_record_num || '';
      const mrnB = b.medical_record_num || '';
      return mrnB.localeCompare(mrnA);
    });
  } else if (criteria === 'mrn_asc') {
    patients.sort((a, b) => {
      const mrnA = a.medical_record_num || '';
      const mrnB = b.medical_record_num || '';
      return mrnA.localeCompare(mrnB);
    });
  }

  renderFormPatientList(patients);
}

function renderFormPatientList(patients) {
  document.getElementById('form-patient-count').textContent = patients.length;
  const body = document.getElementById('form-patient-list-body');
  if (!patients.length) {
    body.innerHTML = `<div class="empty-state" style="padding:32px 0;">
      <div class="empty-icon">👤</div><p>無病患資料</p></div>`;
    return;
  }
  body.innerHTML = patients.map(p => {
    let specialtyText = esc(p.specialty);
    let specialtyTitle = '';
    if (p.specialties && p.specialties.length > 1) {
      specialtyText += ' ...';
      specialtyTitle = `所有看診科別：${p.specialties.join(', ')}`;
    }
    return `
      <div class="patient-item${p.medical_record_num === state.formCurrentMrn ? ' active' : ''}"
           onclick="loadFormDetail('${esc(p.medical_record_num)}', this)">
        <div class="patient-mrn">
          ${esc(p.medical_record_num)}
          ${p.relation ? `<span class="badge badge-relation" style="margin-left: 6px; font-weight: 500;">${esc(p.relation)}</span>` : ''}
          ${p.needs_return_visit ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #ef4444; color: white;">需回診</span>` : ''}
        </div>
        <div class="patient-meta">
          <span class="badge badge-blue" ${specialtyTitle ? `title="${esc(specialtyTitle)}"` : ''}>${specialtyText}</span>
          <span>表單 ${p.form_count} 筆</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">就診日期：${esc(p.latest_checkout || '—')}</div>
      </div>`;
  }).join('');
}

async function loadFormDetail(mrn, el, targetDate = null) {
  state.formCurrentMrn = mrn;
  document.querySelectorAll('#form-patient-list-body .patient-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');

  const visitBody = document.getElementById('form-visit-list-body');
  visitBody.innerHTML = '<div class="empty-state"><div class="spinner-dark"></div><p>載入中…</p></div>';
  
  document.getElementById('form-edit-title').textContent = mrn;
  document.getElementById('form-edit-sub').textContent   = '';
  document.getElementById('form-edit-empty').style.display = 'block';
  document.getElementById('form-edit-container').style.display = 'none';
  const saveBtnWrapper = document.getElementById('form-edit-save-btn-wrapper');
  if (saveBtnWrapper) saveBtnWrapper.style.display = 'none';

  try {
    const d = await api('GET', '/api/chats/' + encodeURIComponent(mrn));
    if (d.error) {
      visitBody.innerHTML = `<p style="color:var(--danger);padding:16px;">${esc(d.error)}</p>`;
      return;
    }
    
    state.currentForms = d.forms || [];
    renderFormVisits(targetDate);
  } catch (err) {
    console.error(err);
    visitBody.innerHTML = '<p style="color:var(--danger);padding:16px;">載入失敗</p>';
  }
}

function renderFormVisits(targetDate = null) {
  const body = document.getElementById('form-visit-list-body');
  const forms = state.currentForms || [];
  
  document.getElementById('form-visit-count').textContent = forms.length;
  
  if (!forms.length) {
    body.innerHTML = `<div class="empty-state" style="padding:32px 0;">
      <div class="empty-icon">📋</div><p>無就診紀錄</p></div>`;
    return;
  }
  
  const sortedForms = [...forms].sort((a, b) => b.checkout_date.localeCompare(a.checkout_date));
  
  body.innerHTML = sortedForms.map((f, index) => {
    const origIdx = forms.findIndex(fa => fa.checkout_date === f.checkout_date);
    return `
      <div class="visit-item" id="form-visit-item-${index}" onclick="selectFormVisit(${origIdx}, this)">
        <div class="visit-title">${esc(f.checkout_date)}</div>
        <div class="visit-meta">
          <span class="badge badge-blue">${esc(f.specialty)}</span>
        </div>
      </div>
    `;
  }).join('');
  
  // Auto select the target visit or fallback to the first (newest) visit
  let selectEl = null;
  if (targetDate) {
    const sortedForms = [...forms].sort((a, b) => b.checkout_date.localeCompare(a.checkout_date));
    const selectIdx = sortedForms.findIndex(f => f.checkout_date === targetDate);
    if (selectIdx !== -1) {
      selectEl = body.querySelector(`#form-visit-item-${selectIdx}`);
    }
  }
  if (!selectEl) {
    selectEl = body.querySelector('.visit-item');
  }
  if (selectEl) {
    selectEl.click();
  }
}

let isEditingCard = false;

function toggleCardEditMode() {
  const btn = document.getElementById('btn-edit-card');
  const icon = document.getElementById('edit-card-icon');
  
  const cardViewMode = document.getElementById('card-view-mode');
  const cardEditMode = document.getElementById('card-edit-mode');
  const editAdminFields = document.getElementById('edit-form-admin-fields');
  
  const displayRelation = document.getElementById('display-form-relation');
  const displayMrn = document.getElementById('display-form-mrn');
  const displayDate = document.getElementById('display-form-date');
  const displayDoctor = document.getElementById('display-form-doctor');
  
  const editRelationInput = document.getElementById('edit-form-relation-input');
  const editMrnInput = document.getElementById('edit-form-mrn-input');
  const editDateInput = document.getElementById('edit-form-date-input');
  const editDoctorSelect = document.getElementById('edit-form-doctor-select');
  const editDoctorGroup = document.getElementById('edit-form-doctor-group');

  isEditingCard = !isEditingCard;
  
  if (isEditingCard) {
    if (editDoctorGroup) editDoctorGroup.style.display = 'flex';
    // Switch to edit mode
    if (cardViewMode) cardViewMode.style.display = 'none';
    if (cardEditMode) cardEditMode.style.display = 'flex';
    
    // 任何醫師都可編輯關係
    if (editRelationInput && displayRelation) editRelationInput.value = displayRelation.textContent.trim();
    
    if (state.isAdmin) {
      if (editAdminFields) editAdminFields.style.display = 'flex';
      if (editMrnInput && displayMrn) editMrnInput.value = displayMrn.textContent.trim();
    } else {
      if (editAdminFields) editAdminFields.style.display = 'none';
    }
    
    if (editDateInput && displayDate) {
      // Convert YYYY-MM-DD HH:MM:SS.SSS to YYYY-MM-DDTHH:MM
      const currentVal = displayDate.textContent.trim();
      editDateInput.value = currentVal.substring(0, 16).replace(' ', 'T');
    }
    
    // Set doctor select value to match current doctor account
    if (editDoctorSelect) {
      const origDate = document.getElementById('edit-form-orig-date').value;
      const f = state.currentForms.find(form => form.checkout_date === origDate);
      if (f) {
        editDoctorSelect.value = f.doctor_account;
      }
    }
    
    // Change edit button icon to checkmark
    if (icon) icon.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;
    if (btn) btn.style.backgroundColor = '#fbbf24'; // Orange/Yellow when editing
  } else {
    // Validate inputs
    let relationVal = displayRelation ? displayRelation.textContent.trim() : '本人';
    if (editRelationInput) relationVal = editRelationInput.value.trim();
    if (!relationVal) {
      alert('關係不能為空');
      isEditingCard = true;
      return;
    }
    
    let mrnVal = displayMrn ? displayMrn.textContent.trim() : '';
    if (state.isAdmin) {
      if (editMrnInput) mrnVal = editMrnInput.value.trim();
      if (!mrnVal) {
        alert('病歷號不能為空');
        isEditingCard = true;
        return;
      }
    }
    
    let dateVal = editDateInput ? editDateInput.value : '';
    if (!dateVal) {
      alert('就診日期不能為空');
      isEditingCard = true;
      return;
    }
    dateVal = dateVal.replace('T', ' ').trim();
    if (dateVal.length >= 16) {
      let secondsPart = ":00";
      if (dateVal.length >= 19) {
        secondsPart = dateVal.substring(16, 19);
      }
      dateVal = dateVal.substring(0, 16) + secondsPart + ".000";
    }

    if (displayRelation) displayRelation.textContent = relationVal;
    if (state.isAdmin) {
      if (displayMrn) displayMrn.textContent = mrnVal;
    }
    
    if (displayDate) displayDate.textContent = dateVal;
    
    if (editDoctorSelect && displayDoctor) {
      const currentDr = state.doctors.find(dr => dr.account_name === editDoctorSelect.value);
      if (currentDr) {
        displayDoctor.textContent = currentDr.doctor_name;
      } else {
        displayDoctor.textContent = editDoctorSelect.value || '—';
      }
    }
    
    if (editDoctorGroup) editDoctorGroup.style.display = 'none';
    // Switch to view mode
    if (cardViewMode) cardViewMode.style.display = 'block';
    if (cardEditMode) cardEditMode.style.display = 'none';
    
    // Change edit button icon back to pencil
    if (icon) {
      icon.innerHTML = `
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
      `;
    }
    if (btn) btn.style.backgroundColor = '#06C755';
  }
  if (typeof checkFormModified === 'function') {
    checkFormModified();
  }
}

async function selectFormVisit(idx, el) {
  document.querySelectorAll('#form-visit-list-body .visit-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');

  const f   = state.currentForms[idx];
  const mrn = state.formCurrentMrn;
  if (!f || !mrn) return;

  document.getElementById('form-edit-title').textContent = `${mrn} (${f.checkout_date})`;
  document.getElementById('form-edit-sub').textContent   = '修改此就診病歷表單';

  document.getElementById('edit-form-mrn').value          = mrn;
  document.getElementById('edit-form-orig-date').value    = f.checkout_date;
  
  // Reset inline edit states
  isEditingCard = false;
  
  // Ensure we are in view mode
  const cardViewMode = document.getElementById('card-view-mode');
  const cardEditMode = document.getElementById('card-edit-mode');
  const editAdminFields = document.getElementById('edit-form-admin-fields');
  
  if (cardViewMode) cardViewMode.style.display = 'block';
  if (cardEditMode) cardEditMode.style.display = 'none';
  if (editAdminFields) editAdminFields.style.display = 'none';
  
  // Reset edit button style and icon to pencil
  const btnEditCard = document.getElementById('btn-edit-card');
  if (btnEditCard) {
    btnEditCard.disabled = false;
    btnEditCard.style.opacity = '1';
    btnEditCard.style.cursor = 'pointer';
    btnEditCard.style.backgroundColor = '#06C755';
    const icon = document.getElementById('edit-card-icon');
    if (icon) {
      icon.innerHTML = `
        <path d="M12 20h9"></path>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
      `;
    }
  }
  
  const warningEl = document.getElementById('edit-form-mrn-warning');
  if (warningEl) warningEl.style.display = 'none';
  
  document.getElementById('form-edit-error').textContent = '';

  // Populate values
  const patientObj = state.allFormPatients.find(p => p.medical_record_num === mrn);
  const relationText = patientObj ? (patientObj.relation || '本人') : '本人';
  
  const displayRelation = document.getElementById('display-form-relation');
  const displayMrn = document.getElementById('display-form-mrn');
  const displayDate = document.getElementById('display-form-date');
  const displayFormReturnBadge = document.getElementById('display-form-return-badge');
  
  if (displayRelation) displayRelation.textContent = relationText;
  if (displayMrn) displayMrn.textContent = mrn;
  if (displayDate) displayDate.textContent = f.checkout_date;

  if (displayFormReturnBadge) {
    if (patientObj && patientObj.needs_return_visit) {
      displayFormReturnBadge.style.display = '';
    } else {
      displayFormReturnBadge.style.display = 'none';
    }
  }
  
  const editRelationInput = document.getElementById('edit-form-relation-input');
  const editMrnInput = document.getElementById('edit-form-mrn-input');
  const editDateInput = document.getElementById('edit-form-date-input');
  
  if (editRelationInput) editRelationInput.value = relationText;
  if (editMrnInput) editMrnInput.value = mrn;
  if (editDateInput) editDateInput.value = f.checkout_date.substring(0, 16).replace(' ', 'T');

  // Show container, hide empty
  document.getElementById('form-edit-empty').style.display = 'none';
  document.getElementById('form-edit-container').style.display = 'block';
  const saveBtnWrapper = document.getElementById('form-edit-save-btn-wrapper');
  if (saveBtnWrapper) saveBtnWrapper.style.display = 'block';

  // 初始化人體圖狀態
  selectedTopics = new Set(f.symptoms || []);
  closePopover();
  renderConfirmedChips(true);

  // Populate Doctor select
  const sel = document.getElementById('edit-form-doctor-select');
  if (!state.doctors.length) {
    const list = await api('GET', '/api/doctors');
    state.doctors = Array.isArray(list) ? list : [];
  }
  sel.innerHTML = state.doctors.map(dr =>
    `<option value="${esc(dr.account_name)}" ${dr.account_name === f.doctor_account ? 'selected' : ''}>
      ${esc(dr.account_name)} — ${esc(dr.doctor_name)}
    </option>`
  ).join('');
  
  // Update display doctor name
  const displayDoctor = document.getElementById('display-form-doctor');
  const currentDr = state.doctors.find(dr => dr.account_name === f.doctor_account);
  if (displayDoctor) {
    if (currentDr) {
      displayDoctor.textContent = currentDr.doctor_name;
    } else {
      displayDoctor.textContent = f.doctor_account || '—';
    }
  }}

async function saveFormEdit() {
  // If still in edit mode, toggle back to view mode to validate and read inputs
  if (isEditingCard) {
    toggleCardEditMode();
  }
  if (isEditingCard) return;

  const mrn      = document.getElementById('edit-form-mrn').value;
  const origDate = document.getElementById('edit-form-orig-date').value;
  
  const displayMrn = document.getElementById('display-form-mrn').textContent.trim();
  const displayRelation = document.getElementById('display-form-relation').textContent.trim();
  const displayDate = document.getElementById('display-form-date').textContent.trim();
  
  const doctorSelect = document.getElementById('edit-form-doctor-select');
  const doctor = doctorSelect.value;
  const symptoms = Array.from(selectedTopics);
  const errEl    = document.getElementById('form-edit-error');
  errEl.textContent = '';

  if (state.isAdmin && !displayMrn) { errEl.textContent = '請填寫病歷號'; return; }
  if (state.isAdmin && !displayRelation) { errEl.textContent = '請填寫關係'; return; }
  if (!displayDate) { errEl.textContent = '請填寫就診日期'; return; }
  if (symptoms.length === 0) { errEl.textContent = '請至少選擇一項衛教資料'; return; }

  const payload = { checkout_date: displayDate, symptoms };
  if (state.isAdmin) {
    payload.medical_record_num = displayMrn;
  }
  payload.relation = displayRelation;
  if (doctor) payload.doctor_account = doctor;

  const res = await api('PUT', `/api/forms/${encodeURIComponent(mrn)}/${encodeURIComponent(origDate)}`, payload);
  if (res.success) {
    showToast('✅ 表單已儲存', 'ok');
    
    // Reload patients list in Column 1
    await loadFormsPatientList();
    
    const targetMrn = state.isAdmin ? displayMrn : mrn;
    state.formCurrentMrn = targetMrn;
    
    // Find the patient element to set active
    const patientItemEl = Array.from(document.querySelectorAll('#form-patient-list-body .patient-item'))
                               .find(item => item.textContent.includes(targetMrn));
                               
    // Reload visit list (Column 2) and select the modified visit
    await loadFormDetail(targetMrn, patientItemEl, displayDate);
    
    // 同步更新聊天紀錄列表
    if (state.currentMrn === mrn || state.currentMrn === displayMrn) {
      loadDetail(targetMrn, null);
    }
  } else {
    document.getElementById('error-alert-message').textContent = res.error || '儲存失敗';
    openModal('modal-alert-error');
    errEl.textContent = res.error || '儲存失敗';
    
    // Revert form content to original state
    const idx = state.currentForms.findIndex(form => form.checkout_date === origDate);
    if (idx !== -1) {
      const activeEl = document.querySelector('#form-visit-list-body .visit-item.active');
      selectFormVisit(idx, activeEl);
    }
  }
}

// ── 人體圖互動邏輯與衛教對應 ──
const topicMapping = {
    "頭": ["頭暈", "流鼻血", "發燒", "頭痛", "偏頭痛", "噁心嘔吐", "眩暈"],
    "脖子": ["咳嗽", "咳血", "打嗝"],
    "手": [],
    "軀幹上半部": ["胸痛", "心悸", "呼吸急促/呼吸困難", "上背痛"],
    "軀幹下半部": ["腹痛", "腸胃炎/病毒性腸胃炎", "便秘", "腹瀉", "腰痛", "吐血、解黑便、解血便、胃腸道出血", "血尿", "下背痛", "尿滯留", "懷孕早期陰道出血", "懷孕後期陰道出血", "月經週期間陰道出血"],
    "腳": [],
    "皮膚": ["燒燙傷", "水腫", "皮膚疹子(皮疹)"],
    "精神": ["譫妄、意識混亂", "虛弱", "暈厥、暈倒"],
    "其他": ["高血壓", "肌肉、關節和骨骼疼痛", "癲癇", "休克", "一般外傷、鈍挫傷、扭傷、拉傷", "傷口處置原則"]
};

let selectedTopics = new Set();
let currentActiveRegion = null;

function getFormEl(id) {
  return document.querySelector(`#form-edit-container #${id}`) || document.getElementById(id);
}

function initBodyDiagramEvents() {
  const popover = getFormEl('popover');
  const hotspots = document.querySelectorAll('#form-edit-container .hotspot');
  const popoverCloseBtn = getFormEl('popover-close');

  if (popoverCloseBtn) {
    popoverCloseBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      closePopover();
    });
  }

  hotspots.forEach(spot => {
    spot.addEventListener('click', function(e) {
      e.stopPropagation();

      const region = this.getAttribute('data-region');

      if (currentActiveRegion === region && popover.classList.contains('show')) {
        closePopover();
        return;
      }

      hotspots.forEach(s => s.classList.remove('active'));
      this.classList.add('active');
      currentActiveRegion = region;

      showPopover(this, region);
    });
  });

  if (popover) {
    popover.addEventListener('click', function(e) { e.stopPropagation(); });
  }

  document.addEventListener('click', function(e) {
    if (!e.target.closest('#form-edit-container #image-wrapper')) {
      closePopover();
    }

    const hasInactive = document.querySelectorAll('#form-edit-container .chip.inactive').length > 0;
    if (hasInactive && !e.target.closest('#form-edit-container .confirmation-section')) {
      renderConfirmedChips(true);
    }
  });
}

function closePopover() {
  const popover = getFormEl('popover');
  if (!popover) return;
  popover.classList.remove('show');
  popover.style.display = 'none';
  
  const layout = document.querySelector('#form-edit-container .interactive-layout');
  if (layout) {
    layout.classList.remove('popover-open');
    layout.classList.remove('trigger-body');
    layout.classList.remove('trigger-button');
  }
  
  const hotspots = document.querySelectorAll('#form-edit-container .hotspot');
  hotspots.forEach(s => s.classList.remove('active'));
  currentActiveRegion = null;
}

function showPopover(hotspotEl, region) {
  const popover = getFormEl('popover');
  const popoverTitle = getFormEl('popover-title');
  const popoverCheckboxes = getFormEl('popover-checkboxes');
  if (!popover || !popoverTitle || !popoverCheckboxes) return;

  popoverTitle.textContent = `「${region}」相關衛教`;
  popoverCheckboxes.innerHTML = '';

  const topics = topicMapping[region] || [];
  if (topics.length === 0) {
    popoverCheckboxes.innerHTML = '<span style="color:#777; font-size:14px; padding: 10px; display: block;">此區域無相關衛教資料。</span>';
  } else {
    topics.forEach(topic => {
      const label = document.createElement('label');
      label.className = 'pop-checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = topic;
      checkbox.checked = selectedTopics.has(topic);
      checkbox.addEventListener('change', function() {
        if (this.checked) selectedTopics.add(topic);
        else selectedTopics.delete(topic);
        renderConfirmedChips();
      });

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(topic));
      popoverCheckboxes.appendChild(label);
    });
  }

  popover.style.display = 'block';
  popover.offsetHeight; // Force reflow
  popover.classList.add('show');

  const layoutEl = document.querySelector('#form-edit-container .interactive-layout');
  if (!layoutEl) return;
  const posType = hotspotEl.getAttribute('data-position');
  
  if (posType === 'body') {
    layoutEl.classList.add('trigger-body');
    layoutEl.classList.remove('trigger-button');
    popover.className = 'arrow-left show';
  } else {
    layoutEl.classList.add('trigger-button');
    layoutEl.classList.remove('trigger-body');
    popover.className = 'arrow-right show';
  }
  layoutEl.classList.add('popover-open');

  const layoutRect = layoutEl.getBoundingClientRect();
  const spotRect = hotspotEl.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();

  const spotCenterY = (spotRect.top + spotRect.bottom) / 2 - layoutRect.top;

  let popoverTop = spotCenterY - popoverRect.height / 2;
  const maxTop = layoutRect.height - popoverRect.height - 15;
  popoverTop = Math.max(0, Math.min(popoverTop, maxTop));

  popover.style.position = 'absolute';
  popover.style.top = popoverTop + 'px';

  let arrowTop = spotCenterY - popoverTop;
  arrowTop = Math.max(20, Math.min(arrowTop, popoverRect.height - 20));
  popover.style.setProperty('--arrow-top', arrowTop + 'px');

  let spotLeft = spotRect.left - layoutRect.left;
  let spotRight = spotRect.right - layoutRect.left;

  const popoverColumn = document.querySelector('#form-edit-container .popover-column');
  if (popoverColumn) {
    let popoverLeft = 0;
    if (posType === 'body') {
      popoverLeft = spotRight + 6;
    } else {
      popoverLeft = spotLeft - 226;
    }
    popoverColumn.style.left = popoverLeft + 'px';
  }
}

function syncPopoverCheckboxes() {
  document.querySelectorAll('#form-edit-container .pop-checkbox-item input').forEach(cb => {
    cb.checked = selectedTopics.has(cb.value);
  });
}

function renderConfirmedChips(forceClean = false) {
  const confirmedList = getFormEl('confirmed-list');
  const emptyMsg = getFormEl('empty-msg');
  if (!confirmedList || !emptyMsg) return;

  if (forceClean) {
    confirmedList.innerHTML = '';
    selectedTopics.forEach(topic => {
      confirmedList.appendChild(createChipElement(topic, true));
    });
  } else {
    const currentChips = Array.from(confirmedList.querySelectorAll('.chip'));
    const currentTopicNames = currentChips.map(c => c.dataset.topic);
    
    selectedTopics.forEach(topic => {
      if (!currentTopicNames.includes(topic)) {
        confirmedList.appendChild(createChipElement(topic, true));
      } else {
        const chip = currentChips.find(c => c.dataset.topic === topic);
        if (chip) {
          chip.classList.add('active');
          chip.classList.remove('inactive');
          chip.querySelector('.icon').textContent = '✓';
        }
      }
    });
    
    currentChips.forEach(chip => {
      const topic = chip.dataset.topic;
      if (!selectedTopics.has(topic)) {
        chip.classList.remove('active');
        chip.classList.add('inactive');
        chip.querySelector('.icon').textContent = '✕';
      }
    });
  }

  const confirmationSection = document.querySelector('#form-edit-container .confirmation-section');
  if (confirmationSection) {
    if (selectedTopics.size > 0) {
      confirmationSection.style.display = 'block';
    } else {
      confirmationSection.style.display = 'none';
    }
  }

  if (confirmedList.children.length === 0) {
    emptyMsg.style.display = 'block';
  } else {
    emptyMsg.style.display = 'none';
  }
  
  if (typeof checkFormModified === 'function') {
    checkFormModified();
  }
}

function createChipElement(topic, isActive) {
  const div = document.createElement('div');
  div.className = `chip ${isActive ? 'active' : 'inactive'}`;
  div.dataset.topic = topic;
  
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = isActive ? '✓' : '✕';
  
  const text = document.createElement('span');
  text.textContent = topic;
  
  div.appendChild(icon);
  div.appendChild(text);
  
  div.addEventListener('click', function(e) {
    e.stopPropagation();
    
    if (selectedTopics.has(topic)) {
      selectedTopics.delete(topic);
      div.classList.remove('active');
      div.classList.add('inactive');
      icon.textContent = '✕';
    } else {
      selectedTopics.add(topic);
      div.classList.add('active');
      div.classList.remove('inactive');
      icon.textContent = '✓';
    }
    syncPopoverCheckboxes();
  });
  
  return div;
}
// ── 修改表單儲存按鈕狀態檢查 ──
function checkFormModified() {
  const saveBtn = document.getElementById('btn-save-form-edit');
  if (!saveBtn) return;
  
  const mrn = document.getElementById('edit-form-mrn').value;
  const origDate = document.getElementById('edit-form-orig-date').value;
  if (!mrn || !origDate) {
    saveBtn.disabled = true;
    saveBtn.style.opacity = '0.5';
    saveBtn.style.cursor = 'not-allowed';
    return;
  }
  
  const f = state.currentForms.find(form => form.checkout_date === origDate);
  if (!f) return;
  
  const origMrn = mrn;
  const patientObj = state.allFormPatients.find(p => p.medical_record_num === origMrn);
  const origRelation = patientObj ? (patientObj.relation || '本人') : '本人';
  const origSymptoms = f.symptoms || [];
  
  const editRelationInput = document.getElementById('edit-form-relation-input');
  const editMrnInput = document.getElementById('edit-form-mrn-input');
  
  let currentRelation = origRelation;
  let currentMrn = origMrn;
  
  if (isEditingCard) {
    if (editRelationInput) currentRelation = editRelationInput.value.trim();
    if (state.isAdmin && editMrnInput) currentMrn = editMrnInput.value.trim();
  } else {
    const displayRelation = document.getElementById('display-form-relation');
    const displayMrn = document.getElementById('display-form-mrn');
    if (displayRelation) currentRelation = displayRelation.textContent.trim();
    if (displayMrn) currentMrn = displayMrn.textContent.trim();
  }
  
  const currentSymptoms = Array.from(selectedTopics);
  
  let symptomsModified = false;
  if (currentSymptoms.length !== origSymptoms.length) {
    symptomsModified = true;
  } else {
    symptomsModified = currentSymptoms.some(s => !origSymptoms.includes(s));
  }
  
  const mrnModified = (currentMrn !== origMrn);
  const relationModified = (currentRelation !== origRelation);
  
  const isModified = mrnModified || relationModified || symptomsModified;
  
  if (isModified) {
    saveBtn.disabled = false;
    saveBtn.style.opacity = '1';
    saveBtn.style.cursor = 'pointer';
  } else {
    saveBtn.disabled = true;
    saveBtn.style.opacity = '0.5';
    saveBtn.style.cursor = 'not-allowed';
  }
}

// Register listeners during page script loading
document.getElementById('edit-form-relation-input').addEventListener('input', checkFormModified);
document.getElementById('edit-form-mrn-input').addEventListener('input', function() {
  const enteredMrn = this.value.trim();
  const originalMrn = document.getElementById('edit-form-mrn').value;
  const warningEl = document.getElementById('edit-form-mrn-warning');
  const btnEditCard = document.getElementById('btn-edit-card');
  
  if (enteredMrn !== originalMrn && state.allFormPatients && state.allFormPatients.some(p => p.medical_record_num === enteredMrn)) {
    warningEl.style.display = 'block';
    btnEditCard.disabled = true;
    btnEditCard.style.opacity = '0.5';
    btnEditCard.style.cursor = 'not-allowed';
  } else {
    warningEl.style.display = 'none';
    btnEditCard.disabled = false;
    btnEditCard.style.opacity = '1';
    btnEditCard.style.cursor = 'pointer';
  }
  checkFormModified();
});

