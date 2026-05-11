from flask import Blueprint, request, render_template, jsonify, session, redirect
import time

# 建立一個名為 form_bp 的 Blueprint
form_bp = Blueprint('form_bp', __name__)

# --- 驗證碼暫存區 ---
# 將原本在 app.py 的暫存區移到這裡統一管理
# 格式: { "123456": {"user_id": "Uxxxx...", "expires_at": 1690000000} }
verification_codes = {}

# 清理過期驗證碼的輔助函式
def cleanup_expired_codes():
    current_time = time.time()
    expired_keys = [code for code, data in verification_codes.items() if current_time > data["expires_at"]]
    for k in expired_keys:
        del verification_codes[k]

# ================= 網頁路由 =================

@form_bp.route("/verify", methods=['GET'])
def verify_page():
    # 這裡直接對應 webpage/form_verify.html
    return render_template("form_verify.html")

@form_bp.route("/api/verify_code", methods=['POST'])
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

    # 驗證成功：取得 ID 與 名字
    user_id = record["user_id"]
    user_name = record.get("user_name", "未知用戶")
    del verification_codes[code]

    # --- 修改：存入 session ---
    session['form_verified'] = True
    session['form_user_id'] = user_id
    session['form_user_name'] = user_name

    return jsonify({"success": True, "redirect_url": "/form"})

@form_bp.route("/form")
def form_page():
    # --- 新增功能：後端檢查 Session 狀態 ---
    # 如果 session 裡沒有 verified 標記，代表未經登入流程，直接導向回驗證頁
    if not session.get('form_verified'):
        return redirect('/verify')
    
    # --- 從 session 取得 ID 與名字並組合 ---
    uid = session.get('form_user_id', '未知 ID')
    uname = session.get('form_user_name', '未知名字')
    # 格式範例：曾宇晨 (U123456...)
    display_info = f"{uname} ({uid})"
        
    return render_template("form.html", line_info=display_info)