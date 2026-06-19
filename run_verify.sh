#!/bin/sh
node server.js &
sleep 4
/home/user/PJT/.venv/bin/python3 verify.py
