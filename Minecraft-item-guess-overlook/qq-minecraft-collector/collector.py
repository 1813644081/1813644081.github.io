"""Background item collector using a local, authenticated OneBot connection."""
import argparse
import asyncio
import contextlib
import csv
import hashlib
import json
import logging
import re
import time
import uuid
import unicodedata
from datetime import datetime, timezone
from collections import deque
from pathlib import Path
from urllib.parse import unquote, urlsplit

import aiohttp
from vision import FIELDS, TableReader
from names import NameMap, resolve_duplicate
from storage import save_json

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
LOG = logging.getLogger("collector")


class BusyError(RuntimeError):
    pass


class RunLock:
    def __enter__(self):
        import msvcrt
        self.file=(DATA/"collector.lock").open("a+b")
        if self.file.tell()==0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            msvcrt.locking(self.file.fileno(),msvcrt.LK_NBLCK,1)
        except OSError:
            self.file.close()
            raise BusyError("已有采集任务在运行，请先暂停该任务")
        return self

    def __exit__(self,*unused):
        import msvcrt
        self.file.seek(0)
        msvcrt.locking(self.file.fileno(),msvcrt.LK_UNLCK,1)
        self.file.close()


def read_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def segments(event):
    value = event.get("message",[])
    return value if isinstance(value,list) else []


def plain_text(event):
    parts=[]
    for segment in segments(event):
        data=segment.get("data",{})
        if segment.get("type")=="text":
            parts.append(data.get("text",""))
        elif segment.get("type")=="markdown":
            content=data.get("content","")
            if isinstance(content,str):
                parts.append(re.sub(r"!?\[[^\]]*\]\([^)]*\)","",content))
    return "".join(parts)


def image_segments(event):
    """Official QQ bots embed table images in Markdown rather than image segments."""
    seen=set()
    for segment in segments(event):
        if segment.get("type")=="image":
            yield segment
        elif segment.get("type")=="markdown":
            content=segment.get("data",{}).get("content","")
            if not isinstance(content,str):
                continue
            for url in re.findall(r"!?\[图片[^\]]*\]\((https?://[^\s)]+)\)",content):
                if url not in seen:
                    seen.add(url)
                    yield {"type":"image","data":{"url":url}}


def is_target(event, target):
    return (event.get("post_type")=="message" and event.get("message_type")=="private"
            and str(event.get("user_id",""))==str(target))


class OneBot:
    def __init__(self, settings):
        self.settings = settings
        self.target = str(settings.get("target_user_id", ""))
        self.pending = {}
        self.events = asyncio.Queue(maxsize=100)

    async def __aenter__(self):
        url = urlsplit(self.settings["ws_url"])
        if url.hostname not in ("127.0.0.1","localhost","::1"):
            raise ValueError("此采集工具只连接本机 QQ 接口")
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
        try:
            self.socket = await self.session.ws_connect(self.settings["ws_url"],
                headers={"Authorization":"Bearer "+self.settings["access_token"]},heartbeat=20)
        except Exception:
            await self.session.close()
            raise
        self.reader = asyncio.create_task(self.receive())
        return self

    async def __aexit__(self, *unused):
        self.reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.reader
        await self.socket.close()
        await self.session.close()

    async def receive(self):
        try:
            async for message in self.socket:
                if message.type != aiohttp.WSMsgType.TEXT:
                    continue
                payload = json.loads(message.data)
                echo = payload.get("echo")
                if echo in self.pending:
                    future = self.pending[echo]
                    if not future.done():
                        future.set_result(payload)
                elif self.target and is_target(payload,self.target):
                    if self.events.full():
                        self.events.get_nowait()
                    self.events.put_nowait(payload)
        except Exception as error:
            LOG.error("后台消息连接中断：%s",type(error).__name__)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("QQ 后台连接已断开"))

    async def call(self, action, **params):
        echo = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[echo] = future
        try:
            await self.socket.send_json({"action":action,"params":params,"echo":echo})
            try:
                result = await asyncio.wait_for(future,30)
            except asyncio.TimeoutError:
                raise RuntimeError(f"{action} 等待后台接口响应超时")
            if result.get("status") not in ("ok","async") or result.get("retcode",0)!=0:
                raise RuntimeError(f"{action} 调用失败：{result.get('message',result.get('wording','未知错误'))}")
            return result.get("data")
        finally:
            self.pending.pop(echo,None)

    async def discover(self):
        if self.target:
            info = await self.call("get_stranger_info",user_id=self.target)
            LOG.info("使用已配置的目标：%s",info.get("nickname",self.target))
            return self.target
        target_name = self.settings["target_name"]
        candidates = {}
        for action,params in (("get_recent_contact",{"count":30}),("get_friend_list",{})):
            try:
                result = await self.call(action,**params)
            except RuntimeError:
                LOG.warning("%s暂未返回，继续尝试其他定位方式",action)
                continue
            for item in result if isinstance(result,list) else []:
                names = [item.get(k,"") for k in ("nickname","remark","peerName","sendNickName")]
                matches = any(str(n) in (target_name,target_name+"机器人") for n in names if n)
                if not matches or item.get("chatType",1)!=1:
                    continue
                user_id = str(item.get("user_id",item.get("peerUin","")))
                if user_id:
                    candidates[user_id] = next((n for n in names if n),target_name)
            if len(candidates)==1:
                break
        if len(candidates)!=1:
            raise RuntimeError(f"未能唯一定位{target_name}，请在控制面板填写机器人的 QQ 号；匹配到{len(candidates)}个对象")
        self.target = next(iter(candidates))
        self.settings["target_user_id"] = self.target
        save_json(ROOT/"config.json",self.settings)
        LOG.info("已定位目标机器人：%s",candidates[self.target])
        return self.target

    async def send(self, text):
        if not self.target:
            raise RuntimeError("还没有确认目标机器人")
        return await self.call("send_private_msg",user_id=self.target,
            message=[{"type":"text","data":{"text":text}}])


class Archive:
    def __init__(self):
        DATA.mkdir(parents=True,exist_ok=True)
        self.items = read_json(DATA/"items.json",{})
        self.state = read_json(DATA/"progress.json",{"attempts":{},"state":"就绪"})
        self.state.setdefault("attempts",{})
        self.state.setdefault("deferred",{})
        self.mapping=NameMap(DATA/"name-map.json")
        self.conflicts=read_json(DATA/"conflicts.json",{})
        self.reader = None
        self.images = set(read_json(DATA/"processed-images.json",[]))
        self.image_index=read_json(DATA/"image-index.json",{})

    def update(self, state, **values):
        if state!="需要处理":
            self.state.pop("error",None)
        self.state.update(state=state,updated=datetime.now(timezone.utc).isoformat(),**values)
        save_json(DATA/"progress.json",self.state)

    def export(self):
        save_json(DATA/"items.json",self.items)
        with (DATA/"items.csv").open("w",encoding="utf-8-sig",newline="") as file:
            writer = csv.writer(file)
            writer.writerow(FIELDS+["查询名称","需要复核","来源图片"])
            for record in self.items.values():
                writer.writerow([record["名称"]]+["、".join(record["标签"][k]) for k in FIELDS[1:]]+
                                ["、".join(record.get("查询名称",[])),record["需要复核"],record.get("来源图片","")])
        save_json(DATA/"processed-images.json",sorted(self.images))
        save_json(DATA/"conflicts.json",self.conflicts)
        save_json(DATA/"image-index.json",self.image_index)

    def available(self,query):
        canonical=self.mapping.resolve(query) or query
        record=self.items.get(canonical)
        return canonical if record and not record.get("需要复核",True) else None

    def entry_available(self,entry):
        if self.available(entry["name"]):
            return True
        if entry.get("verify_query"):
            return False
        source=entry.get("source_url")
        return bool(source and any(value.get("维基来源")==source and self.available(query)
                    for query,value in self.mapping.data["queries"].items()))

    def bind(self,query,canonical,method,event,entry=None):
        entry=entry or {}
        self.mapping.remember(query,canonical,method,event.get("message_id"),
                              entry.get("source_url"),entry.get("page_id"))
        record=self.items.get(canonical)
        if record:
            record["查询名称"]=self.mapping.aliases_for(canonical)
            record["维基条目"]=[{"查询名称":name,"来源":value["维基来源"],
                                 "页面ID":value.get("维基页面ID")}
                                for name,value in self.mapping.data["queries"].items()
                                if value["返回名称"]==canonical and value.get("维基来源")]
        self.state["deferred"].pop(query,None)
        self.export()

    def defer(self,entry,reason):
        self.state["deferred"][entry["name"]]={"entry":entry,"reason":reason,
                                                "候选行":self.state.get("round_names")}

    def store(self,record):
        canonical=record["名称"]
        previous=self.items.get(canonical)
        # Equivalent response names do not prove that their attribute sets are equal.
        def compared(values):
            return {unicodedata.normalize("NFKC",value) for value in values}
        different=previous and any(compared(previous["标签"][key])!=compared(record["标签"][key]) for key in FIELDS[1:])
        if different:
            evidence=self.conflicts.setdefault(canonical,[previous.copy()])
            if not any(item["标签"]==record["标签"] for item in evidence):
                evidence.append(record)
            previous.update(需要复核=True,属性冲突=True)
            LOG.warning("%s出现不同标签，两个版本均已保存，需复核",canonical)
        else:
            if previous:
                for key in ("查询名称","维基条目","属性冲突"):
                    if key in previous:
                        record[key]=previous[key]
                if previous.get("属性冲突"):
                    record["需要复核"]=True
            self.items[canonical]=record

    async def download(self,bot,source):
        for attempt in range(3):
            if (DATA/"STOP").exists():
                raise ValueError("已请求暂停，图片留待复查")
            try:
                async with bot.session.get(source) as response:
                    response.raise_for_status()
                    if response.content_length and response.content_length>20_000_000:
                        raise ValueError("机器人图片过大")
                    chunks=bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        chunks.extend(chunk)
                        if len(chunks)>20_000_000:
                            raise ValueError("机器人图片过大")
                    return bytes(chunks)
            except (aiohttp.ClientError,asyncio.TimeoutError) as error:
                if attempt==2:
                    raise RuntimeError("图片下载多次失败，原回复已保存供复查") from error
                LOG.info("图片下载暂未成功，重试读取原图片")
                await asyncio.sleep(2)

    async def image(self, bot, segment, event, target_name=None,entry=None):
        image_data = segment.get("data",{})
        source = image_data.get("url")
        local = None
        cached_hash=self.image_index.get(source or image_data.get("file",""))
        cached_path=DATA/"images"/(cached_hash+".png") if cached_hash else None
        if cached_path and cached_path.is_file():
            local=str(cached_path)
        elif len(list(image_segments(event)))==1:
            previous=next((record for record in self.items.values()
                           if record.get("消息ID")==event.get("message_id") and record.get("来源图片")),None)
            if previous and (ROOT/previous["来源图片"]).is_file():
                local=str(ROOT/previous["来源图片"])
        if not local and image_data.get("file"):
            try:
                info = await bot.call("get_image",file=image_data["file"])
                local = info.get("file")
                source = info.get("url") or source
            except RuntimeError:
                pass
        if local and Path(local).is_file():
            content = Path(local).read_bytes()
        elif source and urlsplit(source).scheme in ("http","https"):
            content=await self.download(bot,source)
        else:
            raise ValueError("回复图片没有可读取的地址")
        digest = hashlib.sha256(content).hexdigest()
        image_path = DATA/"images"/(digest+".png")
        image_path.parent.mkdir(parents=True,exist_ok=True)
        if not image_path.exists():
            image_path.write_bytes(content)
        self.image_index[source or image_data.get("file",digest)]=digest
        save_json(DATA/"image-index.json",self.image_index)
        if self.reader is None:
            self.reader = TableReader()
        known={name for name,record in self.items.items() if not record.get("需要复核",True)}
        records = await asyncio.to_thread(self.reader.read,image_path,target_name=target_name,known_names=known,
            accepted_names=self.mapping.accepted(target_name) if target_name else None,
            previous_names=self.state.get("round_names"))
        self.state["round_names"]=self.reader.last_row_names if self.reader.last_names_trusted else None
        for record in records:
            record.update(来源="幽幽子机器人",来源图片=str(image_path.relative_to(ROOT)),
                          消息ID=event.get("message_id"),采集时间=datetime.now(timezone.utc).isoformat())
            if target_name:
                self.mapping.remember(target_name,record["名称"],record["名称匹配依据"],event.get("message_id"),
                                      (entry or {}).get("source_url"),(entry or {}).get("page_id"))
            self.store(record)
            if target_name:
                self.bind(target_name,record["名称"],record["名称匹配依据"],event,entry)
        if target_name is None:
            self.images.add(digest)
        self.export()
        return records

    async def event(self, bot, event, target_name=None,entry=None,read_images=True):
        collected = []
        # Only the selected bot's messages ever reach disk.
        with (DATA/"target-messages.jsonl").open("a",encoding="utf-8") as file:
            file.write(json.dumps(event,ensure_ascii=False)+"\n")
        for segment in image_segments(event) if read_images else ():
            try:
                collected.extend(await self.image(bot,segment,event,target_name,entry))
            except (ValueError,OSError,aiohttp.ClientError,RuntimeError) as error:
                LOG.warning("图片待复核：%s",error)
        return collected


async def history(bot, archive):
    result = await bot.call("get_friend_msg_history",user_id=bot.target,count=50)
    messages = result.get("messages",[]) if isinstance(result,dict) else result
    ordered=sorted(messages or [],key=lambda e:(e.get("time",0),int(e.get("real_seq",e.get("message_seq",0)) or 0)))
    start_command=bot.settings.get("start_command","")
    starts=[index for index,event in enumerate(ordered) if start_command and plain_text(event).strip()==start_command]
    if starts:
        ordered=ordered[starts[-1]:]
    entries={entry["name"]:entry for entry in read_json(DATA/"queue.json",[])}
    archive.state["round_names"]=None
    pending=None
    for event in ordered:
        sender = str(event.get("sender",{}).get("user_id",event.get("user_id","")))
        if sender!=bot.target:
            text=plain_text(event).strip()
            query=query_name(text,bot.settings["guess_template"])
            if query:
                pending=entries.get(query,{"name":query})
            elif text in (start_command,bot.settings.get("reset_command")):
                pending=None
                archive.state["round_names"]=None
            continue
        text=plain_text(event)
        if new_round_reply(text):
            archive.state.update(round_names=[],needs_new_round=False)
            archive.state.pop("round_action",None)
            pending=None
        records=await archive.event(bot,event,target_name=pending["name"] if pending else None,entry=pending)
        if pending and (records or duplicate_reply(text)):
            canonical=records[0]["名称"] if records else confirm_duplicate(archive,pending,event)
            if canonical:
                previous=archive.state["attempts"].get(pending["name"],{})
                previous.update(ok=True,phase="已完成",finished=True,returned_name=canonical)
                archive.state["attempts"][pending["name"]]=previous
            else:
                archive.defer(pending,"历史回复为已猜过，无法确认具体名称")
                previous=archive.state["attempts"].get(pending["name"],{})
                previous.update(ok=False,phase="已完成",finished=True,outcome="名称待确认")
                archive.state["attempts"][pending["name"]]=previous
            pending=None
        elif pending and (unavailable_item(text) or no_round(text)):
            previous=archive.state["attempts"].get(pending["name"],{})
            previous.update(ok=False,phase="已完成",finished=True,
                            outcome="机器人未收录" if unavailable_item(text) else "需要新一轮")
            archive.state["attempts"][pending["name"]]=previous
            pending=None
        elif pending and "继续加油" in text and list(image_segments(event)):
            archive.defer(pending,"历史表格名称或字段无法可靠确认")
            previous=archive.state["attempts"].get(pending["name"],{})
            previous.update(ok=False,phase="已完成",finished=True,outcome="名称待确认")
            archive.state["attempts"][pending["name"]]=previous
            pending=None
        if no_round(text) or round_ended(text):
            archive.state.update(needs_new_round=True,round_names=None)
            archive.state.pop("round_action",None)
            pending=None
    archive.update("历史回复已整理",collected=len(archive.items))
    LOG.info("已整理%d个物品",len(archive.items))


def no_round(text):
    return any(term in text for term in ("未开始","没有开始","还没开始","还没开局","先开始","先开局","没有正在进行","没有进行中"))


def round_ended(text):
    return any(term in text for term in ("游戏结束","游戏已结束","本局结束","结束啦","结束猜","已结束","已终止","猜对","猜中","猜出来了","次数用完","挑战失败","正确答案是"))


def new_round_reply(text):
    return "MC" in text.upper() and any(word in text for word in ("开始啦","开始了","开始猜"))


def duplicate_reply(text):
    return any(word in text for word in ("已经猜过","重复猜"))


def query_name(text,template):
    before,after=template.split("{item}")
    match=re.fullmatch(re.escape(before)+r"(.+?)"+re.escape(after),text,re.IGNORECASE)
    return match.group(1) if match else None


def confirm_duplicate(archive,entry,event):
    canonical,method=resolve_duplicate(archive.state.get("round_names") or [],entry["name"],archive.mapping)
    if canonical and canonical in archive.items:
        archive.bind(entry["name"],canonical,method,event,entry)
        return canonical
    return None


def unavailable_item(text):
    return any(term in text for term in ("不存在","不认识","没有这个物品","未收录","暂未收录","不包含方块","找不到该物品"))


def next_query_candidate(entry,attempts):
    """Use only names actually linked by the Wiki; never invent alternate names."""
    for name in entry.get("aliases",[]):
        if name==entry["name"] or name in attempts:
            continue
        return dict(entry,name=name,wiki_title=entry.get("wiki_title",entry["name"]))
    return None


def collection_entries(entries,archive):
    normalized={entry["name"] if isinstance(entry,dict) else str(entry):
                dict(entry) if isinstance(entry,dict) else {"name":str(entry)} for entry in entries}
    sources={entry.get("source_url") for entry in normalized.values() if entry.get("source_url")}
    for name,value in archive.state["deferred"].items():
        entry=value["entry"]
        if entry.get("wiki_title") in normalized or entry.get("source_url") in sources:
            normalized.setdefault(name,entry)
    return normalized


async def wait_interval(bot,archive):
    deadline=time.monotonic()+bot.settings["interval_seconds"]
    while time.monotonic()<deadline:
        if (DATA/"STOP").exists():
            archive.update("已暂停")
            return False
        await asyncio.sleep(min(.5,deadline-time.monotonic()))
    return True


async def round_command(bot,archive,kind):
    command=bot.settings.get("start_command" if kind=="start" else "reset_command")
    if not command:
        archive.update("缺少开局或结束指令，已暂停")
        return False
    if archive.state.get("round_action"):
        archive.update("上次开局或结束结果待确认")
        return False
    while not bot.events.empty():
        bot.events.get_nowait()
    archive.state["round_action"]={"kind":kind,"phase":"正在发送","command":command}
    archive.update("正在开启新一轮" if kind=="start" else "正在结束当前一轮")
    sent_at=time.time()
    receipt=await bot.send(command)
    archive.state["round_action"].update(phase="已发送",message_id=(receipt or {}).get("message_id"))
    archive.update("正在确认开局" if kind=="start" else "正在确认结束")
    deadline=time.monotonic()+bot.settings["reply_timeout_seconds"]
    while time.monotonic()<deadline:
        if (DATA/"STOP").exists():
            archive.update("已暂停")
            return False
        try:
            event=await asyncio.wait_for(bot.events.get(),min(1,deadline-time.monotonic()))
        except asyncio.TimeoutError:
            continue
        if event.get("time",sent_at)<sent_at-1:
            continue
        text=plain_text(event)
        await archive.event(bot,event,read_images=False)
        if kind=="start" and (new_round_reply(text) or ("MC" in text.upper() and "正在进行" in text)):
            if new_round_reply(text):
                archive.state["round_names"]=[]
            archive.state.update(needs_new_round=False)
            archive.state.pop("round_action",None)
            archive.update("新一轮已开始")
            return await wait_interval(bot,archive)
        if kind=="reset" and (round_ended(text) or no_round(text)):
            archive.state.update(needs_new_round=True,round_names=None)
            archive.state.pop("round_action",None)
            archive.update("当前一轮已结束")
            return await wait_interval(bot,archive)
        if any(word in text for word in ("频繁","稍后再试")):
            break
    archive.update("未确认开局或结束，已暂停")
    return False


async def begin_round(bot,archive):
    return await round_command(bot,archive,"start")


async def reset_round(bot,archive):
    if not archive.state.get("needs_new_round"):
        if not await round_command(bot,archive,"reset"):
            return False
    return await begin_round(bot,archive)


def parse_item_list(html):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html,"html.parser")
    heading = next((h for h in soup.select("h2") if "物品列表" in h.get_text()),None)
    if heading is None:
        raise ValueError("没有找到维基物品列表章节")
    block = heading.parent if heading.parent.name=="div" else heading
    grouped = {}
    for sibling in block.next_siblings:
        if not getattr(sibling,"name",None):
            continue
        if sibling.name=="h2" or sibling.select_one("h2"):
            break
        for link in sibling.select("li a[href^='/w/']"):
            if link.find_parent("sup") or link.find_parent(class_="tag"):
                continue
            target = unquote(urlsplit(link["href"]).path.removeprefix("/w/")).replace("_"," ")
            label = link.get_text(strip=True)
            if not label or not target or ":" in target:
                continue
            entry = grouped.setdefault(target,{"name":target,"aliases":[],"source_url":"https://zh.minecraft.wiki/w/"+target})
            if label not in entry["aliases"]:
                entry["aliases"].append(label)
    if len(grouped)<50:
        raise ValueError(f"物品列表只有{len(grouped)}项，停止以免使用不完整列表")
    return list(grouped.values())


async def collect(bot, archive, entries, limit):
    stop = DATA/"STOP"
    failures,attempted,round_count = 0,0,0
    normalized=collection_entries(entries,archive)
    queue=deque(entry for name,entry in normalized.items() if name not in archive.state["deferred"])
    review=deque(entry for name,entry in normalized.items() if name in archive.state["deferred"])
    isolated=False
    force_reset=False
    retries={}
    while queue or review:
        target=bot.settings.get("target_item_count",0)
        confirmed=sum(not record.get("需要复核",True) for record in archive.items.values())
        if target and confirmed>=target:
            archive.update("已集齐目标数量，采集停止",collected=len(archive.items),confirmed=confirmed,target=target)
            return
        if not queue:
            queue,review=review,deque()
            isolated=True
            force_reset=True
        entry=queue.popleft()
        item = entry["name"]
        if archive.entry_available(entry):
            archive.state["deferred"].pop(item,None)
            continue
        previous=archive.state["attempts"].get(item,{})
        if previous.get("outcome")=="机器人未收录":
            alternate=next_query_candidate(entry,archive.state["attempts"])
            if alternate:
                queue.appendleft(alternate)
            continue
        if previous.get("phase") in ("正在发送","已发送") and not previous.get("finished"):
            archive.update("上次发送结果待确认",current_item=item)
            LOG.warning("%s上次发送结果不明确，请先读取已有回复；没有自动重发",item)
            return
        if stop.exists() or (limit and attempted>=limit):
            archive.update("已暂停",collected=len(archive.items))
            return
        if force_reset or (isolated and len(archive.state.get("round_names") or [])!=1):
            archive.update("正在独立新局复查名称",current_item=item)
            if not await reset_round(bot,archive):
                return
            force_reset=False
            round_count=0
        elif archive.state.get("needs_new_round"):
            if not await begin_round(bot,archive):
                return
            round_count=0
        if bot.settings.get("items_per_round") and round_count>=bot.settings["items_per_round"]:
            if not await reset_round(bot,archive):
                return
            round_count=0
        while not bot.events.empty():
            bot.events.get_nowait()
        sent_at=time.time()
        command=bot.settings["guess_template"].format(item=item)
        archive.state["attempts"][item]={"phase":"正在发送","finished":False}
        archive.update("正在采集",current_item=item,collected=len(archive.items))
        LOG.info("查询：%s",item)
        receipt=await bot.send(command)
        archive.state["attempts"][item].update(phase="已发送",sent_message_id=(receipt or {}).get("message_id"))
        archive.update("正在采集",current_item=item,collected=len(archive.items))
        attempted+=1
        round_count+=1
        deadline=time.monotonic()+bot.settings["reply_timeout_seconds"]
        reply_text=[]
        canonical=None
        duplicate=False
        response_id=None
        while time.monotonic()<deadline and not stop.exists():
            try:
                event=await asyncio.wait_for(bot.events.get(),min(1,deadline-time.monotonic()))
            except asyncio.TimeoutError:
                continue
            if event.get("time",sent_at)<sent_at-1:
                continue
            text=plain_text(event)
            if text:
                reply_text.append(text)
            response_id=event.get("message_id")
            records=await archive.event(bot,event,target_name=item,entry=entry)
            if records:
                canonical=records[0]["名称"]
                break
            if duplicate_reply(text):
                duplicate=True
                canonical=confirm_duplicate(archive,entry,event)
                break
            if unavailable_item(text) or no_round(text) or round_ended(text) or any(term in text for term in ("稍后再试","频繁")):
                break
            if list(image_segments(event)) and "继续加油" in text:
                break
        matched=canonical is not None
        if stop.exists() and not matched:
            archive.update("已暂停",collected=len(archive.items))
            return
        archive.state["attempts"][item]={"ok":matched,"phase":"已完成","finished":True,"reply":"\n".join(reply_text),
                                       "sent_message_id":(receipt or {}).get("message_id"),
                                       "response_message_id":response_id,"returned_name":canonical}
        archive.update("正在采集",collected=len(archive.items))
        combined="\n".join(reply_text)
        if matched:
            LOG.info("已确认：%s → %s",item,canonical)
        elif duplicate:
            archive.defer(entry,"已猜过且当前有多个候选行，需要独立新局验证")
            archive.state["attempts"][item]["outcome"]="名称待确认"
            if not isolated:
                review.append(entry)
            else:
                archive.update("独立新局仍无法确认名称，已暂停",current_item=item)
                return
            LOG.info("%s已放入独立复查队列",item)
        elif unavailable_item(combined):
            archive.state["attempts"][item]["outcome"]="机器人未收录"
            alternate=next_query_candidate(entry,archive.state["attempts"])
            if alternate:
                queue.appendleft(alternate)
                LOG.info("维基标题未被接受，改用同一页面的列表名称：%s",alternate["name"])
        if no_round(combined) or round_ended(combined):
            archive.state.update(needs_new_round=True,round_names=None)
            if not matched:
                retries[item]=retries.get(item,0)+1
                if retries[item]>1:
                    archive.update("重新开局后仍未获得回复，已暂停",current_item=item)
                    return
                queue.appendleft(entry)
            archive.update("准备新一轮",collected=len(archive.items))
        if matched or duplicate or unavailable_item(combined) or no_round(combined) or round_ended(combined):
            failures=0
        else:
            failures+=1
            archive.defer(entry,"回复名称或字段无法可靠确认")
            if not isolated:
                review.append(entry)
            LOG.warning("%s未获得可匹配的数据，原回复已保存",item)
        if failures>=bot.settings["max_consecutive_failures"]:
            archive.update("连续失败，已暂停",collected=len(archive.items))
            return
        if any(term in combined for term in ("频繁","稍后再试")):
            archive.update("机器人需要处理，已暂停",collected=len(archive.items))
            return
        archive.update("正在独立复查" if isolated else "正在采集",collected=len(archive.items),
                       deferred_count=len(archive.state["deferred"]))
        if not await wait_interval(bot,archive):
            return
    archive.update("本次采集完成",collected=len(archive.items))


async def main_inner(args):
    DATA.mkdir(parents=True,exist_ok=True)
    settings=read_json(ROOT/"config.json",{})
    archive=Archive()
    if args.command=="items":
        html=args.html.read_text(encoding="utf-8")
        entries=parse_item_list(html)
        save_json(DATA/"queue.json",entries)
        print(f"物品列表已准备：{len(entries)}个合并条目")
        return
    async with OneBot(settings) as bot:
        info=await bot.call("get_login_info")
        LOG.info("QQ 后台已登录：%s",info.get("nickname",""))
        if args.command=="status":
            print("QQ 后台接口连接正常")
            return
        await bot.discover()
        if args.command=="discover":
            print("已定位幽幽子机器人")
            return
        if args.command=="history":
            await history(bot,archive)
            return
        entries=read_json(DATA/"queue.json",[])
        if args.names:
            indexed={entry["name"]:entry for entry in entries}
            entries=[indexed.get(name,{"name":name}) for name in args.names]
        if not entries:
            raise ValueError("还没有准备物品列表")
        # Recover data already returned before a pause or a process interruption.
        await history(bot,archive)
        await collect(bot,archive,entries,args.limit)


async def main(args):
    DATA.mkdir(parents=True,exist_ok=True)
    if args.command in ("history","collect"):
        with RunLock():
            await main_inner(args)
    else:
        await main_inner(args)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("command",choices=["status","discover","history","items","collect"])
    parser.add_argument("--html",type=Path)
    parser.add_argument("--limit",type=int,default=3)
    parser.add_argument("--names",nargs="*")
    args=parser.parse_args()
    DATA.mkdir(parents=True,exist_ok=True)
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(DATA/"collector.log",encoding="utf-8"),logging.StreamHandler()])
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        LOG.info("采集已停止，进度已保留")
    except BusyError as error:
        LOG.error("%s",error)
        raise SystemExit(1)
    except Exception as error:
        LOG.error("%s",error)
        Archive().update("需要处理",error=str(error))
        raise SystemExit(1)
