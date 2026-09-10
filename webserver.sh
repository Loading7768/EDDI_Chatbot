#!/bin/bash
source .venv/bin/activate
sudo -v
sudo .venv/bin/gunicorn --workers 3 --bind unix:/srv/www/twsigntube.org/EDDI_Chatbot/webhook.sock -m 007 --user $USER --group www-data src.app:app >> webserver.log 2>&1 &
