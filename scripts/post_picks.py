"""Post draft updates to Discord when draft.json changes (runs on every push that touches draft.json).

Secrets: DISCORD_BOT_TOKEN, DRAFT_CHANNEL_ID. Does nothing if DRAFT_CHANNEL_ID isn't set.
Compares draft.json with the previous commit and posts: draft started, each new pick, undos,
pause/resume and the end. Whoever is on the clock gets @-mentioned and DMed by the bot.
"""
import json, os, subprocess
from discord_api import call

CHANNEL = os.environ.get("DRAFT_CHANNEL_ID", "").strip()
BOARD = "https://elitetuber168.github.io/ufa-schedule/draft.html"

def load_prev():
    try:
        return json.loads(subprocess.run(["git", "show", "HEAD~1:draft.json"], capture_output=True, text=True, check=True).stdout)
    except Exception:
        return None

def main():
    if not CHANNEL:
        print("DRAFT_CHANNEL_ID not set — not posting."); return
    cur, prev = json.load(open("draft.json", encoding="utf-8")), load_prev()
    sched = json.load(open("schedule.json", encoding="utf-8"))
    SM = {t["abbr"]: t for t in sched["teams"]}
    DT = {t["abbr"]: t for t in cur["teams"]}
    tname = lambda a: SM.get(a, {}).get("name", a)
    def mention(a):
        rid = DT.get(a, {}).get("roleId") or SM.get(a, {}).get("role")
        return f"<@&{rid}>" if rid else f"**{tname(a)}**"
    order = [t["abbr"] for t in cur["teams"] if t.get("in")]
    T = len(order); total = T * cur["rounds"]
    def slot(n):
        r, i = divmod(n, T)
        return r + 1, i + 1, order[T - 1 - i if cur.get("snake") and r % 2 else i]
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
    for n in range(pn, cn):
        rd, pk, team = slot(n); p = pool.get(cur["picks"][n]["player"], {"name": "?", "pos": []})
        pos = "/".join(p.get("pos") or [])
        msgs.append(f"**Round {rd}, Pick {pk}** (#{n + 1}) — {mention(team)} select **{p['name']}**" + (f" ({pos})" if pos else "")
                    + (f" <@{p['discord']}>" if p.get("discord") else ""))
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
    if not msgs:
        print("Nothing new to post."); return
    text = "\n".join(msgs)
    for i in range(0, len(text), 1900):
        call("POST", f"/channels/{CHANNEL}/messages", {"content": text[i:i + 1900], "allowed_mentions": {"parse": ["roles", "users"]}})
    print("Posted:\n" + text)
    if dm_to:
        fo, team, rd, pk, ov = dm_to
        try:
            ch = call("POST", "/users/@me/channels", {"recipient_id": fo})
            call("POST", f"/channels/{ch['id']}/messages", {"content":
                f"⏰ **You're on the clock!** {tname(team)} — Round {rd}, Pick {pk} (#{ov})."
                + (f" You have {cur['pickMinutes']} minutes." if cur.get("pickMinutes") else "")
                + f"\nMake your pick in the server with **/pick** (it autocompletes available players).\nBoard: {BOARD}"})
            print(f"DMed FO {fo}")
        except SystemExit as e:
            print(f"Couldn't DM the FO (they may have DMs off): {e}")

if __name__ == "__main__":
    main()
