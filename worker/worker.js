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
  // runs every minute (wrangler.toml [triggers]) — auto-picks when the clock runs out
  // Each job has its own cron (separate runs = separate time budgets); see wrangler.toml.
  async scheduled(event, env, ctx) {
    const job = event.cron === "*/2 * * * *" ? "counters" : event.cron === "*/5 * * * *" ? "board" : "autopick";
    const t0 = Date.now();
    const run = job === "counters" ? tickCounter(env) : job === "board" ? refreshOwnersBoard(env) : autoPick(env);
    ctx.waitUntil(run.then(() => cronDiag(env, job, Date.now() - t0, null), (e) => { console.log(job + ":", e.message); return cronDiag(env, job, Date.now() - t0, e.message); }));
  },
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
    // remember the DM channel so the admin inbox can show replies people send back
    if (env.VOTES) await kput(env, `dmch:${uid}`, { ch: ch.id, ts: Date.now() }, 120 * 86400).catch(() => {});
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
    if (guild && env.DISCORD_BOT_TOKEN && (!R.fo || !R.draftable || !R.fa)) {
      const roles = await discord(env, "GET", `/guilds/${guild}/roles`).catch(() => []);
      const byName = (n) => roles.find((r) => r.name.toLowerCase().trim() === n.toLowerCase())?.id;
      R.fo ||= byName(env.FO_ROLE || "Franchise owner");
      R.draftable ||= byName(env.DRAFT_ROLE || "Draftable");
      R.fa ||= byName(env.FA_ROLE || "Free Agent") || byName("Free Agents");
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
// after the draft, anyone who leaves a team goes to free agency (Free Agent role); joining a team removes it
const toFA = (env, L, uid, why) => ["done", "skipped"].includes(L.draftStatus) && L.R.fa ? addRole(env, L, uid, L.R.fa, why).catch(() => {}) : null;
const offFA = (env, L, uid, why) => L.R.fa ? delRole(env, L, uid, L.R.fa, why).catch(() => {}) : null;
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
  await refreshOwnersBoard(env, L).catch(() => {});   // keep the live franchise list in sync
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
  await offFA(env, L, uid, "Signed with a team");
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
  await toFA(env, L, uid, "Released — free agent");
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
      if (p?.team === r.team) { await stripTeam(env, L, r.uid, r.team, `Demand approved by ${staff.name}`); await toFA(env, L, r.uid, "Demand approved — free agent"); }
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
  const olds = rosterOf(L, M, abbr).filter((x) => x.rank === "fo" && x.id !== uid);
  for (const old of olds) await delRole(env, L, old.id, L.R.fo, `FO replaced by ${staffName}`);
  if (olds.length) await killTeamPassword(env, abbr);   // the old FO knew it
  if (p.team && p.team !== abbr) await stripTeam(env, L, uid, p.team, "Appointed FO of another team");
  await addRole(env, L, uid, t.roleId, `Appointed FO by ${staffName}`);
  await addRole(env, L, uid, L.R.fo, `Appointed FO by ${staffName}`);
  for (const r of [L.R.gm, L.R.hc, L.R.draftable, L.R.fa]) await delRole(env, L, uid, r, "Appointed FO").catch(() => {});
  bust("members");
  await logTx(env, L, { title: "Franchise Owner Appointed", teams: [abbr], desc: `<@${uid}> is the new franchise owner of the **${t.name}**`, lines: [`🛡️ Appointed by · **${staffName}**`] });
  await dm(env, uid, `👑 You've been appointed franchise owner of the **${t.name}**! Manage your team at ${SITE}fo.html`);
  return `👑 ${p.name} is now FO of the ${t.name}.`;
}
// a team's FO-portal password: delete it (logins made with it stop working too)
async function killTeamPassword(env, abbr) {
  const had = !!(await kget(env, `pw:${abbr}`));
  if (had) await KV(env).delete(`pw:${abbr}`);
  let ended = 0;
  for (const k of await klist(env, "sess:")) { const x = await kget(env, k.name); if (x?.pw && x.team === abbr) { await KV(env).delete(k.name); ended++; } }
  return { had, ended };
}
async function unappoint(env, L, abbr, staffName, removeFromTeam = false) {
  const M = await members(env, L, true), fos = rosterOf(L, M, abbr).filter((x) => x.rank === "fo"), fo = fos[0], t = teamOf(L, abbr);
  if (!fo) throw UE("That team has no FO.");
  for (const x of fos) {
    await delRole(env, L, x.id, L.R.fo, `FO removed by ${staffName}`);
    if (removeFromTeam) { await stripTeam(env, L, x.id, abbr, `FO removed from the team by ${staffName}`); await toFA(env, L, x.id, "Removed from team"); }
  }
  const pw = await killTeamPassword(env, abbr);
  bust("members");
  await logTx(env, L, { title: removeFromTeam ? "Franchise Owner Removed From Team" : "Franchise Owner Removed", teams: [abbr],
    desc: `${fos.map((x) => `<@${x.id}>`).join(", ")} ${fos.length > 1 ? "are" : "is"} no longer ${removeFromTeam ? "on the" : "franchise owner of the"} **${t.name}**`, lines: [`🛡️ By · **${staffName}**`] });
  return `${fo.name} is no longer ${removeFromTeam ? "on" : "FO of"} the ${t.name}.${pw.had ? " The team password was deleted" + (pw.ended ? ` and ${pw.ended} portal login(s) ended` : "") + "." : ""}`;
}
// admin "sync everything": stale passwords/logins, caches, the live owner list
function roleConflicts(L, M) {   // FOs / people on a team who still have Draftable or Free Agent
  const teamIds = new Set(L.teams.map((t) => t.roleId).filter(Boolean)), bad = [L.R.draftable, L.R.fa].filter(Boolean), ops = [];
  for (const m of M) {
    const r = m.roles || [];
    if (!(r.includes(L.R.fo) || r.some((x) => teamIds.has(x)))) continue;
    for (const b of bad) if (r.includes(b)) ops.push([m.user.id, b, display(m)]);
  }
  return ops;
}
async function fixRoleConflicts(env, L, M, max = 30) {
  const ops = roleConflicts(L, M), done = [];
  for (const [uid, role, name] of ops.slice(0, max)) {
    try { await delRole(env, L, uid, role, "On a team / FO — can't be Draftable or a Free Agent"); done.push(name); } catch {}
  }
  if (done.length) bust("members");
  return { fixed: done.length, names: [...new Set(done)], remaining: Math.max(0, ops.length - max) };
}
async function syncAll(env, L, rolesOnly = false) {
  bust("members", "league", "emojis"); L = await league(env, true);
  const M = await members(env, L, true);
  const roles = await fixRoleConflicts(env, L, M);
  if (rolesOnly) return { roles };
  const out = { passwords: [], sessions: 0, board: false, roles };
  const pwTeams = (await klist(env, "pw:")).map((k) => k.name.slice(3));
  for (const abbr of pwTeams) if (!teamOf(L, abbr) || !foOf(L, M, abbr)) { await KV(env).delete(`pw:${abbr}`); out.passwords.push(abbr); }
  for (const k of await klist(env, "sess:")) {
    const x = await kget(env, k.name); if (!x) continue;
    if (x.pw) { const rec = await kget(env, `pw:${x.team}`); if (!rec || (x.pwTs && rec.ts !== x.pwTs) || !foOf(L, M, x.team)) { await KV(env).delete(k.name); out.sessions++; } }
    else if (x.uid && !M.some((m) => m.user.id === x.uid)) { await KV(env).delete(k.name); out.sessions++; }   // left the server
  }
  out.board = !!(await refreshOwnersBoard(env, L, true).catch(() => null));
  out.teamsWithFO = L.teams.filter((t) => foOf(L, M, t.abbr)).length;
  return out;
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
  await offFA(env, L, uid, "Assigned to a team");
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

// ---------- tickets (one conversation per person, numbered ticket-0001…) ----------
const tno = (n) => `ticket-${String(n).padStart(4, "0")}`;
async function ensureTicket(env, uid, name) {
  let t = await kget(env, `ticket:${uid}`);
  if (!t) {
    const n = ((await kget(env, "ticket:counter")) || 0) + 1;
    await kput(env, "ticket:counter", n, 3650 * 86400);
    t = { no: n, uid, name, status: "open", created: Date.now(), updated: Date.now(), lastFrom: "", preview: "", replies: [] };
  }
  if (name) t.name = name;
  return t;
}
const saveTicket = (env, t) => kput(env, `ticket:${t.uid}`, t, 365 * 86400, { no: t.no, status: t.status, updated: t.updated, lastFrom: t.lastFrom });
const staffSig = (admin) => (admin?.name || "UFA Staff").replace(/ \(website\)$/, "");
async function staffSend(env, uid, text, by, ticket) {
  return dm(env, uid, { embeds: [{ author: { name: "UFA Staff" }, ...(ticket ? { title: tno(ticket.no) } : {}), description: text.slice(0, 1800), color: 0xe8424a,
    footer: { text: `From ${by}` }, timestamp: new Date().toISOString() }], components: [row(btn("💬 Reply to staff", 2, "rp:"))] });
}
function msgText(m) {
  const e = (m.embeds || [])[0];
  const t = [m.content, e && [e.title, e.description].filter(Boolean).join("\n")].filter(Boolean).join("\n");
  return t.replace(/\n?-# Sent by UFA Staff/g, "").trim();
}
async function ticketTimeline(env, t) {
  const c = await kget(env, `dmch:${t.uid}`), items = [];
  if (c?.ch) for (const m of (await discord(env, "GET", `/channels/${c.ch}/messages?limit=50`).catch(() => [])) || []) {
    const text = msgText(m); if (!text || (m.author?.bot && /^✅ Thanks — your reply was sent/.test(text))) continue;
    const e = (m.embeds || [])[0], staff = m.author?.bot && (e?.author?.name === "UFA Staff" || e?.author?.name === "UFA League" || /Sent by UFA Staff/.test(m.content || ""));
    items.push({ id: m.id, ts: Date.parse(m.timestamp), from: !m.author?.bot ? "them" : staff ? "staff" : "bot", text, by: staff ? (e?.footer?.text || "").replace(/^From |^Sent by | · UFA Staff$/g, "") : "" });
  }
  for (const r of t.replies || []) items.push({ ts: r.ts, from: "them", text: r.text, via: "button", about: r.about || "" });
  return items.sort((a, b) => a.ts - b.ts);
}
/** look through recent DM channels for messages people typed to the bot and file them into tickets */
async function scanDMs(env, L, page = 0) {
  const staffIds = new Set(String(env.REPLY_TO || env.COMMISH_IDS || "").split(/[\s,]+/).filter(Boolean));   // your own DM with the bot isn't a ticket
  const chans = (await Promise.all((await klist(env, "dmch:")).map(async (k) => ({ uid: k.name.slice(5), ...(await kget(env, k.name)) })))).filter((c) => c.ch && !staffIds.has(c.uid)).sort((a, b) => b.ts - a.ts);
  const slice = chans.slice(page * 20, page * 20 + 20), M = await members(env, L).catch(() => []);
  let found = 0;
  for (const c of slice) {
    const msgs = (await discord(env, "GET", `/channels/${c.ch}/messages?limit=5`).catch(() => [])) || [];
    const mine = msgs.filter((m) => !m.author?.bot && m.content);
    if (!mine.length) continue;
    const newest = Math.max(...mine.map((m) => Date.parse(m.timestamp)));
    const old = await kget(env, `ticket:${c.uid}`);
    if (old && old.updated >= newest) continue;
    const mm = M.find((x) => x.user.id === c.uid), t = await ensureTicket(env, c.uid, mm ? display(mm) : mine[0].author.global_name || mine[0].author.username);
    const last = mine.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    Object.assign(t, { updated: newest, lastThem: newest, lastFrom: "them", preview: last.content.slice(0, 140), status: "open" });
    await saveTicket(env, t); found++;
  }
  return { found, more: (page + 1) * 20 < chans.length };
}

// ---------- admin: players directory ----------
const posDM = (pos) => `Staff updated your positions for the UFA draft.\n\n**Your positions: ${pos.length ? pos.join(" / ") : "none"}**\n\nThis is what franchise owners see when they draft. If it's wrong, hit **Reply to staff** below (or DM a staff member) and we'll fix it.`;
async function recentPosEdits(env, D, days = 7) {   // pool entries staff changed lately that haven't been told yet
  const since = new Date(Date.now() - days * 86400000).toISOString(), seen = new Map();
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://api.github.com/repos/${repo(env)}/commits?path=draft.json&since=${since}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ufa-draft-worker" } });
    if (!r.ok) break;
    const list = await r.json();
    for (const c of list) {
      const m = /^Staff \((.*?)\): ([^:\n]+): /.exec(c.commit?.message || ""); if (!m) continue;
      const at = Date.parse(c.commit.author?.date || c.commit.committer?.date) || 0, k = m[2].trim().toLowerCase();
      if (!seen.has(k) || seen.get(k) < at) seen.set(k, at);
    }
    if (list.length < 100) break;
  }
  const out = [];
  for (const p of D.pool) {
    const at = Math.max(p.posAt || 0, seen.get(String(p.name).toLowerCase()) || 0);
    const told = p.posNotified && !(p.posNotified === p.posAt && p.posAt < 1790977127511);   // edits before 2026-10-02 21:50 UTC never actually got their DM (bug)
    if (at && p.discord && !(told && p.posNotified >= at - 60000)) out.push({ poolId: p.id, uid: p.discord, name: p.name, pos: p.pos || [], at });
  }
  return out.sort((a, b) => b.at - a.at);
}
// how many teams have each player in their draft queue (+ best spot), cached for a minute
const queuePopularity = (env) => cached("qpop", 60000, async () => {
  const pop = {};
  for (const k of await klist(env, "queue:")) {
    const q = await kget(env, k.name) || [];
    q.forEach((id, i) => { const x = pop[id] || (pop[id] = { n: 0, best: 999 }); x.n++; x.best = Math.min(x.best, i + 1); });
  }
  return pop;
});

// ---------- moderation: Discord AutoMod rules (blocks messages before anyone sees them) ----------
const AM_ERR = (e) => e.status === 403 ? UE("The bot needs the **Manage Server** permission to set up auto-delete rules (Server Settings → Roles → the bot's role → Manage Server).") : e;
async function automodList(env, L) {
  const [rules, chans, roles] = await Promise.all([
    discord(env, "GET", `/guilds/${L.guild}/auto-moderation/rules`).catch((e) => { throw AM_ERR(e); }),
    discord(env, "GET", `/guilds/${L.guild}/channels`).catch(() => []),
    discord(env, "GET", `/guilds/${L.guild}/roles`).catch(() => []),
  ]);
  return { rules, channels: chans.filter((c) => [0, 5].includes(c.type)).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    roles: roles.filter((r) => r.name !== "@everyone" && !r.managed).map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)),
    defaults: { alert: L.C.staffChat || "", exempt: L.R.staff ? [L.R.staff] : [] } };
}
async function automodSave(env, L, b, by) {
  const type = +b.trigger_type || 1, actions = b.flagOnly ? [] : [{ type: 1, metadata: b.message ? { custom_message: String(b.message).slice(0, 150) } : {} }];
  if (b.alert) actions.push({ type: 2, metadata: { channel_id: String(b.alert) } });
  if (b.timeout) actions.push({ type: 3, metadata: { duration_seconds: Math.min(2419200, Math.max(60, +b.timeout)) } });
  const clean = (a, n, len) => [...new Set((a || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, n).map((x) => x.slice(0, len));
  const tm = type === 1 ? { keyword_filter: clean(b.keywords, 1000, 60), regex_patterns: clean(b.regex, 10, 260), allow_list: clean(b.allow, 100, 60) }
    : type === 4 ? { presets: (b.presets || [1, 2, 3]).map(Number), allow_list: clean(b.allow, 1000, 60) }
    : type === 5 ? { mention_total_limit: Math.min(50, Math.max(1, +b.mentions || 5)), mention_raid_protection_enabled: true } : {};
  if (type === 1 && !tm.keyword_filter.length && !tm.regex_patterns.length) throw UE("Add at least one word/phrase or pattern.");
  const body = { name: String(b.name || "UFA filter").slice(0, 100), event_type: 1, actions, enabled: b.enabled !== false,
    exempt_roles: clean(b.exemptRoles, 20, 30), exempt_channels: clean(b.exemptChannels, 50, 30), trigger_metadata: tm };
  try {
    if (b.id) return await discord(env, "PATCH", `/guilds/${L.guild}/auto-moderation/rules/${b.id}`, body, `Edited by ${by}`);
    return await discord(env, "POST", `/guilds/${L.guild}/auto-moderation/rules`, { ...body, trigger_type: type }, `Created by ${by}`);
  } catch (e) {
    if (e.status === 400) throw UE("Discord rejected that rule — check for a bad pattern, or you've hit Discord's limit (6 word filters, 1 built-in list, 1 mention-spam rule).");
    throw AM_ERR(e);
  }
}

// remember when each scheduled job last ran (written at most every 10 min per job, to spare KV writes)
async function cronDiag(env, job, ms, err) {
  if (!env.VOTES) return;
  const d = (await kget(env, "cron:diag")) || {}, prev = d[job];
  if (!err && prev && !prev.err && Date.now() - prev.at < 10 * 60e3) return;
  d[job] = { at: Date.now(), ms, err: err ? String(err).slice(0, 200) : null };
  await kput(env, "cron:diag", d, 30 * 86400).catch(() => {});
}

// ---------- fun counters: count AutoMod hits of a rule (audit log) and keep a live message updated ----------
// "draft": blocked "when is the draft" messages (audit action 143). "excuse": flagged-only excuses (144) — never deleted.
const EXCUSE_CATS = [
  ["📶 Lag / WiFi", ["lag", "laggy", "lagging", "lagged", "wifi", "internet", "ping", "connection", "delay", "input delay", "desync", "fps", "frame", "frames", "disconnected", "dc"]],
  ["🎲 Rigged / refs", ["rigged", "refs", "ref", "scripted", "cheating", "cheater", "hacker", "hacking", "unfair", "glitch", "glitched", "bugged", "bug"]],
  ["🎮 Controller / device", ["controller", "drift", "stick drift", "keyboard", "mouse", "battery", "headset", "phone", "crashed", "crash"]],
  ["😴 Wasn't trying", ["wasnt trying", "wasn't trying", "not trying", "didnt try", "didn't try", "afk", "was afk", "tired", "lagging behind", "warming up"]],
];
const EXCUSE_WORDS = ["lag", "laggy", "lagging", "lagged", "my wifi", "wifi died", "bad wifi", "my internet", "high ping", "my ping", "input delay", "desync", "low fps", "frame drops", "i dced", "disconnected",
  "rigged", "the refs", "scripted", "game is rigged", "glitched", "bugged", "glitch", "its bugged",
  "my controller", "stick drift", "controller died", "my keyboard", "my mouse", "battery died", "game crashed", "i crashed",
  "wasnt trying", "wasn't trying", "not even trying", "didnt try", "didn't try", "i was afk", "was afk", "i was tired", "warming up"];
const COUNTERS = { draft: { action: 143, title: "🏈 \"When is the draft?\" counter", noun: "times someone has asked", foot: "asking again just makes this number go up" },
  excuse: { action: 144, title: "😤 Excuse Counter", noun: "excuses made", foot: "skill issue? nah, must be the wifi" } };
function counterEmbed(key, c) {
  const C = COUNTERS[key], top = Object.entries(c.users || {}).sort((a, b) => b[1] - a[1]).slice(0, 5), medal = ["🥇", "🥈", "🥉", "4.", "5."];
  const fields = [];
  if (key === "excuse" && c.cats && Object.values(c.cats).some(Boolean)) fields.push({ name: "What got blamed", value: EXCUSE_CATS.map(([n]) => `${n} — **${c.cats[n] || 0}**`).join("\n") });
  if (top.length) fields.push({ name: key === "excuse" ? "Biggest excuse makers" : "Biggest offenders", value: top.map(([u, n], k) => `${medal[k]} <@${u}> — **${n}**`).join("\n") });
  return { title: c.title || C.title, color: key === "excuse" ? 0xe8424a : 0xffc62f,
    description: `# ${c.count || 0}\n${C.noun}${c.last ? `\n\nLast one: <@${c.last.uid}> <t:${Math.floor(c.last.ts / 1000)}:R>` : ""}`,
    fields, footer: { text: `Updates automatically · ${C.foot}` } };
}
const snowTs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n), tsSnow = (t) => String(BigInt(t - 1420070400000) << 22n);
function excuseCat(text) {
  const t = String(text || "").toLowerCase();
  for (const [n, words] of EXCUSE_CATS) if (words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(t))) return n;
  return null;
}
async function tickCounter(env, key = null, force = false) {
  if (!env.VOTES) return null;
  if (!key) { for (const k of Object.keys(COUNTERS)) await tickCounter(env, k).catch((e) => console.log("counter", k, e.message)); return null; }
  const c = await kget(env, `counter:${key}`); if (!c) return null;
  const before = JSON.stringify(c);
  const guild = c.guild || (await league(env)).guild; c.guild = guild;
  const r = await discord(env, "GET", `/guilds/${guild}/audit-logs?action_type=${COUNTERS[key].action}&limit=100${c.lastAudit ? `&after=${c.lastAudit}` : ""}`).catch((e) => { if (e.status === 403) c.err = "The bot needs the View Audit Log permission."; return null; });
  let changed = force;
  if (r) {
    delete c.err;
    for (const e of (r.audit_log_entries || []).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
      c.lastAudit = e.id;
      if (c.rule && e.options?.auto_moderation_rule_name !== c.rule) continue;
      c.count = (c.count || 0) + 1; c.users = c.users || {}; c.users[e.target_id] = (c.users[e.target_id] || 0) + 1;
      c.last = { uid: e.target_id, ts: snowTs(e.id) }; changed = true;
    }
    if (!c.lastAudit) c.lastAudit = tsSnow(Date.now());   // first run: only count from now on
  }
  // excuses: read the alert channel to see WHAT got blamed (needs Message Content intent; skipped quietly if not available)
  if (key === "excuse" && c.alertCh) {
    const ms = await discord(env, "GET", `/channels/${c.alertCh}/messages?limit=100${c.lastMsg ? `&after=${c.lastMsg}` : ""}`).catch(() => null);
    if (ms) {
      c.cats = c.cats || {};
      for (const m of ms.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
        c.lastMsg = m.id;
        if (m.type !== 24) continue;
        const f = Object.fromEntries((m.embeds?.[0]?.fields || []).map((x) => [x.name, x.value]));
        if (c.rule && f.rule_name && f.rule_name !== c.rule) continue;
        const cat = excuseCat(f.keyword || f.keyword_matched_content || m.content || m.embeds?.[0]?.description);
        if (cat) { c.cats[cat] = (c.cats[cat] || 0) + 1; changed = true; }
      }
      if (!c.lastMsg) c.lastMsg = tsSnow(Date.now());
    }
  }
  if (changed && c.ch && c.msg) await discord(env, "PATCH", `/channels/${c.ch}/messages/${c.msg}`, { embeds: [counterEmbed(key, c)], allowed_mentions: { parse: [] } })
    .catch(async (e) => { if (e.status === 404) delete c.msg; });
  if (JSON.stringify(c) !== before) await kput(env, `counter:${key}`, c, 3650 * 86400);   // KV writes are limited — only save real changes
  return c;
}
async function counterAdmin(env, L, b) {
  const key = COUNTERS[b.key] ? b.key : "draft", K = `counter:${key}`;
  let c = await kget(env, K);
  if (b.remove) { if (c?.ch && c.msg) await discord(env, "DELETE", `/channels/${c.ch}/messages/${c.msg}`).catch(() => {}); await KV(env).delete(K); return { counter: null }; }
  if (b.setup) {
    c = c || { count: 0, users: {} };
    c.rule = String(b.setup.rule || ""); c.title = String(b.setup.title || "").slice(0, 200) || undefined;
    if (b.setup.alertCh) c.alertCh = String(b.setup.alertCh);
    if (key === "excuse" && b.setup.channel && b.setup.channel === c.alertCh) throw UE("That's the hidden log channel — pick a public channel for the board.");
    if (b.setup.channel && (b.setup.channel !== c.ch || !c.msg)) {
      if (c.ch && c.msg) await discord(env, "DELETE", `/channels/${c.ch}/messages/${c.msg}`).catch(() => {});
      const m = await discord(env, "POST", `/channels/${b.setup.channel}/messages`, { embeds: [counterEmbed(key, c)], allowed_mentions: { parse: [] } }).catch(() => { throw UE("The bot can't post in that channel."); });
      c.ch = b.setup.channel; c.msg = m.id;
    }
    await kput(env, K, c, 3650 * 86400);
  }
  if (b.reset && c) { c.count = 0; c.users = {}; c.cats = {}; delete c.last; await kput(env, K, c, 3650 * 86400); }
  if (b.add && c) { c.count = Math.max(0, (c.count || 0) + Math.round(+b.add)); await kput(env, K, c, 3650 * 86400); }
  if (c && (b.setup || b.reset || b.add || b.refresh)) c = await tickCounter(env, key, true);
  return { counter: c };
}
// hidden staff-only log channel for flag-only rules (AutoMod has to post its alerts somewhere)
async function hiddenLogChannel(env, L, by, name = "excuse-log", topic = "AutoMod log for the excuse counter — staff only, mute it.") {
  const chans = await discord(env, "GET", `/guilds/${L.guild}/channels`).catch(() => []);
  const ex = chans.find((c) => c.type === 0 && c.name === name); if (ex) return ex.id;
  const ch = await discord(env, "POST", `/guilds/${L.guild}/channels`, { name, type: 0, topic,
    ...(L.C.staffCategory ? { parent_id: L.C.staffCategory } : {}),
    permission_overwrites: [{ id: L.guild, type: 0, deny: "1024" }, ...(L.R.staff ? [{ id: L.R.staff, type: 0, allow: "1024" }] : [])] }, `Excuse counter log by ${by}`)
    .catch((e) => { throw e.status === 403 ? UE(`The bot needs the Manage Channels permission to create the hidden #${name} channel.`) : e; });
  return ch.id;
}
// move the excuse filter's alerts into the hidden channel and clean the alerts out of the old (public) channel
async function excuseMoveLog(env, L, by) {
  const rules = await discord(env, "GET", `/guilds/${L.guild}/auto-moderation/rules`).catch((e) => { throw AM_ERR(e); });
  const rule = rules.find((r) => r.name === "UFA: Excuses"); if (!rule) throw UE("There's no excuse filter yet.");
  const old = rule.actions.find((a) => a.type === 2)?.metadata?.channel_id, alertCh = await hiddenLogChannel(env, L, by);
  if (old !== alertCh) await discord(env, "PATCH", `/guilds/${L.guild}/auto-moderation/rules/${rule.id}`, { actions: [{ type: 2, metadata: { channel_id: alertCh } }] }, `Log moved by ${by}`).catch((e) => { throw AM_ERR(e); });
  const c = await kget(env, "counter:excuse");
  if (c) { c.alertCh = alertCh; c.lastMsg = tsSnow(Date.now()); await kput(env, "counter:excuse", c, 3650 * 86400); }
  let cleaned = 0;
  if (old && old !== alertCh) {   // delete AutoMod alert messages (type 24) from the old channel, keep everything else
    const ms = await discord(env, "GET", `/channels/${old}/messages?limit=100`).catch(() => []);
    const ids = ms.filter((m) => m.type === 24 && m.id !== c?.msg).map((m) => m.id);
    var intent = ms.filter((m) => m.type === 24).some((m) => (m.embeds?.[0]?.fields || []).length || m.content);
    if (ids.length > 1) { await discord(env, "POST", `/channels/${old}/messages/bulk-delete`, { messages: ids }).then(() => { cleaned = ids.length; }).catch(() => {}); }
    if (!cleaned) for (const id of ids) { await discord(env, "DELETE", `/channels/${old}/messages/${id}`).then(() => cleaned++).catch(() => {}); }
  }
  return { alertCh, cleaned, old, contentIntent: typeof intent === "undefined" ? null : intent };
}
async function ruleToHiddenLog(env, L, ruleId, by) {
  const rules = await discord(env, "GET", `/guilds/${L.guild}/auto-moderation/rules`).catch((e) => { throw AM_ERR(e); });
  const rule = rules.find((r) => r.id === ruleId); if (!rule) throw UE("Rule not found.");
  const name = (rule.name.replace(/^UFA:\s*/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "automod") + "-log";
  const ch = await hiddenLogChannel(env, L, by, name, `AutoMod log for "${rule.name}" — staff only, mute it.`);
  const actions = rule.actions.filter((a) => a.type !== 2).concat([{ type: 2, metadata: { channel_id: ch } }]);
  await discord(env, "PATCH", `/guilds/${L.guild}/auto-moderation/rules/${rule.id}`, { actions }, `Log moved by ${by}`).catch((e) => { throw AM_ERR(e); });
  return { channel: ch, name };
}
// one click: hidden #excuse-log channel + a flag-only AutoMod rule (messages stay up, they just get counted)
async function excuseSetup(env, L, b, by) {
  const alertCh = await hiddenLogChannel(env, L, by);
  const words = (b.words && b.words.length ? b.words : EXCUSE_WORDS);
  const rule = await automodSave(env, L, { name: "UFA: Excuses", trigger_type: 1, keywords: words, alert: alertCh, exemptRoles: [], enabled: true, flagOnly: true }, by);
  return { rule, alertCh };
}

// =====================================================================================================
// UFA Coins — economy & casino. Wallets live in KV ("w:<uid>", balance mirrored in metadata so the
// leaderboard is one list call). Interactive games keep their state in the button ids + the wallet.
// =====================================================================================================
const COIN = "🪙";
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const ECON_DEF = { ch: "", daily: 250, start: 500, enabled: true, minBet: 10, maxBet: 100000 };
const econCfg = async (env) => ({ ...ECON_DEF, ...((await kget(env, "econ:cfg")) || {}) });
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pickr = (a) => a[Math.floor(Math.random() * a.length)];
async function wallet(env, uid, cfg) {
  const w = await kget(env, `w:${uid}`);
  return w || { c: (cfg || ECON_DEF).start, g: { won: 0, lost: 0, best: 0 }, new: true };
}
async function saveW(env, uid, w, name) {
  delete w.new; w.n = name || w.n || "";
  await kput(env, `w:${uid}`, w, 3650 * 86400, { c: Math.round(w.c), n: String(w.n).slice(0, 40) });
}
const memName = (i) => i.member?.nick || i.member?.user?.global_name || i.member?.user?.username || i.user?.username || "someone";
function parseAmt(raw, w, cfg) {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[, ]/g, "");
  let n = s === "all" || s === "max" ? w.c : s === "half" ? Math.floor(w.c / 2) : /^\d+(\.\d+)?k$/.test(s) ? parseFloat(s) * 1000 : parseInt(s);
  n = Math.floor(n);
  if (!n || n < 1) throw UE(`How much? Use a number, \`half\` or \`all\`.`);
  if (n > w.c) throw UE(`You only have ${COIN} **${fmt(w.c)}**.`);
  if (n < cfg.minBet) throw UE(`Minimum bet is ${COIN} ${fmt(cfg.minBet)}.`);
  if (n > cfg.maxBet) throw UE(`Max bet is ${COIN} ${fmt(cfg.maxBet)}.`);
  return n;
}
const ecoTally = (w, net) => { w.g = w.g || { won: 0, lost: 0, best: 0 }; if (net > 0) { w.g.won++; w.g.best = Math.max(w.g.best || 0, net); } else if (net < 0) w.g.lost++; };
const ecoEmbed = (title, desc, color = 0xffc62f, extra = {}) => ({ embeds: [{ title, description: desc, color, ...extra }], allowed_mentions: { parse: [] } });
const pub = (data) => json({ type: 4, data });
const ephem = (content) => reply(content, true);
// mulberry32: seeded rng for games whose state lives in button ids
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seed32 = () => crypto.getRandomValues(new Uint32Array(1))[0];

const WORK = [
  ["held the first-down chains for a JV game", 1], ["sold overpriced nachos at the stadium", 1], ["reffed a 5v5 and only got yelled at twice", 1.2],
  ["washed the team bus", 0.9], ["edited a highlight tape for a FO", 1.3], ["played mascot for the Bills (it was hot)", 1.1],
  ["filmed a scrimmage on a cracked phone", 1], ["coached peewee flag football", 1.2], ["painted the end zone", 1], ["streamed the UFA game to 3 viewers", 0.8],
  ["fixed the stadium wifi so nobody can blame lag", 1.5], ["carried the water bottles", 0.9], ["wrote a hot take thread that went viral", 1.4],
];

async function econCommand(i, env, ctx, cmd) {
  const cfg = await econCfg(env), uid = uidOf(i), o = i.data.options || [], name = memName(i);
  if (!cfg.enabled) return ephem("🪙 UFA Coins is turned off right now.");
  const anywhere = ["balance", "leaderboard", "coinhelp"].includes(cmd);
  if (cfg.ch && i.channel_id !== cfg.ch && !anywhere) return ephem(`🎰 Use coin commands in <#${cfg.ch}>.`);
  const w = await wallet(env, uid, cfg), now = Date.now();
  switch (cmd) {
    case "coinhelp": return ephem([`**🪙 UFA Coins** — everyone starts with ${COIN} ${fmt(cfg.start)}`,
      "`/daily` free coins every day (streaks pay more) · `/work` every hour · `/balance` · `/leaderboard` · `/give`",
      "**Casino:** `/coinflip` `/slots` `/roulette` `/dice` `/blackjack` `/crash`",
      "**Football:** `/drive` (call the plays, score a TD) · `/simgame` (bet on a simulated game) · `/bet` (bet on real UFA games)",
      "`/rob` someone… if you dare. Bets accept numbers, `1.5k`, `half` or `all`."].join("\n"));
    case "balance": {
      const target = opt(o, "user") || uid, tw = target === uid ? w : await wallet(env, target, cfg);
      const g = tw.g || {};
      return pub(ecoEmbed(`${COIN} ${target === uid ? "Your" : "Their"} wallet`, `<@${target}> has **${COIN} ${fmt(tw.c)}**\n\nGames won **${g.won || 0}** · lost **${g.lost || 0}** · biggest win **${fmt(g.best || 0)}**${tw.s ? `\nDaily streak 🔥 **${tw.s}**` : ""}`));
    }
    case "daily": {
      const left = (w.d || 0) + 20 * 3600e3 - now;
      if (left > 0) return ephem(`⏳ Daily resets <t:${Math.floor((now + left) / 1000)}:R>.`);
      w.s = now - (w.d || 0) < 48 * 3600e3 ? Math.min((w.s || 0) + 1, 30) : 1;
      const bonus = Math.min(w.s - 1, 10) * 50, amt = cfg.daily + bonus;
      w.c += amt; w.d = now; await saveW(env, uid, w, name);
      return pub(ecoEmbed("🎁 Daily coins", `<@${uid}> claimed **${COIN} ${fmt(amt)}**${bonus ? ` (incl. 🔥 ${w.s}-day streak bonus +${fmt(bonus)})` : ""}\nBalance: **${COIN} ${fmt(w.c)}**`, 0x4fd18b));
    }
    case "work": {
      const left = (w.wk || 0) + 3600e3 - now;
      if (left > 0) return ephem(`😮‍💨 You're tired. Work again <t:${Math.floor((now + left) / 1000)}:R>.`);
      const [job, mult] = pickr(WORK), amt = Math.round(rint(60, 160) * mult);
      w.c += amt; w.wk = now; await saveW(env, uid, w, name);
      return pub(ecoEmbed("💼 Work", `<@${uid}> ${job} and earned **${COIN} ${fmt(amt)}**.\nBalance: **${COIN} ${fmt(w.c)}**`, 0x3d7bff));
    }
    case "give": {
      const to = opt(o, "user"); if (!to || to === uid) return ephem("Pick someone else.");
      const amt = parseAmt(opt(o, "amount"), w, { ...cfg, minBet: 1, maxBet: 1e12 });
      const tw = await wallet(env, to, cfg); w.c -= amt; tw.c += amt;
      const target = i.data.resolved?.members?.[to], tname = target?.nick || i.data.resolved?.users?.[to]?.global_name || i.data.resolved?.users?.[to]?.username || tw.n;
      await saveW(env, uid, w, name); await saveW(env, to, tw, tname);
      return pub(ecoEmbed("🤝 Coins sent", `<@${uid}> gave <@${to}> **${COIN} ${fmt(amt)}**.`, 0x4fd18b));
    }
    case "leaderboard": {
      const ks = await klist(env, "w:"), top = ks.map((k) => ({ id: k.name.slice(2), c: k.metadata?.c || 0, n: k.metadata?.n })).sort((a, b) => b.c - a.c).slice(0, 10);
      const me = ks.map((k) => k.metadata?.c || 0).sort((a, b) => b - a).indexOf(Math.round(w.c));
      const medal = ["🥇", "🥈", "🥉"];
      return pub(ecoEmbed("🏆 Richest in the UFA", top.map((x, k) => `${medal[k] || `**${k + 1}.**`} <@${x.id}> — ${COIN} **${fmt(x.c)}**`).join("\n") || "Nobody has coins yet. `/daily`!", 0xffc62f,
        { footer: { text: w.new ? "You're not on the board yet — /daily to start" : `You: ${fmt(w.c)} coins · rank #${me + 1} of ${ks.length}` } }));
    }
    case "coinflip": {
      const amt = parseAmt(opt(o, "amount"), w, cfg), side = opt(o, "side") || "heads", flip = Math.random() < 0.5 ? "heads" : "tails", win = side === flip;
      const net = win ? amt : -amt; w.c += net; ecoTally(w, net); await saveW(env, uid, w, name);
      return pub(ecoEmbed(`🪙 Coin flip — ${flip.toUpperCase()}`, `<@${uid}> called **${side}** and ${win ? `won **${COIN} ${fmt(amt)}** 🎉` : `lost **${COIN} ${fmt(amt)}** 💀`}\nBalance: **${COIN} ${fmt(w.c)}**`, win ? 0x4fd18b : 0xe8424a));
    }
    case "slots": {
      const amt = parseAmt(opt(o, "amount"), w, cfg);
      const reel = ["🏈", "🏈", "🏈", "🏟️", "🏟️", "🏆", "🏆", "💎", "🍒", "🍒", "🍒", "🧢", "🧢"];
      const r = [pickr(reel), pickr(reel), pickr(reel)];
      const pay = { "💎": 25, "🏆": 12, "🏟️": 8, "🏈": 5, "🍒": 4, "🧢": 3 };
      let mult = 0;
      if (r[0] === r[1] && r[1] === r[2]) mult = pay[r[0]];
      else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) mult = r.includes("💎") && r.filter((x) => x === "💎").length === 2 ? 3 : 1.5;
      const net = Math.round(amt * mult) - amt; w.c += net; ecoTally(w, net); await saveW(env, uid, w, name);
      return pub(ecoEmbed("🎰 Slots", `## ${r.join(" ┃ ")}\n<@${uid}> ${mult ? `won **${COIN} ${fmt(amt * mult)}** (${mult}x)${mult >= 8 ? " 🚨 **JACKPOT**" : ""}` : `lost **${COIN} ${fmt(amt)}**`}\nBalance: **${COIN} ${fmt(w.c)}**`, mult ? 0x4fd18b : 0xe8424a));
    }
    case "roulette": {
      const amt = parseAmt(opt(o, "amount"), w, cfg), bet = String(opt(o, "bet") || "red").toLowerCase().trim();
      const n = rint(0, 36), reds = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36], col = n === 0 ? "green" : reds.includes(n) ? "red" : "black";
      let mult = 0;
      if (/^\d+$/.test(bet)) { if (+bet > 36) return ephem("Numbers go 0–36."); mult = +bet === n ? 36 : 0; }
      else if (bet === "green" || bet === "0") mult = n === 0 ? 36 : 0;
      else if (bet === "red" || bet === "black") mult = col === bet ? 2 : 0;
      else if (bet === "odd" || bet === "even") mult = n && (n % 2 === 1) === (bet === "odd") ? 2 : 0;
      else if (bet === "low" || bet === "high") mult = n && (n <= 18) === (bet === "low") ? 2 : 0;
      else return ephem("Bet on `red`, `black`, `green`, `odd`, `even`, `low` (1–18), `high` (19–36) or a number 0–36.");
      const net = amt * mult - amt; w.c += net; ecoTally(w, net); await saveW(env, uid, w, name);
      const dot = { red: "🔴", black: "⚫", green: "🟢" }[col];
      return pub(ecoEmbed(`🎡 Roulette — ${dot} ${n}`, `<@${uid}> bet **${COIN} ${fmt(amt)}** on **${bet}** and ${mult ? `won **${COIN} ${fmt(amt * mult)}** (${mult}x) 🎉` : "lost 💀"}\nBalance: **${COIN} ${fmt(w.c)}**`, mult ? 0x4fd18b : 0xe8424a));
    }
    case "dice": {
      const amt = parseAmt(opt(o, "amount"), w, cfg), d = () => rint(1, 6), me = [d(), d()], bot = [d(), d()], a = me[0] + me[1], b = bot[0] + bot[1];
      const net = a > b ? amt : a < b ? -amt : 0; w.c += net; ecoTally(w, net); await saveW(env, uid, w, name);
      const face = (x) => ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][x - 1];
      return pub(ecoEmbed("🎲 Dice", `<@${uid}> rolled ${face(me[0])}${face(me[1])} **${a}** · Bot rolled ${face(bot[0])}${face(bot[1])} **${b}**\n${net > 0 ? `You win **${COIN} ${fmt(amt)}** 🎉` : net < 0 ? `You lose **${COIN} ${fmt(amt)}** 💀` : "Push — bet returned."}\nBalance: **${COIN} ${fmt(w.c)}**`, net > 0 ? 0x4fd18b : net < 0 ? 0xe8424a : 0x93a0bf));
    }
    case "crash": {
      const amt = parseAmt(opt(o, "amount"), w, cfg), target = Math.max(1.1, Math.min(50, parseFloat(String(opt(o, "cashout") || "2").replace("x", "")) || 2));
      const crashAt = Math.max(1, Math.floor((0.97 / (1 - Math.random())) * 100) / 100);
      const win = crashAt >= target, net = win ? Math.round(amt * target) - amt : -amt; w.c += net; ecoTally(w, net); await saveW(env, uid, w, name);
      return pub(ecoEmbed(`🚀 Crash — rocket blew up at ${crashAt.toFixed(2)}x`, `<@${uid}> was cashing out at **${target.toFixed(2)}x** with **${COIN} ${fmt(amt)}**\n${win ? `Cashed out **${COIN} ${fmt(amt * target)}** 🎉` : "Boom. Lost it all 💥"}\nBalance: **${COIN} ${fmt(w.c)}**`, win ? 0x4fd18b : 0xe8424a));
    }
    case "rob": {
      const to = opt(o, "user"); if (!to || to === uid) return ephem("Rob someone else.");
      const left = (w.rb || 0) + 2 * 3600e3 - now; if (left > 0) return ephem(`🚔 Lay low. You can rob again <t:${Math.floor((now + left) / 1000)}:R>.`);
      if (w.c < 200) return ephem(`You need at least ${COIN} 200 to attempt a robbery (bail money).`);
      const tw = await wallet(env, to, cfg); if (tw.new || tw.c < 200) return ephem("They're broke. Not worth it.");
      w.rb = now;
      if (Math.random() < 0.42) {
        const take = Math.min(Math.round(tw.c * (rint(10, 25) / 100)), 2500); w.c += take; tw.c -= take;
        await saveW(env, uid, w, name); await saveW(env, to, tw);
        return pub(ecoEmbed("🦹 Robbery", `<@${uid}> robbed <@${to}> for **${COIN} ${fmt(take)}**! 💰`, 0x4fd18b, {}));
      }
      const fine = Math.min(Math.round(w.c * 0.15), 1500); w.c -= fine; tw.c += fine;
      await saveW(env, uid, w, name); await saveW(env, to, tw);
      return pub(ecoEmbed("🚔 Caught!", `<@${uid}> tried to rob <@${to}> and got caught — paid them **${COIN} ${fmt(fine)}** in damages.`, 0xe8424a));
    }
    case "simgame": return simGame(i, env, cfg, w, uid, name, o);
    case "blackjack": {
      if (w.bj && now - w.bj.t < 10 * 60e3) return ephem("You already have a blackjack hand going — finish it first.");
      const amt = parseAmt(opt(o, "amount"), w, cfg), seed = seed32();
      w.c -= amt; w.bj = { bet: amt, seed, t: now }; await saveW(env, uid, w, name);
      return pub(bjView(uid, w.bj, ""));
    }
    case "drive": {
      if (w.dr && now - w.dr.t < 10 * 60e3) return ephem("You've got a drive going — finish it first.");
      const amt = parseAmt(opt(o, "amount"), w, cfg), seed = seed32();
      w.c -= amt; w.dr = { bet: amt, seed, t: now }; await saveW(env, uid, w, name);
      return pub(driveView(uid, w.dr, ""));
    }
    case "bet": return betCmd(i, env, cfg, w, uid, name, o);
  }
  return ephem("Unknown coin command.");
}

// ---------- blackjack (state = seed + actions in the button id; payout settles once against the wallet) ----------
const CARD = (k) => ({ r: ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"][k % 13], s: ["♠", "♥", "♦", "♣"][Math.floor(k / 13) % 4] });
function deck(seed) { const r = rng(seed), d = [...Array(52).keys()]; for (let k = 51; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [d[k], d[j]] = [d[j], d[k]]; } return d.map(CARD); }
const hv = (h) => { let t = 0, a = 0; for (const c of h) { t += c.r === "A" ? 11 : ["J", "Q", "K"].includes(c.r) ? 10 : +c.r; if (c.r === "A") a++; } while (t > 21 && a) { t -= 10; a--; } return t; };
const show = (h) => h.map((c) => `\`${c.r}${c.s}\``).join(" ");
function bjState(g, acts) {
  const d = deck(g.seed); let p = 0; const P = [d[p++], d[p++]], D = [d[p++], d[p++]]; let bet = g.bet, done = false, msg = "";
  if (hv(P) === 21) { done = true; }
  for (const a of acts) { if (done) break;
    if (a === "h") { P.push(d[p++]); if (hv(P) >= 21) done = true; }
    else if (a === "d") { bet *= 2; P.push(d[p++]); done = true; }
    else if (a === "s") done = true; }
  let pay = 0;
  if (done) {
    const pv = hv(P), bj = pv === 21 && P.length === 2;
    if (pv <= 21 && !bj) while (hv(D) < 17) D.push(d[p++]);
    const dv = hv(D), dbj = dv === 21 && D.length === 2;
    if (pv > 21) { msg = "Bust 💀"; pay = 0; }
    else if (bj && !dbj) { msg = "BLACKJACK! 🃏"; pay = Math.floor(bet * 2.5); }
    else if (dbj && !bj) { msg = "Dealer has blackjack 💀"; pay = 0; }
    else if (dv > 21) { msg = "Dealer busts — you win 🎉"; pay = bet * 2; }
    else if (pv > dv) { msg = "You win 🎉"; pay = bet * 2; }
    else if (pv < dv) { msg = "Dealer wins 💀"; pay = 0; }
    else { msg = "Push — bet back"; pay = bet; }
  }
  return { P, D, done, pay, bet, msg };
}
function bjView(uid, g, acts, final) {
  const st = bjState(g, acts), s = final || st;
  const desc = `<@${uid}> · bet **${COIN} ${fmt(st.bet)}**\n\n**You** (${hv(st.P)}): ${show(st.P)}\n**Dealer** (${st.done ? hv(st.D) : "?"}): ${st.done ? show(st.D) : `${show([st.D[0]])} \`??\``}${st.done ? `\n\n**${st.msg}**${st.pay ? ` — paid **${COIN} ${fmt(st.pay)}**` : ""}${s.bal != null ? `\nBalance: **${COIN} ${fmt(s.bal)}**` : ""}` : ""}`;
  const comps = st.done ? [] : [row(btn("Hit", 1, `bj:${uid}:${acts}h`), btn("Stand", 2, `bj:${uid}:${acts}s`), ...(acts === "" ? [btn("Double", 3, `bj:${uid}:${acts}d`)] : []))];
  return { embeds: [{ title: "🃏 Blackjack", description: desc, color: st.done ? (st.pay > st.bet ? 0x4fd18b : st.pay === st.bet ? 0x93a0bf : 0xe8424a) : 0x3d7bff }], components: comps, allowed_mentions: { parse: [] } };
}

// ---------- drive: call plays from the opponent's 35, score a TD in 4 downs (or kick a FG) ----------
const PLAYS = { r: "🏃 Run", p: "🎯 Short pass", d: "🚀 Deep shot", k: "🦵 Field goal" };
function driveState(g, acts) {
  const r = rng(g.seed); let yl = 35, down = 1, done = false, res = "", log = [], mult = 0;
  for (const a of acts) { if (done) break;
    const x = r();
    if (a === "k") { const dist = yl + 17, chance = Math.max(0.15, 1 - (dist - 20) * 0.022); done = true;
      if (x < chance) { res = `🦵 ${dist}-yard field goal is GOOD`; mult = 1.25; } else res = `🦵 ${dist}-yard field goal… no good 💀`; break; }
    let gain = 0, txt = "";
    if (a === "r") { if (x < 0.03) { done = true; res = "🏃 FUMBLE! Defense recovers 💀"; break; } gain = Math.round(-2 + r() * 11); txt = gain <= 0 ? `stuffed for ${gain}` : `${gain}-yard run`; }
    if (a === "p") { if (x < 0.05) { done = true; res = "🎯 INTERCEPTED 💀"; break; } if (x < 0.22) { gain = 0; txt = "incomplete"; } else { gain = Math.round(4 + r() * 12); txt = `${gain}-yard catch`; } }
    if (a === "d") { if (x < 0.14) { done = true; res = "🚀 Picked off deep 💀"; break; } if (x < 0.68) { gain = 0; txt = "incomplete deep"; } else { gain = Math.round(14 + r() * 26); txt = `${gain}-yard bomb`; } }
    yl -= gain; log.push(`${down}${["st", "nd", "rd", "th"][down - 1]} down — ${PLAYS[a]}: ${txt}`);
    if (yl <= 0) { done = true; res = `🏈 TOUCHDOWN!`; mult = 2; break; }
    down++; if (down > 4) { done = true; res = "Turnover on downs 💀"; }
  }
  return { yl: Math.max(yl, 0), down, done, res, log, mult, pay: Math.round(g.bet * mult) };
}
function driveView(uid, g, acts, bal) {
  const st = driveState(g, acts), field = Math.round((35 - Math.min(35, st.yl)) / 35 * 14);
  const bar = "🟩".repeat(Math.max(0, field)) + "🏈" + "⬛".repeat(Math.max(0, 14 - field)) + "🥅";
  const desc = `<@${uid}> · bet **${COIN} ${fmt(g.bet)}** · TD pays **2x**, FG pays **1.25x**\n${bar}\n${st.log.map((l) => `> ${l}`).join("\n")}${st.log.length ? "\n" : ""}${st.done ? `\n**${st.res}**${st.pay ? ` — won **${COIN} ${fmt(st.pay)}**` : ""}${bal != null ? `\nBalance: **${COIN} ${fmt(bal)}**` : ""}` : `\n**${st.down}${["st", "nd", "rd", "th"][st.down - 1]} down**, ball on the opponent's **${st.yl}**. Call a play:`}`;
  const comps = st.done ? [] : [row(btn(PLAYS.r, 2, `dr:${uid}:${acts}r`), btn(PLAYS.p, 1, `dr:${uid}:${acts}p`), btn(PLAYS.d, 4, `dr:${uid}:${acts}d`), ...(st.yl + 17 <= 55 ? [btn(PLAYS.k, 3, `dr:${uid}:${acts}k`)] : []))];
  return { embeds: [{ title: "🏈 Drive for the win", description: desc, color: st.done ? (st.pay ? 0x4fd18b : 0xe8424a) : 0x3d7bff }], components: comps, allowed_mentions: { parse: [] } };
}
async function econComponent(i, env, kind, owner, acts) {
  const uid = uidOf(i);
  if (uid !== owner) return ephem("That's not your game — start your own!");
  const cfg = await econCfg(env), w = await wallet(env, uid, cfg), name = memName(i);
  if (kind === "bj") {
    if (!w.bj) return json({ type: 7, data: { components: [] } });
    if (acts.endsWith("d") && w.c < w.bj.bet) return ephem("Not enough coins to double — hit or stand.");
    const st = bjState(w.bj, acts);
    if (!st.done) return json({ type: 7, data: bjView(uid, w.bj, acts) });
    const g = w.bj; if (acts.endsWith("d")) w.c -= g.bet;
    w.c += st.pay; ecoTally(w, st.pay - st.bet); delete w.bj; await saveW(env, uid, w, name);
    return json({ type: 7, data: bjView(uid, g, acts, { bal: w.c }) });
  }
  if (kind === "dr") {
    if (!w.dr) return json({ type: 7, data: { components: [] } });
    const st = driveState(w.dr, acts);
    if (!st.done) return json({ type: 7, data: driveView(uid, w.dr, acts) });
    const g = w.dr; w.c += st.pay; ecoTally(w, st.pay - g.bet); delete w.dr; await saveW(env, uid, w, name);
    return json({ type: 7, data: driveView(uid, g, acts, w.c) });
  }
  return ephem("Unknown game.");
}

// ---------- simulated game ----------
async function simGame(i, env, cfg, w, uid, name, o) {
  const L = await league(env), T = L.teams;
  const find = (q) => { q = String(q || "").toLowerCase().trim(); return T.find((t) => t.abbr.toLowerCase() === q || t.name.toLowerCase() === q) || T.find((t) => t.name.toLowerCase().includes(q)); };
  const mine = find(opt(o, "team")) || pickr(T); let opp = find(opt(o, "opponent")); if (!opp || opp.abbr === mine.abbr) { do { opp = pickr(T); } while (opp.abbr === mine.abbr); }
  const amt = opt(o, "amount") ? parseAmt(opt(o, "amount"), w, cfg) : 0;
  const nick = (t) => t.name.split(" ").pop(), sc = { a: 0, b: 0 }, q = [[0, 0], [0, 0], [0, 0], [0, 0]], plays = [];
  const ratA = 0.9 + Math.random() * 0.4, ratB = 0.9 + Math.random() * 0.4;
  const td = ["%s %d-yard TD pass", "%s %d-yard TD run", "%s pick-six from %d out", "%s %d-yard catch-and-run TD", "%s punt return TD (%d yds)"];
  for (let k = 0; k < 4; k++) for (const [side, t, rat] of [["a", mine, ratA], ["b", opp, ratB]]) {
    const drives = rint(1, 3);
    for (let d = 0; d < drives; d++) { const x = Math.random() / rat;
      if (x < 0.32) { q[k][side === "a" ? 0 : 1] += 7; sc[side] += 7; if (plays.length < 7 || Math.random() < 0.3) plays.push(`Q${k + 1} — ${pickr(td).replace("%s", nick(t)).replace("%d", rint(3, 75))}`); }
      else if (x < 0.5) { q[k][side === "a" ? 0 : 1] += 3; sc[side] += 3; if (Math.random() < 0.3) plays.push(`Q${k + 1} — ${nick(t)} ${rint(22, 54)}-yard FG`); } }
  }
  let ot = "";
  if (sc.a === sc.b) { const wa = Math.random() < 0.5; sc[wa ? "a" : "b"] += 6; ot = ` (OT — ${nick(wa ? mine : opp)} walk-off TD)`; }
  const won = sc.a > sc.b;
  let money = "";
  if (amt) { const net = won ? Math.round(amt * 0.9) : -amt; w.c += net; ecoTally(w, net); await saveW(env, uid, w, name);
    money = `\n\n<@${uid}> bet **${COIN} ${fmt(amt)}** on the **${nick(mine)}** — ${won ? `won **${COIN} ${fmt(amt + net)}** 🎉` : "lost 💀"}\nBalance: **${COIN} ${fmt(w.c)}**`; }
  const table = "```\n" + `      Q1 Q2 Q3 Q4  F\n${mine.abbr.padEnd(5)} ${q.map((x) => String(x[0]).padStart(2)).join(" ")} ${String(sc.a).padStart(2)}\n${opp.abbr.padEnd(5)} ${q.map((x) => String(x[1]).padStart(2)).join(" ")} ${String(sc.b).padStart(2)}\n` + "```";
  return pub({ embeds: [{ title: `🏟️ ${mine.name} ${sc.a} – ${sc.b} ${opp.name}${ot}`, color: won ? 0x4fd18b : 0xe8424a,
    description: `${table}${plays.slice(0, 8).map((p) => `> ${p}`).join("\n")}${money}`, footer: { text: "Simulated game · just for fun" } }], allowed_mentions: { parse: [] } });
}

// ---------- bets on real UFA games (this week's schedule); staff settle them on the admin page ----------
async function curWeek(env) { const S = await loadSched(env); const k = S.weeks.findIndex((w) => !w.done); const wk = k >= 0 ? S.weeks[k] : S.weeks[S.weeks.length - 1]; return { S, wk }; }
async function betCmd(i, env, cfg, w, uid, name, o) {
  const { S, wk } = await curWeek(env); if (!wk) return ephem("There's no schedule yet.");
  const q = String(opt(o, "team") || "").toLowerCase().trim(), team = S.teams.find((t) => t.abbr.toLowerCase() === q || t.name.toLowerCase() === q) || S.teams.find((t) => t.name.toLowerCase().includes(q));
  if (!team) return ephem("Which team? Type a team name.");
  const g = wk.games.find((x) => x.a === team.abbr || x.b === team.abbr); if (!g) return ephem(`The ${team.name} don't play in week ${wk.week}.`);
  if (g.result) return ephem("That game already has a result — betting is closed.");
  const key = `bet:${wk.week}:${g.a}-${g.b}:${uid}`;
  if (await kget(env, key)) return ephem("You already bet on that game.");
  const amt = parseAmt(opt(o, "amount"), w, cfg); w.c -= amt; await saveW(env, uid, w, name);
  await kput(env, key, { u: uid, t: team.abbr, a: amt, n: name }, 60 * 86400, { w: wk.week, g: `${g.a}-${g.b}`, t: team.abbr, a: amt });
  const opp = S.teams.find((t) => t.abbr === (g.a === team.abbr ? g.b : g.a));
  return pub(ecoEmbed("🎟️ Bet placed", `<@${uid}> bet **${COIN} ${fmt(amt)}** on the **${team.name}** to beat the ${opp?.name || "?"} (week ${wk.week}).\nPays **1.9x** if they win. Staff settle bets when the result is in.`, 0x3d7bff));
}
async function econAdmin(env, L, b, by) {
  if (b.cfg) { const c = { ...(await econCfg(env)), ...b.cfg }; c.daily = Math.max(0, +c.daily || 0); c.start = Math.max(0, +c.start || 0); await kput(env, "econ:cfg", c, 3650 * 86400); return { cfg: c }; }
  if (b.createChannel) {
    const chans = await discord(env, "GET", `/guilds/${L.guild}/channels`);
    const cat = chans.find((c) => c.type === 4 && /member/i.test(c.name)) || chans.find((c) => c.type === 4 && /general|text|chat/i.test(c.name));
    const ch = await discord(env, "POST", `/guilds/${L.guild}/channels`, { name: "🪙│ufa-coins", type: 0, ...(cat ? { parent_id: cat.id } : {}),
      topic: "UFA Coins — /daily /work /balance /leaderboard · casino: /blackjack /slots /roulette /coinflip /dice /crash · football: /drive /simgame /bet · /coinhelp", rate_limit_per_user: 2 }, `UFA Coins channel by ${by}`)
      .catch((e) => { throw e.status === 403 ? UE("The bot needs Manage Channels to create the channel.") : e; });
    const c = { ...(await econCfg(env)), ch: ch.id }; await kput(env, "econ:cfg", c, 3650 * 86400);
    await discord(env, "POST", `/channels/${ch.id}/messages`, { embeds: [{ title: "🪙 Welcome to UFA Coins", color: 0xffc62f, description: [`Everyone starts with **${COIN} ${fmt(c.start)}**. Get rich, go broke, flex on the leaderboard.`,
      "", "**💰 Earn** — `/daily` (streaks stack!) · `/work` every hour", "**🎰 Casino** — `/blackjack` `/slots` `/roulette` `/coinflip` `/dice` `/crash`",
      "**🏈 Football** — `/drive` call the plays and score · `/simgame` bet on a simulated game · `/bet` on real UFA games", "**😈 Other** — `/give` · `/rob` (risky) · `/balance` · `/leaderboard`", "", "Fake money, just for fun. Type `/coinhelp` any time."].join("\n") }] }).catch(() => {});
    return { cfg: c, channel: ch.id, category: cat?.name || null };
  }
  if (b.adjust) { const { uid, amount } = b.adjust; const w = await wallet(env, uid); w.c = Math.max(0, w.c + Math.round(+amount || 0)); await saveW(env, uid, w, b.adjust.name); return { ok: true, c: w.c }; }
  if (b.settle) {   // {week, game:"A-B", winner:"A"|"B"|"refund"}
    const ks = (await klist(env, `bet:${b.settle.week}:${b.settle.game}:`)); let paid = 0, n = 0;
    for (const k of ks) { const bt = await kget(env, k.name); if (!bt) continue; n++;
      const w = await wallet(env, bt.u), win = b.settle.winner === "refund" ? bt.a : bt.t === b.settle.winner ? Math.round(bt.a * 1.9) : 0;
      if (win) { w.c += win; paid += win; } if (b.settle.winner !== "refund") ecoTally(w, win - bt.a);
      await saveW(env, bt.u, w); await KV(env).delete(k.name);
      if (win && b.settle.winner !== "refund") await dm(env, bt.u, `🎟️ Your bet on the **${bt.t}** hit! You won ${COIN} **${fmt(win)}** UFA Coins.`).catch(() => {});
    }
    return { ok: true, bets: n, paid };
  }
  if (b.reset) { if (String(b.confirm || "").toUpperCase() !== "RESET COINS") throw UE("Type RESET COINS to confirm."); const ks = await klist(env, "w:"); for (const k of ks) await KV(env).delete(k.name); return { ok: true, deleted: ks.length }; }
  // overview
  const [cfg, ws, bets, S, chans] = await Promise.all([econCfg(env), klist(env, "w:"), klist(env, "bet:"), loadSched(env), discord(env, "GET", `/guilds/${L.guild}/channels`).catch(() => [])]);
  const top = ws.map((k) => ({ id: k.name.slice(2), c: k.metadata?.c || 0, n: k.metadata?.n || "" })).sort((a, b) => b.c - a.c);
  const games = {};
  for (const k of bets) { const m = k.metadata || {}; const g = games[`${m.w}|${m.g}`] = games[`${m.w}|${m.g}`] || { week: m.w, game: m.g, pool: 0, bets: [] }; g.pool += m.a || 0; g.bets.push({ t: m.t, a: m.a }); }
  for (const g of Object.values(games)) { const wk = S.weeks.find((x) => x.week === g.week), gm = wk?.games.find((x) => `${x.a}-${x.b}` === g.game); g.result = gm?.result || ""; }
  return { cfg, players: top.length, total: top.reduce((s, x) => s + x.c, 0), top: top.slice(0, 50), games: Object.values(games), teams: S.teams.map(({ abbr, name, color }) => ({ abbr, name, color })),
    channels: chans.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) };
}

// ---------- open free agency (skip the draft) ----------
// Runs in small steps (Workers can only make so many calls per request): the page keeps calling until done.
async function openFreeAgency(env, L, admin, body) {
  const teamIds = new Set(L.teams.map((t) => t.roleId).filter(Boolean)), M = body.preview || body.start ? await members(env, L, true) : [];
  let job = await kget(env, "job:openfa");
  if (body.preview) {
    const d = L.R.draftable ? M.filter((m) => (m.roles || []).includes(L.R.draftable)) : [];
    return { draftable: d.length, toFA: d.filter((m) => !(m.roles || []).some((r) => teamIds.has(r))).length, faRole: !!L.R.fa, draftStatus: L.draftStatus, running: job ? { i: job.i, total: job.list.length } : null };
  }
  if (body.start) {
    if (["live", "paused"].includes(L.draftStatus)) throw UE("The draft is running — end it in the draft room first.");
    if (String(body.confirm || "").trim().toUpperCase() !== "FREE AGENCY") throw UE('Type FREE AGENCY to confirm.');
    let fa = L.R.fa;
    if (!fa) { const r = await discord(env, "POST", `/guilds/${L.guild}/roles`, { name: "Free Agent", mentionable: false, hoist: false }, "Free agency opened"); fa = r.id; bust("league"); }
    const list = L.R.draftable ? M.filter((m) => (m.roles || []).includes(L.R.draftable)).map((m) => [m.user.id, !(m.roles || []).some((r) => teamIds.has(r))]) : [];
    job = { list, i: 0, fa, draftable: L.R.draftable, by: staffSig(admin), moved: 0, errors: 0, announce: !!body.announce, started: Date.now() };
    // mark the draft as skipped so post-draft releases send people to free agency too
    for (let attempt = 0; attempt < 3; attempt++) {
      const { D, sha } = await loadDraft(env); D.status = "skipped";
      try { await putJSON(env, "draft.json", D, sha, `Staff (${job.by}): skipped the draft — free agency is open`); break; }
      catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
    }
    bust("league");
  }
  if (!job) return { done: true, i: 0, total: 0, moved: 0 };
  const end = Math.min(job.list.length, job.i + (body.start ? 8 : 14));
  for (; job.i < end; job.i++) {
    const [uid, free] = job.list[job.i];
    try {
      await discord(env, "DELETE", `/guilds/${L.guild}/members/${uid}/roles/${job.draftable}`, null, "Free agency opened");
      if (free) { await discord(env, "PUT", `/guilds/${L.guild}/members/${uid}/roles/${job.fa}`, null, "Free agency opened"); job.moved++; }
    } catch (e) { if (e.status === 403) { await kput(env, "job:openfa", job, 3600); throw UE("Discord refused a role change — the bot's role must sit above Draftable and Free Agent. Fix that, then press the button again to continue."); } if (e.status !== 404) job.errors++; }
  }
  if (job.i < job.list.length) { await kput(env, "job:openfa", job, 3600); return { done: false, i: job.i, total: job.list.length, moved: job.moved }; }
  await KV(env).delete("job:openfa"); bust("members");
  if (job.announce && L.C.transactions) {
    await discord(env, "POST", `/channels/${L.C.transactions}/messages`, { embeds: [{ title: "🆓 Free agency is open!", color: 0x4fd18b,
      description: `There's no draft this season — **${job.moved}** players are now **Free Agents**.\n\n**Franchise owners:** sign players with **/offer** (they accept from their DMs).\n**Players:** check your offers with **/offers**, or use **/fa list** to see who's available.\n\nRosters are capped at **${cap(L)}**.`,
      footer: { text: `Opened by ${job.by}` }, timestamp: new Date().toISOString() }] }).catch(() => {});
  }
  return { done: true, i: job.i, total: job.list.length, moved: job.moved, errors: job.errors };
}

async function deletePosition(env, name, by) {   // remove a (custom) position from the list and from everyone who has it
  name = String(name || "").trim(); if (!name) throw UE("Which position?");
  if (["QB", "RB", "WR", "TE", "OL", "DE", "LB", "CB", "S", "K/P"].includes(name)) throw UE("Standard positions can't be deleted.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { D, sha } = await loadDraft(env); let n = 0;
    D.positions = (D.positions || []).filter((x) => x !== name);
    for (const p of D.pool) if ((p.pos || []).includes(name)) { p.pos = p.pos.filter((x) => x !== name); n++; }
    try { await putJSON(env, "draft.json", D, sha, `Staff (${by}): deleted position "${name}" (${n} player${n === 1 ? "" : "s"})`); return { ok: true, removedFrom: n }; }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  throw UE("The draft file was busy — try again.");
}
async function notifyPositions(env, ids, silent = false) {   // silent: just take them off the "needs telling" list   // DM up to 12 pool players their current positions, then mark them as told
  ids = [...new Set((ids || []).map(Number))].slice(0, 12);
  const { D } = await loadDraft(env), results = [];
  for (const id of ids) {
    const p = D.pool.find((x) => x.id === id);
    if (!p?.discord) { results.push({ id, ok: false, name: p?.name || String(id) }); continue; }
    results.push({ id, name: p.name, ok: silent ? true : await staffSend(env, p.discord, posDM(p.pos || []), "UFA Staff") });
  }
  const ok = results.filter((r) => r.ok).map((r) => r.id);
  for (let attempt = 0; attempt < 3 && ok.length; attempt++) {
    const { D, sha } = await loadDraft(env), now = Date.now();
    D.pool.forEach((p) => { if (ok.includes(p.id)) p.posNotified = now; });
    try { await putJSON(env, "draft.json", D, sha, silent ? `Skipped telling ${ok.length} player(s) about position changes` : `Told ${ok.length} player(s) their updated positions`); break; }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  return { results };
}
async function adminPlayers(env, L) {
  const [M, { D }] = await Promise.all([members(env, L, true), loadDraft(env)]), H = helpers(D);
  const draftedBy = new Map(D.picks.map((pk, n) => [pk.player, { team: H.slot(n).team, overall: n + 1 }]));
  const byUid = new Map(D.pool.filter((p) => p.discord).map((p) => [p.discord, p]));
  const has = (m, r) => !!r && (m.roles || []).includes(r);
  const rows = M.map((m) => {
    const pi = info(L, m), p = byUid.get(pi.id);
    return { ...pi, foRole: has(m, L.R.fo), draftable: has(m, L.R.draftable), fa: has(m, L.R.fa), joined: m.joined_at || null,
      pool: p ? { id: p.id, pos: p.pos || [], drafted: draftedBy.get(p.id) || null, rank: p.rank ?? null } : null };
  });
  const inServer = new Set(M.map((m) => m.user.id));
  for (const p of D.pool) if (!p.discord || !inServer.has(p.discord))
    rows.push({ id: p.discord || null, name: p.name, avatar: p.avatar || null, team: null, rank: null, staff: false, gone: true,
      pool: { id: p.id, pos: p.pos || [], drafted: draftedBy.get(p.id) || null, rank: p.rank ?? null } });
  const recent = await recentPosEdits(env, D).catch(() => []);
  return { rows, recent, positions: D.positions || [], draftStatus: D.status, roles: { draftable: !!L.R.draftable, fa: !!L.R.fa } };
}
async function adminPlayer(env, L, body, by = "admin") {   // {uid | poolId, pos?: "WR/CB" | [..], pool?: "add" | "remove"}
  const uid = body.uid ? String(body.uid) : null, poolId = body.poolId != null ? +body.poolId : null;
  const M = uid ? await members(env, L, true) : [], m = uid ? M.find((x) => x.user.id === uid) : null;
  if (uid && !m && body.pool === "add") throw UE("They aren't in the server.");
  if (body.pool === "add" && L.R.draftable) await addRole(env, L, uid, L.R.draftable, "Added to the draft pool by staff");
  if (body.pool === "remove" && m && L.R.draftable) await delRole(env, L, uid, L.R.draftable, "Removed from the draft pool by staff").catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    const { D, sha } = await loadDraft(env), H = helpers(D);
    let p = D.pool.find((x) => (uid && x.discord === uid) || (poolId != null && x.id === poolId)), what, tell = false;
    if (body.pool === "remove") {
      if (!p) return { ok: true, text: "Removed." };
      if (H.taken.has(p.id)) throw UE(`${p.name} has already been drafted — undo the pick in the draft room first.`);
      D.pool = D.pool.filter((x) => x !== p); what = `removed ${p.name} from the pool`;
    } else {
      if (!p) {
        if (!m) throw UE("They aren't in the player pool or the server.");
        p = { id: Math.max(0, ...D.pool.map((x) => x.id)) + 1, name: cleanName(display(m)) || m.user.username, pos: [], discord: uid, avatar: avatarUrl(L.guild, m) };
        D.pool.push(p);
        if (L.R.draftable && body.pool !== "add") await addRole(env, L, uid, L.R.draftable, "Added to the draft pool by staff").catch(() => {});   // the hourly sync keeps the pool = Draftable role
      }
      if (body.pos != null) {
        const before = (p.pos || []).join("/");
        const pos = [];   // standard positions are normalised (HB -> RB); anything else is kept as a custom position
        for (const raw of (Array.isArray(body.pos) ? body.pos : String(body.pos).split(/[\/,]+/))) {
          const t = String(raw).replace(/[^\w .+\-\/]/g, "").trim().slice(0, 16); if (!t) continue;
          const v = POS[t.toUpperCase()] || (t.toUpperCase() === "K/P" ? "K/P" : t);
          if (!pos.includes(v)) pos.push(v);
        }
        pos.splice(20);
        p.pos = pos; p.locked = true;
        if (pos.join("/") !== before) { p.posAt = Date.now(); if (m && body.notify !== false) { tell = true; p.posNotified = p.posAt; } }
        D.positions = D.positions || []; for (const x of pos) if (!D.positions.includes(x)) D.positions.push(x);
      }
      what = `${p.name}: ${posTxt(p) || "no positions"}`;
    }
    try { await putJSON(env, "draft.json", D, sha, `Staff (${by}): ${what}`); }
    catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
    const dmed = tell ? await staffSend(env, uid, posDM(p.pos || []), by) : null;
    return { ok: true, text: what, pos: p.pos || [], dmed };
  }
  throw UE("The draft file was busy — try again.");
}

// ---------- live franchise owner list (/setownerchannel) ----------
async function refreshOwnersBoard(env, L, force = false) {
  const b = env.VOTES ? await kget(env, "board:owners") : null;
  if (!b) return null;
  L = L || await league(env);
  const embeds = await franchisesEmbeds(env, L);
  const sig = await sha256(JSON.stringify(embeds.map((e) => [e.title, e.description])));
  if (!force && sig === b.sig) return b;
  const last = embeds[embeds.length - 1];
  last.footer = { text: `${last.footer?.text || "UFA League"} · Updates automatically` }; last.timestamp = new Date().toISOString();
  try { await discord(env, "PATCH", `/channels/${b.ch}/messages/${b.id}`, { embeds, allowed_mentions: { parse: [] } }); }
  catch (e) { if (e.status === 404) { await KV(env).delete("board:owners"); return null; } throw e; }   // message deleted = board turned off
  b.sig = sig; b.updated = Date.now(); await kput(env, "board:owners", b, 3650 * 86400);
  return b;
}
async function setOwnerChannel(env, i) {
  const L = await league(env);
  if (!isStaff(env, L, uidOf(i), i.member?.roles || [], i.member?.permissions)) return "Only staff can do this.";
  const old = await kget(env, "board:owners");
  const embeds = await franchisesEmbeds(env, L), last = embeds[embeds.length - 1];
  last.footer = { text: `${last.footer?.text || "UFA League"} · Updates automatically` }; last.timestamp = new Date().toISOString();
  let msg;
  try { msg = await discord(env, "POST", `/channels/${i.channel_id}/messages`, { embeds, allowed_mentions: { parse: [] } }); }
  catch (e) { return "⚠️ I can't post in this channel — give the bot Send Messages + Embed Links here."; }
  if (old && !(old.ch === i.channel_id && old.id === msg.id)) await discord(env, "DELETE", `/channels/${old.ch}/messages/${old.id}`).catch(() => {});
  const sig = await sha256(JSON.stringify(embeds.map((e) => [e.title, e.description])));
  await kput(env, "board:owners", { ch: i.channel_id, id: msg.id, sig, updated: Date.now(), by: uidOf(i) }, 3650 * 86400);
  return `✅ The franchise owner list is now pinned in <#${i.channel_id}> and updates itself whenever FOs, rosters or teams change. ${old ? "The old list was removed." : ""} Delete the message to turn it off.`;
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
    case "setownerchannel": return later(i, ctx, () => setOwnerChannel(env, i));
    case "coinhelp": case "balance": case "daily": case "work": case "give": case "leaderboard": case "coinflip": case "slots": case "roulette":
    case "dice": case "crash": case "rob": case "simgame": case "blackjack": case "drive": case "bet": return await econCommand(i, env, ctx, cmd);
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
  if (kind === "bj" || kind === "dr") return econComponent(i, env, kind, id, k || "");
  if (kind === "ans") return json({ type: 9, data: { custom_id: `ansm:${id}`, title: "Answer",
    components: [row({ type: 4, custom_id: "text", style: 2, label: "Your answer (sent as a DM from the bot)", min_length: 1, max_length: 1500, required: true })] } });
  if (kind === "rp") return json({ type: 9, data: { custom_id: `rpm:${id || ""}`, title: "Reply to UFA Staff",
    components: [row({ type: 4, custom_id: "text", style: 2, label: "Your reply", min_length: 1, max_length: 1500, required: true })] } });
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
  if (kind === "rpm") return later(i, ctx, async () => {
    const text = i.data.components?.[0]?.components?.[0]?.value || "", uid = uidOf(i), L = await league(env);
    const M = await members(env, L).catch(() => []), m = M.find((x) => x.user.id === uid), name = m ? display(m) : (i.user?.global_name || i.user?.username || uid);
    const log = id ? await kget(env, `dmlog:${id}`) : null;
    const tk = await ensureTicket(env, uid, name);
    tk.replies = [...(tk.replies || []), { text, ts: Date.now(), about: log?.title || "" }].slice(-100);
    Object.assign(tk, { updated: Date.now(), lastThem: Date.now(), lastFrom: "them", preview: text.slice(0, 140), status: "open" });
    await saveTicket(env, tk);
    if (L.C.staffChat) await discord(env, "POST", `/channels/${L.C.staffChat}/messages`, { allowed_mentions: { parse: [] },
      embeds: [{ author: { name: `${tno(tk.no)} · Reply from ${name}` }, title: log?.title ? `Re: ${log.title}` : undefined, description: text.slice(0, 3900), color: 0xffc62f, footer: { text: "Answer it from the admin page → Messages → Tickets" }, timestamp: new Date().toISOString() }] }).catch(() => {});
    // forward to the commissioner(s) by DM, with a button to answer straight from Discord
    for (const cid of String(env.REPLY_TO || env.COMMISH_IDS || "").split(/[\s,]+/).filter(Boolean)) {
      await dm(env, cid, { embeds: [{ author: { name: `📬 ${tno(tk.no)} · Reply from ${name}` }, title: log?.title ? `Re: ${log.title}` : undefined, description: text.slice(0, 3900),
        color: 0xffc62f, footer: { text: m && info(L, m).team ? `${teamOf(L, info(L, m).team).name} · ${uid}` : uid }, timestamp: new Date().toISOString() }],
        components: [row(btn(`Answer ${name}`.slice(0, 80), 1, `ans:${uid}`))] });
    }
    return { content: "✅ Thanks — your reply was sent to UFA Staff.", components: [] };
  }, false);
  if (kind === "ansm") return later(i, ctx, async () => {
    const L = await league(env), me = await actorFromUid(env, L, uidOf(i)).catch(() => ({ staff: isStaff(env, null, uidOf(i)) }));
    if (!me.staff && !isStaff(env, L, uidOf(i))) return "Only staff can answer.";
    const text = i.data.components?.[0]?.components?.[0]?.value || "";
    const tk = await ensureTicket(env, id);
    const ok = await staffSend(env, id, text, me.name && me.name !== "Unknown" ? me.name : "UFA Staff", tk);
    if (ok) { Object.assign(tk, { updated: Date.now(), lastFrom: "staff", preview: text.slice(0, 140) }); await saveTicket(env, tk); }
    return ok ? `✅ Sent to them:\n> ${text.slice(0, 300).replace(/\n/g, "\n> ")}` : "⚠️ Couldn't DM them (DMs closed?).";
  }, false);
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
  if (["team", "opponent"].includes(focused?.name)) {
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

// ---------- draft queue + auto-pick ----------
const getQueue = async (env, abbr) => (await kget(env, `queue:${abbr}`)) || [];
async function autoPick(env, force = null) {   // force = {n, by}: staff skip the team on the clock
  for (let attempt = 0; attempt < 3; attempt++) {
    const { D, sha } = await loadDraft(env), H = helpers(D), n = D.picks.length;
    if (force) {
      if (D.status !== "live" && D.status !== "paused") throw UE("The draft isn't running.");
      if (n >= H.total) throw UE("The draft is already complete.");
      if (force.n != null && +force.n !== n) throw UE("That pick was already made — refresh.");
    } else {
      if (D.status !== "live" || !D.pickMinutes || !D.clockStart || n >= H.total) return;
      if (Date.now() < D.clockStart + D.pickMinutes * 60000) return;
    }
    const s = H.slot(n), q = await getQueue(env, s.team);
    const fromQ = q.map((id) => H.avail.find((x) => x.id === id)).find(Boolean);
    const random = (D.autoMode || "random") === "random";
    const p = fromQ || (random ? H.avail[Math.floor(Math.random() * H.avail.length)] : H.avail[0]);
    if (!p) { D.status = "done"; } else {
      D.picks.push({ player: p.id, at: Date.now(), by: "auto", auto: fromQ ? "queue" : random ? "random" : "board", ...(force ? { forced: force.by || "staff" } : {}) });
      if (D.picks.length >= H.total) D.status = "done";
    }
    D.clockStart = Date.now();
    try { await putJSON(env, "draft.json", D, sha, p ? `Pick #${s.overall}: ${s.team} auto-pick ${p.name}${force ? " (forced by staff)" : ""}` : "Draft complete (pool empty)");
      return p ? { player: p.name, team: s.team, overall: s.overall, from: fromQ ? "queue" : random ? "random" : "board" } : { done: true }; }
    catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
  }
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
      const roles = i.member?.roles || [], tr = L && teamOf(L, s.team)?.roleId;
      const frontOffice = !!tr && roles.includes(tr) && ((L.R.fo && roles.includes(L.R.fo)) || (L.R.gm && roles.includes(L.R.gm)));   // the team's FO or GM
      if (user !== fo && !frontOffice && !commish) return `❌ You're not on the clock. It's **${N[s.team] || s.team}**'s pick${fo ? ` (<@${fo}>)` : ""}.`;
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
      const faOpen = ["done", "skipped"].includes(L.draftStatus) && L.R.fa;   // after the draft (or once it's skipped) new sign-ups are free agents
      if (!faOpen && !L.R.draftable) return "⚠️ Couldn't find the draft-pool role. Ask the commissioner to check the DRAFT_ROLE setting.";
      await discord(env, "PUT", `/guilds/${gid}/members/${uid}/roles/${faOpen ? L.R.fa : L.R.draftable}`);
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
      const abbr = String(team).toUpperCase();
      if (L && !foOf(L, await members(env, L), abbr)) return out({ error: "That team doesn't have a franchise owner right now." }, 401);
      const s = randToken(); await kput(env, `sess:${s}`, { team: abbr, pw: true, pwTs: rec.ts, ts: Date.now() }, 30 * 86400);
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
      if (p === "/api/admin/unappoint") return out({ ok: true, text: await unappoint(env, L, body.team, admin.name, !!body.removeFromTeam) });
      if (p === "/api/admin/automod") return out(body.save ? { ok: true, rule: await automodSave(env, L, body.save, staffSig(admin)) }
        : body.delete ? (await discord(env, "DELETE", `/guilds/${L.guild}/auto-moderation/rules/${body.delete}`).catch((e) => { throw AM_ERR(e); }), { ok: true })
        : body.toggle ? { ok: true, rule: await discord(env, "PATCH", `/guilds/${L.guild}/auto-moderation/rules/${body.toggle}`, { enabled: !!body.enabled }).catch((e) => { throw AM_ERR(e); }) }
        : await automodList(env, L));
      if (p === "/api/admin/diag") return out({ cron: (await kget(env, "cron:diag")) || {}, now: Date.now() });
      if (p === "/api/admin/econ") return out(await econAdmin(env, L, body, staffSig(admin)));
      if (p === "/api/admin/counter") return out(await counterAdmin(env, L, body));
      if (p === "/api/admin/automod/hiddenlog") return out({ ok: true, ...(await ruleToHiddenLog(env, L, String(body.id || ""), staffSig(admin))) });
      if (p === "/api/admin/excuse/movelog") return out({ ok: true, ...(await excuseMoveLog(env, L, staffSig(admin))) });
      if (p === "/api/admin/excuse/setup") return out({ ok: true, ...(await excuseSetup(env, L, body, staffSig(admin))) });
      if (p === "/api/admin/syncall") return out({ ok: true, ...(await syncAll(env, L, !!body.rolesOnly)) });
      if (p === "/api/admin/password") {
        const abbr = String(body.team || "").toUpperCase(); if (!teamOf(L, abbr)) return out({ error: "Unknown team." }, 400);
        if (!body.password) { await killTeamPassword(env, abbr); return out({ ok: true }); }
        if (String(body.password).length < 8) return out({ error: "Use at least 8 characters." }, 400);
        const salt = randToken(); await kput(env, `pw:${abbr}`, { salt, hash: await sha256(salt + body.password), ts: Date.now() }, 365 * 86400);
        return out({ ok: true });
      }
      if (p === "/api/admin/password/dm") {   // DM the team's FO their (just-made) portal password
        const abbr = String(body.team || "").toUpperCase(), t = teamOf(L, abbr); if (!t) return out({ error: "Unknown team." }, 400);
        const rec = await kget(env, `pw:${abbr}`), pw = String(body.password || "");
        if (!rec || rec.hash !== await sha256(rec.salt + pw)) return out({ error: "That isn't the team's current password." }, 400);
        const fo = foOf(L, await members(env, L, true), abbr); if (!fo) return out({ error: `The ${t.name} don't have an FO right now.` }, 400);
        const ok = await staffSend(env, fo.id, `Here's the FO portal password for the **${t.name}**:\n\n**\`${pw}\`**\n\nLog in at ${SITE}fo.html — pick your team and type this in (or just log in with Discord). Don't share it; staff can change it any time.`, staffSig(admin));
        if (!ok) return out({ error: `Couldn't DM ${fo.name} — their DMs might be closed.` }, 400);
        return out({ ok: true, text: `Sent to ${fo.name}.` });
      }
      if (p === "/api/admin/passwords") { const ks = await klist(env, "pw:"); return out({ teams: ks.map((k) => k.name.slice(3)) }); }
      if (p === "/api/admin/overview") {
        const M = await members(env, L, true);
        const pending = (await klist(env, "req:")).filter((k) => k.metadata?.status === "staff").length;
        return out({ teams: L.teams, members: M.map((m) => info(L, m)), cap: cap(L), frozen: frozen(L), draftStatus: L.draftStatus, pending, ready: { staff: !!L.R.staff, gm: !!L.R.gm, hc: !!L.R.hc, fo: !!L.R.fo, approvals: !!L.C.approvals, transactions: !!L.C.transactions } });
      }
      if (p === "/api/admin/dm") {
        const uids = [...new Set(body.uids || [])].slice(0, 12), text = String(body.text || "").trim();
        if (!text) return out({ error: "Write a message first." }, 400);
        if (text.length > 1800) return out({ error: "Keep it under 1800 characters." }, 400);
        const M = await members(env, L), icon = body.embed ? await brandIcon(env, L) : null, results = [];
        const replyRow = body.logId ? [row(btn("💬 Reply to staff", 2, `rp:${body.logId}`))] : [];
        for (const uid of uids) {
          const m = M.find((x) => x.user.id === uid);
          if (!m) { results.push({ id: uid, ok: false, why: "not in server" }); continue; }
          const pi = info(L, m), t = teamOf(L, pi.team);
          const txt = text.replace(/\{name\}/gi, pi.name).replace(/\{team\}/gi, t ? t.name : "free agency").replace(/\{mention\}/gi, `<@${uid}>`);
          const payload = body.embed
            ? { embeds: [{ author: { name: "UFA League", ...(icon ? { icon_url: icon } : {}) }, ...(body.title ? { title: String(body.title).slice(0, 200) } : {}), description: txt,
                color: t ? colorInt(t.color) : 0xe8424a, footer: { text: `Sent by ${admin.name.replace(/ \(website\)$/, "")} · UFA Staff` }, timestamp: new Date().toISOString() }], components: replyRow }
            : { content: `${body.title ? `**${body.title}**\n` : ""}${txt}\n-# Sent by UFA Staff`, components: replyRow };
          const ok = await dm(env, uid, payload);
          results.push({ id: uid, name: pi.name, ok, why: ok ? "" : "DMs closed" });
        }
        return out({ results });
      }
      if (p === "/api/admin/tickets") {
        let scan = null;
        if (url.searchParams.has("scan")) scan = await scanDMs(env, L, Number(url.searchParams.get("scan")) || 0);
        const ks = await klist(env, "ticket:"), M = await members(env, L).catch(() => []);
        const list = (await Promise.all(ks.filter((k) => k.name !== "ticket:counter").map((k) => kget(env, k.name)))).filter(Boolean)
          .map(({ replies, ...t }) => { const m = M.find((x) => x.user.id === t.uid); const pi = m ? info(L, m) : null; return { ...t, ticket: tno(t.no), avatar: pi?.avatar, team: pi?.team || null, rank: pi?.rank || null, name: pi?.name || t.name }; })
          .sort((a, b) => b.updated - a.updated);
        return out({ tickets: list, scan });
      }
      if (p === "/api/admin/ticket") {
        const uid = url.searchParams.get("uid") || body.uid, t = await kget(env, `ticket:${uid}`);
        if (!t) return out({ error: "No ticket for that person." }, 404);
        const M = await members(env, L).catch(() => []), m = M.find((x) => x.user.id === uid), pi = m ? info(L, m) : null;
        return out({ ticket: { ...t, replies: undefined, ticket: tno(t.no), avatar: pi?.avatar, team: pi?.team || null, rank: pi?.rank || null, name: pi?.name || t.name }, timeline: await ticketTimeline(env, t) });
      }
      if (p === "/api/admin/ticket/reply") {
        const text = String(body.text || "").trim(); if (!text || !body.uid) return out({ error: "Write a message first." }, 400);
        const M = await members(env, L).catch(() => []), m = M.find((x) => x.user.id === body.uid);
        if (!m) return out({ error: "That person isn't in the server." }, 400);
        const t = await ensureTicket(env, body.uid, display(m));
        if (!(await staffSend(env, body.uid, text, staffSig(admin), t))) return out({ error: "Couldn't DM them (DMs closed?)." }, 400);
        Object.assign(t, { updated: Date.now(), lastFrom: "staff", preview: text.slice(0, 140), status: "open" }); await saveTicket(env, t);
        return out({ ok: true, ticket: tno(t.no) });
      }
      if (p === "/api/admin/ticket/status") {
        const t = await kget(env, `ticket:${body.uid}`); if (!t) return out({ error: "No ticket." }, 404);
        t.status = body.status === "closed" ? "closed" : "open"; await saveTicket(env, t);
        if (t.status === "closed" && body.notify) await dm(env, t.uid, `✅ Your ticket **${tno(t.no)}** with UFA Staff has been closed. Reply any time to open it again.`);
        return out({ ok: true });
      }
      if (p === "/api/admin/inbox") {
        // replies sent with the Reply button, plus anything people typed straight into their DM with the bot
        const replies = (await Promise.all((await klist(env, "inbox:")).slice(0, 50).map((k) => kget(env, k.name)))).filter(Boolean).map((r) => ({ ...r, via: "button" }));
        const chans = (await Promise.all((await klist(env, "dmch:")).map(async (k) => ({ uid: k.name.slice(5), ...(await kget(env, k.name)) })))).filter((c) => c.ch).sort((a, b) => b.ts - a.ts);
        const page = Math.max(0, Number(url.searchParams.get("page") || 0)), slice = chans.slice(page * 25, page * 25 + 25), M = await members(env, L).catch(() => []);
        const typed = [];
        for (const c of slice) {
          const msgs = await discord(env, "GET", `/channels/${c.ch}/messages?limit=10`).catch(() => []);
          for (const m of msgs || []) if (!m.author?.bot && m.content) {
            const mm = M.find((x) => x.user.id === c.uid);
            typed.push({ uid: c.uid, name: mm ? display(mm) : (m.author.global_name || m.author.username), text: m.content, ts: Date.parse(m.timestamp), via: "dm", avatar: mm ? avatarUrl(L.guild, mm) : null });
          }
        }
        return out({ messages: [...replies, ...typed].sort((a, b) => b.ts - a.ts), checked: slice.length, total: chans.length, more: (page + 1) * 25 < chans.length });
      }
      if (p === "/api/admin/inbox/reply") {
        const text = String(body.text || "").trim(); if (!text || !body.uid) return out({ error: "Write a reply first." }, 400);
        const ok = await staffSend(env, body.uid, text, staffSig(admin));
        return ok ? out({ ok: true }) : out({ error: "Couldn't DM them (DMs closed?)." }, 400);
      }
      if (p === "/api/admin/dm/log") {
        if (req.method === "POST") {
          if (body.start) { const id = String(9e12 - Date.now()).padStart(13, "0"); await kput(env, `dmlog:${id}`, { ts: Date.now(), by: admin.name, title: String(body.title || "").slice(0, 200), text: "", audience: "", sent: 0, failed: [] }, 120 * 86400); return out({ id }); }
          if (body.id) { const e = await kget(env, `dmlog:${body.id}`) || {}; Object.assign(e, { text: String(body.text || "").slice(0, 1800), audience: String(body.audience || "").slice(0, 100), sent: body.sent | 0, failed: (body.failed || []).slice(0, 200) }); await kput(env, `dmlog:${body.id}`, e, 120 * 86400); return out({ ok: true }); }
          const e = { ts: Date.now(), by: admin.name, title: String(body.title || "").slice(0, 200), text: String(body.text || "").slice(0, 1800), audience: String(body.audience || "").slice(0, 100), sent: body.sent | 0, failed: (body.failed || []).slice(0, 200) };
          await kput(env, `dmlog:${String(9e12 - e.ts).padStart(13, "0")}`, e, 120 * 86400); return out({ ok: true });
        }
        const ks = (await klist(env, "dmlog:")).slice(0, 25);
        return out({ log: (await Promise.all(ks.map((k) => kget(env, k.name)))).filter(Boolean) });
      }
      if (p === "/api/admin/queues") {
        const [{ D }, M, ks] = await Promise.all([loadDraft(env), members(env, L), klist(env, "queue:")]);
        const H = helpers(D), taken = H.taken, meta = Object.fromEntries(ks.map((k) => [k.name.slice(6), k.metadata || {}]));
        const rows = [];
        for (const t of L.teams) {
          const dt = D.teams.find((x) => x.abbr === t.abbr) || {}, fo = foOf(L, M, t.abbr);
          if (!dt.in && !fo) continue;
          const q = meta[t.abbr] ? await getQueue(env, t.abbr) : [];
          rows.push({ abbr: t.abbr, name: t.name, color: t.color, inDraft: !!dt.in, fo: fo ? { id: fo.id, name: fo.name } : null,
            queued: q.length, available: q.filter((id) => !taken.has(id)).length, updated: meta[t.abbr]?.ts || null, by: meta[t.abbr]?.by || "", list: q });
        }
        const players = D.pool.map(({ id, name, pos, avatar, discord }) => ({ id, name, pos: pos || [], avatar, discord: discord || null, taken: taken.has(id) }));
        return out({ rows, players, status: D.status, pickMinutes: D.pickMinutes || 0, autoMode: D.autoMode || "random", pool: H.avail.length });
      }
      if (p === "/api/admin/players") return out(await adminPlayers(env, L));
      if (p === "/api/admin/openfa") return out(await openFreeAgency(env, L, admin, body));
      if (p === "/api/admin/position/delete") return out(await deletePosition(env, body.name, staffSig(admin)));
      if (p === "/api/admin/notifypos") return out(await notifyPositions(env, body.ids, !!body.silent));
      if (p === "/api/admin/player") return out(await adminPlayer(env, L, body, staffSig(admin)));
      if (p === "/api/admin/autopick") return out({ ok: true, ...(await autoPick(env, { n: body.n, by: staffSig(admin) })) });   // force an auto-pick for the team on the clock
      if (p === "/api/admin/queue") {   // staff edit a team's draft queue
        const abbr = String(body.team || "").toUpperCase(); if (!teamOf(L, abbr)) return out({ error: "Unknown team." }, 400);
        const { D } = await loadDraft(env), ids = new Set(D.pool.map((x) => x.id));
        const q = [...new Set((body.ids || []).map(Number))].filter((x) => ids.has(x)).slice(0, 60);
        await kput(env, `queue:${abbr}`, q, 120 * 86400, { n: q.length, ts: Date.now(), by: `${staffSig(admin)} (staff)` });
        return out({ ok: true, queue: q });
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
    if (s.pw) {
      const rec = await kget(env, `pw:${s.team}`);
      if (!rec || rec.ts !== s.pwTs || !foOf(L, await members(env, L), s.team)) { await KV(env).delete(`sess:${auth.slice(8)}`); return out({ error: "This team password doesn't work anymore — log in again (or use Discord login)." }, 401); }
    }
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
    if (p === "/api/queue") {
      const abbr = actor.team;
      if (!abbr || !["fo", "gm"].includes(actor.rank)) return out({ error: "Only the FO or GM can set the draft queue." }, 403);
      if (req.method === "POST") {
        const { D } = await loadDraft(env), ids = new Set(D.pool.map((x) => x.id));
        const q = [...new Set((body.ids || []).map(Number))].filter((x) => ids.has(x)).slice(0, 60);
        const byId = actor.id || (actor.pw ? foOf(L, M, abbr)?.id : null) || null;
        await kput(env, `queue:${abbr}`, q, 120 * 86400, { n: q.length, ts: Date.now(), by: actor.name, byId });
        bust("qpop");
        return out({ ok: true, queue: q });
      }
      // a queue someone who's no longer in this front office made (e.g. the previous FO) → ask the new FO to review it
      const qm = await KV(env).getWithMetadata(`queue:${abbr}`), qmeta = qm.metadata || {}, qlist = JSON.parse(qm.value || "[]");
      const front = rosterOf(L, M, abbr).filter((x) => ["fo", "gm"].includes(x.rank));
      const by = String(qmeta.by || "");
      const inheritedQ = qlist.length && !by.endsWith("(staff)") && (qmeta.byId ? !front.some((x) => x.id === qmeta.byId) : (by && !by.endsWith("front office") && !front.some((x) => x.name === by)));
      const { D } = await loadDraft(env), H = helpers(D), N = names(await loadSched(env));
      const mine = D.picks.map((pk, k) => ({ pk, s: H.slot(k) })).filter((x) => x.s.team === abbr).map((x) => ({ ...D.pool.find((y) => y.id === x.pk.player), round: x.s.round, pick: x.s.pick, auto: x.pk.auto || null }));
      let next = null;
      if (D.status === "live" || D.status === "paused") for (let k = D.picks.length; k < H.total; k++) if (H.slot(k).team === abbr) { next = { overall: k + 1, ...H.slot(k), away: k - D.picks.length }; break; }
      const cur = D.picks.length < H.total ? H.slot(D.picks.length) : null;
      return out({ queue: await getQueue(env, abbr), available: H.avail.map(({ id, name, pos, rank, tier, avatar, discord }) => ({ id, name, pos, rank, tier, avatar, discord: discord || null })),
        status: D.status, pickMinutes: D.pickMinutes || 0, clockStart: D.clockStart || null, onClock: cur ? { team: cur.team, name: N[cur.team], round: cur.round, pick: cur.pick } : null,
        next, mine, rounds: D.rounds, teams: H.T, popular: await queuePopularity(env), inherited: inheritedQ ? { by, ts: qmeta.ts || null, n: qlist.length, available: qlist.filter((id) => !H.taken.has(id)).length } : null });
    }
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
