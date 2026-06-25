from flask import Blueprint, request, render_template, jsonify, session, redirect
import time
import sqlite3 # --- 新增註解：引入 sqlite3 以操作資料庫 ---
import os      # --- 新增註解：引入 os 處理路徑 ---
import json    # --- 新增註解：引入 json 處理陣列格式轉換 ---

# 建立一個名為 form_bp 的 Blueprint
form_bp = Blueprint('form_bp', __name__)

# --- 新增註解：取得專案根目錄並設定連接資料庫的輔助函式 ---
BASE_DIR = os.getcwd()

def get_db(name: str) -> sqlite3.Connection:
    path = os.path.join(BASE_DIR, 'database', name)
    return sqlite3.connect(path)

# --- 驗證碼暫存區 ---
# 將原本在 app.py 的暫存區移到這裡統一管理
# 格式: { "123456": {"user_id": "Uxxxx...", "expires_at": 1690000000} }
verification_codes = {
    "112233": {
        "user_id": "U3i4j5k6l7",
        # "user_id": "U1a2b3c4d5",
        "user_name": "曾宇晨",
        "expires_at": time.time() + 3600
    },
    "223344": {
        "user_id": "U2e3f4g5h6",
        "user_name": "楚中天",
        "expires_at": time.time() + 3600
    }
}

# 清理過期驗證碼的輔助函式
def cleanup_expired_codes():
    current_time = time.time()
    expired_keys = [code for code, data in verification_codes.items() if current_time > data["expires_at"]]
    for k in expired_keys:
        del verification_codes[k]

# ================= 網頁路由 =================

@form_bp.route("/verify", methods=['GET'])
def verify_page():
    return redirect('/form')

@form_bp.route("/api/verify_code", methods=['POST'])
def verify_code():
    data = request.json
    account = data.get("account")
    password = data.get("password")
    code = data.get("code")

    if not account or not password or not code:
        return jsonify({"success": False, "message": "請填寫完整資訊"})

    import hashlib
    hashed_pw = hashlib.sha256(password.encode()).hexdigest()

    conn = get_db('hospital.db')
    c = conn.cursor()
    c.execute('SELECT doctor_id, doctor_name, department FROM doctors WHERE account_name = ? AND password_hash = ? AND is_active = 1', (account, hashed_pw))
    doctor = c.fetchone()
    conn.close()

    if not doctor:
        return jsonify({"success": False, "message": "帳號或密碼錯誤，或此醫師未啟用"})

    # 2. 尋找驗證碼記錄
    record = verification_codes.get(code)
    if not record:
        return jsonify({"success": False, "message": "驗證碼錯誤或不存在"})

    # 3. 檢查是否過期
    if time.time() > record["expires_at"]:
        del verification_codes[code] # 過期就刪除
        return jsonify({"success": False, "message": "驗證碼已逾時(超過10分鐘)，請回 LINE 重新取得"})

    # 驗證成功：取得 ID 與 名字
    user_id = record["user_id"]
    user_name = record.get("user_name", "未知用戶")
    del verification_codes[code]

    # --- 修改：存入 session ---
    session['form_verified'] = True
    session['form_user_id'] = user_id
    session['form_user_name'] = user_name
    
    session['doctor_id'] = doctor[0]
    session['doctor_name'] = doctor[1]
    session['doctor_department'] = doctor[2]

    return jsonify({"success": True, "redirect_url": "/form"})

@form_bp.route("/form")
def form_page():
    # --- 新增功能：後端檢查 Session 狀態 ---
    # 如果 session 裡沒有 verified 標記，代表未經登入流程，回傳 login 版面
    if not session.get('form_verified'):
        return render_template("form.html", verified=False)
    
    # --- 從 session 取得 ID 與名字並組合 ---
    uid = session.get('form_user_id', '未知 ID')
    uname = session.get('form_user_name', '未知名字')
    
    doctor_id = session.get('doctor_id')
    doctor_name = session.get('doctor_name')
    doctor_department = session.get('doctor_department')

    # ==== 查詢使用者關聯的病患資料 ====
    relations = []
    try:
        conn = get_db('hospital.db')
        c = conn.cursor()
        c.execute('''
            SELECT lpp.line_patient_pairs_id, lpp.relation, p.medical_record_number
            FROM line_patient_pairs lpp
            JOIN patients p ON lpp.patient_id = p.patient_id
            WHERE lpp.line_uuid = ?
        ''', (uid,))
        rows = c.fetchall()
        for r in rows:
            # Query most recent symptoms for this patient pair under the current doctor's department
            c.execute('''
                SELECT r.symptoms FROM record r
                JOIN doctors d ON r.doctor_id = d.doctor_id
                WHERE r.line_patient_pairs_id = ?
                  AND d.department = ?
                ORDER BY r.checkout_date DESC, r.record_id DESC
                LIMIT 1
            ''', (r[0], doctor_department))
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
                'prefilled_topics': prefilled
            })
        conn.close()
    except Exception as e:
        print(f"讀取關聯資料發生錯誤: {str(e)}")

    return render_template("form.html", verified=True, uname=uname, uid=uid, 
                           doctor_id=doctor_id, doctor_name=doctor_name, doctor_department=doctor_department,
                           relations=relations)


# --- 新增註解：新增處理表單送出的 API 路由，將資料寫入 patient.db 及 form.db ---
@form_bp.route("/api/submit_form", methods=['POST'])
def submit_form():
    data = request.json
    user_name = data.get("user_name")
    line_id = data.get("line_id")
    medical_record_num = data.get("medical_record_num")
    relation = data.get("relation")
    doctor_id = data.get("doctor_id")
    discharge_date = data.get("discharge_date")
    topics = data.get("topics", [])

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

        # 清除 session
        session.clear()

        return jsonify({"success": True, "message": "表單已成功儲存至資料庫"})
    except Exception as e:
        if conn:
            conn.rollback()
            conn.close()
        return jsonify({"success": False, "message": f"寫入資料庫失敗: {str(e)}"})