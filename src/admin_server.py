
from flask import Blueprint, Flask, request, jsonify, session, send_from_directory
import sqlite3
import hashlib
import json
import os
from datetime import datetime
from functools import wraps

# 建立一個名為 admin_bp 的 Blueprint
admin_bp = Blueprint('admin_bp', __name__)
# admin_bp.secret_key = 'eddi_admin_2026_secure_key'
# admin_bp.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

BASE_DIR    = os.getcwd()
WEBPAGE_DIR = os.path.join(BASE_DIR, 'webpage')
PROMPT_FILE = os.path.join(BASE_DIR, 'assets', 'prompt.md')
STATS_CACHE = os.path.join(BASE_DIR, 'data', 'stats_cache.json')

DB_DOCTOR  = os.path.join(BASE_DIR, 'database', 'doctor.db')
DB_PATIENT = os.path.join(BASE_DIR, 'database', 'patient.db')
DB_FORM    = os.path.join(BASE_DIR, 'database', 'form.db')
DB_CHAT    = os.path.join(BASE_DIR, 'database', 'chatlog.db')


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

    # 好友總數 — PATIENT 表筆數（LINE 好友代理值）
    try:
        conn = get_db(DB_PATIENT)
        stats['total_friends'] = conn.execute(
            'SELECT COUNT(*) FROM PATIENT'
        ).fetchone()[0]
        conn.close()
    except Exception:
        stats['total_friends'] = 0

    # 病患總數（有填過表單的不重複病患數）& 表單總數
    try:
        conn = get_db(DB_FORM)
        stats['total_patients'] = conn.execute(
            'SELECT COUNT(DISTINCT medical_record_num) FROM FORM'
        ).fetchone()[0]
        stats['total_forms'] = conn.execute(
            'SELECT COUNT(*) FROM FORM'
        ).fetchone()[0]
        conn.close()
    except Exception:
        stats['total_patients'] = 0
        stats['total_forms']    = 0

    # LINE bot 使用率 — CHAT_LOG 中不重複病患數 / PATIENT 總數
    try:
        conn = get_db(DB_CHAT)
        chatted = conn.execute(
            'SELECT COUNT(DISTINCT medical_record_num) FROM CHAT_LOG'
        ).fetchone()[0]
        conn.close()
        total = stats['total_friends'] or 1
        stats['patients_chatted']  = chatted
        stats['bot_usage_rate']    = round(chatted / total * 100, 1)
    except Exception:
        stats['patients_chatted'] = 0
        stats['bot_usage_rate']   = 0

    # 回診總數 = 表單總數 - 不重複病患數（相差的就是重複就診次數）
    stats['return_visits'] = max(0, stats['total_forms'] - stats['total_patients'])

    # 快取：數字有變才更新檔案
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
                json.dump({'data': snapshot, 'last_updated': now},
                          f, ensure_ascii=False, indent=2)
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
        conn_c = get_db(DB_CHAT)

        if is_admin:
            rows = conn_f.execute(
                'SELECT medical_record_num, MIN(checkout_date) AS first_visit, '
                'COUNT(*) AS form_count FROM FORM '
                'GROUP BY medical_record_num ORDER BY first_visit DESC'
            ).fetchall()
        else:
            rows = conn_f.execute(
                'SELECT medical_record_num, MIN(checkout_date) AS first_visit, '
                'COUNT(*) AS form_count FROM FORM '
                'WHERE doctor_account = ? '
                'GROUP BY medical_record_num ORDER BY first_visit DESC',
                (account,)
            ).fetchall()

        result = []
        for row in rows:
            mrn = row['medical_record_num']

            patient = conn_p.execute(
                'SELECT line_id FROM PATIENT WHERE medical_record_num = ?', (mrn,)
            ).fetchone()

            msg_count = conn_c.execute(
                'SELECT COUNT(*) FROM CHAT_LOG WHERE medical_record_num = ?', (mrn,)
            ).fetchone()[0]

            last_chat = conn_c.execute(
                'SELECT created_at FROM CHAT_LOG WHERE medical_record_num = ? '
                'ORDER BY created_at DESC LIMIT 1', (mrn,)
            ).fetchone()

            result.append({
                'medical_record_num': mrn,
                'line_id':            patient['line_id'] if patient else None,
                'form_count':         row['form_count'],
                'is_return':          row['form_count'] > 1,
                'msg_count':          msg_count,
                'has_logs':           msg_count > 0,
                'last_chat':          last_chat['created_at'][:10] if last_chat else None,
            })

        conn_f.close()
        conn_p.close()
        conn_c.close()
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify(result)


# ── 單一病患詳情 ──────────────────────────────────────────────────────────────

@admin_bp.route('/api/chats/<mrn>')
@login_required
def get_chat_detail(mrn: str):
    account  = session['account']
    is_admin = session['is_admin']

    # 非管理員只能看自己填過表單的病患
    if not is_admin:
        conn = get_db(DB_FORM)
        allowed = conn.execute(
            'SELECT 1 FROM FORM WHERE medical_record_num = ? AND doctor_account = ?',
            (mrn, account)
        ).fetchone()
        conn.close()
        if not allowed:
            return jsonify({'error': '無查看權限'}), 403

    # PATIENT
    conn_p  = get_db(DB_PATIENT)
    patient = conn_p.execute(
        'SELECT * FROM PATIENT WHERE medical_record_num = ?', (mrn,)
    ).fetchone()
    conn_p.close()
    if not patient:
        return jsonify({'error': '找不到此病患'}), 404

    # FORMs
    conn_f = get_db(DB_FORM)
    forms  = conn_f.execute(
        'SELECT * FROM FORM WHERE medical_record_num = ? ORDER BY checkout_date ASC', (mrn,)
    ).fetchall()
    conn_f.close()

    # CHAT_LOG
    conn_c   = get_db(DB_CHAT)
    messages = conn_c.execute(
        'SELECT id, role, content, created_at FROM CHAT_LOG '
        'WHERE medical_record_num = ? ORDER BY created_at ASC', (mrn,)
    ).fetchall()
    conn_c.close()

    forms_list = [
        {
            'medical_record_num': r['medical_record_num'],
            'doctor_account':     r['doctor_account'],
            'checkout_date':      r['checkout_date'],
            'symptoms':           json.loads(r['symptoms']) if r['symptoms'] else [],
            'is_chatted':         bool(r['is_chatted']),
        }
        for r in forms
    ]

    messages_list = [
        {
            'id':         m['id'],
            'role':       m['role'],
            'content':    m['content'],
            'created_at': m['created_at'],
        }
        for m in messages
    ]

    return jsonify({
        'patient': {
            'medical_record_num': patient['medical_record_num'],
            'line_id':            patient['line_id'],
        },
        'forms':    forms_list,
        'messages': messages_list,
    })


# ── Prompt 修改（僅管理員）────────────────────────────────────────────────────

@admin_bp.route('/api/prompt', methods=['GET'])
@admin_required
def get_prompt():
    try:
        content = ''
        if os.path.exists(PROMPT_FILE):
            # 嘗試各種編碼，用 errors='strict' 確保真正解碼成功才停止
            for enc in ('utf-8', 'big5', 'cp950'):
                try:
                    with open(PROMPT_FILE, 'r', encoding=enc, errors='strict') as f:
                        content = f.read()
                    break
                except (UnicodeDecodeError, ValueError):
                    continue
            else:
                # 全部失敗才用 latin-1 fallback（不會拋錯但可能顯示亂碼）
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
        with open(PROMPT_FILE, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'[Prompt] 已寫入：{PROMPT_FILE}  ({len(content)} 字元)')
        return jsonify({
            'success':  True,
            'saved_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'path':     PROMPT_FILE,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── entry point ───────────────────────────────────────────────────────────────

# if __name__ == '__main__':
    # print('EDDI 醫師後台系統')
    # print('網址：http://localhost:5001')
    # print('若尚未初始化資料庫，請先執行：python database/init_db.py\n')
    # app.run(debug=True, port=5001, host='0.0.0.0')
