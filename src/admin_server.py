"""
admin_server.py — EDDI 管理後台（護理站 / 醫師端）Flask Blueprint
======================================================================

【這個檔案在整個系統中的角色】
app.py 建立 Flask app 並註冊三個 Blueprint：form_bp（病患填表頁面）、
admin_bp（本檔案，護理站 / 醫師管理後台）、以及 LINE Webhook 路由本身。
本檔案負責「人」（護理師、醫師、管理員）透過瀏覽器操作系統的所有後端邏輯，
對應到前端 webpage/admin/ 底下的頁面與 JS（admin.html/script.js、
chats.html/js、doctors.html/js、forms.html/js、prompt.html/js、
stats.html/js、education.html/js）。

【權限模型】
所有 API 皆使用 Flask session cookie 驗證登入狀態（見 login()、logout()）。
兩層權限透過裝飾器實作：
  - login_required：任何已登入的醫師/護理師帳號皆可使用。
  - admin_required：session['is_admin'] 必須為真，僅系統管理員可用
    （例如：新增/刪除醫師帳號、管理科別、管理衛教資料、修改 AI Prompt）。

【資料儲存位置總覽】
  - database/hospital.db（SQLite）：doctors / patients / line_accounts /
    line_patient_pairs / record 五張表，結構請見 scripts/db_init.py。
  - chat_logs/<病歷號>/*.json：LINE 對話紀錄（由 chat_logs.py 寫入，本檔案
    只負責「讀取」給前端顯示，讀取邏輯見下方 chat_logs JSON 讀取工具區塊）。
  - drafts/D{doctor_id:07d}/{mrn}_{date}.json：護理師建立的「病歷草稿」，
    等醫師確認症狀內容後才會正式寫入 record 表（doctor_submit）。
  - assets/prompts/prompt_NNN.md + data/prompt_config.json：AI 系統提示詞
    的版本控制（可回溯上一版、切換任意版本、命名別名）。
  - assets/discharge/category.json + assets/discharge/*.md：衛教文章資料，
    同時也是 bot.py 的 build_rag_context() 用來做 RAG 檢索的資料來源
    ── 因此本檔案對衛教資料的增刪修改，會直接影響 LINE Bot 的回覆內容。
  - data/departments.json：科別清單（獨立於 doctors.department 欄位之外，
    多存了「是否啟用」狀態，讓管理員可以停用但不刪除仍有醫師在使用的科別）。
  - data/stats_cache.json：/api/stats 的計算結果快取，用來記錄
    「數值最後一次真正變動」的時間，而不是「最後一次被查詢」的時間。

【本檔案的 8 大功能分區（依code順序）】
  1. 科別 / 衛教資料的檔案存取小工具（load_departments 等）
  2. 共用 helpers（密碼雜湊、DB 連線、登入/管理員裝飾器）
  3. chat_logs JSON 讀取工具（給 /api/chats 系列使用）
  4. Prompt 版本控制 helpers
  5. 認證路由（/main、/api/me、/api/login、/api/logout）
  6. 統計數據、聊天紀錄查詢路由
  7. 表單（出院/回診紀錄）與醫師帳號管理路由
  8. Prompt、科別、衛教資料管理路由
"""

from flask import Blueprint, request, render_template, jsonify, session, send_from_directory
import sqlite3
import hashlib
import json
import os
import re
import glob
from datetime import datetime
from functools import wraps
# 從 bot.py 匯入「置頂 LINE 帳號」佇列的存取函式：
# 當護理師替某個置頂中的 LINE 帳號建立病歷草稿後（nurse_create），
# 該帳號就會被移出置頂清單（因為已經「被處理」了）。
from bot import get_pinned, remove_from_pinned

# 本檔案採用 Flask Blueprint 架構，前綴路徑於 app.py 註冊時決定
# （目前為不加前綴，因此 /main、/api/... 皆為最終路徑）。
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

# 衛教資料（category.json + 對應 .md 檔）的讀寫皆需搶這把鎖，
# 避免多個管理員/醫師同時編輯衛教內容時，JSON 檔案發生競態寫壞的情況。
education_lock = threading.Lock()

def load_departments() -> list:
    """讀取科別設定 JSON（data/departments.json）。
    若檔案不存在，代表是全新安裝，會建立包含「急診科／內科／小兒科」的
    預設清單並寫入檔案後回傳，確保後續 /api/departments 一定有資料可顯示。
    每個科別項目格式為 {"name": 科別名稱, "is_active": 是否啟用}。"""
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
    """寫入科別設定 JSON。呼叫時機：新增/修改/刪除（停用）科別、
    或是新增/修改醫師時科別若不存在則自動補上一筆啟用中的科別紀錄。"""
    try:
        os.makedirs(os.path.dirname(DEPARTMENTS_FILE), exist_ok=True)
        with open(DEPARTMENTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(deps, f, ensure_ascii=False, indent=4)
    except Exception as e:
        print(f"[Departments Save Error] {e}")

def load_education() -> dict:
    """讀取衛教資料 JSON，key 為類別，value 為衛教內容文字。
    相容舊格式（list of {topic_zh, topic_en, content}），讀取時會自動轉換並存回新格式。
    註：目前 /api/education 系列路由實際上都是直接讀寫 EDUCATION_FILE
    （新格式：{部位: {類別: {filename: ...}}}），本函式與 save_education
    保留給其他可能仍依賴舊格式的呼叫端使用。"""
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
    """密碼雜湊：以 SHA256 對明文密碼做單向雜湊後儲存/比對，
    與 db_init.py、db_test.py 建立測試帳號時使用的演算法一致。"""
    return hashlib.sha256(pw.encode()).hexdigest()


def get_db() -> sqlite3.Connection:
    """建立一個新的 SQLite 連線，並設定 row_factory 為 sqlite3.Row，
    使查詢結果可用欄位名稱（如 row['doctor_id']）存取，而非只能用索引。
    每個路由函式各自呼叫、各自負責在 try/finally 或流程結束時 close()，
    未使用連線池（符合 Flask 短生命週期請求的簡單腳本風格）。"""
    conn = sqlite3.connect(DB_HOSPITAL)
    conn.row_factory = sqlite3.Row
    return conn


def login_required(f):
    """裝飾器：檢查 Flask session 中是否有 'account' 鍵（登入成功時由 login() 寫入）。
    未登入則回傳 401 並中斷請求，不會執行被裝飾的路由函式本體。"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'account' not in session:
            return jsonify({'error': '請先登入'}), 401
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    """裝飾器：在 login_required 的基礎上，再檢查 session['is_admin'] 是否為真。
    用於保護「僅系統管理員可用」的路由（醫師帳號的新增/刪除/修改、
    科別與衛教資料的新增/修改/刪除、AI Prompt 的所有寫入操作）。
    未登入回 401，已登入但非管理員回 403。"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'account' not in session:
            return jsonify({'error': '請先登入'}), 401
        if not session.get('is_admin'):
            return jsonify({'error': '此功能僅限管理員'}), 403
        return f(*args, **kwargs)
    return wrapper


# ── chat_logs JSON 讀取工具 ────────────────────────────────────────────────────
# 本區塊的函式都是「唯讀」性質：chat_logs/<mrn>/*.json 的寫入完全由
# chat_logs.py 的 save_chat_to_json / finalize_session 負責（LINE Bot 對話流程），
# admin_server.py 只負責讀出來，組裝成 /api/chats、/api/chats/<mrn> 的回應格式，
# 供 chats.html/chats.js 顯示病患對話紀錄。

def _parse_timestamp(ts: str) -> str:
    """把 ISO 8601 timestamp（例如 '2024-05-01T22:00:00.123+08:00' 或
    帶 'Z' 結尾的 UTC 格式）轉成不含時區、人類易讀的 'YYYY-MM-DD HH:MM:SS' 字串。
    做法：從第 10 個字元之後（跳過日期本身的 '-'）尋找 '+' 或 'Z'，
    找到就切掉時區部分，再把中間的 'T' 換成空白。"""
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
    讀取 chat_logs/<mrn>/ 下所有 *.json（包含尚在進行中的 active_session.json
    與已封存的 <YYYYMMDD>_<NN>.json），把每個檔案裡的 messages 陣列全部攤平、
    合併成單一列表，並依 created_at 時間排序、重新編上連續的 id。
    用途：目前主要供其他工具函式或未來需要「整個病患完整對話串流」時使用；
    /api/chats/<mrn> 實際顯示則是採用下方 load_sessions_for_mrn（保留分場次資訊）。
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
    依 start_time 降序排序（最新的場次在最前面），並回傳 session list，
    供 chats.js 用時間軸方式呈現「一次一次的對話場次」（對應 chat_logs.py
    以 1 小時閒置為界線切分場次的設計）。
    每一個 session 包含:
      - session_id (檔名)
      - label (顯示標籤，例如「2024-05-01 對話 #01 (22:00:00)」或
               「進行中對話 (...)」──若檔名是 active_session.json)
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
    """回傳 {msg_count, last_chat} 給病患列表（/api/chats）使用，屬於輕量掃描：
    只累計訊息數量、取出各檔案 metadata.end_time 中最新的日期，
    不像 load_sessions_for_mrn 那樣把完整訊息內容都讀出組裝，
    因此列表頁載入時效能較好。"""
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
    """回傳 chat_logs/ 下「確實有至少一個 json 檔」的病歷號（MRN）子目錄名稱集合，
    目前未被其他路由直接使用，屬於保留的查詢工具函式。"""
    if not os.path.isdir(CHAT_LOGS_DIR):
        return set()
    result = set()
    for entry in os.scandir(CHAT_LOGS_DIR):
        if entry.is_dir() and glob.glob(os.path.join(entry.path, '*.json')):
            result.add(entry.name)
    return result


# ── Prompt Versioning Helpers ──────────────────────────────────────────────────
# AI 系統提示詞（system prompt）版本控制設計：
#   - 每個版本是 assets/prompts/ 底下的一個獨立檔案 prompt_NNN.md（NNN 為
#     三位數編號，遞增），bot.py 的 load_prompt_template() 讀取的是
#     data/prompt_config.json 裡記錄的 current_version 對應檔案。
#   - assets/prompt.md 是「目前生效版本」的鏡像複本：每次切換/回溯版本
#     時都會同步覆寫這個檔案，保留給舊版程式碼或外部工具直接讀取單一
#     固定路徑使用（相容性用途）。
#   - prompt_001.md 視為「原始版本」，規則上不可被刪除。

def get_all_prompt_versions() -> list:
    """掃描 assets/prompts/ 目錄下所有 prompt_*.md 檔案，依編號數字（檔名
    第 8~-3 個字元，即 NNN 部分）由小到大排序後回傳檔名列表。"""
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
    """讀取 data/prompt_config.json，內容包含 current_version（目前生效
    的版本檔名）與 nicknames（版本檔名 → 使用者自訂別名的字典）。"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_config(cfg: dict):
    """寫入 data/prompt_config.json。"""
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Config] 寫入失敗: {e}")


def get_current_prompt_info():
    """確保目錄、原始版本、以及設定檔存在，並回傳
    (current_version_filename, content, has_prev, has_next, prev_version, next_version)。
    這是本檔案取得「目前生效中」Prompt 完整資訊的統一入口，供 get_prompt()、
    rollback_prompt()、delete_prompt() 呼叫，避免重複撰寫初始化/降級邏輯。
    has_prev/has_next 是相對於「版本編號順序」而言，用於前端上一版/下一版導覽按鈕。"""
    os.makedirs(PROMPTS_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)

    # 確保原始 prompt_001.md 存在：若 assets/prompt.md（舊版單檔式提示詞）存在，
    # 直接複製一份作為 prompt_001.md；否則寫入一句最簡單的預設提示詞，
    # 保證系統一定有「版本 001」可用，不會出現無版本可切換的狀況。
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
    """後台入口頁面：回傳 admin.html（單頁式應用殼層，實際頁面切換由
    script.js 的 showSection() 在前端完成，不會有多次整頁換頁）。"""
    return render_template('admin/html/admin.html')


@admin_bp.route('/main/css/<path:filename>')
def admin_css(filename):
    """靜態資源：提供 webpage/admin/css/ 底下的 CSS 檔案（例如 style.css）。"""
    return send_from_directory(os.path.join(WEBPAGE_DIR, 'admin', 'css'), filename)


@admin_bp.route('/main/js/<path:filename>')
def admin_js(filename):
    """靜態資源：提供 webpage/admin/js/ 底下的 JS 檔案（script.js、chats.js、
    doctors.js、forms.js、prompt.js、stats.js、education.js）。"""
    return send_from_directory(os.path.join(WEBPAGE_DIR, 'admin', 'js'), filename)


@admin_bp.route('/api/me')
def get_me():
    """回傳目前登入狀態，前端 script.js 的 checkAuth() 在應用初始化時呼叫，
    用來決定顯示登入畫面還是主畫面，並依 is_admin 決定是否顯示管理員限定選單。
    刻意不加 @login_required，未登入時回 200 + logged_in:false（而非 401），
    因為這正是用來「查詢」是否已登入的端點，不該被登入裝飾器擋下。"""
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
    """帳號密碼登入：比對 doctors 表的 account_name + password_hash（SHA256）
    + is_active = 1（已停用帳號無法登入，即使密碼正確）。
    成功後將 account / doctor_name / is_admin 寫入 Flask session，
    並設定 session.permanent = True（配合 app.py 設定的
    PERMANENT_SESSION_LIFETIME，讓登入狀態能跨瀏覽器分頁/重啟持續存在，
    不會在關閉瀏覽器後就馬上登出）。"""
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
    """登出：清空整個 session（連同 account/doctor_name/is_admin 一次清除）。"""
    session.clear()
    return jsonify({'success': True})


# ── 統計數據 ──────────────────────────────────────────────────────────────────

@admin_bp.route('/api/stats')
@login_required
def get_stats():
    """儀表板統計數據（供 stats.html/stats.js 顯示卡片與匯出 CSV）。
    計算的指標：
      - total_friends：LINE 好友總數（line_accounts 表列數）。
      - total_patients：病患總數（patients 表列數）。
      - total_forms：出院/回診表單總數（record 表列數）。
      - patients_chatted / bot_usage_rate：has_chatted=1 的病患數，
        以及其佔病患總數的百分比（LINE Bot 使用率）。
      - return_visits：回診次數，用「表單總數 - 病患總數」估算
        （邏輯：每位病患至少有一張出院單，多出來的表單數即為回診次數；
        用 max(0, ...) 避免資料異常時出現負數）。

    快取機制（data/stats_cache.json）的語意是「數值最後一次真正改變的時間」，
    而不是「最後一次被查詢的時間」：每次呼叫都重新計算 stats，
    但只有當新算出來的 snapshot 與快取內容不同時，才更新 last_updated
    時間戳並覆寫快取檔；若數值未變，則沿用快取裡舊的 last_updated。
    這讓前端顯示的「更新時間」能真實反映資料異動時間，而非每次整理頁面
    就跳動的查詢時間，方便管理員判斷數據的新鮮度。"""
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
        # 比對本次算出的完整快照與快取中的舊快照是否相同
        snapshot = {k: v for k, v in stats.items()}
        if cached.get('data') != snapshot:
            # 數值有變動：更新時間戳並覆寫快取檔
            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            stats['last_updated'] = now
            with open(STATS_CACHE, 'w', encoding='utf-8') as f:
                json.dump({'data': snapshot, 'last_updated': now}, f, ensure_ascii=False, indent=2)
        else:
            # 數值未變：沿用快取中原有的 last_updated，不視為「剛剛更新」
            stats['last_updated'] = cached.get('last_updated', '')
    except Exception:
        stats['last_updated'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    return jsonify(stats)


# ── 聊天紀錄列表 ──────────────────────────────────────────────────────────────

@admin_bp.route('/api/chats')
@login_required
def get_chats():
    """病患列表（chats.html 左側清單）：以病歷號（medical_record_number）
    為單位聚合，每個病患顯示其 LINE 帳號、關係、表單數、對話訊息數、
    最近就診日期、看診科別（去重後的清單 + 最新一次的科別）與目前狀態。
    權限差異：管理員（is_admin）可看到全院所有病患；一般醫師只能看到
    自己曾經看診過（record.doctor_id 對應到自己帳號）的病患清單，
    透過 SQL JOIN doctors 並用 WHERE d.account_name = ? 過濾達成。"""
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

            # 對每個病患再額外查詢一次「最新一筆就診紀錄的科別」與「所有曾看過的科別」，
            # 因為上面的主查詢用 GROUP BY 聚合後無法同時取得這兩種細節資訊。
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
    """單一病患詳情頁（chats.html 右側面板）：回傳病患基本資料、
    該病患所有出院/回診表單（forms）、以及所有 LINE 對話場次（sessions，
    來自 load_sessions_for_mrn，包含 metadata 供 chats.js 畫時間軸分隔線）。
    權限檢查：非管理員必須自己至少看診過這位病患一次（record 表中存在
    doctor_id 對應到自己帳號的紀錄），否則回 403，避免醫師互相偷看
    彼此負責病患的對話內容。"""
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

    # 用 LEFT JOIN 是因為即使病患目前尚未被任何 LINE 帳號綁定/配對，
    # 仍需要能查到 patients 表本身的基本資料（不能因為沒有 LINE 配對就整個查不到）。
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
# 本區塊對應 forms.html/forms.js 的「護理師建立病歷草稿 → 醫師確認送出」
# 兩階段流程：
#   1. 護理師（或醫師本人）選擇一個 LINE 帳號，替其建立/選擇病患配對關係，
#      系統會在 drafts/D{doctor_id:07d}/ 底下寫入一份草稿 JSON
#      （nurse_create），此時尚未寫入正式的 record 資料表。
#   2. 該醫師登入後在「草稿列表」看到待確認的草稿（doctor_drafts /
#      doctor_draft 詳情），填入症狀等資訊後按下確認送出（doctor_submit），
#      才會正式 INSERT 進 record 表，草稿檔案隨即被刪除。
# 置頂佇列（pinned，來自 bot.py 的 get_pinned/remove_from_pinned）用來讓
# 護理站快速找到「剛剛才透過 LINE 綁定、但還沒有人幫忙建立病歷」的帳號，
# 一旦護理師替某帳號建立了草稿（nurse_create），該帳號就會自動從置頂佇列移除。

@admin_bp.route('/api/forms/get_line_accounts', methods=['GET'])
@login_required
def get_line_accounts():
    """列出所有 LINE 帳號（供 forms.js 的下拉選單選擇要建立病歷的對象），
    並附帶目前的置頂佇列 line_account_id 清單（pinned/pinned_ids，內容相同，
    保留兩個鍵名是為了前端相容性，避免舊版前端讀取到 undefined）。"""
    conn = get_db()
    try:
        rows = conn.execute(
            'SELECT line_account_id, name FROM line_accounts ORDER BY name'
        ).fetchall()
        accounts = [{'id': r['line_account_id'], 'name': r['name']} for r in rows]
        pinned_ids = get_pinned()

        return jsonify({
            'accounts': accounts,
            'pinned': pinned_ids,
            'pinned_ids': pinned_ids
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@admin_bp.route('/api/forms/doctor_drafts', methods=['GET'])
@login_required
def get_doctor_drafts():
    """列出目前登入醫師自己的所有待確認草稿（掃描 drafts/D{doctor_id:07d}/
    目錄下的 *.json 檔名，檔名格式為 {mrn}_{YYYYMMDD}.json，從檔名反解析出
    病歷號與日期，不需要真的把每個檔案內容都讀出來，效能較好）。
    依檔名反向排序（reverse=True），使較新建立的草稿排在列表前面。"""
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
                if not filename.endswith('.json') or filename in ('placeholder.json',):
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
    """讀取單一草稿檔案的完整內容（供醫師端開啟編輯 Modal 帶入現有資料）。"""
    account = session['account']
    conn = get_db()
    try:
        doctor_row = conn.execute(
            'SELECT doctor_id FROM doctors WHERE account_name = ? LIMIT 1', (account,)
        ).fetchone()
        if not doctor_row:
            return jsonify({'error': '找不到醫師帳號'}), 404
        doctor_id = doctor_row['doctor_id']

        # 用 os.path.basename 去除路徑中可能夾帶的 '../' 等目錄跳脫符號，
        # 避免使用者傳入惡意 filename 讀取到 drafts 目錄以外的檔案（路徑穿越攻擊）。
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
    """捨棄草稿：直接刪除草稿檔案，不會對資料庫做任何變更
    （因為草稿階段本來就還沒寫入 record 表）。"""
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
    """醫師確認送出草稿：把草稿內容正式寫入 record 表，完成後刪除草稿檔案。
    line_patient_pair_id 與 checkout_date 若前端沒有直接傳來，會回頭讀取
    草稿檔案內已儲存的值（草稿建立時 nurse_create 就已經把這兩項寫進去），
    確保即使前端表單只送出 symptoms，仍能取得完整寫入 record 所需的欄位。"""
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
    """查詢某個 LINE 帳號目前已配對的所有病患關係（例如「帳號本人」、
    「父親」、「母親」等），供 forms.js 在建立新病歷草稿時，讓使用者選擇
    「這是幫誰看診」──可以是既有配對，也可以另外新建一個配對關係。"""
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
    """護理師（或醫師本人）建立病歷草稿的核心端點，也是 forms.js「開始看診」
    流程的起點。pair_id 有三種模式，對應到 forms.js 前端下拉選單的三種選項：
      - 'self'：這個 LINE 帳號本人就是病患，relation 固定為「帳號本人」。
      - 'new'：幫這個 LINE 帳號新增一個新的病患配對關係（例如「幫父親掛號」），
               需要同時提供 mrn（病歷號）與 relation（關係稱謂）。
      - 既有的 line_patient_pairs_id（整數字串）：直接沿用該筆既有配對，
        不需要重新輸入病歷號/關係，系統會自動查出對應的 mrn/relation。

    流程：
      1. 從 session 帳號查出 doctor_id/doctor_name（草稿要標示是哪位醫師）。
      2. 依 pair_id 模式解析或建立 patient / line_patient_pairs 資料
         （'self'/'new' 模式下會用 upsert 方式找到既有病患或新增一筆）。
      3. 把上述資訊組成草稿 JSON，寫入 drafts/D{doctor_id:07d}/{mrn}_{日期}.json。
      4. 把這個 LINE 帳號從「置頂佇列」移除（因為已經有人開始處理了）。
      5. 提交資料庫交易；若草稿檔案寫入失敗則回滾資料庫變更，確保
         DB 與檔案系統狀態一致（不會出現「DB 有配對但沒有草稿檔」的半殘狀態）。"""
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

        # 2. 若 pair_id 是既有配對的整數 ID → 跳過 upsert，直接查出 lpp_id/mrn/relation
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

        # 3. 儲存草稿 JSON 檔案（尚未寫入 record 表，等醫師 doctor_submit 才會正式入庫）
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
            # 檔案寫入失敗 → 回滾資料庫變更並回報錯誤，避免 DB 與檔案系統狀態不一致
            conn.rollback()
            return jsonify({'error': f'草稿檔案儲存失敗：{file_err}'}), 500

        # 草稿建立成功後，將該 LINE 帳號從置頂佇列移除（若原本不在佇列中則靜默忽略）
        try:
            remove_from_pinned(int(line_account_id))
        except Exception as pe:
            print(f"[Pinned Remove Error] {pe}")

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
    """修改既有的正式表單（record 表中已存在的紀錄），支援：
      - 修改病歷號（mrn_changed）：僅限管理員，且會連帶把 chat_logs/<舊病歷號>/
        整個目錄搬移（os.rename）到新病歷號目錄，並更新目錄內每份 JSON
        的 metadata.medical_record_num 欄位，確保對話紀錄跟著病歷號走。
      - 修改病患與 LINE 帳號的關係稱謂（relation_changed）：任何登入使用者
        皆可修改，不需要管理員權限。
      - 修改症狀清單（symptoms）：可傳入 list 或逗號分隔字串，皆會轉存成 JSON。
    就診日期與看診醫師視為唯讀欄位，本路由不會更動 checkout_date/doctor_id。"""
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
    """另一個修改表單的路由，與 update_form 的差異在於：本路由允許同時
    改變表單所連結的 LINE 帳號 + 病患配對（line_account_id + pair_id + relation
    + new_mrn），並不需要管理員權限即可修改病歷號（相較 update_form 中
    「改病歷號僅限管理員」的限制較為寬鬆）；但本路由不處理 chat_logs
    目錄搬移，也不支援回傳 record_id 給呼叫端。update_form 主要供
    「病歷號需要管理員審核修改」的情境使用，view_edit_form 則供
    forms.js 檢視/編輯表單時快速調整配對用。
    pair_id 的三種模式定義與 nurse_create 相同（'self' / 'new' / 既有整數 ID）。"""
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
# 對應 doctors.html/doctors.js。除了 list_doctors（GET）任何登入使用者皆可查看
# 醫師名單以外，新增/刪除/修改醫師帳號皆需 admin_required（僅管理員可操作）。

import secrets
import string

def generate_random_password(length=8) -> str:
    """新增醫師帳號時，系統自動產生一組隨機密碼（英文大小寫+數字混合，
    預設 8 碼），透過 secrets 模組（而非 random）確保密碼具備
    密碼學層級的隨機性，避免被預測。產生的密碼只在建立當下回傳一次
    給管理員複製給該醫師，資料庫中僅儲存雜湊值，之後無法再次查詢明文。"""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


@admin_bp.route('/api/doctors', methods=['GET'])
@login_required
def list_doctors():
    """列出所有醫師帳號。每筆額外附加 can_delete 欄位，決定 doctors.js
    是否顯示刪除按鈕：一位醫師「可以被刪除」的條件是同時滿足
      (a) 該醫師在 record 表中沒有任何看診紀錄（避免刪除後產生
          record.doctor_id 指向不存在醫師的資料完整性問題），且
      (b) 不是目前登入者自己的帳號（避免管理員把自己刪除導致無法登入）。
    排序：管理員帳號（is_admin DESC）優先顯示，其餘依帳號名稱排序。"""
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
    """新增醫師帳號：帳號格式限制為英數字與底線（防止特殊符號造成問題），
    密碼由系統隨機產生並以明文形式在回應中回傳一次（generated_password），
    給管理員複製轉交給該醫師；資料庫僅儲存 hash_pw() 後的雜湊值。
    若指定的 specialty（科別）尚未存在於 data/departments.json，
    會自動新增一筆啟用中的科別紀錄，讓科別清單與實際使用中的醫師科別保持同步。"""
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
    """刪除醫師帳號：與 list_doctors 的 can_delete 規則一致，
    後端會再次獨立檢查一次（不可刪除自己、不可刪除已有看診紀錄的醫師），
    避免前端邏輯被繞過（例如直接呼叫 API）而破壞資料完整性。"""
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
    """修改醫師帳號資料：姓名、啟用狀態、是否為管理員、科別、（可選）重設密碼。
    關鍵防呆規則：系統中必須至少保留一位管理員帳號，因此若目前登入的管理員
    正在修改「自己」的帳號並試圖把 is_admin 改為 0，會先確認資料庫中
    是否還有其他 is_admin=1 的帳號存在，否則拒絕這次修改
    （避免整個系統變成沒有任何管理員、無法再管理醫師帳號的窘境）。
    修改科別時，若該科別尚未存在於 departments.json，也會自動補上一筆。"""
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
# 對應 prompt.html/prompt.js。所有路由皆需 admin_required，因為系統提示詞
# 直接影響 LINE Bot（bot.py 的 load_prompt_template）對所有病患的回覆內容與語氣，
# 屬於高風險設定，僅限管理員可修改。

@admin_bp.route('/api/prompt', methods=['GET'])
@admin_required
def get_prompt():
    """讀取 Prompt 內容與版本導覽資訊。
    區分「目前生效版本」（active_version/active_content，即 bot.py 實際使用中的
    那一版）與「目前正在檢視/編輯的版本」（view_version/content，可透過
    query string ?version=xxx 指定要查看歷史上的哪一版，預設等於 active_version）。
    這樣設計讓管理員可以在不切換生效版本的前提下，先「預覽」舊版本內容，
    確認後才透過 switch_prompt 真正切換。"""
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
    """儲存新的 Prompt 內容為一個全新版本（不會覆蓋現有版本檔案，
    也不會自動切換為生效版本 —— 若要生效需另外呼叫 switch_prompt）。
    版本號自動遞增：掃描現有 prompt_*.md 中最大的編號 +1。"""
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
    """一鍵回溯到「目前生效版本」的上一個版本（依版本編號順序）。
    與 delete_prompt 的差異：rollback 不會刪除目前版本的檔案，
    單純只是把 current_version 指標往前移一版並同步 assets/prompt.md，
    因此之後仍可透過 switch_prompt 再切回去。"""
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
    """切換到任意指定的歷史版本，使其成為新的生效版本
    （更新 data/prompt_config.json 的 current_version，並同步覆寫
    assets/prompt.md，讓 bot.py 下次讀取時使用新版本內容）。"""
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
    """永久刪除一個 Prompt 版本檔案（無法刪除原始版本 prompt_001.md，
    此為業務規則上的保護：系統必須永遠保有一個「出廠預設值」可供還原）。
    若刪除的正好是目前生效版本，會自動決定接替的版本：
    優先切換到編號較小的前一版，若沒有前一版則切換到後一版，
    最後手段才退回 prompt_001.md，確保系統永遠有一個生效版本可用，
    不會出現「刪除後無版本生效」的狀態。同時會清除 config 中對應的別名紀錄。"""
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
    """替某個版本設定顯示用的自訂別名（例如「較活潑的語氣」），
    純粹是 UI 顯示用途，儲存在 config.json 的 nicknames 字典中，
    不影響版本檔案內容本身或哪個版本生效。"""
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
    """將病患狀態標記為「已處理」，用於 chats.js 列表中護理師/醫師手動
    確認某位「須看診」或「須回診」病患已完成對應動作時呼叫。
    patients.status 的完整狀態機定義於 scripts/db_init.py 的 CHECK 條件：
    '出院'、'須看診'、'已看診'、'須回診'、'已回診'。
    若前端沒有明確指定要切換成哪個狀態（target_status 未傳入），
    則依目前狀態自動判斷對應的「已完成」狀態：
      須看診 → 已看診；須回診 → 已回診；其他情況預設為 已回診。
    這個自動判斷邏輯讓前端只需要呼叫「清除」動作，不必自己維護狀態轉換規則。"""
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
    """列出所有科別，並標註每個科別目前是否「正被使用」（is_used：
    doctors 表中是否有醫師的 department 欄位等於此科別名稱）。
    is_used 用於前端判斷刪除科別時該顯示「刪除」還是「停用」的提示文字
    （實際的刪除/停用邏輯在 delete_or_disable_department 中執行）。"""
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
    """新增科別。若同名科別已存在但目前是停用狀態，則改為「重新啟用」
    而非報錯（因為刪除有醫師使用中的科別時，實際上只是被停用而非真的移除，
    見 delete_or_disable_department，所以新增時要能把停用的科別復活）。"""
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
    """修改科別：可重新命名（同步更新 doctors.department 欄位，
    確保改名後既有醫師的科別欄位不會變成孤兒資料）與/或切換啟用狀態。"""
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
    """刪除科別的「軟性」處理邏輯：
      - 若目前沒有任何醫師使用該科別 → 直接從 departments.json 移除。
      - 若已有醫師的 department 欄位指向該科別 → 不會真的刪除
        （避免造成醫師資料中的科別欄位失去對應），而是改為停用
        （is_active=False），停用後的科別仍會保留在清單中但不會出現在
        新增/編輯醫師時的科別選單選項裡（前端 doctors.js 過濾邏輯）。"""
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
# 對應 education.html/education.js。這裡管理的資料是 LINE Bot RAG（檢索增強
# 生成）機制的知識來源：assets/discharge/category.json 記錄「部位 → 類別 →
# 對應 .md 檔名」的映射，實際衛教內容則存在各自的 .md 檔案中
# （assets/discharge/*.md）。bot.py 的 build_rag_context() 會依照病患填單時
# 選擇的症狀，用模糊比對找出對應的類別，讀取對應 .md 檔內容注入到 AI 的
# system prompt 的 {context} 位置，讓 AI 回覆病患衛教資訊時有正確的醫療知識依據。
# 因此本區塊任何新增/修改/刪除操作，都會直接影響 LINE Bot 未來對病患的回覆內容。
# 一個 .md 檔可以同時被多個「部位/類別」組合共用（見 _find_filename_owner /
# _delete_md_file_if_unshared），因此刪除時必須先確認沒有其他類別仍在引用
# 該檔案，才會真的刪除實體檔案，避免刪除後其他還在使用該檔的類別失效。

# 輔助函式
def _sanitize_md_filename(filename: str) -> str:
    """限制自訂檔名只能是純檔名（用 os.path.basename 擋掉路徑符號，
    防止路徑穿越攻擊），並確保副檔名是 .md（若使用者沒打副檔名則自動補上）。"""
    filename = os.path.basename((filename or '').strip())
    if not filename:
        return ''
    if not filename.lower().endswith('.md'):
        filename += '.md'
    return filename


def _write_md_content(filename: str, content: str) -> None:
    """把衛教內容文字寫入 assets/discharge/<filename>.md（新增/覆寫）。"""
    os.makedirs(DISCHARGE_MD_DIR, exist_ok=True)
    with open(os.path.join(DISCHARGE_MD_DIR, filename), 'w', encoding='utf-8') as f:
        f.write(content)


def _read_md_content(filename: str) -> str | None:
    """讀取指定 .md 檔內容，檔案不存在則回傳 None（供路由判斷回 404）。"""
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
    """回傳所有「部位/類別/檔名」，攤平成列表供顯示（不含 content，內容另外
    透過 get_education_content 依需求載入，避免列表頁一次讀取全部 .md 檔內容）。
    任何登入使用者皆可查看（唯讀），僅新增/編輯/刪除需要管理員權限。"""
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
    """新增衛教類別（部位 + 類別 + 自訂檔名），同步寫入對應的 md 檔。
    兩項唯一性檢查：
      1. 類別名稱在「整份」資料中必須唯一（不能有兩個部位底下都有同名類別，
         由 _find_category_location 檢查），因為 bot.py 的 build_rag_context
         是用類別名稱去模糊比對症狀文字，重複類別名會造成比對結果混淆。
      2. 檔名也必須唯一（不能借用其他部位/類別「尚未共用」的檔名），
         若要多個類別共用同一份衛教內容，須透過 update_education
         明確指定共用；create_education 一律視為建立新的獨立類別。
    整個檢查 + 寫入 category.json + 寫入 .md 檔的過程都在 education_lock
    保護下完成，避免並發請求造成資料損毀或重複建立。"""
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
    """編輯衛教類別（可同時修改部位、類別名稱、檔名，並同步寫入內容到 md 檔）。
    URL 中的 bodypart/category 是「修改前」的識別鍵，request body 中的
    new_bodypart/new_category/filename 則是「修改後」的目標值。
    若改名，仍會檢查新類別名稱是否與其他部位下的類別衝突；
    若指定的檔名恰好是「自己原本使用的檔名」則允許（owner == (bodypart, category)
    的情況不視為衝突），否則若該檔名已被其他類別佔用則拒絕，
    避免不小心覆寫別的類別正在使用的衛教內容。"""
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