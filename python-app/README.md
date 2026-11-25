# Ứng dụng thống kê tàu bằng Python

Ứng dụng desktop dùng Tkinter và SQLite. Dữ liệu thật có thể nạp từ `database-backup.json` (407 lượt thuộc 3 kỳ trong bản backup hiện tại).

## Chạy

```powershell
cd "E:\code\thong ke"
py -m pip install -r python-app\requirements.txt
py python-app\app.py
```

## Dữ liệu và lưu trữ

- Cơ sở dữ liệu local: `python-app\thong_ke_tau.db`
- Nạp dữ liệu: bấm **Nạp dữ liệu thật**, chọn `database-backup.json`.
- Lần chạy đầu tiên sẽ tự nạp `database-backup.json` nếu cơ sở dữ liệu SQLite chưa có dữ liệu.
- Nạp lại an toàn sẽ thay thế dữ liệu local, không sửa MongoDB hoặc MySQL.
- Có thể lọc theo kỳ, khu vực và tìm tên tàu/hô hiệu/IMO/cảng.
- Xuất CSV không cần thư viện ngoài; xuất Excel cần `openpyxl`.
- Tab **BIỂU BÁO CÁO THỐNG KÊ** có nút chọn biểu 11-T, 11B-T, 12-T, 12B-T, 13-T, 14-T, 15-T, 01-T, 02-T, 03-T, 04-Q, Tổng cộng và Báo cáo.
- Các biểu chi tiết tách tàu biển/PTTNĐ; biểu 03-T/15-T có bộ cột hàng hóa theo cảng riêng. Bộ lọc kỳ hỗ trợ tháng, nửa năm, năm và quý; tab báo cáo có lọc khu vực, xuất Excel và mở lệnh in từ file Excel theo đúng biểu/kỳ đang xem.
- Báo cáo tháng tách số thực hiện, lũy kế từ đầu năm và phần trước kỳ; bố cục in Excel đặt A4 ngang, lặp tiêu đề và co vừa chiều ngang trang.
- Chỉ tiêu không thể xác định từ dữ liệu tàu (ví dụ kế hoạch năm/cùng kỳ năm trước) để trống bằng dấu “-”, không lấy nhầm số tĩnh từ biểu mẫu Excel cũ.

Các bảng chỉ tiêu hiện tính từ dữ liệu tàu đã lưu; cần nhập thêm kế hoạch năm và số liệu lịch sử nếu muốn báo cáo so sánh đầy đủ.
