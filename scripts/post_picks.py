"""React to draft.json changes (runs on every push that touches draft.json).

Secrets: DISCORD_BOT_TOKEN, DRAFT_CHANNEL_ID, DISCORD_GUILD_ID.
- Posts: draft started, each new pick, undos, pause/resume, reset and the end.
- Gives each drafted player their team's Discord role (and takes it back on undo / reset).
- DMs each drafted player ("You've been drafted by ...") and DMs the FO who is now on the clock.
"""
import json, os, subprocess
from discord_api import call
from league import GUILD, BOARD, load, dm

CHANNEL = os.environ.get("DRAFT_CHANNEL_ID", "").strip()
FO_PORTAL = "https://elitetuber168.github.io/ufa-schedule/fo.html"

def load_prev():
    try:
        return json.loads(subprocess.run(["git", "show", "HEAD~1:draft.json"], capture_output=True, text=True, check=True).stdout)
    except Exception:
        return None

def slotter(D):
    order = [t["abbr"] for t in D["teams"] if t.get("in")]
    T = len(order)
    def slot(n):
        r, i = divmod(n, T)
        return r + 1, i + 1, order[T - 1 - i if D.get("snake") and r % 2 else i]
    return slot, T, T * D["rounds"]

def assignments(D):
    """{(discord user id, team role id)} for every pick in D."""
    if not D or not D.get("picks"): return set()
    slot, T, _ = slotter(D)
    if not T: return set()
    pool = {p["id"]: p for p in D["pool"]}
    roles = {t["abbr"]: t.get("roleId") for t in D["teams"]}
    out = set()
    for n, pk in enumerate(D["picks"]):
        uid, rid = pool.get(pk["player"], {}).get("discord"), roles.get(slot(n)[2])
        if uid and rid: out.add((uid, rid))
    return out

def sync_roles(prev, cur):
    if not GUILD: print("DISCORD_GUILD_ID not set — skipping team roles."); return []
    before, after = assignments(prev), assignments(cur)
    errors = []
    for uid, rid in sorted(before - after):
        try: call("DELETE", f"/guilds/{GUILD}/members/{uid}/roles/{rid}"); print(f"Removed role {rid} from {uid}")
        except SystemExit as e: errors.append(str(e))
    for uid, rid in sorted(after - before):
        try: call("PUT", f"/guilds/{GUILD}/members/{uid}/roles/{rid}"); print(f"Gave role {rid} to {uid}")
        except SystemExit as e: errors.append(str(e))
    for e in errors: print("Role change failed:", e)
    return errors

def main():
    cur, prev = load("draft.json"), load_prev()
    sched = load("schedule.json")
    role_errors = sync_roles(prev, cur)
    if not CHANNEL:
        print("DRAFT_CHANNEL_ID not set — not posting."); return
    SM = {t["abbr"]: t for t in sched["teams"]}
    DT = {t["abbr"]: t for t in cur["teams"]}
    tname = lambda a: SM.get(a, {}).get("name", a)
    def mention(a):
        rid = DT.get(a, {}).get("roleId")
        return f"<@&{rid}>" if rid else f"**{tname(a)}**"
    slot, T, total = slotter(cur)
    pool = {p["id"]: p for p in cur["pool"]}
    msgs = []
    ps, cs = (prev or {}).get("status", "setup"), cur.get("status")
    if ps == "setup" and cs == "live":
        msgs.append(f"🏈 **THE UFA DRAFT IS LIVE!** {T} teams · {cur['rounds']} rounds{' · snake' if cur.get('snake') else ''}"
                    + (f" · {cur['pickMinutes']} min per pick" if cur.get("pickMinutes") else "") + f"\nFollow along: {BOARD}\nFOs: make your pick with **/pick** when you're on the clock.")
    pn, cn = len((prev or {}).get("picks", [])), len(cur["picks"])
    if cs == "setup" and ps != "setup":
        text = "🔄 **The draft has been reset** and will start again from pick #1."
        call("POST", f"/channels/{CHANNEL}/messages", {"content": text, "allowed_mentions": {"parse": []}}); print(text); return
    if cn < pn:
        msgs.append(f"↩️ Pick #{cn + 1} was undone by the commissioner.")
    drafted_dms = []
    for n in range(pn, cn):
        rd, pk, team = slot(n); p = pool.get(cur["picks"][n]["player"], {"name": "?", "pos": []})
        pos = "/".join(p.get("pos") or [])
        auto = cur["picks"][n].get("auto")
        tag = " 🤖 *auto-pick from their queue*" if auto == "queue" else " 🤖 *auto-pick (clock ran out)*" if auto else ""
        msgs.append(f"**Round {rd}, Pick {pk}** (#{n + 1}) — {mention(team)} select **{p['name']}**" + (f" ({pos})" if pos else "")
                    + (f" <@{p['discord']}>" if p.get("discord") else "") + tag)
        if p.get("discord"):
            fo = DT.get(team, {}).get("foId")
            drafted_dms.append((p["discord"], f"🎉 **You've been drafted!** The **{tname(team)}** took you in Round {rd}, Pick {pk} (#{n + 1} overall)."
                                + (f"\nYour franchise owner is <@{fo}> — reach out and say hi." if fo else "")
                                + f"\nFull board: {BOARD}"))
    if ps == "live" and cs == "paused": msgs.append("⏸️ The draft is paused.")
    if ps == "paused" and cs == "live": msgs.append("▶️ The draft has resumed.")
    dm_to = None
    changed = bool(msgs) or cn != pn
    if cs == "live" and changed and cn < total:
        rd, pk, team = slot(cn); fo = DT.get(team, {}).get("foId")
        nxt = f"\nOn deck: {mention(slot(cn + 1)[2])}" if cn + 1 < total else ""
        msgs.append(f"⏰ On the clock: {mention(team)}" + (f" (<@{fo}>)" if fo else "") + f" — Round {rd}, Pick {pk}"
                    + (f" · {cur['pickMinutes']} min" if cur.get("pickMinutes") else "") + nxt)
        if fo: dm_to = (fo, team, rd, pk, cn + 1)
    if cs == "done" and ps != "done":
        msgs.append(f"🏁 **The draft is complete!** Full rosters: {BOARD}#/teams")
    if role_errors and cn > pn:
        msgs.append("⚠️ Couldn't give out team roles — the bot needs **Manage Roles** and its role must sit above the team roles.")
    if not msgs:
        print("Nothing new to post."); return
    text = "\n".join(msgs)
    for i in range(0, len(text), 1900):
        call("POST", f"/channels/{CHANNEL}/messages", {"content": text[i:i + 1900], "allowed_mentions": {"parse": ["roles", "users"]}})
    print("Posted:\n" + text)
    for uid, body in drafted_dms:
        if dm(uid, body): print(f"DMed drafted player {uid}")
    if dm_to:
        fo, team, rd, pk, ov = dm_to
        if dm(fo, f"⏰ **You're on the clock!** {tname(team)} — Round {rd}, Pick {pk} (#{ov})."
                  + (f" You have {cur['pickMinutes']} minutes." if cur.get("pickMinutes") else "")
                  + f"\nMake your pick in the server with **/pick** (it autocompletes available players)."
                  + (f"\nIf the clock runs out, the bot picks for you from your draft queue (set it on the FO portal: {FO_PORTAL})." if cur.get("pickMinutes") else "")
                  + f"\nBoard: {BOARD}"):
            print(f"DMed FO {fo}")

if __name__ == "__main__":
    main()
