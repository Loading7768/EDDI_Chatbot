import os
import json
import sqlite3
import glob
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 抓取專案根目錄 (假設 chat_logs.py 放在 src/ 下，根目錄為上一層)
BASE_DIR = Path(__file__).resolve().parent.parent

# 設定台灣時區 (UTC+8)
tw_tz = timezone(timedelta(hours=8))

def get_db_connection():
    """建立與 hospital.db 的連線"""
    db_path = os.path.join(BASE_DIR, 'database', 'hospital.db')
    return sqlite3.connect(db_path)

def get_patients_for_line_id(line_id):
    """透過 line_id 從資料庫查詢綁定的所有病患關係及病歷號"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT p.medical_record_number, lpp.relation, p.patient_id
            FROM line_patient_pairs lpp
            JOIN patients p ON lpp.patient_id = p.patient_id
            WHERE lpp.line_uuid = ?
        """, (line_id,))
        rows = cursor.fetchall()
        # 回傳 [(medical_record_number, relation, patient_id), ...]
        return rows
    except sqlite3.Error as e:
        print(f"[ChatLog DB Error] {e}")
        return []
    finally:
        conn.close()

def get_symptoms_for_patient(line_id, relation):
    """取得某病患對應的所有症狀的聯集"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 先找出 line_patient_pairs_id
        cursor.execute("""
            SELECT line_patient_pairs_id
            FROM line_patient_pairs
            WHERE line_uuid = ? AND relation = ?
        """, (line_id, relation))
        row = cursor.fetchone()
        if not row:
            return []
        lpp_id = row[0]
        
        # 再查出該 line_patient_pairs_id 對應的 record 裡的所有症狀
        cursor.execute("""
            SELECT symptoms
            FROM record
            WHERE line_patient_pairs_id = ?
        """, (lpp_id,))
        rows = cursor.fetchall()
        
        symptoms_set = set()
        for r in rows:
            if r[0]:
                try:
                    syms = json.loads(r[0])
                    for s in syms:
                        symptoms_set.add(s)
                except Exception:
                    pass
        return list(symptoms_set)
    except sqlite3.Error as e:
        print(f"[ChatLog DB Error] {e}")
        return []
    finally:
        conn.close()

def get_patient_mrn(line_id, relation):
    """取得某病患的病歷號"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT p.medical_record_number
            FROM line_patient_pairs lpp
            JOIN patients p ON lpp.patient_id = p.patient_id
            WHERE lpp.line_uuid = ? AND lpp.relation = ?
        """, (line_id, relation))
        row = cursor.fetchone()
        return row[0] if row else None
    except sqlite3.Error as e:
        print(f"[ChatLog DB Error] {e}")
        return None
    finally:
        conn.close()

def save_chat_to_json(mrn, role, content, current_time=None):
    """
    將聊天訊息依據版本 B 格式存入 JSON，並實作 1 小時無對話即切分 Session 的機制。
    """
    if not mrn:
        print("[ChatLog] 傳入的病歷號為空，略過記錄。")
        return

    # Update database has_chatted and status based on keywords
    status_to_update = None
    if "就近至醫療院所看診" in content:
        status_to_update = "須看診"
    elif "請立即前往急診回診" in content:
        status_to_update = "須回診"

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if status_to_update:
            cursor.execute("""
                UPDATE patients
                SET has_chatted = 1, status = ?
                WHERE medical_record_number = ?
            """, (status_to_update, mrn))
        else:
            cursor.execute("""
                UPDATE patients
                SET has_chatted = 1
                WHERE medical_record_number = ? AND has_chatted = 0
            """, (mrn,))
        conn.commit()
    except sqlite3.Error as e:
        print(f"[ChatLog DB Error] Failed to update patient state: {e}")
    finally:
        conn.close()

    # 確保該病患的儲存目錄存在 ({專案根目錄}/chat_logs/{病歷號})
    log_dir = os.path.join(BASE_DIR, 'chat_logs', mrn)
    os.makedirs(log_dir, exist_ok=True)

    active_file_path = os.path.join(log_dir, 'active_session.json')

    # 關鍵修正：若有傳入自訂時間則使用自訂時間，否則使用現在時間
    now = current_time if current_time else datetime.now(tw_tz)
    
    # 初始化版本 B 的預設結構
    session_data = {
        "metadata": {
            "medical_record_num": mrn,
            "session_date": "",
            "session_sequence": None,
            "message_count": 0,
            "start_time": "",
            "end_time": ""
        },
        "messages": []
    }
    
    # 1. 讀取目前尚未結算的活躍對話 (active_session)
    if os.path.exists(active_file_path):
        try:
            with open(active_file_path, 'r', encoding='utf-8') as f:
                loaded_data = json.load(f)
                if isinstance(loaded_data, dict):
                    session_data = loaded_data
        except Exception:
            pass # 若檔案毀損或格式不符，維持預設結構

    messages = session_data.get("messages", [])

    # 2. 判斷間隔是否超過 1 小時，若超過則將舊對話結算歸檔
    if messages:
        last_msg_time_str = messages[-1].get('timestamp')
        if last_msg_time_str:
            try:
                last_msg_time = datetime.fromisoformat(last_msg_time_str)
                # 解決時區不匹配的問題 (offset-naive 與 offset-aware 比較)
                if last_msg_time.tzinfo is None and now.tzinfo is not None:
                    last_msg_time = last_msg_time.replace(tzinfo=tw_tz)
                elif last_msg_time.tzinfo is not None and now.tzinfo is None:
                    last_msg_time = last_msg_time.replace(tzinfo=None)
                time_diff = (now - last_msg_time).total_seconds()
            except Exception as te:
                print(f"[ChatLog Time Error] Failed to parse or subtract times: {te}")
                time_diff = 0

            if time_diff > 3600:
                # 觸發結算！以該 Session 第一則訊息的時間作為歸檔日期基準
                first_msg_time = datetime.fromisoformat(messages[0]['timestamp'])
                date_str = first_msg_time.strftime('%Y%m%d')

                # 尋找當天已結算的檔案數量，用來決定本次編號
                existing_files = glob.glob(os.path.join(log_dir, f"{date_str}_*.json"))
                valid_files = [f for f in existing_files if "active_session" not in f]
                seq_num = len(valid_files) + 1
                
                # 更新最終點收的 Metadata
                session_data["metadata"]["session_sequence"] = seq_num
                session_data["metadata"]["session_date"] = first_msg_time.strftime('%Y-%m-%d')
                
                # 產生檔名：如 20260521_01.json
                final_filename = f"{date_str}_{seq_num:02d}.json"
                final_filepath = os.path.join(log_dir, final_filename)

                # 寫入正式歷史紀錄檔
                with open(final_filepath, 'w', encoding='utf-8') as f:
                    json.dump(session_data, f, ensure_ascii=False, indent=4)
                
                # 舊的 Session 已歸檔，重置結構以開啟全新對話階段
                session_data = {
                    "metadata": {
                        "medical_record_num": mrn,
                        "session_date": "",
                        "session_sequence": None,
                        "message_count": 0,
                        "start_time": "",
                        "end_time": ""
                    },
                    "messages": []
                }
                messages = session_data["messages"]

    # 3. 將新訊息追加進 messages 陣列
    new_message = {
        "role": role,
        "content": content,
        "timestamp": now.isoformat()
    }
    messages.append(new_message)

    # 4. 動態更新 active_session 的 Metadata 狀態
    first_msg_time_str = messages[0]["timestamp"]
    first_msg_time = datetime.fromisoformat(first_msg_time_str)

    session_data["metadata"]["session_date"] = first_msg_time.strftime('%Y-%m-%d')
    session_data["metadata"]["message_count"] = len(messages)
    session_data["metadata"]["start_time"] = first_msg_time_str
    session_data["metadata"]["end_time"] = now.isoformat()

    # 5. 寫回 active_session.json 暫存檔
    with open(active_file_path, 'w', encoding='utf-8') as f:
        json.dump(session_data, f, ensure_ascii=False, indent=4)

def finalize_session(mrn):
    """將現有的 active_session.json 直接強制結算歸檔，並清除 active_session.json"""
    if not mrn:
        return
    log_dir = os.path.join(BASE_DIR, 'chat_logs', mrn)
    active_file_path = os.path.join(log_dir, 'active_session.json')
    
    if os.path.exists(active_file_path):
        try:
            session_data = {}
            with open(active_file_path, 'r', encoding='utf-8') as f:
                loaded_data = json.load(f)
                if isinstance(loaded_data, dict):
                    session_data = loaded_data
            messages = session_data.get("messages", [])
            if messages:
                first_msg_time = datetime.fromisoformat(messages[0]['timestamp'])
                date_str = first_msg_time.strftime('%Y%m%d')

                # 尋找當天已結算的檔案數量，用來決定本次編號
                existing_files = glob.glob(os.path.join(log_dir, f"{date_str}_*.json"))
                valid_files = [f for f in existing_files if "active_session" not in f]
                seq_num = len(valid_files) + 1
                
                # 更新最終點收的 Metadata
                session_data["metadata"]["session_sequence"] = seq_num
                session_data["metadata"]["session_date"] = first_msg_time.strftime('%Y-%m-%d')
                
                # 產生檔名：如 20260521_01.json
                final_filename = f"{date_str}_{seq_num:02d}.json"
                final_filepath = os.path.join(log_dir, final_filename)

                # 寫入正式歷史紀錄檔
                with open(final_filepath, 'w', encoding='utf-8') as f:
                    json.dump(session_data, f, ensure_ascii=False, indent=4)
            
            # 刪除 active_session.json
            os.remove(active_file_path)
            print(f"[ChatLog] Session for {mrn} successfully finalized and archived.")
        except Exception as e:
            print(f"[ChatLog Error] Failed to finalize session for {mrn}: {e}")