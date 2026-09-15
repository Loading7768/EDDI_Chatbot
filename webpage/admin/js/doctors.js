// ════════════════════════════════════════════════════════════════════════
// 檔案總覽（doctors.js）
// ════════════════════════════════════════════════════════════════════════
// 【角色定位】
//   本檔案是「醫護後台管理系統」中「醫師帳號管理」分頁（section-doctors，
//   對應的 HTML 結構位於 webpage/admin/html/doctors.html）的前端邏輯層。
//   本分頁僅供管理員（is_admin === 1）使用；一般醫師登入後端雖然仍會載入
//   此 JS 檔案，但畫面上不會顯示這個分頁的連結（由側邊選單依 is_admin 控
//   制），且若一般醫師嘗試直接呼叫這裡的寫入類函式，後端 API 也會因為
//   `@admin_required` 裝飾器而回傳 403 `{error:'此功能僅限管理員'}`，
//   前端不會、也不應該自行繞過此限制。
//
// 【主要功能】
//   1. 載入並渲染醫師帳號列表（帳號、姓名、科別、啟用狀態、角色、操作）。
//   2. 新增醫師帳號（並顯示系統自動產生的隨機密碼，僅顯示一次）。
//   3. 編輯醫師資料（姓名、科別、啟用狀態、管理員權限、重設密碼）。
//   4. 刪除醫師帳號（僅允許刪除「從未看診過」且「不是自己」的帳號）。
//   5. 科別（department / specialty）管理：新增、改名、啟用/停用、刪除。
//      科別是醫師的自由文字欄位，但透過下拉選單 + 白名單機制統一管理，
//      避免同一個科別因為打字不同而產生多個變體（例如「小兒科」與
//      「小兒科 」）。
//
// 【資料來源與相依性】
//   - 全域變數 `state`（定義於 script.js）：本檔案使用 `state.doctors`
//     暫存目前載入的醫師陣列，供其他分頁（例如病歷分頁的醫師篩選器）
//     共用讀取，避免重複打 API。
//   - 共用工具函式（皆定義於 script.js，本檔案直接呼叫、不重新定義）：
//       api(method, path, body)  → 包裝 fetch()，統一處理
//                                   credentials/JSON/401 自動登出。
//       esc(str)                 → HTML escape，避免 XSS。
//       showToast(msg, type)     → 畫面右下角提示訊息。
//       openModal(id)/closeModal(id) → 開關 Modal（透過切換 'open' class）。
//
// 【權限重點提醒（務必知悉「為什麼」）】
//   - 後端在 PUT /api/doctors/<account> 中，若目前登入者要把「自己」的
//     is_admin 從 1 改為 0，會先檢查系統是否還有其他管理員帳號；若沒有
//     則直接拒絕（400），避免系統落入「沒有任何管理員可以操作後台」的
//     死鎖狀態。前端本身沒有額外檔這個限制，是刻意交給後端做最終把關，
//     前端只需把後端回傳的錯誤訊息顯示出來即可（見 saveDoctorEdit）。
//   - can_delete（見 loadDoctors）也是後端計算好直接回傳的欄位，前端只
//     負責依照這個布林值決定「刪除」按鈕是否要 disabled，實際的規則判斷
//     （是否有看診紀錄、是否為自己）完全由後端負責，避免前後端邏輯不同步。
// ════════════════════════════════════════════════════════════════════════

// ── doctors ──
// ─────────────────────────────────────────────────────────────────────────
// loadDoctors()
// ─────────────────────────────────────────────────────────────────────────
// 用途：向後端請求「目前所有醫師帳號」的完整列表，並渲染到
//       #doctor-tbody（doctors.html 中 <table id="doctor-table"> 的
//       <tbody>）。這是本分頁的「主畫面」渲染函式。
// 觸發時機：
//   - 分頁初次載入 / 切換到此分頁時（由外部的分頁切換邏輯呼叫）。
//   - 新增醫師成功關閉 Modal 時（closeAddDoctorModal(true)）。
//   - 編輯醫師儲存成功時（saveDoctorEdit 內）。
//   - 刪除醫師成功時（deleteDoctor 內）。
//   - 科別改名成功時（executeRenameDepartment 內，因為改名會影響列表中
//     顯示的科別文字，需要重新抓一次醫師資料以取得最新的 specialty）。
// 對應後端 API：GET /api/doctors
//   Request：無 body，僅靠 session cookie 判斷身分（api() 內已自動帶入
//            credentials: 'include'）。
//   Response：JSON 陣列，每個元素形如
//     {
//       doctor_id, account_name, doctor_name,
//       is_active,      // 0/1，帳號是否可登入
//       is_admin,       // 0/1，是否為管理員角色
//       specialty,      // 科別名稱字串（對應資料庫 department 欄位）
//       can_delete      // 布林值，由後端計算：
//                       //   該醫師沒有任何看診紀錄(record) 且
//                       //   不是目前登入者自己 → true，才允許刪除。
//                       //   之所以要禁止刪除「已看診過」的醫師，是為了
//                       //   保留歷史病歷資料的可追溯性（外鍵/紀錄仍會
//                       //   指向這個醫師帳號）；禁止刪除「自己」則是
//                       //   避免操作者把自己登入用的帳號刪掉造成無法
//                       //   再次登入。
//     }
// 渲染邏輯：
//   1. 先把 tbody 內容換成「載入中…」的提示列（loading 骨架畫面）。
//   2. 呼叫 API 拿到陣列後存入 state.doctors（供其他模組共用）。
//   3. 若陣列為空，顯示「無資料」。
//   4. 否則以 Array.map 對每一筆醫師產生一個 <tr>：
//        - 帳號欄：用 <code> 包裝顯示 account_name（唯讀樣式）。
//        - 姓名欄：doctor_name。
//        - 科別欄：以 badge-blue 顯示 specialty，若為空字串則預設顯示
//          「急診科」（純前端顯示層 fallback，不會真的寫回資料庫）。
//        - 狀態欄：is_active 為真 → 綠色 badge「啟用」；否則灰色「停用」。
//        - 角色欄：is_admin 為真 → 橘色 badge「管理員」；否則藍色「醫師」。
//        - 操作欄：
//            「✏️ 修改」按鈕 → 呼叫 openDoctorEditModal(...)，把這一列的
//              資料（帳號、姓名、is_active、is_admin、specialty）以參數
//              形式帶入，開啟編輯 Modal 並預填欄位。
//            「🗑️ 刪除」按鈕 → 呼叫 deleteDoctor(account, name)；若
//              can_delete 為 false，則按鈕會被加上 disabled 屬性並顯示
//              title 提示「已看過病人，無法刪除」，讓使用者在點擊前就
//              能理解為什麼無法刪除，不需要等後端回傳 400 才知道原因。
// 錯誤情境：
//   - fetch/JSON 解析或其他例外會被 catch 到，並將 tbody 內容換成一列
//     紅字（color:var(--danger)）錯誤訊息「載入失敗：<錯誤內容>」，
//     內容以 esc() 處理避免把非預期字串當成 HTML 注入。
//   - 若後端因為未登入回傳 401，api() 內部已經統一處理（顯示 toast、
//     觸發登出流程），這裡的 try/catch 主要處理「非 401 的例外」。
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
    // 將每一筆醫師資料轉換成一列 <tr> 字串，再用 join('') 串接成完整 tbody 內容。
    // 注意：所有帶入 HTML 的動態文字都經過 esc() 處理以防止 XSS；
    // 而傳入 onclick="..." 內的參數（account_name/doctor_name/specialty）
    // 同樣先經過 esc() 才拼接進單引號字串中，避免特殊字元break掉屬性。
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

// ─────────────────────────────────────────────────────────────────────────
// openDoctorEditModal(account, name, isActive, isAdmin, specialty)
// ─────────────────────────────────────────────────────────────────────────
// 用途：開啟「修改醫師資料」Modal（#modal-doctor），並把該筆醫師目前的
//       資料預先填入表單各欄位，讓管理員可以直接在既有值上修改。
// 觸發時機：使用者在醫師列表點擊某一列的「✏️ 修改」按鈕
//           （loadDoctors 產生的按鈕 onclick 會帶入這一列的資料）。
// 參數：
//   account  - 帳號（account_name），存入隱藏欄位 #edit-doctor-account
//              供之後 saveDoctorEdit() 讀取，用來組成 API 路徑；同時也
//              顯示在唯讀欄位 #edit-doctor-account-show（帳號建立後
//              不可修改，因此該欄位在 HTML 上被設為 disabled）。
//   name     - 醫師姓名，填入 #edit-doctor-name。
//   isActive - 0/1，填入 #edit-doctor-active 下拉選單（啟用/停用）。
//   isAdmin  - 0/1，填入 #edit-doctor-admin 下拉選單（醫師/管理員）。
//   specialty- 科別名稱字串，透過 populateSpecialtySelect() 動態載入
//              目前所有可選科別，並把這個值設為選單的預設選中項；若
//              這個科別不在目前啟用中的科別清單裡（例如科別後來被停用
//              了，但這位醫師的資料還沒被改），則會自動切換成「➕ 新增
//              其他科別」的自訂輸入模式，把原本的值填入自訂輸入框，
//              避免資料被靜默改掉。
// 對外部影響：
//   - 重置 #edit-doctor-pw（新密碼欄位）為空字串：這是刻意設計——編輯
//     Modal 每次開啟都不應該顯示或保留上一次輸入過的密碼，且「留空」
//     在 saveDoctorEdit() 中代表「不修改密碼」，因此預設必須是空的。
//   - 清空 #doctor-modal-error 的錯誤訊息（避免殘留上一次的錯誤提示）。
//   - 最後呼叫 openModal('modal-doctor') 顯示 Modal。
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

// ─────────────────────────────────────────────────────────────────────────
// saveDoctorEdit()
// ─────────────────────────────────────────────────────────────────────────
// 用途：讀取「修改醫師資料」Modal 中目前填寫的所有欄位值，做基本的前端
//       必填檢查後，送出 PUT 請求更新該醫師在資料庫中的資料。
// 觸發時機：使用者在 #modal-doctor 中點擊「💾 儲存」按鈕。
// 前端驗證：
//   - 姓名（name）不可空白，否則顯示錯誤「姓名不可空白」並中止，不送出
//     API 請求（省一次無意義的網路來回）。
//   - 科別（specialty）不可空白，否則顯示「科別不可空白」並中止。
//   - 密碼欄位（pw）沒有必填限制：留空代表「這次不重設密碼」，只有在
//     使用者真的輸入了新密碼時，才會把 new_password 加進 payload 一併
//     送出（見下方 `if (pw) payload.new_password = pw;`）。這樣設計是
//     因為後端絕不回傳/儲存明文密碼，前端也沒有任何方式能「顯示目前的
//     密碼」，所以密碼欄位在編輯情境下永遠是空的，只有填了才視為要修改。
// 對應後端 API：PUT /api/doctors/<account>
//   Request body（依實際填寫，可能包含）：
//     {
//       doctor_name: string,   // 姓名
//       specialty:   string,   // 科別
//       is_active:   0|1,      // 帳號啟用狀態
//       is_admin:    0|1,      // 是否為管理員角色
//       new_password: string  // 選填，若有值則後端會重新雜湊(sha256)並
//                              // 覆蓋 password_hash 欄位
//     }
//   Response（成功）：{ success: true }
//   Response（失敗，例如 400）：{ error: '錯誤訊息文字' }
//     常見錯誤情境（由後端把關，前端僅原樣顯示）：
//       - 若目前登入者正在編輯「自己」，且把 is_admin 從 1 改成 0，而
//         系統中沒有其他管理員帳號，後端會拒絕並回傳
//         「無法修改角色：系統必須保留至少一位管理員」。這麼做是為了
//         防止整個後台系統陷入「沒有任何人擁有管理員權限」的死鎖狀態
//         （屆時沒有人能再把權限改回來）。前端不重複驗證這條規則，
//         全權交由後端判斷，只需把 res.error 顯示在 #doctor-modal-error。
// 成功後的處理：
//   - 關閉 Modal（closeModal('modal-doctor')）。
//   - 顯示成功 toast「✅ 醫師資料已更新」。
//   - 重新呼叫 loadDoctors() 讓列表反映最新資料（重新整理整張表格）。
// 失敗後的處理：
//   - 不關閉 Modal，讓使用者可以繼續修改；將 res.error（或預設文字
//     「儲存失敗」）顯示在 #doctor-modal-error。
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

// ─────────────────────────────────────────────────────────────────────────
// openAddDoctorModal()
// ─────────────────────────────────────────────────────────────────────────
// 用途：開啟「新增醫師帳號」Modal（#modal-add-doctor），並把表單重置為
//       初始空白狀態，同時動態載入目前可選的科別清單。
// 觸發時機：使用者點擊分頁右上角「➕ 新增醫師帳號」按鈕
//           （doctors.html 內 onclick="openAddDoctorModal()"）。
// 邏輯細節：
//   - 清空帳號 / 姓名輸入框，重置狀態為「啟用」、角色為「醫師」（一般
//     角色是較安全的預設值，避免不小心新增出一個管理員帳號）。
//   - 清空錯誤訊息區塊 #add-doctor-modal-error。
//   - 這個 Modal 內部有兩個子容器：
//       #add-doctor-form-container   → 填寫表單的畫面（新增前顯示）
//       #add-doctor-success-container → 新增成功後顯示帳號+隨機密碼的畫面
//     開啟時一律顯示表單容器、隱藏成功容器，確保每次重新打開都是從頭
//     填寫的乾淨狀態（不會殘留上一次建立成功的畫面）。
//   - 呼叫 populateSpecialtySelect() 重新向後端拉取 /api/departments，
//     動態產生科別下拉選單（因為科別清單可能隨時被管理員新增/停用）。
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

// ─────────────────────────────────────────────────────────────────────────
// closeAddDoctorModal(shouldReload = false)
// ─────────────────────────────────────────────────────────────────────────
// 用途：關閉「新增醫師帳號」Modal。
// 觸發時機：
//   - 表單畫面中點擊「取消」按鈕 → 呼叫時不帶參數（shouldReload 預設
//     false，因為使用者放棄新增，列表不需要重新整理）。
//   - 成功建立帳號後，密碼顯示畫面中點擊「關閉<br>視窗」按鈕
//     → 呼叫時帶入 true（onclick="closeAddDoctorModal(true)"），代表
//       這次關閉必須同時重新整理醫師列表，因為資料庫已經多了一筆新的
//       醫師帳號，畫面需要顯示出來。
// 參數：shouldReload - 是否在關閉 Modal 後重新呼叫 loadDoctors() 刷新
//                       表格內容。
function closeAddDoctorModal(shouldReload = false) {
  closeModal('modal-add-doctor');
  if (shouldReload) {
    loadDoctors();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// submitAddDoctor()
// ─────────────────────────────────────────────────────────────────────────
// 用途：讀取「新增醫師帳號」表單填寫的資料，做前端必填檢查後送出 POST
//       請求建立新醫師帳號；成功後切換 Modal 內容為「密碼顯示畫面」。
// 觸發時機：使用者在 #modal-add-doctor 表單中點擊「建立帳號」按鈕。
// 前端驗證：
//   - 帳號（account）與姓名（name）皆不可空白，否則顯示
//     「帳號與姓名不可空白」。（帳號格式「僅限英文、數字、底線」的
//     實際規則驗證是由後端負責，前端 HTML 上僅用 placeholder 提示，
//     沒有另外用正規表達式擋，若格式不符，會由後端回傳 res.error。）
//   - 科別（specialty）不可空白，否則顯示「科別不可空白」。
// 對應後端 API：POST /api/doctors
//   Request body：
//     {
//       account_name: string,  // 登入帳號，僅限英數字+底線，建立後
//                               // 無法修改（對應 UNIQUE 欄位）
//       doctor_name:  string,  // 醫師姓名
//       specialty:    string,  // 科別；若為系統中尚未存在的新名稱，
//                               // 後端會自動同步寫入 data/departments.json，
//                               // 不需要額外呼叫 /api/departments 新增。
//       is_active:    0|1,
//       is_admin:     0|1
//     }
//   Response（成功）：{ success: true, password: '隨機產生的8碼明文密碼' }
//     — 這是整個系統中「唯一」會把明文密碼傳回前端的時刻。因為密碼在
//       資料庫中僅以 sha256 雜湊值儲存，一旦這次的 HTTP 回應結束，
//       之後任何 API 都無法再取得這個明文密碼，所以前端必須把它清楚
//       顯示給操作者，並提示「僅顯示這一次」（見下方成功畫面切換邏輯）。
//   Response（失敗）：{ error: '錯誤訊息' }，例如帳號重複、格式不符等，
//     直接顯示在 #add-doctor-modal-error。
// 渲染邏輯（成功時）：
//   - 把 account 和 res.password 分別填入
//     #success-doctor-account / #success-doctor-password。
//   - 隱藏 #add-doctor-form-container（表單），顯示
//     #add-doctor-success-container（密碼提示畫面），讓使用者可以
//     點擊「📋 複製密碼」或關閉視窗（關閉時會觸發列表重新整理）。
// 錯誤情境：
//   - 若 res.error 存在，直接顯示於 #add-doctor-modal-error，Modal 停留
//     在表單畫面，不會切換到成功畫面。
//   - 若連線發生例外（fetch 失敗、JSON 解析錯誤等），顯示
//     「連線失敗: <錯誤內容>」。
//   - 若 res.success 為假但也沒有 error（理論上不應發生的防禦性分支），
//     顯示「建立失敗」。
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

// ─────────────────────────────────────────────────────────────────────────
// copyGeneratedPassword()
// ─────────────────────────────────────────────────────────────────────────
// 用途：把「新增醫師帳號」成功畫面中顯示的隨機密碼複製到系統剪貼簿，
//       方便管理員直接貼給該醫師（例如貼到 LINE 訊息或 email）。
// 觸發時機：使用者在密碼顯示畫面點擊「📋 複製密碼」按鈕。
// 邏輯：
//   - 直接讀取 #success-doctor-password 目前顯示的文字內容（即
//     submitAddDoctor 成功後填入的明文密碼），呼叫瀏覽器
//     navigator.clipboard.writeText() API 寫入剪貼簿。
//   - 成功 → 顯示 toast「📋 密碼已複製到剪貼簿」。
//   - 失敗（例如瀏覽器權限被拒、非 HTTPS 環境限制 clipboard API 等）
//     → 顯示 toast「❌ 複製失敗，請手動選取複製」，讓使用者退而求其次
//       自行選取文字複製。
//   注意：此函式不會呼叫任何後端 API，純粹是前端剪貼簿操作。
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

// ─────────────────────────────────────────────────────────────────────────
// deleteDoctor(account, name)
// ─────────────────────────────────────────────────────────────────────────
// 用途：刪除指定的醫師帳號（不可復原的操作），刪除前會先用瀏覽器原生
//       confirm() 對話框做二次確認，降低誤刪風險。
// 觸發時機：使用者在醫師列表某一列點擊「🗑️ 刪除」按鈕
//           （此按鈕只有在該筆資料的 can_delete 為 true 時才是可點擊
//           狀態，否則在 loadDoctors 渲染階段已被加上 disabled）。
// 參數：account - 要刪除的醫師帳號（account_name）。
//       name    - 要刪除的醫師姓名，僅用於確認對話框文字顯示。
// 前端確認：
//   window.confirm(`⚠️ 確定要刪除醫師「${name}」(${account}) 嗎？
//   刪除後此動作將無法復原！`) — 使用者按「取消」則直接 return，不會
//   發出任何 API 請求。
// 對應後端 API：DELETE /api/doctors/<account>
//   Request：無 body。
//   Response（成功）：{ success: true }
//   Response（失敗，400）：{ error: '錯誤訊息' }
//     即使前端已經用 can_delete 讓按鈕在無法刪除時 disabled，這裡仍然
//     保留完整的錯誤處理分支，是為了防禦「competing update」情境：例如
//     兩個管理員同時開著這個分頁，另一位管理員剛好在這位醫師身上新增
//     了一筆看診紀錄，導致目前這個分頁上顯示的 can_delete（舊資料）
//     仍是 true，但實際送出刪除請求時後端才發現該醫師已經有紀錄了，
//     於是拒絕刪除並回傳明確錯誤訊息。同樣地，後端也會拒絕刪除「自己」
//     的帳號，避免操作者把自己正在使用的登入帳號刪除掉。
// 成功後的處理：
//   - 顯示 toast「🗑️ 醫師帳號已刪除」。
//   - 重新呼叫 loadDoctors() 讓列表中移除這一列。
// 失敗處理：
//   - 顯示 toast「❌ 刪除失敗: <res.error 或 '未知錯誤'>」。
//   - 連線例外時顯示「❌ 連線失敗: <錯誤內容>」。
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

// ════════════════════════════════════════════════════════════════════════
// 科別（department / specialty）管理區塊
// ════════════════════════════════════════════════════════════════════════
// 以下函式負責：
//   1. 在「新增/修改醫師」表單中提供動態的科別下拉選單（含「新增其他
//      科別」自訂輸入選項）——見 populateSpecialtySelect /
//      handleSpecialtySelectChange。
//   2. 獨立的「科別管理」Modal（#modal-departments），讓管理員可以直接
//      新增、改名、啟用/停用、刪除科別，不需要透過編輯醫師間接操作。
// 科別資料的權威來源是後端的 data/departments.json（透過 /api/departments
// 系列端點存取），資料庫 doctors.department 欄位只是「目前這個醫師選用
// 哪個科別名稱」的快照，兩者用科別名稱字串對應，並非用 ID 關聯。
// ── 已回診與科別管理 ──
// pendingDeptName / pendingDeptAction：
//   這兩個模組層級（file-scope）變數用來在「使用者點擊某個科別操作
//   按鈕」與「使用者在確認 Modal 中按下確認」這兩個非同步的使用者互動
//   之間傳遞狀態，因為中間插入了一個共用的確認彈窗（#modal-confirm-dept-action），
//   而該彈窗的「確認」按鈕統一綁定同一個 executeDeptAction() 函式，
//   所以需要先把「要對哪個科別(name)做什麼操作(action)」存起來，等使用
//   者真正按下確認後再讀出來執行。
let pendingDeptName = '';
let pendingDeptAction = ''; // 'disable', 'enable', 'delete'

// ─────────────────────────────────────────────────────────────────────────
// populateSpecialtySelect(selectId, customGroupId, inputId, selectedValue)
// ─────────────────────────────────────────────────────────────────────────
// 用途：動態產生「科別」下拉選單的選項，並根據目前應該選中的值
//       （selectedValue）決定要顯示下拉選單模式，還是切換成「自訂輸入
//       框」模式。此函式同時被「新增醫師」與「修改醫師」兩個 Modal 共用
//       （呼叫時傳入不同的 DOM id 即可重複使用同一套邏輯）。
// 觸發時機：
//   - openAddDoctorModal()：開啟新增醫師 Modal 時，selectedValue 傳入
//     空字串（尚無預設科別）。
//   - openDoctorEditModal()：開啟修改醫師 Modal 時，selectedValue 傳入
//     該醫師目前的 specialty。
// 參數：
//   selectId       - 下拉選單 <select> 的 DOM id
//                    （'add-doctor-specialty-select' 或
//                     'edit-doctor-specialty-select'）。
//   customGroupId  - 「自訂科別名稱」欄位容器的 DOM id，預設用
//                     style="display:none" 隱藏，只有選到
//                     「➕ 新增其他科別」時才顯示。
//   inputId        - 真正會被表單讀取、送往後端的隱藏/顯示輸入框 id
//                    （'add-doctor-specialty' 或 'edit-doctor-specialty'）。
//                    無論使用者是從下拉選單選擇既有科別，還是自己輸入
//                    新科別名稱，最終都會把值同步寫入這個 input，
//                    submitAddDoctor()/saveDoctorEdit() 只讀取這個
//                    input 的值，不直接讀 <select>。
//   selectedValue  - 目前應該預選的科別名稱（新增時為空字串）。
// 對應後端 API：GET /api/departments
//   Response：[{ name: string, is_active: 0|1, is_used: 0|1 }, ...]
// 渲染邏輯：
//   1. 下拉選單先顯示「載入中…」佔位選項。
//   2. 取得科別清單後，篩選出 is_active 為真的科別（activeDeps）——
//      已停用的科別不應該讓使用者在新增/編輯醫師時選到，避免持續產生
//      新的關聯。
//   3. 逐一把 activeDeps 轉成 <option> 加入 <select>。
//   4. 若 selectedValue 有值，但它不在 activeDeps 名單中（例如這位醫師
//      目前使用的科別剛好已被停用，或是編輯時科別剛好是空字串以外的
//      舊資料），且不是特殊值 '__custom__'，則額外把這個值也加成一個
//      <option>，確保下拉選單一定能顯示出「目前的科別」，不會因為找不到
//      對應選項而讓畫面顯示空白或跳到別的科別。
//   5. 最後固定加上一個特殊選項 value="__custom__"「➕ 新增其他科別」，
//      讓使用者可以跳出既有清單，直接輸入一個全新的科別名稱（送出表單
//      時，若是全新名稱，後端 POST /api/doctors 會自動把它同步寫入
//      data/departments.json，不需要使用者先跑去科別管理 Modal 新增）。
//   6. 決定初始選中狀態：
//        - 若 selectedValue 存在且能在完整科別清單(deps，包含未啟用)中
//          找到相符名稱 → 選單選中該值，隱藏自訂輸入框，並把 inputEl
//          同步設為該值。
//        - 若 selectedValue 存在但找不到相符名稱 → 視為自訂科別，選單
//          切到 '__custom__'，顯示自訂輸入框，並把 inputEl 設為
//          selectedValue（保留原始文字，不會被清空）。
//        - 若 selectedValue 是空字串（新增醫師的情境）→ 若有啟用中的
//          科別，預設選中清單中第一個；若一個啟用中的科別都沒有，則
//          直接切到自訂輸入模式讓使用者輸入。
// 錯誤情境：
//   - 若 API 呼叫失敗（例如網路問題），於 console.error 記錄錯誤，並讓
//     選單退回只有「➕ 新增其他科別」一個選項、強制顯示自訂輸入框，
//     確保表單仍然可以被填寫（不會因為科別清單載入失敗而卡住整個
//     新增/編輯流程）。
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

// ─────────────────────────────────────────────────────────────────────────
// handleSpecialtySelectChange(selectEl, customGroupId, inputId)
// ─────────────────────────────────────────────────────────────────────────
// 用途：處理科別下拉選單的 change 事件，決定要不要切換到「自訂輸入
//       科別名稱」的顯示模式，並讓實際要送出的 input 欄位值與目前
//       選單狀態保持同步。
// 觸發時機：doctors.html 中兩個 <select> 皆有綁定
//   onchange="handleSpecialtySelectChange(this, '<自訂欄位群組id>', '<實際input id>')"
//   （新增醫師：add-doctor-specialty-select；
//     修改醫師：edit-doctor-specialty-select）
//   也就是每次使用者在下拉選單中選了不同選項時就會呼叫一次。
// 參數：
//   selectEl      - 觸發事件的 <select> DOM 元素本身（this）。
//   customGroupId - 「自訂科別名稱」欄位容器的 DOM id。
//   inputId       - 實際會被表單讀取送出的 input 欄位 id。
// 邏輯：
//   - 若選中的值是特殊值 '__custom__'（使用者選了「➕ 新增其他科別」）：
//       顯示自訂輸入框、清空其內容，並自動 focus 讓使用者可以直接輸入，
//       不需要再多點一次滑鼠。
//   - 否則（使用者選了清單中既有的科別名稱）：
//       隱藏自訂輸入框，並把 select 目前選中的值同步寫入 inputEl，
//       確保後續讀取 inputId 的值時一定是「使用者實際想要的科別」。
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

// ─────────────────────────────────────────────────────────────────────────
// openDepartmentModal()
// ─────────────────────────────────────────────────────────────────────────
// 用途：開啟獨立的「科別管理」Modal（#modal-departments），這是管理員
//       集中管理所有科別（新增/改名/啟用停用/刪除）的入口，與新增/編輯
//       醫師表單中的科別下拉選單是互相獨立但共享同一份後端資料的兩套
//       UI。
// 觸發時機：使用者點擊分頁右上角「🏥 科別管理」按鈕
//           （doctors.html 內 onclick="openDepartmentModal()"）。
// 邏輯：
//   - 清空「新增科別」輸入框與錯誤訊息。
//   - openModal 顯示 Modal 後，立即呼叫 loadDepartmentsList() 向後端
//     取得最新的科別清單並渲染成表格。
function openDepartmentModal() {
  document.getElementById('new-department-name').value = '';
  document.getElementById('department-modal-error').textContent = '';
  openModal('modal-departments');
  loadDepartmentsList();
}

// ─────────────────────────────────────────────────────────────────────────
// closeDepartmentModal()
// ─────────────────────────────────────────────────────────────────────────
// 用途：關閉「科別管理」Modal。
// 觸發時機：使用者點擊 Modal 底部的「關閉」按鈕。
// 備註：此處不需要重新整理醫師列表，因為 loadDoctors() 只在真正發生
//       「改名」（executeRenameDepartment 成功時）才會被觸發；單純的
//       啟用/停用/刪除科別不會改變既有醫師的 specialty 文字，因此不會
//       影響醫師列表畫面。
function closeDepartmentModal() {
  closeModal('modal-departments');
}

// ─────────────────────────────────────────────────────────────────────────
// loadDepartmentsList()
// ─────────────────────────────────────────────────────────────────────────
// 用途：向後端請求完整的科別清單（包含已停用的），並渲染到
//       #department-tbody（科別管理 Modal 內的表格）。
// 觸發時機：
//   - openDepartmentModal() 開啟 Modal 時。
//   - addDepartment() 新增科別成功後。
//   - executeRenameDepartment() 改名成功後。
//   - executeDeptAction() 執行啟用/停用/刪除成功後。
//   （也就是任何一個會改變科別資料的操作完成後，都會重新呼叫這個函式
//    來刷新表格，確保畫面永遠反映資料庫最新狀態。）
// 對應後端 API：GET /api/departments
//   Response：[{ name: string, is_active: 0|1, is_used: 0|1 }, ...]
//     is_used 代表「目前是否有任何醫師的 specialty 使用這個科別名稱」，
//     這個欄位直接決定了這一列可以顯示什麼操作按鈕（見下方渲染邏輯）。
// 渲染邏輯：
//   1. 先顯示載入中的 spinner。
//   2. 若後端回傳的是帶有 error 欄位的物件（而非陣列），顯示錯誤訊息並
//      清空表格。
//   3. 否則逐筆科別產生一列 <tr>：
//        - 名稱欄：科別名稱（esc 過）。
//        - 狀態欄：is_active 為真 → 綠色「啟用中」；否則灰色「已停用」。
//        - 操作欄：固定有一個「✏️ 修改」按鈕（呼叫 openRenameDeptModal），
//          另外根據 is_used 與 is_active 的組合，動態決定第二個按鈕的
//          文字/樣式/行為：
//            * is_used === true  且 is_active === true
//                → 顯示「⏸️ 停用」（黃色 btn-warn），action='disable'。
//                  因為這個科別目前有醫師在使用，若真的整筆刪除，會讓
//                  資料庫中該醫師的歷史 department 欄位變成「幽靈值」
//                  （查無此科別），所以只能先停用，不能刪除。
//            * is_used === true  且 is_active === false
//                → 顯示「▶️ 啟用」（綠色 btn-accent），action='enable'。
//                  代表這個科別本身已停用，但仍有醫師掛在這個科別下
//                  （多半是這個科別停用「之後」才被指派，或是曾經啟用
//                  時被選用，之後又被停用），管理員可以選擇重新啟用它。
//            * is_used === false（不論 is_active 為何）
//                → 顯示「🗑️ 刪除」（紅色 btn-danger），action='delete'。
//                  因為沒有任何醫師在用這個科別，可以安全地把它從
//                  data/departments.json 中徹底移除，不會產生孤兒資料。
//        - 三個分支對應的按鈕都綁定同一個
//          confirmDeptAction(name, actionType, isUsed) 函式，只是帶入
//          不同的 actionType 字串，讓後續共用的確認 Modal 依 actionType
//          顯示對應文字與呼叫對應 API。
// 錯誤情境：
//   - fetch/JSON 例外會被 catch，於 console.error 記錄，並在
//     #department-modal-error 顯示「載入科別清單失敗」，清空表格內容。
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

// ─────────────────────────────────────────────────────────────────────────
// addDepartment()
// ─────────────────────────────────────────────────────────────────────────
// 用途：在「科別管理」Modal 中新增一個科別。
// 觸發時機：使用者在 Modal 上方的輸入框填入名稱後，點擊「新增科別」
//           按鈕（doctors.html 內 onclick="addDepartment()"）。
// 前端驗證：名稱不可空白，否則顯示「科別名稱不可為空」並中止。
// 對應後端 API：POST /api/departments
//   Request body：{ name: string }
//   Response（成功）：{ message?: string }（沒有 error 欄位即視為成功；
//     若這個名稱原本存在但被停用，後端會直接把它重新啟用，而不是報錯
//     「已存在」，這是為了讓「新增」與「重新啟用」在使用者體感上是
//     同一個直覺動作——不需要先去找到那個停用中的科別再切換狀態。）
//   Response（失敗）：{ error: string }，例如名稱重複且已啟用中。
// 成功後的處理：
//   - 清空輸入框。
//   - 顯示 toast（優先使用後端回傳的 res.message，否則預設
//     「✅ 新增成功」）。
//   - 重新呼叫 loadDepartmentsList() 刷新表格。
// 失敗後的處理：
//   - 顯示 res.error 於 #department-modal-error。
//   - 連線例外時顯示「連線失敗: <錯誤內容>」。
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

// ─────────────────────────────────────────────────────────────────────────
// openRenameDeptModal(oldName)
// ─────────────────────────────────────────────────────────────────────────
// 用途：開啟「修改科別名稱」Modal（#modal-rename-department），並把
//       目前的科別名稱預先填入「原科別名稱」（唯讀）與「新科別名稱」
//       （可編輯，預設值同原名稱，方便使用者用最小改動修正打字錯誤）。
// 觸發時機：使用者在科別管理表格中點擊某一列的「✏️ 修改」按鈕。
// 參數：oldName - 要被修改的科別目前名稱。
// 邏輯：
//   - 隱藏欄位 #rename-dept-old-name 存放 oldName，供
//     executeRenameDepartment() 讀取以組成 API 路徑
//     （PUT /api/departments/<old_name>）。
//   - 唯讀欄位 #rename-dept-old-name-show 純粹顯示用途。
//   - #rename-dept-new-name 預設填入 oldName，讓使用者可以直接在原文字
//     上修改，而不是從空白開始輸入整個名稱。
//   - 清空錯誤訊息，開啟 Modal。
function openRenameDeptModal(oldName) {
  document.getElementById('rename-dept-old-name').value = oldName;
  document.getElementById('rename-dept-old-name-show').value = oldName;
  document.getElementById('rename-dept-new-name').value = oldName;
  document.getElementById('rename-dept-error').textContent = '';
  openModal('modal-rename-department');
}

// ─────────────────────────────────────────────────────────────────────────
// executeRenameDepartment()
// ─────────────────────────────────────────────────────────────────────────
// 用途：送出科別改名請求。
// 觸發時機：使用者在「修改科別名稱」Modal 中點擊「💾 儲存」按鈕。
// 前端驗證：
//   - 新名稱不可空白，否則顯示「科別名稱不可為空」。
//   - 若新名稱與舊名稱完全相同，視為使用者沒有真的要改名，直接關閉
//     Modal（不呼叫 API，節省一次無意義的網路請求，也避免後端在
//     「改名成同名」情境下做多餘的資料庫更新）。
// 對應後端 API：PUT /api/departments/<old_name>
//   Request body：{ name: new_name }
//   Response（成功）：{}（沒有 error 欄位）
//     後端在改名成功時，會連動把所有目前 department 欄位等於舊名稱的
//     醫師記錄，一併更新成新名稱，確保「科別名稱」與「醫師資料表中顯示
//     的科別」永遠一致，不會出現改名後舊名稱憑空消失但醫師資料還停留
//     在舊名稱的不一致狀態。
//   Response（失敗）：{ error: string }，例如新名稱已被其他科別使用。
// 成功後的處理：
//   - 關閉 Modal，顯示 toast「✅ 科別已成功改名」。
//   - 重新呼叫 loadDepartmentsList() 刷新科別表格。
//   - 若 loadDoctors 函式存在（防禦性檢查，理論上一定存在，因為兩者
//     同一個檔案），額外重新呼叫 loadDoctors() 刷新醫師列表——因為
//     醫師列表中的「科別」欄位顯示的正是這個名稱，如果不重新整理，
//     畫面上會繼續顯示已經被改掉的舊名稱，造成資料顯示不一致。
// 失敗後的處理：
//   - 顯示 res.error 於 #rename-dept-error。
//   - 連線例外時顯示「連線失敗: <錯誤內容>」。
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

// ─────────────────────────────────────────────────────────────────────────
// confirmDeptAction(name, action, isUsed)
// ─────────────────────────────────────────────────────────────────────────
// 用途：在真正執行「停用/啟用/刪除科別」之前，先開啟一個共用的確認彈窗
//       （#modal-confirm-dept-action），依 action 類型動態填入不同的
//       標題、警示文字、按鈕樣式與文字，讓使用者在按下確認前清楚知道
//       接下來會發生什麼事，尤其是刪除科別這種不可逆的操作。
// 觸發時機：使用者在科別管理表格中點擊「⏸️ 停用」/「▶️ 啟用」/
//           「🗑️ 刪除」按鈕（依 loadDepartmentsList 渲染邏輯，三者中
//           同一列只會顯示其中一個）。
// 參數：
//   name   - 科別名稱。
//   action - 'disable' | 'enable' | 'delete'，決定彈窗顯示內容與最終
//            要呼叫的 API 方法。
//   isUsed - 目前未在此函式內直接使用於邏輯分支（因為 loadDepartmentsList
//            在產生按鈕時已經依 is_used 決定好對應的 action 是哪一種），
//            此參數保留主要是讓函式簽章保留完整上下文，方便除錯與未來
//            擴充判斷邏輯。
// 邏輯：
//   1. 把 name 和 action 存到模組層級變數 pendingDeptName /
//      pendingDeptAction，供使用者按下確認鈕後，executeDeptAction()
//      讀取並執行對應操作。
//   2. 先重置圖示外框與訊息 banner 的 CSS class（移除上一次可能殘留的
//      danger/warning/success 樣式），避免不同操作之間互相汙染樣式。
//   3. 依 action 分支設定：
//        - 'delete'  → 危險（danger）樣式：標題「確認刪除科別」，
//          說明「將會被完全從系統中刪除」，確認按鈕文字「確認刪除」
//          並套用 btn-danger（紅色，強調不可逆）。
//        - 'disable' → 警告（warning）樣式：標題「確認停用科別」，
//          說明「目前已有關聯醫師，系統無法刪除，將變更為『已停用』
//          狀態」——這段文字直接呼應後端規則：只要 is_used 為真就不能
//          真的刪除，只能停用，讓使用者理解「為什麼這裡沒有刪除
//          選項」。確認按鈕文字「確認停用」，套用 btn-warn（黃色）。
//        - 'enable'  → 成功（success）樣式：標題「確認啟用科別」，
//          說明啟用後這個科別會重新出現在新增/編輯醫師的科別選單中，
//          確認按鈕文字「確認啟用」，套用 btn-accent（主色）。
//   4. 最後開啟 #modal-confirm-dept-action。
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

// ─────────────────────────────────────────────────────────────────────────
// executeDeptAction()
// ─────────────────────────────────────────────────────────────────────────
// 用途：讀取 confirmDeptAction() 事先存好的 pendingDeptName /
//       pendingDeptAction，真正呼叫對應的後端 API 執行停用/啟用/刪除
//       科別的動作。
// 觸發時機：使用者在共用確認彈窗（#modal-confirm-dept-action）中點擊
//           「確認」按鈕。
// 邏輯與對應後端 API：
//   - 若沒有 pendingDeptName 或 pendingDeptAction（防禦性檢查，理論上
//     一定是先呼叫過 confirmDeptAction 才能觸發這裡），直接 return。
//   - 先關閉確認彈窗（不論後續 API 呼叫成功或失敗，都先讓彈窗消失，
//     避免使用者在等待網路回應時，彈窗一直卡在畫面上）。
//   - action === 'delete'：
//       DELETE /api/departments/<name>
//       Response 可能是：
//         - 真正刪除成功：{ message: '...刪除成功...' }
//         - 若這個科別實際上仍被使用（例如與其他分頁的操作有 race
//           condition），後端可能改為僅停用並回傳對應訊息，前端一律
//           以 res.message（若有）顯示，否則顯示預設「✅ 刪除成功」。
//   - action === 'disable'：
//       PUT /api/departments/<name>，body { is_active: false }
//   - action === 'enable'：
//       PUT /api/departments/<name>，body { is_active: true }
//     這兩種情境下，若無錯誤，一律顯示「✅ 已啟用科別」或
//     「✅ 已停用科別」（依 action 動態組字串）。
// 成功後的處理：
//   - 顯示對應 toast。
//   - 重新呼叫 loadDepartmentsList() 刷新科別表格，讓最新的 is_active /
//     操作按鈕文字反映出來。
//   注意：這裡沒有額外呼叫 loadDoctors()，因為停用/啟用/刪除科別本身
//   不會更動任何醫師記錄裡的 specialty 文字（只有「改名」才會連動更新
//   醫師資料，見 executeRenameDepartment），所以不需要重新整理醫師
//   列表。
// 失敗處理：
//   - 若 res.error 存在，使用瀏覽器原生 alert() 顯示（此處刻意使用
//     alert 而非 showToast，可能是因為這個彈窗流程已經關閉了確認
//     Modal，需要一個更強制、必須使用者按下確認才會消失的提示方式，
//     避免因為停用/刪除失敗這種重要訊息被 toast 的短暫顯示時間錯過）。
//   - 連線例外時同樣以 alert 顯示「連線失敗: <錯誤內容>」。
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

