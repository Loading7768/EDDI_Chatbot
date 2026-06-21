import sqlite3
import hashlib
import json
import os
import glob

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
            has_chatted           INTEGER NOT NULL DEFAULT 0
        )
    ''')
    
    # 3. line_patient_pairs 表格
    c.execute('''
        CREATE TABLE line_patient_pairs (
            line_patient_pairs_id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id            INTEGER NOT NULL,
            line_uuid             TEXT    NOT NULL,
            relation              TEXT,
            FOREIGN KEY (patient_id) REFERENCES patients (patient_id)
        )
    ''')
    
    # 4. record 表格
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
    
    # 插入測試資料
    doctors = [
        (1, 'admin',   hash_pw('admin123'), '張大亮 醫師', '急診科', 1, 1),
        (2, 'dr_wang', hash_pw('wang123'),  '王大明 醫師', '內科',   1, 0),
        (3, 'dr_li',   hash_pw('li123'),    '李小華 醫師', '小兒科', 1, 0),
    ]
    
    patients_data = [
        (1, 'P2026001', 1),
        (2, 'P2026002', 0),
        (3, 'P2026003', 0),
        (4, 'P2026004', 0)
    ]
    
    line_pairs_data = [
        (1, 'U1a2b3c4d5', 1, '本人'),
        (2, 'U2e3f4g5h6', 2, '本人'),
        (3, 'U3i4j5k6l7', 3, '媽媽'),
        (4, 'U4m5n6o7p8', 4, '丈夫')
    ]
    
    records_data = [
        (1, 1, '2026-05-01 10:00:00.000', 1, json.dumps(['腹痛', '腸胃炎'], ensure_ascii=False)),
        (2, 2, '2026-05-05 09:15:30.456', 2, json.dumps(['胸痛', '頭暈'], ensure_ascii=False)),
        (3, 3, '2026-05-07 16:45:00.789', 3, json.dumps(['便秘', '腹瀉'], ensure_ascii=False)),
        (4, 1, '2026-05-08 14:30:15.123', 2, json.dumps(['腹痛'], ensure_ascii=False)),
        (5, 4, '2026-05-09 11:20:10.012', 2, json.dumps(['頭暈', '水腫'], ensure_ascii=False))
    ]
    
    c.executemany(
        'INSERT INTO doctors (doctor_id, account_name, password_hash, doctor_name, department, is_active, is_admin) VALUES (?,?,?,?,?,?,?)',
        doctors
    )
    
    c.executemany(
        'INSERT INTO patients (patient_id, medical_record_number, has_chatted) VALUES (?,?,?)',
        patients_data
    )
    
    c.executemany(
        'INSERT INTO line_patient_pairs (line_patient_pairs_id, line_uuid, patient_id, relation) VALUES (?,?,?,?)',
        line_pairs_data
    )
    
    c.executemany(
        'INSERT INTO record (record_id, line_patient_pairs_id, checkout_date, doctor_id, symptoms) VALUES (?,?,?,?,?)',
        records_data
    )
    
    conn.commit()
    conn.close()
    print('hospital.db 初始化完成 (包含 tables: doctors, patients, line_patient_pairs, record)')


# ── data/ ─────────────────────────────────────────────────────────────────────
def create_data_dir():
    data_dir = os.path.join(BASE_DIR, 'data')
    os.makedirs(data_dir, exist_ok=True)
    sessions_dir = os.path.join(data_dir, 'sessions')
    os.makedirs(sessions_dir, exist_ok=True)
    cache = os.path.join(data_dir, 'stats_cache.json')
    if not os.path.exists(cache):
        with open(cache, 'w', encoding='utf-8') as f:
            json.dump({}, f)
    print('data/ 目錄建立完成（含 data/sessions/）')


# ── main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    os.makedirs(os.path.join(BASE_DIR, 'database'), exist_ok=True)
    print('=== EDDI 資料庫初始化 ===\n')
    init_hospital_db()
    create_data_dir()
    print('\n初始化完成！測試帳號：')
    print('  管理員 : admin   / admin123')
    print('  醫師一 : dr_wang / wang123')
    print('  醫師二 : dr_li   / li123')
    print('\n聊天記錄 JSON 請放至：data/sessions/*.json')
