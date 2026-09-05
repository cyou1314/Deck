from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from videowipe import WipeEngine, WipeRequest


def emit(kind: str, payload: dict) -> None:
    print("DECK_EVENT:" + json.dumps({"kind": kind, **payload}, ensure_ascii=False), flush=True)


def progress(event) -> None:
    emit("progress", event.to_dict())


def preview(args) -> None:
    output_dir = Path(args.work_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    with WipeEngine(task="clean", model="sttn", detect_mode=args.detect_mode, ocr="auto") as engine:
        plan = engine.plan(
            WipeRequest(
                video=args.input,
                output_dir=str(output_dir),
                targets=[args.target],
                regions=[args.region] if args.region else [],
                detect_mode=args.detect_mode,
                ocr="auto",
            ),
            on_progress=progress,
        )
    plan_path = output_dir / "wipe_plan.json"
    tracks = [track.to_dict() for track in plan.tracks]
    emit("result", {
        "planPath": str(plan_path),
        "previewPath": str(output_dir / "clean_preview.jpg"),
        "tracks": tracks,
        "removeCount": sum(track["action"] == "remove" for track in tracks),
    })


def run(args) -> None:
    output_dir = Path(args.work_dir) / "result"
    output_dir.mkdir(parents=True, exist_ok=True)
    with WipeEngine(task="clean", model="sttn") as engine:
        result = engine.run(
            WipeRequest(video=args.input, output_dir=str(output_dir), plan=args.plan),
            on_progress=progress,
        )
    produced = Path(result.output_path)
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if produced.resolve() != destination.resolve():
        os.replace(str(produced), str(destination))
    payload = result.to_dict()
    payload["output_path"] = str(destination)
    emit("result", payload)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    preview_parser = sub.add_parser("preview")
    preview_parser.add_argument("--input", required=True)
    preview_parser.add_argument("--work-dir", required=True)
    preview_parser.add_argument("--target", choices=["subtitle", "watermark", "logo"], default="subtitle")
    preview_parser.add_argument("--region", default="")
    preview_parser.add_argument("--detect-mode", choices=["fast", "balanced", "sensitive"], default="balanced")
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--input", required=True)
    run_parser.add_argument("--plan", required=True)
    run_parser.add_argument("--work-dir", required=True)
    run_parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "preview":
        preview(args)
    else:
        run(args)


if __name__ == "__main__":
    main()
