"""Post new draft picks to Discord when draft.json changes (runs on push).

Secrets: DISCORD_BOT_TOKEN, DRAFT_CHANNEL_ID. Does nothing if DRAFT_CHANNEL_ID isn't set.
Compares draft.json with the previous commit and posts: draft started, each new pick
(with who's on the clock next), undos, pause/resume and the draft ending.
"""
import json, os, subprocess
from discord_api import call

CHANNEL = os.environ.get("DRAFT_CHANNEL_ID", "").strip()

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
    TM = {t["abbr"]: t for t in sched["teams"]}
    mention = lambda a: f"<@&{TM[a]['role']}>" if TM.get(a, {}).get("role") else f"**{TM.get(a, {}).get('name', a)}**"
    order = [t["abbr"] for t in cur["teams"] if t.get("in")]
    T, total = len(order), len(order) * cur["rounds"]
    def slot(n):
        r, i = divmod(n, T)
        return r + 1, i + 1, order[T - 1 - i if cur.get("snake") and r % 2 else i]
    pool = {p["id"]: p for p in cur["pool"]}
    msgs = []
    ps, cs = (prev or {}).get("status", "setup"), cur.get("status")
    if ps == "setup" and cs == "live":
        msgs.append(f"🏈 **THE UFA DRAFT IS LIVE!** {T} teams · {cur['rounds']} rounds{' · snake' if cur.get('snake') else ''}" + (f" · {cur['pickMinutes']} min per pick" if cur.get("pickMinutes") else ""))
    pn, cn = len((prev or {}).get("picks", [])), len(cur["picks"])
    if cn < pn:
        msgs.append(f"↩️ Pick #{cn + 1} was undone.")
    for n in range(pn, cn):
        rd, pk, team = slot(n); p = pool.get(cur["picks"][n]["player"], {"name": "?", "pos": []})
        pos = "/".join(p.get("pos") or [])
        msgs.append(f"**Round {rd}, Pick {pk}** (#{n + 1}) — {mention(team)} select **{p['name']}**" + (f" ({pos})" if pos else "") + (f" <@{p['discord']}>" if p.get("discord") else ""))
    if ps == "live" and cs == "paused": msgs.append("⏸️ The draft is paused.")
    if ps == "paused" and cs == "live": msgs.append("▶️ The draft has resumed.")
    if cs in ("live", "paused") and (msgs or cn != pn) and cn < total:
        rd, pk, team = slot(cn)
        nxt = f"\nOn deck: {mention(slot(cn + 1)[2])}" if cn + 1 < total else ""
        msgs.append(f"⏰ On the clock: {mention(team)} (Round {rd}, Pick {pk})" + (f" — {cur['pickMinutes']} min" if cur.get("pickMinutes") else "") + nxt)
    if cs == "done" and ps != "done":
        msgs.append("🏁 **The draft is complete!** Full rosters: https://elitetuber168.github.io/ufa-schedule/draft.html#/teams")
    if not msgs:
        print("Nothing new to post."); return
    text = "\n".join(msgs)
    for i in range(0, len(text), 1900):
        call("POST", f"/channels/{CHANNEL}/messages", {"content": text[i:i + 1900], "allowed_mentions": {"parse": ["roles", "users"]}})
    print("Posted:\n" + text)

if __name__ == "__main__":
    main()
