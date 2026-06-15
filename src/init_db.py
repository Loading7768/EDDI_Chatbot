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


# ── DOCTOR ───────────────────────────────────────────────────────────────────
def init_doctor_db():
    conn = get_db('doctor.db')
    c = conn.cursor()
    # 刷新：先刪再建
    c.execute('DROP TABLE IF EXISTS DOCTOR')
    c.execute('''
        CREATE TABLE DOCTOR (
            account_name  TEXT    PRIMARY KEY,
            password_hash TEXT    NOT NULL,
            doctor_name   TEXT    NOT NULL,
            is_active     INTEGER NOT NULL DEFAULT 1,
            is_admin      INTEGER NOT NULL DEFAULT 0,
            specialty     TEXT    NOT NULL
        )
    ''')
    doctors = [
        ('admin',   hash_pw('admin123'), '管理員',      1, 1, '急診科'),
        ('dr_wang', hash_pw('wang123'),  '王大明 醫師', 1, 0, '急診科'),
        ('dr_li',   hash_pw('li123'),    '李小華 醫師', 1, 0, '急診科'),
    ]
    c.executemany(
        'INSERT INTO DOCTOR '
        '(account_name, password_hash, doctor_name, is_active, is_admin, specialty) VALUES (?,?,?,?,?,?)',
        doctors
    )
    conn.commit()
    conn.close()
    print('doctor.db 初始化完成')


# ── PATIENT ──────────────────────────────────────────────────────────────────
def init_patient_db():
    conn = get_db('patient.db')
    c = conn.cursor()
    c.execute('DROP TABLE IF EXISTS PATIENT')
    c.execute('''
        CREATE TABLE PATIENT (
            medical_record_num TEXT PRIMARY KEY,
            line_id            TEXT UNIQUE,
            patient_name       TEXT NOT NULL,
            is_chatted         INTEGER NOT NULL DEFAULT 0
        )
    ''')
    patients = [
        ('P2026001', 'U1a2b3c4d5', '劉一', 1),
        ('P2026002', 'U2e3f4g5h6', '陳二', 0),
        ('P2026003', 'U3i4j5k6l7', '張三', 0),
        ('P2026004', 'U4m5n6o7p8', '李四', 0)
    ]
    c.executemany(
        'INSERT INTO PATIENT (medical_record_num, line_id, patient_name, is_chatted) VALUES (?,?,?,?)',
        patients
    )
    conn.commit()
    conn.close()
    print('patient.db 初始化完成')


# ── FORM ─────────────────────────────────────────────────────────────────────
def init_form_db():
    conn = get_db('form.db')
    c = conn.cursor()
    c.execute('DROP TABLE IF EXISTS FORM')
    c.execute('''
        CREATE TABLE FORM (
            medical_record_num TEXT    NOT NULL,
            doctor_account     TEXT    NOT NULL,
            checkout_date      DATE    NOT NULL,
            symptoms           TEXT,
            is_chatted         INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (medical_record_num, checkout_date)
        )
    ''')
    forms = [
        ('P2026001', 'dr_wang', '2026-05-01',
         json.dumps(['腹痛', '腸胃炎'], ensure_ascii=False), 1),
        ('P2026001', 'dr_wang', '2026-05-08',
         json.dumps(['腹痛'], ensure_ascii=False), 1),
        ('P2026002', 'dr_wang', '2026-05-05',
         json.dumps(['胸痛', '頭暈'], ensure_ascii=False), 0),
        ('P2026003', 'dr_li',   '2026-05-07',
         json.dumps(['便秘', '腹瀉'], ensure_ascii=False), 0),
        ('P2026004', 'dr_wang', '2026-05-09',
         json.dumps(['頭暈', '水腫'], ensure_ascii=False), 0),
    ]
    c.executemany(
        'INSERT INTO FORM '
        '(medical_record_num, doctor_account, checkout_date, symptoms, is_chatted) VALUES (?,?,?,?,?)',
        forms
    )
    conn.commit()
    conn.close()
    print('form.db 初始化完成')


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
    init_doctor_db()
    init_patient_db()
    init_form_db()
    create_data_dir()
    print('\n初始化完成！測試帳號：')
    print('  管理員 : admin   / admin123')
    print('  醫師一 : dr_wang / wang123')
    print('  醫師二 : dr_li   / li123')
    print('\n聊天記錄 JSON 請放至：data/sessions/*.json')
