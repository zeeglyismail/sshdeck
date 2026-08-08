import asyncio
import contextlib
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import log
from .ssh_manager import manager, get_host

logger = log.get("terminal")
router = APIRouter()

STATS_CMD = (
    "head -1 /proc/stat; echo @@; "
    "grep -E '^(MemTotal|MemAvailable)' /proc/meminfo; echo @@; "
    "df -kP / | tail -1; echo @@; "
    "cat /proc/net/dev; echo @@; "
    "cut -d' ' -f1 /proc/uptime; echo @@; "
    "cut -d' ' -f1-3 /proc/loadavg; echo @@; "
    "who"
)


def _ws_uid(ws: WebSocket):
    try:
        return ws.session.get("uid")
    except Exception:
        return None


@router.websocket("/ws/term/{host_id}")
async def ws_term(ws: WebSocket, host_id: int):
    await ws.accept()
    uid = _ws_uid(ws)
    if not uid:
        await ws.close(code=4401)
        return
    try:
        host = get_host(uid, host_id)
        conn = await manager.get(uid, host)
        proc = await conn.create_process(
            term_type="xterm-256color", term_size=(80, 24), encoding=None)
    except Exception as e:
        logger.error("terminal open failed host_id=%s uid=%s: %s", host_id, uid, e)
        with contextlib.suppress(Exception):
            await ws.send_bytes(f"\r\n\x1b[1;31m✗ {e}\x1b[0m\r\n".encode())
            await ws.close()
        return
    logger.info("terminal opened host_id=%s uid=%s", host_id, uid)

    async def pump():
        try:
            while True:
                data = await proc.stdout.read(65536)
                if not data:
                    break
                await ws.send_bytes(data)
        except Exception:
            pass
        with contextlib.suppress(Exception):
            await ws.close()

    task = asyncio.create_task(pump())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg["t"] == "i":
                proc.stdin.write(msg["d"].encode())
            elif msg["t"] == "r":
                with contextlib.suppress(Exception):
                    proc.change_terminal_size(int(msg["c"]), int(msg["r"]))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        task.cancel()
        with contextlib.suppress(Exception):
            proc.close()
        logger.info("terminal closed host_id=%s uid=%s", host_id, uid)


def _parse_stats(out: str, prev: dict):
    parts = [p.strip() for p in out.split("@@")]
    if len(parts) < 7:
        return None
    res = {}
    # cpu
    cpu = [int(x) for x in parts[0].split()[1:]]
    total, idle = sum(cpu), cpu[3] + (cpu[4] if len(cpu) > 4 else 0)
    if prev.get("cpu_total"):
        dt = total - prev["cpu_total"]
        di = idle - prev["cpu_idle"]
        res["cpu"] = round(max(0.0, (1 - di / dt) * 100), 1) if dt > 0 else 0.0
    else:
        res["cpu"] = 0.0
    prev["cpu_total"], prev["cpu_idle"] = total, idle
    # memory (kB)
    mem = {}
    for line in parts[1].splitlines():
        k, _, v = line.partition(":")
        mem[k.strip()] = int(v.split()[0])
    res["mem_total"] = mem.get("MemTotal", 0) * 1024
    res["mem_used"] = (mem.get("MemTotal", 0) - mem.get("MemAvailable", 0)) * 1024
    # disk
    dfields = parts[2].split()
    res["disk_pct"] = int(dfields[4].rstrip("%")) if len(dfields) >= 5 else 0
    # network
    rx = tx = 0
    for line in parts[3].splitlines()[2:]:
        name, _, rest = line.partition(":")
        if name.strip() == "lo":
            continue
        f = rest.split()
        if len(f) >= 9:
            rx += int(f[0])
            tx += int(f[8])
    now_up = float(parts[4])
    if prev.get("rx") is not None and prev.get("up"):
        dt = max(0.001, now_up - prev["up"])
        res["rx_rate"] = max(0, (rx - prev["rx"]) / dt)
        res["tx_rate"] = max(0, (tx - prev["tx"]) / dt)
    else:
        res["rx_rate"] = res["tx_rate"] = 0
    prev["rx"], prev["tx"], prev["up"] = rx, tx, now_up
    res["uptime"] = now_up
    res["load"] = parts[5]
    who = [" ".join(l.split()) for l in parts[6].splitlines() if l.strip()]
    res["who"] = who
    res["users"] = len(who)
    return res


@router.websocket("/ws/stats/{host_id}")
async def ws_stats(ws: WebSocket, host_id: int):
    await ws.accept()
    uid = _ws_uid(ws)
    if not uid:
        await ws.close(code=4401)
        return
    prev: dict = {}
    try:
        host = get_host(uid, host_id)
        while True:
            conn = await manager.get(uid, host)
            result = await conn.run(STATS_CMD, check=False)
            stats = _parse_stats(result.stdout or "", prev)
            if stats:
                await ws.send_text(json.dumps(stats))
            await asyncio.sleep(0.5)
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as e:
        with contextlib.suppress(Exception):
            await ws.send_text(json.dumps({"error": str(e)}))
            await ws.close()
