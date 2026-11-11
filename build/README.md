# Build PaddleOCR bundle

Thư mục `lib/paddle/` được tạo từ `paddle-entry.mjs`. Chỉ cần build lại khi muốn nâng cấp thư viện.

Chạy trong một thư mục tạm (không cần `node_modules` trong dự án):

```bash
npm i ppu-paddle-ocr onnxruntime-web esbuild
cp "<dự án>/build/paddle-entry.mjs" . && npx esbuild paddle-entry.mjs --bundle --format=esm --minify \
  --alias:onnxruntime-web=onnxruntime-web/wasm \
  --outfile="<dự án>/lib/paddle/paddle.bundle.mjs"
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{mjs,wasm} "<dự án>/lib/paddle/"
```

Mô hình (PP-OCRv5 English, giấy phép Apache-2.0) đặt trong `lib/paddle/models/`:

- `PP-OCRv5_mobile_det_infer.ort` (tìm vùng chữ)
- `en_PP-OCRv5_mobile_rec_infer.ort` (đọc chữ tiếng Anh)
- `ppocrv5_en_dict.txt` (bảng ký tự)

Nguồn: https://huggingface.co/snowfluke/ppu-paddle-ocr-models
(thư viện `ppu-paddle-ocr` giấy phép MIT, `onnxruntime-web` giấy phép MIT).
