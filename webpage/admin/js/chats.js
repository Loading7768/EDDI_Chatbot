// ── chats list ──
async function loadChats() {
  loading(true);
  try {
    const list = await api('GET', '/api/chats');
    state.allPatients = Array.isArray(list) ? list : [];
    const sortCriteria = document.getElementById('patient-sort-select').value;
    sortAndRenderPatients(sortCriteria);
  } catch (err) {
    console.error(err);
    state.allPatients = [];
    renderPatientList([]);
  } finally  { loading(false); }
}

function sortAndRenderPatients(criteria) {
  if (!state.allPatients) return;
  const patients = [...state.allPatients];
  
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

  renderPatientList(patients);
}

function renderPatientList(patients) {
  document.getElementById('patient-count').textContent = patients.length;
  const body = document.getElementById('patient-list-body');
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
      <div class="patient-item${p.medical_record_num === state.currentMrn ? ' active' : ''}"
           data-mrn="${esc(p.medical_record_num)}"
           onclick="loadDetail('${esc(p.medical_record_num)}', this)">
        <div class="patient-mrn">
          ${esc(p.medical_record_num)}
          ${p.relation ? `<span class="badge badge-relation" style="margin-left: 6px; font-weight: 500;">${esc(p.relation)}</span>` : ''}
          ${p.status === '須看診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #f59e0b; color: white;">需看診</span>` : ''}
          ${p.status === '已看診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #fef3c7; color: #b45309; border: 1px solid #fcd34d;">已看診</span>` : ''}
          ${p.status === '須回診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #ef4444; color: white;">需回診</span>` : ''}
          ${p.status === '已回診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;">已回診</span>` : ''}
        </div>
        <div class="patient-meta">
          <span class="badge badge-blue" ${specialtyTitle ? `title="${esc(specialtyTitle)}"` : ''}>${specialtyText}</span>
          ${p.has_logs
            ? '<span class="badge badge-green">已開始聊天</span>'
            : '<span class="badge badge-gray">尚未聊天</span>'}
          <span>就診 ${p.form_count} 次</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">就診日期：${esc(p.latest_checkout || '—')}</div>
      </div>`;
  }).join('');
}

// ── chat detail ──
async function loadDetail(mrn, el) {
  if (state.currentMrn !== mrn) {
    state.currentVisitDate = null;
  }
  state.currentMrn = mrn;

  if (!el && mrn) {
    el = document.querySelector(`#patient-list-body .patient-item[data-mrn="${mrn}"]`);
  }

  document.querySelectorAll('#patient-list-body .patient-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');

  // Hide return visit, relation, and refresh badges/buttons while loading
  document.getElementById('chat-relation-badge').style.display = 'none';
  document.getElementById('chat-return-badge').style.display = 'none';
  document.getElementById('btn-clear-return-visit').style.display = 'none';
  const btnRefreshChat = document.getElementById('btn-refresh-chat');
  if (btnRefreshChat) btnRefreshChat.style.display = 'none';

  document.getElementById('visit-list-body').innerHTML =
    '<div class="empty-state"><div class="spinner-dark"></div><p>載入中…</p></div>';
  document.getElementById('chat-body').innerHTML =
    '<div class="empty-state"><p>請選擇就診紀錄以查看聊天對話</p></div>';
  document.getElementById('chat-title').textContent = '請選擇就診紀錄';
  document.getElementById('chat-sub').textContent   = '';
  document.getElementById('chat-timeline-nav').style.display = 'none';

  try {
    const d = await api('GET', '/api/chats/' + encodeURIComponent(mrn));
    if (d.error) {
      document.getElementById('visit-list-body').innerHTML =
        `<p style="color:var(--danger);padding:16px;">${esc(d.error)}</p>`;
      return;
    }
    
    state.currentSessions = d.sessions || [];
    state.currentForms = d.forms || [];
    
    // Update patient-level badges & buttons
    const chatRelationBadge = document.getElementById('chat-relation-badge');
    const chatReturnBadge = document.getElementById('chat-return-badge');
    const btnClearReturnVisit = document.getElementById('btn-clear-return-visit');

    if (d.patient.relation) {
      chatRelationBadge.textContent = d.patient.relation;
      chatRelationBadge.style.display = '';
    } else {
      chatRelationBadge.style.display = 'none';
    }

    const status = d.patient.status;
    if (status === '須看診') {
      chatReturnBadge.textContent = '需看診';
      chatReturnBadge.style.backgroundColor = '#f59e0b';
      chatReturnBadge.style.color = '#ffffff';
      chatReturnBadge.style.border = 'none';
      chatReturnBadge.style.display = '';
      
      btnClearReturnVisit.textContent = '已看診';
      btnClearReturnVisit.style.backgroundColor = '#f59e0b';
      btnClearReturnVisit.style.color = '#ffffff';
      btnClearReturnVisit.style.border = 'none';
      btnClearReturnVisit.style.display = '';
      btnClearReturnVisit.disabled = false;
      btnClearReturnVisit.style.cursor = 'pointer';
      btnClearReturnVisit.style.opacity = '1';
    } else if (status === '已看診') {
      chatReturnBadge.textContent = '已看診';
      chatReturnBadge.style.backgroundColor = '#fef3c7';
      chatReturnBadge.style.color = '#b45309';
      chatReturnBadge.style.border = '1px solid #fcd34d';
      chatReturnBadge.style.display = '';
      
      btnClearReturnVisit.textContent = '已看診';
      btnClearReturnVisit.style.backgroundColor = '#fef3c7';
      btnClearReturnVisit.style.color = '#b45309';
      btnClearReturnVisit.style.border = '1px solid #fcd34d';
      btnClearReturnVisit.style.display = '';
      btnClearReturnVisit.disabled = true;
      btnClearReturnVisit.style.cursor = 'not-allowed';
      btnClearReturnVisit.style.opacity = '0.7';
    } else if (status === '須回診') {
      chatReturnBadge.textContent = '需回診';
      chatReturnBadge.style.backgroundColor = '#ef4444';
      chatReturnBadge.style.color = '#ffffff';
      chatReturnBadge.style.border = 'none';
      chatReturnBadge.style.display = '';
      
      btnClearReturnVisit.textContent = '已回診';
      btnClearReturnVisit.style.backgroundColor = '#ef4444';
      btnClearReturnVisit.style.color = '#ffffff';
      btnClearReturnVisit.style.border = 'none';
      btnClearReturnVisit.style.display = '';
      btnClearReturnVisit.disabled = false;
      btnClearReturnVisit.style.cursor = 'pointer';
      btnClearReturnVisit.style.opacity = '1';
    } else if (status === '已回診') {
      chatReturnBadge.textContent = '已回診';
      chatReturnBadge.style.backgroundColor = '#fee2e2';
      chatReturnBadge.style.color = '#991b1b';
      chatReturnBadge.style.border = '1px solid #fca5a5';
      chatReturnBadge.style.display = '';
      
      btnClearReturnVisit.textContent = '已回診';
      btnClearReturnVisit.style.backgroundColor = '#fee2e2';
      btnClearReturnVisit.style.color = '#991b1b';
      btnClearReturnVisit.style.border = '1px solid #fca5a5';
      btnClearReturnVisit.style.display = '';
      btnClearReturnVisit.disabled = true;
      btnClearReturnVisit.style.cursor = 'not-allowed';
      btnClearReturnVisit.style.opacity = '0.7';
    } else {
      chatReturnBadge.style.display = 'none';
      btnClearReturnVisit.style.display = 'none';
      btnClearReturnVisit.disabled = false;
      btnClearReturnVisit.style.cursor = 'pointer';
      btnClearReturnVisit.style.opacity = '1';
    }

    if (btnRefreshChat) {
      btnRefreshChat.style.display = 'inline-flex';
    }
    
    renderVisits();
  } catch (err) {
    console.error(err);
    document.getElementById('visit-list-body').innerHTML =
      '<p style="color:var(--danger);padding:16px;">載入失敗</p>';
  }
}

function renderVisits() {
  const body = document.getElementById('visit-list-body');
  const forms = state.currentForms || [];
  
  document.getElementById('visit-count').textContent = forms.length;
  
  if (!forms.length) {
    body.innerHTML = `<div class="empty-state" style="padding:32px 0;">
      <div class="empty-icon">📋</div><p>無就診紀錄</p></div>`;
    return;
  }
  
  const sortedForms = [...forms].sort((a, b) => b.checkout_date.localeCompare(a.checkout_date));
  
  body.innerHTML = sortedForms.map((f, index) => {
    const v_current = f.checkout_date;
    const formsAsc = [...forms].sort((a, b) => a.checkout_date.localeCompare(b.checkout_date));
    const nextForm = formsAsc.find(fa => fa.checkout_date > v_current);
    const v_next = nextForm ? nextForm.checkout_date : null;
    
    const hasLogs = state.currentSessions.some(s => {
      const sTime = parseDate(s.start_time);
      const vCurrent = parseDate(v_current);
      const vNext = parseDate(v_next);
      return sTime && vCurrent && sTime >= vCurrent && (!vNext || sTime < vNext);
    });
    
    return `
      <div class="visit-item" id="visit-item-${index}" data-date="${esc(f.checkout_date)}" onclick="selectVisit('${esc(f.checkout_date)}', this)">
        <div class="visit-title">${esc(f.checkout_date)}</div>
        <div class="visit-meta">
          <span class="badge badge-blue">${esc(f.specialty)}</span>
          ${hasLogs
            ? '<span class="badge badge-green">已開始聊天</span>'
            : '<span class="badge badge-gray">尚未聊天</span>'}
        </div>
      </div>
    `;
  }).join('');
  
  let targetVisitItem = null;
  if (state.currentVisitDate) {
    targetVisitItem = Array.from(body.querySelectorAll('.visit-item')).find(item => item.getAttribute('data-date') === state.currentVisitDate);
  }
  if (!targetVisitItem) {
    targetVisitItem = body.querySelector('.visit-item');
  }
  
  if (targetVisitItem) {
    targetVisitItem.click();
  }
}

function selectVisit(checkoutDate, el) {
  state.currentVisitDate = checkoutDate;
  document.querySelectorAll('#visit-list-body .visit-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  
  document.getElementById('chat-title').textContent = `${state.currentMrn}`;
  document.getElementById('chat-sub').textContent = '就診日期：' + checkoutDate;
  
  const v_current = checkoutDate;
  const formsAsc = [...state.currentForms].sort((a, b) => a.checkout_date.localeCompare(b.checkout_date));
  const nextForm = formsAsc.find(f => f.checkout_date > v_current);
  const v_next = nextForm ? nextForm.checkout_date : null;
  
  const matchedSessions = state.currentSessions.filter(s => {
    const sTime = parseDate(s.start_time);
    const vCurrent = parseDate(v_current);
    const vNext = parseDate(v_next);
    return sTime && vCurrent && sTime >= vCurrent && (!vNext || sTime < vNext);
  });
  
  matchedSessions.sort((a, b) => a.start_time.localeCompare(b.start_time));
  
  const chatBody = document.getElementById('chat-body');
  const timelineNav = document.getElementById('chat-timeline-nav');
  
  if (!matchedSessions.length) {
    chatBody.innerHTML = '<div class="empty-state"><div class="empty-icon">💬</div><p>此就診期間無聊天紀錄</p></div>';
    timelineNav.innerHTML = '';
    timelineNav.style.display = 'none';
    return;
  }
  
  let chatHtml = '';
  let dotHtml = '';
  
  matchedSessions.forEach((s, idx) => {
    let labelStr = '';
    if (s.session_id === 'active_session.json') {
      labelStr = s.label.replace('進行中對話', '最後一次對話');
    } else {
      const sessionDate = s.metadata?.session_date || (s.start_time ? s.start_time.substring(0, 10) : '');
      const seq = s.metadata?.session_sequence;
      const seqStr = seq ? `第 ${seq} 次對話` : '對話';
      const timePart = s.start_time && s.start_time.includes(' ') ? s.start_time.split(' ')[1] : '';
      const timeStr = timePart ? ` (${timePart})` : '';
      labelStr = `${sessionDate} ${seqStr}${timeStr}`;
    }
    
    chatHtml += `
      <div class="session-divider" id="session-divider-${idx}">
        <span>———— ${esc(labelStr)} ————</span>
      </div>
    `;
    
    const msgs = s.messages || [];
    if (!msgs.length) {
      chatHtml += '<div class="no-logs-notice" style="margin: 0 20px;">⚠️ 此對話無聊天紀錄</div>';
    } else {
      msgs.forEach(m => {
        const isUser = m.role === 'user';
        chatHtml += `
          <div class="bubble-row ${isUser ? 'user' : 'assistant'}">
            <div>
              <div class="bubble">${esc(m.content)}</div>
              <div class="bubble-time">${m.created_at}</div>
            </div>
          </div>
        `;
      });
    }
    
    const sessionDate = s.metadata?.session_date || (s.start_time ? s.start_time.substring(0, 10) : '');
    const datePrefix = sessionDate ? sessionDate + ' ' : '';
    const tooltipLabel = s.session_id === 'active_session.json' ? `${datePrefix}最後一次對話` : `${datePrefix}對話 #${s.metadata?.session_sequence || (idx + 1)}`;
  
    dotHtml += `
      <div class="timeline-dot${idx === 0 ? ' active' : ''}" 
           data-label="${esc(tooltipLabel)}" 
           onclick="scrollToSession(${idx})">
      </div>
    `;
  });
  
  chatBody.innerHTML = chatHtml;
  timelineNav.innerHTML = dotHtml;
  timelineNav.style.display = 'flex';
  
  chatBody.scrollTop = 0;
  
  chatBody.onscroll = function() {
    let activeIdx = 0;
    const dividers = chatBody.querySelectorAll('.session-divider');
    dividers.forEach((div, idx) => {
      if (div.offsetTop <= chatBody.scrollTop + 40) {
        activeIdx = idx;
      }
    });
    
    const dots = timelineNav.querySelectorAll('.timeline-dot');
    dots.forEach((dot, idx) => {
      if (idx === activeIdx) {
        dot.classList.add('active');
      } else {
        dot.classList.remove('active');
      }
    });
  };
}

function scrollToSession(idx) {
  const chatBody = document.getElementById('chat-body');
  const target = document.getElementById(`session-divider-${idx}`);
  if (chatBody && target) {
    chatBody.scrollTo({
      top: target.offsetTop - 12,
      behavior: 'smooth'
    });
  }
}

function confirmClearReturnVisit() {
  const btn = document.getElementById('btn-clear-return-visit');
  if (btn && btn.disabled) return;
  const isLook = btn && btn.textContent === '已看診';
  
  const modal = document.getElementById('modal-confirm-return-visit');
  if (modal) {
    if (isLook) {
      modal.querySelector('.modal-alert-title').textContent = '確認已看診';
      modal.querySelector('.modal-alert-banner div').textContent = '將該病患狀態更新為「已看診」。';
      modal.querySelector('.modal-alert-subtitle').textContent = '確定要將該病患狀態更新為「已看診」嗎？';
      
      const confirmBtn = modal.querySelector('.modal-alert-actions .btn-danger');
      if (confirmBtn) {
        confirmBtn.textContent = '確認已看診';
        confirmBtn.style.backgroundColor = '#f59e0b';
      }
    } else {
      modal.querySelector('.modal-alert-title').textContent = '確認已回診';
      modal.querySelector('.modal-alert-banner div').textContent = '將該病患狀態更新為「已回診」。';
      modal.querySelector('.modal-alert-subtitle').textContent = '確定要將該病患狀態更新為「已回診」嗎？';
      
      const confirmBtn = modal.querySelector('.modal-alert-actions .btn-danger');
      if (confirmBtn) {
        confirmBtn.textContent = '確認已回診';
        confirmBtn.style.backgroundColor = '#ef4444';
      }
    }
  }
  openModal('modal-confirm-return-visit');
}

async function executeClearReturnVisit() {
  const mrn = state.currentMrn;
  if (!mrn) return;
  
  const btn = document.getElementById('btn-clear-return-visit');
  const isLook = btn && btn.textContent === '已看診';
  const targetStatus = isLook ? '已看診' : '已回診';
  
  try {
    const res = await api('POST', `/api/patients/${encodeURIComponent(mrn)}/clear_return_visit`, { status: targetStatus });
    if (res.success) {
      closeModal('modal-confirm-return-visit');
      showToast(isLook ? '✅ 已更新看診狀態' : '✅ 已更新回診狀態', 'ok');
      
      // Update patient badges in client side with light colors
      const chatReturnBadge = document.getElementById('chat-return-badge');
      if (targetStatus === '已看診') {
        if (chatReturnBadge) {
          chatReturnBadge.textContent = '已看診';
          chatReturnBadge.style.backgroundColor = '#fef3c7';
          chatReturnBadge.style.color = '#b45309';
          chatReturnBadge.style.border = '1px solid #fcd34d';
          chatReturnBadge.style.display = '';
        }
        if (btn) {
          btn.textContent = '已看診';
          btn.style.backgroundColor = '#fef3c7';
          btn.style.color = '#b45309';
          btn.style.border = '1px solid #fcd34d';
          btn.style.display = '';
          btn.disabled = true;
          btn.style.cursor = 'not-allowed';
          btn.style.opacity = '0.7';
        }
      } else {
        if (chatReturnBadge) {
          chatReturnBadge.textContent = '已回診';
          chatReturnBadge.style.backgroundColor = '#fee2e2';
          chatReturnBadge.style.color = '#991b1b';
          chatReturnBadge.style.border = '1px solid #fca5a5';
          chatReturnBadge.style.display = '';
        }
        if (btn) {
          btn.textContent = '已回診';
          btn.style.backgroundColor = '#fee2e2';
          btn.style.color = '#991b1b';
          btn.style.border = '1px solid #fca5a5';
          btn.style.display = '';
          btn.disabled = true;
          btn.style.cursor = 'not-allowed';
          btn.style.opacity = '0.7';
        }
      }
      
      if (state.allPatients) {
        const p = state.allPatients.find(x => x.medical_record_num === mrn);
        if (p) p.status = targetStatus;
      }
      if (state.allFormPatients) {
        const p = state.allFormPatients.find(x => x.medical_record_num === mrn);
        if (p) p.status = targetStatus;
      }
      
      const displayFormReturnBadge = document.getElementById('display-form-return-badge');
      if (displayFormReturnBadge && state.formCurrentMrn === mrn) {
        if (targetStatus === '已看診') {
          displayFormReturnBadge.textContent = '已看診';
          displayFormReturnBadge.style.backgroundColor = '#fef3c7';
          displayFormReturnBadge.style.color = '#b45309';
          displayFormReturnBadge.style.border = '1px solid #fcd34d';
          displayFormReturnBadge.style.display = '';
        } else {
          displayFormReturnBadge.textContent = '已回診';
          displayFormReturnBadge.style.backgroundColor = '#fee2e2';
          displayFormReturnBadge.style.color = '#991b1b';
          displayFormReturnBadge.style.border = '1px solid #fca5a5';
          displayFormReturnBadge.style.display = '';
        }
      }
      
      const sortCriteria = document.getElementById('patient-sort-select')?.value || 'checkout_desc';
      sortAndRenderPatients(sortCriteria);
      const formSortCriteria = document.getElementById('form-patient-sort-select')?.value || 'checkout_desc';
      sortAndRenderFormPatients(formSortCriteria);
    } else {
      alert(res.error || '清除失敗');
    }
  } catch (err) {
    console.error(err);
    alert('連線失敗: ' + err);
  }
}

async function refreshChatHistory() {
  const mrn = state.currentMrn;
  if (!mrn) return;

  const btn = document.getElementById('btn-refresh-chat');
  if (!btn) return;

  const svg = btn.querySelector('svg');
  if (svg) svg.classList.add('spinning');
  btn.disabled = true;

  try {
    const list = await api('GET', '/api/chats');
    state.allPatients = Array.isArray(list) ? list : [];
    const sortCriteria = document.getElementById('patient-sort-select')?.value || 'checkout_desc';
    sortAndRenderPatients(sortCriteria);

    await loadDetail(mrn);
    showToast('✅ 對話紀錄已更新', 'ok');
  } catch (err) {
    console.error(err);
    showToast('❌ 更新失敗', 'fail');
  } finally {
    if (svg) svg.classList.remove('spinning');
    btn.disabled = false;
  }
}

