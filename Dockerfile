FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app app
COPY static static

# vendor xterm.js so the app works fully offline / intranet-only
RUN mkdir -p static/vendor && \
    curl -fsSL -o static/vendor/xterm.js https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js && \
    curl -fsSL -o static/vendor/xterm.css https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css && \
    curl -fsSL -o static/vendor/addon-fit.js https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js

ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
