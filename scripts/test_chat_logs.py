import os
import json
import shutil
from datetime import datetime, timedelta, timezone
import sys
from pathlib import Path

# ============== 強制讓測試腳本看得到 src 資料夾 ==============
# 1. 取得目前這個測試腳本的專案根目錄
BASE_DIR = Path(__file__).resolve().parent.parent

# 2. 定義出 src 資料夾的絕對路徑
src_path = os.path.join(BASE_DIR, 'src')

# 3. 如果不在搜尋路徑中，就把它塞進去
if src_path not in sys.path:
    sys.path.append(src_path)
# ==========================================================

from chat_logs import save_chat_to_json, BASE_DIR

TEST_LINE_ID = "U1a2b3c4d5" 
TEST_PATIENT_ID = "P2026001"
LOG_DIR = os.path.join(BASE_DIR, 'chat_logs', TEST_PATIENT_ID)
tw_tz = timezone(timedelta(hours=8))

def reset_test_env():
    """環境重置：刪除舊的測試紀錄，確保每次執行結果乾淨"""
    if os.path.exists(LOG_DIR):
        shutil.rmtree(LOG_DIR)
    print("🧹 已清空舊的測試資料夾，重新開始測試...")

def print_current_logs():
    """輔助函式：列印目前資料夾狀態"""
    print(f"\n--- 目前 [{TEST_PATIENT_ID}] 資料夾狀態 ---")
    if not os.path.exists(LOG_DIR):
        print("(資料夾不存在)")
        return
    files = sorted(os.listdir(LOG_DIR))
    for f in files:
        print(f" - {f}")
    print("----------------------------------------")

def inject_timestamp_to_active(back_hours=0, custom_dt=None):
    """
    強行修改 active_session.json 時間戳記的時空特異功能。
    back_hours: 往前推幾個小時
    custom_dt: 指定特定 datetime 物件
    """
    active_path = os.path.join(LOG_DIR, 'active_session.json')
    if not os.path.exists(active_path):
        return
    
    with open(active_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    if custom_dt:
        target_iso = custom_dt.isoformat()
    else:
        target_iso = (datetime.now(tw_tz) - timedelta(hours=back_hours)).isoformat()
        
    for msg in data["messages"]:
        msg["timestamp"] = target_iso
    data["metadata"]["end_time"] = target_iso
    
    with open(active_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

# ==================== 開始模擬測試 ====================

def run_extended_test():
    reset_test_env()

    # 基準時間：設今天為 2026-05-21 22:00:00
    base_today = datetime.now(tw_tz).replace(hour=22, minute=0, second=0, microsecond=0)

    # -----------------------------------------------------------------
    # 情境一：前天（Day 1）的正常對話 -> 隨後閒置超過 1 小時
    # -----------------------------------------------------------------
    print("\n【情境一：模擬前天的對話】")
    day1_time = base_today - timedelta(days=2) # 5/19 22:00
    
    save_chat_to_json(TEST_PATIENT_ID, "user", "前天測試：我覺得傷口有點紅腫。", current_time=day1_time)
    save_chat_to_json(TEST_PATIENT_ID, "assistant", "收到，請問紅腫範圍有擴大嗎？", current_time=day1_time + timedelta(seconds=5))
    
    print("-> 已寫入前天對話，並將時間戳記設為前天。")

    # -----------------------------------------------------------------
    # 情境二：昨天（Day 2）深夜跨天對話 -> 跨到今天凌晨（Day 3）
    # -----------------------------------------------------------------
    print("\n【情境二：模擬昨天深夜訊息 (預期觸發情境一結算為 20260519_01.json)】")
    yesterday_night = base_today.replace(hour=23, minute=30) - timedelta(days=1) # 2026-05-20 23:30
    save_chat_to_json(TEST_PATIENT_ID, "user", "昨天深夜測試：醫生，不好意思半夜打擾，我發燒了。", current_time=yesterday_night)
    
    print("\n【模擬 45 分鐘後回覆 (5/21 00:15)，未滿1小時，應與昨夜對話合併在 active_session】")
    today_early = yesterday_night + timedelta(minutes=45) # 2026-05-21 00:15
    save_chat_to_json(TEST_PATIENT_ID, "assistant", "發燒請先量測體溫，若超過 38.5 度請服用退燒藥，並回診。", current_time=today_early)
    print_current_logs()

    # -----------------------------------------------------------------
    # 情境三：今天（Day 3）早上的對話 -> 觸發跨天對話結算
    # -----------------------------------------------------------------
    print("\n【情境三：今天早上傳訊息（預期觸發跨天對話結算，檔名應為昨天日期）】")
    # 模擬今天早上 09:00 傳訊息（距離凌晨 00:15 已超過 1 小時）
    today_morning = base_today.replace(hour=9, minute=0) # 5/21 09:00
    
    # 這則訊息進來時，會去結算 active 裡的跨天對話。
    # 跨天對話的第一則訊息時間是昨天的 23:30，所以結算檔名必須是昨天的日期！
    save_chat_to_json(TEST_PATIENT_ID, "user", "今天早上測試：我早上量 37.2 度，退燒了。", current_time=today_morning)
    
    print_current_logs()

    # -----------------------------------------------------------------
    # 情境四：今天（Day 3）下午的對話 -> 測試同一天內有多筆對話，序號遞增
    # -----------------------------------------------------------------
    print("\n【情境四：今天下午傳訊息（預期觸發今天早上的對話結算，成為今天第 1 個檔案）】")
    # 模擬今天下午 14:00 傳訊息（距離早上 09:00 超過 1 小時）
    today_afternoon = base_today.replace(hour=14, minute=0) # 5/21 14:00
    
    save_chat_to_json(TEST_PATIENT_ID, "user", "今天下午測試：我想要修改我的病患表單。", current_time=today_afternoon)
    
    print_current_logs()
    
    print("\n【情境五：傍晚再次傳訊息，強迫結算下午的對話（預期成為今天第 2 個檔案）】")
    # 模擬傍晚 18:00 傳訊息
    today_evening = base_today.replace(hour=21, minute=58) # 5/21 21:58
    save_chat_to_json(TEST_PATIENT_ID, "user", "今天傍晚測試：我的驗證碼好像過期了。", current_time=today_evening)
    
    print_current_logs()

if __name__ == "__main__":
    run_extended_test()