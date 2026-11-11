# Dịch Truyện Song Ngữ (Free)

Tiện ích Chrome (Manifest V3) tự động dịch truyện **chữ** và **tranh** tiếng Anh sang tiếng Việt. **Miễn phí 100%**: không API key, không server.

## Tính năng
- **Truyện chữ:** hiện bản dịch ngay dưới mỗi đoạn (song ngữ) hoặc chỉ tiếng Việt.
- **Truyện tranh (manga/manhwa/webtoon):** đọc chữ trong bong bóng thoại bằng PaddleOCR (chạy ngay trong trình duyệt) rồi chèn bản dịch lên ảnh.
- **Thủ công:** giữ `Alt` + kéo chuột để dịch một vùng bất kỳ. Bấm vào bản dịch để xem ảnh gốc.
- Có glossary cho thuật ngữ tu tiên/võ hiệp, cache bản dịch (tối đa 6000 câu), giãn cách request để tránh bị chặn.

## Cài đặt
1. Tải repo về (`Code` → `Download ZIP`) và giải nén.
2. Mở `chrome://extensions`, bật **Developer mode**.
3. Bấm **Load unpacked** và chọn thư mục vừa giải nén.

## Công nghệ
- Dịch: endpoint `translate.googleapis.com` (gtx, không chính thức, có thể thay đổi).
- OCR: PP-OCRv5 English + ONNX Runtime Web, đóng gói sẵn trong `lib/paddle/` (xem [build/README.md](build/README.md)).

## Quyền riêng tư
Văn bản cần dịch được gửi tới Google Translate. Ảnh truyện chỉ được xử lý cục bộ. Quyền `cookies` là tuỳ chọn, chỉ dùng khi bạn bật trong popup để tải ảnh từ site chặn hotlink.

## Giấy phép
MIT. Mô hình PP-OCRv5 (Apache-2.0), `ppu-paddle-ocr` và `onnxruntime-web` (MIT).
