import unittest
from unittest.mock import patch

from fastapi import HTTPException

from api_db import OnlineStatisticsDatabase
from online_api import _normalize_vessel, period_filter, validate_period, vessel_filter


class OnlineApiHelpersTest(unittest.TestCase):
    def test_period_filter_handles_half_year_and_previous_month(self):
        self.assertEqual(
            period_filter(year=2026, period_type="6 tháng đầu"),
            {"period_month": {"$gte": "2026-01", "$lte": "2026-06"}},
        )
        self.assertEqual(
            period_filter("2026-01", 2026, "trước kỳ"),
            {"period_month": {"$in": []}},
        )

    def test_invalid_period_and_area_are_rejected(self):
        with self.assertRaises(HTTPException):
            validate_period("2026-13")
        with self.assertRaises(HTTPException):
            vessel_filter(area="Không có khu vực")

    def test_search_term_is_treated_as_literal_text(self):
        self.assertEqual(
            vessel_filter(search="A.*"),
            {
                "$and": [{
                    "$or": [
                        {"ship_name": {"$regex": "A\\.\\*", "$options": "i"}},
                        {"call_sign": {"$regex": "A\\.\\*", "$options": "i"}},
                        {"imo": {"$regex": "A\\.\\*", "$options": "i"}},
                        {"port": {"$regex": "A\\.\\*", "$options": "i"}},
                    ]
                }]
            },
        )

    def test_vessel_validation_normalizes_required_fields(self):
        record = _normalize_vessel(
            "2026-11",
            {
                "id": "12",
                "khuVuc": "Cửa Việt",
                "shipName": "  Tàu thử  ",
                "grt": "120,5",
            },
        )
        self.assertEqual(record["legacy_id"], 12)
        self.assertEqual(record["ship_name"], "Tàu thử")
        self.assertEqual(record["grt"], 120.5)
        self.assertEqual(record["payload"]["periodMonth"], "2026-11")


class OnlineDatabaseClientTest(unittest.TestCase):
    def test_remote_api_rejects_non_https_public_urls(self):
        with self.assertRaises(ValueError):
            OnlineStatisticsDatabase("http://stats.example.com", "user", "password")

    def test_connection_uses_api_credentials_and_checks_authentication(self):
        class FakeResponse:
            def __init__(self, body):
                self.body = body
                self.ok = True
                self.status_code = 200

            def json(self):
                return self.body

        class FakeSession:
            def __init__(self):
                self.auth = None
                self.headers = {}
                self.calls = []

            def request(self, method, url, **_kwargs):
                self.calls.append((method, url))
                if url.endswith("/api/health"):
                    return FakeResponse({"status": "ok"})
                return FakeResponse({"periods": []})

            def close(self):
                pass

        fake_session = FakeSession()
        with patch("api_db.requests.Session", return_value=fake_session):
            database = OnlineStatisticsDatabase(
                "https://stats.example.com/", "test-user", "test-password"
            )
            database.check_connection()

        self.assertEqual(fake_session.auth, ("test-user", "test-password"))
        self.assertEqual(
            fake_session.calls,
            [
                ("GET", "https://stats.example.com/api/health"),
                ("GET", "https://stats.example.com/api/periods"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
