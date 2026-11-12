#!/usr/bin/env python3
"""把 /v1/tasks/{id}/events 的输出打印成时间线。"""
import json
import sys

data = json.load(sys.stdin)
for e in data.get("items", []):
    src = e.get("from_status") or "-"
    dst = e.get("to_status") or "-"
    payload = e.get("payload") or {}
    extra = ""
    if payload:
        extra = "  " + json.dumps(payload, ensure_ascii=False)[:110]
    print(f"{e['event_id']:>3}  {e['event_type']:<20} {src:<10} -> {dst:<10}{extra}")
