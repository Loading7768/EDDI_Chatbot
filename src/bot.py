import json
import os
from abc import ABC, abstractmethod


# API Key 設定（請填入或透過環境變數傳入）
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "AIzaSyCQdNuAe3sg13SRi3arsgBjPqWdmZM_nAg")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "YOUR_OPENAI_KEY_HERE")


# 資料載入 

def load_discharge_data(json_path: str) -> tuple[list[str], list[str], list[dict]]:
    """
    讀取 EDdischarge.json，回傳：
      topic_en_list : 英文主題名稱 list
      topic_zh_list : 中文主題名稱 list
      raw_data      : 原始 JSON list（供選題後取 content 用）
    content 不在此階段載入，等醫師選完主題後再從 raw_data 取出。
    """
    with open(json_path, encoding="utf-8") as f:
        raw_data: list[dict] = json.load(f)

    topic_en_list: list[str] = [item.get("topic_en", "").strip() for item in raw_data]
    topic_zh_list: list[str] = [item.get("topic_zh", "").strip() for item in raw_data]

    return topic_en_list, topic_zh_list, raw_data


# 醫師選題介面

def doctor_select_topics(
    topic_en_list: list[str],
    topic_zh_list: list[str],
) -> list[int]:
    """列出所有主題讓醫師勾選（可多選），回傳選定主題的索引列表。"""
    print("\n" + "═" * 55)
    print("  📋 請選擇本次出院衛教主題（可多選）")
    print("═" * 55)
    for i, (en, zh) in enumerate(zip(topic_en_list, topic_zh_list)):
        print(f"  [{i + 1:>2}] {zh}  /  {en}")
    print("═" * 55)
    print("  輸入編號，以空格或逗號分隔（例：1 3 5 或 1,3,5）")

    while True:
        raw = input("\n醫師選擇 > ").strip()
        tokens = raw.replace(",", " ").split()
        try:
            indices = [int(t) - 1 for t in tokens]
            if all(0 <= idx < len(topic_en_list) for idx in indices) and indices:
                return indices
        except ValueError:
            pass
        print("  ⚠️  輸入格式錯誤，請重新輸入有效的編號。")


# 醫師填寫病患資訊介面 

def doctor_enter_patient_context() -> str:
    """
    讓醫師輸入病患背景資訊（姓名、診斷、用藥、注意事項等）。
    輸入空白則略過，使用通用回答模式。
    支援多行輸入：輸入空白行結束。
    """
    print("\n" + "═" * 55)
    print("  👤 請填寫病患資訊（供 AI 個人化回答使用）")
    print("  格式建議：姓名、年齡、診斷、目前用藥、注意事項")
    print("  範例：王小明，55歲男性，診斷非典型胸痛，已排除心肌梗塞，")
    print("        用藥阿斯匹靈 100mg QD，需注意傷口照護。")
    print("  （直接按 Enter 略過，使用通用回答模式）")
    print("═" * 55)

    lines = []
    while True:
        line = input("  " if not lines else "  ").strip()
        if not line:
            break
        lines.append(line)

    patient_context = " ".join(lines).strip()

    if patient_context:
        print(f"\n✅ 已記錄病患資訊：{patient_context}")
    else:
        print("\n⚠️  未填寫病患資訊，將使用通用回答模式。")

    return patient_context


# 組合 context

def build_context(
    selected_indices: list[int],
    topic_zh_list: list[str],
    raw_data: list[dict],
) -> str:
    """醫師選完主題後，才從 raw_data 取出對應的 content，組合成 LLM 用的 context。"""
    parts = []
    for idx in selected_indices:
        content = raw_data[idx].get("content", "").strip()
        parts.append(f"【主題：{topic_zh_list[idx]}】\n{content}")
    return "\n\n".join(parts)


# 聊天機器人基底 

class SmartHealthBotBase(ABC):

    def set_patient_context(self, patient_context: str) -> None:
        """由醫師呼叫，設定病患背景資訊（可在 start 前後呼叫）。"""
        self._patient_context = patient_context.strip()

    def get_patient_context(self) -> str:
        """安全取值，未設定時回傳空字串。"""
        return getattr(self, "_patient_context", "")

    def _build_system_prompt(self, context: str, patient_context: str = "") -> str:
        patient_section = (
            patient_context
            if patient_context
            else "（本次未填寫病患資訊，請依衛教資料通用回答）"
        )
        return f"""你是一位專業、溫暖且具同理心的「急診科衛教與關懷助手」。
    你的任務是根據病患提問，結合醫師預先填寫的病患資訊，給予簡短、易懂的居家照護建議，並明確判斷是否需要就醫。

    【病患資訊】（由醫師於看診時填寫）
    {patient_section}

    【衛教參考資料】
    {context}

    ---

    【核心守則】

    1. 安全第一（紅色警報）
    若病患描述出現以下任一情況，立即停止一切提問，優先回覆：
    「🚨 情況緊急，請立即撥打 119 或前往最近的急診室。」
    緊急徵兆包含（但不限於）：劇烈胸痛、呼吸困難、大量出血、意識不清、突發性嚴重頭痛、單側肢體無力或麻木、吞嚥困難、臉部不對稱。

    2. 僅依參考資料回答
    只能使用【衛教參考資料】內容作答，嚴禁自行捏造醫療資訊。
    若資訊不足，請說：「這個問題超出本次衛教範圍，建議回診由醫師評估。」

    3. 語意對齊
    理解口語化用詞（如「拉肚子」→腹瀉、「喘」→呼吸急促），對應正確的衛教內容。

    4. 不診斷、不建議藥物劑量
    你不是醫師，不能診斷疾病或調整藥物。

    ---

    【回答格式】

    每次回覆請依以下格式，簡短作答：

    根據急診出院衛教指引：
    （用 2–4 句話直接回答問題，說明症狀意義與注意事項）

    ▸ 建議：
    🟢 繼續在家觀察 ／ 🟡 建議至診所回診 ／ 🔴 請立即前往急診
    （一行說明判斷原因）

    若症狀持續或惡化，請聯繫您的主治醫師或返院檢查。"""

    @abstractmethod
    def start(self, context: str) -> None:
        """以選定的 context 初始化（或重置）對話 session。"""

    @abstractmethod
    def ask(self, user_input: str) -> str:
        """送出一則訊息並回傳 LLM 的回覆文字。"""


# Gemini 實作

class GeminiBot(SmartHealthBotBase):
    def __init__(self, model_name: str = "models/gemini-2.5-flash"):
        import google.generativeai as genai
        genai.configure(api_key=GEMINI_API_KEY)
        self._genai = genai
        self.model_name = model_name
        self.chat_session = None

    def start(self, context: str) -> None:
        system_instruction = self._build_system_prompt(
            context=context,
            patient_context=self.get_patient_context(),
        )
        model = self._genai.GenerativeModel(
            model_name=self.model_name,
            system_instruction=system_instruction,
        )
        self.chat_session = model.start_chat(history=[])

    def ask(self, user_input: str) -> str:
        if self.chat_session is None:
            raise RuntimeError("請先呼叫 bot.start(context) 初始化對話。")
        response = self.chat_session.send_message(user_input)
        return response.text


# OpenAI 實作

class OpenAIBot(SmartHealthBotBase):
    def __init__(self, model_name: str = "gpt-4o"):
        from openai import OpenAI
        self.client = OpenAI(api_key=OPENAI_API_KEY)
        self.model_name = model_name
        self.messages: list[dict] = []

    def start(self, context: str) -> None:
        system_prompt = self._build_system_prompt(
            context=context,
            patient_context=self.get_patient_context(),
        )
        self.messages = [{"role": "system", "content": system_prompt}]

    def ask(self, user_input: str) -> str:
        if not self.messages:
            raise RuntimeError("請先呼叫 bot.start(context) 初始化對話。")
        self.messages.append({"role": "user", "content": user_input})
        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=self.messages,
        )
        reply = response.choices[0].message.content
        self.messages.append({"role": "assistant", "content": reply})
        return reply


# --- 以下為新增的 LINE Bot 整合用程式碼 ---

# 儲存每個使用者的 Bot 實例：{ "user_id": BotInstance }
user_sessions = {}

# 預先載入所有衛教資料（作為 LINE Bot 的通用預設資料）
try:
    # 注意：請確認你的 EDdischarge.json 路徑是否正確，這裡依你原本的設定
    default_json_path = os.path.join(os.path.dirname(__file__), "../docs/EDdischarge.json")
    if os.path.exists(default_json_path):
        _, topic_zh_list, raw_data = load_discharge_data(default_json_path)
        # 預設載入所有主題作為 context
        default_context = build_context(list(range(len(raw_data))), topic_zh_list, raw_data)
    else:
        default_context = "無外部衛教資料，請依照一般醫療常識回答。"
except Exception as e:
    print(f"載入預設資料失敗：{e}")
    default_context = "無外部衛教資料，請依照一般醫療常識回答。"



def get_ai_response(user_id: str, user_message: str, ai_type: str = 'gemini') -> str:
    """
    接收 LINE user_id 與訊息，取得專屬的 bot 實例並回傳答案
    """
    # 處理特殊指令：重置對話
    if user_message.strip() == '重置':
        if user_id in user_sessions:
            del user_sessions[user_id]
        return "🔄 對話已重置，請開始新的諮詢。"

    # 1. 如果是新使用者，為他建立專屬的 Bot 實例
    if user_id not in user_sessions:
        if ai_type == 'openai':
            bot = OpenAIBot()
        else:
            bot = GeminiBot()
            
        # 因為是 LINE Bot 直面病患，沒有醫師輸入病患資訊，設定為預設值
        bot.set_patient_context("一般病患（由 LINE Bot 諮詢）")
        
        # 啟動對話 (傳入預先組合好的所有衛教知識)
        try:
            bot.start(default_context)
            user_sessions[user_id] = bot
        except Exception as e:
            return f"系統初始化失敗：{e}"
            
    # 2. 取得該使用者的機器人，並進行對話
    bot = user_sessions[user_id]
    try:
        response_text = bot.ask(user_message)
        return response_text
    except Exception as e:
        return f"AI 回覆發生錯誤：{e}"


# ── 主程式 ─────────────────────────────────────────────────────────────────────

def main() -> None:
    # 1. 選擇 LLM provider
    bot = GeminiBot()  # 或換成 OpenAIBot()

    # 2. 讀取資料
    json_path = os.path.join(os.path.dirname(__file__), "../docs/EDdischarge.json")
    topic_en_list, topic_zh_list, raw_data = load_discharge_data(json_path)
    print(f"✅ 成功載入 {len(topic_en_list)} 筆衛教主題")

    while True:
        # 3. 醫師選題
        selected = doctor_select_topics(topic_en_list, topic_zh_list)
        selected_names = "、".join(topic_zh_list[i] for i in selected)
        print(f"\n📌 已選定主題：{selected_names}")

        # 4. 醫師填寫病患資訊
        patient_context = doctor_enter_patient_context()
        bot.set_patient_context(patient_context)

        # 5. 選完後才取 content，組合 context 並初始化對話
        context = build_context(selected, topic_zh_list, raw_data)
        bot.start(context)

        # 6. 開始對話
        print("\n" + "─" * 55)
        print("🏥 智慧衛教小助手 — 對話開始")
        print("  輸入 'exit' / '結束' 結束程式")
        print("  輸入 '重新選題' 返回主題選擇")
        print("─" * 55)

        print("\n🤖 思考中...")
        opening = bot.ask("請開始對話，進行自我介紹並詢問病患目前最不舒服的症狀。")
        print(f"\n🤖 助手：{opening}")

        restart = False
        while True:
            user_input = input("\n👤 使用者：").strip()

            if not user_input:
                continue

            if user_input.lower() in ("exit", "quit", "結束", "再見"):
                print("🤖 助手：祝您早日康復，平安健康！")
                return

            if user_input == "重新選題":
                restart = True
                break

            print("\n🤖 思考中...")
            try:
                reply = bot.ask(user_input)
                print(f"\n🤖 助手：{reply}")
            except Exception as e:
                print(f"❌ 發生錯誤：{e}")

        if not restart:
            break


if __name__ == "__main__":
    main()