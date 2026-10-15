"""Recover missed query rows from saved images; never send QQ messages."""
import asyncio
import json
import re
import shutil
from datetime import datetime,timezone

from collector import Archive,DATA,RunLock,image_segments,plain_text,read_json,save_json


class OfflineBot:
    session=None
    async def call(self,*args,**kwargs):
        raise RuntimeError("离线复查只读取已经保存的图片")


async def recover():
    archive=Archive()
    backup=DATA/"backups"/datetime.now().strftime("before-row-recovery-%Y%m%d-%H%M%S")
    backup.mkdir(parents=True,exist_ok=True)
    for name in ("items.json","items.csv","progress.json","name-map.json","conflicts.json","image-index.json"):
        if (DATA/name).exists():
            shutil.copy2(DATA/name,backup/name)
    entries={entry["name"]:entry for entry in read_json(DATA/"queue.json",[])}
    attempts=archive.state["attempts"]
    candidates={name:entry for name,entry in attempts.items()
                if entry.get("response_message_id") is not None and not archive.available(name)}
    ids={attempt["response_message_id"] for attempt in candidates.values()}
    events={}
    for line in (DATA/"target-messages.jsonl").open(encoding="utf-8"):
        event=json.loads(line)
        if event.get("message_id") in ids:
            events[event["message_id"]]=event
    report={"time":datetime.now(timezone.utc).isoformat(),"recovered":[],"remaining":[]}
    for name,attempt in candidates.items():
        event=events.get(attempt["response_message_id"])
        if not event:
            report["remaining"].append({"name":name,"reason":"没有保存对应的原始回复"})
            continue
        entry=entries.get(name,archive.state["deferred"].get(name,{}).get("entry",{"name":name}))
        archive.state["round_names"]=[] if re.search(r"目前已猜\s*1\s*次",plain_text(event)) else None
        result=[]
        errors=[]
        for segment in image_segments(event):
            data=segment.get("data",{})
            digest=archive.image_index.get(data.get("url") or data.get("file"))
            if not digest or not (DATA/"images"/(digest+".png")).is_file():
                continue
            try:
                result=await archive.image(OfflineBot(),segment,event,target_name=name,entry=entry)
                if result:
                    break
            except (ValueError,OSError,RuntimeError) as error:
                errors.append(str(error))
        if result:
            attempt.update(ok=True,phase="已完成",finished=True,returned_name=result[0]["名称"],outcome="已从缓存图片补回")
            report["recovered"].append({"query":name,"name":result[0]["名称"],"needs_review":result[0]["需要复核"]})
            print("已从图片补回：",name,"→",result[0]["名称"],flush=True)
        else:
            report["remaining"].append({"name":name,"reason":"；".join(errors) or "缓存图片中没有可确认的目标行"})
    archive.state["round_names"]=None
    archive.export()
    archive.update("缓存图片已复查",collected=len(archive.items),cache_recovered=len(report["recovered"]))
    save_json(DATA/"recovery-report.json",report)
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=="__main__":
    with RunLock():
        asyncio.run(recover())
