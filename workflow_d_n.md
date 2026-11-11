# WORKFLOW DỰ ÁN: CHROME EXTENSION TỰ ĐỘNG DỊCH TRUYỆN ANH - VIỆT (MIỄN PHÍ 100%)

---

## 🎯 I. TỔNG QUAN & MỤC TIÊU DỰ ÁN
* **Mục tiêu:** Xây dựng tiện ích mở rộng (Chrome Extension) tự động nhận diện nội dung tiếng Anh trên các trang web đọc truyện (**Truyện chữ / Web Novel** và **Truyện tranh / Manga / Comic**) và hiển thị bản dịch tiếng Việt dưới dạng **phụ đề song ngữ** (giống phụ đề phim ảnh).
* **Cam kết kỹ thuật:** 
  * Hoàn toàn **miễn phí 100%**.
  * Không sử dụng bất kỳ dịch vụ trả phí nào (Không cần đăng ký API Key trả phí của Google/DeepL, không tốn chi phí thuê máy chủ/server).

---

## 🛠️ II. STACK CÔNG NGHỆ SỬ DỤNG
| Thành phần | Công nghệ / Dịch vụ sử dụng | Mô tả chi tiết |
| :--- | :--- | :--- |
| **Nền tảng Extension** | Chrome Manifest V3 | Tiêu chuẩn phát triển tiện ích mở rộng mới nhất trên Google Chrome và Microsoft Edge. |
| **Dịch thuật (Translation)** | Google Translate Endpoint (Free) | Sử dụng endpoint miễn phí: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=...` |
| **Nhận diện chữ trên ảnh (OCR)** | PaddleOCR (PP-OCRv5 English, chạy bằng ONNX Runtime Web) | Mã nguồn mở, chạy 100% trong trình duyệt (đóng gói sẵn trong `lib/paddle/`) để đọc chữ từ khung thoại truyện tranh. |
| **Bộ nhớ đệm & Cài đặt** | `chrome.storage.local` | Lưu trữ cấu hình bật/tắt và cache lại các đoạn văn bản đã dịch để không bị tốn request lần 2. |
| **Giao diện & Hiển thị** | HTML5 / CSS3 / JavaScript | DOM Injection trực tiếp vào trang web, chèn phụ đề dưới dòng gốc hoặc đè lên bong bóng thoại. |

---

## 🔄 III. LUỒNG THỰC THI CHI TIẾT (WORKFLOW STEPS)

```
[ Người dùng mở trang web đọc truyện ]
                 │
                 ▼
      [ Bước 1: Khởi tạo & Cấu hình ]
      ─ Nạp cấu hình từ chrome.storage.local (Bật/Tắt, Chế độ)
                 │
                 ▼
      [ Bước 2: Bắt sự kiện & Trích xuất Dữ liệu ]
      ├── (Nhánh A: Truyện chữ) ──► IntersectionObserver quét thẻ <p>
      └── (Nhánh B: Truyện tranh) ─► Quét ô thoại / Bong bóng thoại
                 │
                 ▼
      [ Bước 3: Dịch thuật & Bộ nhớ đệm (Cache) ]
      ├── 1. Kiểm tra Cache trong chrome.storage.local
      ├── 2. Nối dòng văn bản (Nếu là Manga ──► Chạy PaddleOCR)
      ├── 3. Gọi Google Translate API (Free endpoint)
      └── 4. Lưu kết quả mới vào Cache
                 │
                 ▼
      [ Bước 4: Hiển thị Phụ đề (DOM Rendering) ]
      ─ Tạo element <div class="free-translator-sub">
      ─ Áp dụng style phụ đề (nền trong suốt, màu xanh nổi bật)
                 │
                 ▼
      [ Bước 5: Kiểm soát Trải nghiệm & Chống nghẽn mạng ]
      ─ Throttling / Giãn cách request (200-500ms) để không bị chặn IP
```

---

### Bước 1: Khởi tạo và Cấu hình (Initialization)
1. **Khởi tạo file hệ thống:**
   * `manifest.json`: Đăng ký quyền hạn (`activeTab`, `storage`) và chỉ định script chạy tự động (`content.js`, `styles.css`).
   * `popup.html` / `popup.js`: Giao diện menu thu gọn khi người dùng click vào icon extension.
2. **Nạp trạng thái:** Đọc cấu hình cá nhân từ `chrome.storage.local` (Xác định extension đang bật hay tắt, dùng chế độ song ngữ hay chỉ hiện tiếng Việt).

---

### Bước 2: Bắt sự kiện & Trích xuất dữ liệu (Data Extraction)
Hệ thống tự động phân loại loại truyện đang đọc để xử lý:
* **Nhánh A (Truyện chữ - Web Novel):**
  * Sử dụng **`IntersectionObserver`** theo dõi màn hình cuộn. Chỉ bóc tách các đoạn văn (`<p>`, `.chapter-content p`) thực sự nằm trong tầm mắt người dùng (Viewport).
  * Loại bỏ các đoạn quá ngắn (dưới 5 ký tự) hoặc các thẻ đã được gắn trạng thái xử lý (`dataset.translatedStatus`).
* **Nhánh B (Truyện tranh - Manga/Comic):**
  * Quét các khung ảnh chứa trang truyện (`<img>`).
  * Cắt (crop) vùng chứa khung thoại dựa trên thao tác rê chuột hoặc chọn tự động.

---

### Bước 3: Xử lý Dịch thuật & Bộ nhớ đệm (Translation & Caching)
Đảm bảo tối ưu tốc độ và không bị nghẽn mạng (Rate-limit):
1. **Kiểm tra Cache Cục bộ:** Tra cứu câu tiếng Anh gốc trong bộ nhớ `chrome.storage.local`. Nếu đã từng dịch, lập tức lấy kết quả ra dùng mà không cần gọi API (tiết kiệm 100% thời gian chờ).
2. **Xử lý OCR (Dành cho Truyện tranh):** Đưa ảnh khung thoại qua **PaddleOCR** để đọc thành văn bản tiếng Anh thô.
3. **Gọi API Dịch miễn phí (Nếu chưa có trong Cache):** Gửi chuỗi tiếng Anh qua endpoint Google Translate miễn phí.
4. **Lưu trữ Cache:** Ghi cặp dữ liệu `[Tiếng Anh -> Tiếng Việt]` vào bộ nhớ cục bộ cho lần đọc tiếp theo.

---

### Bước 4: Hiển thị Phụ đề / Ghi đè Giao diện (DOM Rendering)
1. **Tạo thẻ phụ đề:** Sinh ra thẻ HTML tùy chỉnh (ví dụ: `<div class="free-translator-sub">`).
2. **Áp dụng Style dạng Phụ đề:** Sử dụng CSS hiển thị chữ nổi bật trên nền bán trong suốt, bo góc mượt mà.
   * *Đối với truyện chữ:* Chèn ngay bên dưới dòng tiếng Anh gốc (Dạng song ngữ).
   * *Đối với truyện tranh:* Dùng `position: absolute` gắn thẻ đè chuẩn xác lên vị trí ô thoại.
3. **Đánh dấu hoàn tất:** Đổi trạng thái `dataset.translatedStatus = 'completed'` và ngưng theo dõi thẻ đó để giải phóng bộ nhớ.

---

### Bước 5: Kiểm soát Trải nghiệm & Chống nghẽn mạng (Control & Throttling)
1. **Popup Menu Tương tác:** Cho phép người dùng bật/tắt nhanh extension, chuyển đổi qua lại giữa chế độ *Song ngữ* và *Chế độ thay thế (Ẩn tiếng Anh)*.
2. **Cơ chế giãn cách request (Throttling):** Đặt thời gian nghỉ ngơi (delay từ 200ms - 500ms) giữa các lần gửi request dịch liên tiếp, đảm bảo không bị Google tạm khóa IP do gọi request quá dồn dập.