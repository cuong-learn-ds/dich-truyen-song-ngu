// Source of lib/paddle/paddle.bundle.mjs (PaddleOCR for the offscreen document).
// Rebuild: see build/README.md. Only the CPU (WASM) build of ONNX Runtime is used,
// and every file it needs ships inside the extension: nothing is fetched at runtime.
import * as ort from 'onnxruntime-web'; // aliased to onnxruntime-web/wasm at build time
import { PaddleOcrService } from 'ppu-paddle-ocr/web';

export { ort, PaddleOcrService };
