#!/usr/bin/env python3
"""
L3 内网视觉 Agent 服务（sidecar 骨架）

定位：只做「目标定位」——接收现场截图 + 录制参考截图 + 指令，返回归一化坐标与置信度。
执行权始终在 Node 执行器（Playwright）侧；本服务不接触浏览器、不执行动作。

运行（mock 模式，不依赖模型）：
    python3 visual-agent/server.py --host 127.0.0.1 --port 3020

接入真实内网 VLM：
    1. 在 `ground_with_backend()` 里实现 vllm / ollama 分支；
    2. 模型输入：instruction + currentImage + referenceImage + bboxHint；
    3. 模型输出：{"found": bool, "point": {"x": 0..1, "y": 0..1}, "confidence": 0..1}；
    4. 服务只允许监听内网地址，禁止外发截图（合规硬约束）。

协议：
    GET  /health -> {"status": "ok", "backend": "mock", "version": 1}
    POST /ground  request:
        {
          "instruction": "点击搜索按钮",
          "currentImage": "data:image/jpeg;base64,...",      # 必填：现场截图
          "referenceImage": "data:image/jpeg;base64,...",    # 可选：录制时截图
          "viewport": {"width": 1280, "height": 800, "dpr": 2, "scrollX": 0, "scrollY": 0},
          "bboxHint": {"x": 10, "y": 20, "width": 100, "height": 30}  # 可选：录制时的 viewport 坐标
        }
    POST /ground response:
        {"found": true, "point": {"x": 0.42, "y": 0.33}, "confidence": 0.92,
         "reason": "...", "model": "mock", "latencyMs": 3}
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1


def ground_with_backend(backend: str, payload: dict) -> dict:
    """返回 {found, point, confidence, reason, model}；不同后端在此扩展。"""
    instruction = str(payload.get("instruction") or "").strip()
    viewport = payload.get("viewport") or {}
    bbox = payload.get("bboxHint") or {}

    if not payload.get("currentImage"):
        return {"found": False, "confidence": 0.0, "reason": "缺少现场截图", "model": backend}

    if backend == "mock":
        # 骨架实现：用录制 bbox 的中心作为答案，验证端到端链路可用
        if not bbox:
            return {"found": False, "confidence": 0.0, "reason": "mock 需要 bboxHint", "model": "mock"}
        width = float(viewport.get("width") or 0)
        height = float(viewport.get("height") or 0)
        if width <= 0 or height <= 0:
            return {"found": False, "confidence": 0.0, "reason": "viewport 非法", "model": "mock"}
        center_x = float(bbox.get("x", 0)) + float(bbox.get("width", 0)) / 2
        center_y = float(bbox.get("y", 0)) + float(bbox.get("height", 0)) / 2
        return {
            "found": True,
            "point": {"x": max(0.0, min(1.0, center_x / width)), "y": max(0.0, min(1.0, center_y / height))},
            "confidence": 0.92,
            "reason": f"mock：录制 bbox 中心（{instruction[:40]}）",
            "model": "mock",
        }

    # TODO(L3-真实模型)：在 vLLM / Ollama 的 OpenAI 兼容接口上做视觉 grounding。
    # 参考实现要点：
    #   - messages: system(只输出 JSON) + user(text instruction + image_url(currentImage) [+ referenceImage])
    #   - 要求模型返回 {"found", "point": {"x","y"} (0..1 归一化), "confidence"}
    #   - 解析失败 / 越界 → found=false，并记录 reason
    #   - 图片只在本机/内网传递，不写日志正文
    raise NotImplementedError(f"backend={backend} 尚未接入；请实现 ground_with_backend")


class Handler(BaseHTTPRequestHandler):
    server_version = "SRM-VisualAgent/0.1"

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except BrokenPipeError:
            pass

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"status": "ok", "backend": self.server.backend, "version": VERSION})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/ground":
            self._send(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"error": "invalid json"})
            return

        started = time.time()
        try:
            result = ground_with_backend(self.server.backend, payload)
        except NotImplementedError as exc:
            self._send(501, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001 - 骨架服务，错误统一返回
            self._send(500, {"error": f"ground failed: {exc}"})
            return

        result.setdefault("model", self.server.backend)
        result["latencyMs"] = int((time.time() - started) * 1000)
        self._send(200, result)

    def log_message(self, fmt: str, *args) -> None:  # 静默访问日志，避免刷屏
        return


def main() -> None:
    parser = argparse.ArgumentParser(description="SRM L3 内网视觉 Agent（sidecar）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3020)
    parser.add_argument("--backend", default="mock", choices=["mock", "vllm", "ollama"])
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.backend = args.backend
    print(f"visual-agent listening on http://{args.host}:{args.port} backend={args.backend}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
