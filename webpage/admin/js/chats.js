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
           onclick="loadDetail('${esc(p.medical_record_num)}', this)">
        <div class="patient-mrn">
          ${esc(p.medical_record_num)}
          ${p.relation ? `<span class="badge badge-relation" style="margin-left: 6px; font-weight: 500;">${esc(p.relation)}</span>` : ''}
          ${p.needs_return_visit ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #ef4444; color: white;">需回診</span>` : ''}
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
  state.currentMrn = mrn;
  document.querySelectorAll('#patient-list-body .patient-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');

  // Hide return visit and relation badges/buttons while loading
  document.getElementById('chat-relation-badge').style.display = 'none';
  document.getElementById('chat-return-badge').style.display = 'none';
  document.getElementById('btn-clear-return-visit').style.display = 'none';

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

    if (d.patient.needs_return_visit) {
      chatReturnBadge.style.display = '';
      btnClearReturnVisit.style.display = '';
    } else {
      chatReturnBadge.style.display = 'none';
      btnClearReturnVisit.style.display = 'none';
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
      <div class="visit-item" id="visit-item-${index}" onclick="selectVisit('${esc(f.checkout_date)}', this)">
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
  
  const firstVisitItem = body.querySelector('.visit-item');
  if (firstVisitItem) {
    firstVisitItem.click();
  }
}

function selectVisit(checkoutDate, el) {
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
  openModal('modal-confirm-return-visit');
}

async function executeClearReturnVisit() {
  const mrn = state.currentMrn;
  if (!mrn) return;
  
  try {
    const res = await api('POST', `/api/patients/${encodeURIComponent(mrn)}/clear_return_visit`);
    if (res.success) {
      closeModal('modal-confirm-return-visit');
      showToast('✅ 已清除回診狀態', 'ok');
      
      // Instantly clear patient badges in client side
      document.getElementById('chat-return-badge').style.display = 'none';
      document.getElementById('btn-clear-return-visit').style.display = 'none';
      
      if (state.allPatients) {
        const p = state.allPatients.find(x => x.medical_record_num === mrn);
        if (p) p.needs_return_visit = false;
      }
      if (state.allFormPatients) {
        const p = state.allFormPatients.find(x => x.medical_record_num === mrn);
        if (p) p.needs_return_visit = false;
      }
      
      const displayFormReturnBadge = document.getElementById('display-form-return-badge');
      if (displayFormReturnBadge && state.formCurrentMrn === mrn) {
        displayFormReturnBadge.style.display = 'none';
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

