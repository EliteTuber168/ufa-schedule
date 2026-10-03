"""Sync the draft + rosters from Discord (hourly, and on demand).

Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DRAFT_ROLE (role name or ID).
Optional: FO_ROLE (default "Franchise owner").

Players (everyone with the draft role):
- New members are added with their server nickname, avatar and positions parsed from the nickname
  (e.g. "Dj556yk (wr/qb/db)" -> Dj556yk, WR/QB/DB).
- Existing players get their avatar refreshed, and name/positions refreshed unless you edited them
  in the draft room (those are marked "locked").
- Players who lost the role are removed unless already drafted.

Franchise owners:
- Whoever has a team's role AND the FO role becomes that team's FO, unless set by hand in the draft room.

Rosters:
- rosters.json lists everyone holding each team role (used by /roster and the activity check).
"""
import os, re, sys
from league import (GUILD, FO_ROLE, load, save, clean_name, display, avatar, find_role, guild_roles,
                    guild_members, team_roles, build_rosters, write_rosters)

ROLE = os.environ.get("DRAFT_ROLE", "").strip()
EVENT = os.environ.get("GITHUB_EVENT_NAME", "")
POS_ALIASES = {"QB":"QB","RB":"RB","HB":"RB","WR":"WR","TE":"TE","OL":"OL","DE":"DE","DL":"DE","LB":"LB","MLB":"LB","OLB":"LB",
               "CB":"CB","S":"S","FS":"S","SS":"S","DB":"DB","K":"K/P","P":"K/P","KP":"K/P","K/P":"K/P","KR":"KR"}

def parse_pos(m):
    found = []
    for grp in re.findall(r"[\(\[\{](.*?)[\)\]\}]", display(m).upper()):
        for tok in re.split(r"[^A-Z/]+|/", grp):
            p = POS_ALIASES.get(tok)
            if p and p not in found: found.append(p)
    return found

def main():
    if not GUILD or not ROLE: sys.exit("DISCORD_GUILD_ID and DRAFT_ROLE secrets are required.")
    draft, sched = load("draft.json"), load("schedule.json")
    if EVENT == "schedule" and draft.get("status") == "live":
        print("Draft is live — skipping the hourly sync (run it manually if needed)."); return

    roles = guild_roles()
    role = find_role(roles, ROLE)
    if not role: sys.exit(f"No role named/with ID '{ROLE}'. Roles: {', '.join(r['name'] for r in roles)}")
    humans = guild_members()
    fa_phase = draft.get("status") in ("done", "skipped")   # after the draft / once it's skipped: free agents count as the pool
    fa_role = find_role(roles, os.environ.get("FA_ROLE", "").strip() or "Free Agent") or find_role(roles, "Free Agents")
    keep_ids = {role["id"]} | ({fa_role["id"]} if fa_phase and fa_role else set())
    tagged = {m["user"]["id"]: m for m in humans if keep_ids & set(m.get("roles", []))}
    in_server = {m["user"]["id"] for m in humans}
    print(f"{len(humans)} members, {len(tagged)} in the player pool{' (Draftable + Free Agent)' if fa_phase else ''}.")

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
        before = repr(sorted(p.items()))
        p["avatar"] = avatar(m)
        if not p.get("locked"):
            p["name"] = clean_name(m)
            pos = parse_pos(m)
            if pos: p["pos"] = pos
        if repr(sorted(p.items())) != before: updated += 1
        for x in p.get("pos", []):
            if x not in draft.setdefault("positions", []): draft["positions"].append(x)
    keep = []
    for p in pool:
        gone = p["discord"] not in in_server if fa_phase else p["discord"] not in tagged   # in free agency: keep everyone's positions until they leave the server
        if p.get("discord") and gone and p["id"] not in drafted:
            removed += 1; continue
        keep.append(p)
    draft["pool"] = keep

    # ---- team roles + franchise owners ----
    troles = team_roles(roles, draft, sched)
    fo_role = find_role(roles, FO_ROLE)
    linked = 0
    for t in draft["teams"]:
        tr = troles.get(t["abbr"])
        if tr: t["roleId"] = tr["id"]
        if not fo_role or t.get("foManual") or not tr: continue
        fo = next((m for m in humans if tr["id"] in m.get("roles", []) and fo_role["id"] in m.get("roles", [])), None)
        if fo:
            t["fo"], t["foId"] = clean_name(fo), fo["user"]["id"]; linked += 1
    if not fo_role: print(f"No '{FO_ROLE}' role found — skipping FO auto-fill.")
    save("draft.json", draft)

    rosters = build_rosters(humans, roles, draft, sched)
    changed = write_rosters(rosters)
    print(f"Players: +{added} new, {updated} updated, -{removed} removed, {len(keep)} total. FOs linked: {linked}. "
          f"Team roles found: {len(troles)}. Rosters {'updated' if changed else 'unchanged'}.")

if __name__ == "__main__":
    main()
