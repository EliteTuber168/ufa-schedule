"""Register the bot's slash commands in the server.
Run from GitHub: Actions → Register draft slash commands → Run workflow (re-run after adding commands).
Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID."""
import os, sys
from discord_api import call

GUILD = os.environ.get("DISCORD_GUILD_ID", "").strip()
if not GUILD: sys.exit("DISCORD_GUILD_ID secret is required.")
app = call("GET", "/oauth2/applications/@me")
STR, INT, SUB, USER = 3, 4, 1, 6
user = lambda name, desc, req=True: {"type": USER, "name": name, "description": desc, "required": req}
team = lambda req: {"type": STR, "name": "team", "description": "Team name or abbreviation", "required": req, "autocomplete": True}

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
    {"name": "franchises", "description": "Every franchise, its roster count and owner"},
    {"name": "offer", "description": "Offer a free agent a spot on your team (FO / GM / HC)", "options": [user("player", "The free agent to sign")]},
    {"name": "offers", "description": "See and answer contract offers sent to you"},
    {"name": "release", "description": "Release a player from your team (FO / GM)", "options": [user("player", "Player to release")]},
    {"name": "demand", "description": "Ask to leave your team (staff approve it)",
     "options": [{"type": STR, "name": "reason", "description": "Why you want to leave (optional)", "required": False, "max_length": 300}]},
    {"name": "promote", "description": "Promote a player to GM or Head Coach (FO only, staff approve it)", "options": [
        user("player", "Player to promote"),
        {"type": STR, "name": "role", "description": "New role", "required": True, "choices": [{"name": "General Manager", "value": "gm"}, {"name": "Head Coach", "value": "hc"}]},
        {"type": STR, "name": "reason", "description": "Why? (staff see this)", "required": True, "max_length": 300}]},
    {"name": "demote", "description": "Remove a GM / Head Coach title (FO only)", "options": [user("player", "GM or head coach")]},
    {"name": "trade", "description": "Propose a trade (FO / GM) — other team accepts, then staff approve", "options": [
        team(True),
        user("give1", "A player you send"), user("get1", "A player you get", False),
        user("give2", "Another player you send", False), user("get2", "Another player you get", False),
        user("give3", "Another player you send", False), user("get3", "Another player you get", False)]},
    {"name": "activity", "description": "Teams under the minimum or without an FO (staff)"},
    {"name": "vote", "description": "League votes (staff)", "options": [
        {"type": SUB, "name": "create", "description": "Post a vote — one vote per person", "options": [
            {"type": STR, "name": "title", "description": "e.g. Week 1 MVP", "required": True},
            {"type": STR, "name": "options", "description": "Choices separated by commas (2–25)", "required": True},
            {"type": INT, "name": "hours", "description": "Close voting after this many hours (optional)", "required": False, "min_value": 1, "max_value": 720}]}]},
]
res = call("PUT", f"/applications/{app['id']}/guilds/{GUILD}/commands", cmds)
print(f"Registered for app {app['name']} ({app['id']}): " + ", ".join("/" + c["name"] for c in res))
