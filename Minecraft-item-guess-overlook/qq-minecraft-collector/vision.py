"""Read the game's ten-column table. Comparison arrows are masked before OCR."""
import json
import re
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from names import select_target_row

FIELDS = ["名称", "可再生性", "堆叠数量", "稀有度", "获得方式", "用途",
          "库存类别", "合成方式", "掉落方式", "初始版本"]


def runs(mask, minimum=1):
    padded = np.r_[False, np.asarray(mask, dtype=bool), False].astype(int)
    starts = np.flatnonzero(np.diff(padded) == 1)
    ends = np.flatnonzero(np.diff(padded) == -1)
    return [(int(a), int(b)) for a, b in zip(starts, ends) if b-a >= minimum]


def find_grid(rgb):
    height, width = rgb.shape[:2]
    dark = np.max(rgb, axis=2) < 115
    headers = runs(dark.sum(axis=1) > width * .48, minimum=12)
    if not headers:
        raise ValueError("图片中没有找到表头")
    top, bottom = headers[0]
    # Read the strip above the white headings so letter holes do not split columns.
    columns = runs(dark[top+2:top+7].mean(axis=0) > .5, minimum=25)
    if len(columns) != 10:
        raise ValueError(f"表格应有10列，实际检测到{len(columns)}列")
    x1, x2 = columns[0]
    # The inner left padding stays grey even when a long name fills the cell.
    # Measuring across the text area splits rows at dark glyph strokes.
    profile = np.median(rgb[:, x1+2:x1+6].mean(axis=2), axis=1)
    row_mask = (profile > 150) & (profile < 243)
    row_mask[:bottom+2] = False
    rows = runs(row_mask, minimum=25)
    if not rows:
        raise ValueError("表格中没有找到物品行")
    return columns, rows


def mask_arrows(cell):
    """Detect an arrow's connected pixel shape; never give arrow pixels to OCR."""
    result = cell.copy()
    threshold = min(190, float(np.median(cell.mean(axis=2)))-30)
    binary = (cell.mean(axis=2) < threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    candidates = []
    for index in range(1, count):
        x, y, w, h, area = map(int, stats[index])
        if h < 9 or w < 4 or w > h * .8 or area < 10:
            continue
        shape = (labels[y:y+h, x:x+w] == index)
        stalk = int(np.argmax(shape.sum(axis=0)))
        if abs(stalk - (w-1)/2) > max(1.5, w*.2):
            continue
        if shape[:, stalk].sum() < h*.8:
            continue
        row_width = np.array([np.ptp(np.flatnonzero(row))+1 if row.any() else 0
                              for row in shape])
        part = max(3, h//2)
        up = row_width[part:].max(initial=0) <= 3 and row_width[:part].max(initial=0) >= 5
        down = row_width[:h-part].max(initial=0) <= 3 and row_width[h-part:].max(initial=0) >= 5
        if up or down:
            candidates.append((x, y, w, h))
    # Comparison arrows follow the centred number/version, never precede it.
    removed = []
    text_right = max((int(s[0]+s[2]) for s in stats[1:] if s[4] >= 5), default=0)
    background = np.median(cell.reshape(-1, 3), axis=0).astype(np.uint8)
    for x, y, w, h in candidates:
        if x+w < text_right-2:
            continue
        result[max(0,y-1):y+h+1, max(0,x-1):x+w+1] = background
        removed.append([x,y,w,h])
    return result, removed


def merge_text(output):
    if output is None or output.txts is None:
        return "", 0.0
    tokens = []
    for box, text, score in zip(output.boxes, output.txts, output.scores):
        tokens.append((float(np.mean(box[:,1])), float(np.min(box[:,0])), text, float(score)))
    tokens.sort(key=lambda t: (round(t[0]/12), t[1]))
    text = "".join(t[2] for t in tokens)
    text = re.sub(r"\s+", "", text).replace("，", "、").replace(",", "、")
    return text, min((t[3] for t in tokens), default=0.0)


class TableReader:
    def __init__(self):
        from rapidocr import RapidOCR
        self.engine = RapidOCR(params={"Global.text_score": .3})

    def read_cell(self, crop, extra_padding=False):
        # Recognise complete lines, including isolated leading punctuation that
        # the text detector often omits. Concatenate lines without inventing tags.
        ink = crop.mean(axis=2) < min(190,float(np.median(crop.mean(axis=2)))-30)
        spans = runs(ink.any(axis=1))
        merged = []
        for start,end in spans:
            if merged and start-merged[-1][1] <= 3:
                merged[-1] = (merged[-1][0],end)
            else:
                merged.append((start,end))
        texts,scores = [],[]
        for start,end in merged:
            xs = np.flatnonzero(ink[start:end].any(axis=0))
            if not len(xs):
                continue
            line = crop[max(0,start-3):end+3,max(0,int(xs[0])-4):int(xs[-1])+5]
            interpolation=cv2.INTER_CUBIC
            if extra_padding:
                gray=cv2.cvtColor(line,cv2.COLOR_RGB2GRAY)
                gray=cv2.copyMakeBorder(gray,6,6,12,12,cv2.BORDER_CONSTANT,value=int(np.median(gray)))
                line=cv2.cvtColor(gray,cv2.COLOR_GRAY2RGB)
                interpolation=cv2.INTER_LANCZOS4
            line = cv2.resize(line,None,fx=2,fy=2,interpolation=interpolation)
            output = self.engine(line,use_det=False,use_cls=False)
            texts.extend(output.txts or [])
            scores.extend(output.scores or [])
        text = re.sub(r"\s+","","".join(texts)).replace("，","、").replace(",","、")
        return text,min(scores,default=0.0)

    def read(self, image_path, debug_dir=None, target_name=None, known_names=None,
             accepted_names=None,previous_names=None):
        rgb = np.asarray(Image.open(image_path).convert("RGB"))
        columns, rows = find_grid(rgb)
        records = []
        name_info=[]
        name_reviews={}
        name_x1,name_x2=columns[0]
        for y1,y2 in rows:
            name_crop=rgb[y1+4:y2-4,name_x1+5:name_x2-5].copy()
            name_text,name_score=self.read_cell(name_crop)
            if name_score<.92:
                retry_text,retry_score=self.read_cell(name_crop,extra_padding=True)
                name_reviews[len(name_info)]={"初次文字":name_text,"初次置信度":name_score,
                    "复核文字":retry_text,"复核置信度":retry_score,"方法":"灰度文字增加留白后重新识别"}
                if retry_score>name_score:
                    name_text,name_score=retry_text,retry_score
            name_info.append((name_text.lstrip("⭐★☆🌟🏆"),name_text,name_score))
        self.last_row_names=[entry[0] for entry in name_info]
        self.last_names_trusted=bool(name_info) and all(name and score>=.92 for name,_,score in name_info)
        selected,method=None,None
        if target_name is not None:
            selected,method=select_target_row(self.last_row_names,
                set(accepted_names or ())|{target_name},
                previous_names if self.last_names_trusted else None)
            if selected is None:
                return []
            if name_info[selected][2]<.92:
                raise ValueError("目标行名称识别不可靠，暂不建立名称对应关系")
        for row_index, (y1, y2) in enumerate(rows):
            name,name_text,name_score=name_info[row_index]
            if target_name is not None and row_index!=selected:
                continue
            if target_name is None and known_names and name in known_names:
                continue
            raw, confidence, masks, field_reviews = {}, {}, {}, {}
            for column_index, (x1, x2) in enumerate(columns):
                crop = rgb[y1+4:y2-4, x1+5:x2-5].copy()
                if column_index in (2,9):
                    crop, removed = mask_arrows(crop)
                    masks[FIELDS[column_index]] = removed
                if debug_dir:
                    debug = Path(debug_dir)
                    debug.mkdir(parents=True, exist_ok=True)
                    Image.fromarray(crop).save(debug / f"row-{row_index}-{column_index}.png")
                value, score = (name_text,name_score) if column_index==0 else self.read_cell(crop)
                if column_index>0 and score<.92:
                    retry_value,retry_score=self.read_cell(crop,extra_padding=True)
                    field_reviews[FIELDS[column_index]]={"初次文字":value,"初次置信度":score,
                        "复核文字":retry_value,"复核置信度":retry_score,"方法":"灰度文字增加留白后重新识别"}
                    if retry_score>score:
                        value,score=retry_value,retry_score
                raw[FIELDS[column_index]] = value
                confidence[FIELDS[column_index]] = round(score,4)
            values = {key: re.sub(r"[↑↓↗↘↖↙↔↕]", "", value) for key,value in raw.items()}
            if not re.fullmatch(r"\d+", values["堆叠数量"]):
                raise ValueError(f"第{row_index+1}行堆叠数量识别不可靠：{values['堆叠数量']}")
            if any(not value for value in values.values()):
                raise ValueError(f"第{row_index+1}行有空字段，需检查原图")
            values.pop("名称")
            record = {"名称": name, "标签": {
                key: [part for part in re.split(r"[、;；]",value) if part]
                for key,value in values.items()
            }, "原文": raw, "识别置信度": confidence, "已遮挡箭头": masks,
                "需要复核": any(score < .92 for score in confidence.values()),
                "名称匹配依据":method or "历史表格原名"}
            if row_index in name_reviews:
                record["名称识别复核"]=name_reviews[row_index]
            if field_reviews:
                record["字段识别复核"]=field_reviews
            records.append(record)
            if target_name is not None:
                break
        return records


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--debug-dir", type=Path)
    parser.add_argument("--name")
    args = parser.parse_args()
    records = TableReader().read(args.image, args.debug_dir,target_name=args.name)
    result = json.dumps(records,ensure_ascii=False,indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(result,encoding="utf-8")
    print(result)
