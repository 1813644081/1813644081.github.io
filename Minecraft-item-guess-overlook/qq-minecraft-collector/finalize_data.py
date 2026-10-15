"""Finalize the completed run, audit coverage, and retain all exception evidence."""
import json
import shutil
from collections import Counter
from datetime import datetime,timezone

from collector import Archive,DATA,ROOT,RunLock,parse_item_list,read_json,save_json
from vision import TableReader


def finalize():
    archive=Archive()
    backup=DATA/"backups"/datetime.now().strftime("before-final-audit-%Y%m%d-%H%M%S")
    backup.mkdir(parents=True,exist_ok=True)
    for name in ("items.json","items.csv","progress.json","queue.json","name-map.json","conflicts.json"):
        if (DATA/name).exists():
            shutil.copy2(DATA/name,backup/name)
    old_queue=read_json(DATA/"queue.json",[])
    queue=parse_item_list((DATA/"wiki-items.html").read_text(encoding="utf-8"))
    names={entry["name"] for entry in queue}
    excluded_by_name={entry["name"]:entry for entry in read_json(DATA/"excluded-references.json",[])}
    excluded_by_name.update({entry["name"]:dict(entry,reason="该链接位于版本或限定条件注记，不是列表中的物品名称")
                            for entry in old_queue if entry["name"] not in names})
    excluded=[entry for name,entry in excluded_by_name.items() if name not in names]
    save_json(DATA/"excluded-references.json",excluded)
    save_json(DATA/"queue.json",queue)
    reader=None
    for canonical,old in list(archive.items.items()):
        if not old.get("需要复核") or not old.get("来源图片"):
            continue
        path=ROOT/old["来源图片"]
        if not path.is_file():
            continue
        if reader is None:
            reader=TableReader()
        try:
            records=reader.read(path,target_name=canonical)
        except (ValueError,OSError) as error:
            print("仍需复核：",canonical,str(error),flush=True)
            continue
        if records and not records[0]["需要复核"]:
            record=records[0]
            for key in ("来源","来源图片","消息ID","采集时间"):
                record[key]=old.get(key)
            record["复核时间"]=datetime.now(timezone.utc).isoformat()
            archive.store(record)
    for query,value in list(archive.state["deferred"].items()):
        if archive.entry_available(value["entry"]):
            archive.state["deferred"].pop(query,None)
    results=[]
    for entry in queue:
        query=entry["name"]
        canonical=archive.mapping.resolve(query) or query
        record=archive.items.get(canonical)
        if not record:
            relations=[value for value in archive.mapping.data["queries"].values()
                       if value.get("维基来源")==entry["source_url"] and value["返回名称"] in archive.items]
            if relations:
                canonical=relations[0]["返回名称"]
                record=archive.items[canonical]
        candidates=list(dict.fromkeys([query,*entry.get("aliases",[])]))
        attempts={name:archive.state["attempts"].get(name,{}) for name in candidates}
        if record:
            status="需要复核" if record.get("需要复核") else "已采集"
        elif attempts and all(value.get("outcome")=="机器人未收录" for value in attempts.values()):
            status="机器人未收录"
        else:
            status="待处理"
        linked_names=sorted({value["返回名称"] for value in archive.mapping.data["queries"].values()
                             if value.get("维基来源")==entry["source_url"] and value["返回名称"] in archive.items})
        if record and canonical not in linked_names:
            linked_names.append(canonical)
        results.append(dict(entry,返回名称=canonical if record else None,对应机器人物品=linked_names,状态=status,
                            确认记录=archive.mapping.data["queries"].get(query),
                            查询回复={name:value.get("reply","") for name,value in attempts.items()}))
    counts=dict(Counter(entry["状态"] for entry in results))
    report={"time":datetime.now(timezone.utc).isoformat(),"wiki_entries":len(results),
            "robot_records":len(archive.items),"counts":counts,"excluded_reference_count":len(excluded),
            "needs_review":[name for name,record in archive.items.items() if record.get("需要复核")],
            "entries":results}
    target=read_json(ROOT/"config.json",{}).get("target_item_count",0)
    confirmed=sum(not record.get("需要复核",True) for record in archive.items.values())
    completed=(confirmed>=target and not report["needs_review"]) if target else not (counts.get("待处理",0)+counts.get("需要复核",0)+len(report["needs_review"]))
    report.update(target=target,confirmed=confirmed,target_reached=completed)
    save_json(DATA/"coverage.json",report)
    candidates={}
    for entry in [*queue,*read_json(DATA/"wiki-extra-aliases.json",[])]:
        for name in [entry["name"],*entry.get("aliases",[])]:
            candidates.setdefault(name,entry.get("source_url",""))
    query_audit=[]
    for name,source in candidates.items():
        attempt=archive.state["attempts"].get(name)
        relation=archive.mapping.data["queries"].get(name)
        if not attempt:
            status="未单独查询"
        elif not attempt.get("finished",False):
            status="发送结果待确认"
        elif attempt.get("outcome")=="机器人未收录":
            status="机器人未收录"
        elif relation:
            status="已确认对应"
        else:
            status="回复已保存，名称待核对"
        query_audit.append({"查询名称":name,"状态":status,"来源":source,
                            "返回名称":relation["返回名称"] if relation else None,
                            "发送消息ID":(attempt or {}).get("sent_message_id"),
                            "回复消息ID":(attempt or {}).get("response_message_id")})
    audit_counts=dict(Counter(entry["状态"] for entry in query_audit))
    save_json(DATA/"query-audit.json",{"候选名称数量":len(query_audit),"状态统计":audit_counts,"名称记录":query_audit})
    archive.export()
    archive.update("目标物品已集齐并核对" if completed else "采集核对仍有待处理项",
                   collected=len(archive.items),confirmed=confirmed,target=target,coverage=counts)
    summary="# 物品采集核对\n\n"+f"机器人独立物品已核对：{confirmed}/{target or len(archive.items)}。\n"
    if completed and target:
        summary+="已达到指定数量，采集停止。查询间隔为每次收到回复后等待 5 秒。\n"
    summary+="\n维基名称验证进度与机器人独立物品数量分别统计；尚未逐个验证的别名不计作缺失物品。\n\n"
    summary+=f"维基物品条目：{len(results)}\n机器人独立记录：{len(archive.items)}\n"+"\n".join(f"{key}：{value}" for key,value in counts.items())
    summary+=f"\n排除版本注记链接：{len(excluded)}\n\n"
    summary+="数据来自幽幽子机器人的原始表格；不同查询名的返回关系及维基页面分别保留。\n"
    summary+="每个候选名称是否真正查询，见 query-audit.json；同一维基页面已有记录不等于其每个名称都已查询。\n"
    summary+="机器人未收录的条目保留原始查询回复，未补造标签。\n\n"
    for entry in results:
        if entry["状态"]!="已采集":
            summary+=f"- {entry['name']}：{entry['状态']}\n"
    (DATA/"采集结果说明.md").write_text(summary,encoding="utf-8")
    print(json.dumps({key:value for key,value in report.items() if key!="entries"},ensure_ascii=False,indent=2))


if __name__=="__main__":
    with RunLock():
        finalize()
