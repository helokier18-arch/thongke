import os
import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from pymongo import ASCENDING, MongoClient, ReturnDocument
from pymongo.errors import PyMongoError

from db import AREAS


DATABASE_NAME = os.getenv("MONGODB_DB", "maritime_statistics_python")
MAX_BODY_BYTES = 15 * 1024 * 1024
MONTH_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

app = FastAPI(title="Python vessel statistics API", docs_url=None, redoc_url=None)
client: MongoClient | None = None


class VesselRequest(BaseModel):
    month_key: str
    vessel: dict[str, Any]


class BackupRequest(BaseModel):
    backup: dict[str, Any]


def get_database():
    global client
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        raise HTTPException(status_code=503, detail="MongoDB connection is not configured.")
    if client is None:
        client = MongoClient(
            uri,
            appname="maritime-vessel-statistics-python",
            serverSelectionTimeoutMS=8000,
        )
    return client[DATABASE_NAME]


def validate_period(month_key: str) -> str:
    if not MONTH_PATTERN.fullmatch(month_key or ""):
        raise HTTPException(status_code=400, detail="Kỳ phải có định dạng YYYY-MM.")
    return month_key


def validate_area(area: str) -> str:
    if area != "Tổng hợp" and area not in AREAS:
        raise HTTPException(status_code=400, detail="Khu vực không hợp lệ.")
    return area


def area_filter(area: str) -> dict:
    validate_area(area)
    return {} if area == "Tổng hợp" else {"khu_vuc": area}


def period_filter(
    period_month: str = "",
    year: int = 0,
    period_type: str = "tháng",
) -> dict:
    if period_type == "tháng":
        return {"period_month": validate_period(period_month)} if period_month else {}

    start_month = 1
    end_month = 12
    if period_type in ("lũy kế", "trước kỳ") and period_month:
        validate_period(period_month)
        year = int(period_month[:4])
        end_month = int(period_month[5:]) - (1 if period_type == "trước kỳ" else 0)
        if end_month < 1:
            return {"period_month": {"$in": []}}
    elif period_type == "6 tháng đầu":
        start_month, end_month = 1, 6
    elif period_type == "6 tháng cuối":
        start_month, end_month = 7, 12
    elif period_type.startswith("Quý"):
        try:
            quarter = int(period_type[-1])
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Quý báo cáo không hợp lệ.") from error
        if quarter not in (1, 2, 3, 4):
            raise HTTPException(status_code=400, detail="Quý báo cáo không hợp lệ.")
        start_month = (quarter - 1) * 3 + 1
        end_month = quarter * 3

    if year < 1 or year > 9999:
        raise HTTPException(status_code=400, detail="Năm báo cáo không hợp lệ.")
    return {
        "period_month": {
            "$gte": f"{year}-{start_month:02d}",
            "$lte": f"{year}-{end_month:02d}",
        }
    }


def vessel_filter(period: str = "", area: str = "Tổng hợp", search: str = "") -> dict:
    filters = []
    if period:
        filters.append({"period_month": validate_period(period)})
    area_match = area_filter(area)
    if area_match:
        filters.append(area_match)
    term = search.strip()
    if term:
        expression = re.escape(term)
        filters.append({
            "$or": [
                {"ship_name": {"$regex": expression, "$options": "i"}},
                {"call_sign": {"$regex": expression, "$options": "i"}},
                {"imo": {"$regex": expression, "$options": "i"}},
                {"port": {"$regex": expression, "$options": "i"}},
            ]
        })
    return {"$and": filters} if filters else {}


def _numeric(value: Any):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return number if number not in (float("inf"), float("-inf")) else None


def _next_legacy_id(database) -> int:
    counter = database.counters.find_one_and_update(
        {"_id": "vessel"},
        {"$inc": {"value": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(counter["value"])


def _normalize_vessel(month_key: str, vessel: dict[str, Any]) -> dict[str, Any]:
    validate_period(month_key)
    area = str(vessel.get("khuVuc") or "")
    name = str(vessel.get("shipName") or "").strip()
    if area not in AREAS:
        raise HTTPException(status_code=400, detail="Khu vực không hợp lệ.")
    if not name:
        raise HTTPException(status_code=400, detail="Tên tàu bắt buộc.")

    payload = dict(vessel)
    legacy_id = payload.get("id")
    if legacy_id is not None:
        try:
            legacy_id = int(legacy_id)
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail="Mã tàu không hợp lệ.") from error
    payload.update({
        "id": legacy_id,
        "periodMonth": month_key,
        "khuVuc": area,
        "shipName": name,
    })
    return {
        "period_month": month_key,
        "legacy_id": legacy_id,
        "khu_vuc": area,
        "ship_name": name,
        "call_sign": payload.get("callSign"),
        "imo": payload.get("imo"),
        "flag": payload.get("flag"),
        "vessel_class": payload.get("vesselClass"),
        "ship_type": payload.get("shipType"),
        "date_in": payload.get("dateIn"),
        "date_out": payload.get("dateOut"),
        "port": payload.get("port"),
        "port_area": payload.get("portArea"),
        "last_port": payload.get("lastPort"),
        "next_port": payload.get("nextPort"),
        "agent": payload.get("agent"),
        "grt": _numeric(payload.get("grt")),
        "dwt": _numeric(payload.get("dwt")),
        "cargo_amount": _numeric(payload.get("cargoAmount")),
        "cargo_amount_in": _numeric(payload.get("cargoAmountIn")),
        "cargo_amount_out": _numeric(payload.get("cargoAmountOut")),
        "length": _numeric(payload.get("length")),
        "draft": _numeric(payload.get("draft")),
        "payload": payload,
        "updated_at": datetime.now(timezone.utc),
    }


def _record_id(value: str) -> ObjectId:
    if not ObjectId.is_valid(value):
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt tàu.")
    return ObjectId(value)


def _report_match(
    period_month: str,
    year: int,
    period_type: str,
    area: str,
) -> dict:
    period_match = period_filter(period_month, year, period_type)
    area_match = area_filter(area)
    return {"$and": [period_match, area_match]} if area_match else period_match


@app.middleware("http")
async def limit_request_size(request, call_next):
    try:
        content_length = int(request.headers.get("content-length", "0"))
    except ValueError:
        return JSONResponse(status_code=400, content={"detail": "Content-Length không hợp lệ."})
    if content_length > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Dữ liệu gửi lên quá lớn."})
    return await call_next(request)


@app.on_event("startup")
def startup():
    database = get_database()
    database.command("ping")
    database.vessels.create_index(
        [("period_month", ASCENDING), ("legacy_id", ASCENDING), ("khu_vuc", ASCENDING)],
        unique=True,
        partialFilterExpression={"legacy_id": {"$type": "number"}},
        name="uq_period_legacy_area",
    )
    database.vessels.create_index(
        [("khu_vuc", ASCENDING), ("period_month", ASCENDING)],
        name="idx_area_period",
    )
    database.vessels.create_index([("date_in", ASCENDING)], name="idx_date_in")
    database.periods.create_index([("month_key", ASCENDING)], name="idx_month_key")


@app.on_event("shutdown")
def shutdown():
    if client is not None:
        client.close()


@app.exception_handler(PyMongoError)
async def database_error_handler(_request, _error):
    return JSONResponse(
        status_code=503,
        content={"detail": "Không thể truy cập cơ sở dữ liệu online lúc này."},
    )


@app.get("/api/health")
def health():
    try:
        get_database().command("ping")
    except (HTTPException, PyMongoError):
        return JSONResponse(status_code=503, content={"status": "error"})
    return {"status": "ok", "database": DATABASE_NAME}


@app.get("/api/periods")
def list_periods():
    return {"periods": sorted(get_database().periods.distinct("month_key"))}


@app.get("/api/counts")
def counts_by_area(
    period: str = "",
):
    match = {"period_month": validate_period(period)} if period else {}
    values = {area: 0 for area in AREAS}
    for row in get_database().vessels.aggregate([
        {"$match": match},
        {"$group": {"_id": "$khu_vuc", "count": {"$sum": 1}}},
    ]):
        if row["_id"] in values:
            values[row["_id"]] = int(row["count"])
    return values


@app.get("/api/totals")
def totals(
    period: str = "",
    area: str = "Tổng hợp",
    search: str = "",
):
    pipeline = [
        {"$match": vessel_filter(period, area, search)},
        {"$group": {
            "_id": None,
            "vessel_count": {"$sum": 1},
            "grt": {"$sum": {"$ifNull": ["$grt", 0]}},
            "dwt": {"$sum": {"$ifNull": ["$dwt", 0]}},
            "cargo_amount": {"$sum": {"$ifNull": ["$cargo_amount", 0]}},
            "cargo_amount_in": {"$sum": {"$ifNull": ["$cargo_amount_in", 0]}},
            "cargo_amount_out": {"$sum": {"$ifNull": ["$cargo_amount_out", 0]}},
        }},
    ]
    result = next(get_database().vessels.aggregate(pipeline), None)
    if result:
        result.pop("_id", None)
        return result
    return {
        "vessel_count": 0,
        "grt": 0,
        "dwt": 0,
        "cargo_amount": 0,
        "cargo_amount_in": 0,
        "cargo_amount_out": 0,
    }


@app.get("/api/vessels")
def search_vessels(
    period: str = "",
    area: str = "Tổng hợp",
    search: str = "",
    limit: int = Query(default=500, ge=1, le=1000),
):
    projection = {
        "period_month": 1, "legacy_id": 1, "khu_vuc": 1, "ship_name": 1,
        "call_sign": 1, "imo": 1, "flag": 1, "vessel_class": 1,
        "ship_type": 1, "date_in": 1, "date_out": 1, "port": 1,
        "agent": 1, "cargo_amount": 1, "cargo_amount_in": 1,
        "cargo_amount_out": 1, "grt": 1, "dwt": 1,
    }
    rows = get_database().vessels.find(
        vessel_filter(period, area, search),
        projection,
    ).sort([("period_month", -1), ("khu_vuc", 1), ("ship_name", 1)]).limit(limit)
    return [
        {
            "id": str(row["_id"]),
            "period_month": row.get("period_month"),
            "legacy_id": row.get("legacy_id"),
            "khu_vuc": row.get("khu_vuc"),
            "ship_name": row.get("ship_name"),
            "call_sign": row.get("call_sign"),
            "imo": row.get("imo"),
            "flag": row.get("flag"),
            "vessel_class": row.get("vessel_class"),
            "ship_type": row.get("ship_type"),
            "date_in": row.get("date_in"),
            "date_out": row.get("date_out"),
            "port": row.get("port"),
            "agent": row.get("agent"),
            "cargo_amount": row.get("cargo_amount"),
            "cargo_amount_in": row.get("cargo_amount_in"),
            "cargo_amount_out": row.get("cargo_amount_out"),
            "grt": row.get("grt"),
            "dwt": row.get("dwt"),
        }
        for row in rows
    ]


@app.get("/api/export")
def export_rows(
    period: str = "",
    area: str = "Tổng hợp",
    search: str = "",
):
    rows = get_database().vessels.find(
        vessel_filter(period, area, search),
        {
            "period_month": 1, "legacy_id": 1, "khu_vuc": 1,
            "ship_name": 1, "call_sign": 1, "imo": 1, "flag": 1,
            "vessel_class": 1, "ship_type": 1, "date_in": 1,
            "date_out": 1, "port": 1, "port_area": 1, "last_port": 1,
            "next_port": 1, "agent": 1, "cargo_amount": 1,
            "cargo_amount_in": 1, "cargo_amount_out": 1, "grt": 1,
            "dwt": 1, "length": 1, "draft": 1,
        },
    ).sort([("period_month", 1), ("khu_vuc", 1), ("ship_name", 1)])
    return [
        {
            "period_month": row.get("period_month"),
            "legacy_id": row.get("legacy_id"),
            "khu_vuc": row.get("khu_vuc"),
            "ship_name": row.get("ship_name"),
            "call_sign": row.get("call_sign"),
            "imo": row.get("imo"),
            "flag": row.get("flag"),
            "vessel_class": row.get("vessel_class"),
            "ship_type": row.get("ship_type"),
            "date_in": row.get("date_in"),
            "date_out": row.get("date_out"),
            "port": row.get("port"),
            "port_area": row.get("port_area"),
            "last_port": row.get("last_port"),
            "next_port": row.get("next_port"),
            "agent": row.get("agent"),
            "cargo_amount": row.get("cargo_amount"),
            "cargo_amount_in": row.get("cargo_amount_in"),
            "cargo_amount_out": row.get("cargo_amount_out"),
            "grt": row.get("grt"),
            "dwt": row.get("dwt"),
            "length": row.get("length"),
            "draft": row.get("draft"),
        }
        for row in rows
    ]


@app.get("/api/vessels/{record_id}")
def get_vessel(record_id: str):
    document = get_database().vessels.find_one({"_id": _record_id(record_id)})
    if not document:
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt tàu.")
    return document.get("payload", {})


@app.post("/api/vessels")
def add_vessel(body: VesselRequest):
    database = get_database()
    document = _normalize_vessel(body.month_key, body.vessel)
    if document["legacy_id"] is None:
        document["legacy_id"] = _next_legacy_id(database)
        document["payload"]["id"] = document["legacy_id"]
    database.periods.update_one(
        {"month_key": body.month_key},
        {"$set": {"month_key": body.month_key, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    result = database.vessels.insert_one(document)
    return {"id": str(result.inserted_id), "legacy_id": document["legacy_id"]}


@app.put("/api/vessels/{record_id}")
def update_vessel(record_id: str, body: VesselRequest):
    database = get_database()
    document = _normalize_vessel(body.month_key, body.vessel)
    if document["legacy_id"] is None:
        current = database.vessels.find_one(
            {"_id": _record_id(record_id)},
            {"legacy_id": 1},
        )
        if not current:
            raise HTTPException(status_code=404, detail="Không tìm thấy lượt tàu.")
        document["legacy_id"] = current["legacy_id"]
        document["payload"]["id"] = current["legacy_id"]
    result = database.vessels.update_one(
        {"_id": _record_id(record_id)},
        {"$set": document},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt tàu.")
    database.periods.update_one(
        {"month_key": body.month_key},
        {"$set": {"month_key": body.month_key, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"id": record_id, "updated": True}


@app.delete("/api/vessels/{record_id}")
def delete_vessel(record_id: str):
    result = get_database().vessels.delete_one({"_id": _record_id(record_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt tàu.")
    return {"id": record_id, "deleted": True}


@app.get("/api/reports/payloads")
def report_payloads(
    period_month: str = "",
    year: int = 0,
    period_type: str = "tháng",
    area: str = "Tổng hợp",
):
    match = _report_match(period_month, year, period_type, area)
    cursor = get_database().vessels.find(
        match,
        {"payload": 1, "period_month": 1, "khu_vuc": 1},
    ).sort([("period_month", 1), ("khu_vuc", 1), ("ship_name", 1)])
    result = []
    for document in cursor:
        vessel = dict(document.get("payload") or {})
        vessel["periodMonth"] = document["period_month"]
        vessel["khuVuc"] = document["khu_vuc"]
        result.append(vessel)
    return result


@app.get("/api/period-report")
def period_report(
    period_type: str,
    year: int,
    area: str = "Tổng hợp",
):
    if period_type == "6 đầu":
        start_month, end_month = 1, 6
    elif period_type == "6 cuối":
        start_month, end_month = 7, 12
    elif period_type == "năm":
        start_month, end_month = 1, 12
    else:
        raise HTTPException(status_code=400, detail="Loại kỳ báo cáo không hợp lệ.")
    if year < 1 or year > 9999:
        raise HTTPException(status_code=400, detail="Năm báo cáo không hợp lệ.")
    months = [f"{year}-{month:02d}" for month in range(start_month, end_month + 1)]
    match = {"period_month": {"$in": months}}
    area_match = area_filter(area)
    if area_match:
        match.update(area_match)
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": None,
            "vessel_count": {"$sum": 1},
            "grt": {"$sum": {"$ifNull": ["$grt", 0]}},
            "dwt": {"$sum": {"$ifNull": ["$dwt", 0]}},
            "cargo_amount": {"$sum": {"$ifNull": ["$cargo_amount", 0]}},
            "cargo_amount_in": {"$sum": {"$ifNull": ["$cargo_amount_in", 0]}},
            "cargo_amount_out": {"$sum": {"$ifNull": ["$cargo_amount_out", 0]}},
        }},
    ]
    totals_row = next(get_database().vessels.aggregate(pipeline), None) or {}
    totals_row.pop("_id", None)
    totals_row = {
        key: totals_row.get(key, 0)
        for key in (
            "vessel_count", "grt", "dwt", "cargo_amount",
            "cargo_amount_in", "cargo_amount_out",
        )
    }
    data_months = sorted(get_database().vessels.distinct("period_month", match))
    return {
        "periodType": period_type,
        "year": year,
        "area": area,
        "monthKeys": months,
        "dataMonths": data_months,
        **totals_row,
    }


@app.post("/api/import")
def import_backup(body: BackupRequest):
    try:
        state = body.backup["collections"]["applicationState"][0]["state"]
        datasets = state["monthDatasets"]
    except (KeyError, IndexError, TypeError) as error:
        raise HTTPException(status_code=400, detail="File backup không đúng cấu trúc.") from error

    database = get_database()
    inserted = 0
    updated = 0
    skipped = 0
    period_count = 0
    largest_id = max(
        (
            int(vessel["id"])
            for dataset in datasets.values()
            if isinstance(dataset, dict)
            for vessel in dataset.get("vessels", [])
            if isinstance(vessel, dict)
            and str(vessel.get("id") or "").isdigit()
        ),
        default=0,
    )
    if largest_id:
        database.counters.update_one(
            {"_id": "vessel"},
            {"$max": {"value": largest_id}},
            upsert=True,
        )

    for month_key, dataset in datasets.items():
        if month_key == "current" or not MONTH_PATTERN.fullmatch(str(month_key)):
            continue
        period_count += 1
        database.periods.update_one(
            {"month_key": month_key},
            {"$set": {"month_key": month_key, "updated_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
        for vessel in (dataset.get("vessels", []) if isinstance(dataset, dict) else []):
            if not isinstance(vessel, dict):
                skipped += 1
                continue
            try:
                document = _normalize_vessel(month_key, vessel)
            except HTTPException:
                skipped += 1
                continue
            if document["legacy_id"] is None:
                document["legacy_id"] = _next_legacy_id(database)
                document["payload"]["id"] = document["legacy_id"]
            key = {
                "period_month": month_key,
                "legacy_id": document["legacy_id"],
                "khu_vuc": document["khu_vuc"],
            }
            result = database.vessels.update_one(key, {"$set": document}, upsert=True)
            if result.upserted_id:
                inserted += 1
            else:
                updated += 1

    return {
        "periodCount": period_count,
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
    }
