from collections import defaultdict
import re
import unicodedata
from typing import Any

from db import AREAS


DETAIL_SEA_COLUMNS = (
    ("Tên tàu", "shipName"),
    ("Hô hiệu", "callSign"),
    ("Số IMO", "imo"),
    ("Quốc tịch", "flag"),
    ("Loại tàu", "shipType"),
    ("Chiều dài (m)", "length"),
    ("Mớn nước (m)", "draft"),
    ("DWT", "dwt"),
    ("GT", "grt"),
    ("Tĩnh không (m)", "clearanceHeight"),
    ("Xuất khẩu (Tấn)", "exportTons"),
    ("Xuất khẩu (TEU)", "exportTeus"),
    ("Xuất khẩu (TEU rỗng)", "exportEmptyTeus"),
    ("Nhập khẩu (Tấn)", "importTons"),
    ("Nhập khẩu (TEU)", "importTeus"),
    ("Nhập khẩu (TEU rỗng)", "importEmptyTeus"),
    ("Nội địa đến (Tấn)", "domesticInTons"),
    ("Nội địa đến (TEU)", "domesticInTeus"),
    ("Nội địa đến (TEU rỗng)", "domesticInEmptyTeus"),
    ("Nội địa rời (Tấn)", "domesticOutTons"),
    ("Nội địa rời (TEU)", "domesticOutTeus"),
    ("Nội địa rời (TEU rỗng)", "domesticOutEmptyTeus"),
    ("Chuyển tải (Tấn)", "transshipmentTons"),
    ("Chuyển tải (TEU)", "transshipmentTeus"),
    ("Quá cảnh không bốc dỡ (Tấn)", "transitDirectTons"),
    ("Quá cảnh không bốc dỡ (TEU)", "transitDirectTeus"),
    ("Quá cảnh bốc dỡ (Tấn)", "transitLoadedTons"),
    ("Quá cảnh bốc dỡ (TEU)", "transitLoadedTeus"),
    ("Hành khách đến", "passengersIn"),
    ("Hành khách rời", "passengersOut"),
    ("Tên hàng", "cargoName"),
    ("Cảng rời cuối cùng", "lastPort"),
    ("Cảng đến/làm hàng", "portArea"),
    ("Cảng đích", "nextPort"),
    ("Ngày đến cảng", "dateIn"),
    ("Ngày rời cảng", "dateOut"),
    ("Đại lý tàu biển", "agent"),
)

DETAIL_INLAND_COLUMNS = (
    ("Tên PTTNĐ", "shipName"),
    ("Số đăng ký", "registrationNo"),
    ("Loại phương tiện", "shipType"),
    ("Cấp PTTNĐ", "inlandClass"),
    ("Chiều dài (m)", "length"),
    ("Trọng tải toàn phần", "dwt"),
    ("Dung tích", "grt"),
    ("Xuất khẩu (Tấn)", "exportTons"),
    ("Xuất khẩu (TEU)", "exportTeus"),
    ("Xuất khẩu (TEU rỗng)", "exportEmptyTeus"),
    ("Nhập khẩu (Tấn)", "importTons"),
    ("Nhập khẩu (TEU)", "importTeus"),
    ("Nhập khẩu (TEU rỗng)", "importEmptyTeus"),
    ("Nội địa đến (Tấn)", "domesticInTons"),
    ("Nội địa đến (TEU)", "domesticInTeus"),
    ("Nội địa đến (TEU rỗng)", "domesticInEmptyTeus"),
    ("Nội địa rời (Tấn)", "domesticOutTons"),
    ("Nội địa rời (TEU)", "domesticOutTeus"),
    ("Nội địa rời (TEU rỗng)", "domesticOutEmptyTeus"),
    ("Chuyển tải (Tấn)", "transshipmentTons"),
    ("Chuyển tải (TEU)", "transshipmentTeus"),
    ("Quá cảnh không bốc dỡ (Tấn)", "transitDirectTons"),
    ("Quá cảnh không bốc dỡ (TEU)", "transitDirectTeus"),
    ("Quá cảnh bốc dỡ (Tấn)", "transitLoadedTons"),
    ("Quá cảnh bốc dỡ (TEU)", "transitLoadedTeus"),
    ("Hành khách đến", "passengersIn"),
    ("Hành khách rời", "passengersOut"),
    ("Tên hàng", "cargoName"),
    ("Cảng rời cuối cùng", "lastPort"),
    ("Cảng đến/làm hàng", "portArea"),
    ("Cảng đích", "nextPort"),
    ("Ngày đến cảng", "dateIn"),
    ("Ngày rời cảng", "dateOut"),
    ("Đại lý PTTNĐ", "agent"),
)

STAT_COLUMNS = (
    ("STT", "index"),
    ("Chỉ tiêu", "label"),
    ("Đơn vị tính", "unit"),
    ("Kế hoạch năm", "plan"),
    ("Từ đầu kỳ đến trước", "before"),
    ("Thực hiện kỳ báo cáo", "period"),
    ("Lũy kế đến kỳ báo cáo", "cumulative"),
    ("Lũy kế cùng kỳ năm trước", "previous"),
    ("So với cùng kỳ (%)", "year_change"),
    ("So với kế hoạch (%)", "plan_change"),
)

COMPARISON_COLUMNS = (
    ("STT", "index"),
    ("Chỉ tiêu", "label"),
    ("Đơn vị", "unit"),
    ("Thực hiện tháng báo cáo", "period"),
    ("Thực hiện tháng báo cáo năm trước", "previous"),
    ("Thực hiện so với cùng kỳ (%)", "year_change"),
    ("Lũy kế từ đầu năm đến hết tháng báo cáo", "cumulative"),
    ("Lũy kế từ đầu năm đến hết tháng báo cáo năm trước", "previous_cumulative"),
    ("Thực hiện so với cùng kỳ (%)", "cumulative_change"),
)

VIETNAMESE_SHIP_COLUMNS = (
    ("STT", "index"),
    ("Chỉ tiêu", "label"),
    ("Đơn vị tính", "unit"),
    ("Từ đầu năm đến hết tháng trước", "before"),
    ("Thực hiện tháng báo cáo", "period"),
    ("Lũy kế đến tháng báo cáo", "cumulative"),
    ("Lũy kế cùng kỳ năm trước", "previous"),
    ("So với cùng kỳ (%)", "year_change"),
)

PORT_COLUMNS_03 = (
    ("STT", "index"),
    ("Tên cảng/bến", "label"),
    ("Container tháng (Tấn)", "container_period"),
    ("Container tháng (TEU)", "teu_period"),
    ("Container lũy kế (Tấn)", "container_cumulative"),
    ("Container lũy kế (TEU)", "teu_cumulative"),
    ("Hàng khô tháng", "dry_period"),
    ("Hàng khô lũy kế", "dry_cumulative"),
    ("Hàng lỏng tháng", "liquid_period"),
    ("Hàng lỏng lũy kế", "liquid_cumulative"),
    ("Quá cảnh bốc dỡ tháng", "loaded_period"),
    ("Quá cảnh bốc dỡ lũy kế", "loaded_cumulative"),
    ("Lượt tàu tháng", "calls_period"),
    ("Lượt tàu lũy kế", "calls_cumulative"),
    ("Ghi chú", "notes"),
)

PORT_COLUMNS_15 = (
    ("STT", "index"),
    ("Tên cảng/bến", "label"),
    ("Container tháng (Tấn)", "container_period"),
    ("Container tháng (TEU)", "teu_period"),
    ("Container lũy kế (Tấn)", "container_cumulative"),
    ("Container lũy kế (TEU)", "teu_cumulative"),
    ("Hàng khô tháng", "dry_period"),
    ("Hàng khô lũy kế", "dry_cumulative"),
    ("Hàng lỏng tháng", "liquid_period"),
    ("Hàng lỏng lũy kế", "liquid_cumulative"),
    ("Quá cảnh bốc dỡ tháng", "loaded_period"),
    ("Quá cảnh bốc dỡ lũy kế", "loaded_cumulative"),
    ("Quá cảnh không bốc dỡ tháng", "direct_period"),
    ("Quá cảnh không bốc dỡ lũy kế", "direct_cumulative"),
    ("Ghi chú", "notes"),
)

REPORTS = (
    ("11-T", "BÁO CÁO CHI TIẾT TÀU BIỂN RA, VÀO CẢNG BIỂN"),
    ("11B-T", "BÁO CÁO CHI TIẾT PHƯƠNG TIỆN THỦY NỘI ĐỊA"),
    ("12-T", "KHỐI LƯỢNG HÀNG HÓA, HÀNH KHÁCH THÔNG QUA CẢNG BIỂN"),
    ("12B-T", "SỐ LƯỢNG HÀNG HÓA VÀ LƯỢT TÀU THUYỀN THÔNG QUA CẢNG"),
    ("13-T", "LƯỢT TÀU THUYỀN RA, VÀO CẢNG BIỂN"),
    ("14-T", "HÀNG HÓA, HÀNH KHÁCH THÔNG QUA CẢNG BẰNG ĐỘI TÀU BIỂN VIỆT NAM"),
    ("15-T", "KHỐI LƯỢNG HÀNG HÓA THEO CẢNG, BẾN, KHU CHUYỂN TẢI"),
    ("01-T", "HÀNG HÓA, HÀNH KHÁCH THÔNG QUA CẢNG, BẾN THỦY NỘI ĐỊA"),
    ("02-T", "LƯỢT TÀU THUYỀN RA, VÀO CẢNG, BẾN THỦY NỘI ĐỊA"),
    ("03-T", "KHỐI LƯỢNG HÀNG HÓA, LƯỢT TÀU THÔNG QUA CẢNG, BẾN"),
    ("04-Q", "BÁO CÁO TỔNG HỢP QUÝ"),
    ("Tổng cộng", "BẢNG TỔNG CỘNG THEO KHU VỰC"),
    ("Báo cáo", "TỔNG QUAN SỐ LIỆU BÁO CÁO"),
)


def _norm(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"\s+", " ", text.replace("đ", "d").replace("Đ", "D")).strip().lower()


def _number(value: Any):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def _breakdown(vessel: dict) -> dict:
    value = vessel.get("cargoBreakdown")
    return value if isinstance(value, dict) else {}


def _detail_value(vessel: dict, key: str):
    breakdown = _breakdown(vessel)
    if key in breakdown:
        value = breakdown[key]
        if value is not None:
            return value
        if key in (
            "exportTons",
            "importTons",
            "domesticTons",
            "transshipmentTons",
            "transitDirectTons",
            "transitLoadedTons",
        ):
            return _metric([vessel], key)
    if key == "cargoName":
        return " / ".join(
            item for item in (vessel.get("cargoNameIn"), vessel.get("cargoNameOut")) if item
        )
    return vessel.get(key)


def _metric(vessels: list[dict], key: str):
    values = [_number(_breakdown(vessel).get(key)) for vessel in vessels]
    available = [value for value in values if value is not None]
    if available:
        return sum(available)
    if key == "cargoTons":
        total = 0.0
        found = False
        for vessel in vessels:
            incoming = _number(vessel.get("cargoAmountIn"))
            outgoing = _number(vessel.get("cargoAmountOut"))
            incoming_tons = _norm(vessel.get("cargoUnitIn")) in ("tan", "t", "ton")
            outgoing_tons = _norm(vessel.get("cargoUnitOut")) in ("tan", "t", "ton")
            if incoming_tons and incoming is not None:
                total += incoming
                found = True
            if outgoing_tons and outgoing is not None:
                total += outgoing
                found = True
            if incoming is None and outgoing is None:
                amount = _number(vessel.get("cargoAmount"))
                if amount is not None and _norm(vessel.get("cargoUnit")) in ("tan", "t", "ton"):
                    total += amount
                    found = True
        return total if found else None
    if key in (
        "exportTons",
        "importTons",
        "domesticTons",
        "transshipmentTons",
        "transitLoadedTons",
        "transitDirectTons",
    ):
        tokens = {
            "exportTons": ("xuat khau", "xc"),
            "importTons": ("nhap khau", "nc"),
            "domesticTons": ("noi dia", "nd", "brd"),
            "transshipmentTons": ("chuyen tai",),
            "transitLoadedTons": ("qua canh", "qc"),
            "transitDirectTons": ("khong boc do", "kxd"),
        }[key]
        total = 0.0
        found = False
        for vessel in vessels:
            for direction, amount_field, unit_field, handling_field, route_field in (
                ("in", "cargoAmountIn", "cargoUnitIn", "cargoHandlingIn", "sourceRouteCode"),
                ("out", "cargoAmountOut", "cargoUnitOut", "cargoHandlingOut", "sourceRouteOutCode"),
            ):
                amount = _number(vessel.get(amount_field))
                if amount is None or _norm(vessel.get(unit_field)) not in ("tan", "t", "ton"):
                    continue
                descriptor = _norm(
                    f"{vessel.get(handling_field) or ''} {vessel.get(route_field) or ''}"
                )
                if any(token in descriptor for token in tokens):
                    total += amount
                    found = True
            if _number(vessel.get("cargoAmountIn")) is None and _number(vessel.get("cargoAmountOut")) is None:
                amount = _number(vessel.get("cargoAmount"))
                descriptor = _norm(
                    f"{vessel.get('sourceRouteCode') or ''} {vessel.get('sourceRouteOutCode') or ''}"
                )
                if amount is not None and _norm(vessel.get("cargoUnit")) in ("tan", "t", "ton") and any(
                    token in descriptor for token in tokens
                ):
                    total += amount
                    found = True
        return total if found else None
    return None


def _classify(vessel: dict) -> str:
    vessel_class = _norm(vessel.get("vesselClass") or vessel.get("portType"))
    return "inland" if vessel_class in ("inland", "thuy noi dia", "pttnd") else "sea"


def _foreign(vessel: dict) -> bool:
    flag = _norm(vessel.get("flag"))
    return bool(flag and flag not in ("viet nam", "vietnam", "vn", "viet nam (vn)"))


def _cargo_category(vessel: dict) -> str:
    breakdown = _breakdown(vessel)
    handling = _norm(
        " ".join(
            str(vessel.get(field) or "")
            for field in ("cargoHandlingIn", "cargoHandlingOut")
        )
    )
    for token, key in (
        ("xuat khau", "exportTons"),
        ("nhap khau", "importTons"),
        ("noi dia", "domesticTons"),
        ("chuyen tai", "transshipmentTons"),
        ("qua canh", "transitLoadedTons"),
    ):
        if token in handling:
            return key
    for key in ("exportTons", "importTons", "domesticTons", "transitLoadedTons", "transshipmentTons"):
        if _number(breakdown.get(key)) is not None:
            return key
    return ""


def _class_metrics(vessels: list[dict]) -> dict:
    metrics = {}
    metrics["calls"] = len(vessels)
    metrics["sea_calls"] = sum(_classify(vessel) == "sea" for vessel in vessels)
    metrics["inland_calls"] = sum(_classify(vessel) == "inland" for vessel in vessels)
    metrics["foreign_sea_calls"] = sum(
        _classify(vessel) == "sea" and _foreign(vessel) for vessel in vessels
    )
    metrics["vietnamese_sea_calls"] = sum(
        _classify(vessel) == "sea" and not _foreign(vessel) for vessel in vessels
    )
    metrics["cargo_total"] = _metric(vessels, "cargoTons")
    for key in (
        "exportTons",
        "importTons",
        "domesticTons",
        "transshipmentTons",
        "transitLoadedTons",
        "transitDirectTons",
        "containerTons",
        "containerTeus",
        "dryTons",
        "liquidTons",
        "passengersIn",
        "passengersOut",
    ):
        metrics[key] = _metric(vessels, key)
    metrics["passengers"] = (
        sum(value for value in (metrics["passengersIn"], metrics["passengersOut"]) if value is not None)
        if metrics["passengersIn"] is not None or metrics["passengersOut"] is not None
        else None
    )
    return metrics


def _stat_rows(
    vessels: list[dict],
    code: str,
    cumulative_vessels: list[dict] | None = None,
    before_vessels: list[dict] | None = None,
) -> list[dict]:
    cumulative_vessels = vessels if cumulative_vessels is None else cumulative_vessels
    before_vessels = [] if before_vessels is None else before_vessels
    if code in ("02-T", "13-T"):
        specs = [
            ("Tổng lượt tàu thuyền ra, vào cảng", "Lượt", "calls"),
            ("Tàu biển", "Lượt", "sea_calls"),
            ("Tàu biển nước ngoài", "Lượt", "foreign_sea_calls"),
            ("Tàu biển Việt Nam", "Lượt", "vietnamese_sea_calls"),
            ("Phương tiện thủy nội địa", "Lượt", "inland_calls"),
        ]
    elif code in ("03-T", "15-T"):
        return _port_rows(vessels, cumulative_vessels)
    elif code == "14-T":
        is_vietnamese_sea = lambda vessel: (
            _classify(vessel) == "sea" and not _foreign(vessel)
        )
        vessels = [vessel for vessel in vessels if is_vietnamese_sea(vessel)]
        cumulative_vessels = [
            vessel for vessel in cumulative_vessels if is_vietnamese_sea(vessel)
        ]
        before_vessels = [
            vessel for vessel in before_vessels if is_vietnamese_sea(vessel)
        ]
        specs = [
            ("Tổng số hàng hóa", "Tấn", "cargo_total"),
            ("Hàng xuất khẩu", "Tấn", "exportTons"),
            ("Hàng nhập khẩu", "Tấn", "importTons"),
            ("Hàng nội địa", "Tấn", "domesticTons"),
            ("Container", "Tấn", "containerTons"),
            ("Container", "TEU", "containerTeus"),
            ("Hàng lỏng, gas", "Tấn", "liquidTons"),
            ("Hàng khô, tổng hợp", "Tấn", "dryTons"),
            ("Hành khách", "Lượt", "passengers"),
        ]
    else:
        specs = [
            ("Tổng khối lượng hàng hóa", "Tấn", "cargo_total"),
            ("Hàng xuất khẩu", "Tấn", "exportTons"),
            ("Hàng nhập khẩu", "Tấn", "importTons"),
            ("Hàng nội địa", "Tấn", "domesticTons"),
            ("Hàng quá cảnh bốc dỡ", "Tấn", "transitLoadedTons"),
            ("Hàng quá cảnh không bốc dỡ", "Tấn", "transitDirectTons"),
            ("Hàng chuyển tải", "Tấn", "transshipmentTons"),
            ("Container", "Tấn", "containerTons"),
            ("Container", "TEU", "containerTeus"),
            ("Hàng khô", "Tấn", "dryTons"),
            ("Hàng lỏng", "Tấn", "liquidTons"),
            ("Hành khách", "Lượt", "passengers"),
        ]

    metrics = _class_metrics(vessels)
    cumulative_metrics = _class_metrics(cumulative_vessels)
    before_metrics = _class_metrics(before_vessels)
    rows = []
    for index, (label, unit, metric_key) in enumerate(specs, start=1):
        value = metrics.get(metric_key)
        cumulative = cumulative_metrics.get(metric_key)
        row = {
            "index": index,
            "label": label,
            "unit": unit,
            "plan": None,
            "before": before_metrics.get(metric_key),
            "period": value,
            "cumulative": cumulative,
            "previous": None,
            "year_change": None,
            "plan_change": None,
            "previous_cumulative": None,
            "cumulative_change": None,
        }
        rows.append(row)
    return rows


def _port_rows(
    vessels: list[dict],
    cumulative_vessels: list[dict],
) -> list[dict]:
    grouped = defaultdict(list)
    cumulative_by_port = defaultdict(list)
    for vessel in vessels:
        key = vessel.get("portArea") or vessel.get("port") or "Chưa xác định"
        grouped[str(key)].append(vessel)
    for vessel in cumulative_vessels:
        key = vessel.get("portArea") or vessel.get("port") or "Chưa xác định"
        cumulative_by_port[str(key)].append(vessel)
    rows = []
    for index, (port, records) in enumerate(sorted(grouped.items()), start=1):
        metric = _class_metrics(records)
        cumulative = _class_metrics(cumulative_by_port[port])
        rows.append({
            "index": index,
            "label": port,
            "container_period": metric["containerTons"],
            "teu_period": metric["containerTeus"],
            "container_cumulative": cumulative["containerTons"],
            "teu_cumulative": cumulative["containerTeus"],
            "dry_period": metric["dryTons"],
            "dry_cumulative": cumulative["dryTons"],
            "liquid_period": metric["liquidTons"],
            "liquid_cumulative": cumulative["liquidTons"],
            "loaded_period": metric["transitLoadedTons"],
            "loaded_cumulative": cumulative["transitLoadedTons"],
            "direct_period": metric["transitDirectTons"],
            "direct_cumulative": cumulative["transitDirectTons"],
            "calls_period": metric["calls"],
            "calls_cumulative": cumulative["calls"],
            "notes": None,
        })
    if rows:
        metric = _class_metrics(vessels)
        cumulative = _class_metrics(cumulative_vessels)
        rows.append({
            "index": "",
            "label": "TỔNG CỘNG",
            "container_period": metric["containerTons"],
            "teu_period": metric["containerTeus"],
            "container_cumulative": cumulative["containerTons"],
            "teu_cumulative": cumulative["containerTeus"],
            "dry_period": metric["dryTons"],
            "dry_cumulative": cumulative["dryTons"],
            "liquid_period": metric["liquidTons"],
            "liquid_cumulative": cumulative["liquidTons"],
            "loaded_period": metric["transitLoadedTons"],
            "loaded_cumulative": cumulative["transitLoadedTons"],
            "direct_period": metric["transitDirectTons"],
            "direct_cumulative": cumulative["transitDirectTons"],
            "calls_period": metric["calls"],
            "calls_cumulative": cumulative["calls"],
            "notes": None,
        })
    return rows


def _change_percent(current, previous):
    if current is None or previous in (None, 0):
        return None
    return current / previous * 100


def _12b_rows(
    vessels: list[dict],
    cumulative_vessels: list[dict],
    previous_vessels: list[dict],
    previous_cumulative_vessels: list[dict],
) -> list[dict]:
    groups = {
        "all": (vessels, cumulative_vessels, previous_vessels, previous_cumulative_vessels),
        "sea": (
            [vessel for vessel in vessels if _classify(vessel) == "sea"],
            [vessel for vessel in cumulative_vessels if _classify(vessel) == "sea"],
            [vessel for vessel in previous_vessels if _classify(vessel) == "sea"],
            [
                vessel for vessel in previous_cumulative_vessels
                if _classify(vessel) == "sea"
            ],
        ),
        "inland": (
            [vessel for vessel in vessels if _classify(vessel) == "inland"],
            [vessel for vessel in cumulative_vessels if _classify(vessel) == "inland"],
            [vessel for vessel in previous_vessels if _classify(vessel) == "inland"],
            [
                vessel for vessel in previous_cumulative_vessels
                if _classify(vessel) == "inland"
            ],
        ),
    }
    specs = (
        ("I.", "Khối lượng hàng hóa và số lượng tàu thuyền thông qua cảng", "", None, None),
        ("1.1.", "Sản lượng hàng hóa và số lượt tàu biển thông qua", "", None, None),
        ("1.1.1.", "Tổng số lượt tàu biển", "lượt", "sea", "sea_calls"),
        ("1.1.1.1.", "Tàu nước ngoài", "lượt", "sea", "foreign_sea_calls"),
        ("1.1.1.2.", "Tàu Việt Nam", "lượt", "sea", "vietnamese_sea_calls"),
        ("1.1.2.", "Khối lượng hàng hóa thông qua cảng bằng tàu biển", "tấn", "sea", "cargo_total"),
        ("", "Trong đó: Xuất khẩu", "tấn", "sea", "exportTons"),
        ("", "Nhập khẩu", "tấn", "sea", "importTons"),
        ("", "Nội địa", "tấn", "sea", "domesticTons"),
        ("", "Container", "tấn", "sea", "containerTons"),
        ("", "Container", "teu", "sea", "containerTeus"),
        ("", "Hàng lỏng", "tấn", "sea", "liquidTons"),
        ("", "Hàng khô", "tấn", "sea", "dryTons"),
        ("1.2.", "Khối lượng hàng hóa và số lượng phương tiện thủy nội địa (PTTNĐ) thông qua", "", None, None),
        ("1.2.1.", "Tổng số PTTNĐ thông qua", "lượt", "inland", "inland_calls"),
        ("1.2.2.", "Hàng hóa thông qua bằng PTTNĐ", "tấn", "inland", "cargo_total"),
        ("", "Trong đó: Hàng khô", "tấn", "inland", "dryTons"),
        ("", "Hàng lỏng", "tấn", "inland", "liquidTons"),
        ("", "Hàng Container", "tấn", "inland", "containerTons"),
        ("", "Hàng Container", "teu", "inland", "containerTeus"),
        ("1.3.", "Hàng hóa quá cảnh", "tấn", "all", "transitLoadedTons"),
        ("1.4.", "Tổng sản lượng hàng hóa thông qua khu vực cảng biển", "", None, None),
        ("", "Tổng hàng hóa thông qua cảng", "tấn", "all", "cargo_total"),
        ("", "Hàng hóa thông qua cảng bằng tàu biển", "tấn", "sea", "cargo_total"),
        ("", "Hàng hóa thông qua cảng bằng PTTNĐ", "tấn", "inland", "cargo_total"),
    )
    rows = []
    for index, (number, label, unit, group_name, metric_key) in enumerate(specs, start=1):
        row = {
            "index": number,
            "label": label,
            "unit": unit,
            "period": None,
            "previous": None,
            "year_change": None,
            "cumulative": None,
            "previous_cumulative": None,
            "cumulative_change": None,
        }
        if group_name:
            period_records, cumulative_records, previous_records, previous_cumulative_records = groups[group_name]
            period_value = _class_metrics(period_records).get(metric_key)
            previous_value = (
                _class_metrics(previous_records).get(metric_key)
                if previous_records else None
            )
            cumulative_value = _class_metrics(cumulative_records).get(metric_key)
            previous_cumulative_value = (
                _class_metrics(previous_cumulative_records).get(metric_key)
                if previous_cumulative_records else None
            )
            row.update({
                "period": period_value,
                "previous": previous_value,
                "year_change": _change_percent(period_value, previous_value),
                "cumulative": cumulative_value,
                "previous_cumulative": previous_cumulative_value,
                "cumulative_change": _change_percent(
                    cumulative_value, previous_cumulative_value
                ),
            })
        rows.append(row)
    return rows


def build_form_rows(
    code: str,
    vessels: list[dict],
    cumulative_vessels: list[dict] | None = None,
    before_vessels: list[dict] | None = None,
    previous_vessels: list[dict] | None = None,
    previous_cumulative_vessels: list[dict] | None = None,
) -> tuple[list[tuple[str, str]], list[dict]]:
    if code == "11-T":
        rows = [vessel for vessel in vessels if _classify(vessel) == "sea"]
        return list(DETAIL_SEA_COLUMNS), [
            {label: _detail_value(vessel, field) for label, field in DETAIL_SEA_COLUMNS}
            for vessel in rows
        ]
    if code == "11B-T":
        rows = [vessel for vessel in vessels if _classify(vessel) == "inland"]
        return list(DETAIL_INLAND_COLUMNS), [
            {label: _detail_value(vessel, field) for label, field in DETAIL_INLAND_COLUMNS}
            for vessel in rows
        ]
    if code == "Tổng cộng":
        rows = []
        for area in AREAS:
            area_vessels = [vessel for vessel in vessels if vessel.get("khuVuc") == area]
            metrics = _class_metrics(area_vessels)
            rows.append({
                "Khu vực": area,
                "Lượt tàu": metrics["calls"],
                "Tàu biển": metrics["sea_calls"],
                "Phương tiện TNĐ": metrics["inland_calls"],
                "Hàng hóa (tấn)": metrics["cargo_total"],
            })
        metrics = _class_metrics(vessels)
        rows.append({
            "Khu vực": "TỔNG CỘNG",
            "Lượt tàu": metrics["calls"],
            "Tàu biển": metrics["sea_calls"],
            "Phương tiện TNĐ": metrics["inland_calls"],
            "Hàng hóa (tấn)": metrics["cargo_total"],
        })
        return [(key, key) for key in rows[0]], rows
    if code == "Báo cáo":
        metrics = _class_metrics(vessels)
        rows = [
            {"Chỉ tiêu": "Tổng lượt tàu", "Giá trị": metrics["calls"], "Đơn vị": "lượt"},
            {"Chỉ tiêu": "Tàu biển", "Giá trị": metrics["sea_calls"], "Đơn vị": "lượt"},
            {"Chỉ tiêu": "Phương tiện thủy nội địa", "Giá trị": metrics["inland_calls"], "Đơn vị": "lượt"},
            {"Chỉ tiêu": "Hàng hóa có số liệu chi tiết", "Giá trị": metrics["cargo_total"], "Đơn vị": "tấn"},
            {"Chỉ tiêu": "Hàng xuất khẩu", "Giá trị": metrics["exportTons"], "Đơn vị": "tấn"},
            {"Chỉ tiêu": "Hàng nhập khẩu", "Giá trị": metrics["importTons"], "Đơn vị": "tấn"},
        ]
        return [("Chỉ tiêu", "Chỉ tiêu"), ("Giá trị", "Giá trị"), ("Đơn vị", "Đơn vị")], rows
    if code == "04-Q":
        rows = _stat_rows(vessels, "12-T", cumulative_vessels, before_vessels)
        return list(STAT_COLUMNS), rows
    if code == "12B-T":
        rows = _12b_rows(
            vessels,
            cumulative_vessels or vessels,
            previous_vessels or [],
            previous_cumulative_vessels or [],
        )
        return list(COMPARISON_COLUMNS), rows
    if code == "14-T":
        rows = _stat_rows(vessels, code, cumulative_vessels, before_vessels)
        return list(VIETNAMESE_SHIP_COLUMNS), rows
    if code == "03-T":
        rows = _stat_rows(vessels, code, cumulative_vessels, before_vessels)
        return list(PORT_COLUMNS_03), rows
    if code == "15-T":
        rows = _stat_rows(vessels, code, cumulative_vessels, before_vessels)
        return list(PORT_COLUMNS_15), rows
    return list(STAT_COLUMNS), _stat_rows(
        vessels, code, cumulative_vessels, before_vessels
    )
