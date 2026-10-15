"""Atomic JSON saves with bounded retries for Windows reader/antivirus locks."""
import json
import time
import uuid
from pathlib import Path


def save_json(path,value):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+"."+uuid.uuid4().hex+".tmp")
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding="utf-8")
    for attempt in range(9):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt==8:
                # Keep the intact old file and the new temporary copy for recovery.
                raise
            time.sleep(min(.05*2**attempt,.5))
