#!/usr/bin/env python3
"""แปลง Interim Request Log (.xlsx) เป็น JSON ที่ commit ลง git ได้

    python3 scripts/extract-request-log.py [source_dir] [out_dir]

ทำไมเป็น python ไม่ใช่ TypeScript: repo นี้ไม่มีไลบรารีอ่าน xlsx และกฎของโปรเจกต์
ห้ามติดตั้ง package โดยไม่ถามก่อน สคริปต์นี้จึงใช้ stdlib ล้วน — xlsx คือ zip ที่
ข้างในเป็น XML — และเขียนผลเป็น JSON ให้สคริปต์ import ฝั่ง TypeScript อ่านต่อ

ผลพลอยได้ที่สำคัญกว่าการเลี่ยง dependency: JSON ที่ commit ไว้ทำให้ diff ของ git
บอกได้ว่าไฟล์ต้นทางเปลี่ยนอะไรระหว่างสองรอบ import ซึ่งไฟล์ .xlsx ทำไม่ได้
"""

from __future__ import annotations

import datetime
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# วันที่ใน xlsx เก็บเป็นจำนวนวันนับจากฐานนี้ (Excel นับ 1900 เป็นปีอธิกสุรทินผิด
# จึงเป็น 30 ธ.ค. 1899 ไม่ใช่ 31) ตัวเลขในไฟล์เป็น ค.ศ. อยู่แล้ว แม้เอกสารจะเรียกปี 2569
EXCEL_EPOCH = datetime.date(1899, 12, 30)

# ช่วงที่ถือว่าเป็นวันที่ได้จริง — 40000 ≈ 2009, 60000 ≈ 2064 ตัวเลขนอกช่วงนี้
# (เช่น จำนวนเงิน หรือจำนวนชิ้น) ต้องไม่ถูกเดาเป็นวันที่
DATE_MIN, DATE_MAX = 40000, 60000


def column_of(ref: str) -> str:
    """`AB12` → `AB`"""
    return re.match(r"([A-Z]+)", ref).group(1)


def shared_strings(book: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in book.namelist():
        return []

    root = ET.fromstring(book.read("xl/sharedStrings.xml"))
    return [
        "".join(node.text or "" for node in item.iter(M + "t"))
        for item in root.findall("m:si", NS)
    ]


def sheet_files(book: zipfile.ZipFile) -> list[tuple[str, str]]:
    """[(ชื่อชีต, path ใน zip)] ตามลำดับที่ปรากฏในสมุดงาน

    ต้อง resolve ผ่าน `workbook.xml` + rels เสมอ: การเพิ่มชีตหนึ่งชีตกลางไฟล์
    ทำให้ `sheetN.xml` เลื่อนทั้งหมด — ซึ่งเกิดขึ้นจริงตอนที่ `USERNAME_MAP`
    ถูกเพิ่มเข้ามาแล้ว `14_LIST_STAFF` ย้ายจาก sheet12 ไป sheet13
    """
    rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
    target = {
        node.get("Id"): node.get("Target").lstrip("/")
        for node in rels
    }

    sheets = []
    for node in ET.fromstring(book.read("xl/workbook.xml")).iter(M + "sheet"):
        path = target.get(node.get(R_NS + "id"))
        if path:
            sheets.append((node.get("name"), f"xl/{path}"))

    return sheets


def cell_value(cell: ET.Element, strings: list[str]) -> object:
    """ค่าที่เห็นในช่อง — ค่าที่คำนวณแล้ว ไม่ใช่ตัวสูตร

    ช่องสูตรเก็บทั้งสูตรและผลลัพธ์ล่าสุด เราต้องการผลลัพธ์ ส่วนตัวสูตรกลับไปเป็น
    `formula` เพื่อให้แยกออกได้ว่าช่องไหนเป็นค่าที่คนกรอกเอง ช่องไหนเป็นสูตรช่วย
    (field dictionary สั่งว่าช่อง `(derived)` ไม่ต้อง import)
    """
    kind = cell.get("t")
    value = cell.find("m:v", NS)
    inline = cell.find("m:is", NS)

    if kind == "s" and value is not None:
        return strings[int(value.text)]

    if inline is not None:
        return "".join(node.text or "" for node in inline.iter(M + "t"))

    if value is None:
        return None

    if kind in ("str", "e"):
        return value.text

    if kind == "b":
        return value.text == "1"

    try:
        number = float(value.text)
    except (TypeError, ValueError):
        return value.text

    return int(number) if number.is_integer() else number


def as_date(value: object) -> str | None:
    """serial ของ Excel → `YYYY-MM-DD` หรือ None ถ้าไม่ใช่วันที่

    ตัดสินจากช่วงตัวเลขเท่านั้น ไม่อ่าน number format: ไฟล์นี้กรอกมือหลายคน
    รูปแบบของช่องจึงไม่สม่ำเสมอพอจะเชื่อได้ การแปลงจริงเป็นหน้าที่ของสคริปต์
    import ที่รู้ว่าคอลัมน์ไหนคือวันที่จาก field dictionary
    """
    if not isinstance(value, int) or not DATE_MIN <= value <= DATE_MAX:
        return None

    return (EXCEL_EPOCH + datetime.timedelta(days=value)).isoformat()


def read_sheet(book: zipfile.ZipFile, path: str, strings: list[str]) -> list[dict]:
    """หนึ่ง element ต่อหนึ่งแถวที่มีข้อมูล — แถวว่างถูกตัดทิ้ง

    เก็บ `row` ไว้ด้วยเพราะรายงานของ import ต้องอ้างเลขแถวจริงในไฟล์ Excel
    ให้คนที่กรอกไปแก้ได้ ไม่ใช่ลำดับที่ n ของ array
    """
    rows = []

    for row in ET.fromstring(book.read(path)).iter(M + "row"):
        cells: dict[str, object] = {}
        formulas: list[str] = []
        dates: dict[str, str] = {}

        for cell in row.findall("m:c", NS):
            key = column_of(cell.get("r"))
            value = cell_value(cell, strings)

            if cell.find("m:f", NS) is not None:
                formulas.append(key)

            if value in (None, ""):
                continue

            cells[key] = value

            iso = as_date(value)
            if iso:
                dates[key] = iso

        if not cells:
            continue

        entry: dict[str, object] = {"row": int(row.get("r")), "cells": cells}
        if formulas:
            entry["formulas"] = sorted(formulas)
        if dates:
            entry["dates"] = dates

        rows.append(entry)

    return rows


def extract(source: Path, out_dir: Path) -> dict[str, int]:
    book = zipfile.ZipFile(source)
    strings = shared_strings(book)

    target = out_dir / source.stem
    target.mkdir(parents=True, exist_ok=True)

    counts: dict[str, int] = {}

    for name, path in sheet_files(book):
        rows = read_sheet(book, path, strings)
        counts[name] = len(rows)

        (target / f"{name}.json").write_text(
            json.dumps(rows, ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8",
        )

    (target / "_index.json").write_text(
        json.dumps(
            {
                "source": source.name,
                "sheets": [{"name": n, "rows": counts[n]} for n, _ in sheet_files(book)],
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )

    return counts


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    source_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "source"
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else source_dir / "extracted"

    # `~$…` คือไฟล์ล็อกที่ Excel สร้างขณะเปิดสมุดงานอยู่ ไม่ใช่ข้อมูล
    books = sorted(
        path
        for path in source_dir.glob("*.xlsx")
        if not path.name.startswith("~$")
    )

    if not books:
        print(f"ไม่พบไฟล์ .xlsx ใน {source_dir}", file=sys.stderr)
        return 1

    for book in books:
        print(f"{book.name}")
        for name, rows in extract(book, out_dir).items():
            print(f"  {name:24s} {rows:5d} แถว")

    print(f"\nเขียนลง {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
