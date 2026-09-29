"""Sync the draft pool from everyone in the Discord server who has the draft role.

Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DRAFT_ROLE (role name or ID).
- New role members are added (name from server nickname, positions parsed from it, e.g. "Dj556yk (wr/qb/db)").
- Existing players keep any edits made in the draft room.
- Players who lost the role are removed, unless they've already been drafted.
"""
import json, os, re, sys
from discord_api import call

GUILD = os.environ.get("DISCORD_GUILD_ID", "").strip()
ROLE = os.environ.get("DRAFT_ROLE", "").strip()
EVENT = os.environ.get("GITHUB_EVENT_NAME", "")
POS_ALIASES = {"QB":"QB","RB":"RB","HB":"RB","WR":"WR","TE":"TE","OL":"OL","DE":"DE","DL":"DE","LB":"LB","MLB":"LB","OLB":"LB","CB":"CB","S":"S","FS":"S","SS":"S","DB":"DB","K":"K/P","P":"K/P","KP":"K/P","K/P":"K/P","KR":"KR"}

def clean_name(member):
    raw = member.get("nick") or member["user"].get("global_name") or member["user"]["username"]
    name = re.sub(r"[\(\[\{].*?[\)\]\}]", "", raw)          # drop "(wr/qb)" / "[AFL]" bits
    name = re.sub(r"[^\w .\-]", "", name).strip()            # drop emoji / symbols
    return name or member["user"]["username"]

def parse_pos(member):
    raw = (member.get("nick") or member["user"].get("global_name") or "").upper()
    found = []
    for grp in re.findall(r"[\(\[\{](.*?)[\)\]\}]", raw):
        for tok in re.split(r"[^A-Z/]+|/", grp):
            p = POS_ALIASES.get(tok)
            if p and p not in found: found.append(p)
    return found

def main():
    if not GUILD or not ROLE: sys.exit("DISCORD_GUILD_ID and DRAFT_ROLE secrets are required.")
    draft = json.load(open("draft.json", encoding="utf-8"))
    if EVENT == "schedule" and draft.get("status") == "live":
        print("Draft is live — skipping the hourly sync (run it manually if needed)."); return
    roles = call("GET", f"/guilds/{GUILD}/roles")
    role = next((r for r in roles if r["id"] == ROLE or r["name"].lower() == ROLE.lower()), None)
    if not role: sys.exit(f"No role named/with ID '{ROLE}'. Roles: {', '.join(r['name'] for r in roles)}")
    members, after = [], "0"
    while True:
        page = call("GET", f"/guilds/{GUILD}/members?limit=1000&after={after}")
        members += page
        if len(page) < 1000: break
        after = page[-1]["user"]["id"]
    tagged = {m["user"]["id"]: m for m in members if role["id"] in m.get("roles", []) and not m["user"].get("bot")}
    print(f"{len(members)} members in the server, {len(tagged)} with the '{role['name']}' role.")

    pool, drafted = draft.setdefault("pool", []), {p["player"] for p in draft.get("picks", [])}
    by_discord = {p.get("discord"): p for p in pool if p.get("discord")}
    next_id = max([p["id"] for p in pool] or [0]) + 1
    added = removed = 0
    for uid, m in tagged.items():
        if uid in by_discord: continue
        name = clean_name(m)
        existing = next((p for p in pool if not p.get("discord") and p["name"].lower() == name.lower()), None)
        if existing:                      # a manually-added player matches — just link them
            existing["discord"] = uid; continue
        pos = parse_pos(m)
        pool.append({"id": next_id, "name": name, "pos": pos, "discord": uid}); next_id += 1; added += 1
        for p in pos:
            if p not in draft.setdefault("positions", []): draft["positions"].append(p)
    keep = []
    for p in pool:
        if p.get("discord") and p["discord"] not in tagged and p["id"] not in drafted:
            removed += 1; continue
        keep.append(p)
    draft["pool"] = keep
    json.dump(draft, open("draft.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False); open("draft.json", "a").write("\n")
    print(f"Added {added}, removed {removed}. Pool now has {len(keep)} players.")

if __name__ == "__main__":
    main()
