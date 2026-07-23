import sqlite3
import hashlib
import json
import os
import glob
import shutil

BASE_DIR = os.getcwd()


def hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()


def get_db(name: str) -> sqlite3.Connection:
    path = os.path.join(BASE_DIR, 'database', name)
    return sqlite3.connect(path)

# ── HOSPITAL DB ──────────────────────────────────────────────────────────────
def init_hospital_db():
    conn = get_db('hospital.db')
    c = conn.cursor()
    
    # 啟用外鍵約束
    c.execute('PRAGMA foreign_keys = ON')
    
    # 刪除舊表
    c.execute('DROP TABLE IF EXISTS record')
    c.execute('DROP TABLE IF EXISTS line_accounts')
    c.execute('DROP TABLE IF EXISTS line_patient_pairs')
    c.execute('DROP TABLE IF EXISTS patients')
    c.execute('DROP TABLE IF EXISTS doctors')
    
    # 1. doctors 表格
    c.execute('''
        CREATE TABLE doctors (
            doctor_id     INTEGER PRIMARY KEY AUTOINCREMENT,
            account_name  TEXT    UNIQUE NOT NULL,
            password_hash TEXT    NOT NULL,
            doctor_name   TEXT    NOT NULL,
            department    TEXT    NOT NULL,
            is_active     INTEGER NOT NULL DEFAULT 0,
            is_admin      INTEGER NOT NULL DEFAULT 0
        )
    ''')
    
    # 2. patients 表格
    c.execute('''
        CREATE TABLE patients (
            patient_id            INTEGER PRIMARY KEY AUTOINCREMENT,
            medical_record_number TEXT    UNIQUE NOT NULL,
            has_chatted           INTEGER NOT NULL DEFAULT 0,
            status                TEXT    NOT NULL DEFAULT '出院'
            CHECK (status IN ('出院', '須回診', '已回診'))
        )
    ''')
    
    # 3. line_accounts 表格
    c.execute('''
        CREATE TABLE line_accounts (
	        line_account_id INTEGER PRIMARY KEY AUTOINCREMENT,
	        uuid            TEXT    UNIQUE NOT NULL,
	        name            TEXT    NOT NULL
        )
    ''')
    
    # 4. line_patient_pairs 表格
    c.execute('''
        CREATE TABLE line_patient_pairs (
            line_patient_pairs_id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id            INTEGER NOT NULL,
            line_account_id       INTEGER NOT NULL,
            relation              TEXT,
            FOREIGN KEY (patient_id) REFERENCES patients (patient_id),
            FOREIGN KEY (line_account_id) REFERENCES line_accounts (line_account_id),
            UNIQUE (line_account_id, patient_id)
        )
    ''')
    
    # 5. record 表格
    c.execute('''
        CREATE TABLE record (
            record_id             INTEGER PRIMARY KEY AUTOINCREMENT,
            line_patient_pairs_id INTEGER NOT NULL,
            checkout_date         DATETIME NOT NULL,
            doctor_id             INTEGER NOT NULL,
            symptoms              TEXT,    -- 存 JSON 字串
            FOREIGN KEY (line_patient_pairs_id) REFERENCES line_patient_pairs (line_patient_pairs_id),
            FOREIGN KEY (doctor_id) REFERENCES doctors (doctor_id)
        )
    ''')
    
    # 建立 Indexes
    c.execute('CREATE INDEX idx_record_lookup ON record (line_patient_pairs_id, doctor_id, checkout_date DESC)')
    c.execute('CREATE INDEX idx_doctors_department ON doctors (department)')
    c.execute('CREATE INDEX idx_line_patient_pairs_uuid ON line_patient_pairs (line_account_id)')

    
    conn.commit()
    conn.close()
    print('hospital.db 初始化完成 (包含 tables: doctors, patients, line_patient_pairs, record)')


# ── data/ ─────────────────────────────────────────────────────────────────────
def create_data_dir():
    data_dir = os.path.join(BASE_DIR, 'data')
    os.makedirs(data_dir, exist_ok=True)
    cache = os.path.join(data_dir, 'stats_cache.json')
    if not os.path.exists(cache):
        with open(cache, 'w', encoding='utf-8') as f:
            json.dump({}, f)
    print('data/ 目錄建立完成')


# ── drafts/ ───────────────────────────────────────────────────────────────────
def clear_drafts_dir():
    drafts_dir = os.path.join(BASE_DIR, 'drafts')
    if not os.path.exists(drafts_dir):
        os.makedirs(drafts_dir, exist_ok=True)
        return

    for item in os.listdir(drafts_dir):
        if item == 'placeholder.json':
            continue
        item_path = os.path.join(drafts_dir, item)
        if os.path.isdir(item_path):
            shutil.rmtree(item_path)
        else:
            os.remove(item_path)
    print('drafts/ 目錄已清理（僅保留 placeholder.json）')


# ── main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('WARNING: Running this script will reset hospital.db and remove all of the exsisting data.')
    confirm_msg = "Yes. I understand this action will wipe the database along with caches(/data, /drafts) and want to proceed."
    user_input = input(f'Please type exactly "{confirm_msg}" to continue:\n')
    if user_input != confirm_msg:
        print('Input did not match. Terminating script.')
        import sys
        sys.exit(1)
        
    os.makedirs(os.path.join(BASE_DIR, 'database'), exist_ok=True)
    print('=== EDDI 資料庫初始化 ===\n')
    init_hospital_db()
    create_data_dir()
    clear_drafts_dir()
    print('\n初始化完成！')
    print('\n聊天記錄 JSON 請放至：chat_logs/{mrc}/*.json')
    print('\n生成測試資料請使用 db_test.py')
