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
# 取得目前 app.py 所在的絕對路徑 (也就是 src 資料夾)
current_dir = os.path.dirname(os.path.abspath(__file__))
# 將 src 資料夾強制加入 Python 的模組搜尋路徑中
if current_dir not in sys.path:
    sys.path.append(current_dir)
# ============== 修正結束 ==============

# ----- 路徑設定 -----
base_dir = Path(__file__).resolve().parent.parent
env_path = base_dir / ".env"
load_dotenv(dotenv_path=env_path)

# 指定網頁資料夾為 webpage
webpage_dir = base_dir / "webpage"

# 指定靜態檔案資料夾為 assets
assets_dir = base_dir / "assets"

# 初始化 Flask，並將 template_folder 指向 webpage 資料夾，將 static_folder 指向 assets/images 資料夾
app = Flask(__name__, template_folder=str(webpage_dir), static_folder=str(assets_dir), static_url_path='/assets')

# 引入其他 .py 檔案的 Blueprint
from form_handler import form_bp
from admin_server import admin_bp

# 註冊網頁路由 Blueprint
app.register_blueprint(form_bp)
app.register_blueprint(admin_bp)

# 原在 admin_server.py 中的 config, secret_key
app.secret_key = 'eddi_admin_2026_secure_key'
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

channel_access_token = os.getenv("CHANNEL_ACCESS_TOKEN")
channel_secret = os.getenv("CHANNEL_SECRET")

# 初始化 LINE Webhook 與 API Configuration (Bot 將從此處引入以進行事件綁定與 API 呼叫)
configuration = Configuration(access_token=channel_access_token)
line_handler = WebhookHandler(channel_secret)


@app.route("/")
def hello():
    return "Line Bot is running!"

@app.route("/favicon.ico")
def favicon():
    return "", 204  # 回傳「無內容」

@app.route("/eddichatbot", methods=['POST'])
def callback():
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
import bot
bot.register_line_handlers(line_handler, configuration)

if __name__ == "__main__":
    app.run()