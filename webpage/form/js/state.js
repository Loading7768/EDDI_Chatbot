// ============================================================================
// state.js — 病患衛教表單（webpage/form）的 Alpine.js 狀態工廠
// ============================================================================
// 本檔案定義了整份表單所需的「初始狀態」與共用常數，供 app.js 的
// Alpine.data('formApp', ...) 元件在初始化與登出重置時呼叫。
//
// 表單本身是一個「4 步驟精靈（wizard）」，每個步驟對應一張卡片：
//   0. auth     — 醫師登入 / 登出確認
//   1. pair     — 輸入 LINE 配對碼、選擇本次要填寫的病患（本人或家屬關係）
//   2. symptoms — 用人體部位圖挑選本次要提供的衛教主題（症狀）
//   3. review   — 最終確認並送出
//
// 每個步驟物件都共用一組「進度控制欄位」：
//   - key:           步驟識別字串，對應 webpage/form/parts/<key>.html 樣板
//   - completed:      這個步驟是否已完成（完成後畫面會收合成一行摘要，
//                      並可透過旁邊的「編輯」按鈕跳回去修改）
//   - error:          目前顯示給使用者的錯誤訊息（null 表示沒有錯誤）
//   - currentStatus:  對應 STATUS 列舉，用來控制按鈕上的 loading / 打勾動畫
// 其餘欄位則是各步驟專屬的資料（例如 draft 草稿輸入、選中的病患等）。
// ============================================================================

// initSteps()：產生一份「全新」的 4 步驟狀態陣列。
// 每次呼叫都會回傳全新的物件（而非共用參照），因此無論是表單第一次載入，
// 還是醫師登出後要重置整個流程，都可以直接呼叫 initSteps() 取得乾淨的初始狀態，
// 不會殘留前一位醫師或病患的資料。
const initSteps = () => ([
    // completed: tracks progress
    // mode:      control current state of the card
    // value:     holds input data

    // ---- Step 0: auth（醫師登入 / 登出）----
    {
        key: 'auth',
        completed: false,
        error: null,
        currentStatus: 'idle',

        authed: false,       // true 表示醫師目前已登入；用來切換「登入表單」與「登出確認」兩種畫面
        draft: {              // 登入表單的暫存輸入值（帳號 / 密碼），提交成功後會被清空
            account:'',
            password: '',
        },
        doctorName: '',       // 登入成功後由後端回傳的醫師姓名，顯示在完成摘要與畫面問候語
        doctorDept: '',       // 登入成功後由後端回傳的醫師科別
    },

    // ---- Step 1: pair（LINE 配對碼 + 選擇本次病患）----
    {
        key: 'pair',
        completed: false,
        error: null,
        currentStatus: 'idle',

        paired: false,        // true 表示配對碼已驗證成功，畫面由「輸入配對碼」切換為「選擇病患」
        paringCode: '',       // 使用者目前輸入中的 6 位數配對碼字串
        lineUuid: '',         // 配對成功後取得的 LINE 使用者唯一識別碼（line_uuid）
        lineUname: '',        // 配對成功後取得的 LINE 顯示名稱，用於畫面上顯示「您正在為 OOO 填寫」
        relations: [],        // 這個 LINE 帳號底下已存在的關係人清單（本人 + 各種親屬關係），
                               // 每個元素含 relation（關係稱呼）、medical_record_num（病歷號）、
                               // 以及可能的 prefilled_symptoms（上次同科別回診紀錄的症狀，用於預填）
        selectedRelation: null, // 目前使用者選定要填寫的對象；
                                 // 結構為 { type, relation, mrc }，
                                 // type 可能是 'existing_<idx>'（對應 relations 陣列中的既有關係人）
                                 // 或 'new'（新增一個從未出現過的關係人）
        draft: {               // 「新增病患」與「本人補填病歷號」兩個輸入表單的暫存草稿
            self: { type: 'self', relation: '帳號本人', mrc: '' },
            new: { type: 'new', relation: '', mrc: '' }
        },

        pairSelectError: '',   // 選擇病患階段的驗證錯誤訊息（例如稱呼或病歷號重複）
        existingScrolled: false, // 既有關係人清單是否已被滾動（目前僅供樣板判斷陰影等視覺效果使用）
    },

    // ---- Step 2: symptoms（人體部位圖選擇衛教主題）----
    {
        key: 'symptoms',
        completed: false,
        error: null,
        currentStatus: 'idle',

        selectedSymptoms: [],   // 目前已勾選的衛教主題（症狀）清單
        sessionLoaded: false,   // true 表示這次的 selectedSymptoms 是從「上次填寫但尚未確認病患」
                                 // 的 session 還原而來（見 app.js 的 init()），
                                 // 用於避免 confirmPatient() 再次覆寫掉這份已還原的資料
        showPrefillMsg: false,  // true 時在畫面顯示「已根據上次紀錄自動選擇」提示文字
        // topicMapping：人體部位（hotspot 區域名稱）→ 該部位可選症狀清單 的對照表。
        // parts/symptoms.html 中每個熱點（hotspot）的 disabled/pulse-glow 樣式、
        // 以及點擊後彈出的 popover 選單內容，都是直接查詢這份字典而來。
        // 這份清單目前是前端硬編碼的靜態資料，概念上類似 RAG 使用的 category.json
        // 分類架構，但兩者是獨立維護、互不相通的兩份資料。
        topicMapping: {
            '頭': ['頭暈', '流鼻血', '發燒', '頭痛', '偏頭痛', '噁心嘔吐', '眩暈'],
            '脖子': ['咳嗽', '咳血', '打嗝'],
            '手': [],
            '軀幹上半部': ['胸痛', '心悸', '呼吸急促/呼吸困難', '上背痛'],
            '軀幹下半部': ['腹痛', '腸胃炎/病毒性腸胃炎', '便秘', '腹瀉', '腰痛', '吐血、解黑便、解血便、胃腸道出血', '血尿', '下背痛', '尿滯留', '懷孕早期陰道出血', '懷孕後期陰道出血', '月經週期間陰道出血'],
            '腳': [],
            '皮膚': ['燒燙傷', '水腫', '皮膚疹子(皮疹)'],
            '精神': ['譫妄、意識混亂', '虛弱', '暈厥、暈倒'],
            '其他': ['高血壓', '肌肉、關節和骨骼疼痛', '癲癇', '休克', '一般外傷、鈍挫傷、扭傷、拉傷', '傷口處置原則']
        },
        activeRegion: null,      // 目前被點擊、彈出 popover 選單的部位名稱；null 表示沒有 popover 開啟
        popoverTop: 0,            // popover 選單相對於 image-wrapper 容器的絕對定位 top（px），
                                   // 由 app.js 的 showPopover() 依熱點位置動態計算
        popoverLeft: 0,            // popover 選單的絕對定位 left（px），同樣由 showPopover() 計算
        arrowTop: '18px',          // popover 左/右側小箭頭（::before 偽元素）相對於 popover 頂端的偏移量
        popoverArrowClass: 'arrow-left', // 目前應套用的箭頭方向樣式類別（'arrow-left' 或 'arrow-right'），
                                          // 依熱點在畫面左側或右側決定 popover 要往哪個方向長出箭頭
    },

    // ---- Step 3: review（最終確認送出）----
    {
        key: 'review',
        completed: false,
        error: null,
        currentStatus: 'idle',
        // review 步驟本身不需要額外資料欄位：送出時直接讀取 pair 步驟（steps[1]）
        // 的 selectedRelation 作為要寫入資料庫的病歷號與關係，詳見 app.js 的 submitForm()。
    },
]);

// STATUS：三態狀態列舉，凍結（Object.freeze）避免被意外修改。
// 各步驟的 currentStatus 欄位與 footer 按鈕（parts/macros.html 的 footer_button 巨集）
// 都是根據這三個值切換「一般文字」→「轉圈圈 loading 圖示」→「打勾 success 圖示」的按鈕內容。
const STATUS = Object.freeze ({
    IDLE: 'idle',
    LOADING: 'loading',
    SUCCESS: 'success',
});

console.log('steps.js loaded.');
