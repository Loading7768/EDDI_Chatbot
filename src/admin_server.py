from flask import Blueprint, request, render_template, jsonify, session, send_from_directory
import sqlite3
import hashlib
import json
import os
import re
import glob
from datetime import datetime
from functools import wraps

admin_bp = Blueprint('admin_bp', __name__)

# ── 路徑設定 ──────────────────────────────────────────────────────────────────
# admin_server.py 放在 src/，所以專案根目錄是上一層
SRC_DIR      = os.path.dirname(os.path.abspath(__file__))
BASE_DIR     = os.path.dirname(SRC_DIR)

WEBPAGE_DIR   = os.path.join(BASE_DIR, 'webpage')
PROMPTS_DIR   = os.path.join(BASE_DIR, 'assets', 'prompts')
CONFIG_FILE   = os.path.join(BASE_DIR, 'data', 'prompt_config.json')
STATS_CACHE   = os.path.join(BASE_DIR, 'data', 'stats_cache.json')
CHAT_LOGS_DIR = os.path.join(BASE_DIR, 'chat_logs')   # chat_logs/<MRN>/*.json
DISCHARGE_MD_DIR   = os.path.join(BASE_DIR, 'assets', 'discharge')
EDUCATION_FILE = os.path.join(DISCHARGE_MD_DIR, 'category.json')

DB_HOSPITAL = os.path.join(BASE_DIR, 'database', 'hospital.db')

import threading

DEPARTMENTS_FILE = os.path.join(BASE_DIR, 'data', 'departments.json')

education_lock = threading.Lock()

def load_departments() -> list:
    """讀取科別設定 JSON"""
    if not os.path.exists(DEPARTMENTS_FILE):
        initial = [
            {"name": "急診科", "is_active": True},
            {"name": "內科", "is_active": True},
            {"name": "小兒科", "is_active": True}
        ]
        os.makedirs(os.path.dirname(DEPARTMENTS_FILE), exist_ok=True)
        with open(DEPARTMENTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(initial, f, ensure_ascii=False, indent=4)
        return initial
    try:
        with open(DEPARTMENTS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"[Departments Load Error] {e}")
        return []

def save_departments(deps: list):
    """寫入科別設定 JSON"""
    try:
        os.makedirs(os.path.dirname(DEPARTMENTS_FILE), exist_ok=True)
        with open(DEPARTMENTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(deps, f, ensure_ascii=False, indent=4)
    except Exception as e:
        print(f"[Departments Save Error] {e}")

def load_education() -> dict:
    """讀取衛教資料 JSON，key 為類別，value 為衛教內容文字。
    相容舊格式（list of {topic_zh, topic_en, content}），讀取時會自動轉換並存回新格式。"""
    if not os.path.exists(EDUCATION_FILE):
        return {}
    try:
        with open(EDUCATION_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, list):
            converted = {}
            for item in data:
                key = (item.get('topic_zh') or item.get('topic_en') or '').strip()
                if key:
                    converted[key] = item.get('content', '')
            save_education(converted)
            return converted
        if isinstance(data, dict):
            return data
        return {}
    except Exception as e:
        print(f"[Education Load Error] {e}")
        return {}


def save_education(edu: dict):
    """寫入衛教資料 JSON"""
    try:
        os.makedirs(os.path.dirname(EDUCATION_FILE), exist_ok=True)
        with open(EDUCATION_FILE, 'w', encoding='utf-8') as f:
            json.dump(edu, f, ensure_ascii=False, indent=4)
    except Exception as e:
        print(f"[Education Save Error] {e}")
        
# ── helpers ──────────────────────────────────────────────────────────────────

def hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_HOSPITAL)
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
                label = f"進行中對話 ({parsed_start})" if parsed_start else "進行中對話"
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


# ── Prompt Versioning Helpers ──────────────────────────────────────────────────

def get_all_prompt_versions() -> list:
    versions = []
    if os.path.isdir(PROMPTS_DIR):
        files = glob.glob(os.path.join(PROMPTS_DIR, 'prompt_*.md'))
        for f in files:
            name = os.path.basename(f)
            try:
                num = int(name[7:-3])
                versions.append((num, name))
            except Exception:
                pass
    versions.sort(key=lambda x: x[0])
    return [x[1] for x in versions]

def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_config(cfg: dict):
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Config] 寫入失敗: {e}")


def get_current_prompt_info():
    """確保目錄、原始版本、以及設定檔存在，並回傳 (current_version_filename, content, has_prev, has_next, prev_version, next_version)"""
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    
    # 確保原始 prompt_001.md 存在
    p001 = os.path.join(PROMPTS_DIR, 'prompt_001.md')
    if not os.path.exists(p001):
        original_prompt_path = os.path.join(BASE_DIR, 'assets', 'prompt.md')
        if os.path.exists(original_prompt_path):
            import shutil
            shutil.copy(original_prompt_path, p001)
        else:
            # 建立預設原始檔
            with open(p001, 'w', encoding='utf-8') as f:
                f.write("你是一位專業的衛教助手。")
                
    # 讀取 config.json
    cfg = load_config()
    current_version = cfg.get('current_version', 'prompt_001.md')
            
    # 確保目前指向的檔案存在，否則降級回 prompt_001.md
    target_path = os.path.join(PROMPTS_DIR, current_version)
    if not os.path.exists(target_path):
        current_version = 'prompt_001.md'
        target_path = p001
        
    # 讀取內容
    content = ''
    try:
        with open(target_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"[Prompt] 讀取失敗 {current_version}: {e}")
        
    # 找出所有版本
    versions = get_all_prompt_versions()
    if current_version not in versions:
        versions.append(current_version)
        versions.sort(key=lambda x: int(x[7:-3]) if x.startswith('prompt_') and x.endswith('.md') else 0)
        
    idx = versions.index(current_version)
    
    has_prev = idx > 0
    has_next = idx < len(versions) - 1
    
    prev_version = versions[idx - 1] if has_prev else None
    next_version = versions[idx + 1] if has_next else None
    
    return current_version, content, has_prev, has_next, prev_version, next_version


# ── routes ────────────────────────────────────────────────────────────────────

@admin_bp.route('/main')
def index():
    return render_template('admin/html/admin.html')


@admin_bp.route('/main/css/<path:filename>')
def admin_css(filename):
    return send_from_directory(os.path.join(WEBPAGE_DIR, 'admin', 'css'), filename)


@admin_bp.route('/main/js/<path:filename>')
def admin_js(filename):
    return send_from_directory(os.path.join(WEBPAGE_DIR, 'admin', 'js'), filename)


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

    if not os.path.exists(DB_HOSPITAL):
        return jsonify({'success': False,
                        'error': '資料庫尚未初始化，請先執行 init_db.py'}), 500

    try:
        conn = get_db()
        row  = conn.execute(
            'SELECT * FROM doctors WHERE account_name = ? AND password_hash = ? AND is_active = 1',
            (account, hash_pw(password))
        ).fetchone()
        conn.close()
    except Exception as e:
        return jsonify({'success': False, 'error': f'資料庫錯誤：{e}'}), 500

    if not row:
        return jsonify({'success': False, 'error': '帳號或密碼錯誤，或帳號已停用'}), 401

    session.permanent = True
    session['account']       = row['account_name']
    session['doctor_name']   = row['doctor_name']
    session['is_admin']      = bool(row['is_admin'])

    return jsonify({
        'success':     True,
        'doctor_name': row['doctor_name'],
        'is_admin':    bool(row['is_admin']),
        'account':     row['account_name']
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
        conn = get_db()
        # LINE 好友總數以 line_accounts 表格的數量計算
        stats['total_friends'] = conn.execute('SELECT COUNT(*) FROM line_accounts').fetchone()[0]
        # 1. 病患總數改成查詢資料庫中 patients 的 medical_record_number 數量
        stats['total_patients'] = conn.execute('SELECT COUNT(medical_record_number) FROM patients').fetchone()[0]
        stats['total_forms'] = conn.execute('SELECT COUNT(*) FROM record').fetchone()[0]
        
        # 2. LINE bot 使用率改成 patients 中 has_chatted == 1 的數量 / 病患總數
        patients_chatted = conn.execute('SELECT COUNT(*) FROM patients WHERE has_chatted = 1').fetchone()[0]
        total_p = stats['total_patients']
        stats['patients_chatted'] = patients_chatted
        stats['bot_usage_rate']   = round(patients_chatted / total_p * 100, 1) if total_p > 0 else 0.0
        
        conn.close()
    except Exception as e:
        print(f'[stats] 讀取失敗: {e}')
        stats['total_friends'] = 0
        stats['total_patients'] = 0
        stats['total_forms']    = 0
        stats['patients_chatted'] = 0
        stats['bot_usage_rate']   = 0.0

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
        conn = get_db()

        # 就診紀錄中都只需要顯示日期就好，不需要顯示時間，因此最新就診日期使用 strftime('%Y-%m-%d')
        if is_admin:
            rows = conn.execute('''
                SELECT 
                    p.medical_record_number AS medical_record_num,
                    MIN(la.uuid) AS line_id,
                    MIN(lpp.relation) AS relation,
                    COUNT(r.record_id) AS form_count,
                    MAX(strftime('%Y-%m-%d', r.checkout_date)) AS latest_checkout,
                    MIN(p.status) AS status
                FROM record r
                JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
                JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
                JOIN patients p ON lpp.patient_id = p.patient_id
                GROUP BY p.medical_record_number
                ORDER BY latest_checkout DESC
            ''').fetchall()
        else:
            rows = conn.execute('''
                SELECT 
                    p.medical_record_number AS medical_record_num,
                    MIN(la.uuid) AS line_id,
                    MIN(lpp.relation) AS relation,
                    COUNT(r.record_id) AS form_count,
                    MAX(strftime('%Y-%m-%d', r.checkout_date)) AS latest_checkout,
                    MIN(p.status) AS status
                FROM record r
                JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
                JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
                JOIN patients p ON lpp.patient_id = p.patient_id
                JOIN doctors d ON r.doctor_id = d.doctor_id
                WHERE d.account_name = ?
                GROUP BY p.medical_record_number
                ORDER BY latest_checkout DESC
            ''', (account,)).fetchall()

        result = []
        for row in rows:
            mrn = row['medical_record_num']
            
            # 取得最新的一筆看診紀錄當次的看診醫師專科/科別
            latest_doc = conn.execute('''
                SELECT d.department AS specialty
                FROM record r
                JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
                JOIN patients p ON lpp.patient_id = p.patient_id
                JOIN doctors d ON r.doctor_id = d.doctor_id
                WHERE p.medical_record_number = ?
                ORDER BY r.checkout_date DESC LIMIT 1
            ''', (mrn,)).fetchone()

            # 取得該病患看過的所有科別
            doc_specialties = conn.execute('''
                SELECT DISTINCT d.department AS specialty
                FROM record r
                JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
                JOIN patients p ON lpp.patient_id = p.patient_id
                JOIN doctors d ON r.doctor_id = d.doctor_id
                WHERE p.medical_record_number = ?
            ''', (mrn,)).fetchall()
            specialties = [x['specialty'] for x in doc_specialties if x['specialty']]

            chat_stats = get_chat_stats_for_mrn(mrn)
            
            specialty = latest_doc['specialty'] if latest_doc else '急診科'

            result.append({
                'medical_record_num': mrn,
                'line_id':            row['line_id'],
                'relation':           row['relation'],
                'form_count':         row['form_count'],
                'msg_count':          chat_stats['msg_count'],
                'has_logs':           chat_stats['msg_count'] > 0,
                'last_chat':          chat_stats['last_chat'],
                'latest_checkout':    row['latest_checkout'],
                'specialty':          specialty,
                'specialties':        specialties,
                'status':             row['status'],
                'needs_return_visit': row['status'] == '須回診',
            })

        conn.close()
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify(result)


# ── 單一病患詳情 ──────────────────────────────────────────────────────────────

@admin_bp.route('/api/chats/<mrn>')
@login_required
def get_chat_detail(mrn: str):
    account  = session['account']
    is_admin = session['is_admin']

    conn = get_db()

    if not is_admin:
        allowed = conn.execute('''
            SELECT 1 
            FROM record r
            JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
            JOIN patients p ON lpp.patient_id = p.patient_id
            JOIN doctors d ON r.doctor_id = d.doctor_id
            WHERE p.medical_record_number = ? AND d.account_name = ?
            LIMIT 1
        ''', (mrn, account)).fetchone()
        if not allowed:
            conn.close()
            return jsonify({'error': '無查看權限'}), 403

    patient = conn.execute('''
        SELECT p.medical_record_number, MIN(la.uuid) AS line_uuid, MIN(lpp.relation) AS relation, MIN(p.status) AS status
        FROM patients p
        LEFT JOIN line_patient_pairs lpp ON p.patient_id = lpp.patient_id
        LEFT JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
        WHERE p.medical_record_number = ?
        GROUP BY p.medical_record_number
    ''', (mrn,)).fetchone()
    
    if not patient:
        conn.close()
        return jsonify({'error': '找不到此病患'}), 404

    # 更改：在修改表單時需要完整的時間（含毫秒），因此不使用 strftime('%Y-%m-%d')
    forms = conn.execute('''
        SELECT 
            p.medical_record_number AS medical_record_num,
            d.account_name AS doctor_account,
            d.department AS specialty,
            r.checkout_date AS checkout_date,
            r.symptoms AS symptoms,
            p.has_chatted AS is_chatted,
            la.line_account_id AS line_account_id,
            la.name AS line_name,
            lpp.relation AS relation
        FROM record r
        JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
        JOIN patients p ON lpp.patient_id = p.patient_id
        JOIN doctors d ON r.doctor_id = d.doctor_id
        LEFT JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
        WHERE p.medical_record_number = ?
        ORDER BY r.checkout_date ASC
    ''', (mrn,)).fetchall()
    conn.close()

    # 從 JSON 檔讀取聊天訊息（分開成多個 sessions）
    sessions_list = load_sessions_for_mrn(mrn)

    forms_list = [
        {
            'medical_record_num': r['medical_record_num'],
            'doctor_account':     r['doctor_account'],
            'specialty':          r['specialty'] if r['specialty'] else '急診科',
            'checkout_date':      r['checkout_date'],
            'symptoms':           json.loads(r['symptoms']) if r['symptoms'] else [],
            'is_chatted':         bool(r['is_chatted']),
            'line_account_id':    r['line_account_id'],
            'line_name':          r['line_name'],
            'relation':           r['relation'],
        }
        for r in forms
    ]

    return jsonify({
        'patient': {
            'medical_record_num': patient['medical_record_number'],
            'line_id':            patient['line_uuid'],
            'relation':           patient['relation'] if patient['relation'] else '帳號本人',
            'status':             patient['status'],
            'needs_return_visit': patient['status'] == '須回診'
        },
        'forms':    forms_list,
        'sessions': sessions_list,
    })


# ── 修改表單 ──────────────────────────────────────────────────────────────────

@admin_bp.route('/api/forms/get_line_accounts', methods=['GET'])
@login_required
def get_line_accounts():
    account = session['account']
    conn = get_db()
    try:
        doctor_row = conn.execute(
            'SELECT doctor_id FROM doctors WHERE account_name = ? LIMIT 1', (account,)
        ).fetchone()
        doctor_id = doctor_row['doctor_id'] if doctor_row else 0

        # Read recent line accounts cache if exists
        recent_ids = []
        if doctor_id:
            cache_path = os.path.join(BASE_DIR, 'drafts', f'D{doctor_id:07d}', '.recent_line_accounts.json')
            if os.path.exists(cache_path):
                try:
                    with open(cache_path, 'r', encoding='utf-8') as f:
                        recent_ids = json.load(f)
                except Exception:
                    recent_ids = []

        rows = conn.execute(
            'SELECT line_account_id, name FROM line_accounts ORDER BY name'
        ).fetchall()
        accounts = [{'id': r['line_account_id'], 'name': r['name']} for r in rows]

        return jsonify({
            'accounts': accounts,
            'recent_ids': recent_ids if isinstance(recent_ids, list) else []
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@admin_bp.route('/api/forms/doctor_drafts', methods=['GET'])
@login_required
def get_doctor_drafts():
    account = session['account']
    conn = get_db()
    try:
        doctor_row = conn.execute(
            'SELECT doctor_id FROM doctors WHERE account_name = ? LIMIT 1', (account,)
        ).fetchone()
        if not doctor_row:
            return jsonify({'error': '找不到醫師帳號'}), 404
        doctor_id = doctor_row['doctor_id']

        draft_dir = os.path.join(BASE_DIR, 'drafts', f'D{doctor_id:07d}')
        drafts = []
        if os.path.exists(draft_dir):
            for filename in sorted(os.listdir(draft_dir), reverse=True):
                if not filename.endswith('.json') or filename in ('.recent_line_accounts.json', 'placeholder.json'):
                    continue
                name_part = filename[:-5]
                parts = name_part.split('_')
                mrn = parts[0] if parts else name_part
                raw_date = parts[1] if len(parts) > 1 else ''
                if len(raw_date) == 8 and raw_date.isdigit():
                    formatted_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
                else:
                    formatted_date = raw_date or '-'

                drafts.append({
                    'filename': filename,
                    'mrn': mrn,
                    'date': formatted_date
                })

        return jsonify({'drafts': drafts})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@admin_bp.route('/api/forms/doctor_draft/<filename>', methods=['GET'])
@login_required
def get_doctor_draft_detail(filename):
    account = session['account']
    conn = get_db()
    try:
        doctor_row = conn.execute(
            'SELECT doctor_id FROM doctors WHERE account_name = ? LIMIT 1', (account,)
        ).fetchone()
        if not doctor_row:
            return jsonify({'error': '找不到醫師帳號'}), 404
        doctor_id = doctor_row['doctor_id']

        # Prevent directory traversal
        safe_filename = os.path.basename(filename)
        draft_path = os.path.join(BASE_DIR, 'drafts', f'D{doctor_id:07d}', safe_filename)
        if not os.path.exists(draft_path):
            return jsonify({'error': '找不到草稿檔案'}), 404

        with open(draft_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        return jsonify({'success': True, 'data': data, 'filename': safe_filename})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@admin_bp.route('/api/forms/doctor_draft/<filename>', methods=['DELETE'])
@login_required
def delete_doctor_draft(filename):
    account = session['account']
    conn = get_db()
    try:
        doctor_row = conn.execute(
            'SELECT doctor_id FROM doctors WHERE account_name = ? LIMIT 1', (account,)
        ).fetchone()
        if not doctor_row:
            return jsonify({'error': '找不到醫師帳號'}), 404
        doctor_id = doctor_row['doctor_id']

        safe_filename = os.path.basename(filename)
        draft_path = os.path.join(BASE_DIR, 'drafts', f'D{doctor_id:07d}', safe_filename)
        if os.path.exists(draft_path):
            os.remove(draft_path)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@admin_bp.route('/api/forms/doctor_submit', methods=['POST'])
@login_required
def doctor_submit():
    data = request.get_json() or {}
    filename = data.get('filename')
    symptoms = data.get('symptoms', [])

    if not filename:
        return jsonify({'error': 'filename required'}), 400

    account = session['account']
    conn = get_db()
    try:
        conn.execute('PRAGMA foreign_keys = ON')

        doctor_row = conn.execute(
            'SELECT doctor_id FROM doctors WHERE account_name = ? LIMIT 1', (account,)
        ).fetchone()
        if not doctor_row:
            return jsonify({'error': '找不到醫師帳號'}), 404
        doctor_id = doctor_row['doctor_id']

        safe_filename = os.path.basename(filename)
        draft_path = os.path.join(BASE_DIR, 'drafts', f'D{doctor_id:07d}', safe_filename)

        # Read draft data if line_patient_pair_id / checkout_date not passed
        lpp_id = data.get('line_patient_pair_id')
        checkout_date = data.get('checkout_date')

        if not lpp_id or not checkout_date:
            if not os.path.exists(draft_path):
                return jsonify({'error': '草稿檔案不存在'}), 404
            with open(draft_path, 'r', encoding='utf-8') as f:
                draft_content = json.load(f)
            lpp_id = lpp_id or draft_content.get('line_patient_pair_id')
            checkout_date = checkout_date or draft_content.get('checkout_date')

        if not lpp_id or not checkout_date:
            return jsonify({'error': '無法取得完整出院單資訊'}), 400

        # Execute DB transaction
        symptoms_json = json.dumps(symptoms, ensure_ascii=False)
        conn.execute('''
            INSERT INTO record (line_patient_pairs_id, checkout_date, doctor_id, symptoms)
            VALUES (?, ?, ?, ?)
        ''', (lpp_id, checkout_date, doctor_id, symptoms_json))

        # Delete draft JSON file on success
        if os.path.exists(draft_path):
            os.remove(draft_path)

        conn.commit()
        return jsonify({'success': True})

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@admin_bp.route('/api/forms/get_existing_relations', methods=['GET'])
@login_required
def get_existing_relations():
    line_account_id = request.args.get('line_account_id', type=int)
    if not line_account_id:
        return jsonify({'error': 'line_account_id required'}), 400
    conn = get_db()
    try:
        rows = conn.execute('''
            SELECT lpp.line_patient_pairs_id, lpp.relation, p.medical_record_number
            FROM line_patient_pairs lpp
            JOIN patients p ON lpp.patient_id = p.patient_id
            WHERE lpp.line_account_id = ?
            ORDER BY lpp.relation
        ''', (line_account_id,)).fetchall()
        return jsonify([{
            'pair_id':  r['line_patient_pairs_id'],
            'relation': r['relation'] or '帳號本人',
            'mrn':      r['medical_record_number']
        } for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()



@admin_bp.route('/api/forms/nurse_create', methods=['POST'])
@login_required
def nurse_create():
    data           = request.get_json() or {}
    line_account_id = data.get('line_account_id')
    pair_id        = data.get('pair_id')        # 'self', 'new', or existing int
    relation       = (data.get('relation') or '').strip()
    mrn            = (data.get('mrn') or '').strip()

    if not line_account_id:
        return jsonify({'error': 'line_account_id required'}), 400

    account = session['account']
    conn = get_db()
    try:
        conn.execute('PRAGMA foreign_keys = ON')

        # 1. Resolve doctor_id and doctor_name from session account
        doctor_row = conn.execute(
            'SELECT doctor_id, doctor_name FROM doctors WHERE account_name = ? LIMIT 1', (account,)
        ).fetchone()
        if not doctor_row:
            return jsonify({'error': '找不到醫師帳號'}), 404
        doctor_id   = doctor_row['doctor_id']
        doctor_name = doctor_row['doctor_name'] or ''

        # Resolve line_name from line_accounts
        line_acc_row = conn.execute(
            'SELECT name FROM line_accounts WHERE line_account_id = ? LIMIT 1', (line_account_id,)
        ).fetchone()
        line_name = line_acc_row['name'] if line_acc_row else ''

        # 2. If existing pair (int pair_id) → skip upsert, just get lpp_id, mrn, relation
        if pair_id not in ('self', 'new'):
            try:
                lpp_id = int(pair_id)
            except (TypeError, ValueError):
                return jsonify({'error': 'invalid pair_id'}), 400
            # Verify lpp belongs to this line_account_id and fetch mrn and relation
            lpp_row = conn.execute('''
                SELECT lpp.line_patient_pairs_id, lpp.relation, p.medical_record_number
                FROM line_patient_pairs lpp
                JOIN patients p ON lpp.patient_id = p.patient_id
                WHERE lpp.line_patient_pairs_id = ? AND lpp.line_account_id = ?
            ''', (lpp_id, line_account_id)).fetchone()
            if not lpp_row:
                return jsonify({'error': '病患配對不存在'}), 404
            if not mrn:
                mrn = lpp_row['medical_record_number']
            if not relation:
                relation = lpp_row['relation'] or '帳號本人'
        else:
            # Validate inputs
            if not mrn:
                return jsonify({'error': '病歷號不可為空'}), 400
            if pair_id == 'new' and not relation:
                return jsonify({'error': '關係不可為空'}), 400
            if pair_id == 'self':
                relation = '帳號本人'

            # 2a. Upsert patient by MRN
            existing_patient = conn.execute(
                'SELECT patient_id FROM patients WHERE medical_record_number = ?', (mrn,)
            ).fetchone()
            if existing_patient:
                patient_id = existing_patient['patient_id']
            else:
                conn.execute(
                    'INSERT INTO patients (medical_record_number) VALUES (?)', (mrn,)
                )
                patient_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]

            # 2b. Upsert line_patient_pairs
            existing_pair = conn.execute(
                'SELECT line_patient_pairs_id FROM line_patient_pairs WHERE line_account_id = ? AND patient_id = ?',
                (line_account_id, patient_id)
            ).fetchone()
            if existing_pair:
                lpp_id = existing_pair['line_patient_pairs_id']
            else:
                conn.execute(
                    'INSERT INTO line_patient_pairs (patient_id, line_account_id, relation) VALUES (?, ?, ?)',
                    (patient_id, line_account_id, relation)
                )
                lpp_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]

        # 3. Save draft JSON file
        now = datetime.now()
        date_str_ymd = now.strftime('%Y%m%d')
        datetime_str = now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}'
        draft_dir  = os.path.join(BASE_DIR, 'drafts', f'D{doctor_id:07d}')
        draft_path = os.path.join(draft_dir, f'{mrn}_{date_str_ymd}.json')
        draft_data = {
            'checkout_date':       datetime_str,
            'doctor_id':           doctor_id,
            'line_patient_pair_id': lpp_id,
            'symptoms':            [],
            'doctor_name':         doctor_name,
            'line_name':           line_name,
            'relation':            relation,
            'mrc':                 mrn
        }

        try:
            os.makedirs(draft_dir, exist_ok=True)
            with open(draft_path, 'w', encoding='utf-8') as f:
                json.dump(draft_data, f, ensure_ascii=False, indent=4)
        except Exception as file_err:
            # File write failed — rollback DB and report error
            conn.rollback()
            return jsonify({'error': f'草稿檔案儲存失敗：{file_err}'}), 500

        # Update recent line accounts stack (max=4, no duplicates) in drafts/D{doctor_id:07d}/.recent_line_accounts.json
        try:
            cache_path = os.path.join(draft_dir, '.recent_line_accounts.json')
            recent_ids = []
            if os.path.exists(cache_path):
                try:
                    with open(cache_path, 'r', encoding='utf-8') as f:
                        recent_ids = json.load(f)
                    if not isinstance(recent_ids, list):
                        recent_ids = []
                except Exception:
                    recent_ids = []
            # Push line_account_id to top, remove dupes, max 4
            recent_ids = [line_account_id] + [x for x in recent_ids if x != line_account_id]
            recent_ids = recent_ids[:4]
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(recent_ids, f, ensure_ascii=False, indent=2)
        except Exception as cache_err:
            print(f"[Recent LINE Accounts Cache Error] {cache_err}")

        conn.commit()
        return jsonify({'success': True, 'lpp_id': lpp_id, 'draft_path': draft_path})

    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()



@admin_bp.route('/api/forms/<mrn>/<checkout_date>', methods=['PUT'])
@login_required
def update_form(mrn: str, checkout_date: str):
    account  = session['account']
    is_admin = session['is_admin']

    conn = get_db()
    
    try:
        # 1. 精確比對 checkout_date，確保要修改的表單存在
        row = conn.execute('''
            SELECT r.record_id, r.symptoms, r.doctor_id, r.checkout_date
            FROM record r
            JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
            JOIN patients p ON lpp.patient_id = p.patient_id
            WHERE p.medical_record_number = ? AND r.checkout_date = ?
            LIMIT 1
        ''', (mrn, checkout_date)).fetchone()
        
        if not row:
            conn.close()
            return jsonify({'error': '找不到此表單'}), 404

        record_id = row['record_id']

        # 2. 權限檢查：非管理員只能修改自己看診的表單
        if not is_admin:
            allowed = conn.execute('''
                SELECT 1 
                FROM record r
                JOIN doctors d ON r.doctor_id = d.doctor_id
                WHERE r.record_id = ? AND d.account_name = ?
                LIMIT 1
            ''', (record_id, account)).fetchone()
            if not allowed:
                conn.close()
                return jsonify({'error': '無修改權限'}), 403

        data         = request.get_json() or {}
        new_mrn      = data.get('medical_record_num')
        new_relation = data.get('relation')

        # 獲取原始的配對與病患資料
        current_pair = conn.execute('''
            SELECT la.uuid AS line_uuid, lpp.relation, p.medical_record_number, lpp.patient_id
            FROM line_patient_pairs lpp
            JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
            JOIN record r ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
            JOIN patients p ON lpp.patient_id = p.patient_id
            WHERE r.record_id = ?
        ''', (record_id,)).fetchone()

        if not current_pair:
            conn.close()
            return jsonify({'error': '無法取得目前病患的 LINE 帳號配對資訊'}), 400

        original_mrn = current_pair['medical_record_number']
        original_relation = current_pair['relation']
        original_patient_id = current_pair['patient_id']

        # 預設為原配對 ID
        final_pair_id = conn.execute('SELECT line_patient_pairs_id FROM record WHERE record_id = ?', (record_id,)).fetchone()[0]

        # 4. 修改病歷號與關係
        mrn_changed = new_mrn and new_mrn.strip() != original_mrn
        relation_changed = new_relation is not None and new_relation.strip() != original_relation

        # 關係修改不需要管理員權限即可修改，但修改病歷號必須是管理員
        if mrn_changed and not is_admin:
            conn.close()
            return jsonify({'error': '修改病歷號僅限管理員權限。'}), 403

        if mrn_changed:
            new_mrn_str = new_mrn.strip()
            # 檢查新病歷號是否已存在
            conflict = conn.execute('SELECT 1 FROM patients WHERE medical_record_number = ? AND patient_id != ?', (new_mrn_str, original_patient_id)).fetchone()
            if conflict:
                conn.close()
                return jsonify({'error': '該病歷號已存在於系統中，無法修改為此號碼。'}), 400
            
            # 更新資料庫 patients 表
            conn.execute('UPDATE patients SET medical_record_number = ? WHERE patient_id = ?', (new_mrn_str, original_patient_id))
            
            # 搬移對話紀錄資料夾
            old_log_dir = os.path.join(CHAT_LOGS_DIR, original_mrn)
            new_log_dir = os.path.join(CHAT_LOGS_DIR, new_mrn_str)
            if os.path.isdir(old_log_dir) and old_log_dir != new_log_dir:
                try:
                    os.rename(old_log_dir, new_log_dir)
                    # 更新所有 JSON 檔案 metadata 的病歷號
                    for filepath in glob.glob(os.path.join(new_log_dir, '*.json')):
                        try:
                            with open(filepath, 'r+', encoding='utf-8') as f:
                                file_data = json.load(f)
                                if 'metadata' in file_data:
                                    file_data['metadata']['medical_record_num'] = new_mrn_str
                                    f.seek(0)
                                    json.dump(file_data, f, ensure_ascii=False, indent=4)
                                    f.truncate()
                        except Exception as je:
                            print(f"[Update JSON Metadata Error] Failed to update {os.path.basename(filepath)}: {je}")
                except Exception as re:
                    print(f"[Rename Directory Error] {re}")

        if relation_changed:
            new_rel_str = new_relation.strip()
            conn.execute('UPDATE line_patient_pairs SET relation = ? WHERE line_patient_pairs_id = ?', (new_rel_str, final_pair_id))

        # 6. 症狀更新
        symptoms_raw = data.get('symptoms', None)
        if symptoms_raw is not None:
            if isinstance(symptoms_raw, list):
                new_symptoms = json.dumps(symptoms_raw, ensure_ascii=False)
            else:
                parts = [s.strip() for s in str(symptoms_raw).split(',') if s.strip()]
                new_symptoms = json.dumps(parts, ensure_ascii=False)
        else:
            new_symptoms = row['symptoms']

        # 7. 更新 record 內容 (就診日期與醫師設為唯讀，不進行更新)
        conn.execute('''
            UPDATE record 
            SET symptoms = ? 
            WHERE record_id = ?
        ''', (new_symptoms, record_id))

        # 提交事務
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')})

    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': f'修改表單時發生資料庫錯誤: {str(e)}'}), 500


@admin_bp.route('/api/forms/view_edit', methods=['PUT'])
@login_required
def view_edit_form():
    data = request.get_json() or {}
    mrn = data.get('mrn')
    checkout_date = data.get('checkout_date')
    symptoms = data.get('symptoms', [])
    is_admin = session.get('is_admin', False)
    account = session.get('account')

    if not mrn or not checkout_date:
        return jsonify({'error': '缺少必要參數'}), 400

    conn = get_db()
    try:
        conn.execute('PRAGMA foreign_keys = ON')

        # ── Full update (LINE + patient + symptoms) for all users ──
        line_account_id = data.get('line_account_id')
        pair_id = data.get('pair_id')
        relation = (data.get('relation') or '').strip()
        new_mrn = (data.get('new_mrn') or '').strip()

        if not line_account_id or not pair_id:
            return jsonify({'error': '缺少必要參數'}), 400

        # 1. 尋找原紀錄
        row = conn.execute('''
            SELECT r.record_id
            FROM record r
            JOIN line_patient_pairs lpp ON r.line_patient_pairs_id = lpp.line_patient_pairs_id
            JOIN patients p ON lpp.patient_id = p.patient_id
            WHERE p.medical_record_number = ? AND r.checkout_date = ?
            LIMIT 1
        ''', (mrn, checkout_date)).fetchone()

        if not row:
            conn.close()
            return jsonify({'error': '找不到此表單紀錄'}), 404

        record_id = row['record_id']

        # 2. 處理病患配對與病歷號
        final_lpp_id = None
        if pair_id not in ('self', 'new'):
            try:
                lpp_id = int(pair_id)
            except (TypeError, ValueError):
                return jsonify({'error': '無效的配對 ID'}), 400

            lpp_row = conn.execute('''
                SELECT line_patient_pairs_id FROM line_patient_pairs
                WHERE line_patient_pairs_id = ? AND line_account_id = ?
            ''', (lpp_id, line_account_id)).fetchone()
            if not lpp_row:
                return jsonify({'error': '該 LINE 帳號下找不到此病患配對'}), 404
            final_lpp_id = lpp_id
        else:
            if not new_mrn:
                return jsonify({'error': '病歷號不可為空'}), 400
            if pair_id == 'new' and not relation:
                return jsonify({'error': '關係不可為空'}), 400
            if pair_id == 'self':
                relation = '帳號本人'

            # 2a. Upsert patient
            existing_patient = conn.execute(
                'SELECT patient_id FROM patients WHERE medical_record_number = ?', (new_mrn,)
            ).fetchone()
            if existing_patient:
                patient_id = existing_patient['patient_id']
            else:
                conn.execute(
                    'INSERT INTO patients (medical_record_number) VALUES (?)', (new_mrn,)
                )
                patient_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]

            # 2b. Upsert line_patient_pairs
            existing_pair = conn.execute(
                'SELECT line_patient_pairs_id FROM line_patient_pairs WHERE line_account_id = ? AND patient_id = ?',
                (line_account_id, patient_id)
            ).fetchone()
            if existing_pair:
                final_lpp_id = existing_pair['line_patient_pairs_id']
                conn.execute(
                    'UPDATE line_patient_pairs SET relation = ? WHERE line_patient_pairs_id = ?',
                    (relation, final_lpp_id)
                )
            else:
                conn.execute(
                    'INSERT INTO line_patient_pairs (patient_id, line_account_id, relation) VALUES (?, ?, ?)',
                    (patient_id, line_account_id, relation)
                )
                final_lpp_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]

        # 3. 更新 record 內容
        symptoms_json = json.dumps(symptoms, ensure_ascii=False)
        conn.execute('''
            UPDATE record
            SET line_patient_pairs_id = ?, symptoms = ?
            WHERE record_id = ?
        ''', (final_lpp_id, symptoms_json, record_id))

        conn.commit()
        conn.close()
        return jsonify({'success': True})

    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': f'資料庫事務失敗: {str(e)}'}), 500



# ── 醫師帳號管理（管理員）────────────────────────────────────────────────────


import secrets
import string

def generate_random_password(length=8) -> str:
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


@admin_bp.route('/api/doctors', methods=['GET'])
@login_required
def list_doctors():
    try:
        conn = get_db()
        # 1. 查詢 record，取得所有已有病歷紀錄的醫師 id
        active_ids = {r['doctor_id'] for r in conn.execute(
            'SELECT DISTINCT doctor_id FROM record'
        ).fetchall()}

        # 2. 查詢 doctors，取得所有醫師資料
        rows = conn.execute(
            'SELECT doctor_id, account_name, doctor_name, is_active, is_admin, department AS specialty FROM doctors '
            'ORDER BY is_admin DESC, account_name'
        ).fetchall()
        conn.close()

        result = []
        for row in rows:
            d = dict(row)
            # 不能刪除自己，且如果醫師已看診，則無法刪除
            d['can_delete'] = (d['doctor_id'] not in active_ids) and (d['account_name'] != session.get('account'))
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
        conn = get_db()
        exists = conn.execute('SELECT 1 FROM doctors WHERE account_name = ?', (account,)).fetchone()
        if exists:
            conn.close()
            return jsonify({'error': '此帳號已存在'}), 400
        
        # 產生 8 碼隨機密碼
        generated_password = generate_random_password()
        hashed = hash_pw(generated_password)
        
        conn.execute(
            'INSERT INTO doctors (account_name, password_hash, doctor_name, is_active, is_admin, department) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (account, hashed, name, active, admin, specialty)
        )
        conn.commit()
        
        # 同步更新科別 JSON
        deps = load_departments()
        found = False
        for d in deps:
            if d['name'] == specialty:
                d['is_active'] = True  # 確保啟用
                found = True
                break
        if not found:
            deps.append({"name": specialty, "is_active": True})
        save_departments(deps)

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
        conn = get_db()
        # 檢查該醫師在 record 中是否已有病歷紀錄
        has_forms = conn.execute('''
            SELECT 1 
            FROM record r
            JOIN doctors d ON r.doctor_id = d.doctor_id
            WHERE d.account_name = ?
            LIMIT 1
        ''', (account,)).fetchone()

        if has_forms:
            conn.close()
            return jsonify({'error': '已看過病人，無法刪除'}), 400

        exists = conn.execute('SELECT 1 FROM doctors WHERE account_name = ?', (account,)).fetchone()
        if not exists:
            conn.close()
            return jsonify({'error': '找不到此帳號'}), 404

        conn.execute('DELETE FROM doctors WHERE account_name = ?', (account,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/doctors/<account>', methods=['PUT'])
@admin_required
def update_doctor(account: str):
    data = request.get_json() or {}
    conn = get_db()
    row  = conn.execute('SELECT * FROM doctors WHERE account_name = ?', (account,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': '找不到此帳號'}), 404

    new_doctor_name = data.get('doctor_name', row['doctor_name'])
    new_is_active   = int(data.get('is_active', row['is_active']))
    new_is_admin    = int(data.get('is_admin',  row['is_admin']))
    new_specialty   = data.get('specialty', row['department'])
    new_password    = data.get('new_password', '').strip()

    # 檢查若管理員欲將自己改成一般醫師，系統是否仍有其他管理員帳號
    current_admin = session.get('account')
    if account == current_admin and new_is_admin == 0:
        other_admin_exists = conn.execute(
            'SELECT 1 FROM doctors WHERE is_admin = 1 AND account_name != ? LIMIT 1',
            (account,)
        ).fetchone()
        if not other_admin_exists:
            conn.close()
            return jsonify({'error': '無法修改角色：系統必須保留至少一位管理員，無法將自己修改為一般醫師'}), 400

    try:
        if new_password:
            conn.execute(
                'UPDATE doctors SET doctor_name=?, is_active=?, is_admin=?, department=?, password_hash=? '
                'WHERE account_name=?',
                (new_doctor_name, new_is_active, new_is_admin, new_specialty, hash_pw(new_password), account)
            )
        else:
            conn.execute(
                'UPDATE doctors SET doctor_name=?, is_active=?, is_admin=?, department=? WHERE account_name=?',
                (new_doctor_name, new_is_active, new_is_admin, new_specialty, account)
            )
        conn.commit()
        
        # 同步更新科別 JSON
        deps = load_departments()
        found = False
        for d in deps:
            if d['name'] == new_specialty:
                d['is_active'] = True  # 確保啟用
                found = True
                break
        if not found:
            deps.append({"name": new_specialty, "is_active": True})
        save_departments(deps)

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
        # Get active version info
        active_version, active_content, has_prev_act, has_next_act, prev_act, next_act = get_current_prompt_info()
        
        # Determine which version to view/edit
        view_version = request.args.get('version', '').strip()
        if not view_version:
            view_version = active_version
            
        target_path = os.path.join(PROMPTS_DIR, view_version)
        if not os.path.exists(target_path):
            view_version = active_version
            target_path = os.path.join(PROMPTS_DIR, active_version)
            
        with open(target_path, 'r', encoding='utf-8') as f:
            view_content = f.read()
            
        # Compute version navigation metrics for the view_version
        versions = get_all_prompt_versions()
        if view_version not in versions:
            versions.append(view_version)
            versions.sort(key=lambda x: int(x[7:-3]) if x.startswith('prompt_') and x.endswith('.md') else 0)
            
        idx = versions.index(view_version)
        has_prev = idx > 0
        has_next = idx < len(versions) - 1
        prev_version = versions[idx - 1] if has_prev else None
        next_version = versions[idx + 1] if has_next else None
        
        cfg = load_config()
        nicknames = cfg.get('nicknames', {})
        
        return jsonify({
            'content': view_content,
            'current_version': view_version,
            'active_version': active_version,
            'active_content': active_content,
            'has_prev': has_prev,
            'has_next': has_next,
            'prev_version': prev_version,
            'next_version': next_version,
            'versions': versions,
            'nicknames': nicknames
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/prompt', methods=['POST'])
@admin_required
def save_prompt():
    data    = request.get_json() or {}
    content = data.get('content', '')
    try:
        # 尋找下一個可用的版本號
        files = glob.glob(os.path.join(PROMPTS_DIR, 'prompt_*.md'))
        max_num = 1
        for f in files:
            name = os.path.basename(f)
            try:
                num = int(name[7:-3])
                if num > max_num:
                    max_num = num
            except Exception:
                pass
                
        next_version = f"prompt_{max_num + 1:03d}.md"
        next_path = os.path.join(PROMPTS_DIR, next_version)
        
        # 寫入新版本
        with open(next_path, 'w', encoding='utf-8') as f:
            f.write(content)
            
        return jsonify({
            'success':  True,
            'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'version':  next_version,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/prompt/rollback', methods=['POST'])
@admin_required
def rollback_prompt():
    try:
        current_version, _, has_prev, has_next, prev_version, next_version = get_current_prompt_info()
        if not has_prev or not prev_version:
            return jsonify({'error': '找不到上一個版本的 Prompt 備份或已是原始版本'}), 404
            
        # 更新 config 檔 (不用真的把當前的版本刪除)
        cfg = load_config()
        cfg['current_version'] = prev_version
        save_config(cfg)
            
        # 同步至 assets/prompt.md
        original_prompt_path = os.path.join(BASE_DIR, 'assets', 'prompt.md')
        import shutil
        shutil.copy(os.path.join(PROMPTS_DIR, prev_version), original_prompt_path)
            
        return jsonify({
            'success': True,
            'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'version': prev_version
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/prompt/switch', methods=['POST'])
@admin_required
def switch_prompt():
    data = request.get_json() or {}
    version = data.get('version', '').strip()
    if not version:
        return jsonify({'error': '請指定版本'}), 400
    
    target_path = os.path.join(PROMPTS_DIR, version)
    if not os.path.exists(target_path):
        return jsonify({'error': f'版本 {version} 不存在'}), 404
        
    try:
        # 1. 更新 active 設定檔
        cfg = load_config()
        cfg['current_version'] = version
        save_config(cfg)
            
        # 2. 同步至 assets/prompt.md
        original_prompt_path = os.path.join(BASE_DIR, 'assets', 'prompt.md')
        import shutil
        shutil.copy(target_path, original_prompt_path)
        
        return jsonify({
            'success': True,
            'version': version,
            'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/prompt/delete', methods=['POST'])
@admin_required
def delete_prompt():
    data = request.get_json() or {}
    version = data.get('version', '').strip()
    
    active_version, *_ = get_current_prompt_info()
    if not version:
        version = active_version
        
    if version == 'prompt_001.md' or version == 'prompt.md':
        return jsonify({'error': '不可刪除原始版本'}), 400
        
    versions = get_all_prompt_versions()
    if version not in versions:
        return jsonify({'error': '找不到指定的版本'}), 404
        
    try:
        idx = versions.index(version)
        # 決定刪除後切換到哪個版本
        if idx > 0:
            target_version = versions[idx - 1]
        elif idx < len(versions) - 1:
            target_version = versions[idx + 1]
        else:
            target_version = 'prompt_001.md'
            
        # 刪除檔案
        current_path = os.path.join(PROMPTS_DIR, version)
        if os.path.exists(current_path):
            os.remove(current_path)
            
        # 更新 config 中的 nicknames 與 active_version
        cfg = load_config()
        if 'nicknames' in cfg and version in cfg['nicknames']:
            del cfg['nicknames'][version]
            
        if version == active_version:
            cfg['current_version'] = target_version
            save_config(cfg)
            original_prompt_path = os.path.join(BASE_DIR, 'assets', 'prompt.md')
            import shutil
            shutil.copy(os.path.join(PROMPTS_DIR, target_version), original_prompt_path)
        else:
            save_config(cfg)
            
        return jsonify({
            'success': True,
            'version': target_version,
            'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@admin_bp.route('/api/prompt/nickname', methods=['POST'])
@admin_required
def save_prompt_nickname():
    data = request.get_json() or {}
    version = data.get('version', '').strip()
    nickname = data.get('nickname', '').strip()
    
    if not version:
        return jsonify({'error': '請指定版本'}), 400
        
    versions = get_all_prompt_versions()
    if version not in versions:
        return jsonify({'error': f'版本 {version} 不存在'}), 404
        
    try:
        cfg = load_config()
        if 'nicknames' not in cfg:
            cfg['nicknames'] = {}
        cfg['nicknames'][version] = nickname
        save_config(cfg)
        
        return jsonify({
            'success': True,
            'version': version,
            'nickname': nickname
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── 已回診清除與科別管理 ────────────────────────────────────────────────────────

@admin_bp.route('/api/patients/<mrn>/clear_return_visit', methods=['POST'])
@login_required
def clear_return_visit(mrn: str):
    mrn = mrn.strip()
    data = request.get_json() or {}
    target_status = data.get('status')
    
    conn = get_db()
    try:
        if not target_status:
            row = conn.execute('SELECT status FROM patients WHERE medical_record_number = ?', (mrn,)).fetchone()
            if row:
                current_status = row['status']
                if current_status == '須看診':
                    target_status = '已看診'
                elif current_status == '須回診':
                    target_status = '已回診'
                else:
                    target_status = '已回診'
            else:
                target_status = '已回診'
                
        if target_status not in ('已看診', '已回診'):
            return jsonify({'error': '無效的狀態更新'}), 400
            
        conn.execute('''
            UPDATE patients
            SET status = ?
            WHERE medical_record_number = ?
        ''', (target_status, mrn))
        conn.commit()
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()
        
    return jsonify({'success': True, 'status': target_status})


@admin_bp.route('/api/departments', methods=['GET'])
@login_required
def get_departments():
    deps = load_departments()
    conn = get_db()
    try:
        rows = conn.execute('SELECT DISTINCT department FROM doctors').fetchall()
        used_deps = {r['department'].strip() for r in rows if r['department']}
    except Exception:
        used_deps = set()
    finally:
        conn.close()
        
    result = []
    for d in deps:
        result.append({
            'name': d['name'],
            'is_active': d.get('is_active', True),
            'is_used': d['name'].strip() in used_deps
        })
    return jsonify(result)


@admin_bp.route('/api/departments', methods=['POST'])
@admin_required
def create_department():
    data = request.get_json() or {}
    name = data.get('name', '').strip()
    
    if not name:
        return jsonify({'error': '科別名稱不可空白'}), 400
        
    deps = load_departments()
    # 檢查是否已存在
    for d in deps:
        if d['name'] == name:
            if not d.get('is_active', True):
                # 重新啟用
                d['is_active'] = True
                save_departments(deps)
                return jsonify({'success': True, 'message': '該科別已重新啟用'})
            return jsonify({'error': '該科別已存在'}), 400
            
    deps.append({"name": name, "is_active": True})
    save_departments(deps)
    return jsonify({'success': True, 'message': '科別新增成功'})


@admin_bp.route('/api/departments/<old_name>', methods=['PUT'])
@admin_required
def update_department(old_name: str):
    old_name = old_name.strip()
    data = request.get_json() or {}
    new_name = data.get('name', '').strip()
    is_active = data.get('is_active', None)
    
    deps = load_departments()
    
    dep_item = None
    for d in deps:
        if d['name'] == old_name:
            dep_item = d
            break
            
    if not dep_item:
        return jsonify({'error': '找不到該科別'}), 404
        
    # 如果有傳入新名稱，且不等於舊名稱
    if new_name and new_name != old_name:
        # 檢查新名稱是否衝突
        for d in deps:
            if d['name'] == new_name:
                return jsonify({'error': '該科別名稱已存在'}), 400
                
        # 更新 JSON 中的名稱
        dep_item['name'] = new_name
        
        # 透過 SQL 更新 doctors 關聯科別
        try:
            conn = get_db()
            conn.execute('UPDATE doctors SET department = ? WHERE department = ?', (new_name, old_name))
            conn.commit()
            conn.close()
        except Exception as e:
            return jsonify({'error': f'更新醫師科別欄位失敗: {e}'}), 500
            
    if is_active is not None:
        dep_item['is_active'] = bool(is_active)
        
    save_departments(deps)
    return jsonify({'success': True})


@admin_bp.route('/api/departments/<name>', methods=['DELETE'])
@admin_required
def delete_or_disable_department(name: str):
    name = name.strip()
    deps = load_departments()
    
    dep_item = None
    for d in deps:
        if d['name'] == name:
            dep_item = d
            break
            
    if not dep_item:
        return jsonify({'error': '找不到該科別'}), 404
        
    # 檢查是否有醫師使用該科別
    try:
        conn = get_db()
        used = conn.execute('SELECT 1 FROM doctors WHERE department = ? LIMIT 1', (name,)).fetchone()
        conn.close()
    except Exception as e:
        return jsonify({'error': f'查詢資料庫科別關聯失敗: {e}'}), 500
        
    if used:
        # 已被使用：改為停用 (is_active = false)
        dep_item['is_active'] = False
        save_departments(deps)
        return jsonify({'success': True, 'action': 'disabled', 'message': '該科別已被醫師使用，已轉為停用狀態。'})
    else:
        # 未被使用：完全刪除
        deps = [d for d in deps if d['name'] != name]
        save_departments(deps)
        return jsonify({'success': True, 'action': 'deleted', 'message': '科別已成功刪除。'})

# ── 衛教資料管理（醫師自行維護，僅限管理員新增/編輯/刪除）──────────────────────
# 輔助函式
def _sanitize_md_filename(filename: str) -> str:
    """限制自訂檔名只能是純檔名（擋掉路徑符號），並確保副檔名是 .md。"""
    filename = os.path.basename((filename or '').strip())
    if not filename:
        return ''
    if not filename.lower().endswith('.md'):
        filename += '.md'
    return filename


def _write_md_content(filename: str, content: str) -> None:
    os.makedirs(DISCHARGE_MD_DIR, exist_ok=True)
    with open(os.path.join(DISCHARGE_MD_DIR, filename), 'w', encoding='utf-8') as f:
        f.write(content)


def _read_md_content(filename: str) -> str | None:
    path = os.path.join(DISCHARGE_MD_DIR, filename)
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def _delete_md_file_if_unshared(filename: str, edu_after_delete: dict) -> None:
    """只有在刪除後，沒有其他「部位/類別」還指向同一個檔名時，才真的刪除 .md 檔。"""
    still_used = any(
        isinstance(info, dict) and info.get('filename') == filename
        for categories in edu_after_delete.values()
        for info in categories.values()
    )
    if still_used:
        return
    path = os.path.join(DISCHARGE_MD_DIR, filename)
    if os.path.exists(path):
        os.remove(path)

def _find_category_location(edu: dict, category: str):
    """整份資料裡，只要任何部位底下已經有這個類別名稱，就回傳該部位名稱；否則回傳 None。"""
    for bp, categories in edu.items():
        if category in categories:
            return bp
    return None


def _find_filename_owner(edu: dict, filename: str):
    """回傳目前是哪個 (部位, 類別) 在用這個檔名；沒人用就回傳 None。"""
    for bp, categories in edu.items():
        for cat, info in categories.items():
            if info.get('filename') == filename:
                return (bp, cat)
    return None


# ── 衛教資料管理 main function ──────────────────────
@admin_bp.route('/api/education', methods=['GET'])
@login_required
def list_education():
    """回傳所有「部位/類別/檔名」，攤平成列表供顯示（不含 content，內容另外抓）。"""
    test_file = EDUCATION_FILE

    with education_lock:
        if os.path.exists(test_file):
            with open(test_file, 'r', encoding='utf-8') as f:
                edu = json.load(f)
        else:
            edu = {}

    result = []
    for bodypart, categories in edu.items():
        for category, info in categories.items():
            result.append({
                'bodypart': bodypart,
                'category': category,
                'filename': info.get('filename', '')
            })
    result.sort(key=lambda x: (x['bodypart'], x['category']))
    return jsonify(result)


@admin_bp.route('/api/education-content/<path:filename>', methods=['GET'])
@login_required
def get_education_content(filename: str):
    """讀取指定 md 檔的實際內容，供編輯 Modal 帶入現有內容。"""
    filename = _sanitize_md_filename(filename)
    content = _read_md_content(filename)
    if content is None:
        return jsonify({'error': '找不到此檔案'}), 404
    return jsonify({'filename': filename, 'content': content})


@admin_bp.route('/api/education', methods=['POST'])
@admin_required
def create_education():
    """新增衛教類別（部位 + 類別 + 自訂檔名），同步寫入對應的 md 檔"""
    test_file = EDUCATION_FILE

    data = request.get_json() or {}
    bodypart = data.get('bodypart', '').strip()
    category = data.get('category', '').strip()
    content_text = data.get('content', '').strip()
    filename = _sanitize_md_filename(data.get('filename', ''))

    if not bodypart or not category or not content_text or not filename:
        return jsonify({'error': '部位、類別名稱、衛教內容與檔名皆不可空白'}), 400

    with education_lock:
        if os.path.exists(test_file):
            with open(test_file, 'r', encoding='utf-8') as f:
                edu = json.load(f)
        else:
            edu = {}

        existing_bodypart = _find_category_location(edu, category)
        if existing_bodypart is not None:
            return jsonify({'error': f'類別「{category}」已存在於「{existing_bodypart}」底下，類別名稱不可重複'}), 400

        owner = _find_filename_owner(edu, filename)
        if owner is not None:
            owner_bp, owner_cat = owner
            return jsonify({'error': f'檔名「{filename}」已經被「{owner_bp}／{owner_cat}」使用，請換一個檔名'}), 400

        categories = edu.setdefault(bodypart, {})
        categories[category] = {'filename': filename}

        with open(test_file, 'w', encoding='utf-8') as f:
            json.dump(edu, f, ensure_ascii=False, indent=4)

        _write_md_content(filename, content_text)

    return jsonify({'success': True, 'bodypart': bodypart, 'category': category, 'filename': filename})



@admin_bp.route('/api/education/<bodypart>/<category>', methods=['PUT'])
@admin_required
def update_education(bodypart: str, category: str):
    """編輯衛教類別（可同時修改部位、類別名稱、檔名，並同步寫入內容到 md 檔）"""
    test_file = EDUCATION_FILE

    bodypart = bodypart.strip()
    category = category.strip()
    data = request.get_json() or {}
    new_bodypart = data.get('bodypart', bodypart).strip()
    new_category = data.get('category', category).strip()
    content_text = data.get('content', '').strip()
    filename = _sanitize_md_filename(data.get('filename', ''))

    if not new_bodypart or not new_category or not content_text or not filename:
        return jsonify({'error': '部位、類別名稱、衛教內容與檔名皆不可空白'}), 400

    with education_lock:
        if os.path.exists(test_file):
            with open(test_file, 'r', encoding='utf-8') as f:
                edu = json.load(f)
        else:
            edu = {}

        if bodypart not in edu or category not in edu[bodypart]:
            return jsonify({'error': '找不到此類別'}), 404

        renamed = (new_bodypart != bodypart) or (new_category != category)
        if renamed:
            existing_bodypart = _find_category_location(edu, new_category)
            if existing_bodypart is not None:
                return jsonify({'error': f'類別「{new_category}」已存在於「{existing_bodypart}」底下，類別名稱不可重複'}), 400

        owner = _find_filename_owner(edu, filename)
        if owner is not None and owner != (bodypart, category):
            owner_bp, owner_cat = owner
            return jsonify({'error': f'檔名「{filename}」已經被「{owner_bp}／{owner_cat}」使用，請換一個檔名'}), 400

        # 從原本位置移除
        del edu[bodypart][category]
        if not edu[bodypart]:
            del edu[bodypart]

        # 寫入(可能是新的)部位/類別
        edu.setdefault(new_bodypart, {})[new_category] = {'filename': filename}

        with open(test_file, 'w', encoding='utf-8') as f:
            json.dump(edu, f, ensure_ascii=False, indent=4)

        _write_md_content(filename, content_text)

    return jsonify({'success': True, 'bodypart': new_bodypart, 'category': new_category, 'filename': filename})


@admin_bp.route('/api/education/<bodypart>/<category>', methods=['DELETE'])
@admin_required
def delete_education(bodypart: str, category: str):
    """刪除衛教類別（若沒有其他類別共用同一個 md 檔，才一併刪除該檔案）"""
    test_file = EDUCATION_FILE

    bodypart = bodypart.strip()
    category = category.strip()

    with education_lock:
        if os.path.exists(test_file):
            with open(test_file, 'r', encoding='utf-8') as f:
                edu = json.load(f)
        else:
            edu = {}

        if bodypart not in edu or category not in edu[bodypart]:
            return jsonify({'error': '找不到此類別'}), 404

        filename = edu[bodypart][category].get('filename', '')
        del edu[bodypart][category]
        if not edu[bodypart]:
            del edu[bodypart]

        with open(test_file, 'w', encoding='utf-8') as f:
            json.dump(edu, f, ensure_ascii=False, indent=4)

        if filename:
            _delete_md_file_if_unshared(filename, edu)

    return jsonify({'success': True})