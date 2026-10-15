"""Read-only integrity check of collected records and CSV export."""
import csv
import json
import unicodedata
from pathlib import Path

ROOT=Path(r"D:\程序\personal blog\Minecraft-item-guess-overlook\qq-minecraft-collector")
DATA=ROOT/"data"
fields=["可再生性","堆叠数量","稀有度","获得方式","用途","库存类别","合成方式","掉落方式","初始版本"]
items=json.loads((DATA/"items.json").read_text(encoding="utf-8"))
mapping=json.loads((DATA/"name-map.json").read_text(encoding="utf-8"))["queries"]
conflicts=json.loads((DATA/"conflicts.json").read_text(encoding="utf-8"))
with (DATA/"items.csv").open(encoding="utf-8-sig",newline="") as stream:
    rows=list(csv.DictReader(stream))
errors=[]
normalized=set()
for name,record in items.items():
    if record.get("名称")!=name:
        errors.append(name+"：名称键不一致")
    key=unicodedata.normalize("NFKC",name)
    if key in normalized:
        errors.append(name+"：标准化名称重复")
    normalized.add(key)
    tags=record.get("标签",{})
    if set(tags)!=set(fields):
        errors.append(name+"：字段不完整")
    for field in fields:
        values=tags.get(field)
        if not isinstance(values,list) or not values or any(not isinstance(value,str) or not value.strip() for value in values):
            errors.append(name+"：标签为空 "+field)
        elif any(any(arrow in value for arrow in "↑↓↗↘↖↙↔↕") for value in values):
            errors.append(name+"：残留箭头 "+field)
    if record.get("需要复核",True):
        errors.append(name+"：尚未复核")
    if any(record.get("识别置信度",{}).get(field,0)<.92 for field in ["名称",*fields]):
        errors.append(name+"：识别置信度不足")
    if not record.get("来源图片") or not (ROOT/record["来源图片"]).is_file():
        errors.append(name+"：来源图片缺失")
    if not record.get("消息ID"):
        errors.append(name+"：原消息证据缺失")
for query,value in mapping.items():
    if value["返回名称"] not in items:
        errors.append(query+"：对应物品不存在")
for row in rows:
    record=items.get(row["名称"])
    if not record or any(row[field]!="、".join(record["标签"][field]) for field in fields):
        errors.append(row["名称"]+"：CSV与JSON不一致")
if len(rows)!=len(items) or len({row["名称"] for row in rows})!=len(items):
    errors.append("CSV条数或唯一名称数量不一致")
if conflicts:
    errors.append("仍有属性冲突记录")
settings=json.loads((ROOT/"config.json").read_text(encoding="utf-8"))
result={"unique_items":len(items),"csv_rows":len(rows),"confirmed":sum(not r.get("需要复核",True) for r in items.values()),
        "query_mappings":len(mapping),"target":settings.get("target_item_count"),"interval_seconds":settings["interval_seconds"],
        "target_met":len(items)==settings.get("target_item_count"),"errors":errors}
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(bool(errors or not result["target_met"]))
