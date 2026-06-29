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
pairing_codes = {
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

def cleanup_expired_codes():
    current_time = time.time()
    expired_keys = [code for code, data in pairing_codes.items() if current_time > data["expires_at"]]
    for k in expired_keys:
        del pairing_codes[k]


import hashlib

@form_bp.route('/api/form_login', methods=['POST'])
def form_login():
    data = request.json
    account = data.get('account')
    password = data.get('password')
    
    if not account or not password:
        return jsonify({"success": False, "message": "帳號或密碼錯誤，或醫師帳號未啟用"})
        
    hashed_pw = hashlib.sha256(password.encode()).hexdigest()
    
    conn = get_db('hospital.db')
    c = conn.cursor()
    c.execute('SELECT doctor_id, doctor_name, department FROM doctors WHERE account_name = ? AND password_hash = ? AND is_active = 1', (account, hashed_pw))
    doctor = c.fetchone()
    conn.close()
    
    if not doctor:
        return jsonify({"success": False, "message": "帳號或密碼錯誤，或醫師帳號未啟用"})
        
    session['doctor_id'] = doctor[0]
    session['doctor_name'] = doctor[1]
    session['doctor_department'] = doctor[2]
    
    return jsonify({
        "success": True, 
        "doctor_name": doctor[1],
        "department": doctor[2]
    })

@form_bp.route('/api/form_logout', methods=['POST'])
def form_logout():
    session.clear()
    return jsonify({"success": True})

@form_bp.route('/form')
def form_page():
    doctor_info = None
    if 'doctor_id' in session:
        doctor_info = {
            'doctor_id': session.get('doctor_id'),
            'doctor_name': session.get('doctor_name'),
            'department': session.get('doctor_department')
        }
    return render_template('form.html', doctor_info=doctor_info)
