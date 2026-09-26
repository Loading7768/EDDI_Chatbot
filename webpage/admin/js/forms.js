// ════════════════════════════════════════════════════════════════════════
// 檔案總覽：forms.js — 出院表單 / 病歷建立與編輯（管理後台「出院單管理」分頁）
// ════════════════════════════════════════════════════════════════════════
//
// 【這個檔案在整體系統中的角色】
//   本檔案是 webpage/admin/html/forms.html 的行為邏輯層，對應後端
//   src/admin_server.py 底下 `/api/forms/*`（以及少量 `/api/chats*`、
//   `/api/doctors`）系列的 REST API。它是整套「急診出院衛教 LINE Bot +
//   醫護後台」中最複雜的一頁：護理站/醫師必須在此頁把「病患是誰」
//   （對應到 LINE 帳號 + 病患本體 + 兩者關係）與「本次看診的症狀清單」
//   兩件事情綁在一起，最終寫成一筆正式病歷（record），LINE Bot 才能依
//   症狀清單推送衛教內容，且醫護人員能在「病患對話紀錄」分頁看到對話。
//
// 【三個主要工作模式（對應 forms.html 左側三個分頁按鈕）】
//   1. 護理師填單（nurse）：
//        負責「建檔」——選擇一個 LINE 帳號，指定這個帳號本次代表哪位
//        病患（帳號本人 / 既有家屬關係 / 新增關係），填入病歷號，
//        呼叫 nurse_create 建立一份「草稿」。此時症狀尚未填寫（空陣列）。
//   2. 醫師填單（doctor）：
//        負責「完成填單」——列出目前登入醫師自己尚未完成的草稿列表，
//        點開草稿後在三欄式症狀選擇器中勾選症狀，呼叫 doctor_submit
//        正式寫入 record 資料表，並刪除該草稿檔。
//   3. 出院單紀錄（view，預設分頁）：
//        負責「查詢與事後修改」——列出所有病患與其歷次出院單紀錄，
//        可檢視細節，或進入編輯模式修改關係／病歷號／症狀清單
//        （症狀任何醫師都能改；病歷號僅管理員可改，且會牽動聊天紀錄
//        資料夾的搬移，詳見 admin_server.py 的實作）。
//
// 【草稿（draft）→ 正式紀錄（record）完整流程圖】
//
//   [LINE 使用者傳送 "Bind" 訊息完成帳號綁定]
//        │  (src/bot.py 會把該 line_account_id 推入 pinned 佇列，
//        │   詳見下方「pinned 置頂佇列」說明)
//        ▼
//   [護理站開啟「護理師填單」分頁]
//        │  呼叫 GET /api/forms/get_line_accounts 取得帳號列表 + pinned 清單
//        │  選擇 LINE 帳號 → 呼叫 GET /api/forms/get_existing_relations
//        │  選擇「帳號本人 / 既有關係 / 新增關係」+ 填病歷號（新增時還需填關係）
//        ▼
//   [呼叫 POST /api/forms/nurse_create]
//        │  後端 upsert patients / line_patient_pairs 資料表，
//        │  寫入草稿 JSON 檔到 drafts/D{doctor_id:07d}/{mrn}_{yyyymmdd}.json，
//        │  並把該 line_account_id 從 pinned 佇列移除（代表「已被護理站處理」）。
//        │  草稿內容：checkout_date, doctor_id, line_patient_pair_id,
//        │            symptoms(此時為空陣列), doctor_name, line_name,
//        │            relation, mrc(病歷號)
//        ▼
//   [醫師開啟「醫師填單」分頁]
//        │  呼叫 GET /api/forms/doctor_drafts 取得「自己」的草稿清單
//        │  點選某張草稿 → 呼叫 GET /api/forms/doctor_draft/<filename>
//        │  取得草稿完整內容，渲染三欄式症狀選擇器（部位/類別 → 衛教項目 → 已選擇）
//        ▼
//   [醫師勾選症狀後按下「傳送出院單」]
//        │  呼叫 POST /api/forms/doctor_submit
//        │  { filename, symptoms, line_patient_pair_id, checkout_date }
//        │  後端將草稿正式寫入 record 資料表，並刪除草稿檔。
//        ▼
//   [完成：此筆看診紀錄出現在「出院單紀錄」分頁的病患就診紀錄列表中]
//        │  之後可透過 PUT /api/forms/<mrn>/<checkout_date>（一般編輯，
//        │  含病歷號 admin-only）或 PUT /api/forms/view_edit（可同時轉移
//        │  LINE 帳號 / 關係 / 病歷號的進階編輯）來修改此筆正式紀錄。
//
//   草稿與正式紀錄的關鍵差異：草稿是「尚未確定症狀、尚未成為正式病歷」
//   的暫存 JSON 檔（存在檔案系統，不在 record 資料表中），目的是讓
//   護理站與醫師分工——護理站先確認病患身分與病歷號、醫師之後才專心
//   勾選症狀——避免同一人要一次填完所有欄位。草稿刪除後即消失，不會
//   留下歷史軌跡；只有 doctor_submit 成功寫入 record 之後才是「正式」、
//   會被病患列表 / 對話紀錄分頁看到的資料。
//
// 【pinned（置頂）LINE 帳號佇列的作用】
//   src/bot.py 維護一個「反向佇列」（最新在最前，最多 10 筆），記錄
//   「最近透過 LINE 傳送 Bind 訊息、剛完成帳號綁定、但尚未被護理站
//   建立任何出院單草稿」的 line_account_id，存放於
//   data/pinned_line_accounts.json。本頁在「LINE 帳號」下拉選單
//   （護理師填單 / 修改表單的 LINE 帳號選擇器）會把這些帳號優先置頂
//   顯示（見 filterNurseLineAccounts / filterVELineAccounts 中的
//   「置頂」分組），方便護理站第一時間注意到「有新病患剛綁定 LINE、
//   還沒建檔」。一旦 nurse_create 成功建立草稿，該帳號就會自動從
//   pinned 佇列移除，不會再出現在置頂區。
//
// 【核心資料模型速查（詳細定義見後端 src/admin_server.py / models）】
//   - line_accounts：LINE 使用者帳號（uuid + name），可能是病患本人或家屬。
//   - patients：病患本體，主鍵是 medical_record_number（病歷號 / mrn）。
//   - line_patient_pairs：LINE 帳號 ↔ 病患的「關係」配對（一個 LINE 帳號
//     可對應多個病患，relation 欄位存文字關係，例如「帳號本人」「子女」）。
//   - record：每次出院/看診的正式紀錄，含 checkout_date（看診時間）、
//     doctor_id（看診醫師）、symptoms（JSON 陣列，症狀中文名稱列表）。
//
// 【pair_id 三種模式（貫穿本檔案多個表單：nurse-form、view-edit）】
//   選擇病患時，UI 用同一組下拉選單處理三種情境（對應後端 nurse_create /
//   view_edit 的 pair_id 參數）：
//     - 'self'：這個 LINE 帳號本人就是病患。relation 固定為「帳號本人」，
//               只需再補病歷號（若該帳號尚未有「帳號本人」關係）。
//     - 'new'：要幫這個 LINE 帳號新增一個全新的關係配對（例如家屬第一次
//              用同一個 LINE 帳號登記另一位家人），需要同時填「關係」
//              文字與「病歷號」。
//     - <既有整數 pair_id>：直接沿用 get_existing_relations 回傳的既有
//              配對（該 LINE 帳號先前已經建立過的關係），此時不需要再
//              輸入任何文字欄位，因為關係與病歷號都已經存在資料庫中。
//
// 【DOM 結構速覽（詳見 forms.html 對應區塊的註解）】
//   - #forms-layout：三欄式版面容器，data-state 屬性切換 view/nurse/doctor。
//   - #nurse-form-panel：護理師填單表單（LINE 下拉 + 病患下拉 + 草稿欄位）。
//   - #doctor-form-panel：醫師填單表單（草稿 meta 資訊 + 三欄症狀選擇器）。
//   - #form-view-container / #form-edit-container：出院單紀錄分頁的
//     「唯讀檢視」與「編輯模式」兩種畫面，共用同一批 meta-box 樣式。
//
// ════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────
// 區塊：分頁狀態管理（forms state management）
// 負責在「護理師填單 / 醫師填單 / 出院單紀錄」三個工作模式之間切換，
// 透過 #forms-layout 的 data-state 屬性驅動 CSS 顯示/隱藏對應區塊。
// ──────────────────────────────────────────────────────────────────────

// setFormsState(stateName)
// 用途：切換整個「出院單管理」分頁目前所在的工作模式。
// 觸發時機：使用者點擊左側三個模式按鈕（#btn-state-nurse / -doctor / -view，
//           見 forms.html 的 onclick="setFormsState('nurse'|'doctor'|'view')"）。
// 參數：stateName - 'view'（查看/修改出院單紀錄，預設）、'nurse'（護理師填單）、
//                    'doctor'（醫師填單）三者之一。
// 對外部影響：
//   1. 若目前正處於「查看紀錄」分頁的編輯模式（state.viewEditMode），
//      切換模式前先強制退出編輯模式，避免殘留未儲存的編輯狀態。
//   2. 修改 #forms-layout 的 data-state 屬性，CSS 依此屬性決定哪一欄
//      （Column 1 主列表）要顯示對應內容。
//   3. 切換左側按鈕與內容區塊的 .active class（純視覺高亮，非資料操作）。
//   4. 進入 nurse 模式時呼叫 loadNurseLineAccounts() 重新載入 LINE 帳號
//      下拉選單資料；進入 doctor 模式時呼叫 loadDoctorDrafts() 重新載入
//      「自己」尚未完成的草稿列表。這兩個呼叫確保每次切回該分頁時資料
//      都是最新的（例如剛才在別的分頁建立了新草稿）。
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

// ── Export globals if needed ──
// window.someFunc = someFunc;

// window.resetFormsWorkspace()
// 用途：把整個「出院單管理」分頁重置回初始（乾淨）狀態，通常在切換病患
//       分頁（例如從「病患對話紀錄」分頁切換過來）或登出/切換帳號時，
//       由外部（其他 JS 檔，如 chat.js 或 main.js）呼叫，避免殘留上一次
//       選擇的病患、草稿、編輯模式等狀態互相干擾。
// 觸發時機：由外部模組主動呼叫（掛在 window 上，代表這是跨檔案共用的
//           公開 API，而非僅供本檔案內部使用）。
// 對外部影響：
//   1. 清空 state 中與目前選取病患/紀錄相關的欄位
//      （currentMrn、formCurrentMrn、currentSelectedRecord、viewEditMode）。
//   2. 強制切回 'view' 模式（setFormsState('view')）。
//   3. 移除所有病患/就診項目的 .active 高亮樣式。
//   4. 清空 Column 2（就診紀錄）列表，改顯示「請先選擇病患」提示。
//   5. 呼叫 exitViewEditMode() 確保不會卡在編輯模式。
//   6. 隱藏 Column 3 的表單檢視容器與編輯按鈕，改顯示空狀態提示。
//   7. 重置護理師表單（resetNursePatientDropdown）與醫師表單
//      （resetDoctorFormPanel），並清空對應的 DOM 列表與計數 badge。
window.resetFormsWorkspace = function() {
  state.currentMrn = null;
  state.formCurrentMrn = null;
  state.currentSelectedRecord = null;
  state.viewEditMode = false;
  
  // 1. Reset state to view mode
  if (typeof setFormsState === 'function') {
    setFormsState('view');
  }

  // 2. Clear Active Patients & Visit List
  document.querySelectorAll('.patient-item.active, .nurse-patient-item.active, .visit-item.active').forEach(el => el.classList.remove('active'));
  // const patientListBody = document.getElementById('form-patient-list-body');
  // if (patientListBody) patientListBody.innerHTML = '';

  const visitListBody = document.getElementById('form-visit-list-body');
  if (visitListBody) visitListBody.innerHTML = '<div class="empty-state" style="padding:32px 0;"><div class="empty-icon">📋</div><p>請先選擇病患</p></div>';
  
  // 3. Reset Edit State
  exitViewEditMode();
  
  // 4. Hide Detail, Show Placeholder
  const formViewContainer = document.getElementById('form-view-container');
  if (formViewContainer) formViewContainer.style.display = 'none';
  
  const formEditEmpty = document.getElementById('form-edit-empty');
  if (formEditEmpty) formEditEmpty.style.display = 'flex';
  
  const editBtn = document.getElementById('btn-view-edit');
  if (editBtn) editBtn.style.display = 'none';
  
  // 4. Reset Nurse / Doctor forms
  resetNursePatientDropdown();
  const nurseList = document.getElementById('nurse-patient-list');
  if (nurseList) nurseList.innerHTML = '';

  resetDoctorFormPanel();
  const docList = document.getElementById('doctor-draft-list');
  if (docList) docList.innerHTML = '';
  
  const docBadge = document.getElementById('doctor-draft-badge');
  if (docBadge) docBadge.style.display = 'none';
  const docHeaderCount = document.getElementById('doctor-draft-header-count');
  if (docHeaderCount) docHeaderCount.textContent = '0';
  
  const formPatientCount = document.getElementById('form-patient-count');
  if (formPatientCount) formPatientCount.textContent = '0';
  const formVisitCount = document.getElementById('form-visit-count');
  if (formVisitCount) formVisitCount.textContent = '0';
};

// ──────────────────────────────────────────────────────────────────────
// 區塊：醫師填單（doctor form）
// 對應「醫師填單」分頁：列出目前登入醫師「自己」尚未完成的出院單草稿，
// 點選草稿後在三欄式選單勾選症狀，最後正式傳送成為 record。
// 這裡的症狀分類資料（部位/類別 → 底下的衛教項目）與「查看/修改表單」
// 分頁的編輯模式共用同一份 state.dischargeCategories 快取。
// ──────────────────────────────────────────────────────────────────────

// loadDischargeCategories()
// 用途：載入並快取「症狀分類 → 衛教項目」的靜態對照表，供三欄式症狀
//       選擇器（部位/類別欄、衛教項目欄）渲染使用。
// 觸發時機：
//   - 進入醫師填單分頁載入草稿列表前（loadDoctorDrafts 內呼叫）。
//   - 進入「查看/修改表單」的編輯模式前（enterViewEditMode 內呼叫）。
// 呼叫的資源：GET /assets/discharge/category.json
//   這不是後端 admin_server 的 API，而是前端靜態資源（放在
//   webpage/assets/discharge/ 底下的 JSON 檔），格式為
//   { "類別名稱": { "衛教項目名稱": ... }, ... }（本檔案只用到 key，
//   不使用 value 的內容，value 可能是額外的衛教說明文字）。
// 快取邏輯：若 state.dischargeCategories 已存在（非 falsy）就直接
//   return，避免每次切換分頁都重新打一次網路請求；失敗時退化為空物件
//   {}，讓後續渲染函式不至於整頁報錯（症狀分類會顯示為空列表）。
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

// loadDoctorDrafts()
// 用途：載入目前登入醫師自己尚未完成的出院單草稿列表，渲染到
//       #doctor-draft-list（醫師填單分頁的 Column 1 列表），並更新
//       左側按鈕上的未完成數量 badge（#doctor-draft-badge）與標題旁的
//       計數（#doctor-draft-header-count）。
// 觸發時機：
//   - setFormsState('doctor') 切換到醫師填單分頁時。
//   - saveNurseForm() 成功建立草稿後（讓醫師分頁的角標立刻反映新草稿）。
//   - doDeleteDoctorDraft() / doSaveDoctorForm() 完成後重新整理列表。
//   - loadFormsPatientList() 內也會呼叫（讓「出院單紀錄」分頁載入時，
//     醫師填單按鈕上的角標數字同步更新，因為兩個分頁共用同一個
//     doctor_drafts API）。
// 對應 API：GET /api/forms/doctor_drafts
//   Request：無 body，依登入 session 判斷目前是哪位醫師。
//   Response：{ drafts: [ { filename, mrn, date }, ... ] }
//             （後端依檔名反向排序，最新的草稿排最前面）。
// 資料流程與渲染：
//   1. 先呼叫 loadDischargeCategories() 確保症狀分類已就緒（因為使用者
//      點開草稿後馬上就要渲染症狀選單，先預載可避免點擊時的延遲）。
//   2. 依 drafts.length 更新 badge 顯示/隱藏與數字。
//   3. 若草稿為空，顯示「無未完成出院單」空狀態，並呼叫
//      resetDoctorFormPanel() 清空右側表單面板。
//   4. 否則逐筆建立 .patient-item 元素，顯示病歷號（d.mrn）與就診日期
//      （d.date），點擊時呼叫 selectDoctorDraft(filename, mrn, 該元素)。
//      若該草稿正是目前已選取的草稿（state.selectedDoctorDraft），
//      會保留 .active 高亮，避免重新整理列表後失去選取狀態的視覺回饋。
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

// selectDoctorDraft(filename, mrn, targetEl)
// 用途：使用者在草稿列表中點選某一筆草稿，載入該草稿完整內容並渲染到
//       右側的醫師填單表單面板（#doctor-form-panel），準備讓醫師勾選症狀。
// 觸發時機：loadDoctorDrafts() 產生的每個 .patient-item 的 onclick。
// 參數：
//   - filename：草稿檔名（格式為 D{doctor_id:07d}/{mrn}_{yyyymmdd}.json
//               的相對路徑，用於後續 GET/DELETE/doctor_submit 呼叫）。
//   - mrn：病歷號（僅在載入失敗時的 fallback 顯示用，主要資料以 API
//          回傳的 data.mrc 為準）。
//   - targetEl：被點擊的 DOM 元素，用來套用 .active 高亮樣式。
// 對應 API：GET /api/forms/doctor_draft/<filename>
//   Response：{ success: true, data: {...草稿完整內容...}, filename }
//   data 內容包含：checkout_date, doctor_id, doctor_name, line_name,
//                  relation, mrc（病歷號）, symptoms（初始通常為空陣列）,
//                  line_patient_pair_id。
// 資料流程與渲染：
//   1. 先將列表中所有項目移除 .active，再為 targetEl 加上 .active
//      （視覺上標示目前選取的是哪一筆草稿）。
//   2. 呼叫 API 取得草稿資料；若 res.success 為 false 或 data 缺失，
//      顯示 toast 錯誤提示「❌ 載入草稿內容失敗」並中止。
//   3. 成功後把 { filename, data } 存進 state.selectedDoctorDraft，
//      並把 data.symptoms 複製一份到 state.selectedSymptoms（用陣列
//      淺拷貝 [...data.symptoms] 避免直接引用同一個陣列，讓後續勾選
//      操作不會意外污染原始草稿資料）——這個 state.selectedSymptoms
//      就是整個症狀勾選 UI（三欄式選單）的「單一真相來源」。
//   4. 更新表單標題/副標題文字，並顯示動作按鈕（刪除、傳送）。
//   5. 隱藏「請選擇未完成出院單」的預設 placeholder，改顯示實際內容區。
//   6. 把草稿的 meta 資訊（就診日期、負責醫師、LINE 帳號名稱、關係、
//      病歷號）填入 #doctor-meta-* 系列 DOM 元素（這些欄位皆為唯讀展示，
//      因為草稿的身分資訊已由護理站在 nurse_create 階段確定，醫師這階段
//      只需要負責症狀）。
//   7. 呼叫 renderSymptomMainCol() 渲染症狀分類欄，renderSymptomChips()
//      渲染目前已選症狀的標籤列（初次載入通常為空）。
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

// resetDoctorFormPanel()
// 用途：清空醫師填單表單面板的所有選取狀態，回復到「請選擇未完成出院單」
//       的初始畫面。
// 觸發時機：
//   - loadDoctorDrafts() 發現草稿列表為空時。
//   - doDeleteDoctorDraft() 成功刪除草稿後。
//   - window.resetFormsWorkspace() 整頁重置時。
// 對外部影響：
//   1. 清除 state.selectedDoctorDraft（刪除該屬性）、
//      state.selectedSymptoms（重設為空陣列）、
//      state.activeCategory（重設為 null，代表症狀分類欄目前無展開項）。
//   2. 還原表單標題/副標題文字為預設提示，隱藏動作按鈕（刪除/傳送）。
//   3. 顯示 placeholder、隱藏內容區。
//   4. 移除草稿列表中所有 .active 高亮。
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

// ── 三欄式症狀選擇器（醫師填單版）────────────────────────────────
// 這三個函式（renderSymptomMainCol / renderSymptomSubCol / renderSymptomChips）
// 共同組成 #symptom-selection-container 內的三欄式互動元件：
//   欄1「部位/類別」(#symptom-main-list) → 點擊展開 →
//   欄2「衛教項目」(#symptom-sub-list，屬於該類別下的細項) → 點擊勾選/取消 →
//   欄3「已選擇項目」(#symptom-chips-container，顯示所有已選症狀的標籤，
//        不分類別地平鋪展示，可直接點擊標籤移除)。
// 症狀資料來源：state.dischargeCategories（由 loadDischargeCategories 載入
// 的靜態分類表），目前選取結果存在 state.selectedSymptoms（字串陣列，
// 每個字串是症狀的中文名稱，最終會原樣送進 doctor_submit 的 symptoms 欄位，
// 對應後端 record.symptoms 這個 JSON 陣列欄位）。

// renderSymptomMainCol()
// 用途：渲染「部位/類別」欄，列出 state.dischargeCategories 的所有 key。
// 觸發時機：selectDoctorDraft() 載入草稿後呼叫一次；使用者切換類別時
//           不會重新呼叫這個函式（只會呼叫 renderSymptomSubCol）。
// 邏輯細節：
//   - 若某類別底下沒有任何衛教項目（isEmpty 判斷：value 不存在、非物件、
//     或物件無 key），該類別項目加上 .disabled class 且不綁定 onclick，
//     避免使用者點擊一個「其實沒有內容」的分類卻沒有任何反應而困惑。
//   - 點擊類別項目時採用「手風琴」邏輯：若點擊的是目前已展開的類別，
//     則收合（清除 state.activeCategory、隱藏欄2）；否則先清除其他項目
//     的 .active，將自己標記為 active，記錄到 state.activeCategory，
//     並呼叫 renderSymptomSubCol(key) 展開該類別的細項到欄2。
//   - 結尾呼叫 validateDoctorSave() 重新檢查「傳送出院單」按鈕是否可用
//     （目前規則：至少需選 1 項症狀）。
function renderSymptomMainCol() {
  const mainList = document.getElementById('symptom-main-list');
  const subCol = document.getElementById('symptom-sub-col');
  if (!mainList) return;

  mainList.innerHTML = '';
  if (subCol) subCol.style.display = 'none';

  const categories = state.dischargeCategories || {};
  Object.keys(categories).forEach(key => {
    const subItems = categories[key];
    const isEmpty = !subItems || typeof subItems !== 'object' || Object.keys(subItems).length === 0;

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

  validateDoctorSave();
}

// renderSymptomSubCol(categoryKey)
// 用途：渲染欄2「衛教項目」，列出 state.dischargeCategories[categoryKey]
//       底下的所有症狀名稱，並標示哪些已被選取。
// 觸發時機：renderSymptomMainCol() 中類別被展開時；或使用者在欄2內
//           勾選/取消某個症狀後，重新渲染自己以更新勾選狀態的視覺樣式。
// 邏輯細節：
//   - isSelected 判斷該症狀是否已存在 state.selectedSymptoms 陣列中；
//     若是，項目加上 .active class 並在文字前面加上 ✓ 圖示。
//   - 點擊項目時：若尚未選取則 push 進 state.selectedSymptoms；若已選取
//     則用 filter 移除（也就是「點擊即切換」的 toggle 邏輯，而非額外的
//     勾選框輸入元件）。切換後同時重新渲染自己（更新勾選樣式）與
//     renderSymptomChips()（同步更新欄3的已選標籤列）。
//   - 若該類別底下沒有任何症狀項目（symptomNames.length === 0），
//     顯示「（此類別無衛教項目）」提示並提早 return（理論上不會發生，
//     因為 renderSymptomMainCol 已經把空類別標記為 disabled 不可點擊，
//     這裡是防禦性程式碼）。
//   - 結尾呼叫 validateDoctorSave() 重新檢查傳送按鈕可用性。
function renderSymptomSubCol(categoryKey) {
  const subCol = document.getElementById('symptom-sub-col');
  const subHeader = document.getElementById('symptom-sub-header');
  const subList = document.getElementById('symptom-sub-list');
  if (!subCol || !subList) return;

  subCol.style.display = 'flex';
  if (subHeader) subHeader.textContent = categoryKey;
  subList.innerHTML = '';

  const items = state.dischargeCategories[categoryKey] || {};
  const symptomNames = Object.keys(items);
  if (symptomNames.length === 0) {
    subList.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px;text-align:center;">（此類別無衛教項目）</div>';
    return;
  }

  symptomNames.forEach(symptomName => {
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
  validateDoctorSave();
}

// renderSymptomChips()
// 用途：渲染欄3「已選擇項目」，把 state.selectedSymptoms 陣列中所有
//       症狀名稱以「標籤（chip）」形式平鋪展示，不論它們屬於哪個類別。
//       這欄的作用是讓醫師一眼看到「目前總共選了哪些症狀」，不需要
//       逐一展開每個類別去確認。
// 觸發時機：selectDoctorDraft() 初次載入草稿後；renderSymptomSubCol()
//           內每次勾選/取消症狀後；本函式內每個 chip 的 onclick 移除
//           症狀後也會重新呼叫自己。
// 邏輯細節：
//   - 若目前無任何已選症狀，直接隱藏整個欄3（display:none）並清空內容，
//     避免顯示一個空的欄位造成版面混亂。
//   - 每個 chip 顯示 ❌ 圖示 + 症狀名稱，點擊 chip 即代表「取消勾選該症狀」：
//     從 state.selectedSymptoms 中 filter 移除該症狀，若目前欄2正展開某
//     類別（state.activeCategory 有值），重新渲染該類別的欄2以同步移除
//     勾選樣式，最後重新渲染自己（欄3）以移除該標籤。
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

// validateDoctorSave()
// 用途：檢查「傳送出院單」按鈕（#btn-doctor-save）是否應該可點擊。
// 觸發時機：每次症狀選取狀態改變後（renderSymptomMainCol / renderSymptomSubCol
//           結尾都會呼叫）。
// 規則：目前唯一條件是「至少選擇 1 項症狀」（symptoms.length < 1 則停用），
//       因為 record.symptoms 若為空陣列，LINE Bot 就沒有任何衛教內容可推播。
function validateDoctorSave() {
  const saveBtn = document.getElementById('btn-doctor-save');
  if (!saveBtn) return;
  const symptoms = state.selectedSymptoms || [];
  saveBtn.disabled = symptoms.length < 1;
}

// deleteDoctorDraft()
// 用途：點擊「🗑 刪除」按鈕時，先跳出確認 Modal（#modal-confirm-delete-draft），
//       不直接刪除，避免醫師誤觸而遺失草稿。
// 觸發時機：#btn-doctor-delete 的 onclick。
// 對外部影響：僅開啟 Modal；真正的刪除動作交給使用者在 Modal 中按下
//             「確定刪除」後觸發的 doDeleteDoctorDraft()。
function deleteDoctorDraft() {
  if (!state.selectedDoctorDraft) return;
  openModal('modal-confirm-delete-draft');
}

// doDeleteDoctorDraft()
// 用途：使用者在確認 Modal 中按下「確定刪除」後，真正呼叫後端刪除草稿檔。
// 觸發時機：#modal-confirm-delete-draft 內「確定刪除」按鈕的 onclick。
// 對應 API：DELETE /api/forms/doctor_draft/<filename>
//   Request：filename 取自 state.selectedDoctorDraft.filename（URL 編碼）。
//   Response：{ success: true/false, error? }。
// 資料流程：
//   1. 先關閉 Modal。
//   2. 呼叫 DELETE API；成功則顯示成功 toast，呼叫 resetDoctorFormPanel()
//      清空右側表單，並呼叫 loadDoctorDrafts() 重新載入草稿列表
//      （此草稿已從清單中消失）。
//   3. 失敗則顯示帶錯誤訊息的失敗 toast（res.error 或「未知錯誤」）。
//   4. 若整個請求拋出例外（例如網路錯誤），同樣顯示失敗 toast。
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

// saveDoctorForm()
// 用途：點擊「💾 傳送出院單」按鈕時，先在確認 Modal
//       （#modal-confirm-save-draft）中預覽目前已選的症狀清單，
//       讓醫師在正式送出前再次確認，再決定是否繼續。
// 觸發時機：#btn-doctor-save 的 onclick。
// 對外部影響：
//   - 把 state.selectedSymptoms 渲染成一排唯讀（readonly）的
//     symptom-chip，塞進 #modal-save-chips-container；若目前沒有任何
//     已選症狀，顯示「（未選擇任何衛教項目）」提示（理論上不會出現，
//     因為 validateDoctorSave 已限制按鈕在無症狀時停用，此為防禦性顯示）。
//   - 開啟確認 Modal，不會直接呼叫後端 API；實際送出動作交由 Modal 中
//     「確認傳送」按鈕觸發的 doSaveDoctorForm()。
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

// doSaveDoctorForm()
// 用途：使用者在確認 Modal 中按下「確認傳送」後，真正把草稿正式送出，
//       成為 record 資料表中的一筆正式看診紀錄。這是草稿流程的終點。
// 觸發時機：#modal-confirm-save-draft 內 #btn-modal-confirm-save 的 onclick。
// 對應 API：POST /api/forms/doctor_submit
//   Request body：
//     {
//       filename: 草稿檔名（state.selectedDoctorDraft.filename）,
//       line_patient_pair_id: 草稿中記錄的 LINE 帳號↔病患配對 ID
//                              （state.selectedDoctorDraft.data.line_patient_pair_id）,
//       checkout_date: 草稿中記錄的看診日期時間（唯讀，不可由醫師修改）,
//       symptoms: 醫師目前勾選的症狀陣列（state.selectedSymptoms）
//     }
//   （雖然後端在沒帶 line_patient_pair_id / checkout_date 時會自動從草稿檔
//    讀取，這裡仍主動帶上，是為了讓前端呼叫更明確、也避免依賴後端的
//    fallback 行為。）
//   Response：{ success: true/false, error? }
// 資料流程：
//   1. 先關閉確認 Modal，並將傳送按鈕暫時停用（避免重複點擊造成重複送出）。
//   2. 呼叫 API；成功則顯示成功 toast，呼叫 resetDoctorFormPanel() 清空
//      右側表單、loadDoctorDrafts() 重新載入草稿列表（該草稿已被刪除，
//      不會再出現）、loadFormsPatientList() 重新整理「出院單紀錄」分頁的
//      病患列表（因為剛剛新增了一筆正式紀錄，可能是全新病患，也可能是
//      既有病患多了一筆就診紀錄）。
//   3. 失敗則顯示帶錯誤訊息的失敗 toast，並將按鈕重新啟用讓醫師可以
//      再次嘗試（例如可能是網路暫時性錯誤）。
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
    }
  } catch (e) {
    console.error('doSaveDoctorForm error', e);
    showToast('❌ 傳送失敗，請稍後再試', 'fail');
  }

  if (saveBtn) saveBtn.disabled = false;
}



// ──────────────────────────────────────────────────────────────────────
// 區塊：護理師填單（nurse form）
// 對應「護理師填單」分頁：選擇 LINE 帳號 → 選擇/新增病患關係 → 填病歷號
// → 呼叫 nurse_create 建立草稿。這是整個草稿流程的起點。
// 這裡的「LINE 帳號下拉選單」與「病患關係下拉選單」都是自製的
// custom dropdown（非原生 <select>），因為需要支援搜尋框、置頂分組、
// 自訂項目排版（關係文字 + 病歷號並排顯示）等原生下拉選單做不到的效果。
// ──────────────────────────────────────────────────────────────────────

// loadNurseLineAccounts()
// 用途：初始化/重新載入護理師填單表單的 LINE 帳號下拉選單資料。
// 觸發時機：setFormsState('nurse') 切換到護理師填單分頁時。
// 對應 API：GET /api/forms/get_line_accounts
//   Response：{ accounts: [{id, name}, ...], pinned: [line_account_id, ...],
//               pinned_ids: [...] }（pinned 與 pinned_ids 為相容性欄位，
//               程式碼會優先讀 pinned，若不存在才 fallback 讀 pinned_ids）。
// 資料流程與渲染：
//   1. 先重置按鈕文字為「請選擇 LINE 帳號」、清空搜尋框、清除面板上
//      記錄的 dataset.lineAccountId（代表尚未選擇任何帳號）。
//   2. 呼叫 resetNursePatientDropdown() 連動清空下一層的病患下拉選單
//      （因為換一批 LINE 帳號資料後，先前選的病患關係已不再有效）。
//   3. 呼叫 API 取得帳號列表與 pinned 清單，分別存入
//      state.nurseLineAccounts 與 state.nursePinnedLineIds。
//   4. 呼叫 filterNurseLineAccounts('') 以空字串（代表無篩選）渲染完整
//      列表（含置頂分組）到 #nurse-line-items-container。
//   5. 失敗時在容器內顯示紅字「載入失敗」提示。
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
    state.nursePinnedLineIds = (res && Array.isArray(res.pinned)) ? res.pinned : (res && Array.isArray(res.pinned_ids) ? res.pinned_ids : []);
    filterNurseLineAccounts('');
  } catch (e) {
    console.error('loadNurseLineAccounts error', e);
    const container = document.getElementById('nurse-line-items-container');
    if (container) container.innerHTML = '<div style="padding:14px;color:var(--danger);font-size:13px;text-align:center;">載入失敗</div>';
  }
}

// toggleNurseLineDropdown()
// 用途：開啟/關閉「LINE 帳號」自製下拉選單（#nurse-line-dd）。
// 觸發時機：#nurse-line-btn 的 onclick。
// 邏輯細節：
//   - 開啟前先關閉「病患」下拉選單（#nurse-patient-dd），確保畫面上
//     同時只有一個下拉選單展開，避免版面重疊混亂。
//   - 若切換後是「開啟」狀態：自動 focus 搜尋框方便直接輸入關鍵字；
//     同時「靜默地」重新呼叫 GET /api/forms/get_line_accounts 刷新
//     帳號與 pinned 清單（不顯示 loading 也不阻塞 UI），目的是讓「剛剛
//     在其他分頁/其他護理站電腦新綁定的 LINE 帳號」能在下拉選單打開的
//     瞬間就反映最新的置頂清單，不需要使用者手動重新整理整頁。
//     這個刷新失敗時直接吞掉錯誤（.catch(() => {})），因為這只是背景
//     的「盡力更新」，不應該用錯誤 toast 打斷使用者正在操作的下拉選單。
function toggleNurseLineDropdown() {
  const dd = document.getElementById('nurse-line-dd');
  const pDd = document.getElementById('nurse-patient-dd');
  if (pDd) pDd.classList.remove('open');
  if (dd) {
    const isOpen = dd.classList.toggle('open');
    if (isOpen) {
      const searchInput = document.getElementById('nurse-line-search');
      if (searchInput) searchInput.focus();
      // Silently refresh accounts so latest pinned items appear immediately
      api('GET', '/api/forms/get_line_accounts').then(res => {
        if (res && Array.isArray(res.accounts)) {
          state.nurseLineAccounts = res.accounts;
          state.nursePinnedLineIds = Array.isArray(res.pinned) ? res.pinned : (Array.isArray(res.pinned_ids) ? res.pinned_ids : []);
          filterNurseLineAccounts(searchInput ? searchInput.value : '');
        }
      }).catch(() => {});
    }
  }
}

// filterNurseLineAccounts(query)
// 用途：依搜尋框輸入的關鍵字，過濾並渲染 LINE 帳號下拉選單的項目列表。
//       同時也負責在「無搜尋字串」時渲染「置頂」分組。
// 觸發時機：
//   - loadNurseLineAccounts() 載入完資料後以空字串呼叫（顯示全部+置頂）。
//   - #nurse-line-search 搜尋框的 oninput 事件（即時篩選）。
//   - toggleNurseLineDropdown() 開啟下拉選單時背景刷新後重新呼叫。
// 邏輯細節：
//   - 有輸入關鍵字（query 非空）：對 state.nurseLineAccounts 依帳號
//     name（忽略大小寫）做 includes 篩選，並在搜尋框下方顯示「N 項結果」
//     的提示文字（#nurse-line-search-sub）；若篩選結果為空，顯示
//     「找不到相似帳號名稱」。此模式下不顯示置頂分組（因為使用者已經
//     在主動搜尋特定帳號，置頂與否已不重要）。
//   - 無關鍵字（query 為空字串，代表剛開啟或清空搜尋框）：
//       1. 隱藏搜尋結果提示文字。
//       2. 從 state.nursePinnedLineIds 找出對應的帳號物件
//          （pinnedAccounts），若有任何置頂帳號，先渲染一個「置頂」
//          分組標題，接著渲染這些置頂帳號項目，再渲染一個「所有帳號」
//          分組標題，作為視覺分隔。
//       3. 最後再渲染 state.nurseLineAccounts 的完整列表（不論是否已在
//          置頂分組出現過，這裡刻意重複渲染，讓「所有帳號」區塊維持
//          完整的全帳號清單，方便使用者用捲動方式找到任何帳號，
//          而不必依賴置頂機制）。
// 每個項目透過 buildNurseLineItem() 產生對應 DOM 節點。
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

    // Show pinned group if exists
    const pinnedIds = state.nursePinnedLineIds || [];
    const pinnedAccounts = pinnedIds.map(id => all.find(a => Number(a.id) === Number(id))).filter(Boolean);

    if (pinnedAccounts.length > 0) {
      const pHeader = document.createElement('div');
      pHeader.className = 'nurse-dd-header';
      pHeader.textContent = '置頂';
      container.appendChild(pHeader);

      pinnedAccounts.forEach(a => container.appendChild(buildNurseLineItem(a)));

      const aHeader = document.createElement('div');
      aHeader.className = 'nurse-dd-header';
      aHeader.textContent = '所有帳號';
      container.appendChild(aHeader);
    }

    all.forEach(a => container.appendChild(buildNurseLineItem(a)));
  }
}

// buildNurseLineItem(account)
// 用途：建立單一 LINE 帳號在下拉選單中的可點擊項目 DOM 節點。
// 參數：account - { id, name }。
// 對外部影響：點擊該項目會呼叫 selectNurseLineAccount(id, name) 進行選取；
//             item.dataset.accountId 用於之後高亮比對「哪個項目目前被選中」。
function buildNurseLineItem(account) {
  const item = document.createElement('div');
  item.className = 'nurse-patient-item';
  item.dataset.accountId = account.id;
  item.textContent = account.name;

  item.onclick = () => selectNurseLineAccount(account.id, account.name);
  return item;
}

// selectNurseLineAccount(id, name)
// 用途：使用者從下拉選單中選定某個 LINE 帳號後的處理。
// 觸發時機：buildNurseLineItem() 產生項目的 onclick。
// 對外部影響：
//   1. 關閉下拉選單、更新按鈕顯示文字為選中的帳號名稱。
//   2. 把選中的帳號 id 記錄到 #nurse-form-panel 的 dataset.lineAccountId
//      （這個 dataset 是整份護理師表單「目前選了哪個 LINE 帳號」的
//      唯一真相來源，後續 validateNurseForm() / saveNurseForm() 都會
//      讀取它）。
//   3. 更新列表中項目的 .selected 樣式（比對 dataset.accountId 字串）。
//   4. 呼叫 onNurseLineChange(id) 觸發「病患」下拉選單的載入
//      （因為選了不同的 LINE 帳號，該帳號底下已存在的病患關係也不同）。
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

// resetNursePatientDropdown()
// 用途：清空「病患」下拉選單與其相關的草稿輸入欄位，回到未選擇狀態。
// 觸發時機：
//   - loadNurseLineAccounts() 初始化表單時。
//   - onNurseLineChange() 換了新的 LINE 帳號時，先清空舊的病患選擇
//     再重新載入新帳號對應的關係列表。
//   - window.resetFormsWorkspace() 整頁重置時。
// 對外部影響：
//   1. 隱藏病患選擇群組（#nurse-fp-patient-group）、停用病患下拉按鈕、
//      清空按鈕文字與選項列表、關閉下拉選單的展開狀態。
//   2. 清除 #nurse-form-panel 上記錄的 dataset.selPairId /
//      selRelation / selMrn（這三個 dataset 是「目前選擇的病患關係」
//      的真相來源，供 validateNurseForm() / saveNurseForm() 讀取）。
//   3. 隱藏並清空所有「草稿文字輸入欄」（self 病歷號 / new 關係 /
//      new 病歷號），並移除輸入框的 .invalid 錯誤樣式。
//   4. 呼叫 validateNurseForm() 重新檢查儲存按鈕是否應該停用
//      （此時必然是停用，因為尚未選擇任何病患）。
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

// onNurseLineChange(lineAccountId)
// 用途：選定 LINE 帳號後，載入該帳號「已存在的病患關係」列表，組成
//       「病患」下拉選單的選項，並自動預選第一個合理的選項。
// 觸發時機：selectNurseLineAccount() 選定帳號後呼叫。
// 對應 API：GET /api/forms/get_existing_relations?line_account_id=<id>
//   Response：[ {pair_id, relation, mrn}, ... ]（該 LINE 帳號目前已存在
//              資料庫中的所有「關係配對」，例如「帳號本人」「子女」等）。
// 資料流程與渲染：
//   1. 先清空並重新啟用病患下拉選單（resetNursePatientDropdown +
//      顯示 #nurse-fp-patient-group）。
//   2. 呼叫 API 取得關係列表。
//   3. 【特殊規則】若回傳結果中沒有 relation === '帳號本人' 的項目
//      （代表這個 LINE 帳號從未被登記為某位病患本人），則手動在列表
//      最前面插入一個虛擬項目 { pair_id: 'self', relation: '帳號本人',
//      mrn: '???' }，讓護理站永遠有機會把「這支 LINE 就是病患本人」
//      設為選項，即使資料庫裡還沒有這筆配對（實際建立要等
//      saveNurseForm 呼叫 nurse_create 時，用 pair_id='self' 告知後端）。
//   4. 若 API 回傳的關係陣列非空，依規則排序：「帳號本人」永遠排最前，
//      其餘依 relation 文字做本地化排序（localeCompare），逐一用
//      buildPatientItem() 建立選項並加入列表。
//   5. 列表最後永遠加上一個「＋ 新增」項目，點擊會呼叫
//      onNursePatientChange('new')，代表「幫這個 LINE 帳號新增一個
//      全新的關係配對」（例如家屬要新增另一位家人）。
//   6. 自動預選：若存在 firstItem（不論是資料庫既有的第一筆，或前面
//      補上的虛擬「帳號本人」項目），直接呼叫
//      onNursePatientChange(firstItem.pair_id, ...) 自動選中它，
//      省去護理站多一次點擊；否則（理論上不會發生，因為 firstItem
//      至少會是虛擬的帳號本人項目）才 fallback 到選中「新增」。
//   7. 失敗時在列表內顯示紅字「載入失敗」。
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

// buildPatientItem(r)
// 用途：建立「病患」下拉選單中單一「既有關係配對」項目的 DOM 節點
//       （護理師填單版；「查看/修改表單」的編輯模式有對應的
//       buildVEPatientItem，邏輯相同但作用在不同的 DOM 容器）。
// 參數：r - { pair_id, relation, mrn }。
// 顯示排版：relation 文字置左、mrn 置右（中間用 spacer 撐開），
//           若 mrn 為空則顯示 '???' 佔位。
// 對外部影響：item.dataset.pairId/relation/mrn 供 getNurseExistingValues()
//             之後掃描既有病歷號/關係做重複檢查用；點擊會呼叫
//             onNursePatientChange(r.pair_id, r.relation, r.mrn)。
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

// toggleNursePatientDropdown()
// 用途：開啟/關閉「病患」自製下拉選單（#nurse-patient-dd）。
// 觸發時機：#nurse-patient-btn 的 onclick（按鈕在尚未選擇 LINE 帳號前
//           會是 disabled 狀態，故實際上要先選 LINE 帳號才能點擊）。
function toggleNursePatientDropdown() {
  const dd = document.getElementById('nurse-patient-dd');
  if (dd) dd.classList.toggle('open');
}

// 全域點擊監聽：點擊下拉選單以外的區域時自動收合
// 用途：讓 LINE 帳號下拉選單與病患下拉選單在使用者點擊頁面其他地方時
//       自動關閉，符合一般下拉選單的互動慣例（不需要另外點擊「關閉」
//       按鈕）。用 e.target 是否被下拉選單容器 contains 來判斷點擊位置
//       是否在選單內部。
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

// onNursePatientChange(pairId, relation, mrn)
// 用途：使用者在「病患」下拉選單中選定某個關係配對後的核心處理函式，
//       依 pairId 的三種模式（'self' / 'new' / 既有整數）決定要不要
//       顯示額外的文字輸入欄位（病歷號、關係）。
// 觸發時機：
//   - onNurseLineChange() 自動預選第一個選項時直接呼叫。
//   - buildPatientItem() 項目的 onclick（使用者手動選擇既有關係）。
//   - 「＋ 新增」項目的 onclick（傳入 'new'）。
// 參數：
//   - pairId：'self' | 'new' | <既有整數 pair_id>（見檔案最上方
//             「pair_id 三種模式」總覽說明）。
//   - relation / mrn：僅在選擇既有配對時有值；選 'self' 或 'new' 時
//             這兩個參數通常是 undefined（因為值需要由使用者在後續
//             輸入欄位中填寫）。
// 對外部影響：
//   1. 關閉下拉選單，並把選取結果記錄到 #nurse-form-panel 的
//      dataset.selPairId / selRelation / selMrn（供 validateNurseForm /
//      saveNurseForm 讀取的真相來源）。
//   2. 更新下拉按鈕顯示文字：'new' 時置中顯示「＋ 新增」；其他情況
//      顯示「relation　　　　mrn」排版（mrn 為空時顯示 '???'）。
//   3. 更新列表項目的 .selected 高亮樣式。
//   4. 依 pairId 決定顯示哪些額外輸入欄位：
//        - 'self'：顯示「病歷號（帳號本人）」欄位（因為關係已固定為
//          帳號本人，只缺病歷號）。
//        - 'new'：同時顯示「關係」與「病歷號（新增）」兩個欄位
//          （因為這是全新配對，兩者都要使用者輸入）。
//        - 既有整數 pair_id：不顯示任何額外欄位，因為關係與病歷號
//          都已經是資料庫中的既有資料，不需要（也不應該讓使用者在
//          此處）重新輸入。
//   5. 結尾呼叫 validateNurseForm() 重新檢查儲存按鈕是否可用。
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

// getNurseExistingValues()
// 用途：從目前已渲染在「病患」下拉選單中的既有關係配對項目，收集所有
//       已存在的病歷號與關係文字，供 validateNurseForm() 在使用者輸入
//       「新增」病歷號/關係時做重複性檢查（同一個 LINE 帳號底下不應該
//       有兩筆相同的病歷號或相同的關係文字，否則會造成資料混淆）。
// 回傳：{ mrns: Set<string>, relations: Set<string> }
//       （皆已轉小寫並去除前後空白，做不分大小寫比對）。
// 為什麼：直接掃描目前已渲染的 DOM（.nurse-patient-item 的 dataset），
//         而不是重新呼叫 API，是因為 onNurseLineChange() 已經把該
//         LINE 帳號的既有關係渲染到列表中，DOM 本身就是最新且唾手可得
//         的資料來源，不需要額外的網路請求。
function getNurseExistingValues() {
  const mrns = new Set();
  const relations = new Set();
  document.querySelectorAll('#nurse-patient-list .nurse-patient-item').forEach(el => {
    if (el.dataset.mrn)      mrns.add(el.dataset.mrn.trim().toLowerCase());
    if (el.dataset.relation) relations.add(el.dataset.relation.trim().toLowerCase());
  });
  return { mrns, relations };
}

// validateNurseForm()
// 用途：即時檢查護理師填單表單目前輸入是否合法，決定「💾 儲存」按鈕
//       是否可點擊，並在旁邊的提示文字（#nurse-fp-sub）顯示目前缺少
//       什麼或哪裡有問題。
// 觸發時機：幾乎每個表單互動都會呼叫這個函式，包括：
//   - 選擇/切換 LINE 帳號、選擇/切換病患關係（onNursePatientChange 結尾）。
//   - 「病歷號（帳號本人）」「關係」「病歷號（新增）」三個文字輸入框的
//     oninput 事件（即時驗證，不需要等失焦或送出才檢查）。
//   - resetNursePatientDropdown() 重置後也會呼叫一次確保按鈕狀態正確。
// 驗證規則（依 pairId 分支）：
//   - 必要條件：必須先選了 LINE 帳號（dataset.lineAccountId 存在）且
//     選了病患關係（dataset.selPairId 存在），否則直接停用按鈕並提示
//     「請選擇 LINE 帳號與病患」。
//   - pairId === 'self'：病歷號輸入框不可為空；且不可與
//     getNurseExistingValues() 收集到的既有病歷號重複（不分大小寫）。
//     不合法時該輸入框加上 .invalid 樣式（通常對應紅色邊框），提示
//     文字顯示對應錯誤原因。
//   - pairId === 'new'：關係輸入框與病歷號輸入框都不可為空，且都不可
//     與既有值重複（分別檢查 relations 與 mrns 這兩個 Set）。若兩者
//     都有問題，優先顯示「關係」相關的錯誤提示（hint 只在尚未設定時
//     才被覆寫，故先出現的錯誤優先顯示）。
//   - 既有整數 pairId：不進入以上任何分支，代表沿用既有配對資料，
//     沒有額外欄位需要驗證，故 valid 維持 true。
// 結尾：saveBtn.disabled = !valid；並依 valid 更新提示文字為
//       「確認資料無誤就可建立」或具體的錯誤原因。
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

// saveNurseForm()
// 用途：護理師填單表單的最終送出動作，呼叫後端建立「草稿」——這是整個
//       出院單草稿流程的起點（nurse_create 成功後才會有草稿可供醫師
//       在「醫師填單」分頁完成填寫）。
// 觸發時機：#btn-nurse-save 按鈕的 onclick（按鈕在 validateNurseForm()
//           判定不合法時會是 disabled，故此函式一開頭仍會再次確認
//           saveBtn.disabled 為 false 才繼續，屬防禦性檢查）。
// 資料整理邏輯：
//   - lineAccountId、pairId 直接讀取 #nurse-form-panel 的 dataset。
//   - 若 pairId === 'self'：relation 強制覆寫為固定文字「帳號本人」，
//     mrn 則讀取 #nurse-draft-self-mrn 輸入框的值。
//   - 若 pairId === 'new'：relation 與 mrn 都讀取對應的新增輸入框
//     （#nurse-draft-new-relation / #nurse-draft-new-mrn）。
//   - 若 pairId 是既有整數：relation/mrn 直接使用 dataset 中既有的值
//     （panel.dataset.selRelation / selMrn，來自選擇既有配對時
//     onNursePatientChange 寫入的值），不需要再讀輸入框（因為此時
//     對應輸入框根本沒有顯示）。
// 對應 API：POST /api/forms/nurse_create
//   Request body：
//     {
//       line_account_id: 整數（parseInt 轉換）,
//       pair_id: 'self' | 'new' | <既有整數 pair_id>,
//       relation: 字串,
//       mrn: 字串（病歷號）
//     }
//   Response：{ success: true, lpp_id, draft_path } 或
//             { success: false, error }
//   後端行為（重要，助於理解此呼叫的「副作用」）：成功時會 upsert
//   patients / line_patient_pairs 資料表、寫入草稿 JSON 檔到
//   drafts/D{doctor_id:07d}/{mrn}_{yyyymmdd}.json、並把該
//   line_account_id 從 pinned 佇列中移除（因為已經被護理站處理）。
// 資料流程：
//   1. 送出前先停用按鈕並將文字改為「建立中…」，避免重複點擊造成
//      重複建立草稿。
//   2. 成功：顯示成功 toast，還原按鈕文字，並呼叫
//      loadNurseLineAccounts()（重新載入 LINE 帳號列表，此時該帳號
//      應該已經從 pinned 置頂清單中消失）與 loadDoctorDrafts()
//      （讓「醫師填單」分頁的角標立即反映剛建立的新草稿，即使目前
//      使用者還停留在護理師填單分頁）。
//   3. 失敗（包含 API 回傳 success:false 或整個請求拋例外）：顯示帶
//      錯誤訊息的失敗 toast，重新啟用按鈕並還原文字，讓使用者可以
//      修正後再次嘗試送出。
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


// ──────────────────────────────────────────────────────────────────────
// 區塊：出院單紀錄分頁（forms section — 三欄式主畫面：病患列表 →
// 就診紀錄列表 → 表單詳情/編輯）
// 這是「出院單管理」分頁的預設畫面（data-state="view"），三欄分別是：
//   Column 1（#form-patient-list-body）：所有曾建立過出院單的病患清單。
//   Column 2（#form-visit-list-body）：選中病患的歷次就診（checkout_date）
//     清單。
//   Column 3（#form-edit-body）：選中某次就診的詳細內容，可切換唯讀
//     檢視（#form-view-container）與編輯模式（#form-edit-container）。
// ──────────────────────────────────────────────────────────────────────

// loadFormsPatientList()
// 用途：載入「出院單紀錄」分頁 Column 1 的完整病患清單。
// 觸發時機：
//   - 分頁初次載入 / 切換回這個分頁時（由外部呼叫，如 main.js 的路由
//     切換邏輯）。
//   - doSaveDoctorForm()、saveFormEdit()、submitViewEdit() 等會影響
//     病患清單內容的操作完成後，用於刷新列表確保資料最新。
// 對應 API：
//   1. GET /api/chats（此 API 定義在對話紀錄相關的後端路由，回傳的是
//      「所有病患」的彙總清單，包含 medical_record_num、relation、
//      specialty/specialties、form_count、latest_checkout、status 等
//      欄位，因為出院單清單與對話紀錄清單本質上是同一份病患彙總資料，
//      故直接重用這個既有 API，不重複開發專屬的病患清單 API）。
//   2. 同時呼叫 loadDoctorDrafts()（見上方醫師填單區塊），確保切到這個
//      分頁時「醫師填單」按鈕上的未完成草稿角標也是最新的。
// 資料流程：
//   1. 顯示全域 loading 遮罩（loading(true)）。
//   2. 呼叫 API，將結果存入 state.allFormPatients（作為排序/篩選的
//      原始資料來源，之後 sortAndRenderFormPatients 都是對這份複本操作，
//      不會重新打 API）。
//   3. 讀取排序下拉選單（#form-patient-sort-select）目前選中的排序方式，
//      呼叫 sortAndRenderFormPatients() 依此排序並渲染列表。
//   4. 失敗時清空 state.allFormPatients 並渲染空列表。
//   5. finally 區塊關閉 loading 遮罩（無論成功失敗都會執行）。
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

// sortAndRenderFormPatients(criteria)
// 用途：依使用者在 #form-patient-sort-select 選擇的排序方式，對
//       state.allFormPatients 做純前端排序（不重新打 API），再呼叫
//       renderFormPatientList() 渲染結果。
// 觸發時機：
//   - #form-patient-sort-select 的 onchange（使用者手動切換排序方式）。
//   - loadFormsPatientList() 載入資料後依目前選中的排序值呼叫一次。
// 參數：criteria - 'checkout_desc'（就診日期新到舊，預設）、
//                   'checkout_asc'（就診日期舊到新）、
//                   'mrn_desc'（病歷號字串遞減）、
//                   'mrn_asc'（病歷號字串遞增）。
// 邏輯細節：
//   - 先用陣列展開 [...state.allFormPatients] 建立複本再排序，避免
//     直接對原陣列 sort 造成後續操作混亂（雖然 JS 的 sort 是 in-place，
//     這裡刻意複本化是防禦性寫法）。
//   - 日期/病歷號排序皆使用字串比較（localeCompare），因為
//     latest_checkout 與 medical_record_num 皆為可字典序比較的字串
//     格式（日期為 ISO 格式字串，病歷號通常為固定格式的字串）。
//   - 排序完成後呼叫 renderFormPatientList(patients) 實際渲染 DOM。
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

// renderFormPatientList(patients)
// 用途：把病患陣列渲染成 Column 1 的病患清單 DOM（#form-patient-list-body），
//       每個項目顯示病歷號、關係標籤、看診狀態標籤、科別、出院單筆數、
//       最新就診日期。
// 觸發時機：sortAndRenderFormPatients() 排序完成後呼叫；loadFormsPatientList()
//           失敗時以空陣列呼叫顯示「無病患資料」空狀態。
// 渲染邏輯細節：
//   - #form-patient-count 顯示病患總數。
//   - specialtyText/specialtyTitle：若病患有多個科別紀錄
//     （p.specialties.length > 1），只顯示第一個科別文字外加「...」，
//     並用 title（滑鼠懸浮提示）顯示完整科別清單，避免版面被過長的
//     科別列表撐開。
//   - p.medical_record_num === state.formCurrentMrn 時該項目加上
//     .active 高亮，代表「目前 Column 2/3 顯示的就是這位病患」。
//   - 點擊整個項目呼叫 loadFormDetail(mrn, this) 載入該病患的就診紀錄。
//   - 病患狀態徽章（status）採用四種顏色編碼：
//       '須看診'（橘色 #f59e0b，白字）、
//       '已看診'（淺黃底 #fef3c7，深黃字 #b45309，代表已完成但可能仍需
//                 留意）、
//       '須回診'（紅色 #ef4444，白字，最需要醫護人員注意）、
//       '已回診'（淺紅底 #fee2e2，深紅字 #991b1b，代表回診流程已結案）。
//     這組狀態徽章與 relation 徽章、科別徽章可以同時並排顯示在
//     病歷號那一行，方便護理站/醫師快速掃視誰需要優先處理。
//   - esc() 是全域共用的 HTML escape 工具函式（定義在其他共用 JS 檔，
//     例如 utils.js），用於避免病患姓名/病歷號中若含有特殊字元造成
//     HTML injection。
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
          ${p.status === '須看診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #f59e0b; color: white;">需看診</span>` : ''}
          ${p.status === '已看診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #fef3c7; color: #b45309; border: 1px solid #fcd34d;">已看診</span>` : ''}
          ${p.status === '須回診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #ef4444; color: white;">需回診</span>` : ''}
          ${p.status === '已回診' ? `<span class="badge badge-return-visit" style="margin-left: 6px; font-weight: 500; background-color: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;">已回診</span>` : ''}
        </div>
        <div class="patient-meta">
          <span class="badge badge-blue" ${specialtyTitle ? `title="${esc(specialtyTitle)}"` : ''}>${specialtyText}</span>
          <span>出院單 ${p.form_count} 筆</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">就診日期：${esc(p.latest_checkout || '—')}</div>
      </div>`;
  }).join('');
}

// loadFormDetail(mrn, el, targetDate = null)
// 用途：使用者點擊 Column 1 某位病患後，載入該病患所有歷次就診
//       （出院單）紀錄，渲染到 Column 2 的就診紀錄列表。
// 觸發時機：
//   - renderFormPatientList() 產生的病患項目 onclick。
//   - saveFormEdit() / submitViewEdit() 等編輯完成後，重新載入以反映
//     最新資料（此時常會帶入 targetDate 讓使用者留在剛編輯的那一筆）。
// 參數：
//   - mrn：病歷號。
//   - el：被點擊的病患項目 DOM（用於套用 .active 樣式；可為 null，
//         例如程式化呼叫時不一定有對應的可視元素）。
//   - targetDate：可選，若指定則載入完成後自動選中該筆 checkout_date
//     對應的就診項目（而非預設選中最新一筆），常用在「編輯完成後
//     停留在剛剛編輯的那筆紀錄」的情境。
// 對應 API：GET /api/chats/<mrn>
//   Response：{ forms: [ {checkout_date, doctor_account, specialty,
//              symptoms, line_account_id, relation, ...}, ... ], error? }
//   （這個 API 同樣來自對話紀錄相關後端路由，回傳「該病患所有正式
//    record 紀錄」的清單，非草稿。）
// 資料流程：
//   1. 更新 state.formCurrentMrn，並將 Column 1 的 .active 樣式移到
//      被點擊的項目。
//   2. 清空目前選中的紀錄 state.currentSelectedRecord，若正處於編輯
//      模式則強制退出（exitViewEditMode(false)，不彈出「已取消」提示，
//      因為這是「切換病患」而非「使用者主動取消編輯」）。
//   3. 隱藏 Column 3 的編輯/檢視按鈕與檢視容器，Column 2 顯示 loading
//      spinner 佔位。
//   4. 呼叫 API；若回傳 d.error，Column 2 顯示錯誤訊息並中止。
//   5. 成功則把 d.forms 存入 state.currentForms（Column 2/3 渲染的
//      單一資料來源），呼叫 renderFormVisits(targetDate) 實際渲染
//      就診列表並可能自動選中其中一筆。
//   6. 例外狀況（網路錯誤等）在 Column 2 顯示「載入失敗」。
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

// renderFormVisits(targetDate = null)
// 用途：把 state.currentForms（某位病患的所有就診紀錄）渲染成
//       Column 2 的就診項目列表（#form-visit-list-body），並自動選中
//       其中一筆（觸發 Column 3 顯示詳細內容）。
// 觸發時機：loadFormDetail() 成功取得資料後呼叫。
// 邏輯細節：
//   - #form-visit-count 顯示就診紀錄總數。
//   - 若無任何紀錄，顯示「無就診紀錄」空狀態並提早結束。
//   - 顯示順序：依 checkout_date 字串比較做「新到舊」排序
//     （sortedForms），但每個項目的 onclick 傳入的 index 是
//     origIdx —— 也就是在原始未排序陣列 state.currentForms 中的索引，
//     而非排序後的顯示順序索引。這是因為後續多處程式碼（例如
//     selectFormVisit 內部）以「state.currentForms 的原始索引」為主要
//     資料存取方式，保持索引一致可避免排序顯示與底層資料存取脫節。
//   - 自動選中邏輯：
//       若指定了 targetDate，先在排序後的陣列中找到對應
//       checkout_date 的顯示位置（selectIdx），再用該顯示位置去抓取
//       對應的 DOM 元素（#form-visit-item-{selectIdx}）並模擬點擊
//       （.click()）。
//       若找不到 targetDate 對應項目，或根本沒指定 targetDate，
//       fallback 為選中列表中第一個項目（也就是排序後最新的一筆）。
//     用 .click() 觸發選取，是為了完整重用 selectFormVisit() 內原本
//     綁定在 onclick 上的所有渲染邏輯，不需要另外複製一份選取程式碼。
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

// ══════════════════════════════════════════════════════════════════════
// 【重要備註：以下 toggleCardEditMode() / saveFormEdit() 疑似為舊版
//  「卡片內直接編輯」介面的殘留（legacy）程式碼】
//   經比對 webpage/admin/html/forms.html，目前的 DOM 結構中：
//     - #card-view-mode、#card-edit-mode、#edit-form-admin-fields、
//       #edit-form-doctor-group、#btn-edit-card 等元素皆被明確標示為
//       「Hidden compat inputs」（隱藏的相容性輸入欄，見 forms.html
//       第 261~265 行附近），沒有任何按鈕會呼叫 toggleCardEditMode()。
//     - #btn-save-form-edit（saveFormEdit 所操作的儲存按鈕）在目前的
//       forms.html 中並不存在。
//   目前實際生效的編輯流程是下方「View Edit Mode」區塊
//   （enterViewEditMode / exitViewEditMode / submitViewEdit，透過
//   PUT /api/forms/view_edit 送出），而非這裡的 toggleCardEditMode /
//   saveFormEdit（透過 PUT /api/forms/<mrn>/<checkout_date> 送出）。
//   保留這段程式碼是為了不更動既有程式邏輯／行為（任務要求僅新增
//   註解，不可修改程式碼），僅在此註明其目前在正常操作流程下不會被
//   任何使用者互動觸發，供之後維護者確認是否可安全移除。
// ══════════════════════════════════════════════════════════════════════
let isEditingCard = false;

// toggleCardEditMode()
// 用途（依程式碼原意推測）：在 Column 3 卡片內，切換「唯讀顯示」與
//       「直接在卡片內編輯」兩種模式，讓使用者可編輯關係、病歷號
//       （僅管理員）、就診日期、負責醫師，而不需要進入完整的
//       #form-edit-container 編輯版面。
// 參數：無（依賴模組層級變數 isEditingCard 記錄目前是否在編輯狀態）。
// 邏輯概要：
//   - 切換為編輯模式時：把目前顯示文字（display-form-*）填入對應
//     輸入框，管理員才顯示病歷號輸入欄，日期字串從
//     'YYYY-MM-DD HH:MM:SS.SSS' 轉換為 <input type="datetime-local">
//     所需的 'YYYY-MM-DDTHH:MM' 格式；並依原始資料找出對應醫師帳號
//     設定到 <select>。
//   - 切換回唯讀模式時：驗證關係/病歷號/日期不可為空（用原生 alert()
//     阻擋，若驗證失敗會把 isEditingCard 設回 true 並 return，讓使用者
//     停留在編輯模式修正），通過後把輸入值寫回顯示用文字節點，並將
//     日期字串補齊秒數與毫秒（.000）還原成完整格式。
//   - 結尾若 checkFormModified 函式存在則呼叫它，重新檢查儲存按鈕
//     是否應該啟用（但如上方備註，#btn-save-form-edit 在目前 DOM 中
//     不存在，故該檢查實務上不會影響任何畫面）。
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

// selectFormVisit(idx, el)
// 用途：使用者點擊 Column 2 某一筆就診紀錄後，把該筆紀錄的詳細內容
//       渲染到 Column 3 的唯讀檢視畫面（#form-view-container）。這是
//       目前實際運作中的「檢視」進入點（編輯模式則另外透過
//       enterViewEditMode() 觸發）。
// 觸發時機：renderFormVisits() 產生的就診項目 onclick；也可能由
//           renderFormVisits() 內以 .click() 方式程式化觸發（自動選中）。
// 參數：
//   - idx：state.currentForms 陣列中的原始索引（非排序後顯示順序，
//          見 renderFormVisits 註解說明）。
//   - el：被點擊的 DOM 元素，用於套用 .active 樣式。
// 資料流程與渲染：
//   1. 更新 Column 2 的 .active 高亮。
//   2. 從 state.currentForms[idx] 取出該筆紀錄 f，與目前病歷號 mrn
//      組成 state.currentSelectedRecord = { f, mrn }（這是「查看/修改
//      表單」分頁的單一真相來源，enterViewEditMode/exitViewEditMode/
//      submitViewEdit 都讀取這個物件）。
//   3. 若目前正處於編輯模式，先強制退出（不彈出取消提示）。
//   4. 更新標題/副標題文字為就診日期，並把隱藏相容欄位
//      #edit-form-mrn / #edit-form-orig-date 設定為目前病歷號/日期
//      （即使不再使用卡片內編輯模式，仍保留寫入這兩個隱藏欄位以維持
//      舊有相容性，不更動此行為）。
//   5. 從 state.allFormPatients 找出對應病患物件，取得其 relation
//      文字（預設「帳號本人」），填入 meta-box 的關係/病歷號/日期
//      顯示欄位。
//   6. 依病患 status 欄位（須看診/已看診/須回診/已回診）決定是否顯示
//      「需回診」風格的徽章，以及對應的顏色樣式（與 renderFormPatientList
//      中的顏色編碼邏輯一致，但這裡只特別處理「需回診」徽章的顯示/
//      隱藏，其餘狀態文字也會依樣式規則呈現）。
//   7. 渲染症狀清單（唯讀）：把 f.symptoms 陣列逐一轉換為唯讀樣式的
//      symptom-chip 標籤，塞入 #view-form-symptoms；若無症狀顯示
//      「—」佔位符號。
//   8. 顯示唯讀檢視容器，隱藏空狀態與編輯容器。
//   9. 依權限決定是否顯示「✏️ 修改」按鈕：管理員（state.isAdmin）
//      或這筆紀錄的負責醫師本人（f.doctor_account === state.account）
//      才能看到修改按鈕，其他一般醫師僅能檢視、無法編輯這筆紀錄。
//   10. 懶載入醫師清單：若 state.doctors 尚未載入過（快取判斷），
//       呼叫 GET /api/doctors 取得所有醫師帳號與姓名對照，用於把
//       f.doctor_account（帳號名）轉換為易讀的醫師姓名顯示。
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
    if (patientObj) {
      if (patientObj.status === '須看診') {
        displayFormReturnBadge.textContent = '需看診';
        displayFormReturnBadge.style.backgroundColor = '#f59e0b';
        displayFormReturnBadge.style.color = '#ffffff';
        displayFormReturnBadge.style.border = 'none';
        displayFormReturnBadge.style.display = '';
      } else if (patientObj.status === '已看診') {
        displayFormReturnBadge.textContent = '已看診';
        displayFormReturnBadge.style.backgroundColor = '#fef3c7';
        displayFormReturnBadge.style.color = '#b45309';
        displayFormReturnBadge.style.border = '1px solid #fcd34d';
        displayFormReturnBadge.style.display = '';
      } else if (patientObj.status === '須回診') {
        displayFormReturnBadge.textContent = '需回診';
        displayFormReturnBadge.style.backgroundColor = '#ef4444';
        displayFormReturnBadge.style.color = '#ffffff';
        displayFormReturnBadge.style.border = 'none';
        displayFormReturnBadge.style.display = '';
      } else if (patientObj.status === '已回診') {
        displayFormReturnBadge.textContent = '已回診';
        displayFormReturnBadge.style.backgroundColor = '#fee2e2';
        displayFormReturnBadge.style.color = '#991b1b';
        displayFormReturnBadge.style.border = '1px solid #fca5a5';
        displayFormReturnBadge.style.display = '';
      } else {
        displayFormReturnBadge.style.display = 'none';
      }
    }
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
    const drName = currentDr ? currentDr.doctor_name : (f.doctor_account || '—');
    displayDoctor.textContent = drName !== '—' ? `${drName} 醫師` : drName;
  }
}

// saveFormEdit()
// 用途（依程式碼原意推測，見上方 toggleCardEditMode 備註——此函式在
//       目前 forms.html 中沒有對應觸發按鈕，屬於舊版「卡片內編輯」
//       流程的殘留）：把卡片內編輯模式（toggleCardEditMode）與人體圖
//       症狀選擇（selectedTopics）收集到的資料，送往後端更新既有的
//       正式紀錄。
// 對應 API：PUT /api/forms/<mrn>/<checkout_date>
//   Request body：
//     {
//       checkout_date: 顯示中的日期字串,
//       symptoms: Array.from(selectedTopics)（人體圖模組收集的症狀集合）,
//       medical_record_num: 新病歷號（僅 state.isAdmin 為 true 時才帶入，
//                            對應後端「改病歷號僅限管理員」的規則）,
//       relation: 顯示中的關係文字,
//       doctor_account: 下拉選單選中的醫師帳號（若有值才帶入）
//     }
//   Response：{ success: true/false, error? }
// 資料流程：
//   1. 若目前仍在編輯模式（isEditingCard 為 true），先呼叫
//      toggleCardEditMode() 觸發驗證並把輸入值寫回顯示文字；若驗證
//      失敗（isEditingCard 又被設回 true）則直接 return，中止送出。
//   2. 從隱藏欄位/顯示文字節點收集 mrn、原始日期、目前顯示的病歷號/
//      關係/日期、醫師下拉選單、以及 selectedTopics（人體圖模組維護
//      的 Set，見下方「人體圖互動邏輯」區塊）轉為陣列作為症狀清單。
//   3. 前端基本驗證：管理員模式下病歷號/關係不可為空、日期不可為空、
//      症狀至少需選 1 項，任何一項不合法就在 #form-edit-error 顯示
//      錯誤文字並中止（不會發送請求）。
//   4. 呼叫 API；成功則顯示成功 toast，重新呼叫 loadFormsPatientList()
//      刷新 Column 1，並以「新病歷號（若為管理員修改過）或原病歷號」
//      重新呼叫 loadFormDetail() 刷新 Column 2/3、定位到剛編輯的那筆
//      （displayDate）。若目前「病患對話紀錄」分頁也停留在同一個病患
//      （state.currentMrn 比對），額外呼叫 loadDetail() 同步刷新對話
//      紀錄分頁的資料，確保兩個分頁看到的資料一致。
//   5. 失敗則開啟錯誤提示 Modal（#modal-alert-error）並在
//      #form-edit-error 顯示錯誤訊息，同時把畫面還原成編輯前的原始
//      狀態（重新呼叫 selectFormVisit 帶入原始索引，等同於「復原」
//      使用者剛剛的修改）。
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

// ══════════════════════════════════════════════════════════════════════
// 區塊：人體圖互動邏輯與衛教對應（人體圖模組 — 目前疑似為未使用的
// 舊版介面殘留程式碼）
//
// 【重要備註】此區塊（topicMapping、initBodyDiagramEvents、closePopover、
//  showPopover、syncPopoverCheckboxes、renderConfirmedChips、
//  createChipElement）依賴的 DOM 元素（.hotspot、#popover、
//  #popover-close、#popover-title、#popover-checkboxes、
//  .interactive-layout、.popover-column、#confirmed-list、#empty-msg、
//  .confirmation-section、.chip）經檢查在目前的
//  webpage/admin/html/forms.html（以及整個 webpage/admin/html/ 目錄）
//  中皆不存在任何對應元素。也就是說，這是「以身體部位圖點選症狀」的
//  舊版互動介面，已被上方三欄式（部位/類別 → 衛教項目 → 已選擇）
//  選單取代（見 renderSymptomMainCol 系列 與 renderVEMainCol 系列），
//  但這段程式碼仍被保留、且 script.js 的 DOMContentLoaded 監聽器仍會
//  呼叫 initBodyDiagramEvents()（見 script.js）。由於實際找不到
//  .hotspot 元素，querySelectorAll 會回傳空集合，forEach 不執行任何
//  動作，故此函式呼叫在目前系統中屬於「安全的空操作」，不影響任何
//  使用者可見行為。selectedTopics（下方宣告的模組層級 Set）雖然
//  在 saveFormEdit() 中仍被讀取，但因為沒有任何 UI 能夠對它增删元素
//  （人體圖已無對應 DOM），實務上 selectedTopics 會恆為空集合。
//  依任務要求（僅新增註解、不修改程式邏輯），此區塊程式碼原樣保留，
//  僅在此補充說明其目前的實際運作狀態，方便之後判斷是否可安全清除。
//
// topicMapping：身體部位（人體圖上的熱區代號）→ 該部位相關衛教主題
//              清單的靜態對照表，供 showPopover() 依點擊的部位顯示
//              對應的可勾選症狀清單。
// ══════════════════════════════════════════════════════════════════════
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

// selectedTopics：目前已勾選的症狀名稱集合（Set，避免重複），為人體圖
//                 模組的狀態來源，最終在 saveFormEdit() 中被轉為陣列
//                 送往後端（見上方備註：實務上因無 UI 觸發，恆為空集合）。
// currentActiveRegion：目前展開中的人體圖熱區代號，null 代表無展開中的
//                       部位彈出視窗（popover）。
let selectedTopics = new Set();
let currentActiveRegion = null;

// getFormEl(id)
// 用途：優先在 #form-edit-container 範圍內尋找指定 id 的元素，若找不到
//       才 fallback 用全域 document.getElementById 尋找。這種寫法通常
//       是為了容錯——例如同一個 id 若因版面重構被複製到 Column 3
//       以外的地方，仍能優先抓到「表單編輯容器內」正確的那一個。
//       目前因為人體圖相關 id（popover、popover-close 等）在整份
//       forms.html 中皆不存在，此函式對這些 id 的呼叫恆回傳 null。
function getFormEl(id) {
  return document.querySelector(`#form-edit-container #${id}`) || document.getElementById(id);
}

// initBodyDiagramEvents()
// 用途：初始化人體圖模組的所有事件監聽器（熱區點擊展開/收合 popover、
//       popover 關閉按鈕、點擊外部區域自動收合）。
// 觸發時機：由 script.js 的 DOMContentLoaded 監聽器在頁面載入時呼叫一次
//           （見 script.js 對應註解）。
// 目前實際行為：由於 document.querySelectorAll('#form-edit-container .hotspot')
//   在目前 DOM 中回傳空集合，本函式內的 hotspots.forEach(...) 不會綁定
//   任何事件；popoverCloseBtn 透過 getFormEl('popover-close') 取得，
//   同樣會是 null，故 if (popoverCloseBtn) 判斷為 false，不會綁定
//   關閉按鈕事件。函式最底部另外綁定的「點擊 #form-edit-container
//   以外區域時關閉 popover / 若有 .chip.inactive 就強制重新渲染」的
//   全域 document click 監聽器仍會被註冊（這段不依賴 hotspot 是否存在），
//   但因為 .chip 元素同樣不存在於目前 DOM，實際上也不會有任何效果。
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

// closePopover()
// 用途：收合人體圖的部位彈出視窗（popover），移除展開樣式與熱區
//       active 樣式，並清空 currentActiveRegion。
// 觸發時機：initBodyDiagramEvents() 綁定的多處事件（點擊已展開的同一
//           熱區、點擊 popover 關閉按鈕、點擊 #image-wrapper 以外區域）。
//   （見上方備註：目前因對應 DOM 元素不存在，此函式實際上不會被觸發。）
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

// showPopover(hotspotEl, region)
// 用途：展開並定位人體圖的部位彈出視窗，依 region 對應
//       topicMapping 顯示可勾選的症狀 checkbox 清單，並依熱區在畫面上
//       的位置（data-position 為 'body' 或其他）計算 popover 應該出現
//       在左側或右側、以及箭頭指向的垂直位置，避免超出容器邊界
//       （用 Math.max/Math.min 夾住在 [0, maxTop] 範圍內）。
// 觸發時機：initBodyDiagramEvents() 中熱區點擊事件觸發（同一備註：
//           目前因對應 DOM 元素不存在，實際不會被觸發）。
// 邏輯細節：每個症狀對應一個 checkbox，勾選狀態依 selectedTopics.has(topic)
//           決定初始勾選狀態；change 事件觸發時同步增删 selectedTopics，
//           並呼叫 renderConfirmedChips() 更新下方已確認的症狀標籤列表。
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

// syncPopoverCheckboxes()
// 用途：把 popover 內所有 checkbox 的勾選狀態，同步為目前 selectedTopics
//       集合的真實內容（用於當「已確認症狀標籤」被直接點擊移除時，
//       確保如果之後重新打開同一個部位的 popover，checkbox 狀態仍正確）。
function syncPopoverCheckboxes() {
  document.querySelectorAll('#form-edit-container .pop-checkbox-item input').forEach(cb => {
    cb.checked = selectedTopics.has(cb.value);
  });
}

// renderConfirmedChips(forceClean = false)
// 用途：渲染「已確認症狀」標籤列表（#confirmed-list），支援兩種渲染
//       策略：forceClean=true 時整個清空重建（例如點擊頁面空白處，
//       強制把所有 .inactive（已被取消勾選但尚未移除的）標籤真正移除，
//       只留下目前仍在 selectedTopics 中的項目）；forceClean=false（預設）
//       時採用差異更新（只新增缺少的標籤、把已取消的標籤標記為
//       .inactive 但暫不移除，讓使用者有機會看到「剛剛取消了哪個」的
//       視覺回饋，直到下次 forceClean 觸發才真正清除)。
// 觸發時機：checkbox change 事件、initBodyDiagramEvents 中點擊
//           confirmation-section 以外區域時（強制清理 inactive 項目）。
// 對外部影響：同步顯示/隱藏 .confirmation-section 容器（有勾選項目才
//             顯示）與 #empty-msg 空狀態文字；結尾呼叫 checkFormModified()
//             （若存在）重新檢查儲存按鈕狀態。
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

// createChipElement(topic, isActive)
// 用途：建立單一「已確認症狀」標籤（chip）的 DOM 節點，點擊可切換
//       選取/取消狀態（✓/✕ 圖示切換），並同步呼叫 syncPopoverCheckboxes()
//       讓 popover 內對應的 checkbox 保持一致。
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
// ── 修改出院單儲存按鈕狀態檢查（人體圖/卡片內編輯模式所屬，同屬
//    上方備註中「目前無對應觸發 UI」的舊版流程）──
// checkFormModified()
// 用途：比較「卡片內編輯」目前的輸入值（關係、病歷號、症狀）與原始
//       紀錄，判斷是否有任何變更，據此決定 #btn-save-form-edit
//       （目前 forms.html 中不存在此元素）是否應該啟用。
// 觸發時機：toggleCardEditMode() 結尾、renderConfirmedChips() 結尾、
//           #edit-form-relation-input 的 input 事件、
//           #edit-form-mrn-input 的 input 事件（見下方監聽器註冊）。
// 邏輯細節：
//   - 若找不到 saveBtn（#btn-save-form-edit，目前恆為 null）或
//     mrn/origDate 隱藏欄位為空，直接視為不可儲存並提早結束。
//   - 依 isEditingCard 決定要讀取「編輯輸入框」還是「顯示文字節點」
//     的目前值（因為 checkFormModified 可能在編輯中或編輯完成後
//     都會被呼叫）。
//   - 分別比較症狀（陣列內容與長度）、病歷號、關係是否與原始資料
//     （state.currentForms 中找到的對應紀錄、state.allFormPatients
//     中找到的對應病患關係）不同，任一項不同即視為 isModified=true，
//     據此切換按鈕的 disabled 狀態與視覺樣式（透明度、游標樣式）。
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

// ── 模組載入時期立即註冊的輸入監聽器 ──
// 用途：在本檔案被 <script> 標籤載入、執行到這幾行程式碼的當下
//       （並非等待 DOMContentLoaded），立即嘗試抓取
//       #edit-form-relation-input / #edit-form-mrn-input 這兩個隱藏
//       相容輸入欄並綁定 input 事件。由於這兩個元素在 forms.html 中
//       確實存在（作為 hidden compat inputs，見檔案開頭 HTML 結構），
//       綁定本身會成功，但因為沒有任何可見 UI 會讓使用者對這兩個
//       欄位輸入文字（它們不是實際渲染出來給人看的表單欄位），
//       這兩個監聽器在正常使用情境下實際上不會被觸發。
const editRelInput = document.getElementById('edit-form-relation-input');
if (editRelInput) editRelInput.addEventListener('input', checkFormModified);

// #edit-form-mrn-input 的 input 監聽器：額外比對「使用者輸入的病歷號」
// 是否與其他既有病患的病歷號重複（state.allFormPatients 中搜尋），
// 若重複則顯示警告文字（#edit-form-mrn-warning）並停用「編輯卡片」
// 按鈕（#btn-edit-card，目前 DOM 中不存在，故此停用動作無實際效果），
// 避免修改病歷號時不小心撞到別的病患既有的病歷號。
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



// ══════════════════════════════════════════════════════════════════════
// 區塊：查看/修改表單 —— 編輯模式（View Edit Mode，前綴 "ve" = view edit）
// 這是目前實際運作中、使用者真正會操作到的「修改出院單」功能，取代了
// 上方已標註為 legacy 的卡片內編輯（toggleCardEditMode/saveFormEdit）與
// 人體圖模組。點擊 Column 3 唯讀檢視畫面右上角的「✏️ 修改」按鈕
// （#btn-view-edit，onclick="enterViewEditMode()"）即進入此模式，
// 畫面切換為 #form-edit-container，可以：
//   - 重新選擇這筆紀錄要歸屬到哪一個 LINE 帳號 / 哪一種關係 / 病歷號
//     （等同於把這筆正式紀錄的擁有者「轉移」給別的帳號或關係）。
//   - 重新勾選症狀清單（與醫師填單分頁相同的三欄式選單，但前綴為
//     "ve" 對應獨立的一組 DOM 元素與 state 欄位，避免互相干擾）。
// 最終送出走 PUT /api/forms/view_edit（見 submitViewEdit()），與
// PUT /api/forms/<mrn>/<checkout_date>（saveFormEdit 使用的舊 API）
// 是兩個不同的後端端點：view_edit 可以同時「轉移」LINE 帳號/關係/
// 病歷號，邏輯上更接近 nurse_create 的 upsert 行為，但作用對象是
// 既有的正式 record，而非建立新草稿。
// ══════════════════════════════════════════════════════════════════════

// state 欄位初始化：這裡直接對全域共用的 state 物件（定義於其他共用
// JS 檔，例如 utils.js/state.js，非本檔案宣告）附加以下欄位，作為
// View Edit Mode 專屬的狀態容器：
//   - veLineAccounts：目前快取的 LINE 帳號列表（同 get_line_accounts）。
//   - vePinnedLineIds：目前快取的 pinned 置頂帳號 id 列表。
//   - veSelectedLine：使用者目前選中的 LINE 帳號 { id, name }。
//   - veSelectedPair：使用者目前選中的病患關係
//                      { pair_id, relation, mrn }。
//   - veSelectedSymptoms：目前已勾選的症狀名稱陣列（三欄式選單的
//                          單一真相來源，與醫師填單分頁的
//                          state.selectedSymptoms 是獨立的兩份資料）。
//   - veActiveCategory：目前展開中的症狀分類 key（同上，獨立於
//                        state.activeCategory）。
//   - viewEditMode：布林值，代表目前「查看/修改表單」分頁是否處於
//                    編輯模式（true）或唯讀檢視模式（false），也被
//                    setFormsState() 用來判斷切換分頁前是否需要先
//                    強制退出編輯模式。
state.veLineAccounts = [];
state.vePinnedLineIds = [];
state.veSelectedLine = null;     // { id, name }
state.veSelectedPair = null;     // { pair_id, relation, mrn }
state.veSelectedSymptoms = [];
state.veActiveCategory = null;
state.viewEditMode = false;

// enterViewEditMode()
// 用途：把 Column 3 從唯讀檢視畫面切換為可編輯畫面，並初始化編輯模式
//       所需的所有狀態與下拉選單資料。
// 觸發時機：#btn-view-edit「✏️ 修改」按鈕的 onclick（僅在
//           selectFormVisit() 判定使用者具編輯權限時才會顯示此按鈕）。
// 前置條件：state.currentSelectedRecord 必須存在（代表使用者已經在
//           Column 2 選中了某一筆就診紀錄），否則直接 return 不做任何事。
// 資料流程：
//   1. 設定 state.viewEditMode = true，切換標頭按鈕顯示
//      （隱藏「修改」，顯示「取消」與「儲存」）。
//   2. 切換容器顯示：隱藏 #form-view-container，顯示 #form-edit-container。
//   3. 從 state.currentSelectedRecord 取出 { f, mrn }，複製一份
//      f.symptoms 到 state.veSelectedSymptoms 作為編輯起點（陣列淺拷貝，
//      避免直接修改原始紀錄物件）。
//   4. 目前一律顯示 LINE/病患下拉選單區塊（#ve-admin-fields 設為
//      display:contents，隱藏 #ve-nonadmin-info）——也就是說，無論是否
//      為管理員，都能透過此編輯模式重新選擇 LINE 帳號與病患關係
//      （病歷號變更的權限限制實際上在後端 API 或後續驗證邏輯中判斷，
//      而非在此處直接依 state.isAdmin 隱藏欄位；HTML 中確實仍保留
//      #ve-nonadmin-info 這個「非管理員唯讀資訊」區塊的 DOM 結構，
//      但目前程式碼路徑不會顯示它，維持程式碼原樣、僅在此註明）。
//   5. 重置下拉選單顯示文字與 state.veSelectedLine / veSelectedPair
//      為初始未選狀態。
//   6. 呼叫 loadDischargeCategories() 確保症狀分類資料已就緒，接著
//      renderVEMainCol() 渲染症狀分類欄、renderVESymptomChips() 渲染
//      目前已選症狀（來自步驟 3 複製的資料）。
//   7. 呼叫 loadVELineAccounts() 載入 LINE 帳號下拉選單資料；若原始
//      紀錄 f 本身有 line_account_id，呼叫 selectVELineAccount() 自動
//      預選該帳號，並嘗試依 f.relation 預選對應的關係選項（見
//      onVELineChange 的 preselectRelation 參數），讓使用者一進入編輯
//      模式就看到「目前這筆紀錄本來歸屬於誰」，而非空白的下拉選單。
//   8. 結尾呼叫 validateViewEdit() 決定「儲存」按鈕初始是否可點擊
//      （通常初始狀態下因為尚未變更任何資料，按鈕會是停用的）。
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

  // ── Show LINE + patient pickers for all users ──
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
    await selectVELineAccount(f.line_account_id, actName, f.relation);
  }

  validateViewEdit();
}

// exitViewEditMode(cancelled = false)
// 用途：把 Column 3 從編輯模式切回唯讀檢視模式，不會清空
//       state.currentSelectedRecord（因為離開編輯模式後仍應該顯示
//       原本選中的那筆紀錄的唯讀內容）。
// 觸發時機：
//   - #btn-view-cancel「✕ 取消」按鈕的 onclick（cancelled=true，
//     會顯示「已取消修改」的 toast 提示）。
//   - setFormsState()、loadFormDetail()、selectFormVisit()、
//     window.resetFormsWorkspace() 等在切換病患/分頁前，主動呼叫
//     exitViewEditMode(false)（不顯示取消提示，因為這是系統自動的
//     狀態清理，不是使用者主動按下取消）。
//   - submitViewEdit() 成功送出後呼叫（同樣不顯示取消提示，因為這是
//     「儲存成功後退出編輯模式」而非取消）。
// 資料流程：
//   1. 設定 state.viewEditMode = false。
//   2. 依權限（管理員或本人）重新決定「修改」按鈕是否要顯示，隱藏
//      「取消」與「儲存」按鈕（還原成 selectFormVisit() 一開始設定
//      的按鈕顯示規則）。
//   3. 切換容器顯示：隱藏編輯容器、顯示唯讀檢視容器。
//   4. 若 cancelled 為 true，顯示「已取消修改」的提示 toast（空字串
//      作為第二參數，代表使用預設樣式而非成功/失敗樣式）。
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

// ── VE（View Edit）LINE 帳號下拉選單 ──
// 以下函式與護理師填單分頁的 loadNurseLineAccounts / toggleNurseLineDropdown /
// filterNurseLineAccounts / buildNurseLineItem / selectNurseLineAccount
// 邏輯幾乎完全對應（同樣支援搜尋、pinned 置頂分組），差異僅在於：
//   1. 操作的 DOM 元素前綴為 "ve-" 而非 "nurse-"（各自獨立的 DOM 子樹）。
//   2. 狀態存放在 state.veLineAccounts / state.vePinnedLineIds /
//      state.veSelectedLine，而非 state.nurseLineAccounts 等。
//   3. selectVELineAccount() 多了一個 preselectRelation 參數，用於
//      enterViewEditMode() 進入編輯模式時「自動預選原始紀錄的關係」。
// 因此以下各函式的詳細註解會著重在與護理師版本的差異之處，重複邏輯
// 請參照上方護理師填單區塊的對應函式註解。

// loadVELineAccounts()
// 用途：載入編輯模式的 LINE 帳號下拉選單資料。
// 觸發時機：enterViewEditMode() 進入編輯模式時。
// 對應 API：GET /api/forms/get_line_accounts（與護理師填單分頁共用
//           同一個後端 API，但各自維護獨立的前端狀態與 DOM）。
async function loadVELineAccounts() {
  try {
    const res = await api('GET', '/api/forms/get_line_accounts');
    state.veLineAccounts = (res && Array.isArray(res.accounts)) ? res.accounts : [];
    state.vePinnedLineIds = (res && Array.isArray(res.pinned)) ? res.pinned : (res && Array.isArray(res.pinned_ids) ? res.pinned_ids : []);
    filterVELineAccounts('');
  } catch (e) {
    console.error('loadVELineAccounts error', e);
  }
}

// toggleVELineDropdown()
// 用途：開啟/關閉編輯模式的 LINE 帳號下拉選單，開啟時同樣會靜默刷新
//       帳號與 pinned 清單（邏輯與 toggleNurseLineDropdown 完全對應）。
function toggleVELineDropdown() {
  const dd = document.getElementById('ve-line-dd');
  const pDd = document.getElementById('ve-patient-dd');
  if (pDd) pDd.classList.remove('open');
  if (dd) {
    const isOpen = dd.classList.toggle('open');
    if (isOpen) {
      const searchInput = document.getElementById('ve-line-search');
      if (searchInput) searchInput.focus();
      // Silently refresh accounts so latest pinned items appear immediately
      api('GET', '/api/forms/get_line_accounts').then(res => {
        if (res && Array.isArray(res.accounts)) {
          state.veLineAccounts = res.accounts;
          state.vePinnedLineIds = Array.isArray(res.pinned) ? res.pinned : (Array.isArray(res.pinned_ids) ? res.pinned_ids : []);
          filterVELineAccounts(searchInput ? searchInput.value : '');
        }
      }).catch(() => {});
    }
  }
}

// filterVELineAccounts(query)
// 用途：依搜尋關鍵字過濾並渲染編輯模式的 LINE 帳號列表（含置頂分組），
//       邏輯與 filterNurseLineAccounts 完全對應，差異只在讀寫的 state
//       欄位與 DOM 前綴。
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
    const pinnedIds = state.vePinnedLineIds || [];
    const pinnedAccounts = pinnedIds.map(id => all.find(a => Number(a.id) === Number(id))).filter(Boolean);

    if (pinnedAccounts.length > 0) {
      const pHeader = document.createElement('div');
      pHeader.className = 'nurse-dd-header';
      pHeader.textContent = '置頂';
      container.appendChild(pHeader);
      pinnedAccounts.forEach(a => container.appendChild(buildVELineItem(a)));

      const aHeader = document.createElement('div');
      aHeader.className = 'nurse-dd-header';
      aHeader.textContent = '所有帳號';
      container.appendChild(aHeader);
    }
    all.forEach(a => container.appendChild(buildVELineItem(a)));
  }
}

// buildVELineItem(account)
// 用途：建立編輯模式 LINE 帳號下拉選單中單一項目的 DOM 節點，點擊呼叫
//       selectVELineAccount(id, name)（不帶 preselectRelation，代表
//       使用者手動選擇時不需要自動預選任何關係，交由
//       onVELineChange 依預設規則挑選第一個選項）。
function buildVELineItem(account) {
  const item = document.createElement('div');
  item.className = 'nurse-patient-item';
  item.dataset.accountId = account.id;
  item.textContent = account.name;
  item.onclick = () => selectVELineAccount(account.id, account.name);
  return item;
}

// selectVELineAccount(id, name, preselectRelation = null)
// 用途：選定編輯模式的 LINE 帳號，更新按鈕文字/選中樣式，並觸發載入
//       該帳號對應的病患關係列表。
// 參數 preselectRelation：僅由 enterViewEditMode() 帶入，代表「這筆
//       原始紀錄的關係文字」，用於 onVELineChange() 內自動預選對應的
//       病患關係選項，而不是預設選中第一個——因為進入編輯模式時，
//       應該優先顯示「這筆紀錄原本的狀態」，而不是護理師填單那種
//       「預設選第一個」的全新建檔情境。
// 回傳值：直接 return onVELineChange(...) 的 Promise，讓呼叫端
//         （enterViewEditMode 中用了 await）可以等待病患關係列表載入
//         完成後才繼續往下執行（例如 validateViewEdit()）。
function selectVELineAccount(id, name, preselectRelation = null) {
  const dd = document.getElementById('ve-line-dd');
  if (dd) dd.classList.remove('open');
  const btnText = document.getElementById('ve-line-btn-text');
  if (btnText) btnText.textContent = name;
  state.veSelectedLine = { id, name };

  document.querySelectorAll('#ve-line-items-container .nurse-patient-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.accountId === String(id));
  });

  return onVELineChange(id, preselectRelation);
}

// ── VE（View Edit）病患關係下拉選單 ──
// resetVEPatientDropdown()
// 用途：清空編輯模式的「病患」下拉選單與相關草稿輸入欄位，回到未選擇
//       狀態；邏輯與護理師填單分頁的 resetNursePatientDropdown 對應，
//       差異在於這裡把選取結果存在 state.veSelectedPair（物件），而非
//       護理師版本存在 DOM dataset 上。
// 觸發時機：selectVELineAccount() 換帳號前；enterViewEditMode() 初始化時。
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

// onVELineChange(lineAccountId, preselectRelation = null)
// 用途：載入指定 LINE 帳號已存在的病患關係列表，組成下拉選單選項，
//       並依 preselectRelation 決定要自動預選哪一個選項。
// 觸發時機：selectVELineAccount() 選定/切換帳號後呼叫。
// 對應 API：GET /api/forms/get_existing_relations?line_account_id=<id>
//           （與護理師填單分頁 onNurseLineChange 使用同一個 API）。
// 與 onNurseLineChange 的關鍵差異——自動預選邏輯：
//   - 若有傳入 preselectRelation（代表這是進入編輯模式、要還原原始
//     紀錄狀態的情境）：
//       1. 先檢查虛擬的「帳號本人」項目（firstItem）是否就是要找的關係，
//          若是直接選中它。
//       2. 否則在 API 回傳的既有關係陣列中尋找 relation 完全相符的項目
//          （target），找到則選中該項目（帶入其 pair_id/relation/mrn）。
//       3. 若都找不到，但 preselectRelation 剛好是「帳號本人」文字，
//          則退化為直接建構一個 { 'self', '帳號本人', 原病歷號 } 選中
//          （處理「該帳號在資料庫中其實還沒有帳號本人關係，但這筆
//          record 卻記錄著帳號本人關係」的邊界情況——例如資料在別處
//          被異動過）。
//       4. 若上述都找不到對應項目，才 fallback 選中第一個選項或「新增」，
//          與沒有 preselectRelation 時的行為一致。
//   - 若沒有傳入 preselectRelation（使用者手動切換 LINE 帳號的情境）：
//     直接沿用與 onNurseLineChange 相同的「優先選中帳號本人/第一筆」
//     邏輯。
async function onVELineChange(lineAccountId, preselectRelation = null) {
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
      firstItem = { pair_id: 'self', relation: '帳號本人', mrn: state.currentSelectedRecord?.mrn || '???' };
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

    if (preselectRelation) {
      let target = null;
      if (firstItem && firstItem.relation === preselectRelation) {
        target = firstItem;
      } else if (Array.isArray(relations)) {
        target = relations.find(r => r.relation === preselectRelation);
      }
      if (target) {
        selectVEPatient(target.pair_id, target.relation, target.mrn);
      } else if (preselectRelation === '帳號本人') {
        selectVEPatient('self', '帳號本人', state.currentSelectedRecord?.mrn || '???');
      } else {
        if (firstItem) selectVEPatient(firstItem.pair_id, firstItem.relation, firstItem.mrn);
        else selectVEPatient('new');
      }
    } else {
      if (firstItem) {
        selectVEPatient(firstItem.pair_id, firstItem.relation, firstItem.mrn);
      } else {
        selectVEPatient('new');
      }
    }
  } catch (e) {
    console.error('onVELineChange error', e);
    list.innerHTML = '<div style="padding:12px 14px;color:var(--danger);font-size:13px;">載入失敗</div>';
  }
}

// buildVEPatientItem(r)
// 用途：建立編輯模式「病患」下拉選單中單一既有關係配對的 DOM 節點，
//       邏輯與護理師填單分頁的 buildPatientItem 對應，點擊呼叫
//       selectVEPatient(r.pair_id, r.relation, r.mrn)。
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

// toggleVEPatientDropdown()
// 用途：開啟/關閉編輯模式的「病患」下拉選單。
function toggleVEPatientDropdown() {
  const dd = document.getElementById('ve-patient-dd');
  if (dd) dd.classList.toggle('open');
}

// selectVEPatient(pairId, relation, mrn)
// 用途：選定編輯模式的病患關係後的處理，邏輯與護理師填單分頁的
//       onNursePatientChange 對應，差異在於選取結果存放於
//       state.veSelectedPair（物件形式），而非 DOM dataset。
// 觸發時機：buildVEPatientItem() 項目 onclick；onVELineChange() 自動
//           預選時直接呼叫；「＋ 新增」項目的 onclick（傳入 'new'）。
// 依 pairId 三種模式（見檔案開頭總覽）決定顯示哪些額外輸入欄位：
//   - 'self'：顯示「病歷號（帳號本人）」欄位（#ve-self-mrn-row）。
//   - 'new'：顯示「關係」與「病歷號（新增）」欄位。
//   - 既有整數：不顯示額外欄位。
// 結尾呼叫 validateViewEdit() 重新檢查「儲存」按鈕是否可用（因為换了
// 病患關係，可能已經構成與原始紀錄不同的「有變更」狀態）。
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

// 全域點擊監聽：點擊編輯模式的下拉選單以外區域時自動收合
// （與護理師填單分頁那組監聽器邏輯相同，但作用在 ve- 前綴的 DOM。）
document.addEventListener('click', function(e) {
  const veLineDd = document.getElementById('ve-line-dd');
  if (veLineDd && !veLineDd.contains(e.target)) veLineDd.classList.remove('open');
  const vePatientDd = document.getElementById('ve-patient-dd');
  if (vePatientDd && !vePatientDd.contains(e.target)) vePatientDd.classList.remove('open');
});

// ── VE（View Edit）三欄式症狀選擇器渲染函式 ──
// renderVEMainCol / renderVESymptomSubCol / renderVESymptomChips 三者
// 邏輯與醫師填單分頁的 renderSymptomMainCol / renderSymptomSubCol /
// renderSymptomChips 幾乎完全對應，差異僅在於：
//   1. 操作的 DOM 前綴為 "ve-symptom-" 而非 "symptom-"。
//   2. 狀態存放在 state.veSelectedSymptoms / state.veActiveCategory，
//      獨立於醫師填單分頁的 state.selectedSymptoms / state.activeCategory
//      （兩個分頁可能同時各自有未儲存的症狀選取狀態，互不干擾）。
//   3. 每次症狀勾選/取消後，除了重新渲染畫面，還會額外呼叫
//      validateViewEdit()（醫師填單版呼叫的是 validateDoctorSave()），
//      因為編輯模式的「儲存」按鈕邏輯是「有變更才能儲存」，而非單純
//      「至少選一項症狀就能傳送」。

// renderVEMainCol()
// 用途：渲染編輯模式的「部位/類別」欄。
function renderVEMainCol() {
  const mainList = document.getElementById('ve-symptom-main-list');
  const subCol = document.getElementById('ve-symptom-sub-col');
  if (!mainList) return;
  mainList.innerHTML = '';
  if (subCol) subCol.style.display = 'none';

  const categories = state.dischargeCategories || {};
  Object.keys(categories).forEach(key => {
    const subItems = categories[key];
    const isEmpty = !subItems || typeof subItems !== 'object' || Object.keys(subItems).length === 0;

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

// renderVESymptomSubCol(categoryKey)
// 用途：渲染編輯模式的「衛教項目」欄（欄2），點擊項目切換勾選狀態，
//       並同步更新 state.veSelectedSymptoms、重新渲染欄3已選標籤、
//       呼叫 validateViewEdit() 檢查是否已產生變更。
function renderVESymptomSubCol(categoryKey) {
  const subCol = document.getElementById('ve-symptom-sub-col');
  const subHeader = document.getElementById('ve-symptom-sub-header');
  const subList = document.getElementById('ve-symptom-sub-list');
  if (!subCol || !subList) return;

  subCol.style.display = 'flex';
  if (subHeader) subHeader.textContent = categoryKey;
  subList.innerHTML = '';

  const items = state.dischargeCategories[categoryKey] || {};
  const symptomNames = Object.keys(items);
  symptomNames.forEach(symptomName => {
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

// renderVESymptomChips()
// 用途：渲染編輯模式欄3「已選擇項目」的標籤列，點擊標籤即移除該症狀，
//       並同步呼叫 validateViewEdit()。
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

// ── 編輯模式驗證與確認送出 ──
// validateViewEdit()
// 用途：判斷「查看/修改表單」編輯模式的「💾 儲存」按鈕
//       （#btn-view-confirm）是否應該可點擊。與護理師填單的
//       validateNurseForm() 不同之處在於：這裡不只要求「輸入合法」，
//       還額外要求「與原始紀錄相比確實有變更」（hasChanges），因為
//       這是「編輯既有紀錄」而非「建立新紀錄」，若沒有任何變更就不應
//       該允許送出一次無意義的更新請求。
// 觸發時機：幾乎所有編輯模式的互動都會呼叫此函式，包括症狀勾選/取消、
//           LINE 帳號/病患關係切換、self/new 輸入框的 oninput。
// 驗證邏輯（三個步驟）：
//   1. 判斷症狀是否變更（symptomsChanged）：比較原始 f.symptoms 與
//      目前 state.veSelectedSymptoms 的長度與內容。
//   2. 若尚未選擇 LINE 帳號或病患關係（state.veSelectedLine /
//      veSelectedPair 任一為空），直接停用按鈕並提早 return——因為
//      這兩者是送出 view_edit 請求的必要參數，沒有的話連「是否有
//      變更」都無從比較。
//   3. 依 pairId 三種模式收集「目前的關係/病歷號」值，並執行合法性
//      檢查（valid）：
//        - 'self'：目前關係固定為「帳號本人」，病歷號讀取
//          #ve-self-mrn 輸入框，不可為空。
//        - 'new'：關係與病歷號皆讀取對應輸入框，兩者都不可為空。
//        - 既有整數：直接使用 state.veSelectedPair 記錄的
//          relation/mrn，無需額外驗證（因為這些值來自資料庫既有資料）。
//      另外要求症狀清單不可為空（currentSymptoms.length === 0 視為
//      不合法），理由與醫師填單分頁相同——沒有症狀就沒有衛教內容可推播。
//   4. 比較「目前的 LINE 帳號 id / 關係 / 病歷號」是否與原始紀錄
//      （f.line_account_id / f.relation / mrn）任一不同，若不同視為
//      infoChanged=true。
//   5. 最終規則：hasChanges = symptomsChanged || infoChanged；
//      按鈕可用條件為 valid && hasChanges（合法「且」確實有變更才能按）。
function validateViewEdit() {
  const confirmBtn = document.getElementById('btn-view-confirm');
  if (!confirmBtn) return;

  const { f, mrn } = state.currentSelectedRecord || {};
  if (!f) return;

  // 1. Check if symptoms changed
  const origSymptoms = f.symptoms || [];
  const currentSymptoms = state.veSelectedSymptoms || [];
  let symptomsChanged = false;
  if (origSymptoms.length !== currentSymptoms.length) {
    symptomsChanged = true;
  } else {
    symptomsChanged = currentSymptoms.some(s => !origSymptoms.includes(s));
  }

  if (!state.veSelectedLine || !state.veSelectedPair) {
    confirmBtn.disabled = true;
    return;
  }

  let valid = true;
  const pairId = state.veSelectedPair.pair_id;
  let currentRelation = state.veSelectedPair.relation;
  let currentMrn = state.veSelectedPair.mrn;

  if (pairId === 'self') {
    currentRelation = '帳號本人';
    currentMrn = document.getElementById('ve-self-mrn')?.value.trim() ?? '';
    if (!currentMrn) valid = false;
  } else if (pairId === 'new') {
    currentRelation = document.getElementById('ve-new-relation')?.value.trim() ?? '';
    currentMrn = document.getElementById('ve-new-mrn')?.value.trim() ?? '';
    if (!currentRelation || !currentMrn) valid = false;
  }

  if (currentSymptoms.length === 0) {
    valid = false;
  }

  // 2. Check if info changed
  const origLineId = f.line_account_id || '';
  const origRelation = f.relation || '帳號本人';
  const origMrn = mrn || '';
  const currentLineId = state.veSelectedLine ? state.veSelectedLine.id : '';

  let infoChanged = false;
  if (currentLineId !== origLineId || currentRelation !== origRelation || currentMrn !== origMrn) {
    infoChanged = true;
  }

  // 3. Final validity
  const hasChanges = symptomsChanged || infoChanged;
  confirmBtn.disabled = !(valid && hasChanges);
}

// openConfirmEditModal()
// 用途：點擊「💾 儲存」按鈕時，先在確認 Modal（#modal-confirm-edit）
//       中列出「即將變更成什麼樣子」的摘要（新 LINE 帳號名稱、新的
//       關係/病歷號、新的症狀清單），讓使用者在正式送出前再次確認，
//       避免因為誤觸下拉選單而送出非預期的變更（尤其這裡可能牽涉到
//       「轉移病歷號」這種影響範圍較大的操作）。
// 觸發時機：#btn-view-confirm 的 onclick。
// 前置條件：state.currentSelectedRecord 與
//           state.veSelectedLine/veSelectedPair 皆必須存在，否則直接
//           return（理論上按鈕已被 validateViewEdit() 限制在合法狀態
//           下才能點擊，這裡是防禦性檢查）。
// 資料整理：依 pair_id 三種模式，決定要顯示的「新關係」「新病歷號」
//           文字（與 validateViewEdit 中的收集邏輯一致），組成 HTML
//           字串塞入 #ve-confirm-diff，包含 LINE 帳號名稱、關係+病歷號、
//           症狀數量與逐項唯讀標籤列表。
// 對外部影響：僅開啟確認 Modal，不呼叫任何後端 API；實際送出交由
//             Modal 中「確認修改」按鈕觸發的 submitViewEdit()。
function openConfirmEditModal() {
  if (!state.currentSelectedRecord) return;
  if (!state.veSelectedLine || !state.veSelectedPair) return;

  const diffEl = document.getElementById('ve-confirm-diff');
  if (!diffEl) return;

  const newSymptoms = state.veSelectedSymptoms || [];

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

  openModal('modal-confirm-edit');
}

// submitViewEdit()
// 用途：使用者在確認 Modal 中按下「確認修改」後，真正把編輯結果送往
//       後端，更新既有的正式紀錄（record）。這是「查看/修改表單」
//       編輯模式的終點動作。
// 觸發時機：#modal-confirm-edit 內 #btn-modal-confirm-edit 的 onclick。
// 對應 API：PUT /api/forms/view_edit
//   Request body：
//     {
//       mrn: 原始病歷號（用於後端定位要更新的是哪一筆 record）,
//       checkout_date: 原始看診日期時間（record 的另一半複合鍵，
//                      此欄位視為唯讀，編輯模式不允許修改就診時間）,
//       line_account_id: 使用者目前選中的 LINE 帳號 id
//                         （state.veSelectedLine.id）,
//       pair_id: 'self' | 'new' | <既有整數>（使用者目前選中的病患
//                關係模式）,
//       relation: 目前的關係文字（依 pair_id 分支收集）,
//       new_mrn: 目前的病歷號（依 pair_id 分支收集；命名為 new_mrn
//                是因為即使病歷號沒有真正改變，也統一用這個欄位名稱
//                告知後端「使用者確認後的病歷號」，由後端判斷是否
//                真的有異動）,
//       symptoms: 目前已勾選的症狀陣列（state.veSelectedSymptoms）
//     }
//   Response：{ success: true/false, error? }
//   後端行為（依任務描述）：這個 API 的 upsert 邏輯類似 nurse_create
//   （可能需要建立新的 line_patient_pairs 配對，例如選了 'new'），
//   但作用對象是既有的 record：直接更新該筆 record 的
//   line_patient_pairs_id 與 symptoms 欄位，等同於把這筆看診紀錄
//   「轉移」給不同的 LINE 帳號/關係/病歷號擁有，而不是新增一筆
//   全新的紀錄。
// 資料流程：
//   1. 關閉確認 Modal，停用儲存按鈕避免重複送出。
//   2. 依 pair_id 分支收集 relation/newMrn（與前面兩個函式相同邏輯）。
//   3. 呼叫 API；成功則：
//        a. 顯示成功 toast、呼叫 exitViewEditMode()（不顯示取消提示，
//           因為這是儲存成功後正常退出編輯模式）。
//        b. 呼叫 loadFormsPatientList() 刷新 Column 1（病歷號可能已
//           變更，或病患的 relation/status 徽章需要更新）。
//        c. 計算 targetMrn：若使用者選擇了 'self' 或 'new'，目標病歷號
//           要從對應輸入框重新讀取（因為 state.veSelectedPair.mrn
//           在這兩種模式下可能是空字串或初始值，真正的值在輸入框裡）；
//           若是既有整數 pair_id，直接使用 state.veSelectedPair.mrn
//           （資料庫既有值）；若以上都無法決定，fallback 回原始 mrn。
//        d. 呼叫 loadFormDetail(targetMrn, null, f.checkout_date)
//           重新載入「可能已轉移到新病歷號」的病患的就診紀錄列表，
//           並自動定位到剛剛編輯的那一筆（依原始 checkout_date 比對，
//           因為看診時間本身不會被此次編輯改變）。
//   4. 失敗則顯示帶錯誤訊息的失敗 toast，並重新啟用儲存按鈕讓使用者
//      可以修正後再次嘗試。
async function submitViewEdit() {
  closeModal('modal-confirm-edit');
  if (!state.currentSelectedRecord) return;

  const confirmBtn = document.getElementById('btn-view-confirm');
  if (confirmBtn) confirmBtn.disabled = true;

  const { f, mrn } = state.currentSelectedRecord;

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

  const payload = {
    mrn,
    checkout_date: f.checkout_date,
    line_account_id: state.veSelectedLine.id,
    pair_id: pairId,
    relation,
    new_mrn: newMrn,
    symptoms: state.veSelectedSymptoms || []
  };

  try {
    const res = await api('PUT', '/api/forms/view_edit', payload);

    if (res.success) {
      showToast('✅ 表單已成功修改', 'ok');
      exitViewEditMode();
      loadFormsPatientList();
      
      let targetMrn = mrn;
      if (state.veSelectedPair) {
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

