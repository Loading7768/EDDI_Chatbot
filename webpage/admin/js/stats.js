// ════════════════════════════════════════════════════════════════════════
// 檔案總覽：stats.js — 統計儀表板分頁的前端邏輯
// ════════════════════════════════════════════════════════════════════════
// 本檔案對應的畫面是 webpage/admin/html/stats.html 中的 <section id="section-stats">
// （急診出院衛教 LINE Bot + 醫護後台管理系統的「統計數據」分頁）。
//
// 【整體架構定位】
// 這是後台管理系統前端（純 vanilla JS，無框架）的其中一支功能模組，負責：
//   1. 向後端拉取系統整體使用統計數據並渲染到畫面上的統計卡片（loadStats）。
//   2. 提供「將目前統計數據匯出成 CSV 檔案」的功能（exportStatsCSV）。
// 兩者都仰賴全域共用的 api() 輔助函式（定義於本後台其他共用 JS 檔案中，這裡
// 未重複定義）來發送 HTTP 請求；api('GET', '/api/stats') 實際上會對後端發出
// 「GET /api/stats」請求，並自動帶上登入用的 session cookie（因為
// GET /api/stats 這個後端路由套用了 @login_required 裝飾器，只有已登入的
// 醫師帳號才能取得資料，不需要額外的管理員權限）。
//
// 【對應的後端 API：GET /api/stats】
// 定義於 src/admin_server.py 的 get_stats 函式，每次被呼叫時都會即時（不是
// 讀快取）重新查詢資料庫，計算出以下欄位並以 JSON 回傳：
//   - total_friends      : LINE 好友總數 = line_accounts 資料表筆數
//                           （含尚未建檔病歷的純好友帳號）。
//   - total_patients     : 病患總數 = patients 資料表中
//                           medical_record_number 的筆數（獨特病歷號）。
//   - total_forms        : 表單/看診紀錄總數 = record 資料表筆數。
//   - patients_chatted   : 曾經用 LINE Bot 對話過的病患數
//                           = patients.has_chatted = 1 的筆數。
//   - bot_usage_rate     : LINE Bot 使用率(%) = patients_chatted /
//                           total_patients * 100，四捨五入到小數點1位；
//                           若 total_patients 為 0 則固定為 0.0（避免除以零）。
//   - return_visits      : 回診人數估計值 = max(0, total_forms - total_patients)，
//                           意義是「表單數超過病患數的部分」，大致代表同一位
//                           病患有多次看診紀錄（回診）。
//   - last_updated       : 'YYYY-MM-DD HH:MM:SS' 格式的時間字串。
//
// 【last_updated 的特殊快取語意，務必理解】
// 後端每次收到請求都會重新從資料庫算出上述數字，但接著會拿這次算出的結果，
// 跟 data/stats_cache.json 中存放的「上一次計算結果」逐項比較：
//   → 若數字完全沒有變化（代表期間系統資料沒有異動），last_updated 會沿用
//     快取檔案中舊的時間戳，不會變成現在時間；
//   → 若數字有任何變化，last_updated 會更新為「現在」，並把這次的新結果
//     整份寫回 data/stats_cache.json，成為下次比較的基準。
// 因此本檔案顯示在畫面上的「最後更新：xxx」，其語意是「這些統計數字最後一次
// 真正發生變化的時間點」，而不是「使用者本次查詢/整理頁面的當下時間」——
// 即使反覆重新整理頁面，只要資料庫內容沒變，這個時間戳就不會跟著跳動。
//
// 【本檔案的狀態管理】
// 全域變數 currentStatsData 是本模組唯一的「狀態」，用來快取「最近一次成功
// 從 /api/stats 取得的完整回應物件」，供 exportStatsCSV() 匯出 CSV 時直接
// 重複使用，避免每次下載都要多打一次 API；若使用者尚未載入過統計資料（頁面
// 剛開啟、還沒觸發過 loadStats，或先前呼叫失敗），currentStatsData 會維持
// 初始值 null，exportStatsCSV() 內部會偵測到並自動補打一次 API。
// ════════════════════════════════════════════════════════════════════════

// ──── 模組狀態 ────────────────────────────────────────────────────────────
// currentStatsData：快取「最近一次成功取得的 /api/stats 回應物件」。
// - 由 loadStats() 在成功取得資料後寫入。
// - 由 exportStatsCSV() 讀取，作為匯出 CSV 的資料來源；若為 null 則
//   exportStatsCSV() 會自行多打一次 API 補齊資料。
// - 初始值為 null，代表「尚未成功載入過統計資料」。
let currentStatsData = null;

// ──── loadStats：載入並渲染統計儀表板資料 ─────────────────────────────────
// 用途：向後端請求最新的系統統計數據，並將結果分別填入 stats.html 中對應的
//       統計卡片（.stat-value）與「最後更新時間」文字區塊。
// 觸發時機：本檔案本身沒有自動輪詢/定時刷新機制（沒有 setInterval 之類的
//       排程），必須由外部程式碼主動呼叫（例如：切換到「統計數據」分頁時、
//       或頁面初始化流程中呼叫一次 loadStats()）。也就是說，畫面上的數字
//       只會在「載入/切換到這個分頁的那一刻」被更新一次，不會自動即時刷新。
// 參數：無。
// 對外部的影響：
//   - 會清空並可能重新填入 #s-error 的錯誤訊息文字。
//   - 會更新 #s-friends（若存在）、#s-patients、#s-usage、#s-return（若存在）
//     這幾個統計卡片的數值文字，以及 #s-updated 的「最後更新：」文字。
//   - 會覆寫全域狀態 currentStatsData，供 exportStatsCSV() 後續使用。
async function loadStats() {
  // 每次重新載入前先清空舊的錯誤訊息，避免上一次失敗的錯誤文字殘留畫面上。
  document.getElementById('s-error').textContent = '';
  try {
    // 呼叫共用的 api() 輔助函式，對後端發出「GET /api/stats」請求。
    // 此 API 由 src/admin_server.py 的 get_stats 提供，套用 @login_required，
    // 回應為 JSON 物件，欄位詳見本檔案最上方的檔案總覽說明。
    const d = await api('GET', '/api/stats');

    // 後端若在處理過程中發生錯誤（例如資料庫查詢失敗），會回傳帶有 error
    // 欄位的 JSON；此時直接把錯誤訊息顯示在 #s-error，並提前結束函式，
    // 不繼續往下渲染統計卡片（避免用錯誤/不完整的資料覆蓋畫面）。
    if (d.error) { document.getElementById('s-error').textContent = d.error; return; }

    // 請求成功，將完整回應物件存入全域狀態，供 exportStatsCSV() 之後重複使用，
    // 不必為了下載 CSV 再多打一次相同的 API。
    currentStatsData = d;

    // 更新「LINE 好友總數」卡片（id="s-friends"）。
    // 注意：目前 stats.html 尚未實際放置 id="s-friends" 的 DOM 元素，因此
    // getElementById 會回傳 null；下面用 if (friendsEl) 做防呆檢查，若找
    // 不到對應元素就直接跳過，不會拋出例外，畫面上暫時不會顯示這個數字。
    // 對應後端欄位：total_friends（line_accounts 資料表筆數）。
    // 若欄位為 null/undefined（例如後端未回傳），以 ?? '—' 顯示預設佔位符號。
    const friendsEl = document.getElementById('s-friends');
    if (friendsEl) friendsEl.textContent = d.total_friends ?? '—';

    // 更新「病患總數」卡片（id="s-patients"，對應 stats.html 中實際存在的
    // .stat-card green 卡片）。
    // 對應後端欄位：total_patients（patients 資料表中 medical_record_number
    // 的筆數，即已建立病歷的獨特病患總數）。
    const patientsEl = document.getElementById('s-patients');
    if (patientsEl) patientsEl.textContent = d.total_patients ?? '—';

    // 更新「LINE Bot 使用率」卡片（id="s-usage"，對應 stats.html 中實際存在
    // 的 .stat-card orange 卡片）。
    // 對應後端欄位：bot_usage_rate（百分比數字，四捨五入到小數點1位）。
    // 前端在數字後方統一補上百分號「%」；若欄位缺失則顯示「—%」。
    const usageEl = document.getElementById('s-usage');
    if (usageEl) usageEl.textContent = (d.bot_usage_rate ?? '—') + '%';

    // 更新「回診人數」卡片（id="s-return"）。
    // 與 friendsEl 相同，目前 stats.html 尚未放置對應的 DOM 元素，因此這裡
    // 一樣用 if (returnEl) 防呆，找不到就跳過。
    // 對應後端欄位：return_visits（估計值 = max(0, total_forms - total_patients)，
    // 意義是表單數超過病患數的部分，代表可能的回診次數）。
    const returnEl = document.getElementById('s-return');
    if (returnEl) returnEl.textContent = d.return_visits ?? '—';

    // 更新「最後更新時間」文字區塊（id="s-updated"）。
    // 對應後端欄位：last_updated（'YYYY-MM-DD HH:MM:SS' 格式字串）。
    // 重要語意提醒：這個時間代表「統計數字最後一次真正發生變化的時間」，
    // 並非本次查詢/渲染畫面的當下時間（詳見檔案最上方的說明）；若後端未
    // 回傳此欄位（例如空字串/undefined），則清空此區塊不顯示任何文字。
    document.getElementById('s-updated').textContent =
      d.last_updated ? '最後更新：' + d.last_updated : '';
  } catch (err) {
    // 例外處理：涵蓋網路中斷、伺服器無回應、api() 內部拋出例外（例如非 2xx
    // 狀態碼）等情況。將完整錯誤物件輸出到 console 方便除錯，並在畫面上
    // 顯示統一的中文錯誤訊息，不會讓整個頁面崩潰或顯示原始技術性錯誤訊息。
    console.error(err);
    document.getElementById('s-error').textContent = '無法載入統計資料';
  }
}

// ──── exportStatsCSV：將統計數據匯出為 CSV 檔案並觸發瀏覽器下載 ───────────
// 用途：把目前的統計數據整理成一份人類可讀的 CSV 報表，讓醫護人員/管理者
//       可以下載存檔或用 Excel 等軟體開啟查看、留存紀錄。
// 觸發時機：由 stats.html 中「下載 CSV」按鈕的行內事件 onclick="exportStatsCSV()"
//       觸發，屬於使用者主動點擊才會執行的動作，不會自動執行。
// 參數：無。
// 對外部的影響：
//   - 可能會呼叫 GET /api/stats（僅當尚無快取資料時）並更新全域狀態
//     currentStatsData。
//   - 會操作 DOM：動態建立並立即移除一個隱藏的 <a> 下載連結元素，藉此觸發
//     瀏覽器原生的檔案下載行為（不經過任何後端「匯出」API，純粹是前端組
//     字串產生 Blob 檔案）。
//   - 若全域函式 showToast 存在（由本後台其他共用 JS 提供的提示訊息元件），
//     會呼叫它顯示「成功/失敗」的提示訊息；若不存在則退回使用瀏覽器原生
//     的 alert() 對話框。
async function exportStatsCSV() {
  // 若模組狀態 currentStatsData 尚未有資料（例如使用者尚未觸發過 loadStats，
  // 或先前的 loadStats 呼叫失敗未成功寫入），則在此處補打一次
  // 「GET /api/stats」以取得最新統計資料，確保匯出的內容盡量是最新的。
  // 這裡刻意不呼叫 loadStats()（不會去更新畫面上的統計卡片 DOM），只單純
  // 把回應寫入 currentStatsData 供下方組 CSV 使用，避免不必要的畫面重繪。
  if (!currentStatsData) {
    try {
      const d = await api('GET', '/api/stats');
      // 只有在回應不含 error 欄位時才視為成功並寫入快取，避免把錯誤物件
      // 誤當作正常的統計資料使用。
      if (d && !d.error) {
        currentStatsData = d;
      }
    } catch (err) {
      // 補打 API 失敗時僅記錄到 console，不中斷流程；下方仍會再檢查一次
      // currentStatsData 是否成功取得資料，並給出對應的使用者提示。
      console.error(err);
    }
  }

  // 若補打 API 後仍然沒有任何資料可用（例如 API 呼叫失敗、或後端持續回傳
  // 錯誤），則放棄匯出，並提示使用者「尚無統計數據可供下載」，函式提前結束。
  if (!currentStatsData) {
    if (typeof showToast === 'function') {
      showToast('❌ 尚無統計數據可供下載', 'fail');
    } else {
      alert('尚無統計數據可供下載');
    }
    return;
  }

  // d：目前用來組 CSV 的資料來源，即最近一次成功取得的 /api/stats 回應物件。
  const d = currentStatsData;
  // rows：CSV 的每一列資料，第一列為表頭（欄位名稱），之後每一列對應一項
  // 統計指標，欄位依序為：[統計項目名稱, 數值/比例, 中文說明文字]。
  // 這裡把 /api/stats 回應中的每個欄位都轉換成人類易讀的中文列，並在數值
  // 缺失時（?? 0 / || '—'）提供預設值，避免匯出的 CSV 出現 undefined/null。
  const rows = [
    ['統計項目', '數值 / 比例', '說明'],
    // 病患總數 ← total_patients（patients 資料表中 medical_record_number 筆數）
    ['病患總數', d.total_patients ?? 0, '系統中已建立就診紀錄的獨特病患總數'],
    // LINE Bot 使用率 ← bot_usage_rate（patients_chatted / total_patients * 100）
    ['LINE Bot 使用率', (d.bot_usage_rate ?? 0) + '%', '已開始聊天對話的病患比例'],
    // LINE 好友總數 ← total_friends（line_accounts 資料表筆數）
    ['LINE 好友總數', d.total_friends ?? 0, '已綁定 LINE 帳號之好友總數'],
    // 已對話病患數 ← patients_chatted（patients.has_chatted = 1 的筆數）
    ['已對話病患數', d.patients_chatted ?? 0, '已有 LINE Bot 對話紀錄之病患人數'],
    // 病歷表單總數 ← total_forms（record 資料表筆數）
    ['病歷表單總數', d.total_forms ?? 0, '系統中建立的出院衛教表單總筆數'],
    // 複診總次數 ← return_visits（max(0, total_forms - total_patients) 的估計值）
    ['複診總次數', d.return_visits ?? 0, '扣除首就診後的複診紀錄次數'],
    // 最後更新時間 ← last_updated（統計數字最後一次真正變化的時間，非本次查詢時間）
    ['最後更新時間', d.last_updated || '—', '統計數據最後更新時間']
  ];

  // 將 rows 二維陣列轉換為標準 CSV 文字內容：
  // - 開頭加上 UTF-8 BOM（透過 '﻿' 這個特殊字元），確保 Excel 等軟體
  //   開啟時能正確識別編碼，不會把中文字顯示成亂碼。
  // - 每個欄位值先轉成字串，若內含逗號、雙引號或換行符，則依 CSV 規範用
  //   雙引號包起來，並將內部原有的雙引號轉義為兩個連續雙引號（""）。
  // - 每一列欄位用逗號 ',' 串接，列與列之間用 '\r\n'（CRLF）換行，符合
  //   CSV 檔案的通用換行慣例。

  const csvContent = '\uFEFF' + rows.map(row =>
    row.map(val => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\r\n');

  // 將組好的 CSV 文字內容包裝成 Blob 物件（MIME type 為 text/csv），並透過
  // URL.createObjectURL() 產生一個暫時性的可下載網址（blob: 開頭）。
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  // 動態建立一個隱藏的 <a> 連結元素，設定其 href 指向上面產生的 blob 網址，
  // download 屬性則指定下載後的檔名，格式為「EDDI_統計數據報表_YYYY-MM-DD.csv」
  // （日期取自使用者本機當下時間，使用 ISO 字串前 10 字元 'YYYY-MM-DD'）。
  const link = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  link.setAttribute('href', url);
  link.setAttribute('download', `EDDI_統計數據報表_${dateStr}.csv`);
  // 將連結元素暫時插入畫面（document.body），程式化觸發一次點擊事件以
  // 啟動瀏覽器的檔案下載行為，隨即立刻將元素從 DOM 中移除，避免殘留無用
  // 的隱藏元素；最後釋放 Blob 物件的暫時網址（URL.revokeObjectURL），釋放
  // 瀏覽器為此配置的記憶體資源。
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  // 下載動作觸發完成後，若共用的 showToast() 提示元件存在，顯示成功訊息
  // 告知使用者 CSV 報表已成功下載；若不存在則不特別提示（下載本身瀏覽器
  // 通常會有自己的下載提示 UI）。
  if (typeof showToast === 'function') {
    showToast('✅ 統計數據 CSV 報表已成功下載', 'ok');
  }
}
