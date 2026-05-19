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
verification_codes = {}

# 清理過期驗證碼的輔助函式
def cleanup_expired_codes():
    current_time = time.time()
    expired_keys = [code for code, data in verification_codes.items() if current_time > data["expires_at"]]
    for k in expired_keys:
        del verification_codes[k]

# ================= 網頁路由 =================

@form_bp.route("/verify", methods=['GET'])
def verify_page():
    # 這裡直接對應 webpage/form_verify.html
    return render_template("form_verify.html")

@form_bp.route("/api/verify_code", methods=['POST'])
def verify_code():
    data = request.json
    code = data.get("code")
    password = data.get("password")

    # 1. 驗證密碼
    if password != "12345":
        return jsonify({"success": False, "message": "密碼錯誤"})

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

    return jsonify({"success": True, "redirect_url": "/form"})

@form_bp.route("/form")
def form_page():
    # --- 新增功能：後端檢查 Session 狀態 ---
    # 如果 session 裡沒有 verified 標記，代表未經登入流程，直接導向回驗證頁
    if not session.get('form_verified'):
        return redirect('/verify')
    
    # --- 從 session 取得 ID 與名字並組合 ---
    uid = session.get('form_user_id', '未知 ID')
    uname = session.get('form_user_name', '未知名字')
    # 格式範例：曾宇晨 (U123456...)
    # display_info = f"{uname} ({uid})"
    # return render_template("form.html", line_info=display_info, uname=uname, uid=uid)
    
    # --- 新增註解：連接 doctor.db，讀取啟用的醫師名單作為表單下拉選單資料 ---
    conn = get_db('doctor.db')
    c = conn.cursor()
    c.execute('SELECT account_name, doctor_name FROM DOCTOR WHERE is_active = 1')
    doctors = [{'account_name': row[0], 'doctor_name': row[1]} for row in c.fetchall()]
    conn.close()

    # ==== 新增註解：查詢使用者是否存在歷史紀錄，以利預先填入表單 ====
    prefill_record_num = ""
    prefill_doctor_id = ""
    prefill_topics = []

    try:
        # 1. 透過 line_id 去 patient.db 查出該名病患的病歷號
        conn_pat = get_db('patient.db')
        c_pat = conn_pat.cursor()
        c_pat.execute('SELECT medical_record_num FROM PATIENT WHERE line_id = ?', (uid,))
        pat_row = c_pat.fetchone()
        conn_pat.close()

        if pat_row:
            medical_record_num = pat_row[0]
            
            # 2. 拿著病歷號去 form.db 查詢最近一次的紀錄 (以 checkout_date 遞減排序取第一筆)
            conn_form = get_db('form.db')
            c_form = conn_form.cursor()
            c_form.execute('''
                SELECT medical_record_num, doctor_account, symptoms 
                FROM FORM 
                WHERE medical_record_num = ? 
                ORDER BY checkout_date DESC 
                LIMIT 1
            ''', (medical_record_num,))
            form_row = c_form.fetchone()
            conn_form.close()

            if form_row:
                prefill_record_num = form_row[0]
                prefill_doctor_id = form_row[1]
                if form_row[2]:
                    prefill_topics = json.loads(form_row[2])
    except Exception as e:
        print(f"讀取歷史資料發生錯誤: {str(e)}")
    # ==========================================================

    # --- 新增註解：將 doctors 傳遞給前端 ---
    # ==== 新增註解：一併將查到的歷史紀錄 (prefill 相關變數) 傳遞給前端 ====
    return render_template("form.html", uname=uname, uid=uid, doctors=doctors, 
                           prefill_record_num=prefill_record_num, 
                           prefill_doctor_id=prefill_doctor_id, 
                           prefill_topics=prefill_topics)


# --- 新增註解：新增處理表單送出的 API 路由，將資料寫入 patient.db 及 form.db ---
@form_bp.route("/api/submit_form", methods=['POST'])
def submit_form():
    data = request.json
    user_name = data.get("user_name")
    line_id = data.get("line_id")
    medical_record_num = data.get("medical_record_num")
    doctor_id = data.get("doctor_id")
    discharge_date = data.get("discharge_date")
    topics = data.get("topics", [])

    try:
        # --- 新增註解：處理 patient.db，寫入病歷號、LINE ID 及 病患姓名 ---
        conn_patient = get_db('patient.db')
        c_patient = conn_patient.cursor()
        c_patient.execute('''
            INSERT OR REPLACE INTO PATIENT (medical_record_num, line_id, patient_name) 
            VALUES (?, ?, ?)
        ''', (medical_record_num, line_id, user_name))
        conn_patient.commit()
        conn_patient.close()

        # --- 新增註解：處理 form.db，寫入病歷號、醫師帳號、出院日期 及 衛教症狀 ---
        conn_form = get_db('form.db')
        c_form = conn_form.cursor()
        # 將衛教項目陣列轉為 JSON 格式字串存入資料庫
        symptoms_json = json.dumps(topics, ensure_ascii=False)
        c_form.execute('''
            INSERT OR REPLACE INTO FORM (medical_record_num, doctor_account, checkout_date, symptoms) 
            VALUES (?, ?, ?, ?)
        ''', (medical_record_num, doctor_id, discharge_date, symptoms_json))
        conn_form.commit()
        conn_form.close()

        return jsonify({"success": True, "message": "表單已成功儲存至資料庫"})
    except Exception as e:
        return jsonify({"success": False, "message": f"寫入資料庫失敗: {str(e)}"})