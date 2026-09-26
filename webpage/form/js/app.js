// ============================================================================
// app.js — 病患衛教表單（webpage/form）的 Alpine.js 主元件邏輯
// ============================================================================
// 本檔案定義了 Alpine.data('formApp', ...) 元件，也就是 form.html 中
// <div x-data="formApp()"> 所綁定的整份表單行為邏輯。
//
// 整體架構：
//   - state.js  提供 initSteps()（4 步驟初始狀態工廠）與 STATUS 列舉
//   - flip.js   提供 window.flipAnimate()（步驟切換時的位移/縮放動畫）
//   - app.js（本檔案）串接上述兩者，實作：
//       1. 步驟切換（nextStep / jumpTo）與對應的 FLIP 動畫觸發
//       2. 四個步驟各自的「確認」動作，皆會呼叫 form_handler.py 提供的
//          對應 REST API（/api/form_login、/api/form_pair、
//          /api/form_discharge、/api/form_submit 等）
//       3. init()：頁面（重新）載入時，從 Flask 於 form.html 注入的
//          window.doctorInfo / window.pairingInfo 還原已登入的醫師、
//          已配對的 LINE 帳號、甚至上次填到一半但尚未送出的表單進度，
//          讓使用者重新整理頁面或跳轉後不會遺失已完成的步驟。
//
// 這份檔案沒有自己維護資料庫或 session 狀態——所有「持久化」的狀態
// （醫師是否登入、LINE 是否已配對、已選擇哪位病患、已勾選哪些症狀）
// 都是由後端 form_handler.py 透過 Flask session 保存，本檔案只是把
// 每次 API 呼叫回傳的資料同步寫入 Alpine 的 steps 陣列，用於畫面渲染。
// ============================================================================

document.addEventListener('alpine:init', () => {
    Alpine.data('formApp', () => ({
        currentStep: 0,   // 目前展開（放大）顯示的步驟索引（0~3）
        prevStep: 0,      // 進入登出確認畫面前所在的步驟索引，供「取消登出」時跳回原位

        // state.js
        steps: initSteps(), // 4 個步驟的完整狀態陣列，詳見 state.js 的 initSteps()
        STATUS,              // 從 state.js 帶入的三態列舉，供樣板（parts/macros.html）直接比較使用

        // runWithNodeFlip(mutateFn)：
        // 包裝一次「會改變畫面排版」的狀態變更（例如切換 currentStep），
        // 在變更前後分別用 flip.js 的 flipAnimate() 量測所有 data-flip 節點的
        // 位置與大小，讓 Alpine 重新渲染造成的版面跳動變成平滑動畫。
        runWithNodeFlip(mutateFn) {
            const elements = [...document.querySelectorAll('[data-flip]')];
            window.flipAnimate(elements, mutateFn);
        },

        // nextStep()：前進到下一個步驟（currentStep + 1），並套用 FLIP 動畫。
        // 下方註解掉的程式碼是動畫的另一種實作方式（先把 currentStep 設為 -2
        // 讓所有步驟卡片瞬間收合、停頓 200ms、再切到新的步驟），保留在此作為
        // 開發過程中嘗試過的替代方案記錄，目前實際採用的是 runWithNodeFlip()
        // 這個 FLIP 版本。
        async nextStep() {
            if (this.currentStep < this.steps.length) {
                // next = this.currentStep + 1;
                // this.currentStep = -2;
                // await this.delay(200);
                // this.currentStep = next;
                this.runWithNodeFlip(() => {
                    this.currentStep++;
                });
            }
        },

        // jumpTo(i)：直接跳到指定步驟 i（用於點擊已完成步驟旁的「編輯」按鈕）。
        // 會先記錄目前位置到 prevStep，讓使用者若在登出確認畫面按下取消，
        // 可以用 cancelLogout() 跳回原本所在的步驟。
        async jumpTo(i) {
            // this.prevStep = this.currentStep;
            // this.currentStep = -2;
            // await this.delay(200);
            // this.currentStep = i;
            // this.edit = false;
            this.runWithNodeFlip(() => {
                this.prevStep = this.currentStep;
                this.currentStep = i;
                this.edit = false;
            });
        },

        // nodeClasses(i)：依步驟 i 目前的狀態，回傳該步驟卡片外框應套用的 Tailwind class。
        // 三種外觀狀態：
        //   1. 目前展開中的步驟（i === currentStep）→ 大卡片樣式
        //   2. 已完成但目前收合的步驟（step.completed）→ 一行式摘要樣式
        //   3. 尚未到達、還未完成的步驟 → 小圓點佔位樣式
        nodeClasses(i) {
            const step = this.steps[i];

            if (i === this.currentStep) {
                return 'w-full max-h-[72vh] p-4 rounded-[2rem] bg-slate-800';
            }

            if (step.completed) {
                return 'flex justify-center px-6 py-4 rounded-lg bg-blue-950';
            }

            // incomplet
            return 'w-10 h-10 p-4 ml-5 rounded-[2rem] bg-slate-900';
        },

        // delay(ms)：簡單的 Promise 包裝的 setTimeout，用於在各步驟送出成功後
        // 讓「打勾」成功動畫多停留一下，再切換到下一步驟，避免畫面切換過快、
        // 使用者看不到成功回饋。
        async delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },


        // ========== Auth Step ==========
        // confirmLogin()：處理步驟 0（auth）的登入表單送出。
        // 呼叫 POST /api/form_login（見 form_handler.py 的 form_login()），
        // 該端點會核對帳號密碼、並將登入資訊寫入 Flask session。
        // 成功後：清空 draft 輸入、記錄醫師姓名/科別、標記本步驟完成並自動前進到下一步。
        // 失敗（帳密錯誤等）：把後端回傳的錯誤訊息顯示在 step.error。
        async confirmLogin() {
            const authStep = this.steps[0];
            authStep.error = null;
            authStep.currentStatus = STATUS.LOADING;

            try {
                const resp = await fetch('/api/form_login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        account: authStep.draft.account,
                        password: authStep.draft.password,
                    }),
                });
                const data = await resp.json();

                await this.delay(1000); // 讓 loading 動畫至少顯示 1 秒，避免因網路太快而一閃即過
                if (!data.success) {
                    throw new Error(data.message);
                }
                authStep.currentStatus = STATUS.SUCCESS;

                await this.delay(300); // 打勾動畫短暫停留後才切換畫面
                authStep.draft = { account: '', password: '' }; // 清空密碼等敏感輸入，不留在畫面上
                authStep.doctorName = data.doctor_name;
                authStep.doctorDept = data.doctor_department;
                authStep.completed = true;
                this.nextStep();
                authStep.authed = true; // 切換到「已登入」畫面狀態（若之後又跳回這一步，會顯示登出確認畫面而非登入表單）
            } catch (err) {
                authStep.error = err.message;
            }
            authStep.currentStatus = STATUS.IDLE;
        },

        // confirmLogout()：處理登出確認畫面中按下「登出」按鈕。
        // 呼叫 POST /api/form_logout 清除後端 session（見 form_handler.py 的 form_logout()），
        // 前端則直接把整份 steps 重新用 initSteps() 產生一份全新狀態，
        // 等同於把整個表單（登入、配對、症狀、確認）全部重置回最初狀態。
        // 這裡刻意用 try/catch 吞掉呼叫失敗的例外——即使後端登出 API 意外失敗，
        // 前端仍然會照常清空畫面狀態，讓使用者的登出動作在視覺上永遠成功。
        async confirmLogout() {
            const authStep = this.steps[0];
            authStep.currentStatus = STATUS.LOADING;

            try {
                await fetch('api/form_logout', { method: 'POST' });
            } catch (e) { }

            await this.delay(1000);
            authStep.currentStatus = STATUS.SUCCESS;
            await this.delay(300);
            this.steps = initSteps();
        },

        // cancelLogout()：登出確認畫面中按下右上角的取消（X）按鈕，
        // 不呼叫任何 API，單純把畫面跳回按下登出前所在的步驟（prevStep）。
        async cancelLogout() {
            this.runWithNodeFlip(() => {
                this.currentStep = this.prevStep;
            });
            // this.currentStep = -2;
            // await this.delay(200);
            // this.currentStep = this.prevStep;
        },


        // ========== Pair Step ==========
        // confirmPair()：處理步驟 1（pair）中輸入 6 位數配對碼後按下「配對」。
        // 呼叫 POST /api/form_pair（見 form_handler.py 的 form_pair()），
        // 該端點會核對配對碼是否存在且未過期，成功則回傳這個 LINE 帳號的
        // 顯示名稱、UUID，以及底下已存在的所有關係人清單（relations）。
        async confirmPair() {
            const step = this.steps[1];
            if (step.paringCode.length < 6) return;

            step.currentStatus = STATUS.LOADING;
            step.error = '';

            try {
                const res = await fetch('/api/form_pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: step.paringCode })
                });
                const data = await res.json();

                await this.delay(1000);
                if (!data.success) {
                    throw new Error(data.message);
                }

                step.currentStatus = STATUS.SUCCESS;
                await this.delay(300);
                step.lineUname = data.line_uname;
                step.lineUuid = data.line_uuid;
                step.relations = data.relations || [];
                step.paired = true; // 切換畫面：由「輸入配對碼」變成「選擇本次病患」

                // 若後端回傳的關係人清單中沒有「帳號本人」這個選項（例如全新的 LINE 帳號、
                // 尚未建立任何配對紀錄），前端主動在清單最前面補一個空病歷號的佔位項目，
                // 讓使用者一定看得到「帳號本人」可選，稍後在 confirmPatient() 補填病歷號即可。
                const hasSelf = step.relations.some(r => r.relation === '帳號本人');
                if (!hasSelf) {
                    step.relations.unshift({ relation: '帳號本人', medical_record_num: '' });
                }
                // 確保「帳號本人」永遠排在清單最前面，其餘關係人維持原本順序（穩定排序）
                step.relations.sort((a, b) => (a.relation === '帳號本人') ? -1 : (b.relation === '帳號本人') ? 1 : 0);
                // 預設先選中清單第一項（通常就是「帳號本人」）
                step.selectedRelation = { type: 'existing_0', relation: step.relations[0].relation, mrc: step.relations[0].medical_record_num };

            } catch (err) {
                step.error = err.message;
                step.paringCode = ''; // 配對失敗時清空輸入框，讓使用者重新輸入
            }
            step.currentStatus = STATUS.IDLE;
        },

        // confirmPatient()：處理「選擇本次病患」畫面按下「選擇病患」按鈕。
        // 這一步不會呼叫後端 API——僅在前端完成驗證與資料整理，實際的病患資訊
        // 會等到下一步（symptoms 完成後）或最終送出時才寫回後端。
        //
        // 需要處理三種選擇情境：
        //   1. 選中既有關係人，且是「帳號本人」但病歷號尚未填寫過（isSelfInput）
        //      → 必須從 draft.self.mrc 補上使用者剛輸入的病歷號
        //   2. 選中既有關係人，且病歷號已存在 → 直接使用該病歷號，不需額外驗證
        //   3. 選擇「新增」一位全新的關係人 → 需驗證稱呼與病歷號皆已填寫，
        //      且不可與「新增」「帳號本人」字面重複，也不可與既有關係人重複
        async confirmPatient() {
            const step = this.steps[1];
            if (!step.selectedRelation) return;
            step.pairSelectError = '';

            // Resolve effective mrc: for 帳號本人 with blank mrc, use draft input
            let effectiveMrc = step.selectedRelation.mrc;
            const isSelfInput = step.selectedRelation.type.startsWith('existing')
                && step.selectedRelation.relation === '帳號本人'
                && !step.selectedRelation.mrc;
            if (isSelfInput) {
                effectiveMrc = step.draft.self.mrc.trim();
            }

            // Validate
            if (isSelfInput && !effectiveMrc) return;
            if (step.selectedRelation.type === 'new' && (!step.selectedRelation.mrc || !step.selectedRelation.relation)) return;

            if (isSelfInput || step.selectedRelation.type === 'new') {
                const rel = isSelfInput ? '帳號本人' : step.selectedRelation.relation.trim();
                const mrc = isSelfInput ? effectiveMrc : step.selectedRelation.mrc.trim();

                // 「新增」關係人時，稱呼不可與系統保留字（'新增' 按鈕本身文字、'帳號本人'）重複
                if (step.selectedRelation.type === 'new' && (rel === '新增' || rel === '帳號本人')) {
                    step.pairSelectError = '稱呼和病歷號不可重複';
                    return;
                }

                // 稱呼或病歷號皆不可與既有關係人（排除本人）重複，避免建立出重複的關係人紀錄
                const isDup = step.relations.some(r => r.relation !== '帳號本人' && (r.relation === rel || r.medical_record_num === mrc));
                if (isDup) {
                    step.pairSelectError = '稱呼和病歷號不可重複';
                    return;
                }
            }

            let text = '';
            let matchedRelationObj = null;
            if (step.selectedRelation.type.startsWith('existing')) {
                // 選中的是既有關係人：從 relations 陣列中取回完整物件（包含可能的 prefilled_symptoms）
                const idx = parseInt(step.selectedRelation.type.split('_')[1]);
                matchedRelationObj = step.relations[idx];
                text = step.selectedRelation.relation;
            } else {
                text = step.selectedRelation.relation || '？？？';
            }

            const finalMrc = effectiveMrc || step.selectedRelation.mrc;

            // Prefill selection based on patient
            // 依選中的病患，決定症狀步驟是否要預先勾選「上次同科別回診」時填過的症狀。
            const symptomStep = this.steps[2];
            if (symptomStep.sessionLoaded) {
                // sessionLoaded 為 true 表示 init() 已經從 Flask session 還原過
                // 「填寫到一半但尚未確認病患」的症狀選擇，這裡不應該再被
                // matchedRelationObj 的歷史紀錄覆蓋掉，因此只消耗掉這個旗標、
                // 不做任何症狀重設。
                symptomStep.sessionLoaded = false;
            } else {
                if (matchedRelationObj && matchedRelationObj.prefilled_symptoms && matchedRelationObj.prefilled_symptoms.length > 0) {
                    symptomStep.selectedSymptoms = [...matchedRelationObj.prefilled_symptoms];
                    symptomStep.showPrefillMsg = true;
                } else {
                    symptomStep.selectedSymptoms = [];
                    symptomStep.showPrefillMsg = false;
                }
            }

            step.currentStatus = STATUS.SUCCESS;
            await this.delay(300);
            step.selectedRelation.mrc = finalMrc; // 把補填後的病歷號寫回 selectedRelation，供 review/submit 步驟讀取
            step.value = `${text} (${finalMrc})`; // 供步驟收合摘要顯示用的文字（目前樣板未直接使用此欄位，但保留供未來擴充）
            step.completed = true;
            this.nextStep();
            step.currentStatus = STATUS.IDLE;
        },


        // ========== Symptom Step ==========
        // toggleSymptom(topic)：勾選/取消勾選一個症狀主題（供 popover 選單與底部已選 chip 列表共用）。
        // 只要使用者手動調整過症狀清單，就關閉「已根據上次紀錄自動選擇」的提示訊息。
        toggleSymptom(topic) {
            const step = this.steps[2];
            const idx = step.selectedSymptoms.indexOf(topic);
            if (idx > -1) {
                step.selectedSymptoms.splice(idx, 1);
            } else {
                step.selectedSymptoms.push(topic);
            }
            step.showPrefillMsg = false;
        },

        // showPopover(region, event, posType)：點擊人體部位圖上的某個熱點（hotspot）時，
        // 開啟（或關閉，若點擊的是目前已開啟中的同一區域）該部位對應的症狀選單 popover，
        // 並計算 popover 應該顯示在畫面上的絕對座標。
        //
        // 參數：
        //   region  — 被點擊的部位名稱（對應 state.js 的 topicMapping 鍵值）
        //   event   — 點擊事件物件，用來取得被點擊熱點元素本身的位置
        //   posType — 'body'（人體圖左欄的圓形熱點）或 'bottom'（右欄的皮膚/精神/其他按鈕），
        //             決定 popover 要往熱點的右側還是左側展開
        showPopover(region, event, posType) {
            const step = this.steps[2];
            if (step.activeRegion === region) {
                // 再次點擊同一個已展開的區域 → 視為關閉 popover
                step.activeRegion = null;
                return;
            }
            step.activeRegion = region;

            const hotspotEl = event.currentTarget;
            const layoutEl = document.getElementById('image-wrapper');
            if (!hotspotEl || !layoutEl) return;

            // 必須等 Alpine 依 activeRegion 的新值把 popover 的 DOM 渲染出來後，
            // 才能量測 popoverEl 的實際高度來計算定位，因此包在 $nextTick 內；
            // 額外加上一個 50ms 的 setTimeout 是為了讓 x-transition 的進場動畫
            // 開始執行後、popover 尺寸更穩定時才量測（避免動畫初始的 scale-95 造成誤差）。
            this.$nextTick(() => {
                setTimeout(() => {
                    const popoverEl = document.getElementById('popover');
                    if (!popoverEl) return;

                    const layoutRect = layoutEl.getBoundingClientRect();
                    const spotRect = hotspotEl.getBoundingClientRect();
                    const popoverRect = popoverEl.getBoundingClientRect();

                    // 以熱點的垂直中心點為基準，讓 popover 盡量與熱點對齊置中
                    const spotCenterY = (spotRect.top + spotRect.bottom) / 2 - layoutRect.top;

                    let top = spotCenterY - popoverRect.height / 2;
                    // 限制 top 不超出 image-wrapper 容器範圍（上緣不小於 0，下緣預留 15px 邊界）
                    const maxTop = layoutRect.height - popoverRect.height - 15;
                    top = Math.max(0, Math.min(top, maxTop));
                    step.popoverTop = top;

                    // 箭頭（::before 偽元素）的垂直位置：熱點中心相對於 popover 頂端的距離，
                    // 並限制在 popover 高度的合理範圍內（避免箭頭跑出 popover 邊界）
                    let arrow = spotCenterY - top;
                    arrow = Math.max(20, Math.min(arrow, popoverRect.height - 20));
                    step.arrowTop = arrow + 'px';

                    let spotLeft = spotRect.left - layoutRect.left;
                    let spotRight = spotRect.right - layoutRect.left;

                    if (posType === 'body') {
                        // 人體圖左欄的熱點：popover 往右側展開，箭頭朝左指向熱點
                        step.popoverLeft = spotRight + 6;
                        step.popoverArrowClass = 'arrow-left';
                    } else {
                        // 右欄的皮膚/精神/其他按鈕：popover 往左側展開（避免超出畫面右邊界），箭頭朝右
                        step.popoverLeft = spotLeft - 226;
                        step.popoverArrowClass = 'arrow-right';
                    }
                }, 50);
            });
        },

        // confirmSymptoms()：處理症狀步驟按下「選擇」按鈕。
        // 呼叫 POST /api/form_discharge（見 form_handler.py 的 form_discharge()），
        // 將目前選中的病患（medical_record_num、relation）與已勾選症狀清單一併存入
        // 後端 session（尚未寫入資料庫，真正落庫是在最後一步 submitForm()）。
        //
        // 這裡讀取的是 pair 步驟（steps[1]）的 selectedRelation，而非本步驟自己的欄位，
        // 因為病患身分資訊是在上一步驟決定的。
        // 注意：relation 的判斷條件 `selectedRelation?.type === 'self'` 在目前程式碼中
        // 實際上不會成立（confirmPair/confirmPatient 產生的 type 值只會是
        // 'existing_<idx>' 或 'new'，從未賦值為字面 'self'），因此這裡永遠會走
        // else 分支、直接使用 selectedRelation.relation 的值；這是既有程式碼的行為，
        // 本次僅新增註解說明現況，不修改邏輯。
        async confirmSymptoms() {
            const step = this.steps[2];
            const pairStep = this.steps[1];
            if (step.selectedSymptoms.length < 1) return;

            const selectedRelation = pairStep.selectedRelation;
            const mrc = selectedRelation?.mrc?.trim() || '';
            const relation = selectedRelation?.type === 'self' ? '帳號本人' : (selectedRelation?.relation?.trim() || '');

            try {
                const res = await fetch('/api/form_discharge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symptoms: step.selectedSymptoms,
                        medical_record_num: mrc,
                        relation: relation,
                    })
                });
                const data = await res.json();
                if (data.success) {
                    step.currentStatus = STATUS.SUCCESS
                    await this.delay(300);
                    step.value = step.selectedSymptoms.join(', ');
                    step.completed = true;
                    this.nextStep();
                    step.currentStatus = STATUS.IDLE;
                }
                // 注意：此處若 data.success 為 false（後端驗證失敗），並未設定
                // step.error 或還原 currentStatus 狀態，按鈕會停留在原本狀態，
                // 使用者僅能透過再次點擊重試；這是既有程式碼的行為，本次不予修改。
            } catch (e) {
                console.error('Error saving symptoms:', e);
            }
        },



        // ========== Review Step ==========
        // submitForm()：處理最終確認畫面按下「確認送出」按鈕。
        // 呼叫 POST /api/form_submit（見 form_handler.py 的 form_submit()），
        // 該端點會在同一個資料庫交易中完成：確保病患存在（patients 表）、
        // 確保配對關係存在（line_patient_pairs 表）、寫入一筆新的問診紀錄
        // （record 表，內含症狀），並清除本次表單相關的 session 狀態。
        //
        // 成功後，後端會回傳 redirect 網址（通常導向 complete.html 完成頁），
        // 前端導頁的同時順手把整個 steps 重置回初始狀態，避免使用者按「上一頁」
        // 瀏覽器返回鍵時看到已送出的舊資料。
        async submitForm() {
            const step = this.steps[3];
            const pairStep = this.steps[1];

            step.currentStatus = STATUS.LOADING;
            step.error = '';

            const selectedRelation = pairStep.selectedRelation;
            const mrc = selectedRelation?.mrc?.trim();
            // 同 confirmSymptoms() 中的說明：type === 'self' 這個分支在目前流程中
            // 實際上不會被觸發，selectedRelation.relation 才是真正被使用的值。
            const relation = selectedRelation?.type === 'self' ? '帳號本人' : selectedRelation?.relation?.trim();

            try {
                const res = await fetch('/api/form_submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        medical_record_num: mrc,
                        relation: relation,
                    })
                });
                const data = await res.json();

                await this.delay(1000);
                if (!data.success) {
                    throw new Error(data.message);
                }
                if (data.redirect) {
                    window.location.href = data.redirect;
                    this.steps = initSteps();
                    this.currentStep = 0;
                }
            } catch (err) {
                step.error = err.message;
            }

            step.currentStatus = STATUS.IDLE;
        },

        // init()：Alpine 元件初始化時自動呼叫的生命週期方法。
        // 每次載入 /form 頁面（包含使用者重新整理瀏覽器）都會執行一次，負責把
        // Flask 端透過 session 記住的既有進度（見 form_handler.py 的 form_page()）
        // 還原成前端畫面狀態，讓流程可以「從中斷的地方繼續」而不必重新輸入。
        init() {
            // Retrieve doctor and pairing info from window variables (injected by Flask)
            // window.doctorInfo：若醫師目前仍處於已登入的 session 中，
            // form_page() 會把醫師資訊透過 form.html 的 <script> 區塊注入到這裡。
            const doctor = window.doctorInfo;
            if (doctor) {
                const authStep = this.steps[0];
                authStep.doctorName = doctor.doctor_name;
                authStep.doctorDept = doctor.department;
                authStep.completed = true;
                authStep.authed = true;
                // 若目前還停在第 0 步（預設值），直接前進到第 1 步（配對），
                // 讓已登入的醫師不需要再看到登入表單。
                if (this.currentStep === 0) this.currentStep = 1;
            }

            // window.pairingInfo：若 session 中還記得已配對成功的 LINE 帳號
            // （不論是否已經選定病患、填過症狀），會在這裡一次性還原。
            const pairing = window.pairingInfo;
            if (pairing) {
                const pairStep = this.steps[1];
                pairStep.lineUname = pairing.line_uname;
                pairStep.lineUuid = pairing.line_uuid;
                pairStep.relations = pairing.relations || [];
                pairStep.paired = true;

                // Default selection (same logic as post-pair)
                // 與 confirmPair() 完全相同的「補上帳號本人選項、排到最前面」邏輯，
                // 確保無論是即時配對還是從 session 還原，關係人清單的呈現規則一致。
                const hasSelf = pairStep.relations.some(r => r.relation === '帳號本人');
                if (!hasSelf) {
                    pairStep.relations.unshift({ relation: '帳號本人', medical_record_num: '' });
                }
                pairStep.relations.sort((a, b) => (a.relation === '帳號本人') ? -1 : (b.relation === '帳號本人') ? 1 : 0);
                pairStep.selectedRelation = { type: 'existing_0', relation: pairStep.relations[0].relation, mrc: pairStep.relations[0].medical_record_num };

                // If patient was previously confirmed, restore full progress
                // pairing.selected_mrc / selected_relation 由後端 session 記錄，
                // 表示「病患選擇」這一步先前已經確認過（confirmPatient() 曾成功執行）。
                if (pairing.selected_mrc && pairing.selected_relation) {
                    // 在還原的 relations 清單中找出對應的關係人索引，重建與
                    // confirmPair()/confirmPatient() 產生的格式一致的 selectedRelation
                    const restoredIdx = pairStep.relations.findIndex(r => r.relation === pairing.selected_relation);
                    pairStep.selectedRelation = {
                        type: 'existing_' + (restoredIdx >= 0 ? restoredIdx : 0),
                        relation: pairing.selected_relation,
                        mrc: pairing.selected_mrc,
                    };
                    pairStep.completed = true;
                    if (this.currentStep <= 1) this.currentStep = 2;

                    const symptomStep = this.steps[2];
                    if (pairing.symptoms && pairing.symptoms.length > 0) {
                        // Symptoms already saved — jump straight to review
                        // 病患與症狀皆已確認過（confirmSymptoms() 也成功執行過），
                        // 直接跳到最後的確認送出畫面。
                        symptomStep.selectedSymptoms = [...pairing.symptoms];
                        symptomStep.completed = true;
                        if (this.currentStep <= 2) this.currentStep = 3;
                    }
                } else {
                    // Prefill symptom selection from last session if available
                    // 病患尚未確認，但 session 中留有「上次填寫到一半」的症狀選擇
                    // （例如使用者在症狀步驟選了一半就離開網頁），這裡先預填回選單，
                    // 並標記 sessionLoaded=true，避免稍後 confirmPatient() 依
                    // matchedRelationObj 的歷史回診紀錄再次覆蓋掉這份剛還原的選擇。
                    if (pairing.symptoms && pairing.symptoms.length > 0) {
                        const symptomStep = this.steps[2];
                        symptomStep.selectedSymptoms = [...pairing.symptoms];
                        symptomStep.sessionLoaded = true;
                    }
                }
            }
        },
    }));
});
