"""
This script extracts text from discharge PDF and save it in json format.
"""
from pypdf import PdfReader
import re
import json

pdfPath = 'docs/EDdischarge.pdf'
jsonPath = 'docs/EDdischarge.json'

def pdf2json(pdfPath, jsonPath):
    reader = PdfReader(pdfPath)
    text = '\n'.join(p.extract_text() for p in reader.pages)
    lines = text.split('\n')
    
    data = []
    current_item = None
    content_buffer = []
    for line in lines:
        line = line.strip()
        if re.search(r'^[A-Za-z\s,]+$', line):
            if current_item:
                current_item['content'] = ''.join(content_buffer)
                data.append(current_item)

            current_item = {'topic_en': line, 'topic_zh': '', 'content': ''}
            content_buffer = []
        elif current_item and not current_item['topic_zh']:
            current_item['topic_zh'] = line
        elif current_item:
            content_buffer.append(line)

    # last item from the loop
    if current_item:
        current_item['content'] = ''.join(content_buffer)
        data.append(current_item)

    with open(jsonPath, 'w', encoding='utf-8') as file:
        json.dump(data, file, ensure_ascii=False, indent=4)

pdf2json(pdfPath, jsonPath)
