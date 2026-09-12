// ════════════════════════════════════════════════════════════════════════
// 檔案總覽：prompt.js — 「AI Prompt 版本管理」分頁的前端邏輯
// ════════════════════════════════════════════════════════════════════════
//
// 【這個檔案在整體系統中的角色】
//   本檔案負責管理員後台「系統 Prompt 修改」分頁（對應
//   webpage/admin/html/prompt.html 的 DOM）之互動邏輯。這個分頁用來管理
//   LINE Bot 在呼叫 LLM（Gemini / OpenAI / Ollama，由環境變數 LLM_PROVIDER
//   決定，見 src/bot.py）時所使用的「System Prompt（系統提示詞）」。
//   所有對後端的存取都是透過共用的 api() 輔助函式（定義於其他共用 JS，
//   例如 common.js）呼叫 src/admin_server.py 內註冊在 admin_bp 的
//   /api/prompt* 系列端點；除了 GET /api/prompt 之外，其餘寫入類端點皆套
//   用 @admin_required 裝飾器，非管理員登入時後端會回傳 403。
//
// 【版本管理的完整概念模型 —— 務必先理解，才能看懂下面每個函式】
//   1. 「版本檔案」：每一次「儲存」都會在後端 assets/prompts/ 目錄下產生一個
//      新檔案 prompt_NNN.md（NNN 為 3 位數、由後端自動決定，永遠取目前最大
//      編號 +1，絕不覆蓋、也絕不重複使用舊編號）。因此「儲存」＝「新增版本」，
//      並不會修改任何既有版本的內容，這一點在 UI 文案（prompt-info 區塊）也
//      有提示：「修改將會儲存並新增一個版本」。
//      prompt_001.md 是最原始的版本，後端保證它永遠存在、不可被刪除。
//   2. 「啟用中版本 (active_version)」：記錄在後端 data/prompt_config.json 的
//      current_version 欄位，代表 LINE Bot 實際會拿去當 System Prompt 使用
//      的版本。並非最新建立的版本就自動變成啟用中版本 —— 「新增版本」與
//      「切換成啟用中」是兩個獨立的動作，必須另外呼叫切換（套用）API。
//   3. 「瀏覽中版本 (viewingVersion / current_version，注意此處後端回傳欄位
//      名稱容易與『啟用中版本』搞混：GET /api/prompt 回傳的 current_version
//      其實是『目前正在瀏覽/編輯的版本』，而 active_version 才是『目前啟用
//      中的版本』)」：使用者透過左側版本列表點擊、或用 ↩️/↪️ 按鈕前後翻頁時，
//      切換的是「瀏覽中版本」，此時只是載入該版本內容到編輯框讓你查看/編輯，
//      並不會影響 LINE Bot 正在使用哪一版，直到按下「套用」才會真正切換。
//   4. 「暱稱 (nicknames)」：純粹是 UI 上的顯示輔助，讓管理員可以幫某個版本
//      取一個好記的名字（例如「活潑版本」），實際存放在 prompt_config.json
//      的 nicknames 物件中，key 是版本檔名、value 是暱稱字串。暱稱不影響
//      任何 Prompt 內容或啟用邏輯，純粹讓版本列表 UI 更好辨識。
//   5. 「{context} 佔位符」：Prompt 內容中若包含字串 {context}，LINE Bot 端
//      （src/bot.py 的 generate_gemini_reply）在真正呼叫 LLM 前，會把該次
//      對話透過 RAG 檢索到的衛教資料內容動態替換進去，因此管理員在編輯
//      Prompt 時應保留此佔位符，讓 LLM 能拿到即時檢索的知識庫內容作為佐證。
//
// 【全域狀態物件 state（定義於其他共用 JS，此檔案只是讀寫其欄位）】
//   本檔案會讀寫的欄位包括：
//     state.originalPromptContent — 目前「瀏覽中版本」載入時的原始內容快照，
//         用來跟 textarea 目前輸入值比較，判斷使用者是否已修改（是否要
//         enable「儲存並新增」按鈕）。
//     state.viewingVersion — 目前瀏覽/編輯中的版本檔名（例如 'prompt_003.md'）。
//     state.activeVersion  — 目前系統啟用中的版本檔名。
//     state.prevVersion / state.nextVersion — 依版本編號排序後，瀏覽中版本
//         的「上一版」「下一版」檔名，用於 ↩️/↪️ 按鈕的翻頁功能；若沒有上一版
//         或下一版則為 undefined，對應按鈕會被隱藏。
//
// 【本檔案會呼叫的後端 API 一覽（皆定義於 src/admin_server.py）】
//     GET  /api/prompt?version=<可選>      → 讀取指定版本內容 + 版本列表等中繼資料
//     POST /api/prompt        {content}     → 儲存為「新版本」（自動編號 +1）
//     POST /api/prompt/switch {version}     → 將指定版本設為「啟用中版本」
//     POST /api/prompt/delete {version?}    → 刪除指定版本（001 不可刪除）
//     POST /api/prompt/nickname {version, nickname} → 設定/更新版本暱稱
//   （/api/prompt/rollback 為後端提供但本檔案目前透過翻頁 + 套用的組合流程
//    達成類似效果；實際「回溯」是靠 loadPrompt(state.prevVersion) 瀏覽舊版，
//    再由使用者按下「套用」呼叫 /api/prompt/switch 來真正切換啟用版本。）
// ════════════════════════════════════════════════════════════════════════

// ──── 區塊：修改狀態偵測 ────────────────────────────────────────────
// checkPromptModified()
//   用途：比對編輯框（#prompt-textarea）目前的文字內容，與載入時記錄在
//         state.originalPromptContent 的「原始內容快照」是否相同，藉此判斷
//         使用者是否對目前瀏覽的版本做了修改。
//   觸發時機：綁定在 <textarea id="prompt-textarea"> 的 oninput 事件（見
//         prompt.html），也就是使用者每次在編輯框中打字/貼上/刪除文字時都
//         會即時觸發一次。另外在 loadPrompt() 載入版本完成後也會手動呼叫
//         一次，用來重置「儲存並新增」按鈕的 disabled 狀態。
//   對外部的影響：只會操作 DOM，不會呼叫任何後端 API。若內容與原始快照不同
//         （modified === true），會把 #btn-save-prompt（「💾 儲存並新增」按鈕）
//         的 disabled 屬性設為 false 使其可點擊；若內容與原始快照相同（代表
//         沒有任何變更），則保持/恢復 disabled = true，避免使用者對未變更的
//         內容重複建立無意義的新版本。
function checkPromptModified() {
  const ta = document.getElementById('prompt-textarea');
  const btnSave = document.getElementById('btn-save-prompt');
  if (!btnSave) return;
  const modified = ta.value !== (state.originalPromptContent || '');
  btnSave.disabled = !modified;
}

// ──── 區塊：載入指定版本內容（分頁的核心資料流程） ──────────────────
// loadPrompt(version)
//   用途：這是本頁面最核心的函式，負責向後端請求「某個版本的 Prompt 內容」，
//         並把回傳的中繼資料（啟用中版本、暱稱、上一版/下一版、完整版本
//         列表…）同步渲染到頁面上所有相關的 DOM 元素。
//   觸發時機：
//     1. 分頁初次載入時（由頁面初始化流程呼叫，不帶 version 參數）。
//     2. 使用者點擊左側版本列表中的任一版本項目時（見
//        renderPromptVersionsList() 產生的 onclick="loadPrompt('xxx')"）。
//     3. 使用者按 ↩️（prevPromptVersion）或 ↪️（nextPromptVersion）翻頁時。
//     4. 儲存新版本成功後（doSavePrompt 內呼叫 loadPrompt(res.version)，
//        直接跳去顯示剛新增的版本，讓使用者立即看到剛儲存的內容）。
//     5. 套用（切換啟用版本）成功後（doApplyPrompt 內呼叫 loadPrompt(version)，
//        重新整理頁面狀態以反映「這個版本現在是啟用中」）。
//     6. 刪除版本成功後（doDeletePrompt 內呼叫 loadPrompt(res.version)，
//        後端刪除時已自動決定新的啟用版本並回傳在 res.version 中，
//        前端據此導向顯示該版本）。
//     7. 設定暱稱成功後（savePromptNickname 內呼叫 loadPrompt(version)，
//        重新整理讓左側列表與標籤顯示最新的暱稱文字）。
//   參數：
//     version（可選字串）— 要瀏覽的版本檔名，例如 'prompt_003.md'。若省略
//         （undefined），則對應到呼叫 GET /api/prompt 時不帶 version 參數，
//         後端行為是回傳「目前啟用中版本」的內容，等同於「預設顯示目前
//         正在使用的 Prompt」。
//   對應後端 API：GET /api/prompt?version=<version>
//     Request：
//       - 若帶 version query string，後端會讀取該版本檔案內容來顯示；
//       - 若不帶，後端預設回傳目前啟用中版本（active_version）的內容。
//     Response（JSON）欄位說明與對應用途：
//       - content          → 目前「瀏覽中版本」的完整文字內容，寫入
//                             #prompt-textarea 讓管理員可編輯。
//       - current_version  → 目前瀏覽中版本的檔名（注意：命名上容易誤會，
//                             這裡的「current」指的是「正在瀏覽/編輯」，
//                             不是「啟用中」）。寫入 state.viewingVersion，
//                             並顯示於 #editing-version-label。
//       - active_version   → 目前系統啟用中版本的檔名，寫入
//                             state.activeVersion，顯示於 #active-version-label，
//                             並用來與 current_version 比較以決定是否顯示
//                             「目前使用中」徽章（#active-badge）。
//       - active_content   → 啟用中版本的完整內容，寫入唯讀的
//                             #prompt-active-textarea，讓管理員可以在編輯
//                             某個舊版本/新版本時，同時對照右側「目前正在
//                             運作中的版本」內容，方便比較差異。
//       - has_prev/has_next → 布林值，表示依版本編號排序後，瀏覽中版本是否
//                             還有上一版/下一版，用來決定 ↩️/↪️ 按鈕是否顯示。
//       - prev_version/next_version → 上一版/下一版的檔名，寫入
//                             state.prevVersion/state.nextVersion，供
//                             prevPromptVersion()/nextPromptVersion() 使用。
//       - versions         → 所有版本檔名的陣列（依編號排序），交給
//                             renderPromptVersionsList() 重新畫出左側整個
//                             版本列表（#prompt-version-list）。
//       - nicknames        → { 版本檔名: 暱稱字串 } 的物件，用來在各處把
//                             版本檔名轉換成「暱稱(檔名)」的可讀顯示格式
//                             （見內部 getDisplayLabel 輔助函式），並用來
//                             預填暱稱輸入框 #prompt-nickname-input 目前值。
//   渲染/狀態管理細節：
//     - 呼叫初期會先把編輯框、右側啟用中內容框都設為「載入中…」並停用/清空
//       暱稱輸入框，同時隱藏 ↩️/↪️/🗑️ 按鈕與停用「套用」按鈕，避免使用者在
//       資料尚未回來前誤觸操作或看到上一個版本殘留的按鈕狀態。
//     - 拿到回應後，若 d.error 存在（後端讀取失敗，例如版本檔案不存在），
//       則把錯誤訊息顯示在編輯框內並停用編輯框（disabled = true），直接
//       return，不繼續往下渲染其他區塊。
//     - 若 current_version === active_version（代表使用者正在瀏覽的版本
//       正好就是目前啟用中的版本），代表沒有「套用」的意義，因此：
//         * 顯示「目前使用中」徽章；
//         * 停用「套用」按鈕（disabled = true）；
//         * 隱藏右側「目前使用的 Prompt」欄位（沒有必要對照自己跟自己）；
//         * 讓中間編輯框欄位寬度從 40% 展開為 80%，充分利用版面空間。
//       反之，若瀏覽中版本不是啟用中版本，則反向操作：隱藏徽章、啟用
//       「套用」按鈕、顯示右側對照欄、把編輯框欄位縮回 40% 讓右側對照欄
//       有空間顯示。
//     - prompt_001.md 是原始版本、後端規定不可刪除，因此只有當
//       current_version 存在且不等於 'prompt_001.md' 時才顯示「🗑️ 刪除」
//       按鈕，避免使用者對必然會失敗的操作抱有期待。
//     - 最後呼叫 checkPromptModified() 重新評估「儲存並新增」按鈕的可用性
//       （因為 state.originalPromptContent 已更新為新載入版本的內容，剛
//       載入時應該是未修改狀態，此按鈕應為 disabled）。
//   錯誤情境：若 fetch/api() 呼叫過程發生例外（例如網路中斷、伺服器無回應），
//       則 catch 區塊會把編輯框內容設為「無法連線至伺服器」，並將錯誤物件
//       輸出到 console.error 供除錯，此時不會更新任何 state 欄位或其他 DOM。
async function loadPrompt(version) {
  const ta = document.getElementById('prompt-textarea');
  const activeTa = document.getElementById('prompt-active-textarea');
  const nickInput = document.getElementById('prompt-nickname-input');
  
  ta.value = '載入中…'; ta.disabled = true;
  if (activeTa) {
    activeTa.value = '載入中…';
  }
  if (nickInput) {
    nickInput.value = '';
    nickInput.disabled = true;
  }
  
  document.getElementById('save-status').textContent = '';
  document.getElementById('btn-rollback-prompt').style.display = 'none';
  document.getElementById('btn-next-prompt').style.display = 'none';
  document.getElementById('btn-delete-prompt').style.display = 'none';
  document.getElementById('btn-apply-prompt').disabled = true;
  
  const editingLabel = document.getElementById('editing-version-label');
  const activeLabel = document.getElementById('active-version-label');
  const activeBadge = document.getElementById('active-badge');
  
  if (editingLabel) editingLabel.textContent = '-';
  if (activeLabel) activeLabel.textContent = '-';
  if (activeBadge) activeBadge.style.display = 'none';
  
  try {
    // 組出實際呼叫的 API 網址：有指定 version 就帶上 query string 明確要求
    // 該版本的內容；不帶則交由後端預設回傳「目前啟用中版本」的內容。
    let url = '/api/prompt';
    if (version) {
      url += '?version=' + encodeURIComponent(version);
    }
    // 呼叫 GET /api/prompt（見 src/admin_server.py），回傳內容與版本中繼資料
    // 的完整結構請見本檔案最上方「檔案總覽」區塊的 Response 欄位說明。
    const d = await api('GET', url);
    ta.value    = d.error ? '錯誤：' + d.error : (d.content || '');
    ta.disabled = !!d.error;

    // 若後端回傳 error（例如指定版本檔案不存在或讀取失敗），直接顯示錯誤
    // 訊息並停止後續渲染，避免用殘缺/過期的資料覆蓋其他 DOM 區塊。
    if (d.error) return;

    // 小工具：把「版本檔名」轉換成給人看的顯示文字。若該版本有暱稱，顯示
    // 「暱稱(檔名)」的組合格式；若無暱稱，就單純顯示檔名本身。用於編輯框
    // 標籤與啟用中版本標籤兩處。
    const getDisplayLabel = (ver, nicknames) => {
      if (!ver) return '-';
      const nick = nicknames && nicknames[ver];
      return nick ? `${nick}(${ver})` : ver;
    };
    
    if (editingLabel) editingLabel.textContent = getDisplayLabel(d.current_version, d.nicknames);
    if (activeLabel) activeLabel.textContent = getDisplayLabel(d.active_version, d.nicknames);
    
    if (activeTa) {
      activeTa.value = d.active_content || '';
    }
    if (nickInput) {
      nickInput.disabled = false;
      nickInput.value = (d.nicknames && d.nicknames[d.current_version]) || '';
    }
    
    state.originalPromptContent = d.content || '';
    state.viewingVersion = d.current_version;
    state.activeVersion = d.active_version;
    state.prevVersion = d.prev_version;
    state.nextVersion = d.next_version;
    
    checkPromptModified();
    
    const activeCol = document.getElementById('prompt-active-column');
    const centerCol = document.querySelector('.prompt-col-center');
    
    if (d.current_version === d.active_version) {
      if (activeBadge) activeBadge.style.display = 'inline-block';
      document.getElementById('btn-apply-prompt').disabled = true;
      if (activeCol) activeCol.style.display = 'none';
      if (centerCol) centerCol.style.flex = '0 0 80%';
    } else {
      if (activeBadge) activeBadge.style.display = 'none';
      document.getElementById('btn-apply-prompt').disabled = false;
      if (activeCol) activeCol.style.display = 'flex';
      if (centerCol) centerCol.style.flex = '0 0 40%';
    }
    
    if (d.has_prev) {
      document.getElementById('btn-rollback-prompt').style.display = 'inline-block';
    }
    if (d.has_next) {
      document.getElementById('btn-next-prompt').style.display = 'inline-block';
    }
    if (d.current_version && d.current_version !== 'prompt_001.md') {
      document.getElementById('btn-delete-prompt').style.display = 'inline-block';
    }
    
    if (d.versions) {
      renderPromptVersionsList(d.versions, d.active_version, d.current_version, d.nicknames);
    }
  } catch (e) { 
    ta.value = '無法連線至伺服器'; 
    console.error(e);
  }
}

// ──── 區塊：左側版本列表渲染 ─────────────────────────────────────────
// renderPromptVersionsList(versions, activeVersion, viewingVersion, nicknames)
//   用途：把後端回傳的「所有版本檔名陣列」渲染成左側欄
//         #prompt-version-list 內的一整排可點擊列表項目，每一項顯示版本
//         的（暱稱＋）檔名，並標示出哪一個是目前啟用中版本、哪一個是目前
//         正在瀏覽的版本。
//   觸發時機：由 loadPrompt() 在成功取得 API 回應且 d.versions 存在時呼叫，
//         也就是每次載入/切換/翻頁/儲存/刪除/命名任一操作完成後，都會連帶
//         重新渲染一次整個版本列表，確保列表內容（尤其是暱稱、使用中標記）
//         永遠反映後端最新狀態。本函式不會自己呼叫任何 API，純粹是渲染。
//   參數：
//     versions       — 版本檔名陣列（例如 ['prompt_001.md', 'prompt_002.md', ...]），
//                       對應 GET /api/prompt 回應中的 versions 欄位。
//     activeVersion  — 目前啟用中版本檔名，用來判斷該列表項目是否要顯示
//                       綠色「使用中」徽章。
//     viewingVersion — 目前瀏覽中版本檔名，用來判斷該列表項目是否要加上
//                       'active'（醒目樣式）CSS class，讓使用者知道自己
//                       目前正在看哪一個版本。
//     nicknames      — { 版本檔名: 暱稱 } 物件，用來決定顯示文字是純檔名
//                       還是「暱稱(檔名)」格式。
//   渲染邏輯：對 versions 陣列的每一個檔名 v 產生一個 <div class="patient-item">
//         列表項（沿用病人列表的既有樣式 class 以維持視覺一致性），並在
//         onclick 中內嵌呼叫 loadPrompt('<v>') —— 這代表點擊任一版本列表項，
//         就會觸發重新載入該版本的內容到中間編輯框（切換「瀏覽中版本」），
//         但不會呼叫任何寫入類 API，也不會影響「啟用中版本」。
function renderPromptVersionsList(versions, activeVersion, viewingVersion, nicknames) {
  const listEl = document.getElementById('prompt-version-list');
  if (!listEl) return;
  listEl.innerHTML = versions.map(v => {
    const isActive = v === activeVersion;
    const isViewing = v === viewingVersion;
    const displayLabel = nicknames && nicknames[v] ? `${nicknames[v]}(${v})` : v;
    return `
      <div class="patient-item${isViewing ? ' active' : ''}"
           style="padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer;"
           onclick="loadPrompt('${v}')">
        <div style="font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: space-between;">
          <span>${displayLabel}</span>
          ${isActive ? '<span class="badge badge-green" style="font-size: 9px; padding: 1px 4px;">使用中</span>' : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ──── 區塊：設定版本暱稱 ─────────────────────────────────────────────
// savePromptNickname()
//   用途：把使用者在暱稱輸入框（#prompt-nickname-input）中輸入的文字，
//         儲存為「目前瀏覽中版本」的暱稱，方便日後在版本列表上快速辨識
//         這個版本的用途（例如「活潑版本」「正式上線版」等）。
//   觸發時機：綁定在「💾 儲存名稱」按鈕（#btn-save-nickname）的 onclick
//         事件（見 prompt.html），使用者手動點擊時觸發。
//   對應後端 API：POST /api/prompt/nickname
//     Request body：{ version, nickname }
//       - version  → state.viewingVersion，即目前瀏覽中的版本檔名，若為
//                     空值（尚未載入任何版本）則直接 return，不發送請求。
//       - nickname → 輸入框文字經 .trim() 去除頭尾空白後的字串；若使用者
//                     清空輸入框並儲存，等同於把該版本的暱稱清除。
//     Response：{ success, error? } —— 純粹的成功/失敗旗標，不會回傳暱稱
//         本身，因為前端會在成功後透過 loadPrompt(version) 重新整理來拿到
//         最新的暱稱資料（包含更新後的 nicknames 物件）。
//   渲染/狀態管理：
//     - 呼叫前先把 #save-status 顯示為「儲存名稱中…」讓使用者有即時回饋。
//     - 成功：顯示綠色成功訊息，並呼叫 loadPrompt(version) 重新載入目前
//       版本 —— 這一步很關鍵，因為暱稱是顯示在編輯標籤、啟用中標籤、
//       左側版本列表等多處，唯有重新呼叫 GET /api/prompt 才能拿到後端
//       最新的 nicknames 物件並同步更新所有相關 DOM。
//     - 失敗（res.success 為 false）：顯示紅色錯誤訊息，內容取自
//       res.error（若後端沒有提供則顯示預設文字「儲存名稱失敗」）。
//   錯誤情境：若請求本身發生例外（網路問題等），顯示「無法連線至伺服器」
//         並將例外物件印到 console.error 供除錯。
async function savePromptNickname() {
  const version = state.viewingVersion;
  if (!version) return;
  const nickname = document.getElementById('prompt-nickname-input').value.trim();
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '儲存名稱中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt/nickname', { version, nickname });
    if (res.success) {
      statusEl.textContent = '✅ 已成功儲存版本名稱';
      statusEl.className   = 'save-status ok';
      loadPrompt(version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '儲存名稱失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch (err) {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
    console.error(err);
  }
}

// ──── 區塊：儲存並新增版本 ───────────────────────────────────────────
// savePrompt()
//   用途：單純的轉接函式，綁定在「💾 儲存並新增」按鈕（#btn-save-prompt）
//         的 onclick 事件（見 prompt.html），實際邏輯委派給 doSavePrompt()。
//         之所以拆成兩層，是讓 HTML 的 onclick 保持簡潔，並讓非同步邏輯
//         獨立成一個可被其他流程（若未來需要）重複呼叫的函式。
//   觸發時機：使用者在編輯框修改內容（觸發 checkPromptModified 讓按鈕變為
//         可點擊）後按下此按鈕。
function savePrompt() {
  doSavePrompt();
}

// doSavePrompt()
//   用途：把編輯框目前的完整文字內容，以「新增一個版本」的方式送到後端
//         儲存。這是整個版本管理機制的起點：任何一次「儲存」都會在
//         assets/prompts/ 目錄下產生一個全新的 prompt_NNN.md 檔案，NNN 為
//         後端自動計算出的「目前最大版本編號 + 1」，因此版本號永遠只會
//         遞增、不會覆蓋既有檔案，也不會重複使用已刪除版本留下的編號空缺
//         ——這樣設計是為了讓「回溯」「切換」等操作永遠能明確對應到一個
//         不會被之後的操作意外改變內容的檔案，形成可靠的版本歷史紀錄。
//   觸發時機：由 savePrompt() 呼叫，也就是使用者點擊「💾 儲存並新增」時。
//   對應後端 API：POST /api/prompt
//     Request body：{ content } —— 編輯框（#prompt-textarea）目前的完整
//         文字內容，未經任何前端驗證或轉換直接送出。
//     Response：{ success, saved_at, version, error? }
//       - success → 是否儲存成功。
//       - version → 新建立的版本檔名（例如 'prompt_004.md'），前端會
//                    立刻用這個檔名呼叫 loadPrompt(res.version)，讓畫面
//                    自動跳去顯示剛剛新增的這個版本 —— 讓使用者能立即
//                    確認「儲存並新增」動作確實產生了一個新版本。
//       - saved_at → 儲存時間戳（本函式目前未使用此欄位於畫面顯示，僅
//                    透過 success 訊息文字告知使用者已儲存完成）。
//   重要：此操作只是「新增版本」，並不會讓新版本自動變成「啟用中版本」，
//         LINE Bot 仍會繼續使用原本的啟用版本，直到管理員另外按下
//         「套用」（applyPrompt/doApplyPrompt，呼叫 /api/prompt/switch）
//         才會真正切換 LINE Bot 實際使用的 System Prompt。
//   渲染：呼叫前先顯示「儲存中…」；成功後顯示「已儲存並新增版本：<檔名>」
//         並重新載入該版本；失敗則顯示後端提供的錯誤訊息或預設文字。
//   錯誤情境：fetch/api() 例外時顯示「無法連線至伺服器」。
async function doSavePrompt() {
  const content = document.getElementById('prompt-textarea').value;
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '儲存中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt', { content });
    if (res.success) {
      statusEl.textContent = '✅ 已儲存並新增版本：' + (res.version || '');
      statusEl.className   = 'save-status ok';
      loadPrompt(res.version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '儲存失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
  }
}

// ──── 區塊：版本瀏覽翻頁（上一版 / 下一版） ─────────────────────────
// prevPromptVersion()
//   用途：把編輯區切換到「目前瀏覽中版本」的上一個版本（依版本編號排序），
//         純粹是瀏覽層級的操作，不會呼叫任何寫入類 API，也不會影響
//         LINE Bot 目前實際啟用的版本。
//   觸發時機：綁定在 ↩️ 按鈕（#btn-rollback-prompt，title="前一個版本"）的
//         onclick 事件。注意：此按鈕文案雖用了「rollback」的命名（沿用
//         DOM id），但實際語義是「往舊版本方向翻一頁瀏覽」，真正要讓
//         LINE Bot 套用該版本仍需另外按下「套用」按鈕。
//   邏輯：若 state.prevVersion 有值（代表 loadPrompt() 先前回應中
//         has_prev 為 true 才會顯示此按鈕），呼叫 loadPrompt() 載入該
//         版本；若沒有上一版（已是最舊版本），按鈕本身就不會顯示，因此
//         這裡的 if 判斷是雙重保險。
function prevPromptVersion() {
  if (state.prevVersion) {
    loadPrompt(state.prevVersion);
  }
}

// nextPromptVersion()
//   用途：與 prevPromptVersion() 對稱，把編輯區切換到「目前瀏覽中版本」
//         的下一個版本（依版本編號排序，也就是較新的版本）。
//   觸發時機：綁定在 ↪️ 按鈕（#btn-next-prompt，title="後一個版本"）的
//         onclick 事件。
//   邏輯：若 state.nextVersion 有值則呼叫 loadPrompt() 載入該版本；同樣
//         純瀏覽操作，不影響啟用中版本。
function nextPromptVersion() {
  if (state.nextVersion) {
    loadPrompt(state.nextVersion);
  }
}

// ──── 區塊：套用（切換啟用中版本） ───────────────────────────────────
// applyPrompt()
//   用途：開啟「確認套用此 Prompt 版本」的警示彈窗（modal），讓管理員在
//         真正切換 LINE Bot 使用的 System Prompt 之前，有一次明確的二次
//         確認機會 —— 因為這個操作會立即影響所有使用者接下來收到的
//         LINE Bot 回覆內容，屬於高風險操作。
//   觸發時機：綁定在「套用」按鈕（#btn-apply-prompt）的 onclick 事件。
//         此按鈕只有在「瀏覽中版本 ≠ 啟用中版本」時才會被啟用（見
//         loadPrompt() 的按鈕狀態管理邏輯），避免對已經是啟用中的版本
//         做出無意義的套用操作。
//   對外部影響：只是開啟 #modal-confirm-apply-prompt 這個 modal（呼叫
//         共用的 openModal()），尚未呼叫任何後端 API；真正送出請求的
//         邏輯在使用者於彈窗中點擊「確認套用」後，才由 doApplyPrompt()
//         執行。
function applyPrompt() {
  openModal('modal-confirm-apply-prompt');
}

// doApplyPrompt()
//   用途：使用者在確認彈窗中點擊「確認套用」後真正執行的動作 —— 把目前
//         「瀏覽中版本」設定為系統的「啟用中版本」，也就是讓 LINE Bot
//         之後產生回覆時，改用這個版本的內容當作 System Prompt。
//   觸發時機：綁定在 modal-confirm-apply-prompt 彈窗內「確認套用」按鈕的
//         onclick 事件（見 prompt.html）。函式一開始先呼叫
//         closeModal('modal-confirm-apply-prompt') 關閉彈窗，再繼續執行
//         實際的套用邏輯。
//   對應後端 API：POST /api/prompt/switch
//     Request body：{ version } —— state.viewingVersion，即目前正在瀏覽
//         的版本檔名；若此值為空（理論上不應發生，因為按鈕只在有瀏覽中
//         版本時才可點擊），直接 return 不送出請求。
//     Response：{ success, error? }
//   後端行為補充：後端在切換成功時，除了更新
//         data/prompt_config.json 的 current_version 欄位外，還會把該
//         版本的內容複製一份到 assets/prompt.md（LINE Bot 端可能讀取的
//         固定路徑），確保「啟用中版本」與 LINE Bot 實際讀到的內容
//         保持同步一致。
//   渲染：呼叫前顯示「套用中…」；成功後顯示成功訊息，並呼叫
//         loadPrompt(version) 重新載入目前版本 —— 這一步會讓
//         current_version === active_version 成立，因此畫面會自動切換成
//         「顯示使用中徽章、隱藏右側對照欄、隱藏套用按鈕」的狀態（見
//         loadPrompt() 內對應邏輯）。失敗則顯示錯誤訊息。
//   錯誤情境：fetch/api() 例外時顯示「無法連線至伺服器」。
async function doApplyPrompt() {
  closeModal('modal-confirm-apply-prompt');
  const version = state.viewingVersion;
  if (!version) return;
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '套用中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt/switch', { version });
    if (res.success) {
      statusEl.textContent = '✅ 已成功套用此 Prompt 版本';
      statusEl.className   = 'save-status ok';
      loadPrompt(version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '套用失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
  }
}

// ──── 區塊：刪除版本 ────────────────────────────────────────────────
// deletePrompt()
//   用途：開啟「確認刪除目前版本」的警示彈窗，作為刪除操作前的二次確認
//         ——因為刪除版本檔案是不可逆的破壞性操作。
//   觸發時機：綁定在「🗑️ 刪除」按鈕（#btn-delete-prompt）的 onclick 事件。
//         此按鈕只有在瀏覽中版本存在且不是 prompt_001.md（原始版本，
//         後端規定永不可刪除）時才會顯示（見 loadPrompt() 邏輯）。
//   對外部影響：只是開啟 #modal-confirm-delete-prompt 這個 modal，尚未
//         呼叫任何後端 API。
function deletePrompt() {
  openModal('modal-confirm-delete-prompt');
}

// doDeletePrompt()
//   用途：使用者在確認彈窗中點擊「確認刪除」後真正執行的動作 —— 刪除
//         目前「瀏覽中版本」對應的檔案。
//   觸發時機：綁定在 modal-confirm-delete-prompt 彈窗內「確認刪除」按鈕
//         的 onclick 事件。函式一開始先呼叫
//         closeModal('modal-confirm-delete-prompt') 關閉彈窗。
//   對應後端 API：POST /api/prompt/delete
//     Request body：{ version } —— state.viewingVersion，即目前正在瀏覽
//         打算刪除的版本檔名；若為空則直接 return。
//     Response：{ success, version, error? }
//       - version → 後端刪除完成後，回傳「新的啟用中版本」檔名。這是因為
//         若刪除的正好是目前啟用中版本，後端會自動決定一個新的啟用版本
//         （優先切換到編號較小的上一版，找不到則改用下一版，兩者都沒有
//         的話最終退回 prompt_001.md），並同步更新 assets/prompt.md；
//         即使刪除的不是啟用中版本，後端也會回傳目前（刪除後仍然有效的）
//         啟用中版本檔名，讓前端可以統一用 loadPrompt(res.version) 導向
//         一個必定存在的版本，避免畫面停留在已被刪除、不存在的版本上。
//       - 後端同時會清除被刪除版本在 nicknames 中的記錄，避免殘留無效
//         的暱稱資料指向一個已經不存在的檔案。
//   失敗情境（來自後端）：若試圖刪除 prompt_001.md，後端會回傳 400 錯誤，
//         此時 res.success 為 false，前端顯示 res.error 或預設文字
//         「刪除失敗」（正常情況下 UI 已經隱藏了對 001 版本的刪除按鈕，
//         所以這個情境理論上不會被一般操作觸發，屬於後端端的最後防線）。
//   渲染：呼叫前顯示「刪除中…」；成功後顯示成功訊息並呼叫
//         loadPrompt(res.version) 導向刪除後的新狀態；失敗則顯示錯誤訊息。
//   錯誤情境：fetch/api() 例外時顯示「無法連線至伺服器」。
async function doDeletePrompt() {
  closeModal('modal-confirm-delete-prompt');
  const version = state.viewingVersion;
  if (!version) return;
  const statusEl = document.getElementById('save-status');
  statusEl.textContent = '刪除中…'; statusEl.className = 'save-status';
  try {
    const res = await api('POST', '/api/prompt/delete', { version });
    if (res.success) {
      statusEl.textContent = '✅ 已成功刪除版本';
      statusEl.className   = 'save-status ok';
      loadPrompt(res.version);
    } else {
      statusEl.textContent = '❌ ' + (res.error || '刪除失敗');
      statusEl.className   = 'save-status fail';
    }
  } catch {
    statusEl.textContent = '❌ 無法連線至伺服器';
    statusEl.className   = 'save-status fail';
  }
}

