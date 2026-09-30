"""Register the bot's slash commands in the server.
Run from GitHub: Actions → Register draft slash commands → Run workflow (re-run after adding commands).
Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID."""
import os, sys
from discord_api import call

GUILD = os.environ.get("DISCORD_GUILD_ID", "").strip()
if not GUILD: sys.exit("DISCORD_GUILD_ID secret is required.")
app = call("GET", "/oauth2/applications/@me")
STR, INT, SUB = 3, 4, 1
team = lambda req: {"type": STR, "name": "team", "description": "Team name or abbreviation", "required": req, "autocomplete": True}
STAFF = "32"   # only visible to members with Manage Server (change in Server Settings → Integrations)
cmds = [
    {"name": "pick", "description": "Make your draft pick (only works when you're on the clock)",
     "options": [{"type": STR, "name": "player", "description": "Start typing a player's name", "required": True, "autocomplete": True}]},
    {"name": "onclock", "description": "Who's on the clock in the draft"},
    {"name": "available", "description": "Best available players (only you see this)",
     "options": [{"type": STR, "name": "position", "description": "e.g. QB, WR, CB", "required": False}]},
    {"name": "schedule", "description": "This week's games, or one team's schedule", "options": [team(False)]},
    {"name": "roster", "description": "Show a team's roster", "options": [team(True)]},
    {"name": "fa", "description": "Free agents", "options": [
        {"type": SUB, "name": "list", "description": "Players not on a team (only you see this)",
         "options": [{"type": STR, "name": "position", "description": "e.g. QB, WR, CB", "required": False}]},
        {"type": SUB, "name": "join", "description": "Put yourself in the player pool / free agency",
         "options": [{"type": STR, "name": "positions", "description": "Positions you play, e.g. WR/CB", "required": True}]},
        {"type": SUB, "name": "leave", "description": "Take yourself out of the player pool"}]},
    {"name": "activity", "description": "Teams under the minimum or without an FO (staff)", "default_member_permissions": STAFF},
    {"name": "vote", "description": "League votes (staff)", "default_member_permissions": STAFF, "options": [
        {"type": SUB, "name": "create", "description": "Post a vote — one vote per person", "options": [
            {"type": STR, "name": "title", "description": "e.g. Week 1 MVP", "required": True},
            {"type": STR, "name": "options", "description": "Choices separated by commas (2–25)", "required": True},
            {"type": INT, "name": "hours", "description": "Close voting after this many hours (optional)", "required": False, "min_value": 1, "max_value": 720}]}]},
]
res = call("PUT", f"/applications/{app['id']}/guilds/{GUILD}/commands", cmds)
print(f"Registered for app {app['name']} ({app['id']}): " + ", ".join("/" + c["name"] for c in res))
