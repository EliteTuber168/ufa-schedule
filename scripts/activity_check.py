"""Weekly activity check (Mondays, or on demand).

Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, STAFF_CHANNEL (channel ID or name). Optional FO_ROLE.
Counts every team's players from its Discord role and reports to the staff channel:
- teams under the minimum player count (Settings on the admin page)
- teams with no franchise owner, and FOs who left the server
- games past their deadline with no result
Also updates schedule.json: player counts, FO names and (for teams set to "auto") active/inactive.
Set UPDATE_COUNTS=false to only report.
"""
import os, sys
from league import (GUILD, SITE, load, save, settings, guild_roles, guild_members, build_rosters, write_rosters,
                    channel_id, post, parse_date, today)

def main():
    if not GUILD: sys.exit("DISCORD_GUILD_ID secret is required.")
    S, D = load("schedule.json"), load("draft.json", {"teams": []})
    cfg = settings(S)
    update = os.environ.get("UPDATE_COUNTS", "true").strip().lower() != "false"
    roles, members = guild_roles(), guild_members()
    ids = {m["user"]["id"] for m in members}
    rosters = build_rosters(members, roles, D, S)
    write_rosters(rosters)
    DT = {t["abbr"]: t for t in D.get("teams", [])}

    under, empty, no_fo, fo_gone, no_role, flips = [], [], [], [], [], []
    for t in S["teams"]:
        a = t["abbr"]
        if a not in rosters:
            no_role.append(a); continue
        ros = rosters[a]; n = len(ros); fos = [p for p in ros if p.get("fo")]
        if n == 0: empty.append(a)
        elif n < cfg["minPlayers"]: under.append(f"{a} ({n})")
        if n and not fos: no_fo.append(a)
        fid = DT.get(a, {}).get("foId")
        if fid and fid not in ids: fo_gone.append(f"{a} (<@{fid}>)")
        if update:
            t["players"] = n
            if fos: t["fo"] = fos[0]["name"]
            if (t.get("mode") or "auto") == "auto":
                was = bool(t.get("active"))
                t["active"] = n >= cfg["minPlayers"] and (not cfg["requireFO"] or bool((t.get("fo") or "").strip()))
                if was != t["active"]: flips.append(f"{a} → {'active' if t['active'] else 'inactive'}")
    if update: save("schedule.json", S)

    unrep = {}
    for w in S.get("weeks", []):
        d = parse_date(w.get("deadline"))
        if not d or d >= today() or (today() - d).days > 14: continue   # only the last two weeks
        for g in w.get("games", []):
            if g.get("a") and g.get("b") and not g.get("result"):
                unrep.setdefault(w["week"], []).append(f"{g['a']} vs {g['b']}")

    active = sum(1 for t in S["teams"] if t.get("active"))
    out = [f"📋 **Weekly activity check** — minimum {cfg['minPlayers']} players" + (" + an FO" if cfg["requireFO"] else ""), ""]
    if under:  out.append("⚠️ **Under the minimum:** " + ", ".join(under))
    if no_fo:  out.append("👤 **No franchise owner:** " + ", ".join(no_fo))
    if fo_gone: out.append("🚪 **FO left the server:** " + ", ".join(fo_gone))
    if flips:  out.append("🔁 **Status changed:** " + ", ".join(flips))
    if unrep:
        out.append("📝 **No result entered (past deadline):**")
        out += [f"  Week {wk}: " + ", ".join(gs) for wk, gs in sorted(unrep.items())[-4:]]
    if empty:  out.append("🫥 Empty teams: " + ", ".join(empty))
    if no_role: out.append("❓ No Discord role found for: " + ", ".join(no_role))
    if len(out) == 2: out.append("✅ Everything looks good.")
    out += ["", f"**{active}** active teams. Schedule: {SITE}"]
    text = "\n".join(out)
    print(text)
    ch = os.environ.get("STAFF_CHANNEL", "").strip()
    if ch: post(channel_id(ch), text, pings=False)
    else: print("STAFF_CHANNEL secret not set — report printed only.")

if __name__ == "__main__":
    main()
