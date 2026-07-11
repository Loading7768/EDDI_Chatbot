#!/bin/bash
source .venv/bin/activate
.venv/bin/gunicorn --workers 3 --bind unix:$HOME/mywork/EDDI_Chatbot/webhook.sock -m 007 src.app:app
