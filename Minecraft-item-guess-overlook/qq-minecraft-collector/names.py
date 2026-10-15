"""Evidence-based query names. No item/category-specific equivalence rules."""
import json
from pathlib import Path
from storage import save_json


class NameMap:
    def __init__(self,path):
        self.path=Path(path)
        self.data=json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {"version":1,"queries":{}}

    def resolve(self,query):
        value=self.data["queries"].get(query)
        return value["返回名称"] if value else None

    def accepted(self,query,aliases=()):
        values={query,*aliases}
        for name in list(values):
            canonical=self.resolve(name)
            if canonical:
                values.add(canonical)
        return values

    def remember(self,query,canonical,method,message_id=None,source_url=None,page_id=None):
        previous=self.data["queries"].get(query)
        if previous and previous["返回名称"]!=canonical:
            raise ValueError(f"查询名“{query}”出现两个返回名，需复核：{previous['返回名称']}、{canonical}")
        self.data["queries"][query]={"返回名称":canonical,"确认依据":method,"消息ID":message_id,
                                     "维基来源":source_url or (previous or {}).get("维基来源",""),
                                     "维基页面ID":page_id or (previous or {}).get("维基页面ID")}
        save_json(self.path,self.data)

    def aliases_for(self,canonical):
        return sorted(query for query,entry in self.data["queries"].items() if entry["返回名称"]==canonical)


def select_target_row(names,accepted,previous_names=None):
    """An exact accepted name, or exactly one appended row, identifies the reply."""
    exact=[index for index,name in enumerate(names) if name in accepted]
    if len(exact)>1:
        raise ValueError("表格中有多个候选名称，不能自动确定对应行")
    if (previous_names is not None and len(names)==len(previous_names)+1
            and names[:-1]==list(previous_names) and names[-1] not in previous_names):
        return len(names)-1,"查询后唯一新增行"
    if (previous_names is not None and len(names)>=3 and len(names)==len(previous_names)
            and names[:-1]==list(previous_names)[1:] and names[-1] not in previous_names):
        return len(names)-1,"滚动表格保留行同序且末尾唯一新增行"
    if len(exact)==1:
        return exact[0],"已确认名称"
    return None,None


def resolve_duplicate(names,query,mapping):
    """A duplicate has an identity only if already mapped or this round has one row."""
    canonical=mapping.resolve(query)
    if canonical:
        return canonical,"已确认名称"
    if len(names)==1:
        return names[0],"独立新局唯一物品且机器人确认已猜过"
    return None,None
