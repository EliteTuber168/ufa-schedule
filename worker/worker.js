/**
 * UFA League bot — Cloudflare Worker: Discord slash commands/buttons + the FO portal / admin API.
 *
 * Draft:        /pick /onclock /available
 * League:       /schedule /roster /franchises /fa list|join|leave
 * Transactions: /offer /offers /release /demand /trade /promote /demote
 * Staff:        /activity /vote create — plus Approve/Deny (with reason) on requests in #approvals
 * Website API:  /auth/discord, /auth/callback, /api/*  (used by fo.html and admin.html)
 *
 * Worker settings → Variables and Secrets:
 *   DISCORD_PUBLIC_KEY     General Information → Public Key
 *   GITHUB_TOKEN           (secret) fine-grained token, Contents: Read and write on ufa-schedule
 *   DISCORD_BOT_TOKEN      (secret) the bot token — roles, DMs, posts
 *   DISCORD_CLIENT_SECRET  (secret) OAuth2 → Client Secret — "Log in with Discord" on the FO page
 *   COMMISH_IDS            Discord user IDs with staff powers, comma-separated
 *   optional: GUILD_ID, DRAFT_ROLE (default "Draftable"), FO_ROLE (default "Franchise owner"), REPO, SITE_ORIGIN
 * Bindings: KV namespace bound as VOTES (votes, offers, requests, sessions, transaction log).
 * Server IDs (staff role, GM/HC roles, channels) come from config.json, written by the "Set up server" Action.
 */
const BOARD = "https://elitetuber168.github.io/ufa-schedule/draft.html";
const SITE = "https://elitetuber168.github.io/ufa-schedule/";
const APP_ID = "1554632978666229820";
const TZ = "America/New_York";
const DAY = 86400000;
const POS = { QB: "QB", RB: "RB", HB: "RB", WR: "WR", TE: "TE", OL: "OL", DE: "DE", DL: "DE", LB: "LB", MLB: "LB", OLB: "LB",
  CB: "CB", S: "S", FS: "S", SS: "S", DB: "DB", K: "K/P", P: "K/P", KP: "K/P", KR: "KR" };
const RANK = { fo: "Franchise Owner", gm: "General Manager", hc: "Head Coach", player: "Player" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return web(req, url, env, ctx);
    if (req.method !== "POST") return new Response("UFA draft bot is running ✅", { status: 200 });
    const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
    const body = await req.text();
    if (!sig || !ts || !(await verify(env.DISCORD_PUBLIC_KEY, sig, ts + body))) return new Response("Bad signature", { status: 401 });
    const i = JSON.parse(body);
    try {
      if (i.type === 1) return json({ type: 1 });
      if (i.type === 4) return json({ type: 8, data: { choices: await autocomplete(i, env) } });
      if (i.type === 3) return await component(i, env, ctx);
      if (i.type === 5) return await modalSubmit(i, env, ctx);
      if (i.type === 2) return await command(i, env, ctx);
      return reply("Unknown interaction.", true);
    } catch (e) {
      return reply("⚠️ " + (e.user ? e.message : "Something went wrong: " + (e.message || e)), true);
    }
  },
};

// =====================================================================================================
// generic helpers
// =====================================================================================================
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...headers } });
const reply = (content, ephemeral = false) => json({ type: 4, data: { content: String(content).slice(0, 2000), flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });
const hex = (s) => new Uint8Array(s.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
const opt = (opts, name) => (opts || []).find((o) => o.name === name)?.value;
const uidOf = (i) => i.member?.user?.id || i.user?.id;
const UE = (m) => Object.assign(new Error(m), { user: true });          // error safe to show to the user
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const colorInt = (c) => parseInt(String(c || "#3d7bff").replace("#", ""), 16) || 0x3d7bff;
const btn = (label, style, custom_id) => ({ type: 2, style, label, custom_id });
const row = (...c) => ({ type: 1, components: c });
/** Run `work` after answering Discord (so slow work doesn't hit the 3-second limit); its return string edits the reply. */
function later(i, ctx, work, ephemeral = true, update = false) {
  ctx.waitUntil((async () => {
    let out;
    try { out = await work(); } catch (e) { out = "⚠️ " + (e.user ? e.message : "Something went wrong: " + (e.message || e)); }
    if (out == null) return;
    const body = typeof out === "string" ? { content: out.slice(0, 2000) } : out;
    await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowed_mentions: { parse: [] }, ...body }) });
  })());
  return json(update ? { type: 6 } : { type: 5, data: { flags: ephemeral ? 64 : 0 } });
}
/** DM whoever made a request; password logins have no Discord user, so their FO gets it instead. */
async function notify(env, L, uid, team, text) {
  if (uid) return dm(env, uid, text);
  const M = await members(env, L).catch(() => []), fo = team && foOf(L, M, team);
  return fo ? dm(env, fo.id, text) : false;
}
const ref = (id, name) => (id ? `<@${id}>` : `**${name}**`);

async function verify(pub, sig, msg) {
  if (!pub) return false;
  const data = new TextEncoder().encode(msg);
  for (const alg of [{ name: "Ed25519" }, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }]) {
    try {
      const key = await crypto.subtle.importKey("raw", hex(pub), alg, false, ["verify"]);
      return await crypto.subtle.verify(alg.name, key, hex(sig), data);
    } catch (_) { /* try next */ }
  }
  return false;
}

const CACHE = {};
async function cached(key, ms, fn) {
  const c = CACHE[key];
  if (c && Date.now() - c.t < ms) return c.v;
  const v = await fn(); CACHE[key] = { t: Date.now(), v }; return v;
}
const bust = (...keys) => keys.forEach((k) => delete CACHE[k]);

// ---------- GitHub ----------
const repo = (env) => env.REPO || "EliteTuber168/ufa-schedule";
async function gh(env, path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${repo(env)}/contents/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ufa-draft-worker", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const b64e = (s) => { const b = new TextEncoder().encode(s); let o = ""; for (let k = 0; k < b.length; k += 0x8000) o += String.fromCharCode(...b.subarray(k, k + 0x8000)); return btoa(o); };
async function getJSON(env, path) { const f = await gh(env, path); return { D: JSON.parse(b64d(f.content)), sha: f.sha }; }
const putJSON = (env, path, D, sha, message) => gh(env, path, { method: "PUT", body: JSON.stringify({ message, content: b64e(JSON.stringify(D, null, 1) + "\n"), sha }) });
const loadDraft = (env) => getJSON(env, "draft.json");
const loadSched = async (env) => (await getJSON(env, "schedule.json")).D;

// ---------- Discord REST ----------
async function discord(env, method, path, body, reason) {
  if (!env.DISCORD_BOT_TOKEN) throw UE("The bot token isn't set up yet (DISCORD_BOT_TOKEN in the Worker settings).");
  const r = await fetch(`https://discord.com/api/v10${path}`, { method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason).slice(0, 500) } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (r.status === 429) { const w = (await r.json().catch(() => ({}))).retry_after || 1; await new Promise((s) => setTimeout(s, w * 1000 + 200)); return discord(env, method, path, body, reason); }
  if (!r.ok) {
    const e = new Error(`Discord ${r.status}${r.status === 403 ? " (the bot needs Manage Roles and its role above the team/staff roles)" : ""}`); e.status = r.status; throw e;
  }
  return r.status === 204 ? null : r.json();
}
async function dm(env, uid, payload) {
  try {
    const ch = await discord(env, "POST", "/users/@me/channels", { recipient_id: uid });
    await discord(env, "POST", `/channels/${ch.id}/messages`, typeof payload === "string" ? { content: payload } : payload);
    return true;
  } catch { return false; }
}

// =====================================================================================================
// league context
// =====================================================================================================
async function league(env, fresh = false) {
  return cached("league", fresh ? 0 : 30000, async () => {
    const [cfg, S, dr] = await Promise.all([getJSON(env, "config.json").then((x) => x.D).catch(() => ({})), loadSched(env), loadDraft(env)]);
    const D = dr.D, guild = cfg.guild || env.GUILD_ID;
    const R = { ...(cfg.roles || {}) }, C = { ...(cfg.channels || {}) };
    if (guild && env.DISCORD_BOT_TOKEN && (!R.fo || !R.draftable)) {
      const roles = await discord(env, "GET", `/guilds/${guild}/roles`).catch(() => []);
      const byName = (n) => roles.find((r) => r.name.toLowerCase().trim() === n.toLowerCase())?.id;
      R.fo ||= byName(env.FO_ROLE || "Franchise owner");
      R.draftable ||= byName(env.DRAFT_ROLE || "Draftable");
    }
    const teams = S.teams.map((t) => {
      const d = D.teams.find((x) => x.abbr === t.abbr) || {};
      return { abbr: t.abbr, name: t.name, color: t.color, roleId: d.roleId || (/^\d{6,}$/.test(t.role || "") ? t.role : "") };
    });
    const settings = { rosterCap: 25, signingFreeze: false, minPlayers: 5, requireFO: true, ...(S.settings || {}) };
    return { guild, R, C, teams, settings, draftStatus: D.status };
  });
}
const teamOf = (L, abbr) => L.teams.find((t) => t.abbr === abbr);
async function members(env, L, fresh = false) {
  if (!L.guild) throw UE("The server isn't set up yet — run the \"Set up server\" Action on GitHub.");
  return cached("members", fresh ? 0 : 15000, async () => {
    const out = []; let after = "0";
    for (;;) {
      const page = await discord(env, "GET", `/guilds/${L.guild}/members?limit=1000&after=${after}`);
      out.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1].user.id;
    }
    return out.filter((m) => !m.user.bot);
  });
}
const display = (m) => m.nick || m.user.global_name || m.user.username;
function avatarUrl(gid, m) {
  const u = m.user;
  if (m.avatar) return `https://cdn.discordapp.com/guilds/${gid}/users/${u.id}/avatars/${m.avatar}.png?size=96`;
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=96`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
}
function info(L, m) {
  const roles = m.roles || [];
  const team = L.teams.find((t) => t.roleId && roles.includes(t.roleId));
  const rank = !team ? null : L.R.fo && roles.includes(L.R.fo) ? "fo" : L.R.gm && roles.includes(L.R.gm) ? "gm" : L.R.hc && roles.includes(L.R.hc) ? "hc" : "player";
  return { id: m.user.id, name: display(m), avatar: avatarUrl(L.guild, m), team: team?.abbr || null, rank, staff: !!(L.R.staff && roles.includes(L.R.staff)) };
}
const rosterOf = (L, M, abbr) => { const t = teamOf(L, abbr); return t?.roleId ? M.filter((m) => (m.roles || []).includes(t.roleId)).map((m) => info(L, m)) : []; };
const foOf = (L, M, abbr) => rosterOf(L, M, abbr).find((p) => p.rank === "fo");
function isStaff(env, L, uid, roles = [], perms) {
  if (String(env.COMMISH_IDS || "").split(/[\s,]+/).includes(uid)) return true;
  if (L?.R?.staff && roles.includes(L.R.staff)) return true;
  if (env.COMMISH_ROLE_ID && roles.includes(env.COMMISH_ROLE_ID)) return true;
  try { return perms != null && (BigInt(perms) & 0x28n) !== 0n; } catch { return false; }
}
async function actorFromUid(env, L, uid, perms) {
  const M = await members(env, L), m = M.find((x) => x.user.id === uid);
  if (!m) return { id: uid, name: "Unknown", team: null, rank: null, staff: isStaff(env, L, uid, [], perms) };
  const a = info(L, m); a.staff = isStaff(env, L, uid, m.roles, perms); return a;
}
const actorFromInteraction = (env, L, i) => actorFromUid(env, L, uidOf(i), i.member?.permissions);
const who = (a) => (a.id ? `<@${a.id}>` : `**${a.name}**`);
const can = (a, what) => ({ offer: ["fo", "gm", "hc"], release: ["fo", "gm"], trade: ["fo", "gm"], promote: ["fo"] }[what] || []).includes(a.rank);

// ---------- storage (KV) ----------
const KV = (env) => { if (!env.VOTES) throw UE("Storage isn't set up (the Worker needs the VOTES KV binding)."); return env.VOTES; };
const kget = async (env, k) => JSON.parse((await KV(env).get(k)) || "null");
const kput = (env, k, v, ttl, metadata) => KV(env).put(k, JSON.stringify(v), { expirationTtl: ttl, ...(metadata ? { metadata } : {}) });
async function klist(env, prefix) {
  const out = []; let cursor;
  do { const r = await KV(env).list({ prefix, cursor }); out.push(...r.keys); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}

// ---------- roles / posts ----------
const addRole = (env, L, uid, r, why) => r && discord(env, "PUT", `/guilds/${L.guild}/members/${uid}/roles/${r}`, null, why);
const delRole = (env, L, uid, r, why) => r && discord(env, "DELETE", `/guilds/${L.guild}/members/${uid}/roles/${r}`, null, why);
async function stripTeam(env, L, uid, abbr, why) {
  await delRole(env, L, uid, teamOf(L, abbr)?.roleId, why);
  for (const r of [L.R.gm, L.R.hc]) await delRole(env, L, uid, r, why).catch(() => {});
}
// ---------- transaction posts (TeamSign-style embeds: team logo, role mentions, usernames, details block) ----------
const guildEmojis = (env, L) => cached("emojis", 600000, () => discord(env, "GET", `/guilds/${L.guild}/emojis`).catch(() => []));
function teamEmoji(E, t) {
  const nick = t.name.split(" ").pop().toLowerCase(), ab = t.abbr.toLowerCase();
  return E.find((x) => x.name.toLowerCase() === nick || x.name.toLowerCase() === ab) || E.find((x) => x.name.toLowerCase().includes(nick)) || null;
}
const emojiTag = (e) => `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;
const emojiUrl = (e) => `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}?size=128`;
const brandIcon = (env, L) => cached("brand", 3600000, async () => {
  const g = await discord(env, "GET", `/guilds/${L.guild}`).catch(() => null);
  return g?.icon ? `https://cdn.discordapp.com/icons/${L.guild}/${g.icon}.${g.icon.startsWith("a_") ? "gif" : "png"}?size=64` : null;
});
/** title, desc and lines may use <@id> and **Team Name**; they're turned into mentions + `username` and team emoji + role mention. */
async function logTx(env, L, { title, desc, color, teams = [], lines = [] }) {
  const ts = Date.now();
  const [E, M, icon] = await Promise.all([guildEmojis(env, L), members(env, L).catch(() => []), brandIcon(env, L)]);
  const main = teamOf(L, teams[0]);
  const dress = (txt) => {
    let d = String(txt);
    for (const a of teams) { const t = teamOf(L, a); if (!t) continue; const e = teamEmoji(E, t);
      d = d.split(`the **${t.name}**`).join(`${e ? emojiTag(e) + " " : ""}${t.roleId ? `<@&${t.roleId}>` : `**${t.name}**`}`); }
    return d.replace(/<@(\d+)>/g, (s, id) => { const m = M.find((x) => x.user.id === id); return m ? `${s} \`${m.user.username}\`` : s; });
  };
  const body = dress(desc) + (lines.length ? "\n\n" + lines.map((l) => `> • ${dress(l)}`).join("\n") : "");
  const logo = main && teamEmoji(E, main);
  if (L.C.transactions) {
    await discord(env, "POST", `/channels/${L.C.transactions}/messages`, { allowed_mentions: { parse: [] }, embeds: [{
      author: { name: "Transactions", ...(icon ? { icon_url: icon } : {}) }, title, description: body.slice(0, 4000),
      color: color ?? (main ? colorInt(main.color) : 0x3d7bff), ...(logo ? { thumbnail: { url: emojiUrl(logo) } } : {}),
      footer: { text: "UFA League" }, timestamp: new Date(ts).toISOString() }] }).catch(() => {});
  }
  if (env.VOTES) await kput(env, `tx:${String(9e12 - ts).padStart(13, "0")}`, { title, desc: [desc, ...lines].join("\n"), teams, ts }, 90 * 86400).catch(() => {});
}
const capLine = (L, n) => `🔋 Roster Cap · \`${n}/${cap(L)}\``;
const cap = (L) => Number(L.settings.rosterCap) || 25;
function frozen(L) {
  if (L.settings.signingFreeze) return "🧊 Signings and trades are frozen right now.";
  if (["live", "paused"].includes(L.draftStatus)) return "🏈 Signings and trades are paused while the draft is running.";
  return null;
}

// =====================================================================================================
// transactions core (shared by slash commands, buttons and the website)
// =====================================================================================================
async function makeOffer(env, L, actor, uid) {
  if (!can(actor, "offer")) throw UE("Only franchise owners, GMs and head coaches can send offers.");
  const f = frozen(L); if (f) throw UE(f);
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const t = info(L, m), team = teamOf(L, actor.team);
  if (t.team) throw UE(`**${t.name}** is already on the ${teamOf(L, t.team).name}. Only free agents can be offered.`);
  const n = rosterOf(L, M, actor.team).length;
  if (n >= cap(L)) throw UE(`Your roster is full (${n}/${cap(L)}).`);
  const open = (await klist(env, "offer:")).filter((k) => k.metadata?.uid === uid && k.metadata?.team === actor.team && k.metadata?.status === "pending" && k.metadata.exp > Date.now());
  if (open.length) throw UE(`You already have a pending offer out to **${t.name}**.`);
  const o = { id: rid(), team: actor.team, uid, name: t.name, by: actor.id, byName: actor.name, byRank: actor.rank, ts: Date.now(), exp: Date.now() + DAY, status: "pending" };
  await saveOffer(env, o);
  const sent = await dm(env, uid, { embeds: [{ title: `📝 Contract offer — ${team.name}`, color: colorInt(team.color),
      description: `${who(actor)} (${RANK[actor.rank] || "front office"}) wants to sign you to the **${team.name}**.\nRoster: ${n}/${cap(L)}\n\nThis offer expires <t:${Math.floor(o.exp / 1000)}:R>.` }],
    components: [row(btn("✅ Accept", 3, `oa:${o.id}`), btn("❌ Decline", 4, `od:${o.id}`))] });
  return { offer: o, text: `📨 Offer sent to **${t.name}** for the ${team.name}. They have 24 hours to accept.` + (sent ? "" : "\n⚠️ Their DMs are closed — they can accept with **/offers** in the server.") };
}
const saveOffer = (env, o) => kput(env, `offer:${o.id}`, o, 3 * 86400, { team: o.team, uid: o.uid, status: o.status, exp: o.exp });

async function answerOffer(env, id, uid, accept) {
  const o = await kget(env, `offer:${id}`);
  if (!o) return "This offer no longer exists.";
  if (o.uid !== uid) return "This offer isn't for you.";
  if (o.status !== "pending") return `You already ${o.status === "accepted" ? "accepted" : "answered"} this offer.`;
  const L = await league(env, true), team = teamOf(L, o.team);
  if (Date.now() > o.exp) { o.status = "expired"; await saveOffer(env, o); return "⌛ This offer has expired."; }
  if (!accept) {
    o.status = "declined"; await saveOffer(env, o);
    await notify(env, L, o.by, o.team, `❌ **${o.name}** declined your offer to join the ${team.name}.`);
    return `You declined the ${team.name}'s offer.`;
  }
  const f = frozen(L); if (f) return f + " Try again once they're open.";
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) return "You're not in the server anymore.";
  const me = info(L, m);
  if (me.team) { o.status = "void"; await saveOffer(env, o); return `You're already on the ${teamOf(L, me.team).name}.`; }
  const n = rosterOf(L, M, o.team).length;
  if (n >= cap(L)) return `Sorry — the ${team.name} roster is full (${n}/${cap(L)}).`;
  await addRole(env, L, uid, team.roleId, `Signed via offer from ${o.byName}`);
  await delRole(env, L, uid, L.R.draftable, "Signed with a team").catch(() => {});
  o.status = "accepted"; o.answered = Date.now(); await saveOffer(env, o);
  for (const k of await klist(env, "offer:")) if (k.metadata?.uid === uid && k.metadata?.status === "pending" && k.name !== `offer:${id}`) {
    const x = await kget(env, k.name); if (x) { x.status = "void"; await saveOffer(env, x); }
  }
  bust("members");
  await logTx(env, L, { title: "Offer Accepted", teams: [o.team], desc: `<@${uid}> has accepted the offer to the **${team.name}**`,
    lines: [`👤 ${o.byRank === "hc" ? "Coach" : o.byRank === "gm" ? "General Manager" : "Franchise Owner"} · ${ref(o.by, o.byName)}`, capLine(L, n + 1)] });
  await notify(env, L, o.by, o.team, `✅ **${o.name}** accepted and is now on the ${team.name}! Roster ${n + 1}/${cap(L)}.`);
  return `🎉 Welcome to the **${team.name}**!`;
}

async function releasePlayer(env, L, actor, uid) {
  if (!can(actor, "release") && !actor.staff) throw UE("Only franchise owners and GMs can release players.");
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const t = info(L, m);
  if (!t.team || (!actor.staff && t.team !== actor.team)) throw UE(`**${t.name}** isn't on your team.`);
  if (t.rank === "fo") throw UE("You can't release a franchise owner. Staff handle FO changes.");
  if (actor.rank === "gm" && ["gm", "hc"].includes(t.rank)) throw UE("Only the franchise owner can release team staff.");
  const team = teamOf(L, t.team), n = rosterOf(L, M, t.team).length - 1;
  await stripTeam(env, L, uid, t.team, `Released by ${actor.name}`);
  bust("members");
  await logTx(env, L, { title: "Player Released", teams: [t.team], desc: `<@${uid}> has been released from the **${team.name}**`,
    lines: [`👤 Released by · ${actor.id ? `<@${actor.id}>` : `**${actor.name}**`}${actor.staff && !actor.team ? " (staff)" : ""}`, capLine(L, n)] });
  await dm(env, uid, `🧾 You've been released by the **${team.name}**. You're now a free agent.`);
  return `🧾 **${t.name}** has been released.`;
}

async function demand(env, L, actor, reason) {
  if (!actor.team) throw UE("You're not on a team.");
  if (actor.rank === "fo") throw UE("Franchise owners can't demand — talk to staff.");
  const open = await kget(env, `dem:${actor.id}`);
  if (open && (await kget(env, `req:${open}`))?.status === "staff") throw UE("You already have a demand waiting for staff.");
  const r = { id: rid(), type: "demand", status: "staff", uid: actor.id, name: actor.name, team: actor.team, reason: reason || "", ts: Date.now() };
  await postApproval(env, L, r);
  await saveReq(env, r); await kput(env, `dem:${actor.id}`, r.id, 30 * 86400);
  return "📨 Your demand was sent to staff. You'll get a DM when they decide.";
}

async function promote(env, L, actor, uid, role, reason) {
  if (!can(actor, "promote")) throw UE("Only franchise owners can promote players.");
  if (!["gm", "hc"].includes(role)) throw UE("Pick General Manager or Head Coach.");
  if (!L.R[role]) throw UE("The GM/HC roles aren't set up yet — run the \"Set up server\" Action.");
  if (!String(reason || "").trim()) throw UE("Add a reason for the promotion.");
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const t = info(L, m);
  if (t.team !== actor.team) throw UE(`**${t.name}** isn't on your team.`);
  if (t.rank === role) throw UE(`**${t.name}** is already your ${RANK[role]}.`);
  if (t.rank === "fo") throw UE("That's the franchise owner.");
  const r = { id: rid(), type: "promote", status: "staff", uid, name: t.name, team: actor.team, role, reason: String(reason).trim(), by: actor.id, byName: actor.name, ts: Date.now() };
  await postApproval(env, L, r); await saveReq(env, r);
  return `📨 Promotion of **${t.name}** to ${RANK[role]} sent to staff for approval.`;
}

async function demote(env, L, actor, uid) {
  if (!can(actor, "promote") && !actor.staff) throw UE("Only franchise owners can demote staff.");
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const t = info(L, m);
  if (!t.team || (!actor.staff && t.team !== actor.team)) throw UE(`**${t.name}** isn't on your team.`);
  if (!["gm", "hc"].includes(t.rank)) throw UE(`**${t.name}** isn't a GM or head coach.`);
  await delRole(env, L, uid, L.R[t.rank], `Demoted by ${actor.name}`);
  bust("members");
  const team = teamOf(L, t.team);
  await logTx(env, L, { title: "Demotion", teams: [t.team], desc: `<@${uid}> is no longer **${RANK[t.rank]}** of the **${team.name}**`, lines: [`👤 By · ${who(actor)}`] });
  await dm(env, uid, `📉 You're no longer ${RANK[t.rank]} of the ${team.name}. You're still on the roster.`);
  return `📉 **${t.name}** is no longer ${RANK[t.rank]}.`;
}

async function proposeTrade(env, L, actor, toAbbr, give, get) {
  if (!can(actor, "trade")) throw UE("Only franchise owners and GMs can trade.");
  const f = frozen(L); if (f) throw UE(f);
  const to = teamOf(L, toAbbr), from = teamOf(L, actor.team);
  if (!to) throw UE("Pick the team you're trading with.");
  if (to.abbr === from.abbr) throw UE("You can't trade with yourself.");
  give = [...new Set(give.filter(Boolean))]; get = [...new Set(get.filter(Boolean))];
  if (!give.length && !get.length) throw UE("Add at least one player.");
  const M = await members(env, L, true), I = (u) => { const m = M.find((x) => x.user.id === u); return m ? info(L, m) : null; };
  for (const u of give) { const p = I(u); if (!p || p.team !== from.abbr) throw UE(`${p ? `**${p.name}**` : "A player you're giving"} isn't on your team.`); if (p.rank === "fo") throw UE("Franchise owners can't be traded."); }
  for (const u of get) { const p = I(u); if (!p || p.team !== to.abbr) throw UE(`${p ? `**${p.name}**` : "A player you asked for"} isn't on the ${to.name}.`); if (p.rank === "fo") throw UE("Franchise owners can't be traded."); }
  const nf = rosterOf(L, M, from.abbr).length - give.length + get.length, nt = rosterOf(L, M, to.abbr).length - get.length + give.length;
  if (nf > cap(L)) throw UE(`That would put you over the roster cap (${nf}/${cap(L)}).`);
  if (nt > cap(L)) throw UE(`That would put the ${to.name} over the roster cap (${nt}/${cap(L)}).`);
  const names = (us) => us.map((u) => I(u).name);
  const r = { id: rid(), type: "trade", status: "other", from: from.abbr, to: to.abbr, give, get, giveNames: names(give), getNames: names(get), by: actor.id, byName: actor.name, ts: Date.now() };
  await saveReq(env, r);
  const deciders = rosterOf(L, M, to.abbr).filter((p) => p.rank === "fo" || p.rank === "gm");
  const payload = { embeds: [{ title: `🔁 Trade offer from the ${from.name}`, color: colorInt(from.color), description: tradeText(L, r) + `\n\nProposed by ${ref(r.by, r.byName)}. If you accept, it goes to staff for final approval.` }],
    components: [row(btn("✅ Accept trade", 3, `ta:${r.id}`), btn("❌ Decline", 4, `td:${r.id}`))] };
  let sent = 0; for (const d of deciders) if (await dm(env, d.id, payload)) sent++;
  return { req: r, text: `📨 Trade sent to the ${to.name}.` + (sent ? "" : " ⚠️ Couldn't DM their FO/GM — they can answer on the FO page.") };
}
function tradeText(L, r) {
  const list = (us) => us.length ? us.map((u) => `<@${u}>`).join(", ") : "nothing";
  return `**${teamOf(L, r.from).name}** send: ${list(r.give)}\n**${teamOf(L, r.to).name}** send: ${list(r.get)}`;
}
async function answerTrade(env, L, actor, id, accept) {
  const r = await kget(env, `req:${id}`);
  if (!r || r.type !== "trade") return "This trade no longer exists.";
  if (r.status !== "other") return "This trade was already answered.";
  if (!(actor.team === r.to && can(actor, "trade"))) return `Only the ${teamOf(L, r.to).name} FO or GM can answer this.`;
  if (!accept) {
    r.status = "declined"; r.answeredBy = actor.id; await saveReq(env, r);
    await notify(env, L, r.by, r.from, `❌ The ${teamOf(L, r.to).name} declined your trade.\n${tradeText(L, r)}`);
    return "❌ Trade declined.";
  }
  r.status = "staff"; r.acceptedBy = actor.id;
  await postApproval(env, L, r); await saveReq(env, r);
  await notify(env, L, r.by, r.from, `✅ The ${teamOf(L, r.to).name} accepted your trade. It's now waiting for staff approval.`);
  return "✅ Trade accepted — it's now waiting for staff approval.";
}

// ---------- staff approvals ----------
const saveReq = (env, r) => kput(env, `req:${r.id}`, r, 60 * 86400, { type: r.type, status: r.status, team: r.team || r.from, to: r.to || null });
function reqEmbed(L, r) {
  const t = teamOf(L, r.team || r.from) || {};
  const base = r.type === "demand" ? { title: "🚪 Demand request", description: `<@${r.uid}> wants to leave the **${t.name}**.` + (r.reason ? `\nReason: ${r.reason}` : "") }
    : r.type === "promote" ? { title: "📈 Promotion request", description: `${ref(r.by, r.byName)} (FO, ${t.name}) wants to make <@${r.uid}> **${RANK[r.role]}**.\nReason: ${r.reason}` }
    : { title: "🔁 Trade — accepted by both teams", description: tradeText(L, r) };
  const fields = [];
  if (r.status !== "staff") fields.push({ name: r.status === "approved" ? "✅ Approved" : r.status === "denied" ? "❌ Denied" : "⚠️ " + r.status, value: `${r.decidedByName || "Staff"}: ${r.decisionReason || "—"}`.slice(0, 1000) });
  return { ...base, color: r.status === "approved" ? 0x4fd18b : r.status === "denied" ? 0xe8424a : colorInt(t.color), fields, timestamp: new Date(r.ts).toISOString() };
}
async function postApproval(env, L, r) {
  if (!L.C.approvals) throw UE("The staff approvals channel isn't set up yet — run the \"Set up server\" Action.");
  const msg = await discord(env, "POST", `/channels/${L.C.approvals}/messages`, { embeds: [reqEmbed(L, r)], allowed_mentions: { parse: [] },
    components: [row(btn("✅ Approve", 3, `ra:${r.id}`), btn("❌ Deny", 4, `rd:${r.id}`))] });
  r.msg = { ch: L.C.approvals, id: msg.id };
}
async function decide(env, id, approve, reason, staff) {
  const L = await league(env, true), r = await kget(env, `req:${id}`);
  if (!r) throw UE("That request no longer exists.");
  if (r.status !== "staff") throw UE("That request was already handled.");
  reason = String(reason || "").trim(); if (!reason) throw UE("A reason is required.");
  const M = await members(env, L, true), I = (u) => { const m = M.find((x) => x.user.id === u); return m ? info(L, m) : null; };
  let result = approve ? "approved" : "denied", note = "";
  const t = teamOf(L, r.team || r.from);
  if (approve) {
    if (r.type === "demand") {
      const p = I(r.uid);
      if (p?.team === r.team) await stripTeam(env, L, r.uid, r.team, `Demand approved by ${staff.name}`);
      await logTx(env, L, { title: "Demand Successful", teams: [r.team], desc: `<@${r.uid}> has demanded from the **${t.name}**`,
        lines: [`🛡️ Approved by · ${staff.id ? `<@${staff.id}>` : `**${staff.name}**`}`, capLine(L, rosterOf(L, M, r.team).length - (p?.team === r.team ? 1 : 0))] });
      await dm(env, r.uid, `✅ Your demand to leave the ${t.name} was approved. You're now a free agent.\nStaff note: ${reason}`);
      const fo = foOf(L, M, r.team); if (fo) await dm(env, fo.id, `🚪 **${r.name}** has left the ${t.name} (demand approved).\nStaff note: ${reason}`);
    } else if (r.type === "promote") {
      const p = I(r.uid);
      if (p?.team !== r.team) { result = "failed"; note = `${r.name} is no longer on the team.`; }
      else {
        await addRole(env, L, r.uid, L.R[r.role], `Promotion approved by ${staff.name}`);
        const other = r.role === "gm" ? "hc" : "gm"; if (p.rank === other) await delRole(env, L, r.uid, L.R[other]).catch(() => {});
        await logTx(env, L, { title: "Promotion", teams: [r.team], desc: `<@${r.uid}> has been promoted to **${RANK[r.role]}** of the **${t.name}**`,
          lines: [`👑 Requested by · ${ref(r.by, r.byName)}`, `🛡️ Approved by · ${staff.id ? `<@${staff.id}>` : `**${staff.name}**`}`] });
        await dm(env, r.uid, `📈 You've been promoted to **${RANK[r.role]}** of the ${t.name}!`);
        await notify(env, L, r.by, r.team, `✅ Your promotion of **${r.name}** to ${RANK[r.role]} was approved.\nStaff note: ${reason}`);
      }
    } else if (r.type === "trade") {
      const from = teamOf(L, r.from), to = teamOf(L, r.to);
      const bad = [...r.give.filter((u) => I(u)?.team !== r.from), ...r.get.filter((u) => I(u)?.team !== r.to)];
      const nf = rosterOf(L, M, r.from).length - r.give.length + r.get.length, nt = rosterOf(L, M, r.to).length - r.get.length + r.give.length;
      if (bad.length) { result = "failed"; note = "Some players aren't on those teams anymore."; }
      else if (nf > cap(L) || nt > cap(L)) { result = "failed"; note = "A team would go over the roster cap."; }
      else {
        for (const u of r.give) { await stripTeam(env, L, u, r.from, "Trade"); await addRole(env, L, u, to.roleId, "Trade"); }
        for (const u of r.get) { await stripTeam(env, L, u, r.to, "Trade"); await addRole(env, L, u, from.roleId, "Trade"); }
        const lst = (us) => us.length ? us.map((u) => `<@${u}>`).join(", ") : "nothing";
        await logTx(env, L, { title: "Trade Accepted", teams: [r.from, r.to], desc: `the **${from.name}** and the **${to.name}** have completed a trade`,
          lines: [`📤 ${from.abbr} send · ${lst(r.give)}`, `📥 ${to.abbr} send · ${lst(r.get)}`, `🛡️ Approved by · ${staff.id ? `<@${staff.id}>` : `**${staff.name}**`}`,
            `🔋 Roster Cap · ${from.abbr} \`${nf}/${cap(L)}\` · ${to.abbr} \`${nt}/${cap(L)}\``] });
        for (const u of [...r.give, ...r.get]) await dm(env, u, `🔁 You've been traded! Check #transactions for the details.`);
      }
      const msg = result === "approved" ? `✅ Trade approved!\n${tradeText(L, r)}\nStaff note: ${reason}` : `⚠️ The trade couldn't go through: ${note}`;
      for (const a of [foOf(L, M, r.from), foOf(L, M, r.to)]) if (a) await dm(env, a.id, msg);
    }
  } else {
    const deny = `❌ Staff denied your ${r.type === "demand" ? "demand" : r.type === "promote" ? `promotion of ${r.name}` : "trade"}.\nReason: ${reason}`;
    if (r.type === "demand") await dm(env, r.uid, deny);
    else if (r.type === "promote") await notify(env, L, r.by, r.team, deny);
    else for (const a of [foOf(L, M, r.from), foOf(L, M, r.to)]) if (a) await dm(env, a.id, deny);
  }
  r.status = result; r.decidedBy = staff.id; r.decidedByName = staff.name; r.decisionReason = note ? `${reason} (${note})` : reason; r.decidedAt = Date.now();
  await saveReq(env, r); bust("members");
  if (r.msg) await discord(env, "PATCH", `/channels/${r.msg.ch}/messages/${r.msg.id}`, { embeds: [reqEmbed(L, r)], components: [] }).catch(() => {});
  return r;
}

async function appoint(env, L, abbr, uid, staffName) {
  const t = teamOf(L, abbr); if (!t?.roleId) throw UE("That team has no Discord role linked.");
  if (!L.R.fo) throw UE("No Franchise owner role found.");
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const p = info(L, m);
  // a team should have exactly one FO — take the role off every other FO on this team
  for (const old of rosterOf(L, M, abbr).filter((x) => x.rank === "fo" && x.id !== uid)) await delRole(env, L, old.id, L.R.fo, `FO replaced by ${staffName}`);
  if (p.team && p.team !== abbr) await stripTeam(env, L, uid, p.team, "Appointed FO of another team");
  await addRole(env, L, uid, t.roleId, `Appointed FO by ${staffName}`);
  await addRole(env, L, uid, L.R.fo, `Appointed FO by ${staffName}`);
  for (const r of [L.R.gm, L.R.hc]) await delRole(env, L, uid, r).catch(() => {});
  bust("members");
  await logTx(env, L, { title: "Franchise Owner Appointed", teams: [abbr], desc: `<@${uid}> is the new franchise owner of the **${t.name}**`, lines: [`🛡️ Appointed by · **${staffName}**`] });
  await dm(env, uid, `👑 You've been appointed franchise owner of the **${t.name}**! Manage your team at ${SITE}fo.html`);
  return `👑 ${p.name} is now FO of the ${t.name}.`;
}
async function unappoint(env, L, abbr, staffName) {
  const M = await members(env, L, true), fos = rosterOf(L, M, abbr).filter((x) => x.rank === "fo"), fo = fos[0], t = teamOf(L, abbr);
  if (!fo) throw UE("That team has no FO.");
  for (const x of fos) await delRole(env, L, x.id, L.R.fo, `FO removed by ${staffName}`);
  bust("members");
  await logTx(env, L, { title: "Franchise Owner Removed", teams: [abbr], desc: `${fos.map((x) => `<@${x.id}>`).join(", ")} ${fos.length > 1 ? "are" : "is"} no longer franchise owner of the **${t.name}**`, lines: [`🛡️ By · **${staffName}**`] });
  return `${fo.name} is no longer FO of the ${t.name}.`;
}

// ---------- staff overrides (admin page) ----------
async function staffAssign(env, L, staff, uid, abbr) {
  const t = teamOf(L, abbr); if (!t?.roleId) throw UE("That team has no Discord role linked.");
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const p = info(L, m);
  if (p.team === abbr) throw UE(`${p.name} is already on the ${t.name}.`);
  if (p.rank === "fo") throw UE(`${p.name} is a franchise owner — remove them as FO first (or appoint them to the new team).`);
  const n = rosterOf(L, M, abbr).length;
  if (n >= cap(L)) throw UE(`The ${t.name} roster is full (${n}/${cap(L)}). Raise the cap in Settings or remove someone first.`);
  const from = p.team && teamOf(L, p.team);
  if (from) await stripTeam(env, L, uid, p.team, `Moved by ${staff.name}`);
  await addRole(env, L, uid, t.roleId, `Assigned by ${staff.name}`);
  await delRole(env, L, uid, L.R.draftable, "Assigned to a team").catch(() => {});
  bust("members");
  await logTx(env, L, { title: from ? "Roster Move" : "Staff Signing", teams: [abbr, ...(from ? [from.abbr] : [])],
    desc: from ? `<@${uid}> has been moved from the **${from.name}** to the **${t.name}**` : `<@${uid}> has been added to the **${t.name}**`,
    lines: [`🛡️ By · **${staff.name}**`, capLine(L, n + 1)] });
  await dm(env, uid, from ? `🔀 Staff moved you from the ${from.name} to the **${t.name}**.` : `📋 Staff added you to the **${t.name}**!`);
  return from ? `${p.name} moved from the ${from.name} to the ${t.name}.` : `${p.name} added to the ${t.name}.`;
}
async function staffTitle(env, L, staff, uid, role) {
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const p = info(L, m);
  if (!p.team) throw UE(`${p.name} isn't on a team.`);
  if (p.rank === "fo") throw UE(`${p.name} is the franchise owner.`);
  if (!["gm", "hc", "none"].includes(role)) throw UE("Pick General Manager, Head Coach or no title.");
  if (role !== "none" && !L.R[role]) throw UE("The GM/HC roles aren't set up yet.");
  if ((p.rank === "player" && role === "none") || p.rank === role) throw UE(`${p.name} already has that title.`);
  for (const r of ["gm", "hc"]) if (r !== role && p.rank === r) await delRole(env, L, uid, L.R[r], `Title changed by ${staff.name}`);
  if (role !== "none") await addRole(env, L, uid, L.R[role], `Title set by ${staff.name}`);
  bust("members");
  const t = teamOf(L, p.team);
  await logTx(env, L, { title: role === "none" ? "Demotion" : "Promotion", teams: [p.team],
    desc: role === "none" ? `<@${uid}> is no longer **${RANK[p.rank]}** of the **${t.name}**` : `<@${uid}> has been promoted to **${RANK[role]}** of the **${t.name}**`,
    lines: [`🛡️ By · **${staff.name}**`] });
  if (role !== "none") await dm(env, uid, `📈 You're now **${RANK[role]}** of the ${t.name}!`);
  return role === "none" ? `${p.name} no longer has a title.` : `${p.name} is now ${RANK[role]} of the ${t.name}.`;
}
async function staffRole(env, L, staff, uid, on) {
  if (!L.R.staff) throw UE("The UFA Staff role isn't set up yet.");
  const M = await members(env, L, true), m = M.find((x) => x.user.id === uid);
  if (!m) throw UE("That person isn't in the server.");
  const has = (m.roles || []).includes(L.R.staff), name = display(m);
  if (has === on) throw UE(on ? `${name} is already staff.` : `${name} isn't staff.`);
  await (on ? addRole : delRole)(env, L, uid, L.R.staff, `${on ? "Given" : "Removed"} by ${staff.name}`);
  bust("members");
  if (on) await dm(env, uid, "🛡️ You've been made **UFA Staff**. You can now see the staff channels and approve requests.");
  return on ? `${name} is now UFA Staff.` : `${name} is no longer staff.`;
}

// ---------- danger zone (bulk role changes, run in small batches) ----------
const DANGER = {
  wipe_all:     { phrase: "WIPE ALL",     label: "Wipe all teams",               tx: "🧹 All rosters have been cleared" },
  wipe_keep_fo: { phrase: "WIPE PLAYERS", label: "Wipe players (keep FOs)",      tx: "🧹 All rosters have been cleared — franchise owners stay" },
  clear_titles: { phrase: "CLEAR TITLES", label: "Remove every GM / HC title",   tx: "📉 All GM and Head Coach titles have been removed" },
  clear_fos:    { phrase: "REMOVE FOS",   label: "Remove every franchise owner", tx: "👑 All franchise owner roles have been removed" },
  restore:      { phrase: "RESTORE",      label: "Undo last wipe",               tx: "↩️ Rosters have been restored" },
};
const BATCH = 15;
function planOps(L, M, action) {
  const teamIds = new Set(L.teams.map((t) => t.roleId).filter(Boolean)), titles = [L.R.gm, L.R.hc].filter(Boolean);
  const ops = [];
  for (const m of M) {
    const roles = m.roles || [], isFo = !!L.R.fo && roles.includes(L.R.fo);
    let rm = [];
    if (action === "wipe_all") rm = roles.filter((r) => teamIds.has(r) || titles.includes(r) || r === L.R.fo);
    else if (action === "wipe_keep_fo") rm = roles.filter((r) => titles.includes(r) || (!isFo && teamIds.has(r)));
    else if (action === "clear_titles") rm = roles.filter((r) => titles.includes(r));
    else if (action === "clear_fos") rm = roles.filter((r) => r === L.R.fo);
    for (const r of rm) ops.push([m.user.id, r]);
  }
  return ops;
}
async function dangerPreview(env, L) {
  const M = await members(env, L, true), out = {};
  for (const a of ["wipe_all", "wipe_keep_fo", "clear_titles", "clear_fos"]) { const ops = planOps(L, M, a); out[a] = { ops: ops.length, people: new Set(ops.map((o) => o[0])).size }; }
  const b = await kget(env, "backup:latest"), job = await kget(env, "job:current");
  const kv = {};
  for (const pre of ["offer:", "req:", "sess:", "pw:", "tx:"]) kv[pre.slice(0, -1)] = (await klist(env, pre)).filter((k) => pre === "offer:" ? k.metadata?.status === "pending" : pre === "req:" ? ["staff", "other"].includes(k.metadata?.status) : true).length;
  return { counts: out, backup: b ? { action: b.action, label: DANGER[b.action]?.label, ts: b.ts, by: b.by, ops: b.ops.length, people: new Set(b.ops.map((o) => o[0])).size } : null,
    job: job ? { action: job.action, i: job.i, total: job.ops.length } : null, kv, phrases: Object.fromEntries(Object.entries(DANGER).map(([k, v]) => [k, v.phrase])) };
}
async function dangerRun(env, L, admin, body) {
  let job = await kget(env, "job:current");
  if (!job) {
    const a = body.action, d = DANGER[a];
    if (!d) throw UE("Unknown action.");
    if (String(body.confirm || "").trim().toUpperCase() !== d.phrase) throw UE(`Type ${d.phrase} to confirm.`);
    let ops;
    if (a === "restore") { const b = await kget(env, "backup:latest"); if (!b) throw UE("There's nothing to undo."); ops = b.ops; }
    else ops = planOps(L, await members(env, L, true), a);
    job = { id: rid(), action: a, ops, i: 0, add: a === "restore", announce: !!body.announce, by: admin.name, ts: Date.now(), errors: 0 };
    if (a !== "restore" && ops.length) await kput(env, "backup:latest", { action: a, ops, ts: job.ts, by: admin.name }, 60 * 86400);
    if (a === "restore") await KV(env).delete("backup:latest");
  } else if (body.action && body.action !== job.action) {
    throw UE(`"${DANGER[job.action].label}" is still running (${job.i}/${job.ops.length}) — let it finish first.`);
  }
  const end = Math.min(job.ops.length, job.i + BATCH);
  for (; job.i < end; job.i++) {
    const [u, r] = job.ops[job.i];
    try { await discord(env, job.add ? "PUT" : "DELETE", `/guilds/${L.guild}/members/${u}/roles/${r}`, null, `${DANGER[job.action].label} (by ${job.by})`); }
    catch (e) { if (e.status === 403) { await kput(env, "job:current", job, 3600); throw UE("Discord refused a role change — the bot's role must sit above the team, FO, GM and HC roles. Fix that, then press Continue."); } if (e.status !== 404) job.errors++; }
  }
  bust("members");
  if (job.i < job.ops.length) { await kput(env, "job:current", job, 3600); return { done: false, i: job.i, total: job.ops.length }; }
  await KV(env).delete("job:current");
  if (job.announce && job.ops.length) await logTx(env, L, { title: DANGER[job.action].tx, color: 0xe8424a, desc: `${new Set(job.ops.map((o) => o[0])).size} members updated by staff.` });
  return { done: true, i: job.i, total: job.ops.length, errors: job.errors, people: new Set(job.ops.map((o) => o[0])).size };
}
async function dangerSimple(env, L, admin, body) {
  const a = body.action;
  if (String(body.confirm || "").trim().toUpperCase() !== "CONFIRM") throw UE("Type CONFIRM to go ahead.");
  let n = 0;
  if (a === "cancel_pending") {
    for (const k of await klist(env, "offer:")) if (k.metadata?.status === "pending") { const o = await kget(env, k.name); if (o) { o.status = "void"; await saveOffer(env, o); n++; } }
    for (const k of await klist(env, "req:")) if (["staff", "other"].includes(k.metadata?.status)) { const r = await kget(env, k.name); if (r) { r.status = "cancelled"; r.decidedByName = admin.name; r.decisionReason = "Cancelled from the Danger Zone"; await saveReq(env, r); n++; } }
    return `Cancelled ${n} pending offer(s) and request(s).`;
  }
  const pre = { logout_all: "sess:", clear_passwords: "pw:", clear_tx: "tx:" }[a];
  if (!pre) throw UE("Unknown action.");
  for (const k of await klist(env, pre)) { await KV(env).delete(k.name); n++; }
  return a === "logout_all" ? `Logged out ${n} FO portal session(s).` : a === "clear_passwords" ? `Removed ${n} team password(s) — those logins stop working.` : `Deleted ${n} transaction log entries (Discord messages stay).`;
}

// ---------- franchises ----------
async function franchisesEmbeds(env, L) {
  const M = await members(env, L, true);
  const E = await guildEmojis(env, L);
  const emo = (t) => { const e = teamEmoji(E, t); return e ? emojiTag(e) + " " : ""; };
  const rows = L.teams.map((t) => { const r = rosterOf(L, M, t.abbr); return { t, n: r.length, fo: r.find((p) => p.rank === "fo") }; });
  const line = (x) => `${emo(x.t)}${x.t.roleId ? `<@&${x.t.roleId}>` : `**${x.t.name}**`} \`${x.n}/${cap(L)}\` ${x.fo ? `<@${x.fo.id}>` : "**No FO**"}`;
  const act = rows.filter((x) => x.fo).sort((a, b) => a.t.name.localeCompare(b.t.name)), un = rows.filter((x) => !x.fo).sort((a, b) => a.t.name.localeCompare(b.t.name));
  const chunk = (a, n) => { const out = []; for (let k = 0; k < a.length; k += n) out.push(a.slice(k, k + n)); return out; };
  const embeds = [];
  chunk(act, 10).forEach((c, k, all) => embeds.push({ title: k ? undefined : "Franchise Owner List", color: 0xffc62f,
    description: `**Active FOs${all.length > 1 ? ` (${k + 1}/${all.length})` : ""} — ${act.length}**\n` + c.map(line).join("\n") }));
  chunk(un, 10).forEach((c, k, all) => embeds.push({ title: k ? undefined : "Un-Franchised Teams", color: 0x93a0bf,
    description: `**No FO${all.length > 1 ? ` (${k + 1}/${all.length})` : ""} — ${un.length}**\n` + c.map(line).join("\n") }));
  embeds[embeds.length - 1].footer = { text: `Roster cap ${cap(L)} · ${SITE}` };
  return embeds.slice(0, 10);
}

// =====================================================================================================
// Discord: commands
// =====================================================================================================
async function command(i, env, ctx) {
  const cmd = i.data.name, sub = (i.data.options || [])[0], o = i.data.options;
  switch (cmd) {
    case "pick": return later(i, ctx, () => doPick(i, env));
    case "onclock": return await onClock(env);
    case "available": return await available(i, env);
    case "schedule": return await schedule(i, env);
    case "roster": return later(i, ctx, () => roster(i, env), false);
    case "franchises": return later(i, ctx, async () => ({ embeds: await franchisesEmbeds(env, await league(env)) }), false);
    case "activity": return await activity(i, env);
    case "fa":
      if (sub?.name === "list") return await faList(sub, env);
      if (sub?.name === "join") return later(i, ctx, () => faJoin(i, sub, env));
      if (sub?.name === "leave") return later(i, ctx, () => faLeave(i, env));
      break;
    case "vote": if (sub?.name === "create") return await voteCreate(i, sub, env); break;
    case "offer": return later(i, ctx, async () => { const L = await league(env); return (await makeOffer(env, L, await actorFromInteraction(env, L, i), opt(o, "player"))).text; });
    case "offers": return later(i, ctx, () => myOffers(i, env));
    case "release": return later(i, ctx, async () => { const L = await league(env); return releasePlayer(env, L, await actorFromInteraction(env, L, i), opt(o, "player")); });
    case "demand": return later(i, ctx, async () => { const L = await league(env); return demand(env, L, await actorFromInteraction(env, L, i), opt(o, "reason")); });
    case "promote": return later(i, ctx, async () => { const L = await league(env); return promote(env, L, await actorFromInteraction(env, L, i), opt(o, "player"), opt(o, "role"), opt(o, "reason")); });
    case "demote": return later(i, ctx, async () => { const L = await league(env); return demote(env, L, await actorFromInteraction(env, L, i), opt(o, "player")); });
    case "trade": return later(i, ctx, async () => {
      const L = await league(env), a = await actorFromInteraction(env, L, i);
      const t = findTeamL(L, opt(o, "team"));
      return (await proposeTrade(env, L, a, t?.abbr, ["give1", "give2", "give3"].map((k) => opt(o, k)), ["get1", "get2", "get3"].map((k) => opt(o, k)))).text;
    });
  }
  return reply("Unknown command.", true);
}
const findTeamL = (L, q) => { q = String(q || "").trim().toLowerCase(); return L.teams.find((t) => t.abbr.toLowerCase() === q) || L.teams.find((t) => t.name.toLowerCase() === q) || L.teams.find((t) => t.name.toLowerCase().includes(q)); };

async function myOffers(i, env) {
  const uid = uidOf(i), L = await league(env);
  const list = [];
  for (const k of await klist(env, "offer:")) if (k.metadata?.uid === uid && k.metadata?.status === "pending" && k.metadata.exp > Date.now()) list.push(await kget(env, k.name));
  if (!list.length) return "You have no open offers.";
  return { content: "📨 **Your open offers:**", components: list.filter(Boolean).slice(0, 5).map((x) => row(
    { type: 2, style: 2, label: teamOf(L, x.team)?.name.slice(0, 70) || x.team, custom_id: `noop:${x.id}`, disabled: true },
    btn("Accept", 3, `oa:${x.id}`), btn("Decline", 4, `od:${x.id}`))) };
}

// ---------- components (buttons / menus) ----------
async function component(i, env, ctx) {
  const [kind, id, k] = String(i.data.custom_id || "").split(":");
  if (["v", "vs", "vr", "vc"].includes(kind)) return voteComponent(i, env, kind, id, k);
  if (kind === "oa" || kind === "od") return later(i, ctx, async () => {
    return { content: await answerOffer(env, id, uidOf(i), kind === "oa"), components: [] };
  }, true, true);
  if (kind === "ta" || kind === "td") return later(i, ctx, async () => {
    const L = await league(env);
    return { content: await answerTrade(env, L, await actorFromUid(env, L, uidOf(i)), id, kind === "ta"), components: [] };
  }, true, true);
  if (kind === "ra" || kind === "rd") {
    const L = await league(env);
    if (!isStaff(env, L, uidOf(i), i.member?.roles || [], i.member?.permissions)) return reply("Only staff can decide requests.", true);
    return json({ type: 9, data: { custom_id: `rm:${id}:${kind === "ra" ? "a" : "d"}`, title: kind === "ra" ? "Approve request" : "Deny request",
      components: [row({ type: 4, custom_id: "reason", style: 2, label: "Reason (sent to the people involved)", min_length: 2, max_length: 500, required: true })] } });
  }
  return reply("That button doesn't do anything anymore.", true);
}
async function modalSubmit(i, env, ctx) {
  const [kind, id, ad] = String(i.data.custom_id || "").split(":");
  if (kind !== "rm") return reply("Unknown form.", true);
  const reason = i.data.components?.[0]?.components?.[0]?.value || "";
  return later(i, ctx, async () => {
    const L = await league(env), staff = await actorFromInteraction(env, L, i);
    if (!staff.staff) return "Only staff can decide requests.";
    const r = await decide(env, id, ad === "a", reason, staff);
    return r.status === "approved" ? "✅ Approved." : r.status === "denied" ? "❌ Denied." : `⚠️ Couldn't complete it: ${r.decisionReason}`;
  });
}

// =====================================================================================================
// draft / schedule / roster / fa (unchanged behavior)
// =====================================================================================================
function helpers(D) {
  const order = D.teams.filter((t) => t.in).map((t) => t.abbr), T = order.length, total = T * D.rounds;
  const slot = (n) => { const r = Math.floor(n / T), k = n % T; return { round: r + 1, pick: k + 1, overall: n + 1, team: order[D.snake && r % 2 ? T - 1 - k : k] }; };
  const taken = new Set(D.picks.map((p) => p.player));
  const avail = D.pool.filter((p) => !taken.has(p.id)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  const team = (a) => D.teams.find((t) => t.abbr === a) || {};
  return { order, T, total, slot, taken, avail, team };
}
const posTxt = (p) => (p.pos || []).join("/");
const names = (S) => Object.fromEntries(S.teams.map((t) => [t.abbr, t.name]));
function findTeam(S, q) {
  q = String(q || "").trim().toLowerCase(); if (!q) return null;
  return S.teams.find((t) => t.abbr.toLowerCase() === q) || S.teams.find((t) => t.name.toLowerCase() === q)
    || S.teams.find((t) => t.name.split(" ").pop().toLowerCase() === q) || S.teams.find((t) => t.name.toLowerCase().includes(q)) || null;
}
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const niceDate = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
function currentWeek(S) {
  const t = todayISO();
  return [...(S.weeks || [])].sort((a, b) => a.week - b.week).find((w) => !w.done && (w.games || []).length && (!w.deadline || w.deadline >= t)) || null;
}
function parsePos(raw) {
  const out = [];
  for (const tok of String(raw).toUpperCase().split(/[^A-Z]+/)) { const p = POS[tok]; if (p && !out.includes(p)) out.push(p); }
  return out;
}
const cleanName = (s) => String(s || "").replace(/[\(\[\{].*?[\)\]\}]/g, "").replace(/[^\w .\-]/g, "").trim();

async function autocomplete(i, env) {
  const focused = (i.data.options || []).flatMap((o) => o.options ? o.options : [o]).find((o) => o.focused);
  const q = String(focused?.value || "").toLowerCase();
  if (focused?.name === "team") {
    const S = await loadSched(env);
    return S.teams.filter((t) => !q || t.name.toLowerCase().includes(q) || t.abbr.toLowerCase().startsWith(q))
      .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 25)
      .map((t) => ({ name: `${t.name} (${t.abbr})`, value: t.abbr }));
  }
  const { D } = await loadDraft(env), { avail } = helpers(D);
  return avail.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 25)
    .map((p) => ({ name: `${p.rank ? "#" + p.rank + " " : ""}${p.name}${posTxt(p) ? " — " + posTxt(p) : ""}`.slice(0, 100), value: String(p.id) }));
}

async function onClock(env) {
  const { D } = await loadDraft(env), H = helpers(D), N = names(await loadSched(env)), n = D.picks.length;
  if (D.status === "setup") return reply("The draft hasn't started yet.");
  if (D.status === "done" || n >= H.total) return reply(`🏁 The draft is complete. ${BOARD}#/teams`);
  const s = H.slot(n), fo = H.team(s.team).foId;
  let left = "";
  if (D.pickMinutes && D.clockStart) { const m = Math.round((D.clockStart + D.pickMinutes * 60000 - Date.now()) / 60000); left = m >= 0 ? ` · ${m} min left` : ` · ${-m} min over`; }
  const last = n ? (() => { const p = D.pool.find((x) => x.id === D.picks[n - 1].player) || { name: "?" }; return `\nLast pick: **${N[H.slot(n - 1).team] || H.slot(n - 1).team}** — ${p.name}`; })() : "";
  return reply(`⏰ **On the clock:** ${N[s.team] || s.team}${fo ? ` (<@${fo}>)` : ""} — Round ${s.round}, Pick ${s.pick} (#${s.overall})${left}${D.status === "paused" ? " · ⏸️ paused" : ""}${last}\n${BOARD}`);
}

async function available(i, env) {
  const pos = String(opt(i.data.options, "position") || "").toUpperCase().trim();
  const { D } = await loadDraft(env), { avail } = helpers(D);
  const list = avail.filter((p) => !pos || (p.pos || []).includes(pos)).slice(0, 15);
  if (!list.length) return reply(pos ? `No available players at ${pos}.` : "No players available.", true);
  return reply(`**Best available${pos ? " — " + pos : ""}:**\n` + list.map((p, k) => `${p.rank ? "#" + p.rank : k + 1 + "."} **${p.name}**${posTxt(p) ? " (" + posTxt(p) + ")" : ""}${p.tier ? " · T" + p.tier : ""}`).join("\n"), true);
}

async function doPick(i, env) {
  try {
    const user = uidOf(i), raw = String(opt(i.data.options, "player") || "").trim();
    const L = await league(env).catch(() => null), commish = isStaff(env, L, user, i.member?.roles || [], i.member?.permissions);
    const N = names(await loadSched(env));
    for (let attempt = 0; attempt < 3; attempt++) {
      const { D, sha } = await loadDraft(env), H = helpers(D), n = D.picks.length;
      if (D.status === "setup") return "The draft hasn't started yet.";
      if (D.status === "paused") return "⏸️ The draft is paused right now.";
      if (D.status === "done" || n >= H.total) return "🏁 The draft is already complete.";
      const s = H.slot(n), fo = H.team(s.team).foId;
      if (user !== fo && !commish) return `❌ You're not on the clock. It's **${N[s.team] || s.team}**'s pick${fo ? ` (<@${fo}>)` : ""}.`;
      let p = /^\d+$/.test(raw) ? D.pool.find((x) => x.id === +raw) : null;
      if (!p) { const q = raw.toLowerCase(); const m = H.avail.filter((x) => x.name.toLowerCase() === q); p = m.length === 1 ? m[0] : null;
        if (!p) { const c = H.avail.filter((x) => x.name.toLowerCase().includes(q)); if (c.length === 1) p = c[0];
          else return c.length ? `More than one player matches "${raw}": ${c.slice(0, 8).map((x) => x.name).join(", ")}. Pick one from the list.` : `No available player called "${raw}".`; } }
      if (H.taken.has(p.id)) return `❌ **${p.name}** has already been drafted.`;
      D.picks.push({ player: p.id, at: Date.now(), by: user });
      D.clockStart = Date.now();
      if (D.picks.length >= H.total) D.status = "done";
      try { await putJSON(env, "draft.json", D, sha, `Pick #${s.overall}: ${s.team} select ${p.name} (via /pick)`); }
      catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
      return `✅ **Pick is in!** ${N[s.team] || s.team} select **${p.name}**${posTxt(p) ? " (" + posTxt(p) + ")" : ""} — Round ${s.round}, Pick ${s.pick}.\nThe bot will announce it in the draft channel in a few seconds.`;
    }
    return "⚠️ The draft was busy — try /pick again.";
  } catch (e) {
    return "⚠️ Couldn't save the pick: " + (e.message || e) + ([401, 403, 404].includes(e.status) ? " (check the Worker's GITHUB_TOKEN)" : "");
  }
}

async function schedule(i, env) {
  const S = await loadSched(env), N = names(S), q = opt(i.data.options, "team");
  if (q) {
    const t = findTeam(S, q);
    if (!t) return reply(`No team called "${q}".`, true);
    const lines = [];
    for (const w of [...S.weeks].sort((a, b) => a.week - b.week))
      for (const g of w.games || []) if (g.a === t.abbr || g.b === t.abbr) {
        const opp = g.a === t.abbr ? g.b : g.a;
        lines.push(`Week ${w.week}${g.catchup ? " (catch-up)" : ""}: vs **${N[opp] || opp || "TBD"}**` + (g.result ? ` — ${g.result}` : w.done ? "" : ` · due ${niceDate(w.deadline)}`));
      }
    return reply(`📅 **${t.name}**${t.active === false ? " (inactive)" : ""}\n` + (lines.length ? lines.slice(-15).join("\n") : "No games scheduled yet.") + `\n${SITE}`);
  }
  const w = currentWeek(S);
  if (!w) return reply(`No upcoming week is scheduled yet. ${SITE}`);
  const line = (g) => `🏈 **${N[g.a] || g.a}** vs **${N[g.b] || g.b}**${g.result ? " — " + g.result : ""}`;
  const reg = w.games.filter((g) => !g.catchup && g.a && g.b), cu = w.games.filter((g) => g.catchup && g.a && g.b);
  return reply([`📅 **Week ${w.week}**${w.deadline ? ` — deadline ${niceDate(w.deadline)}` : ""}`, ...reg.map(line),
    ...(cu.length ? ["**Catch-up games**", ...cu.map(line)] : []), SITE].join("\n"));
}

async function roster(i, env) {
  const L = await league(env), t = findTeamL(L, opt(i.data.options, "team"));
  if (!t) return "No team by that name.";
  const [{ D }, M] = await Promise.all([loadDraft(env), members(env, L)]);
  const byDiscord = Object.fromEntries(D.pool.filter((p) => p.discord).map((p) => [p.discord, p]));
  const icon = { fo: "👑", gm: "🧠", hc: "📋", player: "•" };
  const r = rosterOf(L, M, t.abbr).sort((a, b) => ["fo", "gm", "hc", "player"].indexOf(a.rank) - ["fo", "gm", "hc", "player"].indexOf(b.rank) || a.name.localeCompare(b.name));
  const lines = r.map((p) => `${icon[p.rank]} <@${p.id}>${p.rank !== "player" ? ` — ${RANK[p.rank]}` : ""}${byDiscord[p.id] && posTxt(byDiscord[p.id]) ? ` (${posTxt(byDiscord[p.id])})` : ""}`);
  return { embeds: [{ title: `${t.name} — ${r.length}/${cap(L)}`, color: colorInt(t.color), description: lines.join("\n") || "No players yet." }] };
}

async function faList(sub, env) {
  const pos = String(opt(sub.options, "position") || "").toUpperCase().trim();
  const { D } = await loadDraft(env), { avail } = helpers(D);
  const all = avail.filter((p) => !pos || (p.pos || []).includes(pos)), list = all.slice(0, 20);
  if (!list.length) return reply(pos ? `No free agents at ${pos}.` : "No free agents right now.", true);
  return reply(`🆓 **Free agents${pos ? " — " + pos : ""}** (${all.length})\n` + list.map((p) => `• ${p.discord ? `<@${p.discord}>` : `**${p.name}**`}${posTxt(p) ? ` (${posTxt(p)})` : ""}`).join("\n")
    + (all.length > list.length ? `\n…and ${all.length - list.length} more: ${BOARD}#/players` : "") + "\nNot on a team? Sign up with **/fa join**.", true);
}

async function faJoin(i, sub, env) {
  const m = i.member, uid = m.user.id, gid = i.guild_id;
  const raw = String(opt(sub.options, "positions") || ""), pos = parsePos(raw);
  if (!pos.length) return `Couldn't read any positions from "${raw}". Try something like **WR/CB** or **QB, LB**.`;
  const L = await league(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { D, sha } = await loadDraft(env), H = helpers(D);
    const onTeam = L.teams.find((t) => t.roleId && (m.roles || []).includes(t.roleId));
    if (onTeam) return `You're already on the **${onTeam.name}** roster.`;
    let p = D.pool.find((x) => x.discord === uid);
    if (p && H.taken.has(p.id)) return "You've already been drafted.";
    if (attempt === 0) {
      if (!L.R.draftable) return "⚠️ Couldn't find the draft-pool role. Ask the commissioner to check the DRAFT_ROLE setting.";
      await discord(env, "PUT", `/guilds/${gid}/members/${uid}/roles/${L.R.draftable}`);
    }
    if (!p) { p = { id: Math.max(0, ...D.pool.map((x) => x.id)) + 1, name: cleanName(m.nick || m.user.global_name || m.user.username) || m.user.username, pos: [], discord: uid }; D.pool.push(p); }
    p.pos = pos; p.avatar = avatarUrl(gid, m); p.locked = true;
    D.positions = D.positions || [];
    for (const x of pos) if (!D.positions.includes(x)) D.positions.push(x);
    try { await putJSON(env, "draft.json", D, sha, `Free agent sign-up: ${p.name} (${pos.join("/")})`); }
    catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
    return `✅ You're in the player pool as **${p.name}** (${pos.join("/")}). FOs can find you on the board: ${BOARD}#/players\nChange positions any time by running **/fa join** again.`;
  }
  return "⚠️ Busy right now — try again.";
}

async function faLeave(i, env) {
  const uid = uidOf(i), gid = i.guild_id, L = await league(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { D, sha } = await loadDraft(env), H = helpers(D);
    const p = D.pool.find((x) => x.discord === uid);
    if (p && H.taken.has(p.id)) return "You've already been drafted — talk to your FO or a commissioner.";
    if (attempt === 0 && L.R.draftable) await discord(env, "DELETE", `/guilds/${gid}/members/${uid}/roles/${L.R.draftable}`).catch(() => {});
    if (!p) return "👋 You're not in the player pool.";
    D.pool = D.pool.filter((x) => x !== p);
    try { await putJSON(env, "draft.json", D, sha, `Free agent left the pool: ${p.name}`); }
    catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
    return "👋 You've been taken out of the player pool. Rejoin any time with **/fa join**.";
  }
  return "⚠️ Busy right now — try again.";
}

async function activity(i, env) {
  const L = await league(env);
  if (!isStaff(env, L, uidOf(i), i.member?.roles || [], i.member?.permissions)) return reply("Only staff can use this.", true);
  const M = await members(env, L), min = L.settings.minPlayers;
  const under = [], noFo = [], empty = [];
  for (const t of L.teams) {
    const r = rosterOf(L, M, t.abbr);
    if (!r.length) { empty.push(t.abbr); continue; }
    if (r.length < min) under.push(`${t.abbr} (${r.length})`);
    if (!r.some((p) => p.rank === "fo")) noFo.push(t.abbr);
  }
  return reply([`📋 **Activity** — minimum ${min} players`,
    under.length ? `⚠️ Under the minimum: ${under.join(", ")}` : "✅ No teams under the minimum",
    noFo.length ? `👤 No FO: ${noFo.join(", ")}` : "", empty.length ? `🫥 Empty: ${empty.join(", ")}` : ""].filter(Boolean).join("\n"), true);
}

// ---------- votes ----------
const TTL = 60 * 60 * 24 * 90;
const pollText = (p) => `🗳️ **${p.title}**\nOne vote per person — you can change it until voting closes.` + (p.ends ? ` Closes <t:${Math.floor(p.ends / 1000)}:R>.` : "");
function pollRows(id, options) {
  const rows = options.length <= 5
    ? [row(...options.map((o, k) => btn(o.slice(0, 80), 1, `v:${id}:${k}`)))]
    : [row({ type: 3, custom_id: `vs:${id}`, placeholder: "Choose your vote", options: options.map((o, k) => ({ label: o.slice(0, 100), value: String(k) })) })];
  rows.push(row(btn("📊 Results (staff)", 2, `vr:${id}`), btn("🔒 Close voting (staff)", 4, `vc:${id}`)));
  return rows;
}
async function tally(env, id, n) {
  const counts = Array(n).fill(0);
  for (const k of await klist(env, `vote:${id}:`)) { const x = k.metadata?.i; if (x >= 0 && x < n) counts[x]++; }
  return counts;
}
function resultsText(p, counts, final) {
  const total = counts.reduce((a, b) => a + b, 0), top = Math.max(...counts);
  const rows = p.options.map((o, k) => [o, counts[k]]).sort((a, b) => b[1] - a[1])
    .map(([o, c]) => `${final && total && c === top ? "🏆" : "▫️"} **${o}** — ${c} vote${c === 1 ? "" : "s"}` + (total ? ` (${Math.round((c / total) * 100)}%) ` + "█".repeat(Math.round((c / total) * 10)) : ""));
  return `${final ? "🔒 **Final results" : "📊 **Results so far"} — ${p.title}**\n${rows.join("\n")}\n${total} total vote${total === 1 ? "" : "s"}.` + (final ? "" : "\n-# Votes from the last minute may not show yet.");
}
async function voteCreate(i, sub, env) {
  const L = await league(env).catch(() => null);
  if (!isStaff(env, L, uidOf(i), i.member?.roles || [], i.member?.permissions)) return reply("Only staff can start a vote.", true);
  const title = String(opt(sub.options, "title") || "").trim().slice(0, 200);
  const options = [...new Set(String(opt(sub.options, "options") || "").split(/[,|\n]/).map((s) => s.trim()).filter(Boolean))];
  const hours = Number(opt(sub.options, "hours") || 0);
  if (options.length < 2 || options.length > 25) return reply("Give between 2 and 25 options, separated by commas.", true);
  const id = rid();
  const poll = { title, options, ends: hours > 0 ? Date.now() + hours * 3600000 : null, by: uidOf(i) };
  await kput(env, `poll:${id}`, poll, TTL);
  return json({ type: 4, data: { content: pollText(poll), components: pollRows(id, options), allowed_mentions: { parse: [] } } });
}
async function voteComponent(i, env, kind, id, k) {
  const poll = await kget(env, `poll:${id}`);
  if (!poll) return reply("This vote has expired.", true);
  if (kind === "v" || kind === "vs") {
    const idx = kind === "vs" ? Number(i.data.values?.[0]) : Number(k);
    if (poll.closed || (poll.ends && Date.now() > poll.ends)) return reply("🔒 Voting is closed.", true);
    if (!(idx >= 0 && idx < poll.options.length)) return reply("That option doesn't exist.", true);
    await kput(env, `vote:${id}:${uidOf(i)}`, idx, TTL, { i: idx });
    return reply(`✅ Your vote: **${poll.options[idx]}**. You can change it until voting closes.`, true);
  }
  const L = await league(env).catch(() => null);
  if (!isStaff(env, L, uidOf(i), i.member?.roles || [], i.member?.permissions)) return reply("Only staff can do that.", true);
  const counts = await tally(env, id, poll.options.length);
  if (kind === "vr") return reply(resultsText(poll, counts, false), true);
  poll.closed = true; await kput(env, `poll:${id}`, poll, TTL);
  return json({ type: 7, data: { content: resultsText(poll, counts, true), components: [], allowed_mentions: { parse: [] } } });
}

// =====================================================================================================
// Website API (FO portal + admin)
// =====================================================================================================
async function sha256(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const randToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function web(req, url, env, ctx) {
  const origin = env.SITE_ORIGIN || "https://elitetuber168.github.io";
  const cors = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const out = (o, s = 200) => json(o, s, cors);
  const p = url.pathname;
  try {
    // ----- Discord login -----
    if (p === "/auth/discord") {
      const back = url.searchParams.get("return") || `${SITE}fo.html`;
      if (!back.startsWith(origin)) return new Response("Bad return URL", { status: 400 });
      const state = randToken(); await kput(env, `st:${state}`, back, 600);
      const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID || APP_ID, response_type: "code", scope: "identify", redirect_uri: `${url.origin}/auth/callback`, state, prompt: "none" });
      return Response.redirect(`https://discord.com/oauth2/authorize?${q}`, 302);
    }
    if (p === "/auth/callback") {
      const back = await kget(env, `st:${url.searchParams.get("state")}`);
      if (!back) return new Response("Login expired — go back and try again.", { status: 400 });
      if (!url.searchParams.get("code")) return Response.redirect(`${back}#error=cancelled`, 302);
      if (!env.DISCORD_CLIENT_SECRET) return Response.redirect(`${back}#error=nosecret`, 302);
      const tr = await fetch("https://discord.com/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID || APP_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: `${url.origin}/auth/callback` }) });
      if (!tr.ok) return Response.redirect(`${back}#error=login`, 302);
      const tok = await tr.json();
      const me = await (await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
      const s = randToken(); await kput(env, `sess:${s}`, { uid: me.id, name: me.global_name || me.username, ts: Date.now() }, 30 * 86400);
      return Response.redirect(`${back}#session=${s}`, 302);
    }
    if (p === "/api/login" && req.method === "POST") {
      const { team, password } = await req.json();
      const rec = await kget(env, `pw:${String(team || "").toUpperCase()}`);
      if (!rec || rec.hash !== await sha256(rec.salt + String(password || ""))) return out({ error: "Wrong team or password." }, 401);
      const s = randToken(); await kput(env, `sess:${s}`, { team: String(team).toUpperCase(), pw: true, ts: Date.now() }, 30 * 86400);
      return out({ session: s });
    }

    const L = await league(env);
    const auth = req.headers.get("Authorization") || "";
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // ----- admin (GitHub token with push access to the repo, or a staff Discord session) -----
    if (p.startsWith("/api/admin/")) {
      const admin = await adminFrom(env, L, auth);
      if (!admin) return out({ error: "Not allowed — sign in with a GitHub token that can edit the site." }, 401);
      if (p === "/api/admin/requests") {
        const list = [];
        for (const k of await klist(env, "req:")) if (["staff", "other"].includes(k.metadata?.status) || url.searchParams.get("all")) list.push(await kget(env, k.name));
        return out({ requests: list.filter(Boolean).sort((a, b) => b.ts - a.ts).map((r) => ({ ...r, text: plain(L, r) })) });
      }
      if (p === "/api/admin/decide") { const r = await decide(env, body.id, !!body.approve, body.reason, admin); return out({ ok: true, status: r.status, note: r.decisionReason }); }
      if (p === "/api/admin/appoint") return out({ ok: true, text: await appoint(env, L, body.team, body.uid, admin.name) });
      if (p === "/api/admin/unappoint") return out({ ok: true, text: await unappoint(env, L, body.team, admin.name) });
      if (p === "/api/admin/password") {
        const abbr = String(body.team || "").toUpperCase(); if (!teamOf(L, abbr)) return out({ error: "Unknown team." }, 400);
        if (!body.password) { await KV(env).delete(`pw:${abbr}`); return out({ ok: true }); }
        if (String(body.password).length < 8) return out({ error: "Use at least 8 characters." }, 400);
        const salt = randToken(); await kput(env, `pw:${abbr}`, { salt, hash: await sha256(salt + body.password), ts: Date.now() }, 365 * 86400);
        return out({ ok: true });
      }
      if (p === "/api/admin/passwords") { const ks = await klist(env, "pw:"); return out({ teams: ks.map((k) => k.name.slice(3)) }); }
      if (p === "/api/admin/overview") {
        const M = await members(env, L, true);
        const pending = (await klist(env, "req:")).filter((k) => k.metadata?.status === "staff").length;
        return out({ teams: L.teams, members: M.map((m) => info(L, m)), cap: cap(L), frozen: frozen(L), draftStatus: L.draftStatus, pending, ready: { staff: !!L.R.staff, gm: !!L.R.gm, hc: !!L.R.hc, fo: !!L.R.fo, approvals: !!L.C.approvals, transactions: !!L.C.transactions } });
      }
      if (p === "/api/admin/danger/preview") return out(await dangerPreview(env, L));
      if (p === "/api/admin/danger") return out({ ok: true, ...(await dangerRun(env, L, admin, body)) });
      if (p === "/api/admin/danger/simple") return out({ ok: true, text: await dangerSimple(env, L, admin, body) });
      if (p === "/api/admin/assign") return out({ ok: true, text: await staffAssign(env, L, admin, body.uid, body.team) });
      if (p === "/api/admin/title") return out({ ok: true, text: await staffTitle(env, L, admin, body.uid, body.role) });
      if (p === "/api/admin/staffrole") return out({ ok: true, text: await staffRole(env, L, admin, body.uid, !!body.on) });
      if (p === "/api/admin/tx") {
        const M = await members(env, L), ks = (await klist(env, "tx:")).slice(0, 60);
        return out({ tx: (await Promise.all(ks.map((k) => kget(env, k.name)))).filter(Boolean).map((t) => ({ ...t, text: mentionsToNames(M, L, t.desc) })) });
      }
      if (p === "/api/admin/members") { const M = await members(env, L); return out({ members: M.map((m) => info(L, m)) }); }
      if (p === "/api/admin/release") return out({ ok: true, text: await releasePlayer(env, L, admin, body.uid) });
      return out({ error: "Unknown admin route." }, 404);
    }

    // ----- FO / player session -----
    const s = auth.startsWith("Session ") ? await kget(env, `sess:${auth.slice(8)}`) : null;
    if (!s) return out({ error: "Please log in." }, 401);
    if (p === "/api/logout") { await KV(env).delete(`sess:${auth.slice(8)}`); return out({ ok: true }); }
    let actor;
    if (s.pw) actor = { id: null, name: `${teamOf(L, s.team)?.name || s.team} front office`, team: s.team, rank: "fo", staff: false, pw: true };
    else actor = await actorFromUid(env, L, s.uid);
    const M = await members(env, L);

    if (p === "/api/me") return out({ me: actor, teams: L.teams.map(({ abbr, name, color }) => ({ abbr, name, color })), cap: cap(L), frozen: frozen(L) });
    if (p === "/api/team") {
      const abbr = url.searchParams.get("team") || actor.team;
      if (!teamOf(L, abbr)) return out({ error: "No team." }, 404);
      const offers = [], reqs = [];
      for (const k of await klist(env, "offer:")) if (k.metadata?.team === abbr && k.metadata?.status === "pending" && k.metadata.exp > Date.now()) offers.push(await kget(env, k.name));
      for (const k of await klist(env, "req:")) if ((k.metadata?.team === abbr || k.metadata?.to === abbr) && ["staff", "other"].includes(k.metadata?.status)) reqs.push(await kget(env, k.name));
      return out({ team: teamOf(L, abbr), roster: rosterOf(L, M, abbr), offers: offers.filter(Boolean), requests: reqs.filter(Boolean).map((r) => ({ ...r, text: plain(L, r) })) });
    }
    if (p === "/api/players") return out({ players: M.map((m) => info(L, m)) });
    if (p === "/api/franchises") return out({ teams: L.teams.map((t) => { const r = rosterOf(L, M, t.abbr); return { ...t, count: r.length, fo: r.find((x) => x.rank === "fo") || null }; }), cap: cap(L) });
    if (p === "/api/transactions") {
      const ks = (await klist(env, "tx:")).slice(0, 40);
      return out({ tx: (await Promise.all(ks.map((k) => kget(env, k.name)))).filter(Boolean).map((t) => ({ ...t, text: mentionsToNames(M, L, t.desc) })) });
    }
    if (req.method !== "POST") return out({ error: "Unknown route." }, 404);
    if (p === "/api/offer") return out({ ok: true, ...(await makeOffer(env, L, actor, body.uid)) });
    if (p === "/api/offer/cancel") {
      const o = await kget(env, `offer:${body.id}`);
      if (!o || o.team !== actor.team || !can(actor, "offer")) return out({ error: "Can't cancel that offer." }, 400);
      o.status = "cancelled"; await saveOffer(env, o); return out({ ok: true });
    }
    if (p === "/api/release") return out({ ok: true, text: await releasePlayer(env, L, actor, body.uid) });
    if (p === "/api/promote") return out({ ok: true, text: await promote(env, L, actor, body.uid, body.role, body.reason) });
    if (p === "/api/demote") return out({ ok: true, text: await demote(env, L, actor, body.uid) });
    if (p === "/api/trade") return out({ ok: true, ...(await proposeTrade(env, L, actor, body.to, body.give || [], body.get || [])) });
    if (p === "/api/trade/respond") return out({ ok: true, text: await answerTrade(env, L, actor, body.id, !!body.accept) });
    if (p === "/api/demand") return out({ ok: true, text: await demand(env, L, actor, body.reason) });
    return out({ error: "Unknown route." }, 404);
  } catch (e) {
    return json({ error: e.user ? e.message : "Something went wrong: " + (e.message || e) }, e.user ? 400 : 500, cors);
  }
}
async function adminFrom(env, L, auth) {
  if (auth.startsWith("Session ")) {
    const s = await kget(env, `sess:${auth.slice(8)}`);
    if (s?.uid) { const a = await actorFromUid(env, L, s.uid); if (a.staff) return a; }
    return null;
  }
  if (!auth.startsWith("GitHub ")) return null;
  const tok = auth.slice(7), key = "gh:" + (await sha256(tok));
  return cached(key, 600000, async () => {
    const r = await fetch(`https://api.github.com/repos/${repo(env)}`, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "ufa-draft-worker" } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.permissions?.push) return null;
    const u = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tok}`, "User-Agent": "ufa-draft-worker" } }).then((x) => x.ok ? x.json() : {}).catch(() => ({}));
    return { id: null, name: `${u.login || "Admin"} (website)`, staff: true, team: null, rank: null };
  });
}
function mentionsToNames(M, L, s) {
  return String(s || "").replace(/<a?:\w+:\d+>\s?/g, "").replace(/`/g, "").replace(/^> • /gm, "• ").replace(/<@&(\d+)>/g, (_, id) => "@" + (L.teams.find((t) => t.roleId === id)?.name || "role"))
    .replace(/<@(\d+)>/g, (_, id) => "@" + (M.find((m) => m.user.id === id) ? display(M.find((m) => m.user.id === id)) : "user")).replace(/\*\*/g, "");
}
function plain(L, r) {
  const t = teamOf(L, r.team || r.from)?.name || "";
  if (r.type === "demand") return `${r.name} wants to leave the ${t}.` + (r.reason ? ` Reason: ${r.reason}` : "");
  if (r.type === "promote") return `${r.byName} wants to make ${r.name} ${RANK[r.role]} of the ${t}. Reason: ${r.reason}`;
  return `${teamOf(L, r.from).name} send ${r.giveNames.join(", ") || "nothing"} · ${teamOf(L, r.to).name} send ${r.getNames.join(", ") || "nothing"}`;
}
