import asyncio
import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch,AsyncMock

import numpy as np
from PIL import Image,ImageDraw,ImageFont
from aiohttp import web

import collector
from collector import OneBot,Archive,collect,is_target,parse_item_list,image_segments,round_ended,next_query_candidate,collection_entries
from vision import FIELDS,TableReader,mask_arrows,find_grid
from names import NameMap,select_target_row,resolve_duplicate
from storage import save_json


def record(name,value="无"):
    return {"名称":name,"标签":{key:[value] for key in FIELDS[1:]},"需要复核":False}


class StorageTests(unittest.TestCase):
    def test_transient_windows_file_lock_preserves_old_data_then_retries(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/"progress.json"
            save_json(target,{"phase":"原有进度"})
            original=Path.replace
            calls=[]
            def replace(source,destination):
                calls.append(str(source))
                if len(calls)<=2:
                    self.assertEqual(json.loads(target.read_text(encoding="utf-8")),{"phase":"原有进度"})
                    raise PermissionError("文件暂时被占用")
                return original(source,destination)
            with patch.object(Path,"replace",replace),patch("storage.time.sleep"):
                save_json(target,{"phase":"已发送","sent_message_id":123})
            self.assertEqual(len(calls),3)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["sent_message_id"],123)

    def test_permanent_failure_is_bounded_and_keeps_both_copies(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/"progress.json"
            save_json(target,{"phase":"原有进度"})
            with patch.object(Path,"replace",side_effect=PermissionError("拒绝访问")) as replace,patch("storage.time.sleep"):
                with self.assertRaises(PermissionError):
                    save_json(target,{"phase":"新进度"})
            self.assertEqual(replace.call_count,9)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["phase"],"原有进度")
            temporary=list(Path(folder).glob("*.tmp"))
            self.assertEqual(len(temporary),1)
            self.assertEqual(json.loads(temporary[0].read_text(encoding="utf-8"))["phase"],"新进度")


class NameTests(unittest.TestCase):
    def test_rolling_table_requires_unchanged_overlap_and_unique_new_row(self):
        self.assertEqual(select_target_row(["靴子","胸甲","地图"],{"空地图"},["陶片","靴子","胸甲"]),
                         (2,"滚动表格保留行同序且末尾唯一新增行"))
        self.assertEqual(select_target_row(["胸甲","靴子","地图"],{"空地图"},["陶片","靴子","胸甲"]),(None,None))
        self.assertEqual(select_target_row(["靴子","胸甲","陶片"],{"空地图"},["陶片","靴子","胸甲"]),(None,None))
        self.assertEqual(select_target_row(["靴子","地图"],{"空地图"},["陶片","靴子"]),(None,None))

    def test_one_wiki_page_can_have_multiple_robot_item_names(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(collector,"DATA",Path(folder)):
            archive=Archive()
            archive.store(record("已确认返回名"))
            archive.mapping.remember("页面标题","已确认返回名","唯一新增行",source_url="https://example.com/group")
            entry={"name":"页面中的另一物品","source_url":"https://example.com/group","verify_query":True}
            self.assertFalse(archive.entry_available(entry))
            archive.store(record("另一个返回名"))
            archive.mapping.remember(entry["name"],"另一个返回名","唯一新增行",source_url=entry["source_url"])
            self.assertTrue(archive.entry_available(entry))

    def test_punctuation_width_does_not_create_false_attribute_conflict(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(collector,"DATA",Path(folder)):
            archive=Archive()
            old=record("山羊角")
            old["标签"]["用途"]=["触发警报!"]
            new=record("山羊角")
            new["标签"]["用途"]=["触发警报！"]
            archive.store(old)
            archive.store(new)
            self.assertFalse(archive.conflicts)
            self.assertFalse(archive.items["山羊角"]["需要复核"])

    def test_deferred_alternate_query_survives_resuming_original_wiki_queue(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(collector,"DATA",Path(folder)):
            archive=Archive()
            entry={"name":"维基标题","aliases":["列表名称"],"source_url":"https://example.com/item"}
            alternate=next_query_candidate(entry,{})
            archive.defer(alternate,"需要独立复查")
            names=collection_entries([entry],archive)
            self.assertIn("列表名称",names)
            self.assertNotIn("列表名称",collection_entries([{"name":"无关物品"}],archive))

    def test_actual_end_reply_and_wiki_candidate_names(self):
        self.assertTrue(round_ended("(´･ω･`) 本局结束啦~答案是：甜浆果"))
        entry={"name":"维基标题","aliases":["列表旧名称","列表名称"],"source_url":"https://example.com/item"}
        candidate=next_query_candidate(entry,{"列表旧名称":{"outcome":"机器人未收录"}})
        self.assertEqual(candidate["name"],"列表名称")
        self.assertEqual(candidate["source_url"],entry["source_url"])
        self.assertIsNone(next_query_candidate(entry,{"列表旧名称":{},"列表名称":{}}))

    def test_unique_added_row_identifies_a_different_name(self):
        self.assertEqual(select_target_row(["原有物品","通用返回名"],{"查询名称"},["原有物品"]),
                         (1,"查询后唯一新增行"))
        self.assertEqual(select_target_row(["甲","乙","丙"],{"查询名称"},["甲"]),(None,None))
        self.assertEqual(select_target_row(["另一个旧物品","新物品"],{"查询名称"},["原有物品"]),(None,None))

    def test_duplicate_needs_confirmed_map_or_single_row(self):
        with tempfile.TemporaryDirectory() as folder:
            mapping=NameMap(Path(folder)/"names.json")
            self.assertEqual(resolve_duplicate(["甲","乙"],"别名",mapping),(None,None))
            self.assertEqual(resolve_duplicate([],"别名",mapping),(None,None))
            canonical,method=resolve_duplicate(["甲"],"别名",mapping)
            mapping.remember("别名",canonical,method,123,"https://example.com/a")
            mapping.remember("另一个名字","甲","查询后唯一新增行",456,"https://example.com/b")
            loaded=NameMap(mapping.path)
            self.assertEqual(resolve_duplicate(["甲","乙"],"别名",loaded),("甲","已确认名称"))
            self.assertEqual(resolve_duplicate([],"别名",loaded),("甲","已确认名称"))
            self.assertEqual(set(loaded.aliases_for("甲")),{"别名","另一个名字"})
            with self.assertRaises(ValueError):
                loaded.remember("别名","乙","新证据")

    def test_conflicting_tags_preserve_both_versions(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(collector,"DATA",Path(folder)):
            archive=Archive()
            archive.store(record("共用名称","版本一"))
            archive.store(record("共用名称","版本二"))
            self.assertEqual(len(archive.conflicts["共用名称"]),2)
            self.assertTrue(archive.items["共用名称"]["需要复核"])
            self.assertEqual(archive.items["共用名称"]["标签"]["初始版本"],["版本一"])


class TableTests(unittest.TestCase):
    def test_low_confidence_usage_is_reread_without_lowering_threshold(self):
        image=Path(r"D:\程序\personal blog\Minecraft-item-guess-overlook\qq-minecraft-collector\data\images\9301de1f0f1e16c57b28295dbe94d26103062062291dfbfeb9d5713e7ac4dd56.png")
        result=TableReader().read(image,target_name="山羊角")[0]
        self.assertEqual(result["标签"]["用途"],["触发警报！"])
        self.assertGreaterEqual(result["识别置信度"]["用途"],.92)
        self.assertFalse(result["需要复核"])
        self.assertLess(result["字段识别复核"]["用途"]["初次置信度"],.92)

    def test_saved_missed_rows_and_uncertain_fish_name(self):
        images=Path(r"D:\程序\personal blog\Minecraft-item-guess-overlook\qq-minecraft-collector\data\images")
        fixtures=[
            ("瓶子草荚果","bb7fa85319b3d2712da9bf03200f52f0a97f4d37fde04c87bd9f128d604010a9.png",3,"1.20"),
            ("命令方块矿车","b064766d43f52ff0e42d53b4d8e5db51407e9198239867f28160db5037e33821.png",2,"1.7.2"),
            ("火把花种子","12e3faab63758996d59139f819d69fcd1f61e72ce9600f1f0a6773c30143063b.png",1,"1.20"),
            ("熟鲑鱼","71ba8e3eba80dad7775c2b133ce6ed8c71ffa0f4af1824f459324abbb6fa6ee8.png",1,"1.7.2"),
        ]
        reader=TableReader()
        for name,filename,count,version in fixtures:
            with self.subTest(name=name):
                path=images/filename
                _,rows=find_grid(np.asarray(Image.open(path).convert("RGB")))
                self.assertEqual(len(rows),count)
                with patch.object(reader,"read_cell",wraps=reader.read_cell) as spy:
                    records=reader.read(path,target_name=name)
                self.assertEqual(len(records),1)
                result=records[0]
                self.assertEqual(result["名称"],name)
                self.assertEqual(result["标签"]["初始版本"],[version])
                self.assertFalse(result["需要复核"])
                self.assertTrue(result["已遮挡箭头"]["初始版本"])
                self.assertEqual(spy.call_count,count+9+(1 if name=="熟鲑鱼" else 0))
                if name=="熟鲑鱼":
                    self.assertLess(result["名称识别复核"]["初次置信度"],.92)
                    self.assertGreaterEqual(result["名称识别复核"]["复核置信度"],.92)

    def test_official_bot_markdown_images(self):
        event={"message":[{"type":"markdown","data":{"content":"继续加油![图片 #1608px #372px](https://qqbot.ugcimg.cn/table.png)"}}]}
        self.assertEqual(list(image_segments(event)),[{"type":"image","data":{"url":"https://qqbot.ugcimg.cn/table.png"}}])

    def test_only_target_row_is_fully_recognised(self):
        fixture=Path(r"D:\程序\personal blog\Minecraft-item-guess-overlook\23c9acaf-fd0a-4ff6-95a9-42a40d569217.png")
        rgb=np.asarray(Image.open(fixture).convert("RGB"))
        _,rows=find_grid(rgb)
        y1,y2=rows[0]
        padding=np.full((8,rgb.shape[1],3),246,dtype=np.uint8)
        repeated=np.concatenate([rgb[:y1],rgb[y1:y2],padding,rgb[y1:y2],padding,rgb[y1:y2],padding])
        reader=TableReader()
        with tempfile.TemporaryDirectory() as folder:
            image=Path(folder)/"table.png"
            Image.fromarray(repeated).save(image)
            original=reader.read_cell
            names=iter([("剑",1),("船",1),("鸡蛋",1)])
            def recognise(crop):
                return next(names,None) or original(crop)
            with patch.object(reader,"read_cell",side_effect=recognise) as spy:
                result=reader.read(image,target_name="剑")
                self.assertEqual(len(result),1)
                self.assertEqual(spy.call_count,12)  # Three names plus only nine target fields.
            names=iter([("剑",1),("船",1),("鸡蛋",1)])
            with patch.object(reader,"read_cell",side_effect=recognise) as spy:
                self.assertEqual(reader.read(image,known_names={"剑","船","鸡蛋"}),[])
                self.assertEqual(spy.call_count,3)

    def test_real_table_preserves_tags_and_masks_arrow(self):
        fixture=Path(r"D:\程序\personal blog\Minecraft-item-guess-overlook\23c9acaf-fd0a-4ff6-95a9-42a40d569217.png")
        record=TableReader().read(fixture)[0]
        self.assertEqual(record["名称"],"剑")
        self.assertEqual(record["标签"]["获得方式"],["合成","升级","箱子掉落","怪物掉落","交易"])
        self.assertEqual(record["原文"]["初始版本"],"pre-alpha")
        self.assertTrue(record["已遮挡箭头"]["初始版本"])
        self.assertFalse(record["需要复核"])

    def test_up_and_down_arrows_are_masked_before_recognition(self):
        font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf",24)
        for text in ("64 ↓","pre-alpha ↑"):
            image=Image.new("RGB",(200,60),(239,188,185))
            ImageDraw.Draw(image).text((10,12),text,font=font,fill=(60,60,60))
            rgb=np.asarray(image)
            masked,removed=mask_arrows(rgb)
            self.assertEqual(len(removed),1,text)
            self.assertFalse(np.array_equal(masked,rgb))

    def test_target_filter_rejects_other_chats(self):
        self.assertTrue(is_target({"post_type":"message","message_type":"private","user_id":42},"42"))
        self.assertFalse(is_target({"post_type":"message","message_type":"group","user_id":42},"42"))
        self.assertFalse(is_target({"post_type":"message","message_type":"private","user_id":99},"42"))

    def test_item_links_merge_aliases(self):
        links="".join(f'<li><a href="/w/物品{i}">物品{i}</a></li>' for i in range(60))
        html='<div><h2>物品列表</h2></div><ul>'+links+'<li><a href="/w/船">橡木船</a></li><li><a href="/w/船">金合欢木船</a></li></ul><div><h2>历史</h2></div>'
        rows=parse_item_list(html)
        boats=[item for item in rows if item["name"]=="船"]
        self.assertEqual(len(boats),1)
        self.assertEqual(boats[0]["aliases"],["橡木船","金合欢木船"])

    def test_item_list_excludes_version_notes_but_preserves_real_item_links(self):
        links="".join(f'<li><a href="/w/物品{i}">物品{i}</a></li>' for i in range(60))
        html='<h2>物品列表</h2><ul>'+links+'<li><a href="/w/新物品">新物品</a><sup class="tag">[<a href="/w/版本说明">某版本限定</a>]</sup></li><li><a href="/w/Java版已移除物品#箭袋">箭袋</a></li></ul><h2>历史</h2>'
        entries=parse_item_list(html)
        names={entry["name"] for entry in entries}
        self.assertIn("新物品",names)
        self.assertNotIn("版本说明",names)
        self.assertEqual(next(entry["aliases"] for entry in entries if entry["name"]=="Java版已移除物品"),["箭袋"])


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_reaching_confirmed_target_stops_before_another_send(self):
        class Bot:
            settings={"target_item_count":1}
            async def send(self,*args):
                raise AssertionError("达到目标后不应继续发送")
        with tempfile.TemporaryDirectory() as folder,patch.object(collector,"DATA",Path(folder)):
            archive=Archive()
            archive.store(record("已确认物品"))
            await collect(Bot(),archive,[{"name":"不再查询"}],0)
            self.assertEqual(archive.state["state"],"已集齐目标数量，采集停止")

    async def test_history_uses_saved_image_when_original_url_is_unavailable(self):
        class Reader:
            last_row_names=["剑"]
            last_names_trusted=True
            def read(self,*args,**kwargs):
                return []
        class Bot:
            session=None  # Any attempt to download would fail this test.
        fixture=Path(r"D:\程序\personal blog\Minecraft-item-guess-overlook\23c9acaf-fd0a-4ff6-95a9-42a40d569217.png")
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            data=root/"data"
            with patch.object(collector,"ROOT",root),patch.object(collector,"DATA",data):
                archive=Archive()
                image=data/"saved.png"
                image.write_bytes(fixture.read_bytes())
                item=record("剑")
                item.update(消息ID=123,来源图片="data/saved.png")
                archive.store(item)
                archive.reader=Reader()
                event={"message_id":123,"message":[{"type":"image","data":{"url":"https://example.com/expired.png"}}]}
                await archive.image(Bot(),event["message"][0],event)
                item["消息ID"]=999
                await archive.image(Bot(),event["message"][0],event)
                self.assertIn("https://example.com/expired.png",archive.image_index)
                self.assertEqual(archive.state["round_names"],["剑"])

    async def test_ambiguous_aliases_reset_once_and_resolve_in_single_row_round(self):
        class FakeBot:
            settings={"reset_command":"/结束猜mc","start_command":"/猜mc物品",
                      "guess_template":"/我猜mc是{item}","reply_timeout_seconds":1,
                      "interval_seconds":0,"items_per_round":0,"max_consecutive_failures":3}
            events=asyncio.Queue()
            sent=[]
            async def send(self,text):
                self.sent.append(text)
                reply={"/结束猜mc":"游戏已结束","/猜mc物品":"MC物品猜谜开始啦",
                       "/我猜mc是名称甲":"继续加油","/我猜mc是名称乙":"这个已经猜过啦"}[text]
                message=[{"type":"text","data":{"text":reply}}]
                if "加油" in reply:
                    message.append({"type":"image","data":{"url":"https://example.com/table.png"}})
                await self.events.put({"message":message,"message_id":len(self.sent)})
                return {"message_id":len(self.sent)+100}
        with tempfile.TemporaryDirectory() as folder,patch.object(collector,"DATA",Path(folder)):
            archive=Archive()
            archive.store(record("共用名称"))
            archive.store(record("无关物品"))
            archive.state["round_names"]=["共用名称","无关物品"]
            for name in ("名称甲","名称乙"):
                archive.defer({"name":name,"source_url":"https://example.com/"+name},"已猜过，无法确定")
            async def table(bot,segment,event,target_name=None,entry=None):
                names=["共用名称"]
                selected,method=select_target_row(names,{target_name},archive.state["round_names"])
                self.assertEqual(selected,0)
                archive.state["round_names"]=names
                archive.bind(target_name,"共用名称",method,event,entry)
                return [archive.items["共用名称"]]
            with patch.object(archive,"image",side_effect=table):
                bot=FakeBot()
                await collect(bot,archive,[{"name":"名称甲"},{"name":"名称乙"}],0)
            self.assertEqual(bot.sent,["/结束猜mc","/猜mc物品","/我猜mc是名称甲","/我猜mc是名称乙"])
            self.assertEqual(archive.mapping.resolve("名称甲"),"共用名称")
            self.assertEqual(archive.mapping.resolve("名称乙"),"共用名称")
            self.assertFalse(archive.state["deferred"])
            self.assertTrue(archive.state["attempts"]["名称乙"]["ok"])

    async def test_echo_response_and_target_event_can_arrive_out_of_order(self):
        async def websocket(request):
            self.assertEqual(request.headers.get("Authorization"),"Bearer test-token")
            socket=web.WebSocketResponse()
            await socket.prepare(request)
            async for message in socket:
                request_data=message.json()
                await socket.send_json({"post_type":"message","message_type":"private","user_id":999,"message":[]})
                await socket.send_json({"post_type":"message","message_type":"private","user_id":42,"message":[]})
                await socket.send_json({"status":"ok","retcode":0,"data":{"value":"ok"},"echo":request_data["echo"]})
            return socket
        app=web.Application()
        app.router.add_get("/",websocket)
        runner=web.AppRunner(app)
        await runner.setup()
        site=web.TCPSite(runner,"127.0.0.1",0)
        await site.start()
        port=site._server.sockets[0].getsockname()[1]
        try:
            async with OneBot({"ws_url":f"ws://127.0.0.1:{port}","access_token":"test-token","target_user_id":"42"}) as bot:
                self.assertEqual(await bot.call("get_status"),{"value":"ok"})
                self.assertEqual((await asyncio.wait_for(bot.events.get(),1))["user_id"],42)
                self.assertTrue(bot.events.empty())
        finally:
            await runner.cleanup()


if __name__=="__main__":
    unittest.main()
