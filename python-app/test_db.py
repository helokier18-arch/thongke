import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import StatisticsDatabase
from reports import REPORTS, build_form_rows


class StatisticsDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.directory.name) / "test.db"
        self.database = StatisticsDatabase(self.database_path)
        self.project_dir = Path(__file__).resolve().parent.parent

    def tearDown(self):
        self.database.close()
        self.directory.cleanup()

    def test_import_real_backup(self):
        result = self.database.replace_from_backup(
            self.project_dir / "database-backup.json"
        )
        self.assertEqual(result["periodCount"], 3)
        self.assertEqual(result["inserted"], 407)
        self.assertEqual(self.database.vessel_count(), 407)
        counts = self.database.counts_by_area()
        self.assertEqual(counts["Cửa Việt"], 201)
        self.assertEqual(counts["Cồn Cỏ"], 5)
        self.assertEqual(counts["Hòn La"], 59)
        self.assertEqual(counts["Cửa Gianh"], 41)
        self.assertEqual(counts["Mỹ Thủy"], 30)
        self.assertEqual(counts["Lèn Bảng"], 71)

    def test_period_and_area_filters(self):
        self.database.replace_from_backup(
            self.project_dir / "database-backup.json"
        )
        rows = self.database.search("2026-11", "Cồn Cỏ")
        self.assertTrue(rows)
        totals = self.database.totals("2026-11", "Cồn Cỏ")
        self.assertGreater(totals["vessel_count"], 0)

    def test_add_edit_delete_and_period_report(self):
        self.database.replace_from_backup(
            self.project_dir / "database-backup.json"
        )
        vessel_id = self.database.add_vessel("2026-12", {
            "khuVuc": "Cửa Việt",
            "shipName": "Tàu thử nghiệm",
            "callSign": "VNTEST",
            "dateIn": "2026-12-01",
            "port": "Cửa Việt",
            "grt": 100,
            "dwt": 200,
        })
        self.assertGreater(vessel_id, 0)
        report = self.database.period_report("năm", 2026, "Cửa Việt")
        self.assertGreaterEqual(report["vessel_count"], 201)

        payload = self.database.payload(vessel_id)
        payload["shipName"] = "Tàu đã sửa"
        payload["grt"] = 150
        self.database.update_vessel(vessel_id, "2026-12", payload)
        updated = self.database.payload(vessel_id)
        self.assertEqual(updated["shipName"], "Tàu đã sửa")
        self.assertEqual(updated["grt"], 150)

        self.database.delete_vessel(vessel_id)
        self.assertEqual(self.database.payload(vessel_id), {})

    def test_report_forms_use_saved_period_data(self):
        self.database.replace_from_backup(
            self.project_dir / "database-backup.json"
        )
        vessels = self.database.report_payloads(
            period_month="2026-11",
            year=2026,
            period_type="tháng",
            area="Tổng hợp",
        )
        self.assertEqual(len(vessels), 206)
        sea_columns, sea_rows = build_form_rows("11-T", vessels)
        inland_columns, inland_rows = build_form_rows("11B-T", vessels)
        self.assertIn(("Tên tàu", "shipName"), sea_columns)
        self.assertIn(("Tên PTTNĐ", "shipName"), inland_columns)
        self.assertEqual(len(sea_rows), 135)
        self.assertEqual(len(inland_rows), 71)

        for code, _title in REPORTS:
            columns, rows = build_form_rows(code, vessels)
            self.assertTrue(columns, code)
            self.assertTrue(rows, code)

    def test_monthly_reports_separate_period_and_cumulative_values(self):
        self.database.replace_from_backup(
            self.project_dir / "database-backup.json"
        )
        query = {
            "period_month": "2026-11",
            "year": 2026,
            "area": "Tổng hợp",
        }
        period = self.database.report_payloads(period_type="tháng", **query)
        cumulative = self.database.report_payloads(period_type="lũy kế", **query)
        before = self.database.report_payloads(period_type="trước kỳ", **query)
        columns, rows = build_form_rows("13-T", period, cumulative, before)

        self.assertIn(("Từ đầu kỳ đến trước", "before"), columns)
        self.assertEqual(rows[0]["period"], 206)
        self.assertEqual(rows[0]["before"], 201)
        self.assertEqual(rows[0]["cumulative"], 407)

        comparison_columns, comparison_rows = build_form_rows(
            "12B-T",
            period,
            cumulative,
            previous_vessels=[],
            previous_cumulative_vessels=[],
        )
        self.assertEqual(len(comparison_columns), 9)
        sea_calls = next(
            row for row in comparison_rows
            if row["label"] == "Tổng số lượt tàu biển"
        )
        self.assertEqual(sea_calls["period"], 135)
        self.assertEqual(sea_calls["cumulative"], 189)
        self.assertIsNone(sea_calls["previous"])

        current_ship = {
            "vesselClass": "sea",
            "flag": "VN",
            "cargoBreakdown": {"cargoTons": 1},
        }
        previous_ships = [
            {
                "vesselClass": "sea",
                "flag": "VN",
                "cargoBreakdown": {"cargoTons": 1},
            }
            for _ in range(2)
        ]
        sea_columns, sea_rows = build_form_rows(
            "14-T",
            [current_ship],
            [current_ship] + previous_ships,
            previous_ships,
        )
        self.assertIn(("Từ đầu năm đến hết tháng trước", "before"), sea_columns)
        self.assertEqual(sea_rows[0]["period"], 1)
        self.assertEqual(sea_rows[0]["before"], 2)
        self.assertEqual(sea_rows[0]["cumulative"], 3)

    def test_port_forms_have_distinct_template_columns(self):
        vessel = {
            "portArea": "Cửa Việt",
            "cargoBreakdown": {
                "containerTons": 10,
                "containerTeus": 2,
                "dryTons": 20,
                "liquidTons": 3,
                "transitLoadedTons": 4,
                "transitDirectTons": 5,
            },
        }
        columns_03, rows_03 = build_form_rows("03-T", [vessel])
        columns_15, rows_15 = build_form_rows("15-T", [vessel])

        self.assertEqual(len(columns_03), 15)
        self.assertEqual(len(columns_15), 15)
        self.assertIn(("Lượt tàu tháng", "calls_period"), columns_03)
        self.assertIn(("Quá cảnh không bốc dỡ tháng", "direct_period"), columns_15)
        self.assertEqual(rows_03[0]["container_period"], 10)
        self.assertEqual(rows_15[0]["direct_period"], 5)


if __name__ == "__main__":
    unittest.main()
