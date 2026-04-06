# EDDI_Chatbot
Emergency Department Discharge Instructions Chatbot

# LINE BOT 設置步驟

🔒**本地永久執行**
🛡️**部屬到 vercel 執行**
⚠️**需要由醫院提供**

## 1. LINE Developer
1. ⚠️建立 LINE Developer 帳號
2. 建立 Provider
3. 建立 Channels (選擇 **Create a Messaging API channel**)
4. ⚠️簡訊認證
5. 在 Official Account Manager 設定 Messaging API 連動
6. 後台的回覆與帳號細項設定
7. 產生 Channel Access Token

## 2. 安裝必要檔案
1. 安裝 Python
2. 安裝 VS Code
3. 🔒安裝 ngrok (需要有帳號)
    1. 打開 ngrok 執行官方網頁中的指令：`$ ngrok config add-authtoken <你的代碼>`
    2. 若是讓電腦一直執行程式，之後會需要一直開著執行檔
    3. 啟動臨時伺服器指令：`ngrok http <port>`(port 用 VS Code 預設是 5000)

## 3. 架設環境
1. 建立 Python 虛擬環境
```
python -m venv <環境名稱>
cd <環境資料夾>/Scripts
activate.bat
```
2. 建立 `requirements.txt`
```
line-bot-sdk==3.7
flask==3.0.0
```
3. 在虛擬環境中執行 `pip install -r <requirements.txt 所屬路徑>`

## 4. VS Code
1. 輸入環境路徑 (選擇虛擬環境資料夾中的 `Scripts/python.exe`)
2. 匯入機器人程式碼 (若尚無程式碼：網路搜尋 line bot sdk pipy 複製預設程式碼)
3. 輸入 LINE Developer 後台的 `CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET` (使用 `.env` 防止被 push 上去) (注意：`handler` 要改名成 `line_handler`)
4. 🔒啟動 Web 應用程序 (VS Code 偵錯模式：**create a launch.json file.** 並選擇到 **flask**)
5. 🔒啟用 ngrok 複製臨時伺服器網址
6. 🔒在 LINE Developer 中的 Webhook URL 貼上

## 5. LINE Bot 部屬到雲端
1. 將專案上傳到 GitHub 上 `(app.py, requirements.txt, vercel.json)`
2. 🛡️註冊 vercel 並建立專案
3. 🛡️將 Fragment Present 改成 `"Other"`
4. 🛡️設定 Environment Variables `(CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET)`
5. 🛡️更改 Webhook URL 為新的部屬網址

### Note: 若要更換 LINE Developers 的帳號
1. 🔒更改 .env 中的 `CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET`
2. 🛡️更改 vercel 上的 Environment Variables `(CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET)`


https://eddi-chatbot-own.vercel.app/callback

https://nlp.cse.ntou.edu.tw/cjlin/app.py