import sqlite3
from pathlib import Path
from typing import Iterable, Optional
import json


AREAS = (
    "Cửa Việt",
    "Cồn Cỏ",
    "Hòn La",
    "Cửa Gianh",
    "Mỹ Thủy",
    "Lèn Bảng",
)


class StatisticsDatabase:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self._create_schema()

    def close(self):
        self.connection.close()

    def _create_schema(self):
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS periods (
                month_key TEXT PRIMARY KEY,
                report_period_label TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS vessels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                period_month TEXT NOT NULL,
                legacy_id INTEGER,
                khu_vuc TEXT NOT NULL,
                ship_name TEXT NOT NULL,
                call_sign TEXT,
                imo TEXT,
                flag TEXT,
                vessel_class TEXT,
                ship_type TEXT,
                date_in TEXT,
                date_out TEXT,
                port TEXT,
                port_area TEXT,
                last_port TEXT,
                next_port TEXT,
                agent TEXT,
                cargo_amount REAL,
                cargo_amount_in REAL,
                cargo_amount_out REAL,
                grt REAL,
                dwt REAL,
                length REAL,
                draft REAL,
                payload_json TEXT NOT NULL,
                UNIQUE(period_month, legacy_id, khu_vuc),
                FOREIGN KEY(period_month) REFERENCES periods(month_key)
                    ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_vessels_area_period
                ON vessels(khu_vuc, period_month);
            CREATE INDEX IF NOT EXISTS idx_vessels_date_in
                ON vessels(date_in);
            """
        )
        self.connection.commit()

    def replace_from_backup(self, backup_path: Path) -> dict:
        with open(backup_path, "r", encoding="utf-8") as handle:
            backup = json.load(handle)

        state = backup["collections"]["applicationState"][0]["state"]
        month_datasets = state["monthDatasets"]
        inserted = 0
        skipped = 0
        period_count = 0

        with self.connection:
            self.connection.execute("DELETE FROM vessels")
            self.connection.execute("DELETE FROM periods")

            for month_key, dataset in month_datasets.items():
                if month_key == "current":
                    continue
                if not month_key or not str(month_key).startswith("20"):
                    continue
                period_count += 1
                label = dataset.get("reportPeriodLabel") if isinstance(dataset, dict) else None
                self.connection.execute(
                    "INSERT INTO periods(month_key, report_period_label) VALUES (?, ?)",
                    (month_key, label),
                )
                for vessel in dataset.get("vessels", []):
                    area = vessel.get("khuVuc")
                    ship_name = str(vessel.get("shipName") or "").strip()
                    if area not in AREAS or not ship_name:
                        skipped += 1
                        continue
                    try:
                        self.connection.execute(
                            """
                            INSERT INTO vessels (
                                period_month, legacy_id, khu_vuc, ship_name, call_sign, imo,
                                flag, vessel_class, ship_type, date_in, date_out, port,
                                port_area, last_port, next_port, agent, cargo_amount,
                                cargo_amount_in, cargo_amount_out, grt, dwt, length, draft,
                                payload_json
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                month_key,
                                vessel.get("id"),
                                area,
                                ship_name,
                                vessel.get("callSign"),
                                vessel.get("imo"),
                                vessel.get("flag"),
                                vessel.get("vesselClass"),
                                vessel.get("shipType"),
                                vessel.get("dateIn"),
                                vessel.get("dateOut"),
                                vessel.get("port"),
                                vessel.get("portArea"),
                                vessel.get("lastPort"),
                                vessel.get("nextPort"),
                                vessel.get("agent"),
                                vessel.get("cargoAmount"),
                                vessel.get("cargoAmountIn"),
                                vessel.get("cargoAmountOut"),
                                vessel.get("grt"),
                                vessel.get("dwt"),
                                vessel.get("length"),
                                vessel.get("draft"),
                                json.dumps(vessel, ensure_ascii=False),
                            ),
                        )
                        inserted += 1
                    except sqlite3.IntegrityError:
                        skipped += 1

        return {
            "periodCount": period_count,
            "inserted": inserted,
            "skipped": skipped,
            "activeMonth": state.get("activeMonthKey"),
        }

    def periods(self) -> list[str]:
        rows = self.connection.execute(
            "SELECT month_key FROM periods ORDER BY month_key"
        ).fetchall()
        return [row["month_key"] for row in rows]

    def vessel_count(self) -> int:
        return int(
            self.connection.execute("SELECT COUNT(*) FROM vessels").fetchone()[0]
        )

    def counts_by_area(self, period: Optional[str] = None) -> dict[str, int]:
        if period:
            rows = self.connection.execute(
                """
                SELECT khu_vuc, COUNT(*) AS count
                FROM vessels
                WHERE period_month = ?
                GROUP BY khu_vuc
                """,
                (period,),
            ).fetchall()
        else:
            rows = self.connection.execute(
                """
                SELECT khu_vuc, COUNT(*) AS count
                FROM vessels
                GROUP BY khu_vuc
                """,
            ).fetchall()
        values = {area: 0 for area in AREAS}
        values.update({row["khu_vuc"]: int(row["count"]) for row in rows})
        return values

    def totals(
        self,
        period: Optional[str] = None,
        area: str = "Tổng hợp",
        search: str = "",
    ) -> dict:
        conditions = []
        params = []
        if period:
            conditions.append("period_month = ?")
            params.append(period)
        if area != "Tổng hợp":
            conditions.append("khu_vuc = ?")
            params.append(area)
        if search:
            conditions.append(
                "(ship_name LIKE ? OR call_sign LIKE ? OR imo LIKE ? OR port LIKE ?)"
            )
            term = f"%{search}%"
            params.extend((term, term, term, term))
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        row = self.connection.execute(
            f"""
            SELECT COUNT(*) AS vessel_count,
                   COALESCE(SUM(grt), 0) AS grt,
                   COALESCE(SUM(dwt), 0) AS dwt,
                   COALESCE(SUM(cargo_amount), 0) AS cargo_amount,
                   COALESCE(SUM(cargo_amount_in), 0) AS cargo_amount_in,
                   COALESCE(SUM(cargo_amount_out), 0) AS cargo_amount_out
            FROM vessels
            {where}
            """,
            params,
        ).fetchone()
        return dict(row)

    def search(
        self,
        period: str = "",
        area: str = "Tổng hợp",
        search: str = "",
        limit: int = 500,
    ) -> list[dict]:
        conditions = []
        params = []
        if period:
            conditions.append("period_month = ?")
            params.append(period)
        if area != "Tổng hợp":
            conditions.append("khu_vuc = ?")
            params.append(area)
        if search:
            conditions.append(
                "(ship_name LIKE ? OR call_sign LIKE ? OR imo LIKE ? OR port LIKE ?)"
            )
            term = f"%{search}%"
            params.extend((term, term, term, term))
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        params.append(limit)
        rows = self.connection.execute(
            f"""
            SELECT id, period_month, legacy_id, khu_vuc, ship_name, call_sign, imo,
                   flag, vessel_class, ship_type, date_in, date_out, port, agent,
                   cargo_amount, cargo_amount_in, cargo_amount_out, grt, dwt
            FROM vessels
            {where}
            ORDER BY period_month DESC, khu_vuc, ship_name
            LIMIT ?
            """,
            params,
        ).fetchall()
        return [dict(row) for row in rows]

    def payload(self, vessel_db_id: int) -> dict:
        row = self.connection.execute(
            "SELECT payload_json FROM vessels WHERE id = ?",
            (vessel_db_id,),
        ).fetchone()
        if not row:
            return {}
        return json.loads(row["payload_json"])

    def ensure_period(self, month_key: str) -> None:
        if not month_key or not month_key[:4].isdigit():
            raise ValueError("Kỳ phải có định dạng YYYY-MM.")
        year = int(month_key[:4])
        month = int(month_key[5:])
        if month < 1 or month > 12:
            raise ValueError("Tháng phải từ 01 đến 12.")
        with self.connection:
            self.connection.execute(
                "INSERT OR IGNORE INTO periods(month_key) VALUES (?)",
                (month_key,),
            )

    def add_vessel(self, month_key: str, vessel: dict) -> int:
        area = vessel.get("khuVuc")
        ship_name = str(vessel.get("shipName") or "").strip()
        if area not in AREAS:
            raise ValueError("Khu vực không hợp lệ.")
        if not ship_name:
            raise ValueError("Tên tàu bắt buộc.")
        self.ensure_period(month_key)
        max_row = self.connection.execute(
            "SELECT COALESCE(MAX(legacy_id), 0) FROM vessels"
        ).fetchone()[0]
        legacy_id = int(vessel.get("id") or max_row + 1)
        payload = dict(vessel)
        payload["id"] = legacy_id
        payload["khuVuc"] = area
        payload["shipName"] = ship_name
        payload["periodMonth"] = month_key
        with self.connection:
            cursor = self.connection.execute(
                """
                INSERT INTO vessels (
                    period_month, legacy_id, khu_vuc, ship_name, call_sign, imo,
                    flag, vessel_class, ship_type, date_in, date_out, port,
                    port_area, last_port, next_port, agent, cargo_amount,
                    cargo_amount_in, cargo_amount_out, grt, dwt, length, draft,
                    payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    month_key, legacy_id, area, ship_name, vessel.get("callSign"),
                    vessel.get("imo"), vessel.get("flag"), vessel.get("vesselClass"),
                    vessel.get("shipType"), vessel.get("dateIn"), vessel.get("dateOut"),
                    vessel.get("port"), vessel.get("portArea"), vessel.get("lastPort"),
                    vessel.get("nextPort"), vessel.get("agent"), vessel.get("cargoAmount"),
                    vessel.get("cargoAmountIn"), vessel.get("cargoAmountOut"),
                    vessel.get("grt"), vessel.get("dwt"), vessel.get("length"),
                    vessel.get("draft"), json.dumps(payload, ensure_ascii=False),
                ),
            )
        return int(cursor.lastrowid)

    def update_vessel(self, vessel_db_id: int, month_key: str, vessel: dict) -> None:
        area = vessel.get("khuVuc")
        ship_name = str(vessel.get("shipName") or "").strip()
        if area not in AREAS:
            raise ValueError("Khu vực không hợp lệ.")
        if not ship_name:
            raise ValueError("Tên tàu bắt buộc.")
        self.ensure_period(month_key)
        legacy_id = vessel.get("id")
        payload = dict(vessel)
        payload["khuVuc"] = area
        payload["shipName"] = ship_name
        payload["periodMonth"] = month_key
        with self.connection:
            self.connection.execute(
                """
                UPDATE vessels SET
                    period_month = ?, legacy_id = ?, khu_vuc = ?, ship_name = ?,
                    call_sign = ?, imo = ?, flag = ?, vessel_class = ?, ship_type = ?,
                    date_in = ?, date_out = ?, port = ?, port_area = ?, last_port = ?,
                    next_port = ?, agent = ?, cargo_amount = ?, cargo_amount_in = ?,
                    cargo_amount_out = ?, grt = ?, dwt = ?, length = ?, draft = ?,
                    payload_json = ?
                WHERE id = ?
                """,
                (
                    month_key, legacy_id, area, ship_name, vessel.get("callSign"),
                    vessel.get("imo"), vessel.get("flag"), vessel.get("vesselClass"),
                    vessel.get("shipType"), vessel.get("dateIn"), vessel.get("dateOut"),
                    vessel.get("port"), vessel.get("portArea"), vessel.get("lastPort"),
                    vessel.get("nextPort"), vessel.get("agent"), vessel.get("cargoAmount"),
                    vessel.get("cargoAmountIn"), vessel.get("cargoAmountOut"),
                    vessel.get("grt"), vessel.get("dwt"), vessel.get("length"),
                    vessel.get("draft"), json.dumps(payload, ensure_ascii=False),
                    vessel_db_id,
                ),
            )

    def delete_vessel(self, vessel_db_id: int) -> None:
        with self.connection:
            self.connection.execute("DELETE FROM vessels WHERE id = ?", (vessel_db_id,))

    def period_report(self, period_type: str, year: int, area: str = "Tổng hợp") -> dict:
        if period_type == "6 đầu":
            month_numbers = range(1, 7)
        elif period_type == "6 cuối":
            month_numbers = range(7, 13)
        elif period_type == "năm":
            month_numbers = range(1, 13)
        else:
            raise ValueError("Loại kỳ báo cáo không hợp lệ.")
        period_keys = [f"{year}-{month:02d}" for month in month_numbers]
        placeholders = ",".join("?" for _ in period_keys)
        params = list(period_keys)
        area_condition = ""
        if area != "Tổng hợp":
            area_condition = " AND khu_vuc = ?"
            params.append(area)
        row = self.connection.execute(
            f"""
            SELECT COUNT(*) AS vessel_count,
                   COALESCE(SUM(grt), 0) AS grt,
                   COALESCE(SUM(dwt), 0) AS dwt,
                   COALESCE(SUM(cargo_amount), 0) AS cargo_amount,
                   COALESCE(SUM(cargo_amount_in), 0) AS cargo_amount_in,
                   COALESCE(SUM(cargo_amount_out), 0) AS cargo_amount_out
            FROM vessels
            WHERE period_month IN ({placeholders})
            {area_condition}
            """,
            params,
        ).fetchone()
        data_months = self.connection.execute(
            f"""
            SELECT DISTINCT period_month
            FROM vessels
            WHERE period_month IN ({placeholders})
            {area_condition}
            ORDER BY period_month
            """,
            params,
        ).fetchall()
        return {
            "periodType": period_type,
            "year": year,
            "area": area,
            "monthKeys": period_keys,
            "dataMonths": [item["period_month"] for item in data_months],
            **dict(row),
        }

    def report_payloads(
        self,
        period_month: str = "",
        year: int = 0,
        period_type: str = "tháng",
        area: str = "Tổng hợp",
    ) -> list[dict]:
        conditions = []
        params = []
        if period_type == "tháng" and period_month:
            conditions.append("period_month = ?")
            params.append(period_month)
        elif period_type in ("lũy kế", "trước kỳ") and period_month:
            year = int(period_month[:4])
            end_month = int(period_month[5:]) - (1 if period_type == "trước kỳ" else 0)
            if end_month < 1:
                return []
            conditions.append("period_month BETWEEN ? AND ?")
            params.extend((f"{year}-01", f"{year}-{end_month:02d}"))
        elif year:
            if period_type == "6 tháng đầu":
                start_month, end_month = 1, 6
            elif period_type == "6 tháng cuối":
                start_month, end_month = 7, 12
            elif period_type.startswith("Quý"):
                quarter = int(period_type[-1])
                start_month, end_month = (quarter - 1) * 3 + 1, quarter * 3
            else:
                start_month, end_month = 1, 12
            conditions.append("period_month BETWEEN ? AND ?")
            params.extend(
                (f"{year}-{start_month:02d}", f"{year}-{end_month:02d}")
            )
        if area != "Tổng hợp":
            conditions.append("khu_vuc = ?")
            params.append(area)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = self.connection.execute(
            f"""
            SELECT period_month, khu_vuc, payload_json
            FROM vessels
            {where}
            ORDER BY period_month, khu_vuc, ship_name
            """,
            params,
        ).fetchall()
        payloads = []
        for row in rows:
            vessel = json.loads(row["payload_json"])
            vessel["periodMonth"] = row["period_month"]
            vessel["khuVuc"] = row["khu_vuc"]
            payloads.append(vessel)
        return payloads

    def export_rows(
        self,
        period: str = "",
        area: str = "Tổng hợp",
        search: str = "",
    ) -> Iterable[dict]:
        conditions = []
        params = []
        if period:
            conditions.append("period_month = ?")
            params.append(period)
        if area != "Tổng hợp":
            conditions.append("khu_vuc = ?")
            params.append(area)
        if search:
            conditions.append(
                "(ship_name LIKE ? OR call_sign LIKE ? OR imo LIKE ? OR port LIKE ?)"
            )
            term = f"%{search}%"
            params.extend((term, term, term, term))
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = self.connection.execute(
            f"""
            SELECT period_month, legacy_id, khu_vuc, ship_name, call_sign, imo,
                   flag, vessel_class, ship_type, date_in, date_out, port, port_area,
                   last_port, next_port, agent, cargo_amount, cargo_amount_in,
                   cargo_amount_out, grt, dwt, length, draft
            FROM vessels
            {where}
            ORDER BY period_month, khu_vuc, ship_name
            """,
            params,
        ).fetchall()
        return (dict(row) for row in rows)
