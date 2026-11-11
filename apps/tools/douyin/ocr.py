# -*- coding: utf-8 -*-
"""对目录内图片做 OCR，输出 JSON 行；供 Node 端解析画面字幕/文字。"""
import sys
import json
import os


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: ocr.py <dir>"}))
        return
    d = sys.argv[1]
    files = sorted(
        [os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))]
    )
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:  # noqa
        print(json.dumps({"ok": False, "error": f"rapidocr 不可用: {e}"}))
        return
    engine = RapidOCR()
    out = []
    for p in files:
        try:
            result, _ = engine(p)
            texts = []
            for item in result or []:
                if len(item) >= 3:
                    t = str(item[1] or '').strip()
                    score = float(item[2] or 0)
                    if t and score >= 0.55:
                        texts.append(t)
            out.append({"file": os.path.basename(p), "texts": texts})
        except Exception as e:  # noqa
            out.append({"file": os.path.basename(p), "error": str(e)[:120]})
    print(json.dumps({"ok": True, "frames": out}, ensure_ascii=False))


if __name__ == '__main__':
    main()
