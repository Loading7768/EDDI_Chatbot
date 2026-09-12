"""
form_handler.py — EDDI 病患端「出院/回診表單」Flask Blueprint
======================================================================

【這個檔案在整個系統中的角色】
app.py 建立 Flask app 並註冊三個 Blueprint：本檔案的 form_bp（病患/醫師
在診間內填寫出院衛教表單使用的頁面）、admin_bp（護理站/醫師管理後台，
見 admin_server.py）、以及 LINE Webhook 路由本身（bot.py）。

本檔案對應的前端頁面全部位於 webpage/form/：
  - intro.html   ：填表前導頁（說明用途，通常在診間平板上先顯示）。
  - form.html    ：主要填表頁面（LINE 配對 → 選擇病患關係 → 選擇症狀 →
                    確認送出），由多個 webpage/form/parts/*.html 片段
                    （auth/pair/symptoms/review）組成，透過 Jinja2
                    render_template 帶入 doctor_info/pairing_info 初始資料。
  - complete.html：送出成功後的完成頁。

【使用情境與流程】
這個表單通常是「醫師在診間內，讓病患用手機出示 LINE 綁定用的 6 碼配對碼，
由醫師（或護理師）操作平板/電腦完成填寫」的流程，而不是病患自己在家操作：
  1. 醫師先透過 /api/form_login 用帳號密碼登入（doctor_id/doctor_name/
     doctor_department 存入 session）。
  2. 病患出示 LINE Bot 產生的 6 碼配對碼，醫師輸入後呼叫 /api/form_pair
     驗證配對碼（pairing_codes 暫存字典，有效期 1 小時），成功後把
     line_uuid/line_uname 存入 session，並查出該 LINE 帳號目前已綁定的
     所有病患關係（relations，含各自最近一次同科別看診紀錄的症狀作為
     預填參考）。
  3. 醫師/病患從 relations 中選擇這次要處理的病患身分（或建立新的），
     並勾選本次症狀，呼叫 /api/form_discharge 暫存到 session。
  4. 最終呼叫 /api/form_submit，在單一 SQLite 交易中：
     upsert patients → upsert line_patient_pairs → INSERT INTO record，
     成功後清空 session 並導向 /complete。

【重要注意事項：line_uuid 欄位與資料庫實際 schema 可能不一致】
本檔案中所有對 line_patient_pairs 表的 SQL（WHERE lpp.line_uuid = ？、
INSERT INTO line_patient_pairs (patient_id, line_uuid, relation)）都是
直接使用 line_uuid 欄位，但依照 scripts/db_init.py 定義的實際 schema，
line_patient_pairs 表只有 line_account_id（外鍵指向 line_accounts.line_account_id）
欄位，並沒有 line_uuid 欄位；LINE 帳號的 UUID 字串是存在另一張
line_accounts 表的 uuid 欄位中，需要先 JOIN 才能取得。也就是說，若資料庫
確實依照 db_init.py 建立，本檔案中所有直接操作 line_uuid 的查詢在執行時
會拋出「no such column: line_uuid」的 SQLite 例外，並被對應的
try/except 吞掉（印出錯誤訊息、relations 回傳空陣列，或整筆交易 rollback）。
這是既有程式碼的行為，本次僅新增註解說明現況，不修改任何邏輯或修復此問題。

【pairing_codes 暫存區】
目前是寫死在記憶體中的字典（重啟伺服器即消失），內含 4 組固定測試配對碼
（000000～333333，對應四種不同的病患關係情境：全新帳號、僅本人、多重
關係、僅一筆非本人關係），供開發/測試填表流程使用；expires_at 使用
Unix timestamp 判斷是否過期，由 cleanup_expired_codes() 定期清除。
正式的 LINE Bot 配對碼產生邏輯位於 bot.py 的 Bind 指令處理流程中
（此檔案僅負責「驗證」配對碼，不負責「產生」）。
"""

from flask import Blueprint, request, render_template, jsonify, session, redirect, send_from_directory
import time
import datetime
import sqlite3 # --- 新增註解：引入 sqlite3 以操作資料庫 ---
import os      # --- 新增註解：引入 os 處理路徑 ---
import json    # --- 新增註解：引入 json 處理陣列格式轉換 ---

# 建立一個名為 form_bp 的 Blueprint
form_bp = Blueprint('form_bp', __name__)

# --- 新增註解：取得專案根目錄並設定連接資料庫的輔助函式 ---
# 注意：此處用 os.getcwd()（目前的工作目錄）而非 admin_server.py 採用的
# os.path.dirname(os.path.abspath(__file__)) 往上一層取得專案根目錄；
# 兩種寫法在「從專案根目錄啟動伺服器」的一般情境下結果相同，但若從
# 其他工作目錄執行程式，BASE_DIR 的計算方式可能不同，屬於既有實作差異。
BASE_DIR = os.getcwd()
def get_db(name: str) -> sqlite3.Connection:
    """依資料庫檔名（例如 'hospital.db'）組出 database/ 底下的路徑並連線。
    與 admin_server.py 的 get_db() 不同之處：這裡沒有設定
    conn.row_factory = sqlite3.Row，因此下方所有查詢結果都是用數字索引
    （例如 row[0]、row[1]）取值，而不是用欄位名稱。"""
    path = os.path.join(BASE_DIR, 'database', name)
    return sqlite3.connect(path)

# --- 驗證碼暫存區 ---
# 將原本在 app.py 的暫存區移到這裡統一管理
# 格式: { "123456": {"user_id": "Uxxxx...", "expires_at": 1690000000} }
# 以下 4 組是開發/測試用的固定配對碼，涵蓋不同的病患關係情境，
# 方便在沒有真實 LINE Bot 互動的情況下，直接測試填表頁面的各種分支：
pairing_codes = {
    "000000": {
        "line_uuid": "U0000000", # new account
        "line_uname": "新人",
        "expires_at": time.time() + 3600
    },
    "111111": {
        "line_uuid": "U1a2b3c4d5", # self only
        "line_uname": "孤兒",
        "expires_at": time.time() + 3600
    },
    "222222": {
        "line_uuid": "U2e3f4g5h6", # self + many relations
        "line_uname": "關係複雜",
        "expires_at": time.time() + 3600
    },
    "333333": {
        "line_uuid": "U3i4j5k6l7", # one relation, no self
        "line_uname": "小幫手",
        "expires_at": time.time() + 3600
    }
}

def cleanup_expired_codes():
    """清除 pairing_codes 中已超過 expires_at 時限的配對碼項目，
    在每次呼叫 /api/form_pair 驗證配對碼之前執行，避免暫存區無限增長，
    也確保過期的配對碼不會再被誤認為有效。"""
    current_time = time.time()
    expired_keys = [code for code, data in pairing_codes.items() if current_time > data["expires_at"]]
    for k in expired_keys:
        del pairing_codes[k]

# ── 靜態資源路由 ──────────────────────────────────────────────────────────────
# 因為 webpage/form/ 並非放在 Flask 預設的 static_folder（app.py 把
# static_folder 設為 assets/），所以 CSS/JS/HTML 片段都需要各自的路由
# 手動用 send_from_directory 提供，否則瀏覽器請求這些檔案會得到 404。

@form_bp.route('/form/css/<path:filename>')
def serve_css(filename):
    """提供 webpage/form/css/ 底下的樣式檔（例如 style.css）。"""
    return send_from_directory(os.path.join(BASE_DIR, 'webpage/form/css'), filename)

@form_bp.route('/form/js/<path:filename>')
def serve_js(filename):
    """提供 webpage/form/js/ 底下的腳本檔（app.js、flip.js、state.js）。"""
    return send_from_directory(os.path.join(BASE_DIR, 'webpage/form/js'), filename)

@form_bp.route('/form/parts/<path:filename>')
def serve_parts(filename):
    """提供 webpage/form/parts/ 底下的 HTML 片段檔（auth/pair/symptoms/
    review/macros），這些片段由 form.html 透過前端 JS（app.js 的分頁切換
    邏輯）動態載入拼接，而不是由 Jinja2 在伺服器端 include。"""
    return send_from_directory(os.path.join(BASE_DIR, 'webpage/form/parts'), filename)

@form_bp.route('/intro')
def intro_page():
    """填表前導頁：純靜態頁面，說明填表用途，通常是診間平板上第一個顯示的畫面。"""

    return send_from_directory(os.path.join(BASE_DIR, 'webpage/form'), 'intro.html')
@form_bp.route('/complete')
def complete_page():
    """填表完成頁：/api/form_submit 成功後導向的最終畫面。"""
    return send_from_directory(os.path.join(BASE_DIR, 'webpage/form'), 'complete.html')

@form_bp.route('/form')
def form_page():
    """主要填表頁面：依目前 session 狀態，動態組出兩塊初始資料傳給前端模板：
      - doctor_info：若已透過 /api/form_login 登入，帶出醫師基本資料，
        讓前端可以跳過登入畫面、直接顯示已登入狀態。
      - pairing_info：若已透過 /api/form_pair 完成 LINE 配對，帶出
        該 LINE 帳號目前所有病患關係（relations），每筆關係還會額外查詢
        「同科別最近一次看診記錄的症狀」作為 prefilled_symptoms，
        讓醫師在回診時可以看到病患上次勾選過的症狀，加快填寫速度。
        同時附上 session 中暫存的 symptoms/selected_mrc/selected_relation，
        使頁面重新整理（reload）時能夠恢復到使用者上次填寫的進度，
        不會因為重新整理而遺失已選擇的病患與症狀。
    doctor_info 與 pairing_info 皆為 None 表示尚未登入/配對，前端會顯示
    對應的登入或配對畫面（parts/auth.html、parts/pair.html）。"""
    doctor_info = None
    if 'doctor_id' in session:
        doctor_info = {
            'doctor_id': session.get('doctor_id'),
            'doctor_name': session.get('doctor_name'),
            'department': session.get('doctor_department')
        }

    pairing_info = None
    if 'line_uuid' in session:
        relations = []
        try:
            conn = get_db('hospital.db')
            c = conn.cursor()
            c.execute('''
                SELECT lpp.line_patient_pairs_id, lpp.relation, p.medical_record_number
                FROM line_patient_pairs lpp
                JOIN patients p ON lpp.patient_id = p.patient_id
                WHERE lpp.line_uuid = ?
            ''', (session.get('line_uuid'),))
            rows = c.fetchall()
            for r in rows:
                # 針對每筆病患關係，再查一次「同科別」最近一次看診紀錄的症狀，
                # 作為這次回診時的預設勾選建議（僅供參考，實際仍需使用者確認）。
                c.execute('''
                    SELECT r.symptoms FROM record r
                    JOIN doctors d ON r.doctor_id = d.doctor_id
                    WHERE r.line_patient_pairs_id = ?
                      AND d.department = ?
                    ORDER BY r.checkout_date DESC, r.record_id DESC
                    LIMIT 1
                ''', (r[0], session.get('doctor_department', '')))
                recent_record = c.fetchone()
                prefilled = []
                if recent_record and recent_record[0]:
                    try:
                        prefilled = json.loads(recent_record[0])
                    except:
                        pass
                relations.append({
                    'pair_id': r[0],
                    'relation': r[1],
                    'medical_record_num': r[2],
                    'prefilled_symptoms': prefilled
                })
            conn.close()
        except Exception as e:
            print(f"Error fetching relations: {e}")

        pairing_info = {
            'line_uuid': session.get('line_uuid'),
            'line_uname': session.get('line_uname'),
            'relations': relations,
            'symptoms': session.get('symptoms'),
            'selected_mrc': session.get('selected_mrc', ''),
            'selected_relation': session.get('selected_relation', ''),
        }
    return render_template('form/form.html', doctor_info=doctor_info, pairing_info=pairing_info)

import hashlib

@form_bp.route('/api/form_login', methods=['POST'])
def form_login():
    """醫師登入：與 admin_server.py 的 /api/login 邏輯類似（SHA256 密碼雜湊
    比對 + is_active=1 檢查），但寫入的是獨立於 admin 系統之外的 session
    鍵值（doctor_id/doctor_name/doctor_department/login_time），
    專供本表單流程使用，兩套登入狀態互不影響（同一使用者在填表頁與
    管理後台頁分別登入，不會互相登出）。"""
    data = request.json
    account = data.get('account')
    password = data.get('password')

    if not account or not password:
        return jsonify({"success": False, "message": "帳號或密碼錯誤，或醫師帳號未啟用"})

    hashed_pw = hashlib.sha256(password.encode()).hexdigest()

    conn = get_db('hospital.db')
    c = conn.cursor()
    c.execute(
        'SELECT doctor_id, doctor_name, department FROM doctors WHERE account_name = ? AND password_hash = ? AND is_active = 1',
        (account, hashed_pw))
    doctor = c.fetchone()
    conn.close()

    if not doctor:
        return jsonify({"success": False, "message": "帳號或密碼錯誤，或醫師帳號未啟用"})

    session['doctor_id'] = doctor[0]
    session['doctor_name'] = doctor[1]
    session['doctor_department'] = doctor[2]
    session['login_time'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]

    return jsonify({
        "success": True,
        "doctor_name": doctor[1],
        "department": doctor[2]
    })

@form_bp.route('/api/form_logout', methods=['POST'])
def form_logout():
    """登出：清空整個 session（連同已配對的 LINE 帳號資訊、已選症狀等
    暫存進度一併清除，下次進入 /form 會回到最初的登入畫面）。"""
    session.clear()
    return jsonify({"success": True})

@form_bp.route('/api/form_pair', methods=['POST'])
def form_pair():
    """驗證病患出示的 6 碼配對碼：先呼叫 cleanup_expired_codes() 清掉過期碼，
    再檢查輸入的碼是否存在於 pairing_codes 暫存區。驗證成功後：
      1. 把 line_uuid/line_uname 存入 session，並設定 form_paired=True
         標記本次填表流程已完成 LINE 配對這一步。
      2. 立即查詢並回傳這個 LINE 帳號目前所有病患關係（relations），
         查詢邏輯與 form_page() 中的區塊完全相同（同樣依「同科別最近一次
         看診症狀」計算 prefilled_symptoms），讓前端配對成功後可以直接
         跳到「選擇病患關係」畫面，不需要再重新整理頁面。
    驗證失敗（配對碼不存在或已過期）則回傳 success:false 及錯誤訊息，
    配對碼保持不變（不會被消耗/刪除，可重複嘗試）。"""
    data = request.json
    code = data.get('code')

    cleanup_expired_codes()

    if code in pairing_codes:
        pairing_data = pairing_codes[code]
        session['line_uuid'] = pairing_data['line_uuid']
        session['line_uname'] = pairing_data['line_uname']
        session['form_paired'] = True

        # Fetch patients
        relations = []
        try:
            conn = get_db('hospital.db')
            c = conn.cursor()
            c.execute('''
                SELECT lpp.line_patient_pairs_id, lpp.relation, p.medical_record_number
                FROM line_patient_pairs lpp
                JOIN patients p ON lpp.patient_id = p.patient_id
                WHERE lpp.line_uuid = ?
            ''', (pairing_data['line_uuid'],))
            rows = c.fetchall()
            for r in rows:
                c.execute('''
                    SELECT r.symptoms FROM record r
                    JOIN doctors d ON r.doctor_id = d.doctor_id
                    WHERE r.line_patient_pairs_id = ?
                      AND d.department = ?
                    ORDER BY r.checkout_date DESC, r.record_id DESC
                    LIMIT 1
                ''', (r[0], session.get('doctor_department', '')))
                recent_record = c.fetchone()
                prefilled = []
                if recent_record and recent_record[0]:
                    try:
                        prefilled = json.loads(recent_record[0])
                    except:
                        pass
                relations.append({
                    'pair_id': r[0],
                    'relation': r[1],
                    'medical_record_num': r[2],
                    'prefilled_symptoms': prefilled
                })
            conn.close()
        except Exception as e:
            print(f"Error fetching relations: {e}")

        return jsonify({
            "success": True,
            "line_uname": pairing_data['line_uname'],
            "line_uuid": pairing_data['line_uuid'],
            "relations": relations
        })
    else:
        return jsonify({"success": False, "message": "配對碼錯誤或不存在"})

@form_bp.route('/api/form_discharge', methods=['POST'])
def form_discharge():
    """暫存本次填寫的症狀清單與所選病患身分到 session 中（尚未寫入資料庫），
    對應填表流程中「選擇症狀」這一步。額外把選定的病歷號（mrc）與關係
    （relation）也存起來，讓使用者若在確認畫面前重新整理頁面，
    form_page() 能透過 session['selected_mrc']/session['selected_relation']
    還原目前選擇的病患身分，不必重新選擇一次。"""
    data = request.json
    symptoms = data.get('symptoms', [])
    session['symptoms'] = symptoms
    # Persist selected patient so page reload can resume at review
    mrc = data.get('medical_record_num', '')
    relation = data.get('relation', '')
    if mrc:
        session['selected_mrc'] = mrc
    if relation:
        session['selected_relation'] = relation
    return jsonify({"success": True})

@form_bp.route('/api/form_submit', methods=['POST'])
def form_submit():
    """最終送出：把整個填表流程累積的資料（醫師、LINE 帳號、病歷號、
    關係、症狀）正式寫入資料庫，在單一交易（BEGIN TRANSACTION ...
    commit/rollback）中依序執行：
      1. INSERT OR IGNORE 到 patients 表：若病歷號已存在則不重複新增，
         has_chatted 預設為 0（尚未透過 LINE Bot 對話）。
      2. 查回 patient_id（因為上一步用 OR IGNORE，不能直接用
         cursor.lastrowid 取得，須另外 SELECT 一次確保取得正確 ID，
         無論是新建立還是原本已存在的病患都能查到）。
      3. INSERT OR IGNORE 到 line_patient_pairs 表，建立/確保這個
         LINE 帳號與病患的配對關係存在。
      4. 查回 line_patient_pairs_id（原因同第 2 步）。
      5. 將症狀陣列序列化為 JSON 字串，INSERT 一筆新的 record
         （每次送出表單都會新增一筆全新的看診紀錄，checkout_date 為
         目前時間，doctor_id 取自 session 中已登入的醫師）。
    任何步驟拋出例外都會 rollback 整筆交易並關閉連線，確保不會留下
    「病患/配對已建立但看診紀錄沒寫入」的半殘資料。成功後清空 session
    （結束本次填表流程）並回傳前端導向 /complete 頁面的指示。"""
    data = request.json
    medical_record_num = data.get("medical_record_num")
    relation = data.get("relation")

    doctor_id = session.get('doctor_id')
    line_id = session.get('line_uuid')
    topics = session.get('symptoms', [])
    discharge_date = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]

    if not doctor_id or not line_id or not medical_record_num or not relation:
        return jsonify({"success": False, "message": "資料不全，無法進行綁定"})

    conn = None
    try:
        conn = get_db('hospital.db')
        c = conn.cursor()
        c.execute('BEGIN TRANSACTION')

        # -- patients table
        c.execute('''
            INSERT OR IGNORE INTO patients (medical_record_number, has_chatted)
            VALUES (?, 0)
        ''', (medical_record_num,))

        # -- Retrieve patient_id safely
        c.execute('''
            SELECT patient_id FROM patients WHERE medical_record_number = ?
        ''', (medical_record_num,))
        patient_row = c.fetchone()
        if not patient_row:
            raise Exception("無法取得 patient_id")
        patient_id = patient_row[0]

        # -- line_patient_pairs table
        c.execute('''
            INSERT OR IGNORE INTO line_patient_pairs (patient_id, line_uuid, relation)
            VALUES (?, ?, ?)
        ''', (patient_id, line_id, relation))

        # -- Retrieve line_patient_pairs_id
        c.execute('''
            SELECT line_patient_pairs_id FROM line_patient_pairs
            WHERE line_uuid = ? AND patient_id = ?
        ''', (line_id, patient_id))
        pair_row = c.fetchone()
        if not pair_row:
            raise Exception("無法取得 line_patient_pairs_id")
        pair_id = pair_row[0]

        # -- records table
        symptoms_json = json.dumps(topics, ensure_ascii=False)
        c.execute('''
            INSERT INTO record (line_patient_pairs_id, checkout_date, doctor_id, symptoms)
            VALUES (?, ?, ?, ?)
        ''', (pair_id, discharge_date, doctor_id, symptoms_json))

        conn.commit()
        conn.close()

        # Clear session
        session.clear()

        return jsonify({"success": True, "redirect": "/complete"})
    except Exception as e:
        if conn:
            conn.rollback()
            conn.close()
        print(f"Transaction failed: {e}")
        return jsonify({"success": False, "message": f"資料傳送失敗，請再試一次"})
