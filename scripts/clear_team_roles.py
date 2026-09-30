"""League restart helper: take every team role off everyone EXCEPT franchise owners.

Run from GitHub: Actions → Clear team roles (restart) → Run workflow. Type CLEAR to confirm;
leave "dry run" ticked first to see who would be affected.
Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID. Optional FO_ROLE.
"""
import os, sys
from discord_api import call
from league import GUILD, FO_ROLE, load, find_role, guild_roles, guild_members, team_roles, clean_name

def main():
    confirm = os.environ.get("CONFIRM", "").strip()
    dry = os.environ.get("DRY_RUN", "true").strip().lower() != "false"
    if not dry and confirm != "CLEAR": sys.exit("Type CLEAR in the confirm box to really remove roles.")
    roles, members = guild_roles(), guild_members()
    fo = find_role(roles, FO_ROLE)
    if not fo: sys.exit(f"No '{FO_ROLE}' role found — refusing to run (FOs would lose their team roles).")
    troles = {r["id"]: a for a, r in team_roles(roles, load("draft.json", {"teams": []}), load("schedule.json")).items()}
    print(f"{len(troles)} team roles found. {'DRY RUN — nothing will change.' if dry else 'Removing roles...'}")
    n = 0
    for m in members:
        if fo["id"] in m.get("roles", []): continue
        for rid in [r for r in m.get("roles", []) if r in troles]:
            n += 1
            print(f"{'Would remove' if dry else 'Removing'} {troles[rid]} from {clean_name(m)}")
            if not dry: call("DELETE", f"/guilds/{GUILD}/members/{m['user']['id']}/roles/{rid}")
    print(f"{'Would remove' if dry else 'Removed'} {n} team roles. Franchise owners were left alone.")

if __name__ == "__main__":
    main()
