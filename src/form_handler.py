from flask import Blueprint, request, render_template, jsonify, session, redirect
import time
import datetime
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
    session['login_time'] = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    
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
            'symptoms': session.get('symptoms')
        }
        
    return render_template('form.html', doctor_info=doctor_info, pairing_info=pairing_info)

@form_bp.route('/api/form_pair', methods=['POST'])
def form_pair():
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
    data = request.json
    symptoms = data.get('symptoms', [])
    session['symptoms'] = symptoms
    return jsonify({"success": True})

@form_bp.route('/api/form_submit', methods=['POST'])
def form_submit():
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
        
        return jsonify({"success": True})
    except Exception as e:
        if conn:
            conn.rollback()
            conn.close()
        print(f"Transaction failed: {e}")
        return jsonify({"success": False, "message": f"資料傳送失敗，請再試一次"})
