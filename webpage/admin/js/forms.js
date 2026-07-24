// ── forms state management ──
function setFormsState(stateName) {
  if (state.viewEditMode) {
    exitViewEditMode(false);
  }
  // stateName: 'view', 'nurse', 'doctor'
  const layout = document.getElementById('forms-layout');
  if (layout) layout.setAttribute('data-state', stateName);

  // Toggle buttons
  document.querySelectorAll('.forms-state-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`btn-state-${stateName}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Toggle content panels
  document.querySelectorAll('.forms-state-content').forEach(c => c.classList.remove('active'));
  const activeContent = document.getElementById(`content-state-${stateName}`);
  if (activeContent) activeContent.classList.add('active');

  // State-specific init
  if (stateName === 'nurse') loadNurseLineAccounts();
  if (stateName === 'doctor') loadDoctorDrafts();
}

// ── doctor form ──
async function loadDischargeCategories() {
  if (state.dischargeCategories) return;
  try {
    const res = await fetch('/assets/discharge/category.json');
    state.dischargeCategories = await res.json();
  } catch (e) {
    console.error('loadDischargeCategories error', e);
    state.dischargeCategories = {};
  }
}

async function loadDoctorDrafts() {
  await loadDischargeCategories();
  try {
    const res = await api('GET', '/api/forms/doctor_drafts');
    const drafts = (res && Array.isArray(res.drafts)) ? res.drafts : [];

    // Update doctor badge counters
    const badge = document.getElementById('doctor-draft-badge');
    const headerCount = document.getElementById('doctor-draft-header-count');
    if (badge) {
      badge.textContent = drafts.length;
      badge.style.display = drafts.length > 0 ? 'inline-flex' : 'none';
    }
    if (headerCount) {
      headerCount.textContent = drafts.length;
    }

    // Render doctor drafts list in main column
    const listEl = document.getElementById('doctor-draft-list');
    if (!listEl) return;

    if (drafts.length === 0) {
      listEl.innerHTML = '<div class="empty-state" style="padding:32px 0;"><div class="empty-icon">📋</div><p>無未完成出院單</p></div>';
      resetDoctorFormPanel();
      return;
    }

    listEl.innerHTML = '';
    drafts.forEach(d => {
      const item = document.createElement('div');
      item.className = 'patient-item';
      if (state.selectedDoctorDraft && state.selectedDoctorDraft.filename === d.filename) {
        item.classList.add('active');
      }
      item.onclick = (e) => selectDoctorDraft(d.filename, d.mrn, e.currentTarget);
      item.innerHTML = `
        <div class="patient-name" style="font-weight:700;font-size:14px;color:var(--text);">${esc(d.mrn)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">就診日期：${esc(d.date)}</div>
      `;
      listEl.appendChild(item);
    });
  } catch (e) {
    console.error('loadDoctorDrafts error', e);
  }
}

async function selectDoctorDraft(filename, mrn, targetEl) {
  // Highlight selected item
  document.querySelectorAll('#doctor-draft-list .patient-item').forEach(el => {
    el.classList.remove('active');
  });
  if (targetEl) targetEl.classList.add('active');

  try {
    const res = await api('GET', `/api/forms/doctor_draft/${encodeURIComponent(filename)}`);
    if (!res.success || !res.data) {
      showToast('❌ 載入草稿內容失敗', 'fail');
      return;
    }

    const data = res.data;
    state.selectedDoctorDraft = { filename, data };
    state.selectedSymptoms = Array.isArray(data.symptoms) ? [...data.symptoms] : [];

    // Header update
    const titleEl = document.getElementById('doctor-fp-title');
    const subEl = document.getElementById('doctor-fp-sub');
    const btnsEl = document.getElementById('doctor-fp-btns');

    if (titleEl) titleEl.textContent = '請選擇衛教資料';
    if (subEl) subEl.textContent = '點擊標籤進行選擇或取消';
    if (btnsEl) btnsEl.style.display = 'flex';

    // Show content, hide placeholder
    const placeholderEl = document.getElementById('doctor-fp-placeholder');
    const contentEl = document.getElementById('doctor-fp-content');
    if (placeholderEl) placeholderEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'flex';

    // Populate Meta Box
    const dateFormatted = data.checkout_date ? data.checkout_date.substring(0, 10) : '-';
    document.getElementById('doctor-meta-date').textContent = dateFormatted;
    document.getElementById('doctor-meta-doctor').textContent = (data.doctor_name || '醫師') + ' 醫師';
    document.getElementById('doctor-meta-line-name').textContent = data.line_name || '-';
    document.getElementById('doctor-meta-relation').textContent = data.relation || '帳號本人';
    document.getElementById('doctor-meta-mrc').textContent = data.mrc || mrn;

    // Render Symptom Selection
    renderSymptomMainCol();
    renderSymptomChips();

  } catch (e) {
    console.error('selectDoctorDraft error', e);
    showToast('❌ 載入草稿失敗', 'fail');
  }
}

function resetDoctorFormPanel() {
  delete state.selectedDoctorDraft;
  state.selectedSymptoms = [];
  state.activeCategory = null;

  const titleEl = document.getElementById('doctor-fp-title');
  const subEl = document.getElementById('doctor-fp-sub');
  const btnsEl = document.getElementById('doctor-fp-btns');

  if (titleEl) titleEl.textContent = '請選擇未完成出院單';
  if (subEl) subEl.textContent = '點擊未完成出院單來填寫';
  if (btnsEl) btnsEl.style.display = 'none';

  const placeholderEl = document.getElementById('doctor-fp-placeholder');
  const contentEl = document.getElementById('doctor-fp-content');
  if (placeholderEl) placeholderEl.style.display = 'flex';
  if (contentEl) contentEl.style.display = 'none';

  document.querySelectorAll('#doctor-draft-list .patient-item').forEach(el => {
    el.classList.remove('active');
  });
}

function renderSymptomMainCol() {
  const mainList = document.getElementById('symptom-main-list');
  const subCol = document.getElementById('symptom-sub-col');
  if (!mainList) return;

  mainList.innerHTML = '';
  if (subCol) subCol.style.display = 'none';

  const categories = state.dischargeCategories || {};
  Object.keys(categories).forEach(key => {
    const subItems = categories[key];
    const isEmpty = !Array.isArray(subItems) || subItems.length === 0;

    const item = document.createElement('div');
    item.className = 'symptom-item' + (isEmpty ? ' disabled' : '');
    if (state.activeCategory === key) item.classList.add('active');
    item.textContent = key;

    if (!isEmpty) {
      item.onclick = (e) => {
        if (state.activeCategory === key) {
          item.classList.remove('active');
          state.activeCategory = null;
          const subCol = document.getElementById('symptom-sub-col');
          if (subCol) subCol.style.display = 'none';
        } else {
          document.querySelectorAll('#symptom-main-list .symptom-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          state.activeCategory = key;
          renderSymptomSubCol(key);
        }
      };
    }
    mainList.appendChild(item);
  });
}

function renderSymptomSubCol(categoryKey) {
  const subCol = document.getElementById('symptom-sub-col');
  const subHeader = document.getElementById('symptom-sub-header');
  const subList = document.getElementById('symptom-sub-list');
  if (!subCol || !subList) return;

  subCol.style.display = 'flex';
  if (subHeader) subHeader.textContent = categoryKey;
  subList.innerHTML = '';

  const items = state.dischargeCategories[categoryKey] || [];
  if (!Array.isArray(items) || items.length === 0) {
    subList.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px;text-align:center;">（此類別無衛教項目）</div>';
    return;
  }

  items.forEach(symptomName => {
    const item = document.createElement('div');
    item.className = 'symptom-item';
    const isSelected = state.selectedSymptoms && state.selectedSymptoms.includes(symptomName);

    if (isSelected) {
      item.classList.add('active');
      item.innerHTML = `<span style="font-weight:700;">✓</span> <span>${esc(symptomName)}</span>`;
    } else {
      item.textContent = symptomName;
    }

    item.onclick = () => {
      if (!state.selectedSymptoms) state.selectedSymptoms = [];
      if (!state.selectedSymptoms.includes(symptomName)) {
        state.selectedSymptoms.push(symptomName);
      } else {
        state.selectedSymptoms = state.selectedSymptoms.filter(s => s !== symptomName);
      }
      renderSymptomSubCol(categoryKey);
      renderSymptomChips();
    };
    subList.appendChild(item);
  });
}

function renderSymptomChips() {
  const selCol = document.getElementById('symptom-selected-col');
  const chipsContainer = document.getElementById('symptom-chips-container');
  if (!selCol || !chipsContainer) return;

  const symptoms = state.selectedSymptoms || [];
  if (symptoms.length === 0) {
    selCol.style.display = 'none';
    chipsContainer.innerHTML = '';
    return;
  }

  selCol.style.display = 'flex';
  chipsContainer.innerHTML = '';

  symptoms.forEach(symptomName => {
    const chip = document.createElement('div');
    chip.className = 'symptom-chip';
    chip.innerHTML = `<span>❌</span> <span>${esc(symptomName)}</span>`;
    chip.onclick = () => {
      state.selectedSymptoms = state.selectedSymptoms.filter(s => s !== symptomName);
      if (state.activeCategory) {
        renderSymptomSubCol(state.activeCategory);
      }
      renderSymptomChips();
    };
    chipsContainer.appendChild(chip);
  });
}

function deleteDoctorDraft() {
  if (!state.selectedDoctorDraft) return;
  openModal('modal-confirm-delete-draft');
}

async function doDeleteDoctorDraft() {
  closeModal('modal-confirm-delete-draft');
  if (!state.selectedDoctorDraft) return;
  const filename = state.selectedDoctorDraft.filename;

  try {
    const res = await api('DELETE', `/api/forms/doctor_draft/${encodeURIComponent(filename)}`);
    if (res.success) {
      showToast('✅ 出院單草稿已刪除', 'ok');
      resetDoctorFormPanel();
      loadDoctorDrafts();
    } else {
      showToast('❌ 刪除失敗：' + (res.error || '未知錯誤'), 'fail');
    }
  } catch (e) {
    console.error('doDeleteDoctorDraft error', e);
    showToast('❌ 刪除失敗，請稍後再試', 'fail');
  }
}

function saveDoctorForm() {
  if (!state.selectedDoctorDraft) return;

  // Render non-interactable chips inside modal
  const container = document.getElementById('modal-save-chips-container');
  if (container) {
    const symptoms = state.selectedSymptoms || [];
    if (symptoms.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);font-size:13px;">（未選擇任何衛教項目）</div>';
    } else {
      container.innerHTML = symptoms.map(s => `
        <div class="symptom-chip readonly">
          <span>📌</span> <span>${esc(s)}</span>
        </div>
      `).join('');
    }
  }

  openModal('modal-confirm-save-draft');
}

async function doSaveDoctorForm() {
  closeModal('modal-confirm-save-draft');
  if (!state.selectedDoctorDraft) return;
  const draft = state.selectedDoctorDraft;
  const saveBtn = document.getElementById('btn-doctor-save');
  if (saveBtn) saveBtn.disabled = true;

  try {
    const res = await api('POST', '/api/forms/doctor_submit', {
      filename: draft.filename,
      line_patient_pair_id: draft.data.line_patient_pair_id,
      checkout_date: draft.data.checkout_date,
      symptoms: state.selectedSymptoms || []
    });

    if (res.success) {
      showToast('✅ 出院單已完成傳送', 'ok');
      resetDoctorFormPanel();
      loadDoctorDrafts();
      loadFormsPatientList();
    } else {
      showToast('❌ 傳送失敗：' + (res.error || '未知錯誤'), 'fail');
      if (saveBtn) saveBtn.disabled = false;
    }
  } catch (e) {
    console.error('doSaveDoctorForm error', e);
    showToast('❌ 傳送失敗，請稍後再試', 'fail');
    if (saveBtn) saveBtn.disabled = false;
  }
}



// ── nurse form ──
async function loadNurseLineAccounts() {
  const btnText = document.getElementById('nurse-line-btn-text');
  const searchInput = document.getElementById('nurse-line-search');
  if (btnText) btnText.textContent = '請選擇 LINE 帳號';
  if (searchInput) searchInput.value = '';

  const panel = document.getElementById('nurse-form-panel');
  if (panel) delete panel.dataset.lineAccountId;

  resetNursePatientDropdown();

  try {
    const res = await api('GET', '/api/forms/get_line_accounts');
    state.nurseLineAccounts = (res && Array.isArray(res.accounts)) ? res.accounts : (Array.isArray(res) ? res : []);
    state.nurseRecentLineIds = (res && Array.isArray(res.recent_ids)) ? res.recent_ids : [];
    filterNurseLineAccounts('');
  } catch (e) {
    console.error('loadNurseLineAccounts error', e);
    const container = document.getElementById('nurse-line-items-container');
    if (container) container.innerHTML = '<div style="padding:14px;color:var(--danger);font-size:13px;text-align:center;">載入失敗</div>';
  }
}

function toggleNurseLineDropdown() {
  const dd = document.getElementById('nurse-line-dd');
  const pDd = document.getElementById('nurse-patient-dd');
  if (pDd) pDd.classList.remove('open');
  if (dd) {
    const isOpen = dd.classList.toggle('open');
    if (isOpen) {
      const searchInput = document.getElementById('nurse-line-search');
      if (searchInput) searchInput.focus();
    }
  }
}

function filterNurseLineAccounts(query) {
  query = (query || '').trim().toLowerCase();
  const all = state.nurseLineAccounts || [];
  const container = document.getElementById('nurse-line-items-container');
  const subEl = document.getElementById('nurse-line-search-sub');
  if (!container) return;

  container.innerHTML = '';

  if (query) {
    const filtered = all.filter(a => (a.name || '').toLowerCase().includes(query));
    if (subEl) {
      subEl.style.display = 'block';
      subEl.textContent = `${filtered.length} 項結果`;
    }
    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:13px;text-align:center;">找不到相似帳號名稱</div>';
      return;
    }
    filtered.forEach(a => container.appendChild(buildNurseLineItem(a)));
  } else {
    if (subEl) subEl.style.display = 'none';

    // Show recent group if exists
    const recentIds = state.nurseRecentLineIds || [];
    const recentAccounts = recentIds.map(id => all.find(a => a.id === id)).filter(Boolean);

    if (recentAccounts.length > 0) {
      const rHeader = document.createElement('div');
      rHeader.className = 'nurse-dd-header';
      rHeader.textContent = '最近選擇';
      container.appendChild(rHeader);

      recentAccounts.forEach(a => container.appendChild(buildNurseLineItem(a)));

      const aHeader = document.createElement('div');
      aHeader.className = 'nurse-dd-header';
      aHeader.textContent = '所有帳號';
      container.appendChild(aHeader);
    }

    all.forEach(a => container.appendChild(buildNurseLineItem(a)));
  }
}

function buildNurseLineItem(account) {
  const item = document.createElement('div');
  item.className = 'nurse-patient-item';
  item.dataset.accountId = account.id;
  item.textContent = account.name;

  item.onclick = () => selectNurseLineAccount(account.id, account.name);
  return item;
}

function selectNurseLineAccount(id, name) {
  const dd = document.getElementById('nurse-line-dd');
  const btnText = document.getElementById('nurse-line-btn-text');
  const panel = document.getElementById('nurse-form-panel');

  if (dd) dd.classList.remove('open');
  if (btnText) btnText.textContent = name;
  if (panel) panel.dataset.lineAccountId = id;

  // Highlight selected item
  document.querySelectorAll('#nurse-line-items-container .nurse-patient-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.accountId === String(id));
  });

  onNurseLineChange(id);
}

function resetNursePatientDropdown() {
  const btn = document.getElementById('nurse-patient-btn');
  const btnText = document.getElementById('nurse-patient-btn-text');
  const list = document.getElementById('nurse-patient-list');
  const dd = document.getElementById('nurse-patient-dd');
  const pGroup = document.getElementById('nurse-fp-patient-group');

  if (pGroup) pGroup.style.display = 'none';
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = '';
  if (list) list.innerHTML = '';
  if (dd) dd.classList.remove('open');

  // Clear dataset on panel
  const panel = document.getElementById('nurse-form-panel');
  if (panel) {
    delete panel.dataset.selPairId;
    delete panel.dataset.selRelation;
    delete panel.dataset.selMrn;
  }

  // Clear and hide all draft fields
  const draftContainer = document.getElementById('nurse-draft-fields');
  if (draftContainer) draftContainer.style.display = 'none';

  ['nurse-draft-self-mrn-row', 'nurse-draft-new-relation-row', 'nurse-draft-new-mrn-row'].forEach(id => {
    const row = document.getElementById(id);
    if (row) row.style.display = 'none';
  });

  ['nurse-draft-self-mrn', 'nurse-draft-new-relation', 'nurse-draft-new-mrn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.classList.remove('invalid'); }
  });

  validateNurseForm();
}

async function onNurseLineChange(lineAccountId) {
  resetNursePatientDropdown();

  const pGroup = document.getElementById('nurse-fp-patient-group');
  if (pGroup) pGroup.style.display = 'flex';

  const btn = document.getElementById('nurse-patient-btn');
  const list = document.getElementById('nurse-patient-list');
  if (!list) return;

  list.innerHTML = '<div style="padding:12px 14px;color:var(--muted);font-size:13px;">載入中…</div>';
  if (btn) { btn.disabled = false; btn.classList.remove('disabled'); }

  try {
    const relations = await api('GET', `/api/forms/get_existing_relations?line_account_id=${lineAccountId}`);
    list.innerHTML = '';
    let firstItem = null;

    // Always put "帳號本人" first if not already in the list
    const hasSelf = Array.isArray(relations) && relations.some(r => r.relation === '帳號本人');
    if (!hasSelf) {
      firstItem = { pair_id: 'self', relation: '帳號本人', mrn: '???' };
      list.appendChild(buildPatientItem(firstItem));
    }

    if (Array.isArray(relations) && relations.length > 0) {
      // Sort: "帳號本人" first, then alphabetically by relation
      const sorted = [...relations].sort((a, b) => {
        if (a.relation === '帳號本人') return -1;
        if (b.relation === '帳號本人') return 1;
        return a.relation.localeCompare(b.relation);
      });
      if (!firstItem) firstItem = sorted[0];
      sorted.forEach(r => list.appendChild(buildPatientItem(r)));
    }

    // Always add "新增" at the bottom
    const newItem = document.createElement('div');
    newItem.className = 'nurse-patient-item new-item';
    newItem.textContent = '＋ 新增';
    newItem.onclick = () => onNursePatientChange('new');
    list.appendChild(newItem);

    // Default to first item automatically (no placeholder)
    if (firstItem) {
      onNursePatientChange(firstItem.pair_id, firstItem.relation, firstItem.mrn);
    } else {
      onNursePatientChange('new');
    }

  } catch (e) {
    console.error('onNurseLineChange error', e);
    list.innerHTML = '<div style="padding:12px 14px;color:var(--danger);font-size:13px;">載入失敗</div>';
  }
}

function buildPatientItem(r) {
  const item = document.createElement('div');
  item.className = 'nurse-patient-item';
  item.dataset.pairId = r.pair_id;
  item.dataset.relation = r.relation;
  item.dataset.mrn = r.mrn || '';

  const rel = document.createElement('span');
  rel.className = 'npi-relation';
  rel.textContent = r.relation;

  const spacer = document.createElement('span');
  spacer.className = 'npi-spacer';

  const mrn = document.createElement('span');
  mrn.className = 'npi-mrn';
  mrn.textContent = r.mrn || '???';

  item.appendChild(rel);
  item.appendChild(spacer);
  item.appendChild(mrn);

  item.onclick = () => onNursePatientChange(r.pair_id, r.relation, r.mrn);
  return item;
}

function toggleNursePatientDropdown() {
  const dd = document.getElementById('nurse-patient-dd');
  if (dd) dd.classList.toggle('open');
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(e) {
  const lineDd = document.getElementById('nurse-line-dd');
  if (lineDd && !lineDd.contains(e.target)) {
    lineDd.classList.remove('open');
  }
  const patientDd = document.getElementById('nurse-patient-dd');
  if (patientDd && !patientDd.contains(e.target)) {
    patientDd.classList.remove('open');
  }
});

function onNursePatientChange(pairId, relation, mrn) {
  const dd = document.getElementById('nurse-patient-dd');
  const btnText = document.getElementById('nurse-patient-btn-text');
  if (dd) dd.classList.remove('open');

  // Track current selection state on the panel element for access later
  const panel = document.getElementById('nurse-form-panel');
  if (panel) {
    panel.dataset.selPairId = pairId;
    panel.dataset.selRelation = relation || '';
    panel.dataset.selMrn = mrn || '';
  }

  // Update button label: centered for "新增", else space grow between relation and mrn
  if (btnText) {
    if (pairId === 'new') {
      btnText.innerHTML = '<span style="color:var(--primary);font-weight:700;width:100%;text-align:center;">＋ 新增</span>';
    } else {
      btnText.innerHTML =
        `<span class="npi-relation">${relation}</span>` +
        `<span class="npi-spacer"></span>` +
        `<span class="npi-mrn">${mrn || '???'}</span>`;
    }
  }

  // Highlight selected item
  document.querySelectorAll('#nurse-patient-list .nurse-patient-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.pairId === String(pairId));
  });

  // Show/hide draft fields
  const draftContainer = document.getElementById('nurse-draft-fields');
  const selfMrnRow     = document.getElementById('nurse-draft-self-mrn-row');
  const newRelRow      = document.getElementById('nurse-draft-new-relation-row');
  const newMrnRow      = document.getElementById('nurse-draft-new-mrn-row');

  selfMrnRow.style.display = 'none';
  newRelRow.style.display  = 'none';
  newMrnRow.style.display  = 'none';

  if (pairId === 'self') {
    // 帳號本人 without MRC → need MRC
    draftContainer.style.display = 'flex';
    selfMrnRow.style.display = 'flex';
  } else if (pairId === 'new') {
    // New patient → need relation + MRC
    draftContainer.style.display = 'flex';
    newRelRow.style.display = 'flex';
    newMrnRow.style.display = 'flex';
  } else {
    // Existing DB pair → no extra inputs needed
    draftContainer.style.display = 'none';
  }

  validateNurseForm();
}

// Collect all existing MRNs and relations from the patient list for duplicate check
function getNurseExistingValues() {
  const mrns = new Set();
  const relations = new Set();
  document.querySelectorAll('#nurse-patient-list .nurse-patient-item').forEach(el => {
    if (el.dataset.mrn)      mrns.add(el.dataset.mrn.trim().toLowerCase());
    if (el.dataset.relation) relations.add(el.dataset.relation.trim().toLowerCase());
  });
  return { mrns, relations };
}

function validateNurseForm() {
  const panel  = document.getElementById('nurse-form-panel');
  const saveBtn = document.getElementById('btn-nurse-save');
  const sub    = document.getElementById('nurse-fp-sub');
  if (!panel || !saveBtn) return;

  const pairId   = panel.dataset.selPairId;
  const lineVal  = panel.dataset.lineAccountId;

  // Must have LINE selected and a patient selected
  if (!lineVal || !pairId) {
    saveBtn.disabled = true;
    if (sub) sub.textContent = '請選擇 LINE 帳號與病患';
    return;
  }

  const { mrns, relations } = getNurseExistingValues();
  let valid = true;
  let hint  = '';

  if (pairId === 'self') {
    const mrnEl = document.getElementById('nurse-draft-self-mrn');
    const val = mrnEl?.value.trim() ?? '';
    if (!val) {
      valid = false; hint = '請填寫帳號本人的病歷號';
      mrnEl?.classList.add('invalid');
    } else if (mrns.has(val.toLowerCase())) {
      valid = false; hint = '病歷號已存在於此 LINE 帳號';
      mrnEl?.classList.add('invalid');
    } else {
      mrnEl?.classList.remove('invalid');
    }

  } else if (pairId === 'new') {
    const relEl  = document.getElementById('nurse-draft-new-relation');
    const mrnEl  = document.getElementById('nurse-draft-new-mrn');
    const relVal = relEl?.value.trim() ?? '';
    const mrnVal = mrnEl?.value.trim() ?? '';

    if (!relVal) {
      valid = false; hint = '請填寫關係';
      relEl?.classList.add('invalid');
    } else if (relations.has(relVal.toLowerCase())) {
      valid = false; hint = '關係已存在於此 LINE 帳號';
      relEl?.classList.add('invalid');
    } else {
      relEl?.classList.remove('invalid');
    }

    if (!mrnVal) {
      valid = false; if (!hint) hint = '請填寫病歷號';
      mrnEl?.classList.add('invalid');
    } else if (mrns.has(mrnVal.toLowerCase())) {
      valid = false; if (!hint) hint = '病歷號已存在於此 LINE 帳號';
      mrnEl?.classList.add('invalid');
    } else {
      mrnEl?.classList.remove('invalid');
    }
  }

  saveBtn.disabled = !valid;
  if (sub) sub.textContent = valid ? '確認資料無誤就可建立' : (hint || '請填寫必要資訊');
}

async function saveNurseForm() {
  const panel     = document.getElementById('nurse-form-panel');
  const saveBtn   = document.getElementById('btn-nurse-save');
  if (!panel || saveBtn.disabled) return;

  const lineAccountId = panel.dataset.lineAccountId;
  const pairId        = panel.dataset.selPairId;
  let relation        = panel.dataset.selRelation;
  let mrn             = panel.dataset.selMrn;

  // Collect draft values for special cases
  if (pairId === 'self') {
    mrn = document.getElementById('nurse-draft-self-mrn')?.value.trim();
    relation = '帳號本人';
  } else if (pairId === 'new') {
    relation = document.getElementById('nurse-draft-new-relation')?.value.trim();
    mrn      = document.getElementById('nurse-draft-new-mrn')?.value.trim();
  }

  saveBtn.disabled = true;
  saveBtn.textContent = '建立中…';

  try {
    const result = await api('POST', '/api/forms/nurse_create', {
      line_account_id: parseInt(lineAccountId),
      pair_id:         pairId,  // 'self', 'new', or DB integer pair id
      relation:        relation,
      mrn:             mrn,
    });

    if (result.success) {
      showToast('✅ 出院單已建立', 'ok');
      saveBtn.textContent = '💾 建立';
      loadNurseLineAccounts();
      loadDoctorDrafts();
    } else {
      showToast('❌ ' + (result.error || '建立失敗'), 'fail');
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 建立';
    }
  } catch (e) {
    console.error('saveNurseForm error', e);
    showToast('❌ 建立失敗，請稍後再試', 'fail');
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 建立';
  }
}


// ── forms section ──
async function loadFormsPatientList() {
  loading(true);
  loadDoctorDrafts();
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
          <span>出院單 ${p.form_count} 筆</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">就診日期：${esc(p.latest_checkout || '—')}</div>
      </div>`;
  }).join('');
}

async function loadFormDetail(mrn, el, targetDate = null) {
  state.formCurrentMrn = mrn;
  document.querySelectorAll('#form-patient-list-body .patient-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  
  state.currentSelectedRecord = null;
  if (state.viewEditMode) exitViewEditMode(false);
  const editBtn = document.getElementById('btn-view-edit');
  const cancelBtn = document.getElementById('btn-view-cancel');
  const confirmBtn = document.getElementById('btn-view-confirm');
  if (editBtn) editBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (confirmBtn) confirmBtn.style.display = 'none';

  const viewContainer = document.getElementById('form-view-container');
  if (viewContainer) viewContainer.style.display = 'none';

  const visitBody = document.getElementById('form-visit-list-body');
  visitBody.innerHTML = '<div class="empty-state"><div class="spinner-dark"></div><p>載入中…</p></div>';
  
  document.getElementById('form-edit-title').textContent = '查看或修改表單';
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
    const dateLabel = f.checkout_date ? f.checkout_date.substring(0, 10) : f.checkout_date;
    return `
      <div class="visit-item" id="form-visit-item-${index}" onclick="selectFormVisit(${origIdx}, this)">
        <div class="visit-title">${esc(dateLabel)}</div>
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
    if (icon) {
      icon.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;
    }
    if (btn) btn.style.backgroundColor = '#fbbf24'; // Orange/Yellow when editing
  } else {
    // Validate inputs
    let relationVal = displayRelation ? displayRelation.textContent.trim() : '帳號本人';
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

  state.currentSelectedRecord = { f, mrn };
  if (state.viewEditMode) exitViewEditMode(false);

  const dateFormatted = f.checkout_date ? f.checkout_date.substring(0, 10) : f.checkout_date;
  document.getElementById('form-edit-title').textContent = `查看或修改表單`;
  document.getElementById('form-edit-sub').textContent   = dateFormatted;

  document.getElementById('edit-form-mrn').value       = mrn;
  document.getElementById('edit-form-orig-date').value = f.checkout_date;

  isEditingCard = false;
  document.getElementById('form-edit-error').textContent = '';

  // Populate meta-box values
  const patientObj = state.allFormPatients.find(p => p.medical_record_num === mrn);
  const relationText = patientObj ? (patientObj.relation || '帳號本人') : '帳號本人';

  const displayRelation = document.getElementById('display-form-relation');
  const displayMrn = document.getElementById('display-form-mrn');
  const displayDate = document.getElementById('display-form-date');
  const displayFormReturnBadge = document.getElementById('display-form-return-badge');

  if (displayRelation) displayRelation.textContent = relationText;
  if (displayMrn) displayMrn.textContent = mrn;
  if (displayDate) displayDate.textContent = dateFormatted;

  if (displayFormReturnBadge) {
    displayFormReturnBadge.style.display = (patientObj && patientObj.needs_return_visit) ? '' : 'none';
  }

  // Populate symptoms chips (read-only)
  const symptomsEl = document.getElementById('view-form-symptoms');
  if (symptomsEl) {
    const symptoms = f.symptoms || [];
    if (symptoms.length === 0) {
      symptomsEl.innerHTML = '<span style="font-size:12px; color:var(--muted);">—</span>';
    } else {
      symptomsEl.innerHTML = symptoms.map(s =>
        `<div class="symptom-chip readonly"><span>📌</span> <span>${esc(s)}</span></div>`
      ).join('');
    }
  }

  // Show view container, hide empty & edit container
  document.getElementById('form-edit-empty').style.display = 'none';
  const viewContainer = document.getElementById('form-view-container');
  if (viewContainer) viewContainer.style.display = 'flex';
  const editContainer = document.getElementById('form-edit-container');
  if (editContainer) editContainer.style.display = 'none';

  // Toggle header buttons
  const editBtn = document.getElementById('btn-view-edit');
  const cancelBtn = document.getElementById('btn-view-cancel');
  const confirmBtn = document.getElementById('btn-view-confirm');
  const canEdit = state.isAdmin || (f.doctor_account && f.doctor_account === state.account);
  if (editBtn) editBtn.style.display = canEdit ? 'inline-flex' : 'none';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (confirmBtn) confirmBtn.style.display = 'none';

  // Populate Doctor display
  if (!state.doctors.length) {
    const list = await api('GET', '/api/doctors');
    state.doctors = Array.isArray(list) ? list : [];
  }
  const displayDoctor = document.getElementById('display-form-doctor');
  const currentDr = state.doctors.find(dr => dr.account_name === f.doctor_account);
  if (displayDoctor) {
    displayDoctor.textContent = currentDr ? currentDr.doctor_name : (f.doctor_account || '—');
  }
}

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
    showToast('✅ 出院單已儲存', 'ok');
    
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
// ── 修改出院單儲存按鈕狀態檢查 ──
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
  const origRelation = patientObj ? (patientObj.relation || '帳號本人') : '帳號本人';
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
const editRelInput = document.getElementById('edit-form-relation-input');
if (editRelInput) editRelInput.addEventListener('input', checkFormModified);

const editMrnInputEl = document.getElementById('edit-form-mrn-input');
if (editMrnInputEl) {
  editMrnInputEl.addEventListener('input', function() {
    const enteredMrn = this.value.trim();
    const origMrnEl = document.getElementById('edit-form-mrn');
    const originalMrn = origMrnEl ? origMrnEl.value : '';
    const warningEl = document.getElementById('edit-form-mrn-warning');
    const btnEditCard = document.getElementById('btn-edit-card');
    
    if (enteredMrn !== originalMrn && state.allFormPatients && state.allFormPatients.some(p => p.medical_record_num === enteredMrn)) {
      if (warningEl) warningEl.style.display = 'block';
      if (btnEditCard) {
        btnEditCard.disabled = true;
        btnEditCard.style.opacity = '0.5';
        btnEditCard.style.cursor = 'not-allowed';
      }
    } else {
      if (warningEl) warningEl.style.display = 'none';
      if (btnEditCard) {
        btnEditCard.disabled = false;
        btnEditCard.style.opacity = '1';
        btnEditCard.style.cursor = 'pointer';
      }
    }
    checkFormModified();
  });
}



// ── View Form Edit Mode ──
state.veLineAccounts = [];
state.veRecentLineIds = [];
state.veSelectedLine = null;     // { id, name }
state.veSelectedPair = null;     // { pair_id, relation, mrn }
state.veSelectedSymptoms = [];
state.veActiveCategory = null;
state.viewEditMode = false;

async function enterViewEditMode() {
  if (!state.currentSelectedRecord) return;
  state.viewEditMode = true;

  // Toggle Header Buttons
  const editBtn = document.getElementById('btn-view-edit');
  const cancelBtn = document.getElementById('btn-view-cancel');
  const confirmBtn = document.getElementById('btn-view-confirm');
  if (editBtn) editBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  if (confirmBtn) confirmBtn.style.display = 'inline-flex';

  // Toggle View vs Edit containers
  const viewContainer = document.getElementById('form-view-container');
  if (viewContainer) viewContainer.style.display = 'none';
  const editContainer = document.getElementById('form-edit-container');
  if (editContainer) editContainer.style.display = 'flex';

  // Copy initial symptoms from current record
  const { f, mrn } = state.currentSelectedRecord;
  state.veSelectedSymptoms = f.symptoms ? [...f.symptoms] : [];

  // Show/hide admin-only fields
  const adminFields = document.getElementById('ve-admin-fields');
  const nonAdminInfo = document.getElementById('ve-nonadmin-info');

  if (state.isAdmin) {
    // ── Admin path: show LINE + patient pickers ──
    if (adminFields) adminFields.style.display = 'contents';
    if (nonAdminInfo) nonAdminInfo.style.display = 'none';

    // Reset dropdown selections
    state.veSelectedLine = null;
    state.veSelectedPair = null;
    const lineBtnText = document.getElementById('ve-line-btn-text');
    if (lineBtnText) lineBtnText.textContent = '請選擇 LINE 帳號';
    const pGroup = document.getElementById('ve-patient-group');
    if (pGroup) pGroup.style.display = 'none';
    const draftFields = document.getElementById('ve-draft-fields');
    if (draftFields) draftFields.style.display = 'none';

    // Load Categories & Render Symptoms
    await loadDischargeCategories();
    renderVEMainCol();
    renderVESymptomChips();

    // Load LINE Accounts and try to pre-select
    await loadVELineAccounts();
    if (f.line_account_id) {
      const actName = f.line_name || '已選擇帳號';
      await selectVELineAccount(f.line_account_id, actName);
      if (f.relation) {
        const pDdText = document.getElementById('ve-patient-btn-text');
        if (pDdText) pDdText.textContent = f.relation;
        // Find pair_id from relation
        const relations = await api('GET', `/api/forms/get_existing_relations?line_account_id=${f.line_account_id}`);
        if (Array.isArray(relations)) {
          const found = relations.find(r => r.relation === f.relation);
          if (found) {
            state.veSelectedPair = { pair_id: found.pair_id, relation: found.relation, mrn: found.mrn };
          } else if (f.relation === '帳號本人') {
            state.veSelectedPair = { pair_id: 'self', relation: '帳號本人', mrn: state.currentSelectedRecord.mrn };
          }
        }
      }
    }
  } else {
    // ── Non-admin path: symptoms only ──
    if (adminFields) adminFields.style.display = 'none';
    if (nonAdminInfo) {
      nonAdminInfo.style.display = 'flex';
      const dr = state.doctors.find(d => d.account_name === f.doctor_account);
      document.getElementById('ve-nonadmin-date').textContent = f.checkout_date ? f.checkout_date.replace('T', ' ').substring(0, 19) : '無紀錄';
      document.getElementById('ve-nonadmin-doctor').textContent = dr ? dr.doctor_name : (f.doctor_account || '—');
      document.getElementById('ve-nonadmin-relation').textContent = f.relation || '—';
      document.getElementById('ve-nonadmin-mrn').textContent = mrn || '—';
    }

    // Load Categories & Render Symptoms (pre-filled)
    await loadDischargeCategories();
    renderVEMainCol();
    renderVESymptomChips();
  }

  validateViewEdit();
}

function exitViewEditMode(cancelled = false) {
  state.viewEditMode = false;

  // Toggle Header Buttons
  const editBtn = document.getElementById('btn-view-edit');
  const cancelBtn = document.getElementById('btn-view-cancel');
  const confirmBtn = document.getElementById('btn-view-confirm');
  const f = state.currentSelectedRecord ? state.currentSelectedRecord.f : {};
  const canEdit = state.isAdmin || (f.doctor_account && f.doctor_account === state.account);
  if (editBtn) editBtn.style.display = canEdit ? 'inline-flex' : 'none';
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (confirmBtn) confirmBtn.style.display = 'none';

  // Toggle View vs Edit containers
  const editContainer = document.getElementById('form-edit-container');
  if (editContainer) editContainer.style.display = 'none';
  const viewContainer = document.getElementById('form-view-container');
  if (viewContainer) viewContainer.style.display = 'flex';

  if (cancelled) {
    showToast('已取消修改', '');
  }
}

// ── VE Line Accounts Dropdown ──
async function loadVELineAccounts() {
  try {
    const res = await api('GET', '/api/forms/get_line_accounts');
    state.veLineAccounts = (res && Array.isArray(res.accounts)) ? res.accounts : [];
    state.veRecentLineIds = (res && Array.isArray(res.recent_ids)) ? res.recent_ids : [];
    filterVELineAccounts('');
  } catch (e) {
    console.error('loadVELineAccounts error', e);
  }
}

function toggleVELineDropdown() {
  const dd = document.getElementById('ve-line-dd');
  const pDd = document.getElementById('ve-patient-dd');
  if (pDd) pDd.classList.remove('open');
  if (dd) {
    const isOpen = dd.classList.toggle('open');
    if (isOpen) {
      const searchInput = document.getElementById('ve-line-search');
      if (searchInput) searchInput.focus();
    }
  }
}

function filterVELineAccounts(query) {
  query = (query || '').trim().toLowerCase();
  const all = state.veLineAccounts || [];
  const container = document.getElementById('ve-line-items-container');
  const subEl = document.getElementById('ve-line-search-sub');
  if (!container) return;
  container.innerHTML = '';

  if (query) {
    const filtered = all.filter(a => (a.name || '').toLowerCase().includes(query));
    if (subEl) {
      subEl.style.display = 'block';
      subEl.textContent = `${filtered.length} 項結果`;
    }
    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:13px;text-align:center;">找不到相似帳號名稱</div>';
      return;
    }
    filtered.forEach(a => container.appendChild(buildVELineItem(a)));
  } else {
    if (subEl) subEl.style.display = 'none';
    const recentIds = state.veRecentLineIds || [];
    const recentAccounts = recentIds.map(id => all.find(a => a.id === id)).filter(Boolean);

    if (recentAccounts.length > 0) {
      const rHeader = document.createElement('div');
      rHeader.className = 'nurse-dd-header';
      rHeader.textContent = '最近選擇';
      container.appendChild(rHeader);
      recentAccounts.forEach(a => container.appendChild(buildVELineItem(a)));

      const aHeader = document.createElement('div');
      aHeader.className = 'nurse-dd-header';
      aHeader.textContent = '所有帳號';
      container.appendChild(aHeader);
    }
    all.forEach(a => container.appendChild(buildVELineItem(a)));
  }
}

function buildVELineItem(account) {
  const item = document.createElement('div');
  item.className = 'nurse-patient-item';
  item.dataset.accountId = account.id;
  item.textContent = account.name;
  item.onclick = () => selectVELineAccount(account.id, account.name);
  return item;
}

function selectVELineAccount(id, name) {
  const dd = document.getElementById('ve-line-dd');
  if (dd) dd.classList.remove('open');
  const btnText = document.getElementById('ve-line-btn-text');
  if (btnText) btnText.textContent = name;
  state.veSelectedLine = { id, name };

  document.querySelectorAll('#ve-line-items-container .nurse-patient-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.accountId === String(id));
  });

  onVELineChange(id);
}

// ── VE Patient Dropdown ──
function resetVEPatientDropdown() {
  state.veSelectedPair = null;
  const pGroup = document.getElementById('ve-patient-group');
  if (pGroup) pGroup.style.display = 'none';
  const btnText = document.getElementById('ve-patient-btn-text');
  if (btnText) btnText.textContent = '';
  const list = document.getElementById('ve-patient-list');
  if (list) list.innerHTML = '';
  const draftFields = document.getElementById('ve-draft-fields');
  if (draftFields) draftFields.style.display = 'none';
  const selfRow = document.getElementById('ve-self-mrn-row');
  if (selfRow) selfRow.style.display = 'none';
  const newRow = document.getElementById('ve-new-fields-row');
  if (newRow) newRow.style.display = 'none';
  const selfMrn = document.getElementById('ve-self-mrn');
  if (selfMrn) selfMrn.value = '';
  const newRel = document.getElementById('ve-new-relation');
  if (newRel) newRel.value = '';
  const newMrn = document.getElementById('ve-new-mrn');
  if (newMrn) newMrn.value = '';
  validateViewEdit();
}

async function onVELineChange(lineAccountId) {
  resetVEPatientDropdown();
  const pGroup = document.getElementById('ve-patient-group');
  if (pGroup) pGroup.style.display = 'flex';

  const btn = document.getElementById('ve-patient-btn');
  const list = document.getElementById('ve-patient-list');
  if (!list) return;

  list.innerHTML = '<div style="padding:12px 14px;color:var(--muted);font-size:13px;">載入中…</div>';
  if (btn) btn.disabled = false;

  try {
    const relations = await api('GET', `/api/forms/get_existing_relations?line_account_id=${lineAccountId}`);
    list.innerHTML = '';
    let firstItem = null;

    const hasSelf = Array.isArray(relations) && relations.some(r => r.relation === '帳號本人');
    if (!hasSelf) {
      firstItem = { pair_id: 'self', relation: '帳號本人', mrn: '???' };
      list.appendChild(buildVEPatientItem(firstItem));
    }

    if (Array.isArray(relations) && relations.length > 0) {
      const sorted = [...relations].sort((a, b) => {
        if (a.relation === '帳號本人') return -1;
        if (b.relation === '帳號本人') return 1;
        return a.relation.localeCompare(b.relation);
      });
      if (!firstItem) firstItem = sorted[0];
      sorted.forEach(r => list.appendChild(buildVEPatientItem(r)));
    }

    const newItem = document.createElement('div');
    newItem.className = 'nurse-patient-item new-item';
    newItem.textContent = '＋ 新增';
    newItem.onclick = () => selectVEPatient('new');
    list.appendChild(newItem);

    if (firstItem) {
      selectVEPatient(firstItem.pair_id, firstItem.relation, firstItem.mrn);
    } else {
      selectVEPatient('new');
    }
  } catch (e) {
    console.error('onVELineChange error', e);
    list.innerHTML = '<div style="padding:12px 14px;color:var(--danger);font-size:13px;">載入失敗</div>';
  }
}

function buildVEPatientItem(r) {
  const item = document.createElement('div');
  item.className = 'nurse-patient-item';
  item.dataset.pairId = r.pair_id;
  item.dataset.relation = r.relation;
  item.dataset.mrn = r.mrn || '';

  item.innerHTML = `<span class="npi-relation">${esc(r.relation)}</span><span class="npi-spacer"></span><span class="npi-mrn">${esc(r.mrn || '???')}</span>`;
  item.onclick = () => selectVEPatient(r.pair_id, r.relation, r.mrn);
  return item;
}

function toggleVEPatientDropdown() {
  const dd = document.getElementById('ve-patient-dd');
  if (dd) dd.classList.toggle('open');
}

function selectVEPatient(pairId, relation, mrn) {
  const dd = document.getElementById('ve-patient-dd');
  if (dd) dd.classList.remove('open');
  state.veSelectedPair = { pair_id: pairId, relation: relation || '', mrn: mrn || '' };

  const btnText = document.getElementById('ve-patient-btn-text');
  if (btnText) {
    if (pairId === 'new') {
      btnText.innerHTML = '<span style="color:var(--primary);font-weight:700;width:100%;text-align:center;">＋ 新增</span>';
    } else {
      btnText.innerHTML = `<span class="npi-relation">${esc(relation)}</span><span class="npi-spacer"></span><span class="npi-mrn">${esc(mrn || '???')}</span>`;
    }
  }

  document.querySelectorAll('#ve-patient-list .nurse-patient-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.pairId === String(pairId));
  });

  const draftFields = document.getElementById('ve-draft-fields');
  const selfRow = document.getElementById('ve-self-mrn-row');
  const newRelRow = document.getElementById('ve-new-relation-row');
  const newMrnRow = document.getElementById('ve-new-mrn-row');

  if (selfRow) selfRow.style.display = 'none';
  if (newRelRow) newRelRow.style.display = 'none';
  if (newMrnRow) newMrnRow.style.display = 'none';

  if (pairId === 'self') {
    if (draftFields) draftFields.style.display = 'flex';
    if (selfRow) selfRow.style.display = 'flex';
  } else if (pairId === 'new') {
    if (draftFields) draftFields.style.display = 'flex';
    if (newRelRow) newRelRow.style.display = 'flex';
    if (newMrnRow) newMrnRow.style.display = 'flex';
  } else {
    if (draftFields) draftFields.style.display = 'none';
  }

  validateViewEdit();
}

// Global click listener for dropdown close
document.addEventListener('click', function(e) {
  const veLineDd = document.getElementById('ve-line-dd');
  if (veLineDd && !veLineDd.contains(e.target)) veLineDd.classList.remove('open');
  const vePatientDd = document.getElementById('ve-patient-dd');
  if (vePatientDd && !vePatientDd.contains(e.target)) vePatientDd.classList.remove('open');
});

// ── VE Symptoms Render Functions ──
function renderVEMainCol() {
  const mainList = document.getElementById('ve-symptom-main-list');
  const subCol = document.getElementById('ve-symptom-sub-col');
  if (!mainList) return;
  mainList.innerHTML = '';
  if (subCol) subCol.style.display = 'none';

  const categories = state.dischargeCategories || {};
  Object.keys(categories).forEach(key => {
    const subItems = categories[key];
    const isEmpty = !Array.isArray(subItems) || subItems.length === 0;

    const item = document.createElement('div');
    item.className = 'symptom-item' + (isEmpty ? ' disabled' : '');
    if (state.veActiveCategory === key) item.classList.add('active');
    item.textContent = key;

    if (!isEmpty) {
      item.onclick = () => {
        if (state.veActiveCategory === key) {
          item.classList.remove('active');
          state.veActiveCategory = null;
          const subCol = document.getElementById('ve-symptom-sub-col');
          if (subCol) subCol.style.display = 'none';
        } else {
          document.querySelectorAll('#ve-symptom-main-list .symptom-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          state.veActiveCategory = key;
          renderVESymptomSubCol(key);
        }
      };
    }
    mainList.appendChild(item);
  });
}

function renderVESymptomSubCol(categoryKey) {
  const subCol = document.getElementById('ve-symptom-sub-col');
  const subHeader = document.getElementById('ve-symptom-sub-header');
  const subList = document.getElementById('ve-symptom-sub-list');
  if (!subCol || !subList) return;

  subCol.style.display = 'flex';
  if (subHeader) subHeader.textContent = categoryKey;
  subList.innerHTML = '';

  const items = state.dischargeCategories[categoryKey] || [];
  items.forEach(symptomName => {
    const item = document.createElement('div');
    item.className = 'symptom-item';
    const isSelected = state.veSelectedSymptoms && state.veSelectedSymptoms.includes(symptomName);

    if (isSelected) {
      item.classList.add('active');
      item.innerHTML = `<span style="font-weight:700;">✓</span> <span>${esc(symptomName)}</span>`;
    } else {
      item.textContent = symptomName;
    }

    item.onclick = () => {
      if (!state.veSelectedSymptoms) state.veSelectedSymptoms = [];
      if (!state.veSelectedSymptoms.includes(symptomName)) {
        state.veSelectedSymptoms.push(symptomName);
      } else {
        state.veSelectedSymptoms = state.veSelectedSymptoms.filter(s => s !== symptomName);
      }
      renderVESymptomSubCol(categoryKey);
      renderVESymptomChips();
      validateViewEdit();
    };
    subList.appendChild(item);
  });
}

function renderVESymptomChips() {
  const selCol = document.getElementById('ve-symptom-selected-col');
  const container = document.getElementById('ve-symptom-chips-container');
  if (!selCol || !container) return;

  const symptoms = state.veSelectedSymptoms || [];
  if (symptoms.length === 0) {
    selCol.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  selCol.style.display = 'flex';
  container.innerHTML = '';

  symptoms.forEach(symptomName => {
    const chip = document.createElement('div');
    chip.className = 'symptom-chip';
    chip.innerHTML = `<span>❌</span> <span>${esc(symptomName)}</span>`;
    chip.onclick = () => {
      state.veSelectedSymptoms = state.veSelectedSymptoms.filter(s => s !== symptomName);
      if (state.veActiveCategory) renderVESymptomSubCol(state.veActiveCategory);
      renderVESymptomChips();
      validateViewEdit();
    };
    container.appendChild(chip);
  });
}

// ── Validation & Confirmation ──
function validateViewEdit() {
  const confirmBtn = document.getElementById('btn-view-confirm');
  if (!confirmBtn) return;

  if (!state.isAdmin) {
    // Non-admin: only require >= 1 symptom
    confirmBtn.disabled = !(state.veSelectedSymptoms && state.veSelectedSymptoms.length > 0);
    return;
  }

  // Admin: full validation
  if (!state.veSelectedLine || !state.veSelectedPair) {
    confirmBtn.disabled = true;
    return;
  }

  let valid = true;
  const pairId = state.veSelectedPair.pair_id;

  if (pairId === 'self') {
    const val = document.getElementById('ve-self-mrn')?.value.trim() ?? '';
    if (!val) valid = false;
  } else if (pairId === 'new') {
    const relVal = document.getElementById('ve-new-relation')?.value.trim() ?? '';
    const mrnVal = document.getElementById('ve-new-mrn')?.value.trim() ?? '';
    if (!relVal || !mrnVal) valid = false;
  }

  if (!state.veSelectedSymptoms || state.veSelectedSymptoms.length === 0) {
    valid = false;
  }

  confirmBtn.disabled = !valid;
}

function openConfirmEditModal() {
  if (!state.currentSelectedRecord) return;
  if (state.isAdmin && (!state.veSelectedLine || !state.veSelectedPair)) return;

  const diffEl = document.getElementById('ve-confirm-diff');
  if (!diffEl) return;

  const newSymptoms = state.veSelectedSymptoms || [];

  if (state.isAdmin) {
    const lineName = state.veSelectedLine.name;
    let newRel = state.veSelectedPair.relation;
    let newMrn = state.veSelectedPair.mrn;

    if (state.veSelectedPair.pair_id === 'self') {
      newRel = '帳號本人';
      newMrn = document.getElementById('ve-self-mrn').value.trim();
    } else if (state.veSelectedPair.pair_id === 'new') {
      newRel = document.getElementById('ve-new-relation').value.trim();
      newMrn = document.getElementById('ve-new-mrn').value.trim();
    }

    diffEl.innerHTML = `
      <div class="modal-alert-banner primary" style="display:flex; flex-direction:column; gap:6px; text-align:left;">
        <div><b>LINE 帳號：</b> ${esc(lineName)}</div>
        <div><b>關係 / 病歷號：</b> ${esc(newRel)} (${esc(newMrn)})</div>
        <div style="margin-top:4px;"><b>衛教項目 (${newSymptoms.length} 項)：</b></div>
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;">
          ${newSymptoms.map(s => `<span class="symptom-chip readonly">📌 ${esc(s)}</span>`).join('')}
        </div>
      </div>
    `;
  } else {
    // Non-admin: just show the symptom list
    diffEl.innerHTML = `
      <div class="modal-alert-banner primary" style="display:flex; flex-direction:column; gap:6px; text-align:left;">
        <div><b>衛教項目 (${newSymptoms.length} 項)：</b></div>
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;">
          ${newSymptoms.map(s => `<span class="symptom-chip readonly">📌 ${esc(s)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  openModal('modal-confirm-edit');
}

async function submitViewEdit() {
  closeModal('modal-confirm-edit');
  if (!state.currentSelectedRecord) return;

  const confirmBtn = document.getElementById('btn-view-confirm');
  if (confirmBtn) confirmBtn.disabled = true;

  const { f, mrn } = state.currentSelectedRecord;

  let payload;
  if (state.isAdmin) {
    const pairId = state.veSelectedPair.pair_id;
    let relation = state.veSelectedPair.relation;
    let newMrn = state.veSelectedPair.mrn;

    if (pairId === 'self') {
      relation = '帳號本人';
      newMrn = document.getElementById('ve-self-mrn').value.trim();
    } else if (pairId === 'new') {
      relation = document.getElementById('ve-new-relation').value.trim();
      newMrn = document.getElementById('ve-new-mrn').value.trim();
    }

    payload = {
      mrn,
      checkout_date: f.checkout_date,
      line_account_id: state.veSelectedLine.id,
      pair_id: pairId,
      relation,
      new_mrn: newMrn,
      symptoms: state.veSelectedSymptoms || []
    };
  } else {
    // Non-admin: only update symptoms
    payload = {
      mrn,
      checkout_date: f.checkout_date,
      symptoms: state.veSelectedSymptoms || []
    };
  }

  try {
    const res = await api('PUT', '/api/forms/view_edit', payload);

    if (res.success) {
      showToast('✅ 表單已成功修改', 'ok');
      exitViewEditMode();
      loadFormsPatientList();
      
      let targetMrn = mrn;
      if (state.isAdmin && state.veSelectedPair) {
        if (state.veSelectedPair.pair_id === 'self') targetMrn = document.getElementById('ve-self-mrn').value.trim();
        else if (state.veSelectedPair.pair_id === 'new') targetMrn = document.getElementById('ve-new-mrn').value.trim();
        else targetMrn = state.veSelectedPair.mrn;
      }
      if (!targetMrn) targetMrn = mrn;
      
      loadFormDetail(targetMrn, null, f.checkout_date);
    } else {
      showToast('❌ 修改失敗：' + (res.error || '未知錯誤'), 'fail');
      if (confirmBtn) confirmBtn.disabled = false;
    }
  } catch (e) {
    console.error('submitViewEdit error', e);
    showToast('❌ 修改失敗，請稍後再試', 'fail');
  }
}

