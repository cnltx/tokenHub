#!/usr/bin/env python3
# tokenHub: 把 New API 数据库导出为 SQL 文本，方便换电脑一键导入。
import os
import sqlite3
import sys


def main():
    db_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join("new-api-data", "one-api.db")
    out_path = sys.argv[2] if len(sys.argv) > 2 else "tokenhub-export.sql"

    if not os.path.exists(db_path):
        print("DB not found:", os.path.abspath(db_path))
        return 1

    conn = sqlite3.connect(db_path)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("-- tokenHub New API export; contains personal keys, do not upload to public repos.\n")
        for line in conn.iterdump():
            f.write(line + "\n")
    conn.close()

    print("Exported:", os.path.abspath(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
