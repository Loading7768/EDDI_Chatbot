"""
run_admin.py — 放在 src/ 資料夾內，直接執行即可啟動後台。

使用方式：
    cd src
    python run_admin.py

前置作業（第一次或要重置資料庫時）：
    python ../init_db.py        # 若 init_db.py 放在專案根目錄
    或
    cd ..
    python init_db.py
"""

import sys
import os

# 確保可以 import 同目錄的 admin_server
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask
from admin_server import admin_bp, BASE_DIR

app = Flask(__name__)
app.secret_key = 'eddi_admin_2026_secure_key'
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

app.register_blueprint(admin_bp)

if __name__ == '__main__':
    print('=' * 48)
    print('  EDDI 醫師後台系統')
    print('=' * 48)
    print(f'  專案根目錄 : {BASE_DIR}')
    print(f'  後台網址   : http://localhost:5001/admin')
    print('  帳號       : admin / admin123')
    print('  停止伺服器 : Ctrl + C')
    print('=' * 48)

    # 啟動前檢查資料庫是否存在
    db_path = os.path.join(BASE_DIR, 'database', 'doctor.db')
    if not os.path.exists(db_path):
        print('\n⚠️  找不到 database/doctor.db')
        print('   請先執行：python init_db.py\n')

    app.run(debug=True, port=5001, host='0.0.0.0')