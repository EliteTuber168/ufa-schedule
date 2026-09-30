"""One-time server setup for the transactions system (safe to re-run — it reuses what already exists).

Run from GitHub: Actions → Set up server → Run workflow.
Secrets: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID. Optional FO_ROLE, TRANSACTIONS_CHANNEL (name or ID, default "transactions").
Bot needs Manage Roles + Manage Channels.

Creates (fresh) roles: UFA Staff, General Manager, Head Coach.
Creates a private "UFA STAFF" category at the bottom with #staff-announcements, #staff-chat, #approvals
(only UFA Staff + the bot can see it).
Writes every ID the bot needs into config.json (no secrets in there).
"""
import os, sys
from discord_api import call
from league import GUILD, FO_ROLE, load, save, find_role

VIEW, SEND, EMBED, HISTORY, MENTION_EVERYONE = 1 << 10, 1 << 11, 1 << 14, 1 << 16, 1 << 17
STAFF_ALLOW = VIEW | SEND | EMBED | HISTORY
CHANNELS = [("staffAnnouncements", "staff-announcements"), ("staffChat", "staff-chat"), ("approvals", "approvals")]

def main():
    if not GUILD: sys.exit("DISCORD_GUILD_ID secret is required.")
    cfg = load("config.json", {}) or {}
    cfg["guild"] = GUILD
    R, C = cfg.setdefault("roles", {}), cfg.setdefault("channels", {})
    roles = call("GET", f"/guilds/{GUILD}/roles")
    by_id = {r["id"]: r for r in roles}
    me = call("GET", "/users/@me")

    def role(key, name, color):
        if R.get(key) in by_id:
            print(f"Role {name}: already set up ({R[key]})"); return R[key]
        r = call("POST", f"/guilds/{GUILD}/roles", {"name": name, "color": color, "hoist": key != "staff", "mentionable": True})
        R[key] = r["id"]; print(f"Created role {name} ({r['id']})"); return r["id"]

    staff = role("staff", "UFA Staff", 0xE8424A)
    role("gm", "General Manager", 0x3D7BFF)
    role("hc", "Head Coach", 0x4FD18B)
    fo = find_role(roles, FO_ROLE)
    if fo: R["fo"] = fo["id"]; print(f"FO role: {fo['name']} ({fo['id']})")
    else: print(f"⚠️ No '{FO_ROLE}' role found — set the FO_ROLE secret to its name.")

    chans = call("GET", f"/guilds/{GUILD}/channels")
    cids = {c["id"]: c for c in chans}
    overwrites = [{"id": GUILD, "type": 0, "allow": "0", "deny": str(VIEW)},
                  {"id": staff, "type": 0, "allow": str(STAFF_ALLOW), "deny": "0"},
                  {"id": me["id"], "type": 1, "allow": str(STAFF_ALLOW | MENTION_EVERYONE), "deny": "0"}]
    cat = C.get("staffCategory")
    if cat not in cids:
        pos = max([c.get("position", 0) for c in chans if c["type"] == 4] or [0]) + 1
        c = call("POST", f"/guilds/{GUILD}/channels", {"name": "UFA STAFF", "type": 4, "position": pos, "permission_overwrites": overwrites})
        cat = C["staffCategory"] = c["id"]; print(f"Created category UFA STAFF ({cat})")
    for key, name in CHANNELS:
        if C.get(key) in cids: print(f"#{name}: already set up"); continue
        c = call("POST", f"/guilds/{GUILD}/channels", {"name": name, "type": 0, "parent_id": cat, "permission_overwrites": overwrites})
        C[key] = c["id"]; print(f"Created #{name} ({c['id']})")

    want = (os.environ.get("TRANSACTIONS_CHANNEL", "").strip() or "transactions").lstrip("#").lower()
    tx = next((c for c in chans if c["id"] == want), None) or next((c for c in chans if c["type"] in (0, 5) and c["name"].lower() == want), None) \
        or next((c for c in chans if c["type"] in (0, 5) and want in c["name"].lower()), None)
    if tx: C["transactions"] = tx["id"]; print(f"Transactions channel: #{tx['name']} ({tx['id']})")
    else: print(f"⚠️ No channel called #{want} — set the TRANSACTIONS_CHANNEL secret.")

    save("config.json", cfg)
    print("\nSaved config.json. Give the UFA Staff role to your staff, and keep the bot's role ABOVE the team roles,")
    print("General Manager, Head Coach and Franchise owner in Server Settings → Roles.")

if __name__ == "__main__":
    main()
