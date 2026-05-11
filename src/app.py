from linebot.v3 import (
    WebhookHandler
)
from linebot.v3.exceptions import (
    InvalidSignatureError
)
from linebot.v3.messaging import (
    Configuration,
    ApiClient,
    MessagingApi,
    ReplyMessageRequest,
    TextMessage,
    TemplateMessage,
    ButtonsTemplate,
    PostbackAction
)
from linebot.v3.webhooks import (
    MessageEvent,
    FollowEvent,
    PostbackEvent,
    TextMessageContent
)

from flask import Flask, request, abort, render_template, jsonify
import os
from dotenv import load_dotenv
import google.generativeai as genai
from pathlib import Path
import random
import time
from datetime import datetime, timedelta, timezone

# ============== 僅為了修正 vercel 找不到 bot.py 的錯誤 ==============
import sys
# 取得目前 app.py 所在的絕對路徑 (也就是 src 資料夾)
current_dir = os.path.dirname(os.path.abspath(__file__))
# 將 src 資料夾強制加入 Python 的模組搜尋路徑中
if current_dir not in sys.path:
    sys.path.append(current_dir)
# ============== 修正結束 ==============

# 引入其他 .py 檔案
from bot import get_ai_response
from admin_server import admin_bp


# ----- 路徑設定 -----
# 使用 os.environ 取得變數
base_dir = Path(__file__).resolve().parent.parent
env_path = base_dir / ".env"
load_dotenv(dotenv_path=env_path)

# 指定網頁資料夾為 webpage
webpage_dir = base_dir / "webpage"

# 指定靜態檔案資料夾為 assets
assets_dir = base_dir / "assets"

# 初始化 Flask，並將 template_folder 指向 webpage 資料夾，將 static_folder 指向 assets/images 資料夾
app = Flask(__name__, template_folder=str(webpage_dir), static_folder=str(assets_dir), static_url_path='/assets')

# 註冊從其他 .py 引入的網頁路由 Blueprint
app.register_blueprint(admin_bp)

# 原在 admin_server.py 中的 config, secret_key
app.secret_key = 'eddi_admin_2026_secure_key'
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

channel_access_token = os.getenv("CHANNEL_ACCESS_TOKEN")
channel_secret = os.getenv("CHANNEL_SECRET")

configuration = Configuration(access_token=channel_access_token)
line_handler = WebhookHandler(channel_secret)


@app.route("/")
def hello():
    return "Line Bot is running!"

@app.route("/favicon.ico")
def favicon():
    return "", 204  # 回傳「無內容」，告訴瀏覽器不用找了

@app.route("/eddichatbot", methods=['POST'])
def callback():
    # get X-Line-Signature header value
    signature = request.headers['X-Line-Signature']

    # get request body as text
    body = request.get_data(as_text=True)
    app.logger.info("Request body: " + body)

    # handle webhook body
    try:
        line_handler.handle(body, signature)
    except InvalidSignatureError:
        app.logger.info("Invalid signature. Please check your channel access token/channel secret.")
        abort(400)

    return 'OK'


# 加入好友事件
@line_handler.add(FollowEvent)
def handle_follow(event):
    # 取得使用者的 LINE User ID
    user_id = event.source.user_id

    print(f'Got {event.type} event, user_id: {user_id}')


# --- 驗證碼暫存區 ---
# 格式: { "123456": {"user_id": "Uxxxx...", "expires_at": 1690000000} }
verification_codes = {}

# 清理過期驗證碼的輔助函式 (避免記憶體佔用)
def cleanup_expired_codes():
    current_time = time.time()
    expired_keys = [code for code, data in verification_codes.items() if current_time > data["expires_at"]]
    for k in expired_keys:
        del verification_codes[k]

# 訊息事件
@line_handler.add(MessageEvent, message=TextMessageContent)
def handle_message(event):
    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        user_message = event.message.text
        user_id = event.source.user_id  # 取得使用者的 LINE User ID
        
        # if user_message == 'postback':
        #     buttons_template = ButtonsTemplate(
        #         title='Postback Sample',
        #         text='Postback Action',
        #         actions=[
        #             PostbackAction(label='Postback Action', text='Postback Action Button Clicked!', data='postback'),
        #         ])
        #     template_message = TemplateMessage(
        #         alt_text='Postback Sample',
        #         template=buttons_template
        #     )
        #     line_bot_api.reply_message(
        #         ReplyMessageRequest(
        #             reply_token=event.reply_token,
        #             messages=[template_message]
        #         )
        #     )
        if user_message == '修改病患表單': 
            cleanup_expired_codes() # 順手清理過期的舊驗證碼
            
            # 若同一個 user 重複產生驗證碼，留最新的驗證碼即可
            for code, data in verification_codes.items():
                if data["user_id"] == user_id:
                    del verification_codes[code]
                    break
                    
            # 產生一個不重複的 6 位數亂數
            while True:
                random_number = str(random.randint(100000, 999999))
                if random_number not in verification_codes:
                    break
            
            # 設定過期時間為現在時間 + 600秒 (10分鐘)
            expires_at = time.time() + 600
            
            # 用驗證碼當 Key 存起來
            verification_codes[random_number] = {
                "user_id": user_id,
                "expires_at": expires_at
            }

            # 將過期時間轉換成可讀性較高的格式，並以 UTC+8 的時間顯示
            tw_tz = timezone(timedelta(hours=8))
            dt_object = datetime.fromtimestamp(expires_at, tz=tw_tz)
            formatted_expiry = dt_object.strftime("%Y-%m-%d %H:%M:%S")
            
            reply_text = f"您的驗證碼是：{random_number}\n此驗證碼將於 10 分鐘後失效（{formatted_expiry}）"

            line_bot_api.reply_message(
                ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[TextMessage(text=reply_text)]
                )
            )
        else:
            # 呼叫 bot.py 的函數產生回覆
            try:
                # 這裡預設使用 gemini，如果你想換成 openai 可以改成 get_ai_response(user_id, user_message, ai_type='openai')
                reply_msg = get_ai_response(user_id, user_message, ai_type='gemini')
                print(f"回覆內容: {reply_msg}")
            except Exception as e:
                app.logger.error(f"系統整合錯誤: {e}")
                reply_msg = "抱歉，我目前無法回應，請稍後再試。"

            line_bot_api.reply_message(
                ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[TextMessage(text=reply_msg)]
                )
            )
        
# @line_handler.add(PostbackEvent)
# def handle_postback(event):
#     if event.postback.data == 'postback':
#         print('Postback event is triggered')


# ================= 網頁路由 =================

@app.route("/verify", methods=['GET'])
def verify_page():
    # 這裡直接對應 webpage/form_verify.html
    return render_template("form_verify.html")

@app.route("/api/verify_code", methods=['POST'])
def verify_code():
    data = request.json
    code = data.get("code")
    password = data.get("password")

    # 1. 驗證密碼
    if password != "12345":
        return jsonify({"success": False, "message": "密碼錯誤"})

    # 2. 尋找驗證碼記錄
    record = verification_codes.get(code)
    if not record:
        return jsonify({"success": False, "message": "驗證碼錯誤或不存在"})

    # 3. 檢查是否過期
    if time.time() > record["expires_at"]:
        del verification_codes[code] # 過期就刪除
        return jsonify({"success": False, "message": "驗證碼已逾時(超過10分鐘)，請回 LINE 重新取得"})

    # 驗證成功：取得該使用者 ID 並刪除一次性驗證碼
    user_id = record["user_id"]
    del verification_codes[code]
    
    # [備註] 實務上你可能需要把 user_id 存進 Flask session，這樣導向 form.html 後才知道是誰在操作
    # session['user_id'] = user_id 

    return jsonify({"success": True, "redirect_url": "/form"})

@app.route("/form")
def form_page():
    # 這裡對應 webpage/form.html
    return render_template("form.html")

if __name__ == "__main__":
    app.run()