from flask import Blueprint, request, jsonify, session, send_from_directory
import sqlite3
import hashlib
import json
import os
import glob
from datetime import datetime
from functools import wraps

admin_bp = Blueprint('admin_bp', __name__)

# ── 路徑設定 ──────────────────────────────────────────────────────────────────
# admin_server.py 放在 src/，所以專案根目錄是上一層
SRC_DIR      = os.path.dirname(os.path.abspath(__file__))
BASE_DIR     = os.path.dirname(SRC_DIR)

WEBPAGE_DIR   = os.path.join(BASE_DIR, 'webpage')
PROMPT_FILE   = os.path.join(BASE_DIR, 'assets', 'prompt.md')
STATS_CACHE   = os.path.join(BASE_DIR, 'data', 'stats_cache.json')
CHAT_LOGS_DIR = os.path.join(BASE_DIR, 'chat_logs')   # chat_logs/<MRN>/*.json

DB_DOCTOR  = os.path.join(BASE_DIR, 'database', 'doctor.db')
DB_PATIENT = os.path.join(BASE_DIR, 'database', 'patient.db')
DB_FORM    = os.path.join(BASE_DIR, 'database', 'form.db')


def migrate_doctor_db():
    if not os.path.exists(DB_DOCTOR):
        return
    try:
        conn = sqlite3.connect(DB_DOCTOR)
        c = conn.cursor()
        # 檢查 DOCTOR 表中是否存在 specialty 欄位
        c.execute("PRAGMA table_info(DOCTOR)")
        columns = [col[1] for col in c.fetchall()]
        if 'specialty' not in columns:
            print("[Migration] 偵測到舊資料庫，為 DOCTOR 資料表新增 specialty 欄位...")
            c.execute("ALTER TABLE DOCTOR ADD COLUMN specialty TEXT")
            c.execute("UPDATE DOCTOR SET specialty = '急診科'")
            conn.commit()
            print("[Migration] 資料庫遷移成功！")
        conn.close()
    except Exception as e:
        print(f"[Migration] doctor.db 自動遷移失敗: {e}")

migrate_doctor_db()


# ── helpers ──────────────────────────────────────────────────────────────────

def hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()


def get_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'account' not in session:
            return jsonify({'error': '請先登入'}), 401
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'account' not in session:
            return jsonify({'error': '請先登入'}), 401
        if not session.get('is_admin'):
            return jsonify({'error': '此功能僅限管理員'}), 403
        return f(*args, **kwargs)
    return wrapper


# ── chat_logs JSON 讀取工具 ────────────────────────────────────────────────────

def _parse_timestamp(ts: str) -> str:
    """把 ISO 8601 timestamp 轉成 'YYYY-MM-DD HH:MM:SS' 字串。"""
    if not ts:
        return ''
    ts = ts.strip()
    for sep in ('+', 'Z'):
        idx = ts.find(sep, 10)   # 避免誤切日期裡的 '-'
        if idx != -1:
            ts = ts[:idx]
    return ts.replace('T', ' ')


def load_messages_for_mrn(mrn: str) -> list:
    """
    讀取 chat_logs/<mrn>/ 下所有 *.json，
    依 timestamp 排序後回傳 message list。
    active_session.json 也會被讀入。
    """
    mrn_dir = os.path.join(CHAT_LOGS_DIR, mrn)
    if not os.path.isdir(mrn_dir):
        return []

    all_messages = []
    for filepath in glob.glob(os.path.join(mrn_dir, '*.json')):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            for msg in data.get('messages', []):
                all_messages.append({
                    'role':       msg.get('role', ''),
                    'content':    msg.get('content', ''),
                    'created_at': _parse_timestamp(msg.get('timestamp', '')),
                })
        except Exception as e:
            print(f'[chat_logs] 讀取失敗 {os.path.basename(filepath)}: {e}')

    all_messages.sort(key=lambda m: m['created_at'])

    for i, m in enumerate(all_messages):
        m['id'] = i + 1

    return all_messages


def load_sessions_for_mrn(mrn: str) -> list:
    """
    讀取 chat_logs/<mrn>/ 下所有 *.json，
    依 start_time 降序排序，並回傳 session list。
    每一個 session 包含:
      - session_id (檔名)
      - label (顯示標籤)
      - messages (訊息清單)
      - metadata (原 metadata)
    """
    mrn_dir = os.path.join(CHAT_LOGS_DIR, mrn)
    if not os.path.isdir(mrn_dir):
        return []

    sessions = []
    for filepath in glob.glob(os.path.join(mrn_dir, '*.json')):
        try:
            filename = os.path.basename(filepath)
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            meta = data.get('metadata', {})
            raw_start = meta.get('start_time', '')
            parsed_start = _parse_timestamp(raw_start)
            
            # 建立易讀的 label
            if filename == 'active_session.json':
                label = f"最後一次對話 ({parsed_start})" if parsed_start else "最後一次對話"
            else:
                session_date = meta.get('session_date', '')
                session_seq = meta.get('session_sequence', '')
                
                # 格式化 sequence
                if isinstance(session_seq, (int, float)):
                    seq_str = f" #{int(session_seq):02d}"
                elif session_seq:
                    seq_str = f" #{session_seq}"
                else:
                    seq_str = ""
                
                # 取得時間部分，例如 "22:00:00"
                time_part = parsed_start.split(' ')[1] if ' ' in parsed_start else ""
                time_str = f" ({time_part})" if time_part else ""
                
                label = f"{session_date} 對話{seq_str}{time_str}"
                
            messages = []
            for msg in data.get('messages', []):
                messages.append({
                    'role':       msg.get('role', ''),
                    'content':    msg.get('content', ''),
                    'created_at': _parse_timestamp(msg.get('timestamp', '')),
                })
            
            sessions.append({
                'session_id': filename,
                'label': label,
                'start_time': parsed_start,
                'messages': messages,
                'metadata': meta
            })
        except Exception as e:
            print(f'[chat_logs] 讀取失敗 {os.path.basename(filepath)}: {e}')

    # 依 start_time 降序排序
    sessions.sort(key=lambda s: s['start_time'], reverse=True)
    return sessions


def get_chat_stats_for_mrn(mrn: str) -> dict:
    """回傳 {msg_count, last_chat} 給病患列表使用，輕量掃描。"""
    mrn_dir = os.path.join(CHAT_LOGS_DIR, mrn)
    if not os.path.isdir(mrn_dir):
        return {'msg_count': 0, 'last_chat': None}

    msg_count = 0
    latest_ts = ''
    for filepath in glob.glob(os.path.join(mrn_dir, '*.json')):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            msg_count += len(data.get('messages', []))
            meta_end = data.get('metadata', {}).get('end_time', '')
            if meta_end:
                ts = _parse_timestamp(meta_end)
                if ts > latest_ts:
                    latest_ts = ts
        except Exception:
            pass

    return {
        'msg_count': msg_count,
        'last_chat': latest_ts[:10] if latest_ts else None,
    }


def list_mrns_with_logs() -> set:
    """回傳 chat_logs/ 下有 json 檔的 MRN 集合。"""
    if not os.path.isdir(CHAT_LOGS_DIR):
        return set()
    result = set()
    for entry in os.scandir(CHAT_LOGS_DIR):
        if entry.is_dir() and glob.glob(os.path.join(entry.path, '*.json')):
            result.add(entry.name)
    return result


# ── routes ────────────────────────────────────────────────────────────────────

@admin_bp.route('/admin')
def index():
    return send_from_directory(WEBPAGE_DIR, 'admin.html')


@admin_bp.route('/api/me')
def get_me():
    if 'account' not in session:
        return jsonify({'logged_in': False})
    return jsonify({
        'logged_in':   True,
        'account':     session['account'],
        'doctor_name': session['doctor_name'],
        'is_admin':    session['is_admin'],
    })


@admin_bp.route('/api/login', methods=['POST'])
def login():
    data     = request.get_json() or {}
    account  = data.get('username', '').strip()
    password = data.get('password', '')

    if not account or not password:
        return jsonify({'success': False, 'error': '請填寫帳號和密碼'}), 400

    if not os.path.exists(DB_DOCTOR):
        return jsonify({'success': False,
                        'error': '資料庫尚未初始化，請先執行 init_db.py'}), 500

    try:
        conn = get_db(DB_DOCTOR)
        row  = conn.execute(
            'SELECT * FROM DOCTOR WHERE account_name = ? AND password_hash = ? AND is_active = 1',
            (account, hash_pw(password))
        ).fetchone()
        conn.close()
    except Exception as e:
        return jsonify({'success': False, 'error': f'資料庫錯誤：{e}'}), 500

    if not row:
        return jsonify({'success': False, 'error': '帳號或密碼錯誤，或帳號已停用'}), 401

    session['account']     = row['account_name']
    session['doctor_name'] = row['doctor_name']
    session['is_admin']    = bool(row['is_admin'])

    return jsonify({
        'success':     True,
        'doctor_name': row['doctor_name'],
        'is_admin':    bool(row['is_admin']),
    })


@admin_bp.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})


# ── 統計數據 ──────────────────────────────────────────────────────────────────

@admin_bp.route('/api/stats')
@login_required
def get_stats():
    stats = {}

    try:
        conn = get_db(DB_PATIENT)
        stats['total_friends'] = conn.execute('SELECT COUNT(*) FROM PATIENT').fetchone()[0]
        conn.close()
    except Exception:
        stats['total_friends'] = 0

    try:
        conn = get_db(DB_FORM)
        stats['total_patients'] = conn.execute(
            'SELECT COUNT(DISTINCT medical_record_num) FROM FORM').fetchone()[0]
        stats['total_forms'] = conn.execute('SELECT COUNT(*) FROM FORM').fetchone()[0]
        conn.close()
    except Exception:
        stats['total_patients'] = 0
        stats['total_forms']    = 0

    # LINE Bot 使用率：有 chat_logs 資料夾的 MRN 數 / 好友總數
    try:
        chatted = len(list_mrns_with_logs())
        total   = stats['total_friends'] or 1
        stats['patients_chatted'] = chatted
        stats['bot_usage_rate']   = round(chatted / total * 100, 1)
    except Exception:
        stats['patients_chatted'] = 0
        stats['bot_usage_rate']   = 0

    stats['return_visits'] = max(0, stats['total_forms'] - stats['total_patients'])

    try:
        os.makedirs(os.path.dirname(STATS_CACHE), exist_ok=True)
        cached = {}
        if os.path.exists(STATS_CACHE):
            with open(STATS_CACHE, 'r', encoding='utf-8') as f:
                cached = json.load(f)
        snapshot = {k: v for k, v in stats.items()}
        if cached.get('data') != snapshot:
            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            stats['last_updated'] = now
            with open(STATS_CACHE, 'w', encoding='utf-8') as f:
                json.dump({'data': snapshot, 'last_updated': now}, f, ensure_ascii=False, indent=2)
        else:
            stats['last_updated'] = cached.get('last_updated', '')
    except Exception:
        stats['last_updated'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    return jsonify(stats)


# ── 聊天紀錄列表 ──────────────────────────────────────────────────────────────

@admin_bp.route('/api/chats')
@login_required
def get_chats():
    account  = session['account']
    is_admin = session['is_admin']

    try:
        conn_f = get_db(DB_FORM)
        conn_p = get_db(DB_PATIENT)
        conn_d = get_db(DB_DOCTOR)

        # 取得所有醫生帳號與科別的對照表
        doctor_rows = conn_d.execute('SELECT account_name, specialty FROM DOCTOR').fetchall()
        doc_specialties = {row['account_name']: row['specialty'] for row in doctor_rows}
        conn_d.close()

        if is_admin:
            rows = conn_f.execute(
                'SELECT medical_record_num, COUNT(*) AS form_count FROM FORM '
                'GROUP BY medical_record_num'
            ).fetchall()
        else:
            rows = conn_f.execute(
                'SELECT medical_record_num, COUNT(*) AS form_count FROM FORM '
                'WHERE doctor_account = ? '
                'GROUP BY medical_record_num',
                (account,)
            ).fetchall()

        result = []
        for row in rows:
            mrn = row['medical_record_num']
            patient = conn_p.execute(
                'SELECT line_id FROM PATIENT WHERE medical_record_num = ?', (mrn,)
            ).fetchone()
            
            # 取得最新一筆就診紀錄，獲取出院日期與醫師帳號
            latest_form = conn_f.execute(
                'SELECT doctor_account, checkout_date FROM FORM WHERE medical_record_num = ? '
                'ORDER BY checkout_date DESC LIMIT 1', (mrn,)
            ).fetchone()

            chat_stats = get_chat_stats_for_mrn(mrn)
            
            doctor_account = latest_form['doctor_account'] if latest_form else None
            specialty = doc_specialties.get(doctor_account, '急診科')

            result.append({
                'medical_record_num': mrn,
                'line_id':            patient['line_id'] if patient else None,
                'form_count':         row['form_count'],
                'msg_count':          chat_stats['msg_count'],
                'has_logs':           chat_stats['msg_count'] > 0,
                'last_chat':          chat_stats['last_chat'],
                'latest_checkout':    latest_form['checkout_date'] if latest_form else None,
                'specialty':          specialty,
            })

        conn_f.close()
        conn_p.close()
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify(result)


# ── 單一病患詳情 ──────────────────────────────────────────────────────────────

@admin_bp.route('/api/chats/<mrn>')
@login_required
def get_chat_detail(mrn: str):
    account  = session['account']
    is_admin = session['is_admin']

    if not is_admin:
        conn = get_db(DB_FORM)
        allowed = conn.execute(
            'SELECT 1 FROM FORM WHERE medical_record_num = ? AND doctor_account = ?',
            (mrn, account)
        ).fetchone()
        conn.close()
        if not allowed:
            return jsonify({'error': '無查看權限'}), 403

    conn_p  = get_db(DB_PATIENT)
    patient = conn_p.execute(
        'SELECT * FROM PATIENT WHERE medical_record_num = ?', (mrn,)
    ).fetchone()
    conn_p.close()
    if not patient:
        return jsonify({'error': '找不到此病患'}), 404

    conn_f = get_db(DB_FORM)
    forms  = conn_f.execute(
        'SELECT * FROM FORM WHERE medical_record_num = ? ORDER BY checkout_date ASC', (mrn,)
    ).fetchall()
    conn_f.close()

    # 取得醫生科別對照表
    conn_d = get_db(DB_DOCTOR)
    doctor_rows = conn_d.execute('SELECT account_name, specialty FROM DOCTOR').fetchall()
    doc_specialties = {row['account_name']: row['specialty'] for row in doctor_rows}
    conn_d.close()

    # 從 JSON 檔讀取聊天訊息（分開成多個 sessions）
    sessions_list = load_sessions_for_mrn(mrn)

    forms_list = [
        {
            'medical_record_num': r['medical_record_num'],
            'doctor_account':     r['doctor_account'],
            'specialty':          doc_specialties.get(r['doctor_account'], '急診科'),
            'checkout_date':      r['checkout_date'],
            'symptoms':           json.loads(r['symptoms']) if r['symptoms'] else [],
            'is_chatted':         bool(r['is_chatted']) if 'is_chatted' in r.keys() else False,
        }
        for r in forms
    ]

    return jsonify({
        'patient': {
            'medical_record_num': patient['medical_record_num'],
            'line_id':            patient['line_id'],
        },
        'forms':    forms_list,
        'sessions': sessions_list,
    })


# ── 修改表單 ──────────────────────────────────────────────────────────────────

@admin_bp.route('/api/forms/<mrn>/<checkout_date>', methods=['PUT'])
@login_required
def update_form(mrn: str, checkout_date: str):
    account  = session['account']
    is_admin = session['is_admin']

    conn = get_db(DB_FORM)

    if not is_admin:
        allowed = conn.execute(
            'SELECT 1 FROM FORM WHERE medical_record_num = ? AND checkout_date = ? AND doctor_account = ?',
            (mrn, checkout_date, account)
        ).fetchone()
        if not allowed:
            conn.close()
            return jsonify({'error': '無修改權限'}), 403

    row = conn.execute(
        'SELECT * FROM FORM WHERE medical_record_num = ? AND checkout_date = ?',
        (mrn, checkout_date)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': '找不到此表單'}), 404

    data               = request.get_json() or {}
    new_checkout_date  = data.get('checkout_date', checkout_date)
    new_doctor_account = data.get('doctor_account', row['doctor_account'])
    symptoms_raw       = data.get('symptoms', None)

    if symptoms_raw is not None:
        if isinstance(symptoms_raw, list):
            new_symptoms = json.dumps(symptoms_raw, ensure_ascii=False)
        else:
            parts = [s.strip() for s in str(symptoms_raw).split(',') if s.strip()]
            new_symptoms = json.dumps(parts, ensure_ascii=False)
    else:
        new_symptoms = row['symptoms']

    try:
        if new_checkout_date != checkout_date:
            conn.execute(
                'INSERT INTO FORM (medical_record_num, doctor_account, checkout_date, symptoms, is_chatted) '
                'VALUES (?,?,?,?,?)',
                (mrn, new_doctor_account, new_checkout_date, new_symptoms, row['is_chatted'])
            )
            conn.execute(
                'DELETE FROM FORM WHERE medical_record_num = ? AND checkout_date = ?',
                (mrn, checkout_date)
            )
        else:
            conn.execute(
                'UPDATE FORM SET doctor_account = ?, symptoms = ? '
                'WHERE medical_record_num = ? AND checkout_date = ?',
                (new_doctor_account, new_symptoms, mrn, checkout_date)
            )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')})
    except Exception as e:
        conn.close()
        return jsonify({'error': str(e)}), 500


# ── 醫師帳號管理（管理員）────────────────────────────────────────────────────

import secrets
import string

def generate_random_password(length=8) -> str:
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


@admin_bp.route('/api/doctors', methods=['GET'])
@admin_required
def list_doctors():
    try:
        # 1. 查詢 form.db，取得所有已有表單的醫師帳號
        conn_f = get_db(DB_FORM)
        active_accounts = {row['doctor_account'] for row in conn_f.execute(
            'SELECT DISTINCT doctor_account FROM FORM'
        ).fetchall()}
        conn_f.close()

        # 2. 查詢 doctor.db，取得所有醫師資料
        conn = get_db(DB_DOCTOR)
        rows = conn.execute(
            'SELECT account_name, doctor_name, is_active, is_admin, specialty FROM DOCTOR '
            'ORDER BY is_admin DESC, account_name'
        ).fetchall()
        conn.close()

        result = []
        for row in rows:
            d = dict(row)
            # 不能刪除自己，且如果醫師已看診（在 form.db 中有紀錄），則無法刪除
            d['can_delete'] = (d['account_name'] not in active_accounts) and (d['account_name'] != session.get('account'))
            result.append(d)

        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/doctors', methods=['POST'])
@admin_required
def create_doctor():
    data = request.get_json() or {}
    account = data.get('account_name', '').strip()
    name = data.get('doctor_name', '').strip()
    active = int(data.get('is_active', 1))
    admin = int(data.get('is_admin', 0))
    specialty = data.get('specialty', '').strip()

    if not account or not name:
        return jsonify({'error': '請填寫帳號與姓名'}), 400

    if not specialty:
        specialty = '急診科'

    # 驗證帳號格式 (僅限英數字與底線)
    if not all(c.isalnum() or c == '_' for c in account):
        return jsonify({'error': '帳號只能包含英文、數字及下底線'}), 400

    try:
        conn = get_db(DB_DOCTOR)
        exists = conn.execute('SELECT 1 FROM DOCTOR WHERE account_name = ?', (account,)).fetchone()
        if exists:
            conn.close()
            return jsonify({'error': '此帳號已存在'}), 400
        
        # 產生 8 碼隨機密碼
        generated_password = generate_random_password()
        hashed = hash_pw(generated_password)
        
        conn.execute(
            'INSERT INTO DOCTOR (account_name, password_hash, doctor_name, is_active, is_admin, specialty) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (account, hashed, name, active, admin, specialty)
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'password': generated_password})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/doctors/<account>', methods=['DELETE'])
@admin_required
def delete_doctor(account: str):
    account = account.strip()
    current_user = session.get('account')

    if account == current_user:
        return jsonify({'error': '無法刪除自己'}), 400

    try:
        # 檢查該醫師在 form.db 中是否已有病歷紀錄
        conn_f = get_db(DB_FORM)
        has_forms = conn_f.execute('SELECT 1 FROM FORM WHERE doctor_account = ?', (account,)).fetchone()
        conn_f.close()

        if has_forms:
            return jsonify({'error': '已看過病人，無法刪除'}), 400

        conn = get_db(DB_DOCTOR)
        exists = conn.execute('SELECT 1 FROM DOCTOR WHERE account_name = ?', (account,)).fetchone()
        if not exists:
            conn.close()
            return jsonify({'error': '找不到此帳號'}), 404

        conn.execute('DELETE FROM DOCTOR WHERE account_name = ?', (account,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/doctors/<account>', methods=['PUT'])
@admin_required
def update_doctor(account: str):
    data = request.get_json() or {}
    conn = get_db(DB_DOCTOR)
    row  = conn.execute('SELECT * FROM DOCTOR WHERE account_name = ?', (account,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': '找不到此帳號'}), 404

    new_doctor_name = data.get('doctor_name', row['doctor_name'])
    new_is_active   = int(data.get('is_active', row['is_active']))
    new_is_admin    = int(data.get('is_admin',  row['is_admin']))
    new_specialty   = data.get('specialty', row['specialty'])
    new_password    = data.get('new_password', '').strip()

    try:
        if new_password:
            conn.execute(
                'UPDATE DOCTOR SET doctor_name=?, is_active=?, is_admin=?, specialty=?, password_hash=? '
                'WHERE account_name=?',
                (new_doctor_name, new_is_active, new_is_admin, new_specialty, hash_pw(new_password), account)
            )
        else:
            conn.execute(
                'UPDATE DOCTOR SET doctor_name=?, is_active=?, is_admin=?, specialty=? WHERE account_name=?',
                (new_doctor_name, new_is_active, new_is_admin, new_specialty, account)
            )
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        conn.close()
        return jsonify({'error': str(e)}), 500


# ── Prompt 修改（管理員）────────────────────────────────────────────────────

@admin_bp.route('/api/prompt', methods=['GET'])
@admin_required
def get_prompt():
    try:
        content = ''
        if os.path.exists(PROMPT_FILE):
            for enc in ('utf-8', 'big5', 'cp950'):
                try:
                    with open(PROMPT_FILE, 'r', encoding=enc, errors='strict') as f:
                        content = f.read()
                    break
                except (UnicodeDecodeError, ValueError):
                    continue
            else:
                with open(PROMPT_FILE, 'r', encoding='latin-1') as f:
                    content = f.read()
        return jsonify({'content': content, 'path': PROMPT_FILE})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/prompt', methods=['POST'])
@admin_required
def save_prompt():
    data    = request.get_json() or {}
    content = data.get('content', '')
    try:
        os.makedirs(os.path.dirname(PROMPT_FILE), exist_ok=True)
        with open(PROMPT_FILE, 'w', encoding='utf-8') as f:
            f.write(content)
        return jsonify({
            'success':  True,
            'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'path':     PROMPT_FILE,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500