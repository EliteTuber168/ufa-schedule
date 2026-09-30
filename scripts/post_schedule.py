"""Weekly schedule posts (runs daily; each post only goes out once).

Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, SCHEDULE_CHANNEL (channel ID or name, e.g. "schedule").
- Schedule: the first time a new week becomes the current week, posts its games and pings both teams.
- Reminder: the day before a week's deadline, pings the teams whose games still have no result.
Manual runs can force either post with FORCE=schedule / FORCE=reminder.
Remembers what was posted in bot_state.json.
"""
import datetime, os, sys
from league import GUILD, SITE, load, save, channel_id, post, team_mention, parse_date, nice_date, current_week, today

FORCE = os.environ.get("FORCE", "").strip().lower().replace("none", "")

def line(g, D, S):
    return f"🏈 {team_mention(g['a'], D, S)} vs {team_mention(g['b'], D, S)}" + (f" — {g['result']}" if g.get("result") else "")

def main():
    ch = os.environ.get("SCHEDULE_CHANNEL", "").strip()
    if not GUILD or not ch:
        print("SCHEDULE_CHANNEL secret not set — nothing to do."); return
    S, D = load("schedule.json"), load("draft.json", {"teams": []})
    state = load("bot_state.json", None)
    first_run = state is None
    state = state or {}
    posted, reminded = state.setdefault("postedWeeks", []), state.setdefault("remindedWeeks", [])
    w = current_week(S)
    if not w:
        print("No current week with games."); save("bot_state.json", state); return
    n, dl = w["week"], parse_date(w.get("deadline"))
    key = f"{n}|{w.get('deadline', '')}"   # week numbers restart with a new season, deadlines don't repeat
    if first_run and not FORCE:
        # the current week was already announced by hand — start automatic posts from the next one
        posted.append(key); save("bot_state.json", state)
        print(f"First run: marked week {n} as already posted. Automatic posts start with the next week."); return
    reg = [g for g in w["games"] if not g.get("catchup") and g.get("a") and g.get("b")]
    cu = [g for g in w["games"] if g.get("catchup") and g.get("a") and g.get("b")]
    cid = None

    if FORCE == "schedule" or (key not in posted and FORCE != "reminder"):
        cid = cid or channel_id(ch)
        msg = [f"📅 **{S.get('league', 'UFA')} — Week {n} schedule**" + (f"\nDeadline: **{nice_date(dl)}**" if dl else ""), ""]
        msg += [line(g, D, S) for g in reg]
        if cu:
            msg += ["", "**Catch-up games**"] + [line(g, D, S) for g in cu]
        msg += ["", f"Full schedule: {SITE}"]
        post(cid, "\n".join(msg)); print("Posted schedule for week", n)
        if key not in posted: posted.append(key)

    due = dl and today() == dl - datetime.timedelta(days=1)
    if FORCE == "reminder" or (due and key not in reminded and FORCE != "schedule"):
        left = [g for g in reg + cu if not g.get("result")]
        if left:
            cid = cid or channel_id(ch)
            when = f"**tomorrow ({nice_date(dl)})**" if due else (f"by **{nice_date(dl)}**" if dl else "soon")
            post(cid, "\n".join([f"⏰ **Reminder:** Week {n} games are due {when}. Still to be played:", ""] + [line(g, D, S) for g in left]))
            print("Posted reminder for week", n)
        else:
            print("Every game has a result — no reminder needed.")
        if key not in reminded: reminded.append(key)

    save("bot_state.json", state)

if __name__ == "__main__":
    main()
