"""Recover cached canonical rows, then discover distinct items inside Wiki groups."""
import asyncio
import json
import logging
from datetime import datetime,timezone

from PIL import Image
from collector import Archive,DATA,ROOT,RunLock,OneBot,collect,history,image_segments,read_json,save_json
from vision import TableReader


def confirmed(archive):
    return sum(not record.get("需要复核",True) for record in archive.items.values())


def cached_rows(archive,target):
    by_digest={}
    for line in (DATA/"target-messages.jsonl").open(encoding="utf-8"):
        event=json.loads(line)
        for segment in image_segments(event):
            data=segment.get("data",{})
            digest=archive.image_index.get(data.get("url") or data.get("file"))
            if digest:
                by_digest[digest]=event
    candidates=[]
    for path in (DATA/"images").glob("*.png"):
        try:
            with Image.open(path) as image:
                width,height=image.size
            candidates.append((height,width,path))
        except OSError:
            pass
    selected=[entry[2] for entry in sorted(candidates,reverse=True)[:4]]
    selected.extend(ROOT/record["来源图片"] for record in archive.items.values()
                    if record.get("需要复核") and record.get("来源图片"))
    # A deferred reply may already contain a missing row even when its table
    # is shorter than the largest cached tables.
    deferred_ids={archive.state["attempts"].get(name,{}).get("response_message_id")
                  for name in archive.state["deferred"]}
    selected.extend(DATA/"images"/(digest+".png") for digest,event in by_digest.items()
                    if event.get("message_id") in deferred_ids and event.get("message_id") is not None
                    and (DATA/"images"/(digest+".png")).is_file())
    reader=TableReader()
    for path in dict.fromkeys(selected):
        if confirmed(archive)>=target:
            break
        known={name for name,record in archive.items.items() if not record.get("需要复核",True)}
        try:
            records=reader.read(path,known_names=known)
        except (ValueError,OSError) as error:
            logging.warning("缓存表格暂未读取：%s",error)
            continue
        event=by_digest.get(path.stem,{})
        for record in records:
            if record["识别置信度"]["名称"]<.92:
                continue
            record.update(来源="幽幽子机器人",来源图片=str(path.relative_to(ROOT)),
                          消息ID=event.get("message_id"),采集时间=datetime.now(timezone.utc).isoformat(),
                          补回依据="已保存的机器人表格中完整且清晰的物品行")
            archive.store(record)
            logging.info("从已有完整表格补回：%s",record["名称"])
            if confirmed(archive)>=target:
                break
        archive.export()
    archive.update("正在核对独立物品数量",collected=len(archive.items),confirmed=confirmed(archive),target=target)


async def finish():
    settings=read_json(ROOT/"config.json",{})
    settings.update(interval_seconds=5,target_item_count=197)
    save_json(ROOT/"config.json",settings)
    archive=Archive()
    cached_rows(archive,197)
    queue=read_json(DATA/"queue.json",[])
    priority=[]
    remaining=[]
    # A shared Wiki page can contain several robot items. Test its actual list
    # labels independently when the page title returned a different known item.
    for entry in queue:
        mapped=archive.mapping.resolve(entry["name"])
        linked={value["返回名称"] for value in archive.mapping.data["queries"].values()
                if value.get("维基来源")==entry.get("source_url")}
        aliases=[name for name in entry.get("aliases",[]) if name not in archive.state["attempts"]
                 and not archive.available(name)]
        for index,name in enumerate(aliases):
            candidate=dict(entry,name=name,wiki_title=entry["name"],verify_query=True)
            (priority if mapped and mapped!=entry["name"] and len(linked)<=1 and index<4 else remaining).append(candidate)
    for entry in read_json(DATA/"wiki-extra-aliases.json",[]):
        if not archive.available(entry["name"]):
            priority.append(dict(entry,verify_query=True))
    # Small shared-page groups are more likely to distinguish independent
    # records; leave long material/colour/species variant groups until later.
    remaining.sort(key=lambda entry:len(entry.get("aliases",[])))
    entries=priority+queue+remaining
    async with OneBot(settings) as bot:
        await bot.call("get_login_info")
        await bot.discover()
        await history(bot,archive)
        await collect(bot,archive,entries,0)
    logging.info("独立物品：%s；已核对：%s",len(archive.items),confirmed(archive))


if __name__=="__main__":
    DATA.mkdir(parents=True,exist_ok=True)
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(DATA/"collector.log",encoding="utf-8"),logging.StreamHandler()])
    with RunLock():
        asyncio.run(finish())
