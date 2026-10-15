"""Query the source-confirmed template subtype, retaining full robot evidence."""
import asyncio
import logging
from collector import Archive,DATA,ROOT,RunLock,OneBot,collect,history,read_json

async def run():
    settings=read_json(ROOT/"config.json",{})
    archive=Archive()
    names={"下界合金升级","下界合金升级锻造模板","Netherite Upgrade"}
    entries=[dict(entry,verify_query=True) for entry in read_json(DATA/"wiki-extra-aliases.json",[])
             if entry["name"] in names]
    async with OneBot(settings) as bot:
        await bot.call("get_login_info")
        await bot.discover()
        await history(bot,archive)
        await collect(bot,archive,entries,0)

if __name__=="__main__":
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(DATA/"collector.log",encoding="utf-8"),logging.StreamHandler()])
    with RunLock():
        asyncio.run(run())
