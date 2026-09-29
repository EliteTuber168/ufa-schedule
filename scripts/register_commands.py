"""Register the draft slash commands (/pick, /onclock, /available) in the server.
Run once from GitHub: Actions → Register draft slash commands → Run workflow.
Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID."""
import os, sys
from discord_api import call

GUILD = os.environ.get("DISCORD_GUILD_ID", "").strip()
if not GUILD: sys.exit("DISCORD_GUILD_ID secret is required.")
app = call("GET", "/oauth2/applications/@me")
cmds = [
    {"name": "pick", "description": "Make your draft pick (only works when you're on the clock)",
     "options": [{"type": 3, "name": "player", "description": "Start typing a player's name", "required": True, "autocomplete": True}]},
    {"name": "onclock", "description": "Who's on the clock in the draft"},
    {"name": "available", "description": "Best available players (only you see this)",
     "options": [{"type": 3, "name": "position", "description": "e.g. QB, WR, CB", "required": False}]},
]
res = call("PUT", f"/applications/{app['id']}/guilds/{GUILD}/commands", cmds)
print(f"Registered for app {app['name']} ({app['id']}): " + ", ".join("/" + c["name"] for c in res))
