// ════════════════════════════════════════════════════════════════════════
// 檔案總覽：衛教資料管理分頁 - 前端邏輯（webpage/admin/js/education.js）
// ════════════════════════════════════════════════════════════════════════
//
// 【這個檔案在整體系統中的角色】
// 本檔案是「急診出院衛教 LINE Bot + 醫護後台管理系統」後台管理介面中，負責
// 「衛教資料管理」分頁（配對的畫面骨架見 webpage/admin/html/education.html）
// 的全部互動邏輯：向後端 Flask API（定義於 src/admin_server.py，經由
// src/app.py 註冊的 admin_bp 掛載）發送 fetch 請求、把回應資料渲染成畫面上的
// 手風琴式列表、處理新增/編輯/刪除三種操作對應的 Modal 開關與表單驗證。
// 本檔案不直接操作資料庫，所有讀寫都透過 fetch 呼叫後端 API 完成；後端本身
// 也不是存 SQLite，而是把「目錄結構」存成 JSON 檔、把「內容文字」存成獨立的
// Markdown 檔（詳見下方資料儲存架構說明），並用 threading.Lock 保護並行寫入。
//
// 【權限模型】
// 讀取列表（GET /api/education、GET /api/education-content/<filename>）對一般
// 已登入者可能也開放；但新增（POST /api/education）、編輯
// （PUT /api/education/<bodypart>/<category>）、刪除
// （DELETE /api/education/<bodypart>/<category>）這三個寫入型 API 在後端都套用了
// @admin_required 裝飾器，若目前登入者不是管理員，呼叫這些 API 會收到 HTTP 403，
// 本檔案會將後端回傳的錯誤訊息（data.error）直接顯示在 Modal 的錯誤區塊或 toast
// 提示中，讓使用者知道操作被拒絕的原因。是否具備管理員身分，是由後台外層透過
// GET /api/me 的 is_admin 欄位判斷，與本檔案的邏輯無直接關聯（本檔案假設呼叫者
// 已經是被允許進入此分頁的使用者，寫入失敗時單純把 API 回應的錯誤顯示出來）。
//
// 【資料儲存架構（前端所有操作最終都對應到這個結構）】
//   1. assets/discharge/category.json
//      { "部位名稱": { "類別名稱": { "filename": "xxx.md" }, ... }, ... }
//      兩層階層式對照表：第一層 key 是部位（bodypart），第二層 key 是類別
//      （category），value 記錄該類別實際內容檔的檔名。
//   2. assets/discharge/<filename>.md
//      每個類別的實際衛教內容文字，以獨立 Markdown 檔存放。同一個檔名可以被
//      多個不同的 (部位, 類別) 組合共同引用（例如兩種症狀恰好該讀同一篇文章），
//      因此後端刪除時會先確認 category.json 裡是否還有其他類別引用同一檔名，
//      沒有其他引用者才會真的把 .md 檔案從硬碟刪除，避免刪錯共用檔案或留下
//      永遠用不到的孤兒檔案。這也是為什麼本檔案在新增/編輯時，「檔名」是一個
//      獨立於「類別名稱」的欄位，且允許（在後端邏輯許可的情況下）多個類別共用
//      同一個檔名。
//
// 【與 LINE Bot AI 回覆的關聯（RAG，檢索增強生成）】
// LINE Bot 端（src/bot.py 的 build_rag_context 函式）會依病患看診紀錄中的症狀
// （中文名稱字串）比對 category.json，找出對應的 .md 檔名，把該檔案內容整合成
// 「RAG context」，作為提示詞的一部分交給 LLM 參考後回覆病患。也就是說，管理員
// 在本頁面新增/編輯的每一段文字，會直接影響 AI 對病患的衛教說明是否正確、完整，
// 因此本檔案的資料一致性（必填檢查、命名衝突提示）雖然多半是後端在把關，前端
// 也會盡量即時呈現後端回傳的錯誤，協助管理員快速修正。
//
// 【本檔案會呼叫的後端 API 一覽（皆定義於 src/admin_server.py）】
//   - GET    /api/education
//       取得攤平後的列表 [{bodypart, category, filename}, ...]（依 bodypart,
//       category 排序），不含實際內容文字（避免列表回應過大）。
//       → 呼叫點：loadEducationList()
//   - GET    /api/education-content/<filename>
//       取得單一 .md 檔的實際文字內容 {filename, content}，檔案不存在回 404。
//       → 呼叫點：openEducationEditModal()（開啟編輯 Modal 時，用來把現有內容
//         帶入 textarea）
//   - POST   /api/education
//       body {bodypart, category, content, filename}，新增一筆 (部位, 類別) 對照
//       並建立/覆寫對應的 .md 檔。
//       → 呼叫點：submitEducationForm()（新增模式）
//   - PUT    /api/education/<bodypart>/<category>
//       body {bodypart, category, content, filename}，編輯既有一筆，URL 路徑中的
//       <bodypart>/<category> 是「編輯前的原始值」，body 裡的欄位則是「使用者
//       修改後想要的新值」，因此可以同時支援改部位名稱、改類別名稱、改檔名、
//       改內容文字。
//       → 呼叫點：submitEducationForm()（編輯模式）
//   - DELETE /api/education/<bodypart>/<category>
//       刪除該筆 (部位, 類別) 對照關係；後端確認沒有其他類別共用同一 .md 檔名後，
//       才會真的刪除該檔案。
//       → 呼叫點：confirmDeleteEducation()
//
// 【前端狀態管理總覽】
// 本檔案採用模組層級（top-level）變數作為簡易的前端狀態管理，取代框架（無使用
// React/Vue 等），所有渲染都是「狀態改變 → 重新用 innerHTML 整段重繪對應容器」
// 的模式：
//   - educationList：目前從後端載入的完整列表快取，畫面上所有分組、表格列都是
//     依這份陣列即時算出來的，不會有另一份「畫面自己維護的資料」跟它分岔。
//   - educationEditingBodypart / educationEditingCategory：目前開啟的新增/編輯
//     Modal 是哪一種模式的關鍵旗標（兩者皆 null＝新增模式；皆有值＝編輯模式，
//     且記錄的是「編輯前的原始部位/類別」，用於組出 PUT 請求的 URL）。
//   - educationDeleteTarget：目前刪除確認 Modal 對應的目標 (bodypart, category)。
//   - expandedBodyparts：目前手風琴列表中「展開中」的部位名稱集合，用 Set 儲存，
//     每次 renderEducationTable() 重繪時都會讀取這個集合來決定每個部位區塊該
//     顯示展開或收合狀態，確保使用者展開某個部位後，即使資料重新整理（例如
//     儲存/刪除後重新 loadEducationList()），該部位仍維持展開，不會每次都被
//     打回收合狀態造成操作體驗不佳。
// ════════════════════════════════════════════════════════════════════════

// 衛教資料管理（管理員）

let educationList = [];               // [{bodypart, category, filename}, ...]
let educationEditingBodypart = null;  // 編輯中的原始部位（null 代表「新增」模式）
let educationEditingCategory = null;  // 編輯中的原始類別
let educationDeleteTarget = null;     // {bodypart, category}
let expandedBodyparts = new Set();    // 目前展開中的部位名稱，重新 render 後會保留狀態

// ── 共用小工具 ──
//   以下三個函式（eduShowLoading / eduHideLoading / eduToast）是「優先使用後台
//   外層共用元件，若不存在則自行操作 DOM 的 fallback」寫法：後台主頁面通常會
//   全域提供 showLoading()/hideLoading()（控制載入中遮罩）與 showToast(msg, type)
//   （顯示右下角/頂部的訊息提示條）等共用函式；若因某些頁面組合方式導致這些
//   全域函式不存在，就退回直接找 #loading、#toast 這兩個 DOM 元素自己處理，
//   確保本檔案在各種嵌入情境下都不會因為找不到函式而整頁噴錯。

// 顯示「載入中」狀態：在每次發出 fetch 請求前呼叫，用來提示使用者目前有非同步
// 動作正在進行（例如載入列表、儲存、刪除）。優先呼叫後台外層的全域 showLoading()，
// 若該函式不存在（此頁面被單獨嵌入、未載入外層共用 JS 的情境），則直接對
// #loading 元素加上 'active' class 由 CSS 控制顯示載入中遮罩/動畫。
function eduShowLoading() {
  if (typeof showLoading === 'function') { showLoading(); return; }
  const el = document.getElementById('loading');
  if (el) el.classList.add('active');
}

// 隱藏「載入中」狀態：與 eduShowLoading() 成對使用，通常放在 fetch 呼叫的
// try/catch/finally 的 finally 區塊裡，確保無論成功或失敗都會關閉載入中提示。
function eduHideLoading() {
  if (typeof hideLoading === 'function') { hideLoading(); return; }
  const el = document.getElementById('loading');
  if (el) el.classList.remove('active');
}

// 顯示一則短暫的訊息提示條（toast）：用於回報操作結果（成功/失敗），例如
// 「衛教資料已儲存」、「刪除失敗」等。
// 參數：
//   message - 要顯示的文字內容
//   isOk    - true 代表成功（樣式套用 'ok'），false 代表失敗（樣式套用 'fail'）
// 優先呼叫後台外層的全域 showToast(message, type)；若不存在則直接操作
// #toast 元素：設定文字、切換樣式 class、加上 'show' class 使其顯示，並用
// setTimeout 在 2.5 秒後自動移除 'show' class 使其淡出。每次呼叫都會先
// clearTimeout 前一次尚未觸發的計時器（存在元素自身的 _eduTimer 屬性上），
// 避免快速連續呼叫時，前一個 toast 的隱藏計時器提前把新顯示的 toast 關掉。
function eduToast(message, isOk) {
  if (typeof showToast === 'function') { showToast(message, isOk ? 'ok' : 'fail'); return; }
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('ok', 'fail');
  el.classList.add(isOk ? 'ok' : 'fail', 'show');
  clearTimeout(el._eduTimer);
  el._eduTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// 將任意字串安全轉換為可插入 innerHTML 的 HTML 逸出（escape）字串，避免
// XSS（例如部位名稱、類別名稱、檔名若剛好含有 <script> 等字元，直接拼接進
// innerHTML 會被當成 HTML/腳本解析執行）。實作技巧：建立一個暫時的、不會被
// 掛進畫面的 <div>，用 textContent 賦值（瀏覽器會自動把特殊字元當成純文字，
// 不會被當成標籤解析），再讀取該 div 被瀏覽器轉換過的 innerHTML，即可得到
// 逸出後的安全字串。若傳入 null/undefined 則視為空字串處理。
// 本檔案所有會把後端回傳資料（部位名稱、類別名稱、檔名）拼接進 innerHTML
// 字串模板的地方（見 renderEducationTable()、populateBodypartOptions()），
// 都會透過這個函式包裝一層，是本檔案唯一的 XSS 防護手段。
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ── 載入列表 ──────────────────────────────────────────────────────────────

// 從後端載入整份衛教資料列表，並觸發重新渲染。
// 觸發時機：
//   1. 頁面首次載入時（見檔案最末的 DOMContentLoaded 監聽器）
//   2. 新增/編輯儲存成功後（submitEducationForm() 結尾呼叫，確保畫面反映最新資料）
//   3. 刪除成功後（confirmDeleteEducation() 結尾呼叫）
// 對應後端 API：GET /api/education
//   - Request：無 body，僅帶 credentials: 'same-origin'（讓瀏覽器附上 session
//     cookie，讓後端可以用 Flask session 判斷目前登入者身分）
//   - Response（成功 200）：JSON 陣列 [{bodypart, category, filename}, ...]，
//     是後端把 category.json 的兩層階層結構「攤平」成一維陣列後，依 bodypart、
//     category 排序回傳；不含實際的衛教內容文字（內容需另外呼叫
//     GET /api/education-content/<filename> 取得，見 openEducationEditModal()）。
//   - Response（失敗，例如非管理員或伺服器錯誤）：{error: "..."}，前端會把
//     data.error 顯示在 toast 提示中；若後端連 error 欄位都沒給，則顯示預設的
//     「載入衛教資料失敗」文字。
// 資料流程：fetch 回應 → 存入模組層級變數 educationList（若回應不是陣列則保底
// 設為空陣列，避免後續分組/渲染邏輯因型別錯誤而整頁壞掉）→ 呼叫
// renderEducationTable() 依這份資料重新畫出畫面。
// 例外處理：無論成功或失敗，最終都會呼叫 eduHideLoading() 關閉載入中提示
// （transformed via try/finally）；網路層級的例外（例如斷線、JSON 解析失敗）
// 會被 catch 區塊攔截，顯示「載入衛教資料時發生錯誤」並記錄到 console，不會讓
// 例外往外拋出中斷整個頁面。
async function loadEducationList() {
  const container = document.getElementById('education-groups');
  if (!container) return;

  eduShowLoading();
  try {
    const res = await fetch('/api/education', { credentials: 'same-origin' });
    const data = await res.json();

    if (!res.ok) {
      eduToast(data.error || '載入衛教資料失敗', false);
      return;
    }

    educationList = Array.isArray(data) ? data : [];
    renderEducationTable();
  } catch (err) {
    eduToast('載入衛教資料時發生錯誤', false);
    console.error('[education] load error', err);
  } finally {
    eduHideLoading();
  }
}

// ── 依部位分組並渲染成手風琴 ─────────────────────────────────────────────

// 將攤平的列表（[{bodypart, category, filename}, ...]）依 bodypart 分組，
// 轉換成 Map<bodypart, Array<item>>，方便 renderEducationTable() 依部位
// 一組一組畫出手風琴區塊。
// 使用 Map 而非一般物件，是為了保留插入順序（陣列本身已依後端排序好的
// bodypart, category 順序），Map 的 key 迭代順序等於第一次遇到該 bodypart
// 時的順序，渲染出來的分組順序會與後端排序結果一致。
function groupByBodypart(list) {
  const map = new Map();
  for (const item of list) {
    if (!map.has(item.bodypart)) map.set(item.bodypart, []);
    map.get(item.bodypart).push(item);
  }
  return map;
}

// 核心渲染函式：依目前的 educationList（模組層級狀態）重新畫出整個手風琴列表，
// 是本檔案「狀態改變後重新整段渲染」模式的代表性函式。任何會影響到列表資料或
// 展開狀態的操作（載入資料、展開/收合部位）最終都會呼叫這個函式來刷新畫面。
// 觸發時機：loadEducationList() 載入資料完成後、使用者點擊部位標題切換
// 展開/收合狀態時（見本函式內對 .bodypart-header 綁定的 click 監聽器）。
// 渲染邏輯：
//   1. 若 educationList 為空 → 隱藏列表容器 #education-table-wrap，顯示空狀態
//      提示 #education-empty，並清空 #education-groups 的內容後直接 return。
//   2. 否則 → 顯示列表容器、隱藏空狀態提示，呼叫 groupByBodypart() 分組。
//   3. 對每個部位分組，依 expandedBodyparts（Set，記錄目前展開中的部位名稱）
//      判斷該部位區塊此次要以「展開」或「收合」樣式呈現（展開圖示旋轉 90 度、
//      內容區塊 display:block；收合則圖示不旋轉、內容區塊 display:none）。
//   4. 每個部位區塊內的每一列（每個類別）畫出：類別名稱、md 檔名（monospace
//      字型呈現，強調這是檔案系統路徑相關資訊）、以及「編輯」「刪除」兩個按鈕。
//      按鈕上用 data-action、data-idx 屬性記錄要對 educationList 中哪個索引
//      的項目做編輯/刪除，而不是把 bodypart/category 直接寫進 onclick 字串，
//      這樣可以避免部位/類別名稱中含有特殊字元（例如引號）時破壞產生的 HTML。
//   5. 全部內容以字串模板拼接後，一次性透過 innerHTML 整段覆寫 #education-groups
//      （簡單但足夠的渲染方式，因為衛教類別數量通常不會太大，不需要虛擬 DOM
//      或差量更新）。所有動態插入的文字（bodypart、category、filename）都經過
//      escapeHtml() 處理，避免 XSS。
//   6. 因為每次都是整段重繪，先前綁定在舊 DOM 節點上的事件監聽器會隨舊節點一起
//      被丟棄，所以在 innerHTML 賦值完成「之後」，必須重新對新產生的 DOM 節點
//      綁定事件：
//        - .bodypart-header 的 click：切換該部位在 expandedBodyparts 集合中的
//          存在狀態（展開↔收合），然後重新呼叫 renderEducationTable() 自我遞迴
//          刷新畫面（此時 expandedBodyparts 已更新，會畫出新的展開/收合狀態）。
//        - button[data-action] 的 click：依 data-idx 從 educationList 找回
//          對應的項目物件，再依 data-action 是 'edit' 還是其他值，分別呼叫
//          openEducationEditModal(item.bodypart, item.category) 開啟編輯 Modal，
//          或 openEducationDeleteModal(item.bodypart, item.category) 開啟刪除
//          確認 Modal。
function renderEducationTable() {
  const container = document.getElementById('education-groups');
  const emptyState = document.getElementById('education-empty');
  const tableWrap = document.getElementById('education-table-wrap');
  if (!container) return;

  if (!educationList.length) {
    container.innerHTML = '';
    if (tableWrap) tableWrap.style.display = 'none';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }

  if (tableWrap) tableWrap.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  const grouped = groupByBodypart(educationList);

  container.innerHTML = Array.from(grouped.entries()).map(([bodypart, items]) => {
    const isOpen = expandedBodyparts.has(bodypart);

    const rows = items.map((item) => {
      const idx = educationList.indexOf(item);
      return `
        <tr>
          <td><strong>${escapeHtml(item.category)}</strong></td>
          <td style="color:var(--muted); font-family:monospace;">${escapeHtml(item.filename)}</td>
          <td>
            <button class="btn btn-gray btn-xs" data-action="edit" data-idx="${idx}">編輯</button>
            <button class="btn btn-danger btn-xs" data-action="delete" data-idx="${idx}">刪除</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="bodypart-group" style="margin-bottom:8px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
        <div class="bodypart-header" data-toggle="${escapeHtml(bodypart)}"
             style="display:flex; align-items:center; gap:8px; padding:12px 16px; cursor:pointer; background:#f8f9fb;">
          <span style="display:inline-block; transition:transform .15s; transform:rotate(${isOpen ? '90deg' : '0deg'});">▶</span>
          <strong>${escapeHtml(bodypart)}</strong>
          <span style="color:var(--muted); font-size:13px;">（${items.length} 個衛教單）</span>
        </div>
        <div class="bodypart-body" style="display:${isOpen ? 'block' : 'none'}; padding:8px 16px 12px 16px;">
          <table style="width:100%;">
            <thead>
              <tr>
                <th style="width:200px;">衛教單</th>
                <th style="width:200px;">md 檔名</th>
                <th style="width:150px;">操作</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  // 事件綁定 1：點部位標題（.bodypart-header）展開/收合
  //   由於整段 HTML 是剛剛才用 innerHTML 寫入的全新節點，這裡必須重新對每個
  //   .bodypart-header 綁定 click 監聽器。點擊時取出該標題上 data-toggle
  //   屬性記錄的部位名稱（bp），若目前已展開就從 expandedBodyparts 移除
  //   （收合），否則加入（展開），然後重新呼叫 renderEducationTable() 依
  //   最新的展開狀態重繪整個列表——這是本檔案典型的「狀態變更→整段重繪」模式，
  //   不直接用 DOM API 切換單一區塊的 display，而是統一走同一個渲染函式，
  //   確保畫面永遠與 expandedBodyparts、educationList 這兩份狀態一致。
  container.querySelectorAll('.bodypart-header').forEach(header => {
    header.addEventListener('click', () => {
      const bp = header.dataset.toggle;
      if (expandedBodyparts.has(bp)) {
        expandedBodyparts.delete(bp);
      } else {
        expandedBodyparts.add(bp);
      }
      renderEducationTable();
    });
  });

  // 事件綁定 2：每一列的「編輯」/「刪除」按鈕（button[data-action]）
  //   同樣因為節點是全新產生的，需要重新綁定。點擊時依按鈕上的 data-idx
  //   （在渲染 rows 時，透過 educationList.indexOf(item) 算出的索引）從
  //   educationList 陣列取回對應的完整項目物件 {bodypart, category, filename}。
  //   若該索引已找不到對應項目（理論上不太會發生，除非渲染與資料不同步）則
  //   直接放棄。取到項目後，依 data-action 的值：
  //     - 'edit'   → 呼叫 openEducationEditModal(item.bodypart, item.category)
  //                  開啟「新增/編輯共用 Modal」並切換到編輯模式
  //     - 其他（'delete'）→ 呼叫 openEducationDeleteModal(item.bodypart, item.category)
  //                  開啟刪除確認 Modal
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = educationList[Number(btn.dataset.idx)];
      if (!item) return;
      if (btn.dataset.action === 'edit') {
        openEducationEditModal(item.bodypart, item.category);
      } else {
        openEducationDeleteModal(item.bodypart, item.category);
      }
    });
  });
}

// 特殊 sentinel 值，代表「部位下拉選單目前選中的是『+ 新增部位…』這個選項」，
// 用來和真實存在的部位名稱字串區分（因為部位名稱本身是使用者自由輸入的中文
// 字串，無法保證不會恰好等於某個固定字串，這裡選用一個雙底線包住的英文識別字
// 作為不太可能與真實部位名稱衝突的標記值）。populateBodypartOptions()、
// onBodypartSelectChange()、getSelectedBodypart() 三個函式都依賴這個常數來
// 判斷目前是否處於「輸入新部位名稱」的狀態。
const NEW_BODYPART_VALUE = '__new__';

// 依目前 educationList 裡出現過的部位產生下拉選項，最後加一個「+ 新增部位…」。
// selectedBodypart 有值且已存在於選項裡 → 直接選中它；否則自動切到「新增」模式並把
// 值帶進新增用的文字框（例如編輯一筆目前部位已被刪掉的舊資料時，不會選到錯的選項）。
//
// 觸發時機：開啟新增/編輯 Modal 時（openEducationCreateModal() 傳入 null；
// openEducationEditModal() 傳入該筆資料目前的 bodypart）。
// 參數：
//   selectedBodypart - 希望預先選中的部位名稱；新增模式下傳入 null。
// 邏輯拆解：
//   1. 從記憶體中的 educationList 收集所有「目前已出現過」的部位名稱，去重
//      （用 Set 包一層陣列去重）並排序，這份清單直接反映 category.json 目前
//      實際存在的頂層 key，而不是額外去問後端要一份「部位清單」的 API
//      （因為 GET /api/education 回來的攤平列表本身就足以推導出所有部位）。
//   2. 用這份清單產生 <option>，並在最後固定加上一個 value 為
//      NEW_BODYPART_VALUE 的「+ 新增部位…」選項，讓管理員可以建立全新的部位。
//   3. 決定要選中哪個選項（valueToSelect）以及是否要預先填入「新增部位」文字框
//      （prefillNewInput）：
//        - 若 selectedBodypart 有值且確實存在於目前的部位清單中：代表這是在
//          編輯一筆「部位仍然存在」的既有資料，直接選中該部位。
//        - 若 selectedBodypart 有值但「不存在」於目前清單中：屬於邊界情況，
//          例如管理員在別的分頁/視窗把這個部位改名或刪除了，這裡改用「新增
//          部位」模式呈現，並把原本的部位名稱字串預先填入新增文字框，讓
//          管理員可以看到原始值並決定要沿用還是修改，而不會誤選到清單裡
//          第一個不相關的部位。
//        - 若 selectedBodypart 為 null（新增模式）且清單非空：預設選中清單中
//          第一個部位（依字母/注音排序後的第一個），方便管理員快速在既有部位
//          底下新增類別，不必每次都手動選。
//        - 若清單本身是空的（第一次使用，尚無任何衛教資料）：只能選「新增
//          部位」。
//   4. 設定 select.value、newInput.value，並依目前選中的是否為
//      NEW_BODYPART_VALUE 來決定「新增部位」文字框要顯示還是隱藏。
function populateBodypartOptions(selectedBodypart) {
  const select = document.getElementById('education-input-bodypart-select');
  const newInput = document.getElementById('education-input-bodypart-new');
  if (!select || !newInput) return;

  const bodyparts = Array.from(new Set(educationList.map(i => i.bodypart))).sort();

  select.innerHTML = bodyparts.map(bp =>
    `<option value="${escapeHtml(bp)}">${escapeHtml(bp)}</option>`
  ).join('') + `<option value="${NEW_BODYPART_VALUE}">+ 新增部位或科別…</option>`;

  let valueToSelect;
  let prefillNewInput = '';

  if (selectedBodypart && bodyparts.includes(selectedBodypart)) {
    // 編輯既有類別：選中它目前所在的部位
    valueToSelect = selectedBodypart;
  } else if (selectedBodypart) {
      valueToSelect = NEW_BODYPART_VALUE;
      prefillNewInput = selectedBodypart;
  } else if (bodyparts.length > 0) {
      valueToSelect = bodyparts[0];
  } else {
      valueToSelect = NEW_BODYPART_VALUE;
  }

  select.value = valueToSelect;
  newInput.value = prefillNewInput;
  newInput.style.display = (select.value === NEW_BODYPART_VALUE) ? 'block' : 'none';
}

// 部位下拉選單 (#education-input-bodypart-select) 的 onchange 事件處理器
//（綁定方式為 HTML 中的 inline onchange="onBodypartSelectChange()"，見
// education.html）。觸發時機：使用者在 Modal 中手動切換部位下拉選單的選項。
// 邏輯：判斷目前選中的值是否等於 NEW_BODYPART_VALUE（也就是選了「+ 新增
// 部位…」），若是，就顯示下方的「新增部位」文字輸入框並自動 focus 進去，方便
// 使用者直接開始輸入；若切回既有部位，則隱藏該文字框（其中殘留的值不會被清空，
// 但因為隱藏且送出表單時只會在選中 NEW_BODYPART_VALUE 時才讀取這個欄位的值，
// 所以不影響最終送出的資料）。
function onBodypartSelectChange() {
  const select = document.getElementById('education-input-bodypart-select');
  const newInput = document.getElementById('education-input-bodypart-new');
  if (!select || !newInput) return;
  const isNew = select.value === NEW_BODYPART_VALUE;
  newInput.style.display = isNew ? 'block' : 'none';
  if (isNew) newInput.focus();
}

// 送出表單時，實際要用的部位名稱從這裡取（下拉選了現有的就直接用，選「新增」就用文字框的值）
// 這是連接「部位下拉選單 + 新增部位文字框」這組雙欄位 UI 與「送出表單時單一
// bodypart 字串值」之間的轉接函式，由 submitEducationForm() 呼叫。
// 邏輯：若下拉選單目前值是 NEW_BODYPART_VALUE，代表使用者要建立新部位，此時
// 真正要送出的值來自「新增部位」文字框（並做 trim 去除頭尾空白，避免因為
// 使用者不小心多打空格導致產生一個看似相同但實際是不同字串的部位名稱）；
// 否則下拉選單選的就是既有部位名稱字串，直接回傳。
function getSelectedBodypart() {
  const select = document.getElementById('education-input-bodypart-select');
  const newInput = document.getElementById('education-input-bodypart-new');
  if (!select) return '';
  return select.value === NEW_BODYPART_VALUE
    ? (newInput ? newInput.value.trim() : '')
    : select.value;
}

// ── 新增 / 編輯 Modal ────────────────────────────────────────────────────

// 開啟「新增衛教類別」Modal（新增模式）。
// 觸發時機：使用者點擊分頁右上角「+ 新增類別」按鈕（education.html 中的
// inline onclick="openEducationCreateModal()"）。
// 對外部狀態/DOM 的影響：
//   - 將 educationEditingBodypart、educationEditingCategory 都設為 null，
//     這是本檔案判斷「目前 Modal 處於新增模式」的依據，submitEducationForm()
//     會依此決定要送出 POST 而非 PUT。
//   - 將 Modal 標題文字設為「新增衛教類別」。
//   - 呼叫 populateBodypartOptions(null) 重建部位下拉選單（因為每次開啟都要
//     反映目前最新的部位清單），新增模式下不預先指定要選中的部位。
//   - 清空類別名稱、檔名、內容三個輸入欄位（避免殘留上一次操作的舊值）。
//   - 隱藏表單錯誤訊息區塊（避免顯示上一次操作留下的錯誤訊息）。
//   - 呼叫共用的 openModal('modal-education-edit') 顯示 Modal（該函式應為
//     後台外層提供的通用 Modal 開關工具，本檔案未定義，僅負責呼叫）。
// 此函式本身不發送任何 API 請求，純粹是畫面狀態初始化。
function openEducationCreateModal() {
  educationEditingBodypart = null;
  educationEditingCategory = null;
  document.getElementById('education-modal-title-text').textContent = '新增衛教單';
  populateBodypartOptions(null);
  document.getElementById('education-input-category').value = '';
  document.getElementById('education-input-filename').value = '';
  document.getElementById('education-input-content').value = '';
  hideEducationModalError();
  openModal('modal-education-edit');
}

// 開啟「編輯衛教類別」Modal（編輯模式）。
// 觸發時機：使用者在手風琴列表中點擊某一列的「編輯」按鈕（見
// renderEducationTable() 內對 button[data-action="edit"] 的 click 監聽器）。
// 參數：
//   bodypart - 該筆資料目前所屬的部位名稱（編輯前的原始值）
//   category - 該筆資料目前的類別名稱（編輯前的原始值）
// 邏輯與資料流程：
//   1. 先從本地已載入的 educationList 找出對應項目（不需要重新打 API，因為
//      列表資料已經在記憶體中）。找不到（理論上不太會發生，除非資料剛好被
//      其他管理員同時刪除）則用 eduToast() 顯示「找不到此類別的資料」並直接
//      中止，不開啟 Modal。
//   2. 將 educationEditingBodypart / educationEditingCategory 設為這兩個
//      「編輯前的原始值」——之後儲存時，submitEducationForm() 會用這兩個值
//      組出 PUT /api/education/<bodypart>/<category> 的 URL 路徑，即使使用者
//      在表單中把部位/類別名稱都改掉，後端依然能靠 URL 中的原始值準確定位
//      要更新的是哪一筆，並允許同時完成改名。
//   3. 將 Modal 標題設為「編輯衛教類別」，呼叫 populateBodypartOptions(item.bodypart)
//      重建部位下拉選單並預選目前所屬部位，把類別名稱、檔名分別填入對應輸入框。
//   4. 內容欄位先填入暫時的「載入中...」文字（因為列表 API 不含實際內容文字，
//      需要另外發一個請求才能拿到），並先呼叫 openModal() 讓 Modal 立即顯示，
//      不等內容載入完成才開啟視窗，改善使用者體感速度。
//   5. 呼叫 GET /api/education-content/<filename>（見下方註解）非同步取得
//      實際內容後，才把 textarea 的值換成真正的檔案內容。
async function openEducationEditModal(bodypart, category) {
  const item = educationList.find(i => i.bodypart === bodypart && i.category === category);
  if (!item) {
    eduToast('找不到此衛教單的資料', false);
    return;
  }

  educationEditingBodypart = bodypart;
  educationEditingCategory = category;
  document.getElementById('education-modal-title-text').textContent = '編輯衛教單';
  populateBodypartOptions(item.bodypart);
  document.getElementById('education-input-category').value = item.category;
  document.getElementById('education-input-filename').value = item.filename;
  document.getElementById('education-input-content').value = '載入中...';
  hideEducationModalError();
  openModal('modal-education-edit');

  // content 不在列表 API 裡，另外抓 md 檔實際內容帶入
  // 對應後端 API：GET /api/education-content/<filename>
  //   - Request：filename 需經過 encodeURIComponent() 編碼後放入 URL 路徑，
  //     避免檔名中若含有特殊字元（例如空白、中文）破壞 URL 結構；帶
  //     credentials: 'same-origin' 讓後端能辨識登入身分。
  //   - Response（成功 200）：{filename, content}，content 即該 .md 檔案的
  //     完整原始文字內容。
  //   - Response（失敗，例如檔案不存在，回 404）：{error: "..."}。
  // 資料流程：成功則把 data.content 填入 #education-input-content textarea，
  // 讓管理員看到並可以編輯目前的實際衛教內容文字；失敗則把 textarea 清空為
  // 空字串，並呼叫 showEducationModalError() 在 Modal 內顯示錯誤訊息（例如
  // 檔案不存在），讓管理員知道內容載入失敗但仍可在此 Modal 內處理（例如
  // 重新指定一個有效的檔名，或直接補上內容文字後儲存）。
  // 例外處理：網路層級錯誤（例如斷線）會被 catch 攔截，textarea 清空、顯示
  // 「讀取衛教內容時發生錯誤」，並記錄到 console，不會讓整個 Modal 卡死或
  // 拋出未攔截的例外。
  try {
    const res = await fetch(`/api/education-content/${encodeURIComponent(item.filename)}`, { credentials: 'same-origin' });
    const data = await res.json();
    document.getElementById('education-input-content').value = res.ok ? data.content : '';
    if (!res.ok) {
      showEducationModalError(data.error || '讀取衛教內容失敗');
    }
  } catch (err) {
    document.getElementById('education-input-content').value = '';
    showEducationModalError('讀取衛教內容時發生錯誤');
    console.error('[education] read content error', err);
  }
}

// 關閉「新增/編輯」Modal。
// 觸發時機：使用者點擊 Modal 內的「取消」按鈕（education.html inline
// onclick="closeEducationEditModal()"）。呼叫共用的 closeModal('modal-education-edit')
// 隱藏 Modal，並清除表單錯誤訊息（避免下次開啟 Modal 時殘留上一次的錯誤文字）。
// 注意：此函式不會重置 educationEditingBodypart/educationEditingCategory 或清空
// 輸入欄位——這些狀態會在下次呼叫 openEducationCreateModal() 或
// openEducationEditModal() 時被重新設定，因此不影響下一次開啟 Modal 的正確性。
function closeEducationEditModal() {
  closeModal('modal-education-edit');
  hideEducationModalError();
}

// 在「新增/編輯」Modal 內顯示一則表單層級的錯誤訊息（對應 DOM 元素
// #education-modal-error）。用於呈現前端必填檢查失敗（見 submitEducationForm()）
// 或後端 API 回應的錯誤內容（例如「類別名稱已存在」「檔名已被使用」），讓管理員
// 不需要關閉 Modal 就能看到具體失敗原因並就地修正後重新送出。
function showEducationModalError(msg) {
  const el = document.getElementById('education-modal-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

// 隱藏並清空「新增/編輯」Modal 的錯誤訊息區塊。在每次開啟 Modal
// （openEducationCreateModal()/openEducationEditModal()）或關閉 Modal
// （closeEducationEditModal()）時呼叫，確保錯誤訊息不會跨次操作殘留誤導使用者。
function hideEducationModalError() {
  const el = document.getElementById('education-modal-error');
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

// 送出「新增/編輯」表單：依目前是新增模式或編輯模式，呼叫對應的後端 API
// 建立或更新一筆 (部位, 類別) → 檔名/內容 的對照關係。
// 觸發時機：使用者在 Modal 中點擊「儲存」按鈕（education.html inline
// onclick="submitEducationForm()"）。
// 參數來源：直接從 Modal 內各輸入元件讀值——
//   - bodypart：透過 getSelectedBodypart() 取得（會依下拉選單是否選了
//     「+ 新增部位…」，決定要讀下拉值還是文字輸入框的值）
//   - category、filename、content：分別讀取對應輸入框/textarea 的 value，
//     並統一做 trim() 去除頭尾空白。
// 前端驗證：四個欄位（部位、類別、檔名、內容）皆不可為空字串，否則呼叫
// showEducationModalError() 顯示提示並中止，不會發出任何 API 請求。這是後端
// 「所有欄位皆必填」規則在前端的第一層防線，即使前端漏擋，後端仍會再次驗證。
// 送出前置動作：暫時 disable「儲存」按鈕（避免使用者重複點擊造成重複送出
// 兩個新增請求）、顯示載入中提示。
// 依模式決定呼叫哪個 API：
//   - educationEditingCategory === null（新增模式）：
//       對應後端 API：POST /api/education
//       Request body：{bodypart, category, content, filename}（JSON）
//       後端行為：檢查 category 名稱是否已存在於其他部位下（category 需全域
//       唯一）、檢查 filename 是否已被其他 (部位,類別) 佔用且非刻意共用，
//       檔名若缺少 .md 副檔名會自動補上並做路徑安全處理；驗證通過後同時寫入
//       category.json 與建立/覆寫對應的 .md 檔案內容。
//   - 否則（editingCategory 有值，編輯模式）：
//       對應後端 API：PUT /api/education/<educationEditingBodypart>/<educationEditingCategory>
//       （URL 中的 bodypart/category 皆用 encodeURIComponent() 編碼，避免中文
//       或特殊字元破壞 URL 結構；這兩個值是「編輯前」的原始值，用來讓後端
//       準確定位要更新的是哪一筆既有資料）
//       Request body：{bodypart, category, content, filename}（此處欄位是
//       「編輯後」使用者想要的新值，可能與 URL 中的原始值不同，代表要改名/
//       改檔名/改內容）
//       後端行為：改名/改檔名時的唯一性衝突檢查邏輯與新增相同；驗證通過後
//       更新 category.json 對應項目，並覆寫或視需要搬移/建立 .md 檔案內容。
// 回應處理：
//   - res.ok 為 false（例如驗證失敗、非管理員 403、找不到原始資料 404 等）：
//     呼叫 showEducationModalError(data.error || '儲存失敗，請稍後再試')，
//     Modal 保持開啟讓管理員修正後重試，不會清空已輸入的內容。
//   - res.ok 為 true（成功）：
//       1. 狀態維護：若編輯前的部位（educationEditingBodypart）與儲存後的新
//          部位（bodypart）不同，代表這筆資料被搬到別的部位底下了，所以把
//          舊部位從 expandedBodyparts 移除（該部位底下可能已經沒有這筆資料，
//          不需要強制保持展開），並將新部位加入 expandedBodyparts（確保
//          reload 後管理員能立刻在展開狀態下看到剛存的這筆資料，不必自己
//          再去點開）。
//       2. 呼叫 closeEducationEditModal() 關閉 Modal。
//       3. 呼叫 eduToast('衛教資料已儲存', true) 顯示成功提示。
//       4. 呼叫 await loadEducationList() 重新向後端拉取最新列表並重新渲染，
//          確保畫面上的資料與後端 category.json 的最新狀態一致（而不是自己
//          在前端手動拼接更新後的物件塞回 educationList，這樣可以避免前端
//          與後端資料結構假設不一致所導致的顯示錯誤）。
// 例外處理：網路層級錯誤（fetch 失敗、JSON 解析失敗等）由 catch 攔截，顯示
// 「儲存時發生錯誤，請稍後再試」並記錄到 console。無論成功或失敗，finally
// 區塊都會重新啟用「儲存」按鈕並關閉載入中提示。
async function submitEducationForm() {
  const bodypart = getSelectedBodypart();
  const category = document.getElementById('education-input-category').value.trim();
  const filename = document.getElementById('education-input-filename').value.trim();
  const content = document.getElementById('education-input-content').value.trim();

  if (!bodypart || !category || !filename || !content) {
    showEducationModalError('部位或科別、衛教單名稱、檔名與衛教內容皆不可空白');
    return;
  }

  const saveBtn = document.getElementById('education-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  eduShowLoading();

  try {
    let res;
    if (educationEditingCategory === null) {
      // 新增
      res = await fetch('/api/education', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ bodypart, category, content, filename })
      });
    } else {
      // 編輯（含可能的部位/類別改名）
      res = await fetch(
        `/api/education/${encodeURIComponent(educationEditingBodypart)}/${encodeURIComponent(educationEditingCategory)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ bodypart, category, content, filename })
        }
      );
    }
    const data = await res.json();

    if (!res.ok) {
      showEducationModalError(data.error || '儲存失敗，請稍後再試');
      return;
    }

    // 存檔後如果部位有變動，記得展開新的部位，讓使用者馬上看到剛存的資料
    if (educationEditingBodypart && educationEditingBodypart !== bodypart) {
      expandedBodyparts.delete(educationEditingBodypart);
    }
    expandedBodyparts.add(bodypart);

    closeEducationEditModal();
    eduToast('衛教資料已儲存', true);
    await loadEducationList();
  } catch (err) {
    showEducationModalError('儲存時發生錯誤，請稍後再試');
    console.error('[education] save error', err);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    eduHideLoading();
  }
}

// ── 刪除 ─────────────────────────────────────────────────────────────────

// 開啟「刪除確認」Modal，並記錄要刪除的目標。
// 觸發時機：使用者在手風琴列表中點擊某一列的「刪除」按鈕（見
// renderEducationTable() 內對 button[data-action] 非 'edit' 情況的處理）。
// 參數：
//   bodypart - 要刪除的項目所屬部位名稱
//   category - 要刪除的項目類別名稱
// 邏輯：將 {bodypart, category} 存入模組層級變數 educationDeleteTarget，供
// 之後 confirmDeleteEducation() 讀取；把「部位 / 類別」組成的描述文字填入
// #education-delete-target，讓刪除確認 Modal 上的提示文字（見 education.html）
// 能明確顯示即將刪除哪一筆，降低誤刪風險；最後呼叫共用的
// openModal('modal-education-delete') 顯示確認 Modal。此函式本身不發送任何
// API 請求，純粹是確認流程的第一步。
function openEducationDeleteModal(bodypart, category) {
  educationDeleteTarget = { bodypart, category };
  document.getElementById('education-delete-target').textContent = `${bodypart} / ${category}`;
  openModal('modal-education-delete');
}

// 真正執行刪除動作：使用者在確認 Modal 中點擊「確認刪除」按鈕（education.html
// inline onclick="confirmDeleteEducation()"）時觸發。
// 前置檢查：若 educationDeleteTarget 為 null（理論上不應發生，除非在未經
// openEducationDeleteModal() 設定目標的情況下被直接呼叫），直接 return 不做
// 任何事，避免對 undefined 目標發出無意義的請求。
// 對應後端 API：DELETE /api/education/<bodypart>/<category>
//   - Request：bodypart、category 皆用 encodeURIComponent() 編碼後放入 URL
//     路徑（避免中文或特殊字元破壞路徑結構），不需要帶 body，但需
//     credentials: 'same-origin' 讓後端可辨識登入身分並套用 @admin_required
//     檢查。
//   - Response（成功 200）：代表該筆 (bodypart, category) 對照已從
//     category.json 移除。後端在移除這筆對照關係之後，還會額外檢查
//     category.json 裡是否還有其他任何 (部位, 類別) 引用相同的 .md 檔名——
//     若「沒有」其他引用者，才會把該 .md 實體檔案從硬碟一併刪除；若「還有」
//     其他類別在共用同一份內容檔，則只移除這筆對照關係，保留檔案本體不刪除。
//     這個「引用計數」式的判斷是為了避免誤刪仍被其他類別使用的共用衛教文章，
//     或是相反地在硬碟上留下永遠不會再被讀取的孤兒 .md 檔案。
//   - Response（失敗，例如非管理員 403、資料不存在 404）：{error: "..."}，
//     前端顯示 data.error 或預設的「刪除失敗」文字。
// 成功後的處理：關閉刪除確認 Modal（closeModal）、顯示成功 toast、清空
// educationDeleteTarget（避免殘留上次的目標值），並呼叫 await
// loadEducationList() 重新從後端拉取最新列表以反映刪除結果（畫面上該列會
// 因為不再存在於 educationList 而自然從渲染結果中消失）。
// 例外處理：網路層級錯誤由 catch 攔截，顯示「刪除時發生錯誤」toast 並記錄到
// console；無論成功或失敗，finally 區塊都會關閉載入中提示。
async function confirmDeleteEducation() {
  if (!educationDeleteTarget) return;
  const { bodypart, category } = educationDeleteTarget;

  eduShowLoading();
  try {
    const res = await fetch(
      `/api/education/${encodeURIComponent(bodypart)}/${encodeURIComponent(category)}`,
      { method: 'DELETE', credentials: 'same-origin' }
    );
    const data = await res.json();

    if (!res.ok) {
      eduToast(data.error || '刪除失敗', false);
      return;
    }

    closeModal('modal-education-delete');
    eduToast('已刪除衛教單', true);
    educationDeleteTarget = null;
    await loadEducationList();
  } catch (err) {
    eduToast('刪除時發生錯誤', false);
    console.error('[education] delete error', err);
  } finally {
    eduHideLoading();
  }
}

// ── 初始載入 ────────────────────────────────────────────────────────────

// 頁面（此分頁對應的 DOM 內容）載入完成後的進入點：監聽瀏覽器原生的
// DOMContentLoaded 事件（代表 HTML 文件已完全解析、DOM 樹已就緒，不需要等待
// 圖片等外部資源載入完成），一旦觸發就立即呼叫 loadEducationList() 向後端
// 取得目前的衛教資料列表並渲染到畫面上，讓管理員一進入這個分頁就能看到現有
// 資料，不需要任何額外操作。這是本檔案唯一的自動執行入口，其餘所有函式都是
// 被動等待使用者互動（點擊按鈕、切換下拉選單等）或被其他函式呼叫。
document.addEventListener('DOMContentLoaded', () => {
  loadEducationList();
});