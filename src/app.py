"""
====================================================================================
 app.py — Flask 應用程式進入點 (Application Entry Point)
====================================================================================

【這個檔案在整個系統中的角色】
    本專案是一個「急診出院衛教 LINE Bot」系統，由三大部分組成：
      1. LINE Bot 對話引擎  → src/bot.py（負責病患透過 LINE 與 AI 對話、RAG 檢索衛教資料、
         呼叫 LLM 產生回覆、管理對話狀態機）
      2. 病患出院表單網頁    → src/form_handler.py（提供 form_bp，讓護理站/醫師填寫出院衛教
         表單、綁定 LINE 帳號與病歷）
      3. 醫護後台管理系統    → src/admin_server.py（提供 admin_bp，讓醫師/管理員登入後查看
         病患對話紀錄、管理醫師帳號、維護 AI Prompt 與衛教資料、查看統計數據）

    app.py 就是把上述三塊「串起來」的 Flask 主程式：
      - 建立 Flask app 實例，設定樣板/靜態檔案資料夾路徑
      - 以 Blueprint 的方式註冊 form_bp 與 admin_bp（讓路由定義分散在不同檔案，但仍共用
        同一個 Flask app 與 session secret_key）
      - 初始化 LINE Messaging API 所需的 Configuration（存取金鑰）與 WebhookHandler
        （事件分派器），並在啟動時把這兩個物件「注入」給 bot.py，讓 bot.py 能使用它們
        呼叫 LINE API、並將自己定義的事件處理函式註冊到 WebhookHandler 上
      - 對外提供 LINE 官方帳號的 Webhook 端點 `/eddichatbot`，所有使用者在 LINE 上的
        訊息/貼圖/回傳事件都會由 LINE 平台以 HTTP POST 方式打到這個端點

【啟動流程總覽】（依照本檔案程式碼從上到下執行的順序）
    1. 匯入 LINE SDK 相關類別（WebhookHandler、InvalidSignatureError、Configuration）
    2. 修正 sys.path，確保在 Vercel 等雲端無伺服器 (serverless) 環境部署時，
       Python 仍能正確找到與 app.py 同目錄的 bot.py / admin_server.py / form_handler.py
    3. 載入 .env 環境變數檔（LINE 金鑰、LLM API 金鑰等敏感設定都存在這裡，不進版控）
    4. 建立 Flask app，指定 template_folder 為 webpage/（給 render_template 用）、
       static_folder 為 assets/（給 /assets/* 靜態資源用，例如圖片）
    5. 匯入並註冊兩個 Blueprint：form_bp（病患表單）、admin_bp（醫護後台）
       　※ 這裡故意把 import 寫在 app 建立之後，是因為 form_handler.py / admin_server.py
          內部可能會用到已經設定好路徑的 app 或環境變數，避免循環匯入問題
    6. 設定 Flask session 用的 secret_key 與 Cookie SameSite 屬性（原本這段設定寫在
       admin_server.py 裡，因為 session 屬於整個 app 層級的設定，所以搬移到 app.py 統一管理）
    7. 從環境變數讀取 LINE Channel 的 access token 與 secret，建立 Configuration
       （呼叫 LINE Messaging API 用）與 WebhookHandler（驗證/解析 Webhook 用）
    8. 定義三個基本路由：`/`（健康檢查用）、`/favicon.ico`（避免瀏覽器要圖示時噴 404 錯誤
       訊息）、`/eddichatbot`（LINE Webhook 主入口，見下方詳細說明）
    9. 匯入 bot 模組，呼叫 `bot.register_line_handlers(line_handler, configuration)`，
       把上面建立好的 WebhookHandler 與 Configuration 交給 bot.py，讓 bot.py 把它
       自己定義的事件處理函式（handle_follow、handle_message、handle_postback）動態
       綁定到這個 WebhookHandler 上，同時把 Configuration 存成 bot.py 的全域變數，
       供 bot.py 之後呼叫 LINE Messaging API 時使用
   10. 若以 `python app.py` 直接執行（非透過 WSGI/Vercel 啟動），則啟動 Flask 內建
       開發伺服器（debug=True）

【為什麼要用「動態註冊」而不是直接在 bot.py 裡寫 @handler.add(...) 裝飾器？】
    LINE Bot SDK 官方教學通常會在建立 WebhookHandler 的那個檔案裡，直接用
    `@handler.add(MessageEvent, message=TextMessageContent)` 裝飾器綁定處理函式。
    但這樣一來，WebhookHandler 實例與事件處理函式必須定義在同一個 Python 模組
    (`__main__` 或同一份檔案) 裡，否則裝飾器綁定的 handler 物件跟 app.py 實際使用的
    handler 物件可能不是同一個實例，導致「事件註冊了，但收不到觸發」的詭異問題
    （常見於 Flask app 用不同方式啟動時，`__name__` 判斷為 `__main__` 或
    模組名稱不一致所致）。
    本專案的作法是：
      - WebhookHandler 與 Configuration 這兩個「單例物件」永遠只在 app.py 建立一次
      - bot.py 只負責「定義」事件處理函式的邏輯（handle_follow 等），不自行建立
        WebhookHandler
      - app.py 啟動時主動呼叫 bot.register_line_handlers(...)，把 app.py 建立的
        WebhookHandler 實例「傳進去」讓 bot.py 呼叫 `.add(...)` 完成綁定
    這樣無論 app.py 是被 `python app.py` 直接執行、被 gunicorn/wsgi 啟動、或是被
    Vercel 的無伺服器函式呼叫，事件綁定的物件永遠是同一個，徹底解決命名空間不一致的問題。
====================================================================================
"""

from math import degrees
from linebot.v3 import (
    WebhookHandler
)
from linebot.v3.exceptions import (
    InvalidSignatureError
)
from linebot.v3.messaging import (
    Configuration
)

from flask import Flask, request, abort
import os
from dotenv import load_dotenv
from pathlib import Path
import sys

# ============== 僅為了修正 vercel 找不到 bot.py 的錯誤 ==============
# 背景：本專案部署在 Vercel 這類無伺服器 (Serverless) 平台時，執行環境的工作目錄
# 與模組搜尋路徑 (sys.path) 可能不包含 src/ 這個資料夾本身，導致 `import bot`、
# `from admin_server import admin_bp` 等「同目錄相對匯入」會找不到模組而丟出
# ModuleNotFoundError。以下三行手動把 app.py 所在的資料夾 (即 src/) 加進
# sys.path，確保無論在本機開發環境還是 Vercel 上執行，都能正確匯入同目錄下的
# bot.py / admin_server.py / form_handler.py / chat_logs.py。
# 取得目前 app.py 所在的絕對路徑 (也就是 src 資料夾)
current_dir = os.path.dirname(os.path.abspath(__file__))
# 將 src 資料夾強制加入 Python 的模組搜尋路徑中
if current_dir not in sys.path:
    sys.path.append(current_dir)
# ============== 修正結束 ==============

# ----- 路徑設定 -----
# base_dir：專案根目錄。app.py 位於 <root>/src/app.py，
# 所以要往上兩層 (parent.parent) 才會回到專案根目錄。
base_dir = Path(__file__).resolve().parent.parent
# env_path：.env 環境變數檔案的絕對路徑，內含 LINE 金鑰、LLM API 金鑰等機密設定。
env_path = base_dir / ".env"
# 將 .env 內容載入到 os.environ，讓後續 os.getenv(...) 能讀取到這些變數。
load_dotenv(dotenv_path=env_path)

# 指定網頁資料夾為 webpage
# webpage_dir 底下放的是所有會被 render_template() 使用的 HTML 樣板，
# 包含病患表單 (webpage/form/) 與醫護後台 (webpage/admin/) 兩大類頁面。
webpage_dir = base_dir / "webpage"

# 指定靜態檔案資料夾為 assets
# assets_dir 底下放圖片、Prompt 版本檔 (assets/prompts/)、衛教 Markdown 檔
# (assets/discharge/) 等靜態/資料檔案，其中圖片會透過 Flask 的 static 機制對外提供。
assets_dir = base_dir / "assets"

# 初始化 Flask，並將 template_folder 指向 webpage 資料夾，將 static_folder 指向 assets/images 資料夾
# - template_folder=webpage_dir：讓 render_template('form/form.html')、
#   render_template('admin/html/admin.html') 這類呼叫能正確找到樣板檔案。
# - static_folder=assets_dir, static_url_path='/assets'：讓 assets/ 底下的檔案可以
#   透過 URL 前綴 /assets/... 直接被瀏覽器存取（例如圖片、favicon 等公開靜態資源）。
app = Flask(__name__, template_folder=str(webpage_dir), static_folder=str(assets_dir), static_url_path='/assets')

# 引入其他 .py 檔案的 Blueprint
# 注意：這兩個 import 特意寫在 `app = Flask(...)` 之後，因為 form_handler.py 與
# admin_server.py 內部使用了 Flask 的 Blueprint 機制（不直接依賴 app 實例即可定義路由），
# 但仍需確保 sys.path 已經設定好 (見上方) 才能被正確找到並匯入。
from form_handler import form_bp   # 病患出院衛教表單、醫師登入表單頁的所有路由
from admin_server import admin_bp  # 醫護後台管理系統（登入、病患對話紀錄、醫師/科別/Prompt/衛教資料管理、統計）的所有路由

# 註冊網頁路由 Blueprint
# 註冊後，form_bp 與 admin_bp 裡用 @form_bp.route(...) / @admin_bp.route(...) 定義的
# 路由才會真正掛載到這個 Flask app 上、開始生效。
app.register_blueprint(form_bp)
app.register_blueprint(admin_bp)

# 原在 admin_server.py 中的 config, secret_key
# secret_key 用於對 Flask session cookie 進行簽章/加密，避免使用者端竄改 session 內容
# （例如竄改 is_admin 欄位偽裝成管理員）。因為 session 是整個 app 共用的機制
# （form_bp 的醫師登入與 admin_bp 的醫護後台登入都會用到 session），所以統一搬到
# app.py 這個「全域」層級設定，而不是各自在 Blueprint 檔案裡各設一次。
app.secret_key = 'eddi_admin_2026_secure_key'
# SESSION_COOKIE_SAMESITE = 'Lax'：避免 CSRF 風險的同時，仍允許一般的頁面導覽/表單提交
# 情境下 Cookie 能正常帶上（若設為 'Strict' 可能導致從外部連結導入時 session 遺失）。
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

# 從環境變數讀取 LINE 官方帳號的兩個核心憑證：
# - CHANNEL_ACCESS_TOKEN：呼叫 LINE Messaging API（回覆訊息、取得使用者資料等）所需的權杖。
# - CHANNEL_SECRET：驗證 Webhook 請求是否確實來自 LINE 官方伺服器（防止偽造請求）所需的密鑰。
channel_access_token = os.getenv("CHANNEL_ACCESS_TOKEN")
channel_secret = os.getenv("CHANNEL_SECRET")

# 初始化 LINE Webhook 與 API Configuration (Bot 將從此處引入以進行事件綁定與 API 呼叫)
# configuration：之後呼叫 `MessagingApi(ApiClient(configuration))` 時要用的設定物件，
#                內含 access_token，讓 bot.py 能發送回覆訊息、查詢使用者顯示名稱等。
# line_handler：LINE SDK 提供的 Webhook 事件分派器，負責驗證 X-Line-Signature 標頭、
#                解析 Webhook Request Body，並依照事件類型呼叫先前用 `.add(...)` 註冊過
#                的處理函式。這個實例會在下方透過 bot.register_line_handlers() 交給
#                bot.py 完成事件綁定。
configuration = Configuration(access_token=channel_access_token)
line_handler = WebhookHandler(channel_secret)


@app.route("/")
def hello():
    # 極簡的健康檢查 (health check) 路由：只要能連到伺服器根路徑，回應這串文字，
    # 常用於雲端平台（如 Vercel / Render）確認服務是否成功部署、存活。
    return "Line Bot is running!"

@app.route("/favicon.ico")
def favicon():
    # 瀏覽器/爬蟲會自動嘗試讀取 /favicon.ico，若沒有特別處理，Flask 預設會回傳 404，
    # 並在伺服器日誌中產生大量無意義的錯誤紀錄。這裡直接回應「204 No Content」
    # （代表請求成功但沒有內容），避免污染日誌，也不需要真的準備一張圖示。
    return "", 204  # 回傳「無內容」

@app.route("/eddichatbot", methods=['POST'])
def callback():
    """
    LINE Webhook 主入口。

    這個路由的網址 (/eddichatbot) 必須設定在 LINE Developers 後台的
    「Webhook URL」欄位。之後每當使用者對這個 LINE 官方帳號發送訊息、加好友、
    或點擊 Quick Reply/Postback 按鈕時，LINE 平台就會即時對這個 URL 發送一個
    HTTP POST 請求，Request Body 是描述該事件的 JSON，並在 Header 中夾帶
    X-Line-Signature（用 Channel Secret 做 HMAC-SHA256 簽章，用來驗證這個
    請求真的來自 LINE 官方伺服器，而非偽造）。

    處理流程：
      1. 從 Header 取出 X-Line-Signature 簽章字串。
      2. 取出整個請求內容的原始文字（as_text=True，注意順序：必須用「原始未解析」
         的 body 字串去驗證簽章，若先用 request.get_json() 解析再重新序列化，
         簽章驗證會因為字串內容/格式不同而失敗）。
      3. 記錄請求內容到 Flask logger，方便除錯（可在伺服器日誌中看到每次收到的
         原始 Webhook payload）。
      4. 呼叫 `line_handler.handle(body, signature)`：
         - LINE SDK 內部會先用 channel_secret 重新計算簽章，並與傳入的 signature
           比對，確認請求合法性；
         - 驗證通過後，會依照 body 中的事件類型 (event type)，分派給先前透過
           `bot.register_line_handlers()` 註冊在這個 line_handler 上的對應
           處理函式（例如收到文字訊息會呼叫 bot.handle_message、收到 Postback
           會呼叫 bot.handle_postback、使用者加好友會呼叫 bot.handle_follow）。
         - 這一步是「同步執行」的：bot.py 的處理函式會在這裡被直接呼叫並執行完畢
           （包含呼叫 LLM 產生回覆、讀寫聊天紀錄、回覆 LINE 訊息等），執行完才會
           繼續往下走。
      5. 若簽章驗證失敗 (InvalidSignatureError)，代表這個請求可能是偽造的，
         記錄警告訊息並回傳 HTTP 400 Bad Request（abort(400)），拒絕處理。
      6. 最終一律回傳純文字 'OK'（HTTP 200），這是 LINE 平台要求的 Webhook
         回應慣例——只要收到 200 OK，LINE 就認為這次事件已成功送達，不會重試。
    """
    # 取得 X-Line-Signature 標頭
    signature = request.headers['X-Line-Signature']

    # 取得請求內容作為純文字
    body = request.get_data(as_text=True)
    app.logger.info("Request body: " + body)

    # 處理 Webhook 內容，觸發 bot.py 中註冊的事件處理器
    try:
        line_handler.handle(body, signature)
    except InvalidSignatureError:
        app.logger.info("Invalid signature. Please check your channel access token/channel secret.")
        abort(400)

    return 'OK'


# 導入 bot.py 並動態註冊 LINE 事件處理器，徹底解決 __main__ 命名空間不一致問題
# 這一行必須放在 line_handler / configuration 都已經建立完成之後執行，
# 因為 register_line_handlers() 需要把這兩個「已經初始化好」的物件傳給 bot.py。
# 執行後：
#   - bot.py 內部的全域變數 `configuration` 會被設定成這裡建立的 configuration，
#     之後 bot.py 呼叫 `ApiClient(configuration)` 時就會用到正確的 LINE 存取權杖。
#   - line_handler 會被綁定上 bot.handle_follow / bot.handle_message / bot.handle_postback
#     三個事件處理函式，之後 callback() 路由呼叫 line_handler.handle(...) 才能正確
#     分派事件給這些函式執行。
import bot
bot.register_line_handlers(line_handler, configuration)

if __name__ == "__main__":
    # 只有在「直接執行這個檔案」(例如本機開發時執行 `python app.py`) 時才會進入這裡，
    # 啟動 Flask 內建的開發用伺服器 (debug=True 會開啟自動重載與詳細錯誤頁面)。
    # 若透過 gunicorn / Vercel 等 WSGI 方式啟動，則不會執行到這裡，而是直接使用
    # 上面已經建立好、註冊好路由與事件處理器的 `app` 物件作為 WSGI 應用程式。
    app.run(debug=True)
