"""Tiny Discord REST helper (stdlib only). Token comes from the DISCORD_BOT_TOKEN secret."""
import json, os, time, urllib.request, urllib.error

API = "https://discord.com/api/v10"
TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "").strip()

def call(method, path, body=None):
    if not TOKEN:
        raise SystemExit("DISCORD_BOT_TOKEN secret is missing.")
    data = json.dumps(body).encode() if body is not None else None
    for _ in range(5):
        req = urllib.request.Request(API + path, data=data, method=method, headers={
            "Authorization": "Bot " + TOKEN,
            "User-Agent": "DiscordBot (https://github.com/EliteTuber168/ufa-schedule, 1.0)",
            "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = float(json.loads(e.read() or b"{}").get("retry_after", 2))
                time.sleep(wait + 0.5); continue
            msg = e.read().decode(errors="replace")[:300]
            hint = {401: "Bad bot token.", 403: "The bot is missing access (check it's in the server and Server Members Intent is on).", 404: "Server/channel/role ID not found."}.get(e.code, "")
            raise SystemExit(f"Discord API {e.code} on {path}: {hint} {msg}")
    raise SystemExit("Discord kept rate-limiting; try again later.")
