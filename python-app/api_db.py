import json
from pathlib import Path
from urllib.parse import urlparse

import requests


class OnlineStatisticsDatabase:
    def __init__(self, base_url: str, username: str, password: str):
        parsed = urlparse(base_url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("Địa chỉ API phải bắt đầu bằng http:// hoặc https://.")
        if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1"):
            raise ValueError("API online phải dùng HTTPS.")
        self.base_url = base_url.strip().rstrip("/")
        self.session = requests.Session()
        self.session.auth = (username, password)
        self.session.headers.update({"Accept": "application/json"})

    def _request(self, method: str, path: str, **kwargs):
        try:
            response = self.session.request(
                method,
                f"{self.base_url}{path}",
                timeout=(15, 120),
                **kwargs,
            )
        except requests.RequestException as error:
            raise RuntimeError(
                "Không kết nối được API. Kiểm tra Internet và địa chỉ máy chủ."
            ) from error

        try:
            body = response.json()
        except ValueError:
            body = {}
        if not response.ok:
            if response.status_code == 401:
                message = "Tên đăng nhập hoặc mật khẩu API không đúng."
            elif response.status_code >= 500:
                message = "Máy chủ online đang lỗi hoặc chưa kết nối được cơ sở dữ liệu."
            else:
                message = body.get("detail", "Yêu cầu API không hợp lệ.")
            raise RuntimeError(str(message))
        return body

    def check_connection(self):
        health = self._request("GET", "/api/health")
        if health.get("status") != "ok":
            raise RuntimeError("API chưa kết nối được cơ sở dữ liệu online.")
        self.periods()

    def periods(self) -> list[str]:
        return self._request("GET", "/api/periods")["periods"]

    def vessel_count(self) -> int:
        return int(self.totals().get("vessel_count", 0))

    def counts_by_area(self, period: str | None = None) -> dict[str, int]:
        params = {"period": period} if period else {}
        return self._request("GET", "/api/counts", params=params)

    def totals(
        self,
        period: str | None = None,
        area: str = "Tổng hợp",
        search: str = "",
    ) -> dict:
        params = {"area": area, "search": search}
        if period:
            params["period"] = period
        return self._request("GET", "/api/totals", params=params)

    def search(
        self,
        period: str = "",
        area: str = "Tổng hợp",
        search: str = "",
        limit: int = 500,
    ) -> list[dict]:
        return self._request(
            "GET",
            "/api/vessels",
            params={"period": period, "area": area, "search": search, "limit": limit},
        )

    def payload(self, vessel_db_id: int | str) -> dict:
        return self._request("GET", f"/api/vessels/{vessel_db_id}")

    def add_vessel(self, month_key: str, vessel: dict) -> str:
        return self._request(
            "POST",
            "/api/vessels",
            json={"month_key": month_key, "vessel": vessel},
        )["id"]

    def update_vessel(
        self,
        vessel_db_id: int | str,
        month_key: str,
        vessel: dict,
    ) -> None:
        self._request(
            "PUT",
            f"/api/vessels/{vessel_db_id}",
            json={"month_key": month_key, "vessel": vessel},
        )

    def delete_vessel(self, vessel_db_id: int | str) -> None:
        self._request("DELETE", f"/api/vessels/{vessel_db_id}")

    def period_report(self, period_type: str, year: int, area: str = "Tổng hợp") -> dict:
        return self._request(
            "GET",
            "/api/period-report",
            params={"period_type": period_type, "year": year, "area": area},
        )

    def report_payloads(
        self,
        period_month: str = "",
        year: int = 0,
        period_type: str = "tháng",
        area: str = "Tổng hợp",
    ) -> list[dict]:
        return self._request(
            "GET",
            "/api/reports/payloads",
            params={
                "period_month": period_month,
                "year": year,
                "period_type": period_type,
                "area": area,
            },
        )

    def export_rows(
        self,
        period: str = "",
        area: str = "Tổng hợp",
        search: str = "",
    ) -> list[dict]:
        return self._request(
            "GET",
            "/api/export",
            params={"period": period, "area": area, "search": search},
        )

    def replace_from_backup(self, backup_path: Path) -> dict:
        with open(backup_path, "r", encoding="utf-8") as handle:
            backup = json.load(handle)
        return self._request("POST", "/api/import", json={"backup": backup})

    def ensure_period(self, month_key: str) -> None:
        if month_key not in self.periods():
            raise ValueError("Hãy nạp dữ liệu có kỳ báo cáo trước khi thêm tàu.")

    def close(self):
        self.session.close()
