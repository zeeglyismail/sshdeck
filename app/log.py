import logging
import sys


def setup():
    """App-wide logging to stdout so `docker logs sshdeck` shows everything."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S"))
    root = logging.getLogger()
    if not root.handlers:
        root.addHandler(handler)
    root.setLevel(logging.INFO)
    logging.getLogger("asyncssh").setLevel(logging.WARNING)


def get(name: str) -> logging.Logger:
    return logging.getLogger(f"sshdeck.{name}")
