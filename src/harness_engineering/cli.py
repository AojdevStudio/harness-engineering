from __future__ import annotations

import argparse
import logging
from pathlib import Path

from harness_engineering.service import SymphonyService
from harness_engineering.workflow import select_workflow_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Symphony harness service.")
    parser.add_argument("workflow", nargs="?", help="Path to WORKFLOW.md. Defaults to ./WORKFLOW.md.")
    parser.add_argument("--port", type=int, default=None, help="Enable the HTTP status extension on this port.")
    parser.add_argument("--once", action="store_true", help="Run startup and one poll tick, then exit.")
    parser.add_argument("--log-level", default="INFO", help="Python logging level.")
    args = parser.parse_args(argv)

    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.INFO), format="%(asctime)s %(levelname)s %(message)s")
    workflow_path = select_workflow_path(args.workflow, cwd=Path.cwd())
    service = SymphonyService(workflow_path, port_override=args.port)
    try:
        service.start()
        if args.once:
            service.tick()
            return 0
        service.run_forever()
        return 0
    except Exception as exc:
        logging.error("startup failed reason=%s", exc)
        return 1
