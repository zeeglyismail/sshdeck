import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import crypto, db, log, ws
from .routers import all_routers

log.setup()
logger = log.get("main")
db.init()

app = FastAPI(title="SSHDeck")
app.add_middleware(SessionMiddleware, secret_key=crypto.session_secret(),
                   max_age=30 * 24 * 3600, same_site="lax")

for r in all_routers:
    app.include_router(r)
app.include_router(ws.router)

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    logger.exception("unhandled error on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=500, content={"detail": f"Internal error: {exc}"})


@app.get("/")
def index(request: Request):
    if not request.session.get("uid"):
        return RedirectResponse("/login")
    return FileResponse(os.path.join(STATIC, "index.html"))


@app.get("/login")
def login_page(request: Request):
    if request.session.get("uid"):
        return RedirectResponse("/")
    return FileResponse(os.path.join(STATIC, "login.html"))


logger.info("SSHDeck started, data dir: %s", db.DATA_DIR)
