import csv
import json
import os
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    from openpyxl import Workbook
except ImportError:
    Workbook = None

from db import AREAS, StatisticsDatabase
from reports import REPORTS, build_form_rows


BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DATABASE_PATH = BASE_DIR / "thong_ke_tau.db"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Thống kê tàu thuyền")
        self.geometry("1180x720")
        self.minsize(900, 620)

        self.database = StatisticsDatabase(DATABASE_PATH)
        self.period_var = tk.StringVar(value="")
        self.area_var = tk.StringVar(value="Tổng hợp")
        self.search_var = tk.StringVar(value="")

        self._create_ui()
        default_backup = PROJECT_DIR / "database-backup.json"
        if self.database.vessel_count() == 0 and default_backup.exists():
            try:
                self.database.replace_from_backup(default_backup)
            except Exception as error:
                messagebox.showerror(
                    "Không nạp được dữ liệu thật",
                    str(error),
                )
        self.refresh_periods()
        self.refresh()
        self.refresh_report()

    def _create_ui(self):
        self.configure(padx=12, pady=12)
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True)

        vessel_tab = ttk.Frame(self.notebook)
        report_tab = ttk.Frame(self.notebook)
        self.notebook.add(vessel_tab, text="Danh sách tàu")
        self.notebook.add(report_tab, text="BIỂU BÁO CÁO THỐNG KÊ")

        toolbar = ttk.Frame(vessel_tab)
        toolbar.pack(fill="x", pady=(8, 4))

        ttk.Label(toolbar, text="Kỳ").pack(side="left")
        self.period_combo = ttk.Combobox(
            toolbar,
            textvariable=self.period_var,
            state="readonly",
            width=12,
        )
        self.period_combo.pack(side="left", padx=(6, 14))
        self.period_combo.bind("<<ComboboxSelected>>", lambda _event: self.refresh())

        ttk.Label(toolbar, text="Khu vực").pack(side="left")
        self.area_combo = ttk.Combobox(
            toolbar,
            textvariable=self.area_var,
            values=("Tổng hợp",) + AREAS,
            state="readonly",
            width=18,
        )
        self.area_combo.pack(side="left", padx=(6, 14))
        self.area_combo.bind("<<ComboboxSelected>>", lambda _event: self.refresh())

        ttk.Label(toolbar, text="Tìm").pack(side="left")
        search = ttk.Entry(toolbar, textvariable=self.search_var, width=28)
        search.pack(side="left", padx=6)
        search.bind("<Return>", lambda _event: self.refresh())
        ttk.Button(toolbar, text="Tìm", command=self.refresh).pack(side="left")

        ttk.Button(toolbar, text="Nạp dữ liệu thật", command=self.import_real_backup).pack(
            side="right", padx=4
        )
        ttk.Button(toolbar, text="Thêm tàu", command=self.add_vessel_dialog).pack(
            side="left", padx=(14, 4)
        )
        ttk.Button(toolbar, text="Sửa tàu", command=self.edit_vessel_dialog).pack(
            side="left", padx=4
        )
        ttk.Button(toolbar, text="Xóa tàu", command=self.delete_vessel_dialog).pack(
            side="left", padx=4
        )
        ttk.Button(toolbar, text="Xuất CSV", command=lambda: self.export("csv")).pack(
            side="right", padx=4
        )
        ttk.Button(toolbar, text="Xuất Excel", command=lambda: self.export("xlsx")).pack(
            side="right", padx=4
        )

        summary = ttk.LabelFrame(vessel_tab, text="Tổng hợp")
        summary.pack(fill="x", pady=(12, 8))
        self.summary_labels = {}
        for index, (key, title) in enumerate(
            (
                ("vessel_count", "Lượt tàu"),
                ("grt", "GRT"),
                ("dwt", "DWT"),
                ("cargo_amount", "Hàng (tổng)"),
                ("cargo_amount_in", "Hàng đến"),
                ("cargo_amount_out", "Hàng rời"),
            )
        ):
            frame = ttk.Frame(summary)
            frame.grid(row=0, column=index, padx=12, pady=8, sticky="w")
            ttk.Label(frame, text=title).grid(row=0, column=0)
            label = ttk.Label(frame, text="0", font=("Segoe UI", 12, "bold"))
            label.grid(row=1, column=0)
            self.summary_labels[key] = label

        table_frame = ttk.Frame(vessel_tab)
        table_frame.pack(fill="both", expand=True)

        columns = (
            "period_month",
            "khu_vuc",
            "ship_name",
            "call_sign",
            "imo",
            "date_in",
            "date_out",
            "port",
            "grt",
            "dwt",
            "cargo_amount",
        )
        headings = (
            "Kỳ",
            "Khu vực",
            "Tên tàu",
            "Hô hiệu",
            "IMO",
            "Ngày đến",
            "Ngày rời",
            "Cảng",
            "GRT",
            "DWT",
            "Hàng",
        )
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings")
        for column, heading in zip(columns, headings):
            self.tree.heading(column, text=heading)
            self.tree.column(column, width=100, anchor="w", stretch=True)
        self.tree.column("ship_name", width=180)
        self.tree.column("port", width=180)
        self.tree.pack(side="left", fill="both", expand=True)

        scrollbar = ttk.Scrollbar(
            table_frame, orient="vertical", command=self.tree.yview
        )
        scrollbar.pack(side="right", fill="y")
        self.tree.configure(yscrollcommand=scrollbar.set)

        self.status = ttk.Label(vessel_tab, text="")
        self.status.pack(fill="x", pady=(8, 0))

        self.protocol("WM_DELETE_WINDOW", self.close)
        self._create_report_ui(report_tab)

    def _create_report_ui(self, parent):
        controls = ttk.Frame(parent)
        controls.pack(fill="x", pady=(8, 4))

        ttk.Label(controls, text="Kỳ báo cáo").pack(side="left")
        self.report_type_var = tk.StringVar(value="tháng")
        self.report_type_combo = ttk.Combobox(
            controls,
            textvariable=self.report_type_var,
            values=("tháng", "6 tháng đầu", "6 tháng cuối", "năm", "Quý 1", "Quý 2", "Quý 3", "Quý 4"),
            state="readonly",
            width=15,
        )
        self.report_type_combo.pack(side="left", padx=(6, 12))
        self.report_type_combo.bind("<<ComboboxSelected>>", lambda _event: self.refresh_report())

        ttk.Label(controls, text="Tháng").pack(side="left")
        self.report_month_var = tk.StringVar(value="")
        self.report_month_combo = ttk.Combobox(
            controls,
            textvariable=self.report_month_var,
            state="readonly",
            width=12,
        )
        self.report_month_combo.pack(side="left", padx=(6, 12))
        self.report_month_combo.bind("<<ComboboxSelected>>", lambda _event: self.refresh_report())

        ttk.Label(controls, text="Năm").pack(side="left")
        self.report_year_var = tk.StringVar(value="2026")
        self.report_year_entry = ttk.Entry(controls, textvariable=self.report_year_var, width=7)
        self.report_year_entry.pack(side="left", padx=(6, 12))

        ttk.Label(controls, text="Khu vực").pack(side="left")
        self.report_area_var = tk.StringVar(value="Tổng hợp")
        self.report_area_combo = ttk.Combobox(
            controls,
            textvariable=self.report_area_var,
            values=("Tổng hợp",) + AREAS,
            state="readonly",
            width=16,
        )
        self.report_area_combo.pack(side="left", padx=(6, 12))
        self.report_area_combo.bind("<<ComboboxSelected>>", lambda _event: self.refresh_report())

        ttk.Button(controls, text="Xem", command=self.refresh_report).pack(side="left")
        ttk.Button(controls, text="Xuất Excel", command=self.export_report_excel).pack(
            side="right", padx=4
        )
        ttk.Button(controls, text="In biểu", command=self.print_report).pack(
            side="right", padx=4
        )

        form_picker = ttk.Frame(parent)
        form_picker.pack(fill="x", pady=(4, 6))
        self.report_form_var = tk.StringVar(value="11-T")
        self.report_form_buttons = {}
        for index, (code, _title) in enumerate(REPORTS):
            button = ttk.Button(
                form_picker,
                text=code,
                command=lambda selected=code: self.select_report(selected),
            )
            button.grid(row=index // 7, column=index % 7, padx=3, pady=3, sticky="ew")
            self.report_form_buttons[code] = button
            form_picker.columnconfigure(index % 7, weight=1)

        self.report_title = ttk.Label(
            parent,
            text="",
            font=("Segoe UI", 15, "bold"),
            anchor="center",
            justify="center",
        )
        self.report_title.pack(fill="x", pady=(6, 3))
        self.report_group_header = ttk.Label(
            parent,
            text="",
            anchor="center",
            foreground="#075985",
        )
        self.report_group_header.pack(fill="x", pady=(0, 4))

        report_frame = ttk.Frame(parent)
        report_frame.pack(fill="both", expand=True)
        self.report_tree = ttk.Treeview(report_frame, show="headings")
        self.report_tree.pack(side="top", fill="both", expand=True)
        report_scroll_y = ttk.Scrollbar(
            report_frame, orient="vertical", command=self.report_tree.yview
        )
        report_scroll_y.place(relx=1.0, rely=0, relheight=1.0, anchor="ne")
        report_scroll_x = ttk.Scrollbar(
            parent, orient="horizontal", command=self.report_tree.xview
        )
        report_scroll_x.pack(fill="x")
        self.report_tree.configure(
            yscrollcommand=report_scroll_y.set,
            xscrollcommand=report_scroll_x.set,
        )

        self.report_status = ttk.Label(parent, text="")
        self.report_status.pack(fill="x", pady=(6, 0))
        self.current_report_rows = []
        self.current_report_columns = []
        self.refresh_report()

    def refresh_periods(self):
        periods = self.database.periods()
        values = ("",) + tuple(periods)
        self.period_combo.configure(values=values)
        if hasattr(self, "report_month_combo"):
            self.report_month_combo.configure(values=periods)
            if periods and self.report_month_var.get() not in periods:
                self.report_month_var.set(periods[-1])
            if periods:
                self.report_year_var.set(periods[-1][:4])
        if not periods:
            self.period_var.set("")
        elif not self.period_var.get():
            self.period_var.set(periods[-1])

    def refresh(self):
        period = self.period_var.get()
        area = self.area_var.get()
        search = self.search_var.get().strip()

        for item in self.tree.get_children():
            self.tree.delete(item)
        totals = self.database.totals(period, area, search)
        for key, label in self.summary_labels.items():
            value = totals.get(key, 0)
            if key == "vessel_count":
                label.configure(text=f"{int(value):,}".replace(",", "."))
            else:
                label.configure(text=f"{float(value):,.2f}".replace(",", "X").replace(".", ",").replace("X", "."))

        rows = self.database.search(period, area, search)
        for row in rows:
            values = tuple(row.get(column) if row.get(column) is not None else "" for column in self.tree["columns"])
            self.tree.insert("", "end", iid=str(row["id"]), values=values)

        area_counts = self.database.counts_by_area(period)
        area_text = " | ".join(f"{name}: {count}" for name, count in area_counts.items())
        self.status.configure(
            text=f"Cơ sở dữ liệu: {DATABASE_PATH.name} — "
                 f"{len(rows)} dòng hiển thị — {area_text}"
        )

    def refresh_report(self):
        try:
            year = int(self.report_year_var.get())
        except ValueError:
            messagebox.showerror("Năm không hợp lệ", "Hãy nhập năm dạng 2026.")
            return
        period_type = self.report_type_var.get()
        selected_area = self.report_area_var.get()
        report_code = self.report_form_var.get()
        month_key = self.report_month_var.get()
        if period_type == "tháng" and month_key:
            year = int(month_key[:4])

        payloads = self.database.report_payloads(
            period_month=month_key,
            year=year,
            period_type=period_type,
            area=selected_area,
        )
        if period_type == "tháng" and month_key:
            cumulative_payloads = self.database.report_payloads(
                period_month=month_key,
                year=year,
                period_type="lũy kế",
                area=selected_area,
            )
            before_payloads = self.database.report_payloads(
                period_month=month_key,
                year=year,
                period_type="trước kỳ",
                area=selected_area,
            )
            previous_month = f"{year - 1}-{month_key[5:]}"
            previous_payloads = self.database.report_payloads(
                period_month=previous_month,
                year=year - 1,
                period_type="tháng",
                area=selected_area,
            )
            previous_cumulative_payloads = self.database.report_payloads(
                period_month=previous_month,
                year=year - 1,
                period_type="lũy kế",
                area=selected_area,
            )
        else:
            cumulative_payloads = payloads
            before_payloads = []
            previous_payloads = []
            previous_cumulative_payloads = []
        columns, rows = build_form_rows(
            report_code,
            payloads,
            cumulative_payloads,
            before_payloads,
            previous_payloads,
            previous_cumulative_payloads,
        )
        if report_code == "Tổng cộng" and selected_area != "Tổng hợp":
            rows = [row for row in rows if row.get("Khu vực") == selected_area]
        self.current_report_columns = columns
        self.current_report_rows = rows

        tree_columns = [f"c{index}" for index in range(len(columns))]
        self.report_tree.configure(columns=tree_columns, show="headings")
        for column_id, (heading, _field) in zip(tree_columns, columns):
            self.report_tree.heading(column_id, text=heading)
            width = max(100, min(260, len(heading) * 9))
            self.report_tree.column(column_id, width=width, minwidth=80, stretch=True)
        for item in self.report_tree.get_children():
            self.report_tree.delete(item)
        for index, row in enumerate(rows):
            values = []
            for heading, field in columns:
                value = row.get(field)
                if isinstance(value, float):
                    value = f"{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
                elif value is None or value == "":
                    value = "-"
                values.append(value)
            tag = ("total",) if str(row.get("label", "")).startswith("TỔNG") or row.get("Khu vực") == "TỔNG CỘNG" else ()
            self.report_tree.insert("", "end", iid=f"report-{index}", values=values, tags=tag)
        self.report_tree.tag_configure("total", font=("Segoe UI", 9, "bold"))

        title = next((title for code, title in REPORTS if code == report_code), report_code)
        period_label = (
            month_key.replace("-", "/")
            if period_type == "tháng" and month_key
            else f"{period_type} năm {year}"
        )
        self.report_title.configure(
            text=f"BIỂU SỐ {report_code} — {title}\n{period_label} — {selected_area}"
        )
        if report_code in ("11-T", "11B-T"):
            self.report_group_header.configure(
                text="Thông tin phương tiện | Hàng hóa theo nhóm nghiệp vụ | Hành khách | Hành trình"
            )
        elif report_code in ("03-T", "15-T"):
            self.report_group_header.configure(
                text="Container | Hàng khô | Hàng lỏng | Quá cảnh | Lượt tàu"
            )
        else:
            self.report_group_header.configure(
                text="Các số liệu kế hoạch, cùng kỳ năm trước hoặc không có trong dữ liệu tàu hiển thị bằng dấu —"
            )

        periods = self.database.periods()
        if period_type == "tháng":
            data_periods = [month_key] if month_key in periods else []
        else:
            data_periods = [
                key for key in periods
                if key.startswith(f"{year}-")
            ]
        if period_type == "6 tháng đầu":
            expected = [f"{year}-{month:02d}" for month in range(1, 7)]
        elif period_type == "6 tháng cuối":
            expected = [f"{year}-{month:02d}" for month in range(7, 13)]
        elif period_type.startswith("Quý"):
            quarter = int(period_type[-1])
            expected = [
                f"{year}-{month:02d}"
                for month in range((quarter - 1) * 3 + 1, quarter * 3 + 1)
            ]
        elif period_type == "tháng":
            expected = [month_key] if month_key else []
        else:
            expected = [f"{year}-{month:02d}" for month in range(1, 13)]
        missing = [key for key in expected if key not in data_periods]
        self.report_status.configure(
            text=f"{len(payloads)} lượt tàu | Có dữ liệu: "
                 f"{', '.join(data_periods) if data_periods else 'chưa có'}"
                 f" | Thiếu kỳ: {', '.join(missing) if missing else 'không'}"
        )

    def select_report(self, code: str):
        self.report_form_var.set(code)
        self.refresh_report()

    def export_report_excel(self):
        if Workbook is None:
            messagebox.showerror(
                "Thiếu thư viện",
                "Chạy: pip install -r python-app\\requirements.txt",
            )
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".xlsx",
            filetypes=(("Excel", "*.xlsx"),),
        )
        if not path:
            return
        self._write_report_excel(path)
        messagebox.showinfo(
            "Đã xuất",
            f"Đã lưu biểu {self.report_form_var.get()} ({len(self.current_report_rows)} dòng):\n{path}",
        )

    def print_report(self):
        if Workbook is None:
            messagebox.showerror(
                "Thiếu thư viện",
                "Chạy: pip install -r python-app\\requirements.txt",
            )
            return
        path = filedialog.asksaveasfilename(
            title="Lưu file Excel trước khi in",
            defaultextension=".xlsx",
            filetypes=(("Excel", "*.xlsx"),),
        )
        if not path:
            return
        try:
            self._write_report_excel(path)
            os.startfile(path, "print")
        except OSError as error:
            messagebox.showerror(
                "Không mở được lệnh in",
                f"File đã lưu tại:\n{path}\n\n{error}",
            )

    def _write_report_excel(self, path: str):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = self.report_form_var.get()[:31]
        sheet.append([self.report_title.cget("text")])
        sheet.append([heading for heading, _field in self.current_report_columns])
        for row in self.current_report_rows:
            sheet.append([
                row.get(field) if row.get(field) not in (None, "") else None
                for _heading, field in self.current_report_columns
            ])
        sheet.freeze_panes = "A3"
        sheet.auto_filter.ref = sheet.dimensions
        sheet.page_setup.orientation = "landscape"
        sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 0
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.print_title_rows = "1:2"
        sheet.print_area = sheet.calculate_dimension()
        for column_cells in sheet.columns:
            width = min(
                40,
                max(
                    12,
                    max(len(str(cell.value or "")) for cell in column_cells) + 2,
                ),
            )
            sheet.column_dimensions[column_cells[0].column_letter].width = width
        workbook.save(path)

    def _open_vessel_dialog(self, title: str, vessel_db_id: int | None = None):
        payload = self.database.payload(vessel_db_id) if vessel_db_id else {}
        period = payload.get("periodMonth") or payload.get("monthKey") or self.period_var.get()
        if period not in self.database.periods():
            period = self.period_var.get()

        dialog = tk.Toplevel(self)
        dialog.title(title)
        dialog.transient(self)
        dialog.grab_set()
        dialog.resizable(False, False)

        fields = (
            ("month", "Kỳ (YYYY-MM)", period),
            ("khuVuc", "Khu vực", payload.get("khuVuc", self.area_var.get() if self.area_var.get() != "Tổng hợp" else "Cửa Việt")),
            ("shipName", "Tên tàu", payload.get("shipName", "")),
            ("callSign", "Hô hiệu", payload.get("callSign", "")),
            ("imo", "IMO", payload.get("imo", "")),
            ("flag", "Quốc tịch", payload.get("flag", "")),
            ("vesselClass", "Loại tàu", payload.get("vesselClass", "")),
            ("shipType", "Kiểu tàu", payload.get("shipType", "")),
            ("dateIn", "Ngày đến", payload.get("dateIn", "")),
            ("dateOut", "Ngày rời", payload.get("dateOut", "")),
            ("port", "Cảng", payload.get("port", "")),
            ("portArea", "Cảng làm hàng", payload.get("portArea", "")),
            ("grt", "GRT", payload.get("grt", "")),
            ("dwt", "DWT", payload.get("dwt", "")),
            ("length", "Chiều dài", payload.get("length", "")),
            ("draft", "Mớn nước", payload.get("draft", "")),
            ("cargoAmount", "Hàng tổng", payload.get("cargoAmount", "")),
            ("cargoAmountIn", "Hàng đến (tấn)", payload.get("cargoAmountIn", "")),
            ("cargoAmountOut", "Hàng rời (tấn)", payload.get("cargoAmountOut", "")),
            ("agent", "Đại lý", payload.get("agent", "")),
        )
        entries = {}
        for index, (key, label, value) in enumerate(fields):
            row = index // 2
            column = (index % 2) * 2
            ttk.Label(dialog, text=label).grid(
                row=row, column=column, padx=8, pady=5, sticky="e"
            )
            if key == "khuVuc":
                widget = ttk.Combobox(
                    dialog,
                    values=AREAS,
                    state="readonly",
                    width=24,
                )
                widget.set(str(value))
            else:
                widget = ttk.Entry(dialog, width=27)
                widget.insert(0, "" if value is None else str(value))
            widget.grid(
                row=row, column=column + 1, padx=8, pady=5, sticky="w"
            )
            entries[key] = widget

        def save():
            vessel = {}
            for key, widget in entries.items():
                text = widget.get().strip()
                if key in (
                    "grt", "dwt", "length", "draft", "cargoAmount",
                    "cargoAmountIn", "cargoAmountOut",
                ):
                    if text:
                        try:
                            vessel[key] = float(text.replace(",", "."))
                        except ValueError:
                            messagebox.showerror("Số liệu không hợp lệ", f"{key}: {text}")
                            return
                    else:
                        vessel[key] = None
                elif key == "month":
                    continue
                else:
                    vessel[key] = text
            vessel["id"] = payload.get("id")
            month_key = entries["month"].get().strip()
            try:
                if vessel_db_id:
                    self.database.update_vessel(vessel_db_id, month_key, vessel)
                else:
                    self.database.add_vessel(month_key, vessel)
                dialog.destroy()
                self.period_var.set(month_key)
                self.refresh_periods()
                self.refresh()
            except Exception as error:
                messagebox.showerror("Không lưu được tàu", str(error))

        buttons = ttk.Frame(dialog)
        buttons.grid(row=(len(fields) + 1) // 2 + 1, column=0, columnspan=4, pady=10)
        ttk.Button(buttons, text="Lưu", command=save).pack(side="left", padx=6)
        ttk.Button(buttons, text="Hủy", command=dialog.destroy).pack(
            side="left", padx=6
        )

    def add_vessel_dialog(self):
        if not self.period_var.get():
            messagebox.showwarning("Thiếu kỳ", "Hãy tạo hoặc chọn một kỳ báo cáo.")
            return
        self._open_vessel_dialog("Thêm tàu")

    def edit_vessel_dialog(self):
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("Chưa chọn tàu", "Hãy chọn một tàu trong danh sách.")
            return
        self._open_vessel_dialog("Sửa tàu", int(selection[0]))

    def delete_vessel_dialog(self):
        selection = self.tree.selection()
        if not selection:
            messagebox.showwarning("Chưa chọn tàu", "Hãy chọn một tàu trong danh sách.")
            return
        if not messagebox.askyesno("Xóa tàu", "Bạn có chắc muốn xóa lượt tàu này?"):
            return
        self.database.delete_vessel(int(selection[0]))
        self.refresh()

    def import_real_backup(self):
        default_backup = PROJECT_DIR / "database-backup.json"
        path = filedialog.askopenfilename(
            title="Chọn file backup dữ liệu thật",
            initialdir=str(PROJECT_DIR),
            filetypes=(("MongoDB backup JSON", "*.json"), ("Tất cả", "*.*")),
        )
        if not path:
            return
        try:
            result = self.database.replace_from_backup(Path(path))
            self.refresh_periods()
            self.refresh()
            messagebox.showinfo(
                "Đã nạp dữ liệu",
                f"Đã nạp: {result['inserted']} lượt\n"
                f"Kỳ: {result['periodCount']}\n"
                f"Bỏ qua: {result['skipped']}",
            )
        except Exception as error:
            messagebox.showerror("Không nạp được dữ liệu", str(error))

    def export(self, kind: str):
        period = self.period_var.get()
        area = self.area_var.get()
        search = self.search_var.get().strip()
        rows = list(self.database.export_rows(period, area, search))
        if not rows:
            messagebox.showwarning("Không có dữ liệu", "Không có dòng nào phù hợp bộ lọc.")
            return

        if kind == "csv":
            path = filedialog.asksaveasfilename(
                defaultextension=".csv",
                filetypes=(("CSV", "*.csv"),),
            )
            if not path:
                return
            with open(path, "w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
                writer.writeheader()
                writer.writerows(rows)
        else:
            if Workbook is None:
                messagebox.showerror(
                    "Thiếu thư viện",
                    "Chạy: pip install -r python-app\\requirements.txt",
                )
                return
            path = filedialog.asksaveasfilename(
                defaultextension=".xlsx",
                filetypes=(("Excel", "*.xlsx"),),
            )
            if not path:
                return
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Thống kê"
            sheet.append(list(rows[0].keys()))
            for row in rows:
                sheet.append(list(row.values()))
            workbook.save(path)

        messagebox.showinfo("Đã xuất", f"Đã lưu {len(rows)} dòng:\n{path}")

    def close(self):
        self.database.close()
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
