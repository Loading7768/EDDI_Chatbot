
import sqlite3
import hashlib
import json
import os

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
    c.execute('''
        CREATE TABLE IF NOT EXISTS DOCTOR (
            account_name  TEXT    PRIMARY KEY,
            password_hash TEXT    NOT NULL,
            doctor_name   TEXT    NOT NULL,
            is_active     INTEGER NOT NULL DEFAULT 1,
            is_admin      INTEGER NOT NULL DEFAULT 0
        )
    ''')
    doctors = [
        ('admin',   hash_pw('admin123'), '管理員',      1, 1),
        ('dr_wang', hash_pw('wang123'),  '王大明 醫師', 1, 0),
        ('dr_li',   hash_pw('li123'),    '李小華 醫師', 1, 0),
    ]
    c.executemany(
        'INSERT OR IGNORE INTO DOCTOR '
        '(account_name, password_hash, doctor_name, is_active, is_admin) VALUES (?,?,?,?,?)',
        doctors
    )
    conn.commit()
    conn.close()
    print('doctor.db 初始化完成')


# ── PATIENT ──────────────────────────────────────────────────────────────────
def init_patient_db():
    conn = get_db('patient.db')
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS PATIENT (
            medical_record_num TEXT PRIMARY KEY,
            line_id            TEXT UNIQUE
        )
    ''')
    patients = [
        ('P2026001', 'U1a2b3c4d5'),
        ('P2026002', 'U2e3f4g5h6'),
        ('P2026003', 'U3i4j5k6l7'),
        ('P2026004', 'U4m5n6o7p8'),
    ]
    c.executemany(
        'INSERT OR IGNORE INTO PATIENT (medical_record_num, line_id) VALUES (?,?)',
        patients
    )
    conn.commit()
    conn.close()
    print('patient.db 初始化完成')


# ── FORM ─────────────────────────────────────────────────────────────────────
def init_form_db():
    conn = get_db('form.db')
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS FORM (
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
        'INSERT OR IGNORE INTO FORM '
        '(medical_record_num, doctor_account, checkout_date, symptoms, is_chatted) VALUES (?,?,?,?,?)',
        forms
    )
    conn.commit()
    conn.close()
    print('form.db 初始化完成')


# ── CHAT_LOG ─────────────────────────────────────────────────────────────────
def init_chatlog_db():
    conn = get_db('chatlog.db')
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS CHAT_LOG (
            id                 INTEGER   PRIMARY KEY AUTOINCREMENT,
            medical_record_num TEXT      NOT NULL,
            role               TEXT      NOT NULL,
            content            TEXT      NOT NULL,
            created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    logs = [
        ('P2026001', 'user',      '我今天肚子還是很痛，是不是要去急診？',
         '2026-05-08 10:15:00'),
        ('P2026001', 'assistant', '您好！我是EDDI衛教助理。請問腹痛位置在哪裡？疼痛程度是輕微、中等還是嚴重？是否有伴隨發燒、嘔吐或腹瀉？',
         '2026-05-08 10:15:05'),
        ('P2026001', 'user',      '痛在肚臍周圍，中等程度，有一點噁心',
         '2026-05-08 10:16:00'),
        ('P2026001', 'assistant', '根據您描述的症狀，建議注意以下幾點：\n1. 保持臥床休息\n2. 少量飲水或清流質\n3. 避免油膩刺激性食物\n\n如果出現以下情況，請立即就醫：\n⚠️ 疼痛劇烈加重\n⚠️ 發燒超過38°C\n⚠️ 嘔吐不止\n\n目前症狀屬於「黃色」等級，建議在家觀察，若症狀加重請立即至急診就醫。',
         '2026-05-08 10:16:10'),
        ('P2026001', 'user',      '好的，謝謝。我可以吃止痛藥嗎？',
         '2026-05-08 10:17:00'),
        ('P2026001', 'assistant', '關於止痛藥，請依照出院時醫師的處方服用，不要自行增加劑量。若疼痛持續或加劇，請盡快回診或前往急診。',
         '2026-05-08 10:17:08'),
        ('P2026001', 'user',      '我量了體溫，37.8度',
         '2026-05-08 10:45:00'),
        ('P2026001', 'assistant', '37.8°C屬於低度發燒，目前尚未達到緊急就醫標準（38°C以上）。建議多休息、補充水分，並密切觀察體溫變化。若體溫升至38°C以上或腹痛明顯加劇，請立即前往急診就醫。',
         '2026-05-08 10:45:12'),
    ]
    c.executemany(
        'INSERT OR IGNORE INTO CHAT_LOG '
        '(medical_record_num, role, content, created_at) VALUES (?,?,?,?)',
        logs
    )
    conn.commit()
    conn.close()
    print('chatlog.db 初始化完成')


# ── data/ ─────────────────────────────────────────────────────────────────────
def create_data_dir():
    data_dir = os.path.join(BASE_DIR, 'data')
    os.makedirs(data_dir, exist_ok=True)
    cache = os.path.join(data_dir, 'stats_cache.json')
    if not os.path.exists(cache):
        with open(cache, 'w', encoding='utf-8') as f:
            json.dump({}, f)
    print('data/ 目錄建立完成')


# ── main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('=== EDDI 資料庫初始化 ===\n')
    init_doctor_db()
    init_patient_db()
    init_form_db()
    init_chatlog_db()
    create_data_dir()
    print('\n初始化完成！測試帳號：')
    print('  管理員 : admin   / admin123')
    print('  醫師一 : dr_wang / wang123')
    print('  醫師二 : dr_li   / li123')
