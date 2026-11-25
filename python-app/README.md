# Ứng dụng thống kê tàu bằng Python

Ứng dụng desktop Tkinter có thể kết nối nhiều máy tới một API online riêng. API dùng MongoDB Atlas database `maritime_statistics_python`, tách biệt với dữ liệu của web app. EXE chỉ cần địa chỉ API và tài khoản API; không chứa URI hay mật khẩu MongoDB.

## Triển khai API online

1. Đồng bộ Blueprint trên Render từ `render.yaml`; blueprint sẽ thêm dịch vụ `maritime-vessel-statistics-python-api`.
2. Trong Environment của dịch vụ Python, đặt:
   - `MONGODB_URI`: connection string Atlas. Đây là secret, chỉ nhập trên Render.
   - `API_AUTH_USERNAME` và `API_AUTH_PASSWORD`: tài khoản riêng để đăng nhập vào ứng dụng.
   - `MONGODB_DB` được blueprint đặt là `maritime_statistics_python`.
3. Trong Atlas Database Access, cấp cho user MongoDB quyền đọc/ghi database `maritime_statistics_python`; trong Network Access, cho phép kết nối từ các địa chỉ outbound IP mà Render hiển thị. Không dùng `0.0.0.0/0` nếu có thể giới hạn địa chỉ.
4. Chờ dịch vụ triển khai thành công và ghi lại URL HTTPS của dịch vụ, ví dụ `https://ten-dich-vu.onrender.com`.

API và database online này là riêng với web app, nhưng có thể dùng cùng Atlas cluster. Mỗi dịch vụ Render có bộ biến môi trường riêng. Không gửi URI Atlas cho người dùng EXE.

## Tạo EXE trên Windows

Cài Python 3.14, mở PowerShell tại thư mục dự án rồi chạy:

```powershell
py -3.14 -m venv .venv-python
.\.venv-python\Scripts\python.exe -m pip install -r python-app\requirements.txt
.\.venv-python\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --windowed --name ThongKeTauOnline --paths python-app --distpath python-app\release-final --specpath python-app python-app\app.py
```

File EXE được tạo tại `python-app\release-final\ThongKeTauOnline.exe`. Có thể gửi file này cho các máy Windows khác; các máy cần Internet nhưng không cần cài Python.

## Kết nối và nạp dữ liệu

1. Để dùng online, mở EXE và nhập URL HTTPS của API Render cùng username/password API. Thông tin đăng nhập chỉ dùng trong phiên chạy, không được lưu vào file EXE. Chọn **Dùng SQLite local** nếu chỉ muốn dùng dữ liệu trên máy đó.
2. Trên một máy, chọn **Nạp lên server** và chọn file backup JSON. Dữ liệu được nhập theo kiểu thêm/cập nhật, không xóa dữ liệu đang có.
3. Các máy khác đăng nhập cùng API để xem và sửa chung dữ liệu online. Không cần nạp cùng backup ở từng máy.

Đây là database mới tách biệt, nên cần nạp dữ liệu khởi tạo một lần. Chỉ tải file backup lên khi bạn chủ động chọn file trong ứng dụng.

## Chạy kiểm thử và API local

```powershell
py -m pip install -r python-app\requirements-api.txt
py -m unittest discover -s python-app -p "test_*.py"
```

Để chạy API local, đặt `MONGODB_URI`, `MONGODB_DB`, `API_AUTH_USERNAME`, `API_AUTH_PASSWORD`, sau đó:

```powershell
cd python-app
py -m uvicorn online_api:app --host 127.0.0.1 --port 8000
```

Render bản miễn phí có thể ngủ khi không hoạt động; lần kết nối đầu tiên sau đó có thể mất thêm thời gian để khởi động.

## Chức năng báo cáo

- Lọc theo kỳ, khu vực và tìm tên tàu/hô hiệu/IMO/cảng.
- Thêm, sửa, xóa lượt tàu; xuất CSV và Excel.
- Tab **BIỂU BÁO CÁO THỐNG KÊ** có các biểu 11-T, 11B-T, 12-T, 12B-T, 13-T, 14-T, 15-T, 01-T, 02-T, 03-T, 04-Q, Tổng cộng và Báo cáo.
- Các biểu chi tiết tách tàu biển/PTTNĐ; biểu 03-T/15-T có bộ cột hàng hóa theo cảng riêng.
- Báo cáo tháng tách số thực hiện, lũy kế từ đầu năm và phần trước kỳ; bố cục Excel in A4 ngang, lặp tiêu đề và co vừa chiều ngang trang.
- Chỉ tiêu không có trong dữ liệu tàu (ví dụ kế hoạch năm/cùng kỳ năm trước) hiển thị dấu “—”.
