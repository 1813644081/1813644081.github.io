"""Prepare local-only NapCat and collector settings without printing tokens."""
import json
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "runtime" / "napcat-node-v4.18.38"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def prepare():
    settings_path = ROOT / "config.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    else:
        settings = {
            "ws_url": "ws://127.0.0.1:60991",
            "access_token": secrets.token_urlsafe(32),
            "webui_token": secrets.token_urlsafe(24),
            "target_name": "幽幽子",
            "target_user_id": "",
            "guess_template": "/我猜mc是{item}",
            "start_command": "/猜mc物品",
            "reset_command": "/结束猜mc",
            "items_per_round": 0,
            "interval_seconds": 5,
            "target_item_count": 197,
            "reply_timeout_seconds": 60,
            "max_consecutive_failures": 3,
        }
        save(settings_path, settings)
    config_dir = BACKEND / "napcat" / "config"
    save(config_dir / "webui.json", {
        "host": "127.0.0.1", "port": 6099,
        "token": settings["webui_token"], "loginRate": 10,
        "autoLoginAccount": "", "disableWebUI": False,
    })
    save(config_dir / "onebot11.json", {
        "network": {
            "httpServers": [], "httpClients": [],
            "websocketServers": [{
                "name": "minecraft-collector", "enable": True,
                "host": "127.0.0.1", "port": 60991,
                "messagePostFormat": "array", "reportSelfMessage": False,
                "token": settings["access_token"], "enableForcePushEvent": True,
                "debug": False, "heartInterval": 30000,
            }], "websocketClients": [], "plugins": [],
        }, "musicSignUrl": "", "enableLocalFile2Url": False,
        "parseMultMsg": False,
    })
    return settings


if __name__ == "__main__":
    prepare()
    print("本机后台接口配置已准备。")
