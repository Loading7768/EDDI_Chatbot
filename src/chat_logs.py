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
    """建立與 patient.db 的連線"""
    db_path = os.path.join(BASE_DIR, 'database', 'patient.db')
    return sqlite3.connect(db_path)

def get_patient_id(line_id):
    """透過 line_id 從資料庫查詢 medical_record_num"""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT medical_record_num FROM PATIENT WHERE line_id = ?", (line_id,))
        result = cursor.fetchone()
        return result[0] if result else None
    except sqlite3.Error as e:
        print(f"[ChatLog DB Error] {e}")
        return None
    finally:
        conn.close()

def save_chat_to_json(line_id, role, content, current_time=None):
    """
    將聊天訊息依據版本 B 格式存入 JSON，並實作 1 小時無對話即切分 Session 的機制。
    """
    patient_id = get_patient_id(line_id)
    if not patient_id:
        print(f"[ChatLog] 找不到 line_id: {line_id} 對應的病歷號，略過記錄。")
        return

    # 確保該病患的儲存目錄存在 ({專案根目錄}/chat_logs/{病歷號})
    log_dir = os.path.join(BASE_DIR, 'chat_logs', patient_id)
    os.makedirs(log_dir, exist_ok=True)

    active_file_path = os.path.join(log_dir, 'active_session.json')

    # --- 關鍵修正：若有傳入自訂時間則使用自訂時間，否則使用現在時間 ---
    now = current_time if current_time else datetime.now(tw_tz)
    
    # 初始化版本 B 的預設結構
    session_data = {
        "metadata": {
            "medical_record_num": patient_id,
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
        with open(active_file_path, 'r', encoding='utf-8') as f:
            try:
                session_data = json.load(f)
            except json.JSONDecodeError:
                pass # 若檔案毀損或為空，維持預設結構

    messages = session_data.get("messages", [])

    # 2. 判斷間隔是否超過 1 小時，若超過則將舊對話結算歸檔
    if messages:
        last_msg_time_str = messages[-1].get('timestamp')
        if last_msg_time_str:
            last_msg_time = datetime.fromisoformat(last_msg_time_str)
            time_diff = (now - last_msg_time).total_seconds()

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
                        "medical_record_num": patient_id,
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