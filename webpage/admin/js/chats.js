// ════════════════════════════════════════════════════════════════════════════
// 檔案總覽：chats.js —「病患對話紀錄」分頁前端邏輯（後台管理系統 / EDDI_Chatbot）
// ════════════════════════════════════════════════════════════════════════════
//
// 【這個檔案在整體系統中的角色】
// 對應 webpage/admin/html/chats.html 的三欄式版面（左：病患列表／中：就診紀錄／
// 右：聊天面板）。負責向後端 Flask API（src/admin_server.py 的 admin_bp 藍圖）
// 拉取資料、在前端做排序/篩選/分組，並把結果渲染進 chats.html 對應的 DOM 元素。
// 本檔案依賴 webpage/admin/js/script.js 提供的共用工具：
//   - state：全域狀態物件（本檔案主要使用 state.currentMrn、state.currentVisitDate、
//            state.currentSessions、state.currentForms、state.allPatients、
//            state.allFormPatients、state.formCurrentMrn）
//   - api(method, path, body)：包裝 fetch，自動帶入 credentials（session cookie）、
//            自動處理 401（登入逾時/被踢出）並轉呼叫 showLogin()
//   - esc(s)：HTML escape，避免 XSS
//   - parseDate(str)：將 "YYYY-MM-DD HH:MM:SS" 或 ISO 字串轉為可比較的 Date 物件
//   - loading(on) / showToast(msg, type) / openModal(id) / closeModal(id)：UI 共用元件
//
// 【主要功能列表】
// 1. 病患列表載入與排序：loadChats() 呼叫 GET /api/chats 取得病患列表快取到
//    state.allPatients；sortAndRenderPatients() 依使用者選擇的排序條件（就診日期/
//    病歷號，升冪/降冪）純前端排序後交給 renderPatientList() 渲染。
// 2. 病患詳情載入：loadDetail(mrn) 呼叫 GET /api/chats/<mrn>，取得該病患的
//    出院表單歷史（forms）與 LINE 對話紀錄（sessions），並依病患目前狀態
//    （'須看診'/'已看診'/'須回診'/'已回診'）動態更新警示徽章與「已看診/已回診」按鈕。
// 3. 就診紀錄渲染與對話配對：renderVisits() 渲染中欄卡片列表，並依「本次就診日期
//    ~ 下一次就診日期」的時間區間，判斷每次就診是否已有對應的 LINE 對話紀錄。
// 4. 對話內容渲染（依 session 分組 + 時間軸）：selectVisit() 篩出對應時間區間內的
//    session，依序渲染聊天泡泡與 session 分隔線，並產生右側時間軸圓點；
//    scrollToSession() 讓使用者點擊圓點可平滑捲動到對應 session。
// 5. 清除「須看診/須回診」警示：confirmClearReturnVisit() 開啟二次確認 Modal，
//    executeClearReturnVisit() 呼叫 POST /api/patients/<mrn>/clear_return_visit
//    真正更新後端病患狀態，並同步更新前端各處已渲染的徽章/按鈕與快取資料。
// 6. 重新整理：refreshChatHistory() 重新拉取病患列表與目前病患詳情，
//    用於病患剛傳送新訊息時，醫護人員想立即看到最新對話內容。
//
// 【資料從哪裡來（對應後端 src/admin_server.py）】
//   - GET  /api/chats                                  → get_chats()：病患列表（含統計）
//   - GET  /api/chats/<mrn>                             → get_chat_detail()：單一病患詳情
//   - POST /api/patients/<mrn>/clear_return_visit       → clear_return_visit()：清除警示
// 病患是否可見的權限過濾（一般醫師僅能看自己曾看診過的病患，管理員可看全部）完全
// 由後端依 Flask session 帳號自動處理，本檔案不需要、也沒有做任何權限判斷。
// ════════════════════════════════════════════════════════════════════════════

// ── chats list ──

/**
 * loadChats()
 * 用途：初次進入「聊天紀錄」分頁時，向後端拉取完整病患列表並渲染到左欄。
 * 觸發時機：切換到 section-chats 分頁時由外部（script.js 的分頁切換邏輯）呼叫。
 * 呼叫 API：GET /api/chats
 *   → 對應後端 src/admin_server.py 的 get_chats()。
 *   → 回應格式：病患物件陣列，每筆包含 medical_record_num、line_id、relation、
 *     form_count、msg_count、has_logs、last_chat、latest_checkout、specialty、
 *     specialties（陣列）、status、needs_return_visit 等欄位（詳見檔案總覽註解）。
 * 資料處理：將回應存入 state.allPatients（供之後排序/清除警示等操作重複使用，
 *   避免每次排序都重新打 API），再讀取目前排序下拉選單 (#patient-sort-select)
 *   的值，呼叫 sortAndRenderPatients() 依該排序條件渲染。
 * 失敗處理：若 fetch/JSON 解析失敗，清空 state.allPatients 並渲染空列表，
 *   同時在 console 記錄錯誤（不中斷 UI，只是顯示「無病患資料」）。
 * 對外影響：更新 #patient-list-body（透過 renderPatientList）、切換 #loading 遮罩。
 */
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

/**
 * sortAndRenderPatients(criteria)
 * 用途：對已快取在 state.allPatients 的病患陣列做「純前端」排序（不重新呼叫 API），
 *   再交給 renderPatientList() 渲染。之所以能在前端排序而不用重打 API，是因為
 *   GET /api/chats 一次性回傳了所有病患的完整資料，排序只是改變顯示順序。
 * 觸發時機：
 *   1. loadChats() / refreshChatHistory() 取得新資料後主動呼叫一次（沿用目前選單值）。
 *   2. 使用者變更 #patient-sort-select 下拉選單時，由 chats.html 的
 *      onchange="sortAndRenderPatients(this.value)" 直接呼叫。
 *   3. executeClearReturnVisit() 清除警示成功後，重新排序以反映最新狀態。
 * 參數：criteria - 排序條件字串，可能值：
 *   - 'checkout_desc'：依 latest_checkout（最新就診日期字串，YYYY-MM-DD）由新到舊
 *   - 'checkout_asc' ：依 latest_checkout 由舊到新
 *   - 'mrn_desc'     ：依 medical_record_num（病歷號字串）字典序由大到小
 *   - 'mrn_asc'      ：依 medical_record_num 字典序由小到大
 *   （日期/病歷號皆為字串，故直接用 localeCompare 比較；若欄位為 null 則以空字串代入，
 *    空字串排序時會被視為「最小」，因此無日期/病歷號的資料會被排在對應方向的末端）。
 * 對外影響：呼叫 renderPatientList(patients) 重新渲染 #patient-list-body。
 * 注意：會先用 [...state.allPatients] 複製一份陣列再排序，避免直接修改
 *   （污染）原始快取陣列的順序，確保每次切換排序條件都是從原始資料重新排序。
 */
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

/**
 * renderPatientList(patients)
 * 用途：將已排序好的病患陣列渲染成卡片列表，寫入 #patient-list-body。
 * 觸發時機：由 sortAndRenderPatients() 呼叫（間接被 loadChats()/使用者變更排序/
 *   refreshChatHistory()/executeClearReturnVisit() 觸發），不會被其他地方單獨呼叫。
 * 參數：patients - 病患物件陣列（來自 GET /api/chats 回應，可能已排序）。
 * 渲染邏輯：
 *   - 先更新 #patient-count 徽章數字為 patients.length。
 *   - 若陣列為空，顯示「無病患資料」空狀態並直接 return。
 *   - 每筆病患渲染一個 .patient-item 卡片：
 *     - data-mrn 屬性存病歷號，供 CSS 選取器與之後手動標記 active 用。
 *     - 若 p.medical_record_num === state.currentMrn（目前已選中的病患）則加上
 *       'active' class，讓卡片維持選中樣式（例如排序後仍能標示原本選中的病患）。
 *     - 病歷號後方視情況附加：
 *       a) 關係徽章（p.relation，如「帳號本人」「父親」）。
 *       b) 狀態警示徽章：依 p.status 顯示對應顏色/文字——
 *          '須看診' → 橘色「需看診」；'已看診' → 淺黃「已看診」；
 *          '須回診' → 紅色「需回診」（★ 這是最重要的警示：代表 LINE Bot 在某次
 *            AI 回覆病患的內容中偵測到「請立即前往急診回診」等字眼，後端
 *            src/admin_server.py/bot.py 便將該病患 DB 的 status 設為「須回診」，
 *            用紅色最搶眼的顏色提示醫護人員需優先處理）；
 *          '已回診' → 淺紅「已回診」（代表警示已被醫護人員手動清除確認過）。
 *     - .patient-meta 區塊顯示：科別徽章（p.specialty；若病患看過多個科別
 *       [p.specialties.length > 1] 則在文字後方加 "..." 並透過 title 屬性顯示
 *       完整科別清單作為滑鼠懸停提示）、是否已開始聊天徽章（依 p.has_logs 布林值：
 *       綠色「已開始聊天」或灰色「尚未聊天」）、就診次數（p.form_count）。
 *     - 最下方顯示最新就診日期（p.latest_checkout，若無則顯示 "—"）。
 *   - 每張卡片綁定 onclick="loadDetail(mrn, this)"，點擊後會載入該病患的完整詳情
 *     （出院表單歷史 + LINE 對話紀錄）到中欄與右欄。
 * 安全性：所有插入 HTML 的動態文字皆經過 esc() 轉義，避免病歷號/關係/科別等
 *   欄位中若含有惡意字元造成 XSS。
 */
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

/**
 * loadDetail(mrn, el)
 * 用途：使用者點擊左欄某位病患時，載入該病患的完整詳情（出院表單歷史 + LINE
 *   對話紀錄），並依病患目前狀態更新警示徽章與「已看診/已回診」清除按鈕。
 * 觸發時機：
 *   - 由 chats.html 病患卡片的 onclick="loadDetail(mrn, this)" 觸發（此時 el 為
 *     被點擊的 DOM 元素）。
 *   - 由 refreshChatHistory() 呼叫（此時不傳 el，函式內會自動用 mrn 反查對應的
 *     .patient-item 元素以補上 active 樣式）。
 * 參數：
 *   - mrn：病歷號（medical_record_num）。
 *   - el（可選）：被點擊的病患卡片 DOM 元素，用於標記 active 樣式；若未傳入
 *     則以 `#patient-list-body .patient-item[data-mrn="${mrn}"]` 選取器反查。
 * 狀態管理：
 *   - 若切換到不同病患（state.currentMrn !== mrn），重置 state.currentVisitDate
 *     （代表「目前選中的就診日期」），避免沿用上一位病患的就診日期去比對新病患的
 *     forms，造成 renderVisits() 選錯就診卡片。
 *   - 設定 state.currentMrn = mrn，供後續 renderVisits()/selectVisit()/
 *     executeClearReturnVisit() 等函式讀取「目前正在查看哪位病患」。
 * DOM 更新（載入中的過渡畫面）：
 *   - 移除所有病患卡片的 active class，只給目前點擊的卡片加上 active（visual highlight）。
 *   - 先隱藏關係徽章、狀態警示徽章、清除警示按鈕、重新整理按鈕（避免顯示上一位
 *     病患殘留的徽章資訊，等新資料回來後才依新資料決定顯示與否）。
 *   - 中欄 #visit-list-body 顯示 spinner「載入中…」，右欄 #chat-body 顯示提示文字，
 *     #chat-title/#chat-sub 重置為預設文字，#chat-timeline-nav 隱藏。
 * 呼叫 API：GET /api/chats/<mrn>（encodeURIComponent 處理病歷號中可能的特殊字元）
 *   → 對應後端 src/admin_server.py 的 get_chat_detail()。
 *   → 回應格式：
 *     {
 *       patient: { medical_record_num, line_id, relation, status, needs_return_visit },
 *       forms:    [ { medical_record_num, doctor_account, specialty, checkout_date,
 *                      symptoms:[...], is_chatted, line_account_id, line_name, relation } ... ],
 *       sessions: [ { session_id, label, start_time, messages:[...], metadata } ... ]
 *     }
 *   → 若回應含 error 欄位（例如一般醫師嘗試查看非自己看診過的病患，後端回 403 並帶
 *     error 訊息），直接把錯誤訊息顯示在 #visit-list-body 並中止後續處理。
 * 資料處理與渲染：
 *   - 將 d.sessions 存入 state.currentSessions，d.forms 存入 state.currentForms
 *     （後續 renderVisits()/selectVisit() 皆讀取這兩個快取，不會重複打 API）。
 *   - 關係徽章 (#chat-relation-badge)：依 d.patient.relation 是否存在決定顯示/隱藏與文字。
 *   - 狀態警示徽章 (#chat-return-badge) 與清除按鈕 (#btn-clear-return-visit)：
 *     依 d.patient.status 四個可能值分別設定文字/顏色/是否 disabled：
 *       '須看診' → 徽章橘色「需看診」；按鈕橘色「已看診」且可點擊（尚未處理，
 *                  故按鈕可點擊讓醫護人員確認已看診後清除警示）。
 *       '已看診' → 徽章淺黃「已看診」；按鈕同樣顯示「已看診」但 disabled
 *                  （已經處理過，純粹用來顯示歷史狀態，避免重複點擊）。
 *       '須回診' → 徽章紅色「需回診」（★ 對應 LINE Bot AI 回覆偵測到「請立即前往
 *                  急診回診」等關鍵字後，後端自動把病患狀態設為此值，是本頁面
 *                  最重要的警示訊號）；按鈕紅色「已回診」且可點擊。
 *       '已回診' → 徽章淺紅「已回診」；按鈕同樣顯示「已回診」但 disabled。
 *       其他（如「出院」，代表尚無任何警示）→ 徽章與按鈕皆隱藏。
 *   - 若存在 #btn-refresh-chat，顯示為 inline-flex（僅在成功載入某位病患詳情後才顯示）。
 *   - 最後呼叫 renderVisits() 渲染中欄就診紀錄列表（並間接觸發右欄對話渲染，見該函式說明）。
 * 例外處理：fetch 或渲染過程出錯時，在 console 記錄並於 #visit-list-body 顯示「載入失敗」。
 */
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

/**
 * renderVisits()
 * 用途：將 state.currentForms（目前病患的出院表單/就診紀錄陣列）渲染成中欄
 *   #visit-list-body 的卡片列表，並自動選中第一張（或記憶中的）卡片以連動右欄對話。
 * 觸發時機：由 loadDetail() 在成功取得病患詳情後呼叫（每次切換病患都會重新渲染）。
 * 資料處理與渲染邏輯：
 *   - 更新 #visit-count 為 forms.length；若無表單資料，顯示「無就診紀錄」空狀態並 return。
 *   - 依 checkout_date 由新到舊排序（sortedForms）決定顯示順序（最新看診排最上面，
 *     符合醫護人員通常想先看最近就診狀況的使用情境）。
 *   - 【為什麼要判斷 hasLogs／如何配對就診紀錄與 LINE 對話】
 *     一個病患可能多次掛急診看診，每次看診後都會收到 LINE Bot 衛教訊息並可能
 *     持續對話一段時間；但 LINE 對話 session（chat_logs/<mrn>/*.json）本身沒有
 *     欄位直接記錄「這是對應第幾次看診」。因此前端用時間區間推論歸屬：
 *       v_current = 本次就診日期（f.checkout_date）
 *       v_next    = 依 checkout_date 由舊到新排序後，找出第一筆
 *                   checkout_date > v_current 的表單，取其日期作為區間右界
 *                   （若沒有更新的一筆，代表這是最新一次看診，則 v_next = null，
 *                   區間開放到未來）。
 *     只要某個 session 的 start_time 落在 [v_current, v_next) 區間內
 *     （用 parseDate() 轉為 Date 物件比較），就視為「屬於這次就診」的對話，
 *     用來決定該卡片要顯示綠色「已開始聊天」或灰色「尚未聊天」徽章。
 *     （右欄實際渲染對話內容時，selectVisit() 會用同一套時間區間邏輯篩選 session，
 *      確保中欄徽章顯示的「有沒有對話」跟右欄實際顯示的內容一致。）
 *   - 每張卡片顯示：就診日期時間（去掉 'T'，只取到分鐘）、科別徽章、聊天狀態徽章，
 *     並綁定 onclick="selectVisit(checkoutDate, this)"。
 *   - 渲染完成後，嘗試找回 state.currentVisitDate（使用者上次選中的就診日期）
 *     對應的卡片；若找不到（例如剛切換病患、還沒有選過任何就診紀錄），則
 *     預設選第一張卡片（即最新一次就診）。找到目標卡片後主動觸發 .click()，
 *     讓右欄對話內容能自動顯示，不需要使用者再多點一次。
 */
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
        <div class="visit-title">${esc(f.checkout_date ? f.checkout_date.replace('T', ' ').substring(0, 16) : '')}</div>
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

/**
 * selectVisit(checkoutDate, el)
 * 用途：使用者點擊中欄某張就診紀錄卡片時，篩出該次就診期間對應的 LINE 對話
 *   session，並將對話內容（依 session 分組、附時間軸）渲染到右欄 #chat-body。
 * 觸發時機：
 *   - 由 chats.html 動態產生的 .visit-item 卡片 onclick 呼叫。
 *   - 由 renderVisits() 在渲染完成後對目標卡片呼叫 .click() 間接觸發（自動選中）。
 * 參數：
 *   - checkoutDate：該次就診的 checkout_date 字串（作為時間區間左界）。
 *   - el：被點擊的卡片 DOM 元素，用於切換 active 樣式。
 * 狀態管理：
 *   - state.currentVisitDate = checkoutDate：記住目前選中的就診日期，讓
 *     renderVisits() 在下次重新渲染（例如重新整理或切回同一病患）時能還原選中狀態。
 * DOM 更新：
 *   - 移除所有 .visit-item 的 active class，只給目前點擊的卡片加上 active。
 *   - #chat-title 設為目前病歷號（state.currentMrn），#chat-sub 設為「就診日期：...」。
 * 【session 時間區間篩選邏輯（與 renderVisits() 的 hasLogs 判斷完全一致）】：
 *   - v_current = checkoutDate（本次就診日期）。
 *   - 依 state.currentForms 的 checkout_date 由舊到新排序，找出第一筆
 *     checkout_date > v_current 的表單作為 v_next（下一次就診日期）；若沒有更新
 *     的一筆（代表這是最新一次看診），v_next = null，代表區間右界開放到未來。
 *   - 從 state.currentSessions 中篩出 start_time 落在 [v_current, v_next) 的
 *     session 作為 matchedSessions，並依 start_time 由舊到新排序（讓對話依真實
 *     發生時間先後呈現，符合閱讀直覺）。
 *   - 若找不到任何符合的 session，顯示「此就診期間無聊天紀錄」空狀態並清空/隱藏
 *     時間軸 (#chat-timeline-nav)，直接 return。
 * 【對話內容渲染：依 session 分組 + 時間軸】：
 *   - 對每個 session 產生：
 *     a) 一個 .session-divider 分隔線（帶 id="session-divider-{idx}"，供時間軸
 *        點擊時可用 offsetTop 定位捲動目標），內容為顯示用的 label 字串：
 *        - 若 session_id === 'active_session.json'（代表這是「目前仍在進行、
 *          尚未因超過 1 小時無互動而被歸檔」的對話檔案），將原本後端給的
 *          label 中的「進行中對話」文字取代為「最後一次對話」，因為在歷史紀錄
 *          檢視情境下，這通常已經是該次就診中「最後、且可能仍會持續」的對話，
 *          用「最後一次對話」更符合醫護人員檢視歷史紀錄時的語意。
 *        - 其他 session（已歸檔的 xxx_NN.json 檔案）則自行組出
 *          "{session_date} 第{N}次對話 (HH:MM:SS)" 格式的 label（若 metadata 缺少
 *          session_sequence 則只顯示「對話」，不顯示序號）。
 *     b) 該 session 底下所有訊息（s.messages）渲染成聊天泡泡：role === 'user'
 *        的訊息（病患發送）套用 'user' class（通常靠右/不同底色），其餘視為
 *        'assistant'（LINE Bot AI 回覆）套用 'assistant' class；若該 session
 *        沒有任何訊息，顯示「⚠️ 此對話無聊天紀錄」提示（例如 session 檔案存在但
 *        因某種原因訊息陣列是空的）。
 *     c) 對應的一個 .timeline-dot（時間軸圓點），data-label 屬性存放懸停提示文字
 *        （格式類似 "{session_date} 最後一次對話" 或 "{session_date} 對話 #{N}"），
 *        並綁定 onclick="scrollToSession(idx)"；第一個 session（idx === 0，
 *        即時間最早的那個）預設加上 'active' class 作為初始高亮。
 *   - 全部組好後一次性寫入 chatBody.innerHTML 與 timelineNav.innerHTML（避免多次
 *     觸發 reflow），並將 chatBody.scrollTop 重置為 0（每次選擇新的就診紀錄都從
 *     對話最上方開始看）。
 * 捲動同步時間軸（onscroll 事件綁定）：
 *   - 每次使用者手動捲動 #chat-body 時，動態計算目前捲動位置對應到哪一個
 *     .session-divider（判斷條件：分隔線的 offsetTop 小於等於目前 scrollTop + 40，
 *     取符合條件中 idx 最大的一個，即「目前畫面最上方可見、且已經捲過去的那個分隔線」），
 *     並將 #chat-timeline-nav 中對應 idx 的 .timeline-dot 加上 'active' class、
 *     其餘移除，讓時間軸圓點即時反映使用者目前捲動閱讀到哪一段對話。
 */
function selectVisit(checkoutDate, el) {
  state.currentVisitDate = checkoutDate;
  document.querySelectorAll('#visit-list-body .visit-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  
  document.getElementById('chat-title').textContent = `${state.currentMrn}`;
  document.getElementById('chat-sub').textContent = '就診日期：' + (checkoutDate ? checkoutDate.replace('T', ' ').substring(0, 16) : '');
  
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

/**
 * scrollToSession(idx)
 * 用途：使用者點擊右側時間軸的某個 .timeline-dot 時，將 #chat-body 平滑捲動到
 *   對應 session 的分隔線位置，方便快速跳轉到特定一段對話，不需手動慢慢滑動。
 * 觸發時機：由 selectVisit() 動態產生的 .timeline-dot 的 onclick="scrollToSession(idx)" 呼叫。
 * 參數：idx - session 在目前 matchedSessions 陣列中的索引，對應
 *   id="session-divider-{idx}" 的分隔線元素。
 * 邏輯：找到目標分隔線元素後，呼叫 chatBody.scrollTo() 以 smooth 行為捲動，
 *   目標位置為該分隔線的 offsetTop 再往上偏移 12px（留一點視覺緩衝，避免分隔線
 *   緊貼視窗頂端邊緣）。
 */
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

/**
 * confirmClearReturnVisit()
 * 用途：使用者點擊右欄的「已看診/已回診」按鈕 (#btn-clear-return-visit) 時，
 *   開啟二次確認 Modal（#modal-confirm-return-visit），避免誤觸直接清除警示。
 * 觸發時機：由 chats.html 該按鈕的 onclick="confirmClearReturnVisit()" 呼叫。
 * 邏輯：
 *   - 若按鈕目前是 disabled 狀態（代表狀態已經是「已看診」或「已回診」，即已無
 *     需要清除的警示），直接 return，不開啟 Modal（防止透過其他方式間接觸發時
 *     仍誤動作；正常情況下 disabled 按鈕本身就無法被點擊觸發 onclick）。
 *   - 依按鈕目前文字判斷情境：isLook = 按鈕文字是否為 '已看診'
 *     （對應病患目前狀態為「須看診」，屬於較輕微的警示，用橘色系）；
 *     否則視為「已回診」情境（對應病患目前狀態為「須回診」，屬於較嚴重的警示，
 *     用紅色系，因為此狀態代表 LINE Bot 偵測到「請立即前往急診回診」等字眼）。
 *   - 依情境動態改寫 Modal 內文字與確認按鈕顏色：
 *     isLook=true  → 標題「確認已看診」、banner/subtitle 文案改為「已看診」相關措辭、
 *                     確認按鈕文字「確認已看診」、背景色改為橘色 (#f59e0b)。
 *     isLook=false → 標題「確認已回診」、banner/subtitle 文案改為「已回診」相關措辭、
 *                     確認按鈕文字「確認已回診」、背景色維持紅色 (#ef4444)。
 *   - 最後呼叫 openModal('modal-confirm-return-visit') 顯示 Modal。
 * 對外影響：僅修改 Modal 內部文字/樣式並顯示 Modal，尚未呼叫任何後端 API
 *   （真正的狀態更新要等使用者在 Modal 中按下確認鈕，觸發 executeClearReturnVisit()）。
 */
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

/**
 * executeClearReturnVisit()
 * 用途：使用者在確認 Modal 中按下「確認已看診/確認已回診」後，真正呼叫後端 API
 *   清除病患的「須看診/須回診」警示狀態，並同步更新前端所有已渲染的相關 UI。
 * 觸發時機：由 chats.html Modal 內確認按鈕的 onclick="executeClearReturnVisit()" 呼叫。
 * 前置判斷：
 *   - mrn = state.currentMrn；若目前沒有選中任何病患則直接 return（防呆，理論上
 *     此函式只會在已選中病患並開啟 Modal 的情況下被觸發）。
 *   - isLook = 按鈕（#btn-clear-return-visit）目前文字是否為 '已看診'，藉此決定
 *     targetStatus 要送 '已看診' 還是 '已回診' 給後端（與 confirmClearReturnVisit()
 *     判斷邏輯一致，確保兩個函式對「目前情境」的理解相同）。
 * 呼叫 API：POST /api/patients/<mrn>/clear_return_visit，body: { status: targetStatus }
 *   → 對應後端 src/admin_server.py 的 clear_return_visit()。
 *   → 後端邏輯備註：雖然此處前端一定會明確帶上 status，但後端本身也支援不帶
 *     status 時依目前狀態自動判斷（須看診→已看診、須回診→已回診），此為後端的
 *     防呆保護，前端仍應明確傳遞以確保與 UI 顯示的按鈕文字一致。
 *   → 回應格式：{ success: true, status: targetStatus } 或 { error: '...' }。
 * 成功後的 UI 同步更新（res.success === true）：
 *   - 關閉確認 Modal，顯示成功 toast（文字依 isLook 顯示「已更新看診狀態」或
 *     「已更新回診狀態」）。
 *   - 更新右欄狀態徽章 (#chat-return-badge) 與清除按鈕 (#btn-clear-return-visit)：
 *     依 targetStatus 改為對應的「已處理」淺色樣式（已看診→淺黃、已回診→淺紅），
 *     並將按鈕設為 disabled（因為警示已清除，該按鈕暫時無事可做，避免重複點擊
 *     再次呼叫 API）。
 *   - 同步更新前端快取：state.allPatients 與 state.allFormPatients（表單分頁共用
 *     的病患陣列快取，屬於 forms.js 使用的資料但共用同一個 state 物件）中對應
 *     mrn 的病患物件的 status 欄位，確保之後排序/切換分頁時資料保持一致，不需要
 *     重新打 API 才能看到最新狀態。
 *   - 若「表單管理」分頁目前正顯示同一位病患（透過 #display-form-return-badge
 *     元素是否存在，且 state.formCurrentMrn === mrn 判斷），也同步更新該分頁上
 *     顯示的狀態徽章樣式，避免使用者切換分頁後看到不一致的舊資料。
 *   - 重新呼叫 sortAndRenderPatients()（本分頁病患列表）與 sortAndRenderFormPatients()
 *     （表單分頁病患列表，定義於 forms.js）以目前選單排序條件重新渲染兩份病患列表，
 *     讓警示徽章的變化立即反映在列表視圖上（例如原本顯示紅色「需回診」的卡片
 *     會變成淺紅「已回診」）。
 * 失敗處理：
 *   - res.success 為 false（後端回錯誤，如狀態不合法）→ 顯示 alert(res.error || '清除失敗')。
 *   - fetch 例外（連線失敗）→ console 記錄並 alert('連線失敗: ...')。
 */
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

/**
 * refreshChatHistory()
 * 用途：讓醫護人員在不切換病患、不重新整理整個網頁的情況下，手動重新拉取「病患
 *   列表」與「目前選中病患的詳情」最新資料，常用於病患剛透過 LINE 傳送新訊息、
 *   希望立即在後台看到最新對話內容的情境。
 * 觸發時機：由 chats.html 的 #btn-refresh-chat 按鈕 onclick="refreshChatHistory()" 呼叫；
 *   該按鈕只在已選中某位病患（loadDetail 成功後）才會顯示。
 * 前置判斷：mrn = state.currentMrn；若未選中病患則直接 return。
 * 載入中視覺回饋：為按鈕內的 svg 圖示加上 'spinning' class（CSS 旋轉動畫），
 *   並將按鈕設為 disabled，避免使用者重複點擊觸發多次重複請求。
 * 呼叫 API（依序兩次）：
 *   1. GET /api/chats → 重新取得完整病患列表（可能有其他病患的狀態也在此期間
 *      改變，例如其他病患也收到新的警示），更新 state.allPatients 後依目前排序
 *      條件重新渲染 #patient-list-body。
 *   2. 呼叫 loadDetail(mrn)（不傳 el，函式內會自動依 mrn 反查對應卡片元素）
 *      → 內部即為 GET /api/chats/<mrn>，重新取得該病患最新的表單與對話 session，
 *        並重新渲染中欄/右欄，等同於重新執行一次「點擊該病患」的完整流程。
 * 完成後：顯示成功 toast「✅ 對話紀錄已更新」。
 * 失敗處理：console 記錄錯誤並顯示失敗 toast「❌ 更新失敗」。
 * finally：無論成功或失敗，都移除 svg 的 'spinning' class 並將按鈕恢復可點擊，
 *   確保 UI 不會卡在載入中的狀態。
 */
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

