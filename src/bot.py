import os
import json
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from abc import ABC, abstractmethod
import google.generativeai as genai
from dotenv import load_dotenv

# 抓取專案根目錄
BASE_DIR = Path(__file__).resolve().parent.parent

# 載入環境變數
env_path = BASE_DIR / ".env"
load_dotenv(dotenv_path=env_path)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyCQdNuAe3sg13SRi3arsgBjPqWdmZM_nAg")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "YOUR_OPENAI_KEY_HERE")

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
configuration = None

# ── 1. 狀態管理 (Session State Management) ───────────────────────────────────────
STATE_DIR = os.path.join(BASE_DIR, 'data')
os.makedirs(STATE_DIR, exist_ok=True)

def get_user_state(line_id):
    """讀取 user 的當前狀態"""
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
    state_file = os.path.join(STATE_DIR, f"{line_id}_state.json")
    if os.path.exists(state_file):
        try:
            os.remove(state_file)
        except Exception:
            pass

# ── 2. 動態 Prompt 與 RAG 檢索 ────────────────────────────────────────────────
def get_prompt_version() -> str:
    """讀取 prompt 配置文件中的當前版本"""
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

# 中文主題到英文檔名的靜態映射表 (保證精確對應)
ZH_TOPIC_TO_FILE = {
    "腹痛衛教": "abdominal_pain.md",
    "腸胃炎衛教，病毒性腸胃炎衛教": "acute_viral_gastroenteritis.md",
    "燒燙傷衛教": "burn_injury.md",
    "胸痛衛教": "chest_pain.md",
    "便秘衛教": "constipation.md",
    "當您的咳嗽出現以下情況時，請及時尋求醫療協助：": "cough.md",
    "譫妄、意識混亂衛教": "delirium_confusion.md",
    "腹瀉衛教": "diarrhea.md",
    "頭暈衛教": "dizziness.md",
    "水腫衛教": "edema.md",
    "流鼻血衛教": "epistaxis_nosebleeds.md",
    "發燒衛教": "fever.md",
    "腰痛衛教": "flank_pain.md",
    "虛弱衛教": "general_weakness.md",
    "頭痛衛教": "headache.md",
    "吐血、解黑便、解血便，胃腸道出血衛教": "hematemesis_gi_bleed.md",
    "血尿衛教": "hematuria.md",
    "咳血衛教": "hemoptysis.md",
    "打嗝衛教": "hiccups.md",
    "高血壓衛教": "hypertension_emergency.md",
    "下背痛衛教": "low_back_pain.md",
    "偏頭痛衛教": "migraine.md",
    "肌肉、關節和骨骼疼痛衛教": "myalgia_arthralgia_bone_pain.md",
    "噁心嘔吐衛教": "nausea_and_vomiting.md",
    "心悸衛教": "palpitation.md",
    "癲癇衛教": "seizure.md",
    "休克衛教": "shock.md",
    "當您的呼吸急促或呼吸困難出現以下情況時，請立即尋求醫療協助：": "shortness_of_breath_dyspnea.md",
    "皮膚疹子(皮疹)衛教": "skin_rash.md",
    "暈厥、暈倒衛教": "syncope.md",
    "一般外傷、鈍挫傷、扭傷、拉傷衛教": "trauma_contusion_sprain.md",
    "傷口處置原則，擦傷、撕裂傷，縫合傷口衛教": "trauma_suture_abrasion_wound.md",
    "上背痛衛教": "upper_back_pain.md",
    "尿滯留衛教": "urinary_retention.md",
    "懷孕早期陰道出血衛教": "vaginal_bleeding_early_pregnancy.md",
    "懷孕後期陰道出血衛教": "vaginal_bleeding_late_pregnancy.md",
    "月經週期間陰道出血衛教": "vaginal_bleeding_between_periods.md",
    "眩暈衛教": "vertigo.md"
}

def build_rag_context(symptoms: list[str]) -> str:
    """根據病患的症狀中文名稱，讀取對應的英文 Markdown 檔案並合併"""
    if not symptoms:
        return "無對應的衛教參考資料。請根據通用醫療常識回答。"
        
    matched_files = set()
    for sym in symptoms:
        found = False
        for topic_zh, filename in ZH_TOPIC_TO_FILE.items():
            if sym in topic_zh:
                matched_files.add(filename)
                found = True
                break
        if not found:
            # 模糊比對
            for topic_zh, filename in ZH_TOPIC_TO_FILE.items():
                if topic_zh in sym or sym in topic_zh:
                    matched_files.add(filename)
                    break
                    
    if not matched_files:
        return "無對應的衛教參考資料。請根據通用醫療常識回答。"
        
    parts = []
    discharge_dir = os.path.join(BASE_DIR, 'assets', 'discharge')
    for filename in sorted(matched_files):
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
def generate_history_summary(older_messages: list[dict], model_name: str) -> str:
    """呼叫 Gemini 產生較早對話記錄的精簡摘要"""
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
    
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        model = genai.GenerativeModel(model_name=model_name)
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        print(f"[Summary Error] Failed to generate summary: {e}")
        return "（較早對話記錄因長度限制已被系統簡化）"

def get_chat_history_and_summary(mrn: str, prompt_ver: str, model_name: str) -> tuple[list[dict], str]:
    """
    從 active_session.json 重構對話歷史，並處理 Token 限制。
    保留最近 5 次對話 (10 條訊息)，並將更早之前的對話生成精簡總結 (Summary)。
    注意：此處需將最後一條剛寫入的 user 訊息剔除，只載入先前的歷史。
    """
    log_path = os.path.join(BASE_DIR, 'chat_logs', mrn, 'active_session.json')
    if not os.path.exists(log_path):
        return [], ""
        
    try:
        with open(log_path, 'r', encoding='utf-8') as f:
            session_data = json.load(f)
    except Exception:
        return [], ""
        
    messages = session_data.get("messages", [])
    if not messages:
        return [], ""
        
    # 最新的一則 user 訊息不放入歷史（因為即將透過 chat.send_message 送出）
    history_messages = messages[:-1]
    
    if len(history_messages) <= 10:
        gemini_history = []
        for msg in history_messages:
            role = "model" if msg.get("role") == "assistant" else "user"
            gemini_history.append({
                "role": role,
                "parts": [msg.get("content", "")]
            })
        return gemini_history, ""
        
    # 超過 5 次對話 (10 條訊息)，進行總結
    recent_messages = history_messages[-10:]
    older_messages = history_messages[:-10]
    
    gemini_history = []
    for msg in recent_messages:
        role = "model" if msg.get("role") == "assistant" else "user"
        gemini_history.append({
            "role": role,
            "parts": [msg.get("content", "")]
        })
        
    summary_text = generate_history_summary(older_messages, model_name)
    return gemini_history, summary_text

# ── 4. Gemini 回覆產生器 ─────────────────────────────────────────────────────
def generate_gemini_reply(user_id: str, mrn: str, relation: str, user_message: str) -> str:
    """整合動態 Prompt、RAG、歷史對話與摘要，呼叫 Gemini API 產生回覆"""
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
    metadata = {
        "model_version": model_name,
        "prompt_version": prompt_ver
    }
    system_instruction += f"\n\n【對話系統元數據 (System Metadata)】\n{json.dumps(metadata, ensure_ascii=False, indent=2)}"
    
    # 6. 呼叫 API
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

def handle_follow(event):
    user_id = event.source.user_id
    print(f"[LINE Webhook] Got follow event, user_id: {user_id}")

def handle_message(event):
    global configuration
    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        user_message = event.message.text.strip()
        user_id = event.source.user_id
        user_profile = line_bot_api.get_profile(user_id)
        user_name = user_profile.display_name

        # 1. 修改病患表單 (這是 app.py 原有的邏輯)
        if user_message == '修改病患表單':
            from form_handle import load_verification_codes, save_verification_codes, cleanup_expired_codes
            import random
            import time
            
            cleanup_expired_codes()
            codes = load_verification_codes()
            for code, data in list(codes.items()):
                if data["user_id"] == user_id:
                    del codes[code]
                    break
            while True:
                random_number = str(random.randint(100000, 999999))
                if random_number not in codes:
                    break
            expires_at = time.time() + 600
            codes[random_number] = {
                "user_id": user_id,
                "user_name": user_name,
                "expires_at": expires_at
            }
            save_verification_codes(codes)
            formatted_expiry = datetime.fromtimestamp(expires_at, tz=tw_tz).strftime("%Y-%m-%d %H:%M:%S")
            reply_text = f"您的驗證碼是：{random_number}\n此驗證碼將於 10 分鐘後失效（{formatted_expiry}）"
            
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
                is_timeout = True
                
        # 4. 處理「更換對象」或「timeout」的情形
        if user_message == "更換對象" or is_timeout:
            current_mrn = state.get("medical_record_number")
            if current_mrn:
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

        # 5. 根據狀態機處理訊息
        status = state.get("status")
        
        if status == "SELECTING_PATIENT":
            reply_text = "請先從下方選單選擇您本次要諮詢的對象。"
            send_patient_selection_quick_reply(line_bot_api, event.reply_token, bound_patients, text_prefix=reply_text)
            state["last_interaction"] = now.isoformat()
            save_user_state(user_id, state)
            return
            
        elif status == "CHATTING":
            mrn = state.get("medical_record_number")
            relation = state.get("relation")
            
            chat_logs.save_chat_to_json(mrn, "user", user_message, now)
            reply_text = generate_gemini_reply(user_id, mrn, relation, user_message)
            chat_logs.save_chat_to_json(mrn, "assistant", reply_text, datetime.now(tw_tz))
            
            state["last_interaction"] = datetime.now(tw_tz).isoformat()
            save_user_state(user_id, state)
            
            send_reply_with_optional_change_button(line_bot_api, event.reply_token, reply_text, len(bound_patients))
            return
            
        else:
            # 初始狀態 (status 為 None)
            if len(bound_patients) >= 2:
                send_patient_selection_quick_reply(line_bot_api, event.reply_token, bound_patients)
                state["status"] = "SELECTING_PATIENT"
                state["last_interaction"] = now.isoformat()
                save_user_state(user_id, state)
            else:
                mrn, relation, _ = bound_patients[0]
                # 開始新對話，先清除可能殘留的 active_session
                chat_logs.finalize_session(mrn)
                
                state["medical_record_number"] = mrn
                state["relation"] = relation
                state["status"] = "CHATTING"
                state["last_interaction"] = now.isoformat()
                save_user_state(user_id, state)
                
                chat_logs.save_chat_to_json(mrn, "user", user_message, now)
                reply_text = generate_gemini_reply(user_id, mrn, relation, user_message)
                chat_logs.save_chat_to_json(mrn, "assistant", reply_text, datetime.now(tw_tz))
                
                send_reply_with_optional_change_button(line_bot_api, event.reply_token, reply_text, len(bound_patients))

def handle_postback(event):
    global configuration
    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        user_id = event.source.user_id
        postback_data = event.postback.data
        
        # 解析 postback_data
        params = {}
        for pair in postback_data.split('&'):
            if '=' in pair:
                k, v = pair.split('=', 1)
                params[k] = v
                
        action = params.get("action")
        
        if action == "select_patient":
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
            
            # 開始諮詢，觸發 AI 的開場白
            opening_prompt = "請開始對話，進行自我介紹並詢問病患目前最不舒服的症狀。"
            chat_logs.save_chat_to_json(mrn, "user", opening_prompt, now)
            reply_text = generate_gemini_reply(user_id, mrn, relation, opening_prompt)
            chat_logs.save_chat_to_json(mrn, "assistant", reply_text, datetime.now(tw_tz))
            
            bound_patients = chat_logs.get_patients_for_line_id(user_id)
            send_reply_with_optional_change_button(line_bot_api, event.reply_token, reply_text, len(bound_patients))
            
        elif action == "change_patient":
            state = get_user_state(user_id)
            current_mrn = state.get("medical_record_number")
            if current_mrn:
                chat_logs.finalize_session(current_mrn)
                
            reset_user_state(user_id)
            bound_patients = chat_logs.get_patients_for_line_id(user_id)
            
            if len(bound_patients) >= 2:
                send_patient_selection_quick_reply(line_bot_api, event.reply_token, bound_patients)
                new_state = {
                    "medical_record_number": None,
                    "relation": None,
                    "last_interaction": datetime.now(tw_tz).isoformat(),
                    "status": "SELECTING_PATIENT"
                }
                save_user_state(user_id, new_state)

# ── 7. 事件監聽動態註冊方法 ───────────────────────────────────────────────────
def register_line_handlers(line_handler_instance, config_instance):
    """
    將 bot 中定義的監聽方法註冊到 app.py 初始化的 WebhookHandler 上，並初始化全域 configuration。
    這可完全避免 Python __main__ 與 app 命名空間不一致導致的 Handler 找不到問題。
    """
    global configuration
    configuration = config_instance
    
    line_handler_instance.add(FollowEvent)(handle_follow)
    line_handler_instance.add(MessageEvent, message=TextMessageContent)(handle_message)
    line_handler_instance.add(PostbackEvent)(handle_postback)
    print("[LINE Webhook] Event handlers successfully registered.")

# ── Legacy/CLI 介面相容方法 ─────────────────────────────────────────────────
# 保留這些以便現有的其他測試/CLI 腳本不會報錯
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
    def __init__(self, model_name: str = "models/gemini-2.5-flash"):
        genai.configure(api_key=GEMINI_API_KEY)
        self.model_name = model_name
        self.chat_session = None
    def start(self, context: str) -> None:
        model = genai.GenerativeModel(model_name=self.model_name, system_instruction=context)
        self.chat_session = model.start_chat(history=[])
    def ask(self, user_input: str) -> str:
        if self.chat_session is None:
            raise RuntimeError("請先呼叫 bot.start(context)")
        response = self.chat_session.send_message(user_input)
        return response.text

class OpenAIBot(SmartHealthBotBase):
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
        self.messages.append({"role": "assistant", "content": reply})
        return reply

def get_ai_response(user_id: str, user_message: str, ai_type: str = 'gemini') -> str:
    """相容性包裝：由 CLI/舊版調用"""
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