"""
====================================================================================
 chat_logs.py — 病患對話紀錄 (Chat Log) 讀寫模組
====================================================================================

【這個檔案在整個系統中的角色】
    本模組是 LINE Bot 對話系統與資料庫之間的橋樑，主要負責兩件事：
      1. 【資料庫查詢輔助】：根據 LINE 使用者的 uuid (line_id)，查詢他/她綁定的所有
         病患關係 (line_patient_pairs)、病歷號 (medical_record_number)、以及該病患
         歷次看診記錄的症狀清單，供 bot.py 在對話中使用（例如做 RAG 檢索、決定要
         詢問哪位病患）。
      2. 【對話紀錄持久化】：把每一則 LINE 對話（病患發的訊息、AI 的回覆）以 JSON
         檔案的形式寫入磁碟，並實作「超過 1 小時無互動就視為對話結束，自動切分成
         新的一筆歷史紀錄檔」的機制（詳見 save_chat_to_json 的說明）。

    呼叫這個模組的主要對象是 src/bot.py（LINE 事件處理函式 handle_message /
    handle_postback 在對話過程中會呼叫 get_patients_for_line_id、
    get_symptoms_for_patient、save_chat_to_json、finalize_session 等函式）。
    另外 src/admin_server.py 也會「直接讀取」這裡寫出的 JSON 檔案（走檔案系統，
    不透過本模組的函式），在醫護後台的「病患對話紀錄」分頁顯示對話內容。

【資料庫 (SQLite: database/hospital.db) 相關資料表關聯】
    本模組只會「讀取」資料庫（除了 save_chat_to_json 會更新 patients 的
    has_chatted / status 欄位），不會建立新的病患或關係配對（那些是
    admin_server.py 的 nurse_create / doctor_submit 等函式的職責）。
      - line_accounts(line_account_id, uuid, name)：
            LINE 使用者帳號，uuid 就是 LINE 平台的 user_id。
      - patients(patient_id, medical_record_number, has_chatted, status)：
            病患本體，以病歷號 (medical_record_number) 作為對外识別。
      - line_patient_pairs(line_patient_pairs_id, patient_id, line_account_id, relation)：
            LINE 帳號與病患之間的關係配對（例如某帳號是某病患的「帳號本人」或「父親」）。
            一個 LINE 帳號可以同時綁定多位病患（例如家屬用同一個 LINE 帳號回覆
            多位家人的衛教對話），這也是 bot.py 需要「詢問使用者本次要諮詢哪位
            病患」的原因。
      - record(record_id, line_patient_pairs_id, checkout_date, doctor_id, symptoms)：
            每次出院/看診的正式紀錄，symptoms 欄位存的是 JSON 字串（中文症狀名稱陣列）。

【對話紀錄檔案 (JSON) 的儲存結構】
    每位病患的對話紀錄都存放在 `chat_logs/<病歷號>/` 資料夾下，內含：
      - `active_session.json`：
            目前「尚在進行中、還沒有超過 1 小時無互動」的對話。這個檔案會不斷被
            覆寫更新（每則新訊息都會 append 進去），直到被「歸檔」（見下方）
            或被程式結束時強制關閉 (finalize_session)。
      - `<YYYYMMDD>_<NN>.json`：
            已經「歸檔」的歷史對話紀錄。YYYYMMDD 是這次對話「第一則訊息」的日期，
            NN 是當天的序號（同一天可能因為多次超過 1 小時無互動而產生多筆對話，
            從 01 開始編號）。這些檔案一旦寫入就不會再被修改（唯讀歷史紀錄），
            active_session.json 也不會再更新回這些已歸檔的檔案。

    單一 JSON 檔案的內容格式（版本 B 格式）：
    ```
    {
        "metadata": {
            "medical_record_num": "病歷號",
            "session_date": "此次對話開始的日期 YYYY-MM-DD",
            "session_sequence": 當天第幾筆對話（歸檔後才會填數字，active_session 時為 null),
            "message_count": 這個檔案裡目前總共有幾則訊息,
            "start_time": 第一則訊息的 ISO8601 時間戳,
            "end_time": 最後一則訊息的 ISO8601 時間戳
        },
        "messages": [
            {"role": "user" | "assistant", "content": "訊息文字", "timestamp": "ISO8601"},
            ...
        ]
    }
    ```

【「1 小時無互動即切分」的設計原因】
    病患可能斷斷續續地與 Bot 互動（例如今天問一次、隔幾天又回來問），如果所有訊息
    都塞在同一個檔案裡，會讓：
      (a) LINE Bot 產生回覆時，需要塞給 LLM 的「歷史對話」越滾越大，Token 消耗
          與延遲都會增加；
      (b) 醫護後台在檢視對話紀錄時，很難分辨「這是同一次看診的連續對話」還是
          「病患過了幾天後又回來問了完全不相關的問題」。
    因此本模組以「連續兩則訊息之間的時間差是否超過 3600 秒 (1 小時)」作為切分點：
    一旦偵測到超過 1 小時，就把 active_session.json 目前累積的內容「結算」寫成
    一個帶日期序號的正式歷史檔案，然後清空 active_session.json、開始一段全新的對話。
====================================================================================
"""

import os
import json
import sqlite3
import glob
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 抓取專案根目錄 (假設 chat_logs.py 放在 src/ 下，根目錄為上一層)
BASE_DIR = Path(__file__).resolve().parent.parent

# 設定台灣時區 (UTC+8)
# 所有寫入 JSON 的時間戳都會用這個時區，確保「1 小時無互動」的判斷與後台顯示的
# 時間都是台灣本地時間，不會因為伺服器所在地時區不同而產生誤差。
tw_tz = timezone(timedelta(hours=8))

def get_db_connection():
    """建立與 hospital.db 的連線"""
    # 注意：這裡回傳的是「純」sqlite3.Connection（沒有設定 row_factory），
    # 因此下方的查詢都是用 index (row[0], row[1]...) 取值，而不是像
    # admin_server.py 那樣用 row['column_name'] 取值。呼叫端使用完畢後
    # 務必自行呼叫 conn.close()（本模組內每個函式都用 try/finally 確保關閉）。
    db_path = os.path.join(BASE_DIR, 'database', 'hospital.db')
    return sqlite3.connect(db_path)

def get_patients_for_line_id(line_id):
    """透過 line_id (uuid) 從資料庫查詢綁定的所有病患關係及病歷號"""
    # 用途：當使用者在 LINE 上發送訊息時，bot.py 需要知道「這個 LINE 帳號」
    # 綁定了哪些病患（可能是本人、也可能是好幾位家屬），才能決定：
    #   - 只綁定 1 位病患 → 直接開始對話，不需要詢問
    #   - 綁定 2 位以上病患 → 呼叫 send_patient_selection_quick_reply() 讓使用者
    #     用 Quick Reply 按鈕選擇本次要諮詢哪一位
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 三層 JOIN：line_accounts (以 uuid 找到帳號) → line_patient_pairs
        # (該帳號綁定的所有配對關係) → patients (取得病歷號)。
        cursor.execute("""
            SELECT p.medical_record_number, lpp.relation, p.patient_id
            FROM line_patient_pairs lpp
            JOIN patients p ON lpp.patient_id = p.patient_id
            JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
            WHERE la.uuid = ?
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
    # 用途：bot.py 的 generate_gemini_reply() 會呼叫這個函式取得病患「歷次看診」
    # 記錄過的所有症狀（去重後的聯集），再透過 build_rag_context() 找出對應的
    # 衛教 Markdown 檔案內容，組成 LLM 回覆時參考的 RAG context。
    # 之所以要「聯集」而不是只取最近一次，是因為同一位病患可能因多種症狀出院
    # （例如同時有發燒與腹瀉的衛教紀錄），對話時應該涵蓋所有相關衛教主題。
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # 先找出 line_patient_pairs_id
        # 步驟 1：先用 (line_id, relation) 這組「LINE帳號＋關係」的複合條件，
        # 精確定位出這是「哪一個」病患配對（因為同一個 LINE 帳號可能綁定多位病患，
        # 必須帶入 relation 才能確定是問哪一位）。
        cursor.execute("""
            SELECT lpp.line_patient_pairs_id
            FROM line_patient_pairs lpp
            JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
            WHERE la.uuid = ? AND lpp.relation = ?
        """, (line_id, relation))
        row = cursor.fetchone()
        if not row:
            return []
        lpp_id = row[0]

        # 再查出該 line_patient_pairs_id 對應的 record 裡的所有症狀
        # 步驟 2：用該配對 ID 查出「這位病患所有出院看診紀錄」的 symptoms 欄位
        # （每筆是 JSON 字串陣列），逐筆解析後用 set 做去重聯集。
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
                    # symptoms 欄位若是空字串、None、或格式不是合法 JSON（理論上不應該
                    # 發生，但仍防禦性處理），就直接跳過這一筆，不讓單筆壞資料炸掉整個查詢。
                    pass
        return list(symptoms_set)
    except sqlite3.Error as e:
        print(f"[ChatLog DB Error] {e}")
        return []
    finally:
        conn.close()

def get_patient_mrn(line_id, relation):
    """取得某病患的病歷號"""
    # 用途：目前在 bot.py 主流程中沒有被直接呼叫到（bot.py 是透過
    # get_patients_for_line_id 一次拿到所有 (mrn, relation, patient_id) 組合），
    # 但保留這個輔助函式供未來需要「已知 line_id + relation，只想查病歷號」的
    # 情境使用（例如可能被其他腳本或測試呼叫）。
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT p.medical_record_number
            FROM line_patient_pairs lpp
            JOIN patients p ON lpp.patient_id = p.patient_id
            JOIN line_accounts la ON lpp.line_account_id = la.line_account_id
            WHERE la.uuid = ? AND lpp.relation = ?
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
    # 這是本模組的核心函式，bot.py 在使用者發送訊息時（role='user'）以及 AI 產生
    # 回覆後（role='assistant'）都會各呼叫一次這個函式，把訊息落地成 JSON 檔案。
    #
    # 整體邏輯分為 5 個步驟（詳見下方各步驟編號註解）：
    #   0. 依訊息內容關鍵字，同步更新資料庫 patients 表的看診狀態旗標
    #   1. 讀取目前尚未結算的 active_session.json（若存在）
    #   2. 判斷「這則新訊息」與「該 session 最後一則訊息」的時間差是否超過 1 小時；
    #      若超過，先把舊的 active_session 內容結算歸檔成歷史檔案，並重置成全新的
    #      空白 session 結構
    #   3. 把這則新訊息 append 進 messages 陣列
    #   4. 更新 session 的 metadata（訊息數、起訖時間等）
    #   5. 把最終結果寫回 active_session.json
    if not mrn:
        # mrn（病歷號）是必要參數，若呼叫端沒有正確取得病歷號（例如使用者尚未
        # 完成綁定流程），就不記錄這則訊息，避免產生找不到歸屬的孤兒紀錄。
        print("[ChatLog] 傳入的病歷號為空，略過記錄。")
        return

    # Update database has_chatted and status based on keywords
    # 0. 關鍵字掃描：AI 的回覆內容若包含特定的醫療警示用語，代表 AI 判斷病患目前
    #    的狀況需要進一步就醫。這裡直接用「字串包含」比對（而非結構化的 AI 輸出
    #    格式）來偵測，所以 Prompt 設計時必須確保 AI 會原封不動地說出這兩句關鍵字，
    #    後台管理系統（admin_server.py 的 /api/chats）才能依此標記紅色警示。
    #      - 「就近至醫療院所看診」 → 狀態設為 "須看診"（較輕微，建議就醫）
    #      - 「請立即前往急診回診」 → 狀態設為 "須回診"（較緊急，建議立即回急診）
    #    注意：這個關鍵字掃描是對「所有 role 呼叫」都會執行（user 訊息與 assistant
    #    訊息都會經過這裡），但實務上這兩句警示語只會出現在 AI (assistant) 的回覆中。
    status_to_update = None
    if "就近至醫療院所看診" in content:
        status_to_update = "須看診"
    elif "請立即前往急診回診" in content:
        status_to_update = "須回診"

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if status_to_update:
            # 一旦偵測到警示關鍵字，無條件覆寫 status（即使病患之前狀態是別的值），
            # 同時把 has_chatted 標記為 1（代表這位病患已經開始使用過 LINE Bot）。
            cursor.execute("""
                UPDATE patients
                SET has_chatted = 1, status = ?
                WHERE medical_record_number = ?
            """, (status_to_update, mrn))
        else:
            # 沒有偵測到警示關鍵字時，只更新 has_chatted，且加上
            # `AND has_chatted = 0` 條件，避免每一則訊息都觸發一次不必要的
            # UPDATE（已經是 1 的話就不用再寫入，減少資料庫寫入次數）。
            # 注意這裡刻意不去動 status 欄位，避免把病患原本已經被標記的
            # "須看診"/"須回診" 等狀態，在沒有警示關鍵字的普通對話中被誤蓋回其他值。
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
    # current_time 參數主要是讓呼叫端（bot.py）可以在同一次事件處理中，讓
    # user 訊息與 assistant 訊息使用一致、可控的時間戳（避免兩次呼叫
    # datetime.now() 之間有微小的時間差、或方便測試/補寫歷史資料時指定時間）。
    now = current_time if current_time else datetime.now(tw_tz)

    # 初始化版本 B 的預設結構
    # 這是「全新 session」的預設骨架，會在以下兩種情況被使用：
    #   (a) active_session.json 根本不存在（這位病患第一次對話，或剛結算完舊的）
    #   (b) 讀取 active_session.json 失敗（檔案損毀/格式不符）時的安全回退值
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
        # 取出「目前 active_session 中最後一則訊息」的時間戳，與這次要寫入的
        # 新訊息時間 (now) 做差值比較，這就是「無互動時間」的定義：
        # 並非「距離現在的絕對時間」，而是「上一則訊息與這一則訊息之間」的間隔。
        last_msg_time_str = messages[-1].get('timestamp')
        if last_msg_time_str:
            try:
                last_msg_time = datetime.fromisoformat(last_msg_time_str)
                # 解決時區不匹配的問題 (offset-naive 與 offset-aware 比較)
                # Python 的 datetime 相減，若一個帶時區資訊 (aware) 一個不帶
                # (naive)，會直接丟出 TypeError。這裡用「補齊時區」的方式統一，
                # 確保無論舊資料是否含時區資訊都能安全相減。
                if last_msg_time.tzinfo is None and now.tzinfo is not None:
                    last_msg_time = last_msg_time.replace(tzinfo=tw_tz)
                elif last_msg_time.tzinfo is not None and now.tzinfo is None:
                    last_msg_time = last_msg_time.replace(tzinfo=None)
                time_diff = (now - last_msg_time).total_seconds()
            except Exception as te:
                print(f"[ChatLog Time Error] Failed to parse or subtract times: {te}")
                # 解析失敗時保守地當作「沒有超時」(time_diff=0)，避免因為單純的
                # 時間格式異常，就誤判為超時而不必要地把對話切斷、產生歸檔檔案。
                time_diff = 0

            if time_diff > 3600:
                # 觸發結算！以該 Session 第一則訊息的時間作為歸檔日期基準
                # 用「第一則訊息」的日期而非「現在」的日期，是因為這次 session
                # 理論上代表的是「那一天開始的對話」，即使跨過午夜才結束，
                # 檔名與 session_date 仍應歸屬於對話開始的那一天，符合直覺。
                first_msg_time = datetime.fromisoformat(messages[0]['timestamp'])
                date_str = first_msg_time.strftime('%Y%m%d')

                # 尋找當天已結算的檔案數量，用來決定本次編號
                # glob 找出同一天已經產生過的歷史檔案數量（排除 active_session
                # 本身），藉此決定這次要結算的檔案是當天第幾筆對話（序號從 1 開始）。
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
                # 這個檔案寫入之後就是「唯讀歷史紀錄」，之後不會再被本函式修改
                # （下一次結算會產生序號更大的新檔案，不會覆寫這個檔案）。
                with open(final_filepath, 'w', encoding='utf-8') as f:
                    json.dump(session_data, f, ensure_ascii=False, indent=4)

                # 舊的 Session 已歸檔，重置結構以開啟全新對話階段
                # 把 session_data / messages 重置為空骨架，讓下方步驟 3 開始時，
                # 這則「觸發超時判斷的新訊息」會成為全新 session 的第一則訊息。
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
    # 每次寫入都重新從 messages[0] 與 messages[-1] 推算 start_time / end_time /
    # message_count / session_date，而不是逐步累加，這樣即使中途發生任何異常，
    # metadata 永遠能從 messages 陣列「重新推導」出正確值，具備自我修復的特性。
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
    # 與 save_chat_to_json() 內部「因超過 1 小時而自動結算」的邏輯幾乎相同，
    # 差別在於：這個函式是被「明確的業務事件」觸發，而不是靠時間差判斷。
    # bot.py 會在以下兩種情境呼叫本函式：
    #   1. 使用者主動點擊「更換對象 🔄」或發送「更換對象」文字，切換到別的病患時
    #      → 先把「原本正在聊」的病患對話結算掉，才開始新病患的對話。
    #   2. 偵測到使用者距離上次互動已超過 1 小時 (is_timeout) 時
    #      → 同樣要先把舊對話結算掉，重置狀態機。
    #   3. 單一病患情境下（bound_patients 只有一筆），使用者第一次開始對話前，
    #      也會呼叫一次確保沒有殘留的舊 active_session。
    # 這樣可以確保「换病患」這個動作本身，就是一個明確的 session 邊界，
    # 不需要一定等到真的間隔超過 1 小時才切分。
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
                # 只有當 active_session 裡「確實有訊息內容」時才需要歸檔；
                # 若是空的 (messages 為空陣列)，代表根本沒有發生過對話，
                # 不需要產生一個空白的歷史檔案，直接跳到下方刪除 active_session.json。
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
            # 不論上面是否真的產生了歷史檔案，只要曾經存在 active_session.json
            # 就一定要刪除它，確保下一次 save_chat_to_json() 被呼叫時，會從
            #「檔案不存在」的全新狀態開始，正確地建立下一段對話。
            os.remove(active_file_path)
            print(f"[ChatLog] Session for {mrn} successfully finalized and archived.")
        except Exception as e:
            print(f"[ChatLog Error] Failed to finalize session for {mrn}: {e}")
