import json
import os
import re
import sys

def normalize_text(text):
    # Remove all whitespace characters
    return re.sub(r'\s+', '', text)

def main():
    # Attempt to fix printing encoding issues on Windows
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass
        
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    txt_path = os.path.join(base_dir, 'docs', 'EDdischarge.txt')
    json_path = os.path.join(base_dir, 'docs', 'EDdischarge.json')
    
    with open(txt_path, 'r', encoding='utf-8') as f:
        txt_content = f.read()
        
    with open(json_path, 'r', encoding='utf-8') as f:
        json_data = json.load(f)
        
    json_reconstructed = ""
    for item in json_data:
        json_reconstructed += item.get('topic_en', '')
        json_reconstructed += item.get('topic_zh', '')
        json_reconstructed += item.get('content', '')
        
    txt_norm = normalize_text(txt_content)
    json_norm = normalize_text(json_reconstructed)
    
    if txt_norm == json_norm:
        print("Contents are exactly the same (ignoring whitespace and newlines).")
    else:
        print("Contents are NOT the same!")
        print(f"TXT length (no whitespace): {len(txt_norm)}")
        print(f"JSON length (no whitespace): {len(json_norm)}")
        
        min_len = min(len(txt_norm), len(json_norm))
        for i in range(min_len):
            if txt_norm[i] != json_norm[i]:
                print(f"First diff at non-whitespace char index {i}:")
                start = max(0, i-20)
                end = min(min_len, i+20)
                print(f"TXT  context: ...{txt_norm[start:end]}...")
                print(f"JSON context: ...{json_norm[start:end]}...")
                print(f"TXT char: '{txt_norm[i]}' vs JSON char: '{json_norm[i]}'")
                break
                
        if len(txt_norm) != len(json_norm) and min_len == len(txt_norm):
            print("TXT is shorter, JSON has extra content.")
        elif len(txt_norm) != len(json_norm) and min_len == len(json_norm):
            print("JSON is shorter, TXT has extra content.")

if __name__ == '__main__':
    main()
