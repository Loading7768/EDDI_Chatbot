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


### LINE Developers Webhook URL:
1. https://eddi-chatbot-own.vercel.app/callback
2. https://nlp.cse.ntou.edu.tw/cjlin/app.py

# Ubuntu 模擬器

## 1. wsl2 設定
1. 在 Windows 搜尋列中輸入 `開啟或關閉 Windows 功能`，勾選「Windows 子系統 Linux 版」、「虛擬機器平台」
2. 在 Windows 搜尋列中輸入 `cmd`，並選擇「以系統管理員身分執行」
3. 輸入指令 `wsl --install`
4. **更新系統並安裝環境：**
   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install python3 python3-pip python3-venv -y
   ```
5. **建立專案資料夾並進入：**
   ```bash
   mkdir my_linebot
   cd my_linebot
   ```
6. **建立並啟動虛擬環境：**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```
7. **安裝必要套件：**
   ```bash
   pip install flask line-bot-sdk
   ```
8. 使用 `nano app.py` 建立檔案，並貼上撰寫好的程式碼

## 2. Nginx 設定
1. **安裝 Nginx：**
   在新的終端機分頁輸入：
   ```bash
   sudo apt install nginx -y
   ```
2. **設定反向代理：**
   使用 nano 編輯器建立一個新的 Nginx 設定檔：
   ```bash
   sudo nano /etc/nginx/sites-available/linebot
   ```
   將以下內容貼上：
   ```nginx
   server {
       listen 80;
       server_name localhost;

       location / {
           proxy_pass http://127.0.0.1:5000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
   *(存檔離開：按 `Ctrl+S` -> `Ctrl+X`)*
3. **啟用設定檔並刪除預設網頁：**
   ```bash
   sudo ln -s /etc/nginx/sites-available/linebot /etc/nginx/sites-enabled/
   sudo rm /etc/nginx/sites-enabled/default
   ```
   *(若有其他的網頁在的話可能會出問題，但這裡刪掉在 available 還是看的到)
4. **檢查設定檔語法並重啟 Nginx：**
   ```bash
   sudo nginx -t
   sudo service nginx restart
   ```
   *(到這一步，你的 Nginx 已經成功將 `80` Port 的流量轉發到 `5000` Port 了。)*

## 3. ngrok 設定
1. **在 WSL2 中安裝 ngrok：**
   回到終端機，執行以下指令安裝：
   ```bash
   curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/keyrings/ngrok.asc >/dev/null
   echo "deb [signed-by=/etc/apt/keyrings/ngrok.asc] https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
   sudo apt update && sudo apt install ngrok
   ```
2. **綁定你的 ngrok 帳號 (需先去官網註冊取得 Token)：**
   ```bash
   ngrok config add-authtoken 你的_AUTH_TOKEN
   ```
3. **啟動 ngrok 並指向 Nginx (Port 80)：**
   **注意！** 這裡我們是指向 Nginx 的 `80` Port，而不是 Flask 的 `5000` Port，這樣才能測試到 Nginx 的反向代理是否正常運作。
   ```bash
   ngrok http 80
   ```
4. **設定 LINE Developers Console：**
   將 ngrok 畫面中顯示的 `https://xxxxxx.ngrok-free.dev` 複製下來。
   到 LINE 後台的 Webhook URL 欄位填寫：
   `https://xxxxxx.ngrok-free.dev/callback`

## 4. Gunicorn + Systemd
1. 啟動虛擬環境 (非常重要)
請確保你已經進入了存放 `app.py` 的專案資料夾，並且終端機前面有顯示 `(venv)`。如果沒有，請先啟動虛擬環境：
   ```bash
   source venv/bin/activate
   ```

2. 安裝 Gunicorn
透過 pip 安裝 Gunicorn 套件：
   ```bash
   pip install gunicorn
   ```

3. 使用 `nano` 編輯器，在系統的 systemd 目錄下建立一個新的服務檔案（我們將它命名為 `linebot.service`）：
   ```bash
   sudo nano /etc/systemd/system/linebot.service
   ```

4. 將以下內容完整複製並貼上到 nano 編輯器中：
    ```ini
    [Unit]
    Description=Gunicorn daemon for LINE Bot
    After=network.target

    [Service]
    # 執行程式的使用者
    User=<使用者名稱>

    # 告訴系統你的專案資料夾在哪裡
    WorkingDirectory=/home/<使用者名稱>/my_linebot

    # 告訴系統你的虛擬環境路徑
    Environment="PATH=/home/<使用者名稱>/my_linebot/venv/bin"

    # 啟動 Gunicorn 的完整指令
    ExecStart=/home/<使用者名稱>/my_linebot/venv/bin/python3 -m gunicorn -w 2 -b 127.0.0.1:5000 app:app

    # 如果程式當掉，系統會自動幫你重啟
    Restart=always

    [Install]
    WantedBy=multi-user.target
    ```

5. **重新載入 systemd 的設定：**
   ```bash
   sudo systemctl daemon-reload
   ```
6. **啟動你的 LINE Bot 服務：**
   ```bash
   sudo systemctl start linebot
   ```
7. **設定為開機自動啟動（重要！）：**
   ```bash
   sudo systemctl enable linebot
   ```
8. 請輸入以下指令查看狀態：
    ```bash
    sudo systemctl status linebot
    ```

* **如果成功：** 你會看到綠色的 `Active: active (running)`。
* **如果失敗：** 你會看到紅色的 `Active: failed` 或不斷閃爍的 `activating (auto-restart)`，並且在畫面下方會直接印出 Python 的錯誤日誌（例如缺少套件、金鑰沒填等）。



