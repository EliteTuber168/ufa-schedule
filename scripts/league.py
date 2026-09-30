"""Shared helpers for the UFA bot scripts (stdlib only)."""
import datetime, json, os, re
from discord_api import call

GUILD = os.environ.get("DISCORD_GUILD_ID", "").strip()
FO_ROLE = os.environ.get("FO_ROLE", "").strip() or "Franchise owner"
BOARD = "https://elitetuber168.github.io/ufa-schedule/draft.html"
SITE = "https://elitetuber168.github.io/ufa-schedule/"
SET_DEF = {"minPlayers": 5, "requireFO": True, "deadlineDays": 4, "maxCatchup": 1, "rematch": "avoid", "pingEveryone": True, "announcement": ""}

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.environ.get("LEAGUE_TZ", "").strip() or "America/New_York")
except Exception:
    TZ = datetime.timezone(datetime.timedelta(hours=-4))

def today():
    return datetime.datetime.now(TZ).date()

def load(path, default=None):
    try:
        return json.load(open(path, encoding="utf-8"))
    except FileNotFoundError:
        return default

def save(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")

def settings(sched):
    return {**SET_DEF, **(sched.get("settings") or {})}

# ---------- Discord members / roles ----------
def display(m):
    return m.get("nick") or m["user"].get("global_name") or m["user"]["username"]

def clean_name(m):
    name = re.sub(r"[\(\[\{].*?[\)\]\}]", "", display(m))       # drop "(wr/qb)" / "[AFL]"
    name = re.sub(r"[^\w .\-]", "", name).strip()                # drop emoji / symbols
    return name or m["user"]["username"]

def avatar(m):
    u = m["user"]
    if m.get("avatar"):
        return f"https://cdn.discordapp.com/guilds/{GUILD}/users/{u['id']}/avatars/{m['avatar']}.png?size=96"
    if u.get("avatar"):
        return f"https://cdn.discordapp.com/avatars/{u['id']}/{u['avatar']}.png?size=96"
    return f"https://cdn.discordapp.com/embed/avatars/{(int(u['id']) >> 22) % 6}.png"

def find_role(roles, key):
    key = str(key).lower().strip()
    return next((r for r in roles if r["id"] == key or r["name"].lower().strip() == key), None)

def guild_roles():
    return call("GET", f"/guilds/{GUILD}/roles")

def guild_members():
    out, after = [], "0"
    while True:
        page = call("GET", f"/guilds/{GUILD}/members?limit=1000&after={after}")
        out += page
        if len(page) < 1000: break
        after = page[-1]["user"]["id"]
    return [m for m in out if not m["user"].get("bot")]

def team_roles(roles, draft, sched):
    """abbr -> Discord role, matched by stored roleId, then full team name, then nickname ("Vikings")."""
    names = {t["abbr"]: t["name"] for t in sched["teams"]}
    ids = {t["abbr"]: t.get("roleId") for t in draft.get("teams", [])}
    out = {}
    for abbr, full in names.items():
        r = (ids.get(abbr) and find_role(roles, ids[abbr])) or find_role(roles, full) or find_role(roles, full.split()[-1])
        if r: out[abbr] = r
    return out

def build_rosters(members, roles, draft, sched):
    fo = find_role(roles, FO_ROLE)
    out = {}
    for abbr, r in team_roles(roles, draft, sched).items():
        out[abbr] = sorted(({"id": m["user"]["id"], "name": clean_name(m), "avatar": avatar(m),
                             **({"fo": True} if fo and fo["id"] in m.get("roles", []) else {})}
                            for m in members if r["id"] in m.get("roles", [])),
                           key=lambda p: (not p.get("fo"), p["name"].lower()))
    return out

def write_rosters(rosters):
    """Write rosters.json only when a roster actually changed (keeps the commit history quiet)."""
    old = load("rosters.json", {}) or {}
    if old.get("teams") == rosters: return False
    save("rosters.json", {"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "teams": rosters})
    return True

# ---------- channels ----------
def channel_id(value):
    """Accepts a channel ID or a channel name like 'schedule' / '#schedule'."""
    v = (value or "").strip().lstrip("#")
    if not v or v.isdigit(): return v
    chans = call("GET", f"/guilds/{GUILD}/channels")
    c = next((c for c in chans if c["name"].lower() == v.lower() and c.get("type") in (0, 5)), None)
    if not c: raise SystemExit(f"No text channel named #{v}.")
    return c["id"]

def post(channel, text, pings=True):
    for i in range(0, len(text), 1900):
        call("POST", f"/channels/{channel}/messages", {"content": text[i:i + 1900],
             "allowed_mentions": {"parse": ["roles", "users"] if pings else []}})

def dm(uid, text):
    try:
        ch = call("POST", "/users/@me/channels", {"recipient_id": uid})
        call("POST", f"/channels/{ch['id']}/messages", {"content": text})
        return True
    except SystemExit as e:
        print(f"Couldn't DM {uid} (DMs off?): {e}")
        return False

def team_mention(abbr, draft, sched):
    t = next((t for t in draft.get("teams", []) if t["abbr"] == abbr), {})
    s = next((t for t in sched["teams"] if t["abbr"] == abbr), {})
    rid = t.get("roleId") or (s.get("role") if str(s.get("role", "")).isdigit() else "")
    return f"<@&{rid}>" if rid else f"**{s.get('name', abbr)}**"

def parse_date(s):
    try: return datetime.date.fromisoformat(str(s)[:10])
    except Exception: return None

def nice_date(d):
    return d.strftime("%a, %b ") + str(d.day)

def current_week(sched):
    """The first week not marked done whose deadline hasn't passed (or has no deadline)."""
    t = today()
    for w in sorted(sched.get("weeks", []), key=lambda w: w["week"]):
        if w.get("done") or not w.get("games"): continue
        d = parse_date(w.get("deadline"))
        if d is None or d >= t: return w
    return None
