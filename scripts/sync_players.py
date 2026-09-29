"""Sync the draft from Discord.

Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DRAFT_ROLE (role name or ID).
Optional: FO_ROLE (default "Franchise owner").

Players (everyone with the draft role):
- New members are added with their server nickname, avatar and positions parsed from the nickname
  (e.g. "Dj556yk (wr/qb/db)" -> Dj556yk, WR/QB/DB).
- Existing players get their avatar refreshed, and name/positions refreshed unless you edited them
  in the draft room (those are marked "locked").
- Players who lost the role are removed unless already drafted.

Franchise owners:
- For each team, finds the Discord role named after the team ("Minnesota Vikings" or "Vikings").
  Whoever has that role AND the FO role becomes the team's FO (name + Discord ID), unless you set
  the FO by hand in the draft room.
"""
import json, os, re, sys
from discord_api import call

GUILD = os.environ.get("DISCORD_GUILD_ID", "").strip()
ROLE = os.environ.get("DRAFT_ROLE", "").strip()
FO_ROLE = os.environ.get("FO_ROLE", "").strip() or "Franchise owner"
EVENT = os.environ.get("GITHUB_EVENT_NAME", "")
POS_ALIASES = {"QB":"QB","RB":"RB","HB":"RB","WR":"WR","TE":"TE","OL":"OL","DE":"DE","DL":"DE","LB":"LB","MLB":"LB","OLB":"LB",
               "CB":"CB","S":"S","FS":"S","SS":"S","DB":"DB","K":"K/P","P":"K/P","KP":"K/P","K/P":"K/P","KR":"KR"}

def display(m):
    return m.get("nick") or m["user"].get("global_name") or m["user"]["username"]

def clean_name(m):
    name = re.sub(r"[\(\[\{].*?[\)\]\}]", "", display(m))       # drop "(wr/qb)" / "[AFL]"
    name = re.sub(r"[^\w .\-]", "", name).strip()                # drop emoji / symbols
    return name or m["user"]["username"]

def parse_pos(m):
    found = []
    for grp in re.findall(r"[\(\[\{](.*?)[\)\]\}]", display(m).upper()):
        for tok in re.split(r"[^A-Z/]+|/", grp):
            p = POS_ALIASES.get(tok)
            if p and p not in found: found.append(p)
    return found

def avatar(m):
    u = m["user"]
    if m.get("avatar"):   # server-specific avatar
        return f"https://cdn.discordapp.com/guilds/{GUILD}/users/{u['id']}/avatars/{m['avatar']}.png?size=96"
    if u.get("avatar"):
        return f"https://cdn.discordapp.com/avatars/{u['id']}/{u['avatar']}.png?size=96"
    return f"https://cdn.discordapp.com/embed/avatars/{(int(u['id']) >> 22) % 6}.png"

def find_role(roles, key):
    key = key.lower()
    return next((r for r in roles if r["id"] == key or r["name"].lower().strip() == key), None)

def main():
    if not GUILD or not ROLE: sys.exit("DISCORD_GUILD_ID and DRAFT_ROLE secrets are required.")
    draft = json.load(open("draft.json", encoding="utf-8"))
    sched = json.load(open("schedule.json", encoding="utf-8"))
    if EVENT == "schedule" and draft.get("status") == "live":
        print("Draft is live — skipping the hourly sync (run it manually if needed)."); return

    roles = call("GET", f"/guilds/{GUILD}/roles")
    role = find_role(roles, ROLE)
    if not role: sys.exit(f"No role named/with ID '{ROLE}'. Roles: {', '.join(r['name'] for r in roles)}")
    members, after = [], "0"
    while True:
        page = call("GET", f"/guilds/{GUILD}/members?limit=1000&after={after}")
        members += page
        if len(page) < 1000: break
        after = page[-1]["user"]["id"]
    humans = [m for m in members if not m["user"].get("bot")]
    tagged = {m["user"]["id"]: m for m in humans if role["id"] in m.get("roles", [])}
    print(f"{len(members)} members, {len(tagged)} with the '{role['name']}' role.")

    # ---- players ----
    pool, drafted = draft.setdefault("pool", []), {p["player"] for p in draft.get("picks", [])}
    by_discord = {p.get("discord"): p for p in pool if p.get("discord")}
    next_id = max([p["id"] for p in pool] or [0]) + 1
    added = updated = removed = 0
    for uid, m in tagged.items():
        p = by_discord.get(uid)
        if not p:
            name = clean_name(m)
            p = next((x for x in pool if not x.get("discord") and x["name"].lower() == name.lower()), None)
            if p: p["discord"] = uid
            else:
                p = {"id": next_id, "name": name, "pos": parse_pos(m), "discord": uid}; next_id += 1; pool.append(p); added += 1
        before = json.dumps(p, sort_keys=True)
        p["avatar"] = avatar(m)
        if not p.get("locked"):
            p["name"] = clean_name(m)
            pos = parse_pos(m)
            if pos: p["pos"] = pos
        if json.dumps(p, sort_keys=True) != before: updated += 1
        for x in p.get("pos", []):
            if x not in draft.setdefault("positions", []): draft["positions"].append(x)
    keep = []
    for p in pool:
        if p.get("discord") and p["discord"] not in tagged and p["id"] not in drafted:
            removed += 1; continue
        keep.append(p)
    draft["pool"] = keep

    # ---- franchise owners ----
    fo_role = find_role(roles, FO_ROLE)
    linked = 0
    if not fo_role:
        print(f"No '{FO_ROLE}' role found — skipping FO auto-fill.")
    else:
        names = {t["abbr"]: t["name"] for t in sched["teams"]}
        for t in draft["teams"]:
            full = names.get(t["abbr"], t["abbr"]); short = full.split()[-1]
            trole = find_role(roles, full) or find_role(roles, short)
            if trole: t["roleId"] = trole["id"]
            if t.get("foManual") or not trole: continue
            fo = next((m for m in humans if trole["id"] in m.get("roles", []) and fo_role["id"] in m.get("roles", [])), None)
            if fo:
                t["fo"], t["foId"] = clean_name(fo), fo["user"]["id"]; linked += 1
    json.dump(draft, open("draft.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    open("draft.json", "a").write("\n")
    print(f"Players: +{added} new, {updated} updated, -{removed} removed, {len(keep)} total. FOs linked: {linked}.")

if __name__ == "__main__":
    main()
