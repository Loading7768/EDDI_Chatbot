// ════════════════════════════════════════════════════════════════════════
// 檔案總覽 (File Overview)
// ════════════════════════════════════════════════════════════════════════
// 檔名：webpage/admin/js/script.js
//
// 【系統角色】
//   這是「急診出院衛教 LINE Bot 醫護後台管理系統」前端的核心共用腳本，
//   對應搭配的 HTML 外殼是 webpage/admin/html/admin.html。
//   後端由 src/admin_server.py 的 admin_bp Blueprint 透過
//   GET /main/js/<filename> 路由提供本檔案（靜態檔案），並在
//   admin.html 的所有 <script> 標籤中「最先」被載入，因此本檔案
//   定義的全域變數/函式（state、api()、showToast()、esc() 等）
//   會被其餘六支分頁腳本（stats.js / chats.js / forms.js / doctors.js /
//   prompt.js / education.js）直接使用，等同於一個「共用工具層」。
//
// 【本檔案負責的主要功能】
//   1. 全域狀態管理 (state)：跨分頁共用的登入者身分、目前操作中的病歷號、
//      各分頁暫存的資料快取（doctors 清單、表單清單、對話 session 清單、
//      病患清單）。
//   2. API 通訊層 (api())：統一的 fetch 包裝函式，自動帶入 session cookie、
//      自動處理 JSON 序列化，並集中處理「未登入 / 被踢出」(401) 的情境。
//   3. UI 共用元件控制：loading 覆蓋層、toast 訊息、Modal 開關、
//      側邊選單 (sidebar) 展開/收合。
//   4. 登入 / 登出流程：呼叫後端 POST /api/login、POST /api/logout、
//      GET /api/me，並處理「重複登入衝突」「被強制登出」等情境的
//      使用者互動。
//   5. 分頁導覽 (showSection())：控制六個分頁 (.section) 的顯示/隱藏，
//      並依名稱分派至對應分頁腳本的資料載入函式。
//   6. 共用工具函式：esc()（HTML escape，避免 XSS）。
//   7. 頁面初始化：DOMContentLoaded 時呼叫 checkAuth() 驗證登入狀態，
//      並呼叫其他分頁腳本提供的 initBodyDiagramEvents()（人體部位圖初始化，
//      屬 education.js 或 forms.js 的功能，此處僅負責在啟動流程中呼叫）。
//
// 【對應後端 API（皆定義於 src/admin_server.py 的 admin_bp）】
//   - GET  /api/me      → 檢查目前 session 是否已登入
//   - POST /api/login    → 帳號密碼登入（body: {username, password, force}）
//   - POST /api/logout   → 登出，清除 session
//   （其餘分頁專屬 API 由對應分頁 JS 檔呼叫，不在本檔案範圍）
//
// 【權限模型】
//   後台採 Flask session cookie 驗證（非 JWT），所有 fetch 皆帶
//   credentials:'include' 讓瀏覽器自動附上 session cookie。
//   是否為管理員 (is_admin) 由登入回應帶回，決定「醫師帳號管理」
//   「Prompt 修改」兩個分頁是否對使用者顯示（見 initApp()）。
// ════════════════════════════════════════════════════════════════════════

// 將字串格式的日期時間安全地轉換為 Date 物件。
// 用途：後端 SQLite 存的日期時間字串常為 "YYYY-MM-DD HH:MM:SS" 格式，
//       若直接交給 `new Date(str)`，部分瀏覽器（尤其含空格分隔日期與時間
//       的格式）在跨瀏覽器環境下解析結果不一致或直接失敗 (Invalid Date)。
//       因此這裡把字串中的空格取代為 'T'，轉成 ISO 8601 格式
//       ("YYYY-MM-DDTHH:MM:SS")，確保各瀏覽器都能正確解析。
// 參數：str - 原始日期時間字串（可能為 null/undefined/空字串）
// 回傳：Date 物件；若輸入為空值則回傳 null。
// 使用者：本檔案未直接呼叫，主要提供給其他分頁腳本（例如 chats.js 顯示
//        對話時間、stats.js 繪製時間相關圖表）共用，避免各分頁各自
//        寫一套日期解析邏輯造成不一致。
function parseDate(str) {
  if (!str) return null;
  return new Date(str.trim().replace(' ', 'T'));
}

// ── state ──
// 全域共用狀態物件，供本檔案與其餘所有分頁腳本 (stats.js/chats.js/
// forms.js/doctors.js/prompt.js/education.js) 讀寫，等同於一個簡易的
// 「全域 store」（無框架、無響應式綁定，純物件屬性）。
//   - isAdmin        ：目前登入者是否為管理員（由 /api/me 或 /api/login
//                       回應的 is_admin 決定），控制管理員限定分頁的顯示。
//   - account        ：目前登入者的帳號 (account_name)，供各分頁需要標示
//                       「操作者」時使用（例如判斷是否為本人建立的紀錄）。
//   - currentMrn      ：目前在「聊天紀錄」分頁選中的病患病歷號
//                       (medical_record_number)，供 chats.js 判斷目前
//                       顯示哪位病患的對話詳情。
//   - formCurrentMrn  ：目前在「出院單管理」分頁選中/編輯中的病歷號，
//                       與 currentMrn 分開存放是因為兩個分頁可能各自
//                       獨立選取不同病患，互不干擾。
//   - doctors         ：醫師清單快取（doctors.js 從後端抓回後存於此，
//                       供下拉選單等 UI 重複使用，避免重複打 API）。
//   - currentForms    ：目前選中病患的出院單清單快取（forms.js 使用）。
//   - currentSessions ：目前選中病患的 LINE 對話 session 清單快取
//                       （chats.js 使用）。
//   - allPatients     ：聊天紀錄分頁用的病患總表快取（chats.js 用於
//                       搜尋/篩選，避免每次篩選都重新打 API）。
//   - allFormPatients ：出院單管理分頁用的病患總表快取（forms.js 用途
//                       同上，但因兩分頁篩選條件可能不同，分開存放）。
const state = { isAdmin: false, currentMrn: null, formCurrentMrn: null, doctors: [], currentForms: [], currentSessions: [], allPatients: [], allFormPatients: [] };

// ── api ──
// 全站共用的 API 呼叫包裝函式，統一封裝 fetch()，是本系統與後端
// (src/admin_server.py 的 admin_bp 所有路由) 溝通的「唯一入口」，
// 所有分頁腳本呼叫後端 API 皆透過此函式，而非直接使用原生 fetch。
// 參數：
//   method - HTTP 方法字串，例如 'GET' / 'POST' / 'PUT' / 'DELETE'
//   path   - 後端路由路徑，例如 '/api/me'、'/api/chats' 等
//            （相對路徑，瀏覽器會自動以目前網域為基底，對應
//            src/admin_server.py 中以 admin_bp 註冊的路由）
//   body   - 選填，要以 JSON 傳送的 request body（物件），若為
//            undefined 則視為不帶 body 的請求（例如 GET）
// 回傳：後端回應解析後的 JSON 物件（Promise）。
// 行為細節：
//   1. 一律帶入 credentials:'include'，讓瀏覽器自動附上 Flask session
//      cookie，這是後台「登入態」驗證的關鍵（後端靠 session 判斷
//      是否已登入、登入者是誰），本系統不使用 Authorization header
//      或 localStorage token。
//   2. 若有帶 body，自動設定 Content-Type: application/json 並將物件
//      序列化為 JSON 字串。
//   3. 特別處理 HTTP 401（未授權）：
//        - 先嘗試解析錯誤回應 JSON（失敗則視為空物件，避免二次拋錯）。
//        - 若錯誤訊息精確等於「您的帳號已在其他地方登入，此連線已被
//          登出。」，代表使用者是在操作過程中被他處的重複登入踢出，
//          此時開啟 modal-kicked-out 告知使用者。
//        - 其餘 401 情況（例如 session 過期、根本未登入）則以
//          showToast() 顯示錯誤訊息（若無則顯示預設「請先登入」）。
//        - 無論哪種情況，最終都呼叫 showLogin() 強制退回登入畫面，
//          並直接回傳解析出的錯誤物件（呼叫端可依 errData 內容判斷，
//          但因已被導回登入畫面，通常呼叫端後續邏輯不會再執行）。
//   4. 非 401 的情況，直接回傳 res.json()（呼叫端自行檢查
//      success/error 等業務欄位）。
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    const errData = await res.json().catch(() => ({}));
    if (errData.error === '您的帳號已在其他地方登入，此連線已被登出。') {
      openModal('modal-kicked-out');
    } else {
      showToast(errData.error || '請先登入', 'fail');
    }
    showLogin();
    return errData;
  }
  return res.json();
}

// 控制全域「載入中」覆蓋層 (#loading，定義於 admin.html) 的顯示/隱藏。
// 參數：on - true 表示顯示載入動畫（新增 .active class），
//            false 表示隱藏（移除 .active class）。
// 使用情境：各分頁腳本在發送 API 請求前呼叫 loading(true)，等回應
//          處理完畢後（無論成功或失敗）呼叫 loading(false)，避免
//          使用者在等待期間誤以為畫面沒反應而重複操作。
function loading(on) {
  document.getElementById('loading').classList.toggle('active', on);
}

// ── toast ──
// 顯示一則短暫的浮動提示訊息（例如「已儲存」「刪除失敗」），對應
// admin.html 中的 #toast 元素，是全站共用的輕量通知元件。
// 參數：
//   msg  - 要顯示的文字內容
//   type - 選填，樣式類型字串（例如 'success' / 'fail'），由 CSS
//          依 class 名稱決定不同底色/圖示；預設空字串表示中性樣式。
// 行為：先設定文字與 class（含 'show' 觸發淡入動畫），
//      2.8 秒 (2800ms) 後自動移除 'show' class 使其淡出消失，
//      下一次呼叫會覆蓋目前顯示中的訊息（無佇列機制）。
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ── modal ──
// 開啟指定 id 的彈出視窗（Modal）：為該元素加上 'open' class，
// 由 CSS 負責視覺上的淡入/置中顯示（modal-backdrop 系列元件皆遵循
// 此慣例）。各分頁腳本亦可直接呼叫此共用函式開啟自己定義的 Modal。
function openModal(id) { document.getElementById(id).classList.add('open'); }
// 關閉指定 id 的彈出視窗：移除該元素的 'open' class，觸發淡出/隱藏。
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── sidebar ──
// 切換側邊選單 (sidebar) 的展開/收合狀態，由 header 的漢堡選單按鈕
// (#hamburger-btn) 呼叫，主要用於手機版 RWD 版面。
// 邏輯：先檢查 #sidebar 目前是否已帶有 .open class：
//   - 若已展開 → 呼叫 closeSidebar() 收合（避免重複疊加狀態）。
//   - 若未展開 → 同時為 側邊選單本身 (#sidebar)、
//     遮罩層 (#sidebar-overlay)、以及應用程式主容器 (#app) 都加上
//     對應的開啟 class：
//       * #sidebar 加 'open'         → CSS 讓選單滑入畫面
//       * #sidebar-overlay 加 'open' → 顯示半透明遮罩，並讓遮罩本身
//                                       可被點擊以關閉選單（見 admin.html
//                                       的 onclick="closeSidebar()"）
//       * #app 加 'sidebar-open'     → 供 CSS 在選單開啟時調整主內容
//                                       區的呈現（例如加上遮罩效果或
//                                       禁止背景滾動）
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const app = document.getElementById('app');
  if (sb.classList.contains('open')) {
    closeSidebar();
  } else {
    sb.classList.add('open');
    ov.classList.add('open');
    app.classList.add('sidebar-open');
  }
}
// 收合側邊選單：移除 #sidebar / #sidebar-overlay 的 'open' class，
// 以及 #app 的 'sidebar-open' class，還原成選單收合狀態。
// 觸發來源：點擊遮罩層、點擊選單內建的關閉按鈕 (✕)、點擊任一導覽項目
// 切換分頁後（showSection() 內會主動呼叫，讓手機版切換分頁後自動收合
// 選單，提升操作體驗）。
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  document.getElementById('app').classList.remove('sidebar-open');
}

// ── auth ──
// 驗證目前瀏覽器 session 是否已登入，是整個系統啟動流程的第一步，
// 由檔案最下方 DOMContentLoaded 事件監聽器在頁面載入完成後立即呼叫。
// 對應後端 API：GET /api/me（src/admin_server.py 的 admin_bp 路由）
//   - 已登入時回應格式：{ logged_in: true, account, doctor_name, is_admin }
//   - 未登入時回應格式：{ logged_in: false, kicked_out?: true }
//     （kicked_out 為選填欄位，代表此 session 曾存在但被他處的重複
//     登入標記為失效，需特別提示使用者，而非單純「尚未登入」的靜默狀態）
// 處理邏輯：
//   - me.logged_in 為 true → 呼叫 initApp(me) 進入主畫面，並用回應中的
//     帳號資訊初始化 header 顯示與權限控制。
//   - me.logged_in 為 false：
//       * 若 me.kicked_out 為 true → 額外開啟 modal-kicked-out 告知
//         使用者「已被他處登入擠掉」。
//       * 無論是否被踢出，最終都呼叫 showLogin() 顯示登入畫面。
async function checkAuth() {
  const me = await api('GET', '/api/me');
  if (me.logged_in) {
    initApp(me);
  } else {
    if (me.kicked_out) {
      openModal('modal-kicked-out');
    }
    showLogin();
  }
}

// 顯示登入畫面、隱藏應用程式主體。
// 透過直接操作 inline style.display（而非 class）切換，與 #app 的顯示
// 邏輯互為鏡像，兩者同時只會有一個是可見的。
// 觸發來源：checkAuth() 判定未登入時、executeLogout()/doLogout() 登出完成後、
// api() 攔截到 401 時。
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// 登入成功後初始化整個應用程式主畫面，是連接「登入結果」與「主畫面
// 顯示狀態」的關鍵函式。
// 參數：me - 登入者資訊物件，來源可能是：
//   1. checkAuth() 呼叫 GET /api/me 的回應（頁面重新整理、已有 session 時）
//   2. doLogin() 呼叫 POST /api/login 成功後手動組出的
//      { doctor_name, is_admin, account } 物件（結構與 /api/me 略有差異，
//      但本函式只用到這三個共同欄位，因此可以互通）
// 主要動作：
//   1. 將登入者的管理員身分 (isAdmin) 與帳號 (account) 寫入全域 state，
//      供其餘分頁腳本讀取判斷權限或標示操作者。
//   2. 切換顯示：隱藏登入畫面、顯示應用程式主體 (#app)。
//   3. 更新 header 上的使用者資訊：姓名 (#header-name) 直接顯示，
//      身分標籤 (#header-role) 依 is_admin 顯示不同文字與樣式 class
//      (role-admin / role-doctor)，讓管理員視覺上可與一般醫師區分。
//   4. 權限控制 UI：找出所有帶有 .admin-only class 的元素（即側邊選單
//      的「醫師帳號管理」「Prompt 修改」），若非管理員則強制隱藏
//      (display:none)，是管理員則還原顯示（清空 inline style，交還
//      給原本的 CSS 規則決定顯示方式）。此為前端 UX 層級的隱藏，
//      對應的後端 API 仍會各自驗證權限，不可僅靠此處隱藏做安全防護。
//   5. 決定登入後預設顯示的分頁：讀取 localStorage 中
//      'admin_active_section'（記錄使用者上次停留的分頁），若沒有記錄
//      則預設 'stats'。但若記錄的分頁是管理員限定的 'prompt' 或
//      'doctors'，而目前登入者「不是」管理員，則強制改回 'stats'，
//      避免一般醫師的瀏覽器殘留了管理員分頁的記錄卻無法正常顯示內容。
//      最後呼叫 showSection() 實際切換並載入該分頁資料。
function initApp(me) {
  state.isAdmin = me.is_admin;
  state.account = me.account || '';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  document.getElementById('header-name').textContent = me.doctor_name;
  const roleEl = document.getElementById('header-role');
  roleEl.textContent = me.is_admin ? '醫師 (管理員)' : '醫師';
  roleEl.className   = 'role-tag ' + (me.is_admin ? 'role-admin' : 'role-doctor');

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = me.is_admin ? '' : 'none';
  });

  const savedSection = localStorage.getItem('admin_active_section') || 'stats';
  const targetSection = (savedSection === 'prompt' || savedSection === 'doctors') && !me.is_admin ? 'stats' : savedSection;
  showSection(targetSection);
}

// 執行登入流程，由登入按鈕 (#login-btn) 的 onclick 觸發，也會由「重複
// 登入衝突」Modal 中的「在此處登入（強制登出另一邊）」按鈕以 force=true
// 呼叫。
// 參數：force - 是否強制登入並踢掉已存在的另一邊 session（預設 false，
//              即一般登入嘗試；true 則是使用者在確認衝突提示後的
//              二次呼叫）。
// 對應後端 API：POST /api/login
//   request body：{ username, password, force }
//   response（成功）：{ success:true, doctor_name, is_admin, account }
//   response（帳號密碼錯誤等一般失敗）：{ success:false, error } (400/401/500)
//   response（偵測到重複登入衝突，force 未帶或為 false 時）：
//                 { success:false, conflict:true }（依系統背景說明推斷，
//                 用來與一般登入失敗區分，觸發彈出確認 Modal 而非直接
//                 顯示錯誤訊息）
// 執行流程：
//   1. 讀取帳號/密碼輸入框的值（帳號會 trim 去除頭尾空白，密碼不 trim
//      避免使用者密碼本身含有意義上的空白被誤刪），清空前次的錯誤訊息。
//   2. 前端基本驗證：帳號或密碼為空則直接顯示錯誤、不送出請求
//      （減少無意義的 API 呼叫）。
//   3. 將登入按鈕替換成 loading 文字（含 spinner）並設為 disabled，
//      避免使用者連續點擊造成重複送出多次登入請求。
//   4. 呼叫 api('POST', '/api/login', {...}) 送出登入請求：
//        - res.success 為 true → 登入成功：關閉可能開著的
//          modal-session-conflict（若這次是 force=true 的重試），並呼叫
//          initApp() 帶入後端回應的使用者資訊，進入主畫面。
//        - res.conflict 為 true（隱含 success 為 false）→ 開啟
//          modal-session-conflict，讓使用者選擇是否強制登入。
//        - 其餘情況（帳號密碼錯誤、伺服器錯誤等一般失敗）→ 把
//          res.error（或預設「登入失敗」）顯示在 #login-error。
//   5. try/catch 額外處理網路層級錯誤（例如伺服器完全無回應、
//      fetch 拋出例外），顯示「無法連線至伺服器」。
//   6. finally 區塊確保無論成功/失敗，登入按鈕都會還原成可點擊狀態
//      （避免因例外導致按鈕永遠停留在 disabled/loading 狀態）。
async function doLogin(force = false) {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';

  if (!username || !password) { errEl.textContent = '請填寫帳號和密碼'; return; }

  const btn = document.getElementById('login-btn');
  btn.innerHTML = '<span class="spinner-white"></span> 登入中…';
  btn.disabled  = true;

  try {
    const res = await api('POST', '/api/login', { username, password, force });
    if (res.success) {
      closeModal('modal-session-conflict');
      initApp({ doctor_name: res.doctor_name, is_admin: res.is_admin, account: res.account });
    } else if (res.conflict) {
      openModal('modal-session-conflict');
    } else {
      errEl.textContent = res.error || '登入失敗';
    }
  } catch { errEl.textContent = '無法連線至伺服器'; }
  finally  { btn.innerHTML = '登入'; btn.disabled = false; }
}

// 切換登入表單中密碼輸入框的顯示/隱藏狀態（純前端 UI 行為，不涉及
// 任何 API 呼叫），由密碼欄位旁的眼睛圖示按鈕 (#toggle-pass-btn) 觸發。
// 邏輯：檢查 input 目前的 type 屬性：
//   - 若目前是 'password'（隱藏中）→ 改為 'text'（顯示明文），並將
//     按鈕圖示、aria-label、title 都改為「隱藏密碼」的狀態（👁️ 圖示，
//     提示點擊後會重新隱藏）。
//   - 若目前是 'text'（顯示中）→ 改回 'password'（重新遮蔽），圖示與
//     提示文字還原為「顯示密碼」（🙈 圖示）。
// 這只影響瀏覽器如何「呈現」輸入框內容，不影響 doLogin() 讀取到的
// 實際密碼值。
function togglePasswordVisibility() {
  const passInput = document.getElementById('login-pass');
  const toggleBtn = document.getElementById('toggle-pass-btn');
  if (passInput.type === 'password') {
    passInput.type = 'text';
    toggleBtn.textContent = '👁️';
    toggleBtn.setAttribute('aria-label', '隱藏密碼');
    toggleBtn.setAttribute('title', '隱藏密碼');
  } else {
    passInput.type = 'password';
    toggleBtn.textContent = '🙈';
    toggleBtn.setAttribute('aria-label', '顯示密碼');
    toggleBtn.setAttribute('title', '顯示密碼');
  }
}

// 實際執行登出動作，由 admin.html 的「確認登出」Modal
// (modal-confirm-logout) 中「確認登出」按鈕觸發，是目前系統 UI
// 實際使用的登出入口（登出流程已改為自訂 Modal 二次確認，而非瀏覽器
// 原生 confirm()，詳見下方 doLogout() 的說明）。
// 對應後端 API：POST /api/logout（無 request body），
//   response：{ success:true }（後端清除 Flask session cookie）。
// 執行流程：
//   1. 關閉確認登出的 Modal。
//   2. 清除 localStorage 中記錄的 'admin_active_section'，讓下次登入
//      不會嘗試恢復到登出前的分頁（回到預設 stats 分頁），避免下一位
//      登入者（可能是不同醫師）意外停留在前一位使用者最後檢視的分頁。
//   3. 呼叫 POST /api/logout 通知後端清除 session。
//   4. 重置全域狀態 state.currentMrn 為 null（清空「目前選中病患」的
//      殘留狀態，避免下次登入誤用到舊資料）。
//   5. 若 forms.js 有掛載全域函式 window.resetFormsWorkspace（先用
//      typeof 檢查其存在，避免因腳本載入順序或該分頁未載入而拋出
//      ReferenceError），則呼叫它清空出院單編輯區的暫存工作內容
//      （例如尚未送出的草稿），避免資料殘留造成下一位使用者困惑或
//      資安風險（例如仍看得到上一位醫師編輯中的病患資料片段）。
//   6. 清空登入表單的帳號/密碼輸入框內容（避免帳密殘留在畫面上）。
//   7. 呼叫 showLogin() 顯示登入畫面。
async function executeLogout() {
  closeModal('modal-confirm-logout');
  localStorage.removeItem('admin_active_section');
  await api('POST', '/api/logout');
  state.currentMrn = null;
  if (typeof window.resetFormsWorkspace === 'function') window.resetFormsWorkspace();
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  showLogin();
}

// 舊版/備用登出函式：邏輯與 executeLogout() 完全相同，差異僅在於
// 使用瀏覽器原生的 window.confirm() 對話框做二次確認，而非開啟自訂的
// modal-confirm-logout Modal。目前 admin.html 的登出按鈕已改為呼叫
// openModal('modal-confirm-logout') → executeLogout()，此函式在目前
// UI 中沒有任何 HTML 元素綁定呼叫它，保留於此可能是為了向下相容
// （例如舊版本 HTML、或供其他尚未更新的呼叫點/除錯用途），不影響現行
// 登出流程的行為。
async function doLogout() {
  if (!confirm('確定要登出系統嗎？')) {
    return;
  }
  localStorage.removeItem('admin_active_section');
  await api('POST', '/api/logout');
  state.currentMrn = null;
  if (typeof window.resetFormsWorkspace === 'function') window.resetFormsWorkspace();
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  showLogin();
}

// 為密碼輸入框綁定 keydown 事件：讓使用者在密碼欄位按下 Enter 鍵時
// 直接觸發登入 (doLogin())，無需額外用滑鼠點擊「登入」按鈕，
// 提升鍵盤操作的使用體驗（等同於表單的預設送出行為，但此處是手動
// 綁定而非用 <form> 的 submit 事件，因為登入區塊沒有包在 <form> 標籤內）。
document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// ── navigation ──
// 分頁切換的核心函式，是六個分頁 (stats/chats/forms/doctors/prompt/
// education) 之間導覽的唯一入口，由側邊選單的 .nav-item 點擊事件呼叫
// （見 admin.html），也會在 initApp() 登入完成後被呼叫以顯示預設分頁。
// 參數：name - 分頁識別字串，必須對應：
//        1. 某個 .nav-item 元素的 data-sec 屬性值
//        2. 某個分頁容器元素的 id（格式為 'section-' + name，
//           例如 name='stats' 對應 id="section-stats"，定義在對應的
//           stats.html 等被 include 進 admin.html 的分頁檔案內）
// 執行流程：
//   1. 將本次要顯示的分頁名稱寫入 localStorage
//      (key: 'admin_active_section')，讓使用者重新整理頁面或重新登入
//      後（見 initApp()）能自動回到上次瀏覽的分頁，提升操作連續性。
//   2. 先移除所有 .section 與 .nav-item 元素目前的 .active class
//      （清空狀態），再只為「目前目標分頁」的容器與導覽項目加上
//      .active（這是 CSS 決定顯示/隱藏、以及選單項目高亮樣式的依據；
//      因六個分頁的 HTML 皆已同時存在於 DOM 中，此處純粹是顯示狀態
//      切換，不會有任何網路請求去抓取分頁的 HTML 內容）。
//   3. 呼叫 closeSidebar()，讓手機版在選擇分頁後自動收合側邊選單。
//   4. 依 name 分派呼叫對應分頁腳本定義的資料載入函式，確保每次切換
//      進入該分頁時都拿到最新資料（而不是沿用可能已過期的舊資料）：
//        - 'stats'   → loadStats()（定義於 stats.js，呼叫統計相關 API）
//        - 'chats'   → loadChats()（定義於 chats.js，呼叫聊天紀錄相關 API）
//        - 'forms'   → loadFormsPatientList()（定義於 forms.js，載入
//                       出院單管理分頁的病患清單）
//        - 'prompt'  → loadPrompt()（定義於 prompt.js，載入 LLM system
//                       prompt 版本資料，僅管理員可見/可用）
//        - 'doctors' → loadDoctors()（定義於 doctors.js，載入醫師帳號
//                       清單，僅管理員可見/可用）
//        - 'education' 沒有對應的 if 分支：推測 education.js 採用不同的
//          初始化時機（例如頁面載入時就先載入好、或監聽其他事件），
//          並非每次切換分頁才重新拉取資料；本檔案不修改該分頁邏輯。
function showSection(name) {
  localStorage.setItem('admin_active_section', name);
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('section-' + name).classList.add('active');
  document.querySelector(`[data-sec="${name}"]`).classList.add('active');
  closeSidebar();

  if (name === 'stats')   loadStats();
  if (name === 'chats')   loadChats();
  if (name === 'forms')   loadFormsPatientList();
  if (name === 'prompt')  loadPrompt();
  if (name === 'doctors') loadDoctors();
}


// ── utils ──
// HTML escape 工具函式：將字串中會被瀏覽器解析為 HTML 標籤/屬性語法的
// 特殊字元轉換為對應的 HTML 實體，是全站防止 XSS（跨站腳本攻擊）的
// 關鍵共用函式。任何分頁腳本在用字串拼接方式產生 innerHTML（例如把
// 後端回傳的病患姓名、對話內容等使用者輸入資料插入頁面）時，都應該
// 先透過 esc() 處理，避免惡意內容（例如 <script>）被瀏覽器當作真正的
// HTML/JS 執行。
// 參數：s - 任意值（可能是 undefined/null/數字/字串等）
// 回傳：轉換後的安全字串。
// 實作細節：
//   - `s ?? ''`：若 s 為 null 或 undefined，視為空字串（避免
//     String(null) 變成字面上的 "null" 顯示在畫面上）。
//   - 依序轉換：& → &amp;（必須最先處理，否則後續轉換出的
//     &lt;/&gt;/&quot; 中的 & 會被二次轉換造成顯示錯誤）、
//     < → &lt;、> → &gt;、" → &quot;（雙引號轉換可避免注入破壞
//     屬性值，例如 title="xxx" 中的 xxx 若含有雙引號會提前結束屬性）。
//   - 未轉換單引號 (')，若呼叫端是以雙引號包住 HTML 屬性則安全，
//     但若用單引號包屬性則仍有風險，使用時需留意屬性引號的搭配。
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── init ──
// 整個後台前端應用程式的啟動點：等待瀏覽器完成 DOM 解析
// （DOMContentLoaded，不等待圖片等外部資源載入完成，因此啟動速度較快）
// 後依序執行：
//   1. initBodyDiagramEvents()：初始化人體部位圖（body diagram）相關的
//      互動事件綁定。此函式並非定義在本檔案，而是由其他分頁腳本
//      （依系統慣例推測為 education.js 或 forms.js，用於「衛教資料
//      管理」選擇身體部位、或「出院單管理」標記症狀部位等功能）提供，
//      因為 admin.html 載入順序上 script.js 最先執行，但實際定義該
//      函式的分頁腳本會在 script.js 之後才載入 —— 這仰賴瀏覽器對
//      <script> 標籤採用「循序下載但只在全部到位、DOMContentLoaded
//      觸發時才執行此處回呼」的行為，此時所有 <script> 均已執行完畢、
//      函式皆已定義在全域作用域，因此可以安全呼叫。
//   2. checkAuth()：檢查登入狀態並據此顯示登入畫面或應用程式主畫面
//      （見上方說明），是實際決定使用者「看到什麼」的關鍵呼叫。
document.addEventListener('DOMContentLoaded', () => {
  initBodyDiagramEvents();
  checkAuth();
});
