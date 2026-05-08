from flask import Flask, request, abort

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

import os
from dotenv import load_dotenv
import google.generativeai as genai
from pathlib import Path

# 引入在 bot.py 寫好的介面
from bot import get_ai_response

app = Flask(__name__)

# 使用 os.environ 取得變數
base_dir = Path(__file__).resolve().parent.parent
env_path = base_dir / ".env"
load_dotenv(dotenv_path=env_path)

channel_access_token = os.getenv("CHANNEL_ACCESS_TOKEN")
channel_secret = os.getenv("CHANNEL_SECRET")

configuration = Configuration(access_token=channel_access_token)
line_handler = WebhookHandler(channel_secret)

# # 設定 Gemini (交給 bot.py 處理)
# gemini_api_key = os.getenv("GEMINI_API_KEY")

# def get_gemini_model():
#     if not gemini_api_key:
#         return None
#     genai.configure(api_key=gemini_api_key)
#     return genai.GenerativeModel('gemini-flash-latest')

# gemini_model = get_gemini_model()


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
    print(f'Got {event.type} event')


# 訊息事件
@line_handler.add(MessageEvent, message=TextMessageContent)
def handle_message(event):
    with ApiClient(configuration) as api_client:
        line_bot_api = MessagingApi(api_client)
        user_message = event.message.text

        # 取得使用者的 LINE User ID
        user_id = event.source.user_id
        
        if user_message == 'postback':
            buttons_template = ButtonsTemplate(
                title='Postback Sample',
                text='Postback Action',
                actions=[
                    PostbackAction(label='Postback Action', text='Postback Action Button Clicked!', data='postback'),
                ])
            template_message = TemplateMessage(
                alt_text='Postback Sample',
                template=buttons_template
            )
            line_bot_api.reply_message(
                ReplyMessageRequest(
                    reply_token=event.reply_token,
                    messages=[template_message]
                )
            )
        else:
            # # 呼叫 Gemini 產生回覆
            # if gemini_model:
            #     try:
            #         # 加入 generation_config 限制最高輸出字數，避免 Vercel 10秒 timeout 導致不回覆
            #         response = gemini_model.generate_content(
            #             user_message
            #         )
            #         reply_msg = response.text
            #         print(reply_msg)
            #     except Exception as e:
            #         app.logger.error(f"Gemini API Error: {e}")
            #         reply_msg = "抱歉，我目前無法回應，請稍後再試。"
            # else:
            #     reply_msg = "系統尚未設定好 Gemini API Key 喔！"

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
        
@line_handler.add(PostbackEvent)
def handle_postback(event):
    if event.postback.data == 'postback':
        print('Postback event is triggered')

if __name__ == "__main__":
    app.run()