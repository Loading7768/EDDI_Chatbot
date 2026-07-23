import json
from db_init import get_db, hash_pw

def insert_test_data():
    conn = get_db('hospital.db')
    c = conn.cursor()
    
    # 插入測試資料
    doctors = [
        (1, 'admin',   hash_pw('admin123'), '張大亮', '急診科', 1, 1),
        (2, 'dr_wang', hash_pw('wang123'),  '王大明', '內科',   1, 0),
        (3, 'dr_li',   hash_pw('li123'),    '李小華', '小兒科', 1, 0),
        # 1 more in '急診科'
        (4, 'dr_chen', hash_pw('chen123'),  '陳小妹', '急診科', 1, 0),
        # 2 more inactive accounts
        (5, 'dr_lin',  hash_pw('lin123'),   '林志玲', '內科',   0, 0),
        (6, 'dr_wu',   hash_pw('wu123'),    '吳宗憲', '小兒科', 0, 0),
    ]
    
    # patients: 10, only this first one has_chatted
    # status 涵蓋五種狀態: 出院 / 須看診 / 已看診 / 須回診 / 已回診
    patients_data = [
        (1, 'P2026001', 1, '須回診'),
        (2, 'P2026002', 0, '須看診'),
        (3, 'P2026003', 0, '已看診'),
        (4, 'P2026004', 0, '出院'),
        (5, 'P2026005', 0, '須回診'),
        (6, 'P2026006', 0, '已回診'),
        (7, 'P2026007', 0, '出院'),
        (8, 'P2026008', 0, '須看診'),
        (9, 'P2026009', 0, '已看診'),
        (10, 'P2026010', 0, '出院'),
    ]
    
    # line_patient_pairs: give 'U2e3f4g5h6' 5 different relations.
    line_pairs_data = [
        (1, 'U1a2b3c4d5', 1, '帳號本人'),
        (2, 'U2e3f4g5h6', 2, '帳號本人'),
        (3, 'U3i4j5k6l7', 3, '媽媽'),
        (4, 'U4m5n6o7p8', 4, '丈夫'),
        (5, 'U2e3f4g5h6', 5, '爸爸'),
        (6, 'U2e3f4g5h6', 6, '兒子'),
        (7, 'U2e3f4g5h6', 7, '女兒'),
        (8, 'U2e3f4g5h6', 8, '妻子'),
    ]
    
    # records: 
    # same line_patient_pair_id but by different department doctors.
    # same line_patient_pair_id and 2 from same department, 1 from same department but different doctor.
    records_data = [
        # (record_id, line_patient_pairs_id, checkout_date, doctor_id, symptoms)
        (1, 1, '2026-05-01 10:00:00.000', 1, json.dumps(['腹痛', '腸胃炎'], ensure_ascii=False)),
        
        # Test cases for line_patient_pair_id = 2 (which uses 'U2e3f4g5h6' paired with patient 2)
        (2, 2, '2026-05-05 09:15:30.456', 2, json.dumps(['胸痛', '頭暈'], ensure_ascii=False)), # 內科
        (3, 2, '2026-05-06 10:00:00.000', 1, json.dumps(['發燒'], ensure_ascii=False)), # 急診科 (doctor_id 1)
        (4, 2, '2026-05-07 11:00:00.000', 1, json.dumps(['咳嗽'], ensure_ascii=False)), # 急診科 (doctor_id 1)
        (5, 2, '2026-05-08 12:00:00.000', 4, json.dumps(['喉嚨痛'], ensure_ascii=False)), # 急診科 (doctor_id 4)
        
        (6, 3, '2026-05-07 16:45:00.789', 3, json.dumps(['便秘', '腹瀉'], ensure_ascii=False)),
        (7, 4, '2026-05-09 11:20:10.012', 2, json.dumps(['頭暈', '水腫'], ensure_ascii=False))
    ]
    
    import sqlite3
    try:
        c.executemany(
            'INSERT INTO doctors (doctor_id, account_name, password_hash, doctor_name, department, is_active, is_admin) VALUES (?,?,?,?,?,?,?)',
            doctors
        )
        
        c.executemany(
            'INSERT INTO patients (patient_id, medical_record_number, has_chatted, status) VALUES (?,?,?,?)',
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
        print('測試資料插入完成！\n')
    except sqlite3.IntegrityError:
        print('測試資料已存在，跳過插入步驟。\n')
    
    print('=== EXPLAIN QUERY PLAN 測試 ===')
    
    def verify_plan(cursor, query):
        cursor.execute(query)
        rows = cursor.fetchall()
        for row in rows:
            print('  ', row)
            if 'SEARCH' in str(row[-1]):
                print('   => [SUCCESS] Index is working (Uses SEARCH instead of SCAN)')
            elif 'SCAN' in str(row[-1]):
                print('   => [WARNING] Index might not be used (Uses SCAN)')

    print('1. 查詢特定病患與醫師歷史紀錄 (預期使用 idx_record_lookup):')
    verify_plan(c, 'EXPLAIN QUERY PLAN SELECT * FROM record WHERE line_patient_pairs_id = 2 AND doctor_id = 1 ORDER BY checkout_date DESC')
        
    print('\n2. 查詢特定科別的醫師 (預期使用 idx_doctors_department):')
    verify_plan(c, 'EXPLAIN QUERY PLAN SELECT * FROM doctors WHERE department = "急診科"')
        
    print('\n3. 查詢特定 LINE UUID (預期使用 idx_line_patient_pairs_uuid):')
    verify_plan(c, 'EXPLAIN QUERY PLAN SELECT * FROM line_patient_pairs WHERE line_uuid = "U2e3f4g5h6"')
        
    print()
    conn.close()

if __name__ == '__main__':
    insert_test_data()