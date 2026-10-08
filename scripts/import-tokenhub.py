#!/usr/bin/env python3
# tokenHub: 把 tokenhub-export.sql 一键导入 New API 数据库。
import os
import shutil
import sqlite3
import sys
import time

DB_PATH = os.path.join("new-api-data", "one-api.db")


def main():
    sql_path = sys.argv[1] if len(sys.argv) > 1 else "tokenhub-export.sql"

    if not os.path.exists(sql_path):
        print("SQL export not found:", os.path.abspath(sql_path))
        return 1

    os.makedirs("new-api-data", exist_ok=True)

    if os.path.exists(DB_PATH):
        backup_path = DB_PATH + ".backup-" + time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(DB_PATH, backup_path)
        print("Backup:", backup_path)

    conn = sqlite3.connect(DB_PATH)
    with open(sql_path, "r", encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.close()

    print("Imported OK. Run: docker compose up -d")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
