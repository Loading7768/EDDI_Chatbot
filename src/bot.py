"""
====================================================================================
 bot.py — LINE Bot 對話引擎 (Conversation Engine)
====================================================================================

【這個檔案在整個系統中的角色】
    這是整個「急診出院衛教 LINE Bot」系統的大腦，負責：
      1. LINE Webhook 事件處理：使用者加好友 (Follow)、發送文字訊息 (Message)、
         點擊 Quick Reply / Postback 按鈕時的所有互動邏輯，都定義在這裡。
      2. 對話狀態機 (State Machine)：管理每位 LINE 使用者目前處於「尚未選擇病患」、
         「正在選擇病患」、「正在與 AI 對話」等哪個狀態，決定下一步該怎麼回應。
      3. AI 回覆產生：整合「動態版本化的 System Prompt」＋「RAG 檢索出的衛教資料」＋
         「歷史對話與長對話摘要」，組裝成完整的上下文後，呼叫 LLM（可切換
         Gemini / OpenAI / 本機 Ollama 三種 provider 之一）取得回覆文字。
      4. 「置頂 (pinned) LINE 帳號」佇列：記錄剛完成帳號綁定、但護理站/醫師尚未
         替其建立病歷表單的 LINE 帳號，供醫護後台 (admin_server.py) 的表單建立
         頁面優先顯示，方便快速處理新病患。

    本檔案「不會」自己建立 Flask app 或 LINE SDK 的 Configuration / WebhookHandler
    實例——這些單例物件由 src/app.py 負責建立，並透過 register_line_handlers()
    這個函式「注入」進來（詳見本檔案最下方的說明），藉此避免 Python 模組命名空間
    不一致導致事件綁定失效的問題。

【依賴的其他模組】
      - chat_logs.py：查詢病患綁定關係、症狀資料、寫入/歸檔對話紀錄 JSON 檔。
      - google.generativeai (Gemini SDK)：呼叫 Gemini 雲端模型。
      - requests：直接以 HTTP 呼叫 Ollama（地端）與 OpenAI（雲端）的
        Chat Completions API（皆為 OpenAI 相容格式）。
      - linebot.v3 SDK：LINE Messaging API 的訊息物件、事件型別定義。

【本檔案的邏輯分區（依照程式碼中的區塊標題）】
      0. LLM Provider 設定與底層 API 呼叫封裝（Ollama / OpenAI 兩個 HTTP 呼叫函式）
      1. 使用者對話狀態管理 (Session State Management)：讀寫 data/<line_id>_state.json
      2. 動態 Prompt 與 RAG 檢索：讀取目前啟用中的 Prompt 版本、依症狀組裝衛教參考資料
      3. Token 管理與對話摘要：控制餵給 LLM 的歷史對話長度，超過上限時自動摘要壓縮
      4. AI 回覆產生器：整合以上所有素材，依 Provider 分流呼叫對應的 LLM API
      5. LINE Bot 輔助方法：組裝 Quick Reply 按鈕等共用邏輯
      6. LINE Webhook 事件處理器：handle_follow / handle_message / handle_postback
      7. 事件監聽動態註冊方法：register_line_handlers()（由 app.py 呼叫）
      8. Legacy/CLI 介面相容方法：保留給舊版測試腳本使用的抽象類別與包裝函式

【對話狀態機總覽】（詳見第 6 區塊 handle_message 的完整流程說明）
    每位 LINE 使用者 (line_id) 在 data/<line_id>_state.json 中都有一筆狀態，
    包含四個欄位：
      - medical_record_number：目前對話對象的病歷號（None 代表尚未選定）
      - relation：目前對話對象與此 LINE 帳號的關係（例如「帳號本人」「父親」）
      - last_interaction：最後一次互動時間（ISO8601），用於判斷是否超過 1 小時逾時
      - status：None（初始）/ 'SELECTING_PATIENT'（等待使用者用 Quick Reply
        選擇病患）/ 'CHATTING'（已選定病患，正在與 AI 對話中）
====================================================================================
"""

import os
import json
import sqlite3
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path
from abc import ABC, abstractmethod
import google.generativeai as genai
from dotenv import load_dotenv
import requests  # 用於地端 Ollama API 呼叫

# 抓取專案根目錄
# bot.py 位於 <root>/src/bot.py，往上兩層即為專案根目錄，所有資料檔案路徑
# (data/, chat_logs/, assets/, database/) 都是以此為基準組出絕對路徑。
BASE_DIR = Path(__file__).resolve().parent.parent

# 載入環境變數
# 讀取專案根目錄下的 .env 檔案，取得 API 金鑰與各種可調參數（LLM_PROVIDER、
# OLLAMA_BASE_URL 等），讓開發者可以在不修改程式碼的情況下切換設定。
env_path = BASE_DIR / ".env"
load_dotenv(dotenv_path=env_path)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "YOUR_GEMINI_KEY_HERE")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "YOUR_OPENAI_KEY_HERE")

# === [模型提供者設定] ===
# LLM_PROVIDER 是整個 AI 回覆邏輯的「總開關」，決定要用哪一種語言模型服務。
# 支援的值（皆可用底下兩個別名的任一個）：
#   - "gemini"              → 使用 Google Gemini 雲端 API（原始版本，也是預設的 fallback 邏輯路徑）
#   - "local_gpt"/"ollama"  → 使用本機/地端部署的 Ollama（跑開源模型，例如 gpt-oss:20b），
#                              適合對資料隱私要求高、或沒有雲端 API 額度的情境
#   - "cloud_gpt"/"openai"  → 使用 OpenAI 官方雲端 API
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "cloud_gpt")  # "gemini" (雲端), "local_gpt"/"ollama" (地端), "cloud_gpt"/"openai" (雲端)

# === [Ollama 地端模型設定與 API 呼叫] ===
# Ollama 預設會在本機啟動一個相容 OpenAI API 格式的伺服器，預設埠號 11434，
# 路徑加上 /v1 即可直接沿用 OpenAI SDK/呼叫慣例的 Chat Completions 介面。
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gpt-oss:20b")

# === [OpenAI 雲端模型設定與 API 呼叫] ===
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4-mini")

def call_ollama_chat_api(messages: list[dict], model: str = OLLAMA_MODEL, temperature: float = 0.7) -> str:
    """呼叫地端 Ollama Chat Completions API (OpenAI 相容)"""
    # messages 格式為標準 OpenAI Chat 格式：[{"role": "system"/"user"/"assistant", "content": "..."}]
    # Authorization 標頭雖然帶了 Bearer token，但 Ollama 本機服務通常不會真的驗證這個值，
    # 這裡填入 "ollama" 只是為了符合 OpenAI 用戶端函式庫/中介層可能會強制要求帶入
    # Authorization 標頭的慣例，避免某些相容層因缺少此標頭而報錯。
    url = f"{OLLAMA_BASE_URL.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer ollama"
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature
    }
    try:
        # timeout=60：本機大型模型（如 20B 參數）生成速度可能較慢，給予較寬鬆的等待時間，
        # 避免因為模型推論時間較長而提前判定逾時失敗。
        response = requests.post(url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        res_json = response.json()
        return res_json["choices"][0]["message"]["content"].strip()
    except Exception as e:
        # 任何錯誤（連線失敗、逾時、模型未下載、回應格式異常等）都會被這裡攔截，
        # 印出錯誤到伺服器日誌方便除錯，同時回傳一則對病患友善的中文錯誤訊息，
        # 確保即使後端出錯，使用者在 LINE 上收到的仍是可理解的訊息而非程式錯誤堆疊。
        print(f"[Ollama Error] API call failed: {e}")
        return "抱歉，地端 AI 系統暫時無法回應，請確認 Ollama 是否已啟動且已下載 gpt-oss:20b 模型。"

def call_openai_chat_api(messages: list[dict], model: str = OPENAI_MODEL, temperature: float = 0.7) -> str:
    """呼叫雲端 OpenAI Chat Completions API"""
    # 與 call_ollama_chat_api 幾乎相同的呼叫模式，差異只在網址固定指向 OpenAI 官方
    # API 端點，且 Authorization 帶的是真正需要驗證的 OPENAI_API_KEY。
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_API_KEY}"
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        res_json = response.json()
        return res_json["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"[OpenAI Error] API call failed: {e}")
        return "抱歉，雲端 GPT 系統暫時無法回應，請確認 .env 中的 OPENAI_API_KEY 是否正確且額度充足。"


# 時區設定
tw_tz = timezone(timedelta(hours=8))

# ── 引入 LINE SDK 相關模組 ───────────────────────────────────────────────────
from linebot.v3.messaging import (
    ApiClient,
    MessagingApi,
    ReplyMessageRequest,
    TextMessage,
    QuickReply,
    QuickReplyItem,
    PostbackAction
)
from linebot.v3.webhooks import (
    MessageEvent,
    FollowEvent,
    PostbackEvent,
    TextMessageContent
)

import chat_logs

# ── 全域變數 ──────────────────────────────────────────────────────────────────
# configuration 會在 register_line_handlers 被呼叫時從 app.py 傳入並初始化
# 在模組被 import 的當下，configuration 只是個 None 佔位符；必須等到 app.py
# 執行 `bot.register_line_handlers(line_handler, configuration)` 之後，
# 這個全域變數才會被賦予真正的 LINE Configuration 物件。所有需要呼叫 LINE
# Messaging API 的函式（handle_message、handle_postback）都是透過
# `global configuration` 讀取這個模組層級的變數。
configuration = None

# ── Pinned LINE Accounts (Reverse Queue, MAX_PINNED = 10) ────────────────────
# 「置頂佇列」用途：當使用者在 LINE 上發送 "Bind" 完成帳號綁定後，代表這是一位
# 剛剛加入的新病患/家屬，但此時醫護人員尚未替他/她建立正式的病歷/出院表單。
# 為了讓護理站在 admin_server.py 的「建立表單」頁面能快速找到「這些剛綁定、
# 還沒建檔」的 LINE 帳號（而不必在所有 LINE 好友清單中人工搜尋），這裡維護一個
# 「最新在最前面、最多保留 10 筆」的反向佇列，並持久化存成 JSON 檔案
# （data/pinned_line_accounts.json），確保伺服器重啟後仍不會遺失佇列狀態。
# 佇列的生命週期：
#   加入佇列 (add_to_pinned)   → 使用者在 LINE 傳送 "Bind" 完成綁定時觸發
#   移出佇列 (remove_from_pinned) → 護理站在 admin_server.py 呼叫 nurse_create
#                                    成功建立病歷草稿後觸發（見 admin_server.py）
PINNED_FILE = os.path.join(BASE_DIR, 'data', 'pinned_line_accounts.json')
MAX_PINNED = 10
pinned = []
# pinned_lock：因為 Flask 開發伺服器/多執行緒環境下，可能同時有多個請求
# (LINE Webhook 事件 與 admin 後台 API) 同時存取這個共用的 JSON 檔案與
# 記憶體中的 pinned 清單，用一個 threading.Lock 確保「讀取檔案 → 修改 →
# 寫回檔案」這一整段操作不會被其他執行緒打斷而造成競態 (race condition)。
pinned_lock = threading.Lock()

def _load_pinned_from_file() -> list:
    """從 JSON 檔案載入 pinned 清單"""
    # 每次都「重新從檔案讀取」而不是完全信任記憶體中的 `pinned` 全域變數，
    # 是因為這個 JSON 檔案可能被其他行程（例如另一個 worker process）同時修改，
    # 以檔案內容為單一事實來源 (source of truth) 較為保險。
    if os.path.exists(PINNED_FILE):
        try:
            with open(PINNED_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, list):
                    # 防禦性過濾：只保留看起來像合法整數 ID 的項目，並統一轉型為 int，
                    # 避免檔案裡混入非預期型別（例如手動編輯壞掉）導致後續比較失敗。
                    return [int(x) for x in data if isinstance(x, (int, str)) and str(x).isdigit()]
        except Exception as e:
            print(f"[Pinned Load Error] {e}")
    return []

def _save_pinned_to_file(pinned_list: list):
    """將 pinned 清單寫入 JSON 檔案"""
    # 採用「寫到暫存檔 (.tmp) 再 os.replace 原子性覆蓋」的寫入方式，避免寫入過程中
    # 若程式意外中斷（例如伺服器重啟），導致正式檔案處於「寫了一半」的損毀狀態；
    # os.replace 在大多數作業系統上是原子操作，要麼完全成功覆蓋、要麼完全不動。
    try:
        os.makedirs(os.path.dirname(PINNED_FILE), exist_ok=True)
        temp_file = f"{PINNED_FILE}.tmp"
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(pinned_list, f, ensure_ascii=False, indent=2)
        os.replace(temp_file, PINNED_FILE)
    except Exception as e:
        print(f"[Pinned Save Error] {e}")

def add_to_pinned(line_account_id: int):
    """將 line_account_id 加入置頂隊列 (反向隊列，最新在最前，上限 10)。若已在置頂中則不變動。"""
    # 呼叫時機：handle_message() 處理 "Bind" 綁定指令成功後呼叫（不論是新綁定
    # 還是帳號已存在），確保「使用者主動來綁定」這件事會被護理站注意到。
    global pinned
    with pinned_lock:
        current_pinned = _load_pinned_from_file()
        try:
            acc_id = int(line_account_id)
        except (ValueError, TypeError):
            return
        if acc_id not in current_pinned:
            # insert(0, ...)：新加入的帳號放在清單最前面 → 這就是「反向佇列」
            # （Reverse Queue）的意思：越新綁定的帳號，在列表最上方越優先被看到。
            current_pinned.insert(0, acc_id)
            if len(current_pinned) > MAX_PINNED:
                # 超過上限時，直接裁掉「最舊」的尾端項目，只保留最新的 10 筆，
                # 因為這個佇列的目的是「提醒最近發生的事」，太舊的沒有繼續保留的意義。
                current_pinned = current_pinned[:MAX_PINNED]
            _save_pinned_to_file(current_pinned)
        pinned = current_pinned

def remove_from_pinned(line_account_id: int):
    """若 line_account_id 在置頂清單中，則將其移除。"""
    # 呼叫時機：admin_server.py 的 nurse_create() 成功替該 LINE 帳號建立病歷
    # 草稿之後呼叫，代表這個「新綁定待處理」的提醒已經被護理站處理掉了，
    # 從置頂清單移除，避免持續佔用置頂版面。
    global pinned
    with pinned_lock:
        current_pinned = _load_pinned_from_file()
        try:
            acc_id = int(line_account_id)
        except (ValueError, TypeError):
            return
        if acc_id in current_pinned:
            current_pinned.remove(acc_id)
            _save_pinned_to_file(current_pinned)
        pinned = current_pinned

def get_pinned() -> list:
    """取得當前置頂清單副本。"""
    # 供 admin_server.py 的 /api/forms/get_line_accounts 端點呼叫，讓前端知道
    # 哪些 line_account_id 應該顯示「置頂」樣式（例如加上特殊標記或排到列表最前）。
    global pinned
    with pinned_lock:
        pinned = _load_pinned_from_file()
        return list(pinned)

# ── 1. 狀態管理 (Session State Management) ───────────────────────────────────────
# 這一整區負責維護「每位 LINE 使用者目前對話進行到哪個階段」的狀態機資料。
# 由於 LINE Webhook 是「無狀態」的 HTTP 請求（每次收到訊息都是獨立的一次 POST），
# 若不把狀態持久化到檔案，伺服器每次重啟或多個請求交錯處理時就無法得知「這個人
# 上一句話說了什麼、現在該進入哪個流程」，因此才需要這一整套以檔案為基礎的
# 簡易 session 儲存機制（相較於資料庫，選擇用 JSON 檔案是因為狀態本身生命週期短、
# 結構簡單，不需要額外的資料表）。
STATE_DIR = os.path.join(BASE_DIR, 'data')
os.makedirs(STATE_DIR, exist_ok=True)

def get_user_state(line_id):
    """讀取 user 的當前狀態"""
    # 每位使用者的狀態各自存成一個獨立檔案：data/<line_id>_state.json。
    # 若檔案不存在或讀取失敗，回傳一個「全新初始狀態」的預設字典，確保呼叫端
    # 永遠能拿到結構一致的 dict，不需要額外判斷 None。
    state_file = os.path.join(STATE_DIR, f"{line_id}_state.json")
    if os.path.exists(state_file):
        try:
            with open(state_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "medical_record_number": None,
        "relation": None,
        "last_interaction": None,
        "status": None  # None, 'SELECTING_PATIENT', 'CHATTING'
    }

def save_user_state(line_id, state):
    """儲存 user 的當前狀態"""
    state_file = os.path.join(STATE_DIR, f"{line_id}_state.json")
    try:
        with open(state_file, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=4)
    except Exception as e:
        print(f"[State Error] Failed to save state for {line_id}: {e}")

def reset_user_state(line_id):
    """清除 user 的狀態檔案"""
    # 呼叫時機：使用者要求「更換對象」或偵測到逾時時，直接刪除狀態檔案，
    # 讓下一次 get_user_state() 讀取時自然回退到初始狀態，等同於「登出重來」。
    state_file = os.path.join(STATE_DIR, f"{line_id}_state.json")
    if os.path.exists(state_file):
        try:
            os.remove(state_file)
        except Exception:
            pass

# ── 2. 動態 Prompt 與 RAG 檢索 ────────────────────────────────────────────────
# 這一區負責組裝「餵給 LLM 的系統指令與參考資料」，是連接「醫護後台 Prompt 版本
# 管理」與「衛教資料管理」（都在 admin_server.py）跟「實際對話」之間的橋樑。
def get_prompt_version() -> str:
    """讀取 prompt 配置文件中的當前版本"""
    # data/prompt_config.json 由 admin_server.py 的 Prompt 版本管理功能維護，
    # current_version 欄位記錄「目前啟用中」的版本檔名（例如 "prompt_003.md"）。
    # 管理員在後台切換/回溯/刪除版本時，實際上就是在改這個檔案的內容，
    # 因此 LINE Bot 對話時永遠會即時反映管理員最新設定的版本，無需重啟伺服器。
    path = os.path.join(BASE_DIR, 'data', 'prompt_config.json')
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                config = json.load(f)
                return config.get("current_version", "prompt_001.md") # 如果找不到 "current_version" 就直接給 "prompt_001.md"
        except Exception:
            pass
    return "prompt_001.md"

def load_prompt_template(version: str) -> str:
    """載入對應版本的 Prompt 內容"""
    # 依版本檔名去 assets/prompts/ 資料夾讀取實際的 Prompt 文字內容（Markdown 檔）。
    # 若指定版本檔案不存在（例如版本已被刪除但 config 尚未更新、或發生競態），
    # 會降級 (fallback) 使用 prompt_001.md（原始、永不刪除的版本）；
    # 若連 prompt_001.md 都讀不到，最後回退到程式碼內硬編的極簡預設字串，
    # 確保無論如何都不會讓 LLM 收到空白的系統指令。
    prompt_file = os.path.join(BASE_DIR, 'assets', 'prompts', version)
    if os.path.exists(prompt_file):
        try:
            with open(prompt_file, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception:
            pass
    # Fallback 到 prompt_001.md
    fallback_file = os.path.join(BASE_DIR, 'assets', 'prompts', 'prompt_001.md')
    if os.path.exists(fallback_file):
        try:
            with open(fallback_file, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception:
            pass
    return "請根據以下衛教資料回答病患：\n【參考資訊】:\n{context}"

def load_symptom_filename_map() -> dict[str, str]:
    """從 assets/discharge/category.json 動態讀取衛教主題與檔名的對照表"""
    # category.json 的結構是巢狀的「部位 → 類別 → {filename}」（由
    # admin_server.py 的衛教資料管理功能維護）。這裡把它「攤平」成一個
    # 簡單的 {類別中文名稱: 檔名} 對照表，方便下方 build_rag_context() 用
    # 病患的症狀名稱直接查表找出對應的 Markdown 檔名，不需要關心部位層級。
    category_file = os.path.join(BASE_DIR, 'assets', 'discharge', 'category.json')
    mapping = {}
    if os.path.exists(category_file):
        try:
            with open(category_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for _cat, items in data.items():
                    if isinstance(items, dict):
                        for sym_name, info in items.items():
                            if isinstance(info, dict) and "filename" in info:
                                mapping[sym_name] = info["filename"]
        except Exception as e:
            print(f"[RAG Error] Failed to load category.json: {e}")
    return mapping

def build_rag_context(symptoms: list[str]) -> str:
    """根據病患的症狀中文名稱，讀取對應的英文 Markdown 檔案並合併"""
    # 這是本檔案 RAG（Retrieval-Augmented Generation，檢索增強生成）機制的核心：
    # 不是把所有衛教資料全部塞給 LLM（那樣會浪費大量 Token 且可能引入無關資訊），
    # 而是「只挑出與這位病患本次症狀相關」的衛教文章，合併成參考資料區塊，
    # 讓 LLM 的回覆更精準地聚焦在病患真正需要知道的照護資訊上。
    if not symptoms:
        return "無對應的衛教參考資料。請根據通用醫療常識回答。"

    symptom_map = load_symptom_filename_map()
    if not symptom_map:
        return "無對應的衛教參考資料。請根據通用醫療常識回答。"

    matched_files = set()
    for sym in symptoms:
        for topic_zh, filename in symptom_map.items():
            # 比對邏輯採用「模糊子字串比對」（sym == topic_zh 完全相同，或互為子字串），
            # 是因為病患看診紀錄裡存的症狀文字，與衛教類別命名可能不會逐字完全一致
            # （例如病歷寫「腹瀉」，衛教類別可能叫「急性腹瀉」），用子字串比對可以
            # 提高配對成功率，避免因為文字略有差異就完全找不到對應衛教資料。
            if sym == topic_zh or sym in topic_zh or topic_zh in sym:
                matched_files.add(filename)
                break

    if not matched_files:
        return "無對應的衛教參考資料。請根據通用醫療常識回答。"

    parts = []
    discharge_dir = os.path.join(BASE_DIR, 'assets', 'discharge')
    for filename in sorted(matched_files):
        # sorted(matched_files)：固定順序輸出，讓同一組症狀每次組出的 RAG context
        # 順序一致，避免因為 set 的無序特性造成每次呼叫組出的 Prompt 不穩定
        # （雖然內容相同，但順序不同可能造成 LLM 回覆的些微差異、也不利於除錯比對）。
        filepath = os.path.join(discharge_dir, filename)
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                    parts.append(f"【主題檔案：{filename}】\n{content}")
            except Exception as e:
                print(f"[RAG Error] Failed to read {filename}: {e}")

    if not parts:
        return "無對應的衛教參考資料。請根據通用醫療常識回答。"

    return "\n\n".join(parts)

# ── 3. Token 管理與對話摘要 ──────────────────────────────────────────────────
# 這一區解決的問題是：病患可能與 Bot 進行了非常多次、跨越許多天的對話，若每次
# 呼叫 LLM 都把「所有歷史對話」原封不動地整段送進去，會導致：
#   (a) Token 用量隨對話次數線性成長，最終超出模型的 context window 上限；
#   (b) 雲端 API 費用與延遲都會隨之增加。
# 解決策略：優先保留「最近幾次」完整對話（最多 5 個 session 檔案）讓 LLM 能看到
# 逐字的細節，較久以前的對話則透過 LLM 自己先「摘要」壓縮成一小段文字，
# 大幅降低歷史對話占用的 Token 量，同時仍保留關鍵資訊的連貫性。
def generate_history_summary(older_messages: list[dict], model_name: str) -> str:
    """產生較早對話記錄的精簡摘要 (同時保留原 Gemini 與新地端 Ollama)"""
    # 把「較舊的訊息」格式化成一段可讀的逐字稿文字（角色標籤用中文「病患」/
    # 「衛教助手」而非 user/assistant，讓摘要用的 Prompt 更貼近自然語言），
    # 再請 LLM 用一段 150 字以內的摘要總結這些內容。
    formatted_history = []
    for msg in older_messages:
        role_name = "病患" if msg.get("role") == "user" else "衛教助手"
        formatted_history.append(f"{role_name}：{msg.get('content')}")
    history_str = "\n".join(formatted_history)

    prompt = (
        "您是一位急診科醫療記錄助理。請將以下對話內容精簡地總結為一段病患的居家照護提問與助手回覆的摘要，字數在 150 字以內。\n\n"
        "對話內容：\n"
        f"{history_str}\n\n"
        "請直接輸出總結內容，不要有任何多餘的解釋："
    )

    # === [Ollama 地端模型分支] ===
    # 注意：摘要生成本身也是呼叫一次 LLM，因此同樣要依照 LLM_PROVIDER 設定分流，
    # 確保無論主要對話走哪個 provider，摘要這個「輔助性」呼叫也走同一個 provider，
    # 不會出現「主對話用地端模型，但摘要卻打了一次雲端 API」這種不一致、
    # 甚至可能造成非預期費用或資安顧慮的情況。
    if LLM_PROVIDER in ["ollama", "local_gpt"]:
        messages = [{"role": "user", "content": prompt}]
        return call_ollama_chat_api(messages, model=OLLAMA_MODEL)

    # === [OpenAI 雲端模型分支] ===
    elif LLM_PROVIDER in ["openai", "cloud_gpt"]:
        messages = [{"role": "user", "content": prompt}]
        return call_openai_chat_api(messages, model=OPENAI_MODEL)

    # === [原 Gemini 雲端模型分支] ===
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        model = genai.GenerativeModel(model_name=model_name)
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        print(f"[Summary Error] Failed to generate summary with Gemini: {e}")
        return "（較早對話記錄因長度限制已被系統簡化）"

def get_chat_history_and_summary(mrn: str, prompt_ver: str, model_name: str) -> tuple[list[dict], str]:
    """
    從 chat_logs/<mrn>/ 下所有 *.json 重構對話歷史，並處理 Token 限制。
    當 tokens 不足時，完整傳給 LLM 的只剩下最新的 5 次對話（5 個 json 檔），
    其餘的 json 則生成精簡總結 (Summary)。
    注意：此處需將最新一條剛寫入的 user 訊息剔除，只載入先前的歷史。
    """
    # 這個函式回傳一個 tuple：(llm_history, summary_text)
    #   - llm_history：可以直接餵給 LLM 當作「多輪對話歷史」的訊息陣列
    #     （格式依 provider 不同，Gemini 用 {"role","parts"}，OpenAI/Ollama 用
    #     {"role","content"}）
    #   - summary_text：若歷史過長被摘要處理過，這裡會是摘要文字；
    #     若完全不需要摘要（歷史本身不長），則回傳空字串 ""
    import glob
    log_dir = os.path.join(BASE_DIR, 'chat_logs', mrn)
    if not os.path.isdir(log_dir):
        return [], ""

    sessions = []
    for filepath in glob.glob(os.path.join(log_dir, '*.json')):
        # 掃描該病患資料夾下「所有」的 json 檔案，包含已歸檔的歷史檔案
        # 以及目前尚在進行中的 active_session.json（因為呼叫這個函式的時間點，
        # 使用者剛送出的最新訊息通常已經先被 save_chat_to_json 寫進
        # active_session.json 了，所以下方會把「最新一則」訊息剔除）。
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)

            messages = data.get("messages", [])
            if not messages:
                continue

            meta = data.get("metadata", {})
            start_time_str = meta.get("start_time", "")
            if not start_time_str:
                # 若 metadata 缺少 start_time（理論上不應發生，屬防禦性處理），
                # 退而使用檔案的最後修改時間當作排序依據的替代值。
                try:
                    mtime = os.path.getmtime(filepath)
                    start_time = datetime.fromtimestamp(mtime, tz=tw_tz)
                except Exception:
                    start_time = datetime.min.replace(tzinfo=tw_tz)
            else:
                try:
                    start_time = datetime.fromisoformat(start_time_str)
                except Exception:
                    start_time = datetime.min.replace(tzinfo=tw_tz)

            sessions.append({
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "start_time": start_time,
                "messages": messages
            })
        except Exception as e:
            print(f"[ChatLog Load Error] Failed to read {os.path.basename(filepath)}: {e}")

    if not sessions:
        return [], ""

    # 依時間由舊到新排序
    sessions.sort(key=lambda s: s["start_time"])

    # 最新的一則訊息剔除（因為即將透過 chat.send_message 送出）
    # 最新對話是最後一個 session (sessions[-1])
    # 這是關鍵的「去重」處理：因為呼叫這個函式之前，bot.py 已經先呼叫
    # chat_logs.save_chat_to_json() 把「使用者剛剛發的這句話」寫入了
    # active_session.json（也就是排序後最新的那個 session），若不剔除，
    # 這句話會同時出現在「歷史對話」與「即將透過 send_message() 傳入」的
    # 當前訊息中，造成 LLM 看到重複的內容。
    all_candidate_messages = []
    for i, s in enumerate(sessions):
        msgs = s["messages"]
        if i == len(sessions) - 1:
            all_candidate_messages.extend(msgs[:-1])
        else:
            all_candidate_messages.extend(msgs)

    # 轉為 LLM 歷史格式 (區分 Gemini 與 OpenAI/Ollama 格式)
    llm_history = []
    for msg in all_candidate_messages:
        if LLM_PROVIDER in ["ollama", "local_gpt", "openai", "cloud_gpt"]:
            # OpenAI/Ollama 格式 (role: user/assistant, content: str)
            role = "assistant" if msg.get("role") == "assistant" else "user"
            llm_history.append({
                "role": role,
                "content": msg.get("content", "")
            })
        else:
            # Gemini 格式 (role: user/model, parts: [str])
            # Gemini SDK 的角色命名與 OpenAI 不同：assistant 要改叫 "model"，
            # 且內容要包在 "parts" 陣列中而非單一字串，這裡做格式轉換。
            role = "model" if msg.get("role") == "assistant" else "user"
            llm_history.append({
                "role": role,
                "parts": [msg.get("content", "")]
            })

    # 計算 Token 數
    MAX_HISTORY_TOKENS = 6000
    token_count = 0
    model = None

    if LLM_PROVIDER in ["ollama", "local_gpt", "openai", "cloud_gpt"]:
        # 地端模型 / OpenAI 使用備用字數估計 (每個 token 約為 1.5 個字元)
        # OpenAI/Ollama 的 API 呼叫本身不提供簡易的「本地端計算 token 數」工具
        # （tiktoken 等函式庫在此專案未引入），因此用「字元數 / 1.5」的經驗法則
        # 粗略估計中文/英文混合文字的 token 數，雖不精確，但足以作為是否需要
        # 觸發摘要壓縮的判斷依據。
        total_chars = sum(len(msg.get("content", "")) for msg in all_candidate_messages)
        token_count = int(total_chars / 1.5)
    else:
        if llm_history:
            try:
                # Gemini SDK 提供 model.count_tokens()，可以精確計算實際 token 數，
                # 因此走 Gemini 分支時優先使用官方方法，比字元估算更準確。
                genai.configure(api_key=GEMINI_API_KEY)
                model = genai.GenerativeModel(model_name=model_name)
                token_count = model.count_tokens(llm_history).total_tokens
            except Exception as e:
                print(f"[Token Count Error] Failed to count tokens: {e}")
                # 備用估算：中文/英文字數除以 1.5
                total_chars = sum(len(msg.get("content", "")) for msg in all_candidate_messages)
                token_count = int(total_chars / 1.5)

    # 判斷是否需要進行總結 (當 token 超過限制時)
    if token_count > MAX_HISTORY_TOKENS:
        chosen_k = 0
        # 從「最近 5 個 session（或全部 session，取較小值）」開始，逐步減少
        # k（保留的完整 session 數），每減少一次就重新計算這 k 個 session 的
        # token 量，直到找到一個「保留 k 個完整 session 仍不超過 Token 上限」
        # 的最大 k 值。這是一種貪婪 (greedy) 搜尋：優先盡可能保留較多完整、
        # 逐字的近期對話，只有在真的塞不下時才進一步縮減。
        # 嘗試從 min(5, len(sessions)) 遞減至 0
        for k in range(min(5, len(sessions)), -1, -1):
            if k == 0:
                chosen_k = 0
                break

            recent_sessions = sessions[-k:]
            recent_candidate_messages = []
            for idx, s in enumerate(recent_sessions):
                msgs = s["messages"]
                if idx == len(recent_sessions) - 1:
                    recent_candidate_messages.extend(msgs[:-1])
                else:
                    recent_candidate_messages.extend(msgs)

            k_llm_history = []
            for msg in recent_candidate_messages:
                if LLM_PROVIDER in ["ollama", "local_gpt", "openai", "cloud_gpt"]:
                    role = "assistant" if msg.get("role") == "assistant" else "user"
                    k_llm_history.append({
                        "role": role,
                        "content": msg.get("content", "")
                    })
                else:
                    role = "model" if msg.get("role") == "assistant" else "user"
                    k_llm_history.append({
                        "role": role,
                        "parts": [msg.get("content", "")]
                    })

            k_token_count = 0
            if k_llm_history:
                if LLM_PROVIDER in ["ollama", "local_gpt", "openai", "cloud_gpt"]:
                    total_chars = sum(len(msg.get("content", "")) for msg in recent_candidate_messages)
                    k_token_count = int(total_chars / 1.5)
                else:
                    if model is not None:
                        try:
                            k_token_count = model.count_tokens(k_llm_history).total_tokens
                        except Exception as e:
                            print(f"[Token Count Error] Failed to count tokens in loop: {e}")
                            total_chars = sum(len(msg.get("content", "")) for msg in recent_candidate_messages)
                            k_token_count = int(total_chars / 1.5)
                    else:
                        total_chars = sum(len(msg.get("content", "")) for msg in recent_candidate_messages)
                        k_token_count = int(total_chars / 1.5)

            if k_token_count <= MAX_HISTORY_TOKENS:
                chosen_k = k
                break

        # 根據 chosen_k 分配完整對話歷史與摘要內容
        if chosen_k > 0:
            # 找到了一個可行的 k：把「最近 k 個 session」當作完整歷史直接保留
            # (llm_history)，把「更早的 session」全部丟給 generate_history_summary()
            # 壓縮成摘要文字 (older_messages)。
            recent_sessions = sessions[-chosen_k:]
            older_sessions = sessions[:-chosen_k]

            recent_candidate_messages = []
            for idx, s in enumerate(recent_sessions):
                msgs = s["messages"]
                if idx == len(recent_sessions) - 1:
                    recent_candidate_messages.extend(msgs[:-1])
                else:
                    recent_candidate_messages.extend(msgs)

            llm_history = []
            for msg in recent_candidate_messages:
                if LLM_PROVIDER in ["ollama", "local_gpt", "openai", "cloud_gpt"]:
                    role = "assistant" if msg.get("role") == "assistant" else "user"
                    llm_history.append({
                        "role": role,
                        "content": msg.get("content", "")
                    })
                else:
                    role = "model" if msg.get("role") == "assistant" else "user"
                    llm_history.append({
                        "role": role,
                        "parts": [msg.get("content", "")]
                    })

            older_messages = []
            for s in older_sessions:
                older_messages.extend(s["messages"])
        else:
            # chosen_k == 0, 不留下任何完整歷史對話
            # 代表即使只保留最近 1 個 session，Token 量仍然超標（極端情況，
            # 例如單次對話內容異常龐大），此時完全不保留任何逐字歷史，
            # 把「所有」歷史訊息都交給摘要處理，只靠一段摘要文字提供上下文。
            llm_history = []
            older_messages = []
            for idx, s in enumerate(sessions):
                msgs = s["messages"]
                if idx == len(sessions) - 1:
                    older_messages.extend(msgs[:-1])
                else:
                    older_messages.extend(msgs)

        summary_text = generate_history_summary(older_messages, model_name)
        return llm_history, summary_text
    else:
        # 不需要進行總結
        # Token 量在上限之內，直接把「全部歷史」原封不動地當作 llm_history 回傳，
        # 不產生摘要（summary_text 為空字串）。
        return llm_history, ""

# ── 4. AI 回覆產生器 (支援 Gemini 與 Ollama gpt-oss) ─────────────────────────
def generate_gemini_reply(user_id: str, mrn: str, relation: str, user_message: str) -> str:
    """整合動態 Prompt、RAG、歷史對話與摘要，呼叫 LLM 產生回覆 (相容原有名稱以避免外部呼叫報錯)"""
    # 函式名稱雖然還叫 generate_gemini_reply（保留舊名稱是為了不破壞既有呼叫端
    # 程式碼，例如下方 Legacy 相容區塊的 get_ai_response()），但實際上這個函式
    # 現在是「所有 LLM Provider」共用的統一入口，會依 LLM_PROVIDER 設定分流到
    # Gemini / OpenAI / Ollama 三者之一。
    #
    # 整體組裝流程（1~6 步驟對照下方程式碼註解編號）：
    #   1. 取得目前啟用中的 Prompt 版本與其文字內容
    #   2. 依病患症狀做 RAG 檢索，取得相關衛教資料文字
    #   3. 讀取歷史對話（可能夾帶壓縮摘要）
    #   4. 把 RAG 內容代入 Prompt 模板中的 {context} 佔位符，組成完整系統指令
    #   5. 附加「系統元數據」（目前使用的模型版本、Prompt 版本），方便除錯與追蹤
    #   6. 依 Provider 分流，實際呼叫對應的 LLM API 並回傳文字回覆
    model_name = "models/gemini-2.5-flash"

    # 1. 取得 Prompt 模板
    prompt_ver = get_prompt_version()
    prompt_template = load_prompt_template(prompt_ver)

    # 2. 取得 RAG 參考資料
    symptoms = chat_logs.get_symptoms_for_patient(user_id, relation)
    rag_context = build_rag_context(symptoms)

    # 3. 取得歷史紀錄與摘要
    history, summary_text = get_chat_history_and_summary(mrn, prompt_ver, model_name)

    # 4. 組裝 System Instruction
    system_instruction = prompt_template.replace("{context}", rag_context)

    if summary_text:
        system_instruction += f"\n\n【前情提要 (較早對話的摘要)】：\n{summary_text}"

    # 5. 注入 Metadata
    # 把目前實際使用的模型版本號、Prompt 版本號一併附加在 system_instruction
    # 的最尾端（以 JSON 格式呈現）。這段文字雖然不影響病患看到的實際回覆內容
    # （因為屬於「系統指令」而非會被直接複誦的內容），但方便未來若需要除錯，
    # 直接從記錄下來的 system_instruction 內容就能知道當時是用哪個模型/版本產生的回覆。
    if LLM_PROVIDER in ["ollama", "local_gpt"]:
        model_ver = OLLAMA_MODEL
    elif LLM_PROVIDER in ["openai", "cloud_gpt"]:
        model_ver = OPENAI_MODEL
    else:
        model_ver = model_name

    metadata = {
        "model_version": model_ver,
        "prompt_version": prompt_ver
    }
    system_instruction += f"\n\n【對話系統元數據 (System Metadata)】\n{json.dumps(metadata, ensure_ascii=False, indent=2)}"

    # 6. 呼叫 API (依 Provider 設定路由)
    if LLM_PROVIDER in ["ollama", "local_gpt"]:
        # === [Ollama 地端模型分支] ===
        # 組裝聊天訊息，將 system_instruction 放最前作為系統角色
        messages = [{"role": "system", "content": system_instruction}]
        # 加入對話歷史與當前使用者訊息
        messages.extend(history)
        messages.append({"role": "user", "content": user_message})

        return call_ollama_chat_api(messages, model=OLLAMA_MODEL)

    elif LLM_PROVIDER in ["openai", "cloud_gpt"]:
        # === [OpenAI 雲端模型分支] ===
        messages = [{"role": "system", "content": system_instruction}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_message})

        return call_openai_chat_api(messages, model=OPENAI_MODEL)

    else:
        # === [原 Gemini 雲端模型分支] ===
        # Gemini SDK 的用法與 OpenAI/Ollama 不同：system_instruction 是建立
        # GenerativeModel 時的獨立參數（不是塞進 messages 陣列裡的一則訊息），
        # 而多輪對話歷史則是透過 start_chat(history=...) 帶入，再用
        # chat.send_message() 送出「這一輪」的使用者訊息並取得回覆——這種
        # ChatSession 物件會在物件生命週期內自動維護對話上下文，但本專案
        # 因為每次 HTTP 請求都是全新的函式呼叫（沒有跨請求保留物件），所以
        # 每次呼叫都要重新用 history 參數「重建」對話上下文，等同於手動管理
        # 原本 ChatSession 會自動處理的狀態。
        try:
            genai.configure(api_key=GEMINI_API_KEY)
            model = genai.GenerativeModel(
                model_name=model_name,
                system_instruction=system_instruction
            )
            chat = model.start_chat(history=history)
            response = chat.send_message(user_message)
            return response.text
        except Exception as e:
            print(f"[Gemini Error] API call failed: {e}")
            return "抱歉，AI 系統暫時無法回應，請稍後再試。"


# ── 5. LINE Bot 輔助方法 ─────────────────────────────────────────────────────
def send_patient_selection_quick_reply(line_bot_api, reply_token, bound_patients, text_prefix="請選擇您本次要詢問的病患對象："):
    """發送 Quick Reply 供使用者選擇病患對象"""
    # 用於「一個 LINE 帳號綁定了 2 位以上病患」的情境：把每一位病患的
    # (mrn, relation) 組成一顆 Quick Reply 按鈕，按鈕文字顯示 relation
    # （例如「父親」「母親」），使用者點擊後 LINE 會自動發送一則
    # PostbackEvent（data 帶有 action=select_patient&mrn=...&relation=...），
    # 交由下方 handle_postback() 接手處理。
    items = []
    for mrn, relation, _ in bound_patients:
        items.append(
            QuickReplyItem(
                action=PostbackAction(
                    label=relation,
                    data=f"action=select_patient&mrn={mrn}&relation={relation}",
                    text=f"選擇詢問對象：{relation}"
                )
            )
        )
    quick_reply = QuickReply(items=items)
    line_bot_api.reply_message(
        ReplyMessageRequest(
            reply_token=reply_token,
            messages=[TextMessage(text=text_prefix, quick_reply=quick_reply)]
        )
    )

def send_reply_with_optional_change_button(line_bot_api, reply_token, text, patient_count):
    """回覆訊息，並視病患綁定數量附帶「更換對象」按鈕"""
    # 只有當這個 LINE 帳號綁定了「2 位以上」病患時，才需要附加「更換對象 🔄」的
    # Quick Reply 按鈕（因為只綁定 1 位病患時，根本沒有「其他對象」可以切換，
    # 顯示這個按鈕沒有意義，反而會讓對話介面顯得雜亂）。
    if patient_count >= 2:
        quick_reply = QuickReply(items=[
            QuickReplyItem(
                action=PostbackAction(
                    label="更換對象 🔄",
                    data="action=change_patient",
                    text="更換對象"
                )
            )
        ])
        line_bot_api.reply_message(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[TextMessage(text=text, quick_reply=quick_reply)]
            )
        )
    else:
        line_bot_api.reply_message(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[TextMessage(text=text)]
            )
        )

# ── 6. LINE Webhook 事件處理器 (Event Handlers) ───────────────────────────────
# 以下三個函式 (handle_follow / handle_message / handle_postback) 會在下方
# register_line_handlers() 執行時，被動態綁定到 app.py 建立的 WebhookHandler
# 實例上。當 app.py 的 /eddichatbot 路由收到合法的 LINE Webhook 請求並呼叫
# line_handler.handle(body, signature) 時，SDK 會依事件類型自動呼叫對應的
# 這幾個函式，並把解析好的 event 物件當作參數傳入。

def handle_follow(event):
    # 使用者加入這個 LINE 官方帳號好友時觸發。目前只做簡單的記錄用途（印出
    # user_id 到伺服器日誌），並沒有主動發送歡迎訊息或做任何綁定引導——
    # 實際的帳號綁定是靠使用者「主動輸入 Bind 文字」觸發（見 handle_message）。
    user_id = event.source.user_id
    print(f"[LINE Webhook] Got follow event, user_id: {user_id}")

def handle_message(event):
    """
    處理使用者發送的一般文字訊息事件，是整個對話狀態機的核心進入點。

    完整流程（對應下方程式碼中以數字標註的區塊）：
      0. 過濾掉「選擇詢問對象：」開頭的文字（這是使用者點擊 Quick Reply 按鈕時
         LINE 自動連帶送出的「顯示文字」，會被視為一則普通文字訊息事件觸發
         handle_message，但實際的邏輯應該交給對應的 PostbackEvent／
         handle_postback 處理，因此這裡要主動忽略，避免同一個使用者動作
         被處理兩次）。
      1. 特殊指令「Bind」：綁定 LINE 帳號到資料庫 line_accounts 表（首次使用
         系統時，使用者需要輸入 "Bind" 這個固定文字來註冊自己的 LINE 帳號）。
      2. 查詢這個 LINE 帳號目前綁定了哪些病患；若完全沒有綁定任何病患，
         提示使用者需要先聯絡系統管理員完成綁定，直接結束處理。
      3. 讀取這個使用者的對話狀態，並判斷距離上次互動是否已超過 1 小時（逾時）。
      4. 若使用者要求「更換對象」，或已經逾時：先把「目前對話中」病患的
         active_session 結算歸檔，重置狀態；若綁定了 2 位以上病患，則發送
         Quick Reply 讓使用者重新選擇要諮詢的對象。
      5. 依目前狀態機的狀態 (status) 分派到不同的處理邏輯：
           - status == 'SELECTING_PATIENT'：使用者應該用 Quick Reply 選擇，
             若他直接打字，提示他改用選單選擇。
           - status == 'CHATTING'：目前是正常對話中，把這則訊息記錄下來，
             呼叫 AI 產生回覆，記錄回覆，更新最後互動時間，回傳給使用者。
           - 其他（狀態為 None，初始情況）：依綁定病患數量決定是先請他選擇
             對象，還是（只有 1 位病患時）直接開始對話。
    """
    global configuration
    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        user_message = event.message.text.strip()

        # 0. 忽略「選擇詢問對象：」的文字訊息，避免與 PostbackEvent 重複處理
        if user_message.startswith("選擇詢問對象："):
            return

        user_id = event.source.user_id
        user_profile = line_bot_api.get_profile(user_id)
        user_name = user_profile.display_name

        # 1. 修改病患表單 (這是 app.py 原有的邏輯)
        # 使用者輸入固定文字 "Bind" 來觸發「把自己的 LINE 帳號寫入資料庫」的動作。
        # 這是本系統讓 LINE 使用者「主動註冊」而非由醫護人員代為建立帳號的入口，
        # 之後護理站才能在後台的「建立表單」頁面，把這個新出現的 LINE 帳號與
        # 某位病患的病歷關聯起來 (見 admin_server.py 的 nurse_create)。
        if user_message == 'Bind':
            db_path = os.path.join(BASE_DIR, 'database', 'hospital.db')
            conn = None
            line_account_id = None
            try:
                conn = sqlite3.connect(db_path)
                cursor = conn.cursor()
                try:
                    # 嘗試新增一筆帳號紀錄；uuid 欄位有 UNIQUE 限制，若這個
                    # user_id 之前已經綁定過，INSERT 會因為違反唯一性約束
                    # 而丟出 IntegrityError，被下方 except 攔截處理成
                    # 「帳號已綁定」的情境，而不是真的建立第二筆重複紀錄。
                    cursor.execute(
                        "INSERT INTO line_accounts (uuid, name) VALUES (?, ?)",
                        (user_id, user_name)
                    )
                    conn.commit()
                    line_account_id = cursor.lastrowid
                    reply_text = "綁定完成"
                except sqlite3.IntegrityError:
                    cursor.execute(
                        "SELECT line_account_id FROM line_accounts WHERE uuid = ? LIMIT 1",
                        (user_id,)
                    )
                    row = cursor.fetchone()
                    if row:
                        line_account_id = row[0]
                    reply_text = "帳號已綁定"
            except Exception as e:
                reply_text = f"綁定失敗：{e}"
            finally:
                if conn:
                    conn.close()

            if line_account_id is not None:
                # 無論是「首次綁定成功」還是「帳號已綁定過」，都會把這個帳號
                # 加入置頂佇列——因為即使帳號早就綁定過，使用者主動再發一次
                # "Bind" 這個動作本身，也代表他/她現在正在與系統互動，
                # 值得提醒護理站注意（例如可能是要補建新的病患關係）。
                add_to_pinned(line_account_id)

            line_bot_api.reply_message(
                ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[TextMessage(text=reply_text)]
                )
            )
            return

        # 2. 查詢該 line_id 綁定的病患
        bound_patients = chat_logs.get_patients_for_line_id(user_id)

        if not bound_patients:
            # 完全沒有任何綁定關係：代表這個 LINE 帳號可能還沒被護理站/醫師
            # 建立任何病歷關聯（即使已經執行過 "Bind" 指令，Bind 只是註冊了
            # line_accounts 表，還沒有 line_patient_pairs 關係）。
            reply_text = "您尚未綁定任何病歷，請先聯絡系統管理員進行綁定。"
            line_bot_api.reply_message(
                ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[TextMessage(text=reply_text)]
                )
            )
            return

        # 3. 載入當前狀態並檢查 timeout
        state = get_user_state(user_id)
        now = datetime.now(tw_tz)
        is_timeout = False

        if state.get("last_interaction"):
            try:
                last_time = datetime.fromisoformat(state["last_interaction"])
                if (now - last_time).total_seconds() > 3600:
                    is_timeout = True
            except Exception:
                # 時間字串解析失敗時，保守地視為「已逾時」，強制重新走一次
                # 選擇對象/開始對話的流程，避免因為壞資料卡在無法辨識的狀態中。
                is_timeout = True

        # 4. 處理「更換對象」或「timeout」的情形
        if user_message == "更換對象" or is_timeout:
            current_mrn = state.get("medical_record_number")
            if current_mrn:
                # 換對象或逾時前，一定要先把「原本對話中」的病患對話結算歸檔，
                # 確保新的對話（無論是換到別的病患，還是逾時後重新開始）
                # 會落在一個全新的 session 檔案裡，不會與前一段對話混在一起。
                chat_logs.finalize_session(current_mrn)

            reset_user_state(user_id)
            state = {
                "medical_record_number": None,
                "relation": None,
                "last_interaction": None,
                "status": None
            }

            if len(bound_patients) >= 2:
                send_patient_selection_quick_reply(line_bot_api, event.reply_token, bound_patients)
                state["status"] = "SELECTING_PATIENT"
                state["last_interaction"] = now.isoformat()
                save_user_state(user_id, state)
                return
            # 注意：若 bound_patients 只有 1 筆，這裡不會 return，而是讓程式碼
            # 繼續往下流動到步驟 5 的 else 分支（status 為 None 的情況），
            # 直接把這則使用者剛剛發送的訊息，當作是「開始跟這位唯一病患對話」
            # 的第一句話來處理，不需要多一次「請選擇對象」的往返。

        # 5. 根據狀態機處理訊息
        status = state.get("status")

        if status == "SELECTING_PATIENT":
            # 使用者應該透過 Quick Reply 按鈕點擊選擇，但如果他直接手動打字
            # （例如打了與病患姓名無關的內容），系統不會嘗試解析文字內容，
            # 而是單純再次提示他改用選單選擇，避免誤判使用者輸入的自由文字。
            reply_text = "請先從下方選單選擇您本次要諮詢的對象。"
            send_patient_selection_quick_reply(line_bot_api, event.reply_token, bound_patients, text_prefix=reply_text)
            state["last_interaction"] = now.isoformat()
            save_user_state(user_id, state)
            return

        elif status == "CHATTING":
            # 正常對話中的主流程：記錄使用者訊息 → 呼叫 AI → 記錄 AI 回覆 →
            # 更新互動時間 → 回覆給使用者（視情況附帶「更換對象」按鈕）。
            mrn = state.get("medical_record_number")
            relation = state.get("relation")

            chat_logs.save_chat_to_json(mrn, "user", user_message, now)
            reply_text = generate_gemini_reply(user_id, mrn, relation, user_message)
            # 儲存助手回覆。若回覆內容中包含「回診」字眼，後端管理系統會判定該病患「需回診」並於 UI 標記紅標。
            chat_logs.save_chat_to_json(mrn, "assistant", reply_text, datetime.now(tw_tz))

            state["last_interaction"] = datetime.now(tw_tz).isoformat()
            save_user_state(user_id, state)

            send_reply_with_optional_change_button(line_bot_api, event.reply_token, reply_text, len(bound_patients))
            return

        else:
            # 初始狀態 (status 為 None)
            # 這是「全新使用者第一次發訊息」或「剛換對象/逾時重置後、只綁定 1
            # 位病患」的情況：
            #   - 綁定 2 位以上病患 → 先請他選擇要諮詢哪一位，不直接開始對話。
            #   - 只綁定 1 位病患 → 沒有選擇的必要，直接把這則訊息當作對話的
            #     開場白，立刻進入 CHATTING 狀態並呼叫 AI 產生回覆。
            if len(bound_patients) >= 2:
                send_patient_selection_quick_reply(line_bot_api, event.reply_token, bound_patients)
                state["status"] = "SELECTING_PATIENT"
                state["last_interaction"] = now.isoformat()
                save_user_state(user_id, state)
            else:
                mrn, relation, _ = bound_patients[0]
                # 開始新對話，先清除可能殘留的 active_session
                # 防禦性處理：即使理論上不該有殘留的 active_session（因為換
                # 對象/逾時時都已經呼叫過 finalize_session），仍在這裡再保險
                # 呼叫一次，確保絕對不會把新對話的訊息誤接到舊的殘留檔案上。
                chat_logs.finalize_session(mrn)

                state["medical_record_number"] = mrn
                state["relation"] = relation
                state["status"] = "CHATTING"
                state["last_interaction"] = now.isoformat()
                save_user_state(user_id, state)

                chat_logs.save_chat_to_json(mrn, "user", user_message, now)
                reply_text = generate_gemini_reply(user_id, mrn, relation, user_message)
                # 儲存助手回覆。若回覆內容中包含「回診」字眼，後端管理系統會判定該病患「需回診」並於 UI 標記紅標。
                chat_logs.save_chat_to_json(mrn, "assistant", reply_text, datetime.now(tw_tz))

                send_reply_with_optional_change_button(line_bot_api, event.reply_token, reply_text, len(bound_patients))

def handle_postback(event):
    """
    處理使用者點擊 Quick Reply / Postback 按鈕時觸發的事件。

    目前系統中唯一會發送、且需要在這裡被處理的 Postback 動作是
    "action=select_patient"（來自 send_patient_selection_quick_reply()
    產生的按鈕）；至於「更換對象」按鈕（action=change_patient）點擊後
    LINE 會連帶送出「更換對象」的文字訊息，實際上是交由上方
    handle_message() 內的「使用者要求更換對象」邏輯處理，這裡的
    handle_postback 目前並沒有另外處理 action=change_patient 這個分支
    （因為那個按鈕設計上主要依賴其 `text` 屬性所觸發的文字訊息事件）。
    """
    global configuration
    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        user_id = event.source.user_id
        postback_data = event.postback.data

        # 解析 postback_data
        # postback_data 是我們自己在 PostbackAction(data=...) 中定義的字串
        # 格式，例如 "action=select_patient&mrn=A123&relation=父親"，
        # 這裡手動用 & 與 = 拆解成 key-value 字典，等同於簡易版的
        # URL query string 解析（不使用 urllib 是因為格式單純，手動拆解足夠）。
        params = {}
        for pair in postback_data.split('&'):
            if '=' in pair:
                k, v = pair.split('=', 1)
                params[k] = v

        action = params.get("action")

        if action == "select_patient":
            # 使用者從 Quick Reply 選單中選定了要諮詢的病患對象：
            #   1. 直接把狀態設為 CHATTING 並記錄選定的 mrn / relation。
            #   2. 用一句「隱藏 Prompt」(combined_prompt) 主動觸發 AI 先做
            #      自我介紹並詢問病患目前最不舒服的症狀，讓使用者不需要
            #      自己再多打一句話才能開始對話，體驗更流暢。
            #   3. combined_prompt 本身不會直接顯示給使用者看（它是傳給 AI
            #      的輸入），使用者在 LINE 上看到的訊息記錄，是他點擊按鈕時
            #      LINE 自動顯示的「選擇詢問對象：xxx」文字，加上緊接著收到
            #      的 AI 開場白回覆。
            mrn = params.get("mrn")
            relation = params.get("relation")

            now = datetime.now(tw_tz)
            state = {
                "medical_record_number": mrn,
                "relation": relation,
                "last_interaction": now.isoformat(),
                "status": "CHATTING"
            }
            save_user_state(user_id, state)

            # 開始諮詢，結合選擇訊息與隱藏 prompt
            user_msg = f"選擇詢問對象：{relation}"
            combined_prompt = f"{user_msg}\n請開始對話，進行自我介紹並詢問病患目前最不舒服的症狀。"
            chat_logs.save_chat_to_json(mrn, "user", user_msg, now)
            reply_text = generate_gemini_reply(user_id, mrn, relation, combined_prompt)
            # 儲存助手回覆。若回覆內容中包含「回診」字眼，後端管理系統會判定該病患「需回診」並於 UI 標記紅標。
            chat_logs.save_chat_to_json(mrn, "assistant", reply_text, datetime.now(tw_tz))

            bound_patients = chat_logs.get_patients_for_line_id(user_id)
            send_reply_with_optional_change_button(line_bot_api, event.reply_token, reply_text, len(bound_patients))

# ── 7. 事件監聽動態註冊方法 ───────────────────────────────────────────────────
def register_line_handlers(line_handler_instance, config_instance):
    """
    將 bot 中定義的監聽方法註冊到 app.py 初始化的 WebhookHandler 上，並初始化全域 configuration。
    這可完全避免 Python __main__ 與 app 命名空間不一致導致的 Handler 找不到問題。
    """
    # 這是本檔案與 app.py 之間唯一的「連接點」：app.py 在建立好
    # WebhookHandler 與 Configuration 之後，主動呼叫這個函式一次，
    # 完成以下兩件事：
    #   1. 把傳入的 config_instance 存到本模組的全域變數 `configuration`，
    #      讓 handle_message / handle_postback 之後才能透過
    #      `ApiClient(configuration)` 建立可呼叫 LINE API 的用戶端。
    #   2. 呼叫 line_handler_instance.add(EventType, message=...)(handler_func)
    #      的寫法，等同於手動套用官方 SDK 慣用的 @handler.add(...) 裝飾器，
    #      只是改成「函式呼叫」的形式，讓綁定動作可以延後到 app.py 明確
    #      呼叫這個函式時才執行，而不是在模組被 import 的當下就靠裝飾器
    #      自動綁定（那樣才會產生本檔案開頭說明的命名空間不一致問題）。
    global configuration
    configuration = config_instance

    line_handler_instance.add(FollowEvent)(handle_follow)
    line_handler_instance.add(MessageEvent, message=TextMessageContent)(handle_message)
    line_handler_instance.add(PostbackEvent)(handle_postback)
    print("[LINE Webhook] Event handlers successfully registered.")

# ── Legacy/CLI 介面相容方法 ─────────────────────────────────────────────────
# 保留這些以便現有的其他測試/CLI 腳本不會報錯
# 以下類別與函式並不會被 app.py 的主流程 (Webhook → handle_message →
# generate_gemini_reply) 呼叫到，而是提供一套「物件導向、可在命令列/測試腳本
# 中直接互動」的替代介面，方便在不啟動完整 Flask 伺服器、不需要真的透過 LINE
# 傳訊息的情況下，直接在 Python 互動環境或測試程式中建立一個 Bot 物件、
# 呼叫 .start(context) 設定情境、再呼叫 .ask(問題) 取得回覆，快速驗證
# Prompt 或衛教資料的效果。
class SmartHealthBotBase(ABC):
    def set_patient_context(self, patient_context: str) -> None:
        self._patient_context = patient_context.strip()
    def get_patient_context(self) -> str:
        return getattr(self, "_patient_context", "")
    @abstractmethod
    def start(self, context: str) -> None:
        pass
    @abstractmethod
    def ask(self, user_input: str) -> str:
        pass

class GeminiBot(SmartHealthBotBase):
    """CLI/測試用：直接包裝 Gemini 的 ChatSession，提供 start()/ask() 兩個簡單方法。"""
    def __init__(self, model_name: str = "models/gemini-2.5-flash"):
        genai.configure(api_key=GEMINI_API_KEY)
        self.model_name = model_name
        self.chat_session = None
    def start(self, context: str) -> None:
        # context 會被當作 system_instruction，等同於主流程中的 system_instruction 組裝結果。
        model = genai.GenerativeModel(model_name=self.model_name, system_instruction=context)
        self.chat_session = model.start_chat(history=[])
    def ask(self, user_input: str) -> str:
        if self.chat_session is None:
            raise RuntimeError("請先呼叫 bot.start(context)")
        response = self.chat_session.send_message(user_input)
        return response.text

class OpenAIBot(SmartHealthBotBase):
    """CLI/測試用：直接使用官方 openai Python SDK（注意：與上方 call_openai_chat_api() 用 requests 手動呼叫 REST API 是兩套獨立的實作，互不影響）。"""
    def __init__(self, model_name: str = "gpt-4o"):
        from openai import OpenAI
        self.client = OpenAI(api_key=OPENAI_API_KEY)
        self.model_name = model_name
        self.messages = []
    def start(self, context: str) -> None:
        self.messages = [{"role": "system", "content": context}]
    def ask(self, user_input: str) -> str:
        self.messages.append({"role": "user", "content": user_input})
        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=self.messages
        )
        reply = response.choices[0].message.content
        # 手動把 AI 回覆也 append 進 self.messages，讓下一次 ask() 呼叫時，
        # 這個物件實例本身就保有完整的多輪對話歷史（與主流程中每次都要
        # 重新從 chat_logs 檔案重建歷史的作法不同，這裡是靠物件狀態保存）。
        self.messages.append({"role": "assistant", "content": reply})
        return reply

class OllamaBot(SmartHealthBotBase):
    """地端 Ollama gpt-oss 相容之 Bot 類別 (CLI/測試使用)"""
    def __init__(self, model_name: str = OLLAMA_MODEL):
        self.model_name = model_name
        self.context = ""
        self.messages = []
    def start(self, context: str) -> None:
        self.context = context
        self.messages = [{"role": "system", "content": context}]
    def ask(self, user_input: str) -> str:
        self.messages.append({"role": "user", "content": user_input})
        reply = call_ollama_chat_api(self.messages, model=self.model_name)
        self.messages.append({"role": "assistant", "content": reply})
        return reply

def get_ai_response(user_id: str, user_message: str, ai_type: str = 'gemini') -> str:
    """相容性包裝：由 CLI/舊版調用"""
    # 提供一個「不需要事先知道病患對話狀態機細節」的簡化入口：
    # 只給 user_id 與訊息文字，內部自動讀取/建立狀態，找出（或自動綁定）
    # 對應的病患，再呼叫主流程共用的 generate_gemini_reply()。
    # 注意：ai_type 參數目前並未實際被用來覆寫 LLM_PROVIDER（仍是由全域的
    # LLM_PROVIDER 環境變數決定呼叫哪個 Provider），保留此參數只是維持
    # 舊版呼叫介面的相容性，避免舊呼叫端傳入這個參數時發生 TypeError。
    state = get_user_state(user_id)
    mrn = state.get("medical_record_number")
    relation = state.get("relation")
    if not mrn:
        bound_patients = chat_logs.get_patients_for_line_id(user_id)
        if bound_patients:
            mrn, relation, _ = bound_patients[0]
            state["medical_record_number"] = mrn
            state["relation"] = relation
            state["status"] = "CHATTING"
            save_user_state(user_id, state)
        else:
            return "尚未綁定病患"
    return generate_gemini_reply(user_id, mrn, relation, user_message)
