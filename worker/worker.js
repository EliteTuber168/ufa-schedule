/**
 * UFA League bot — Cloudflare Worker that handles Discord slash commands and buttons.
 *
 *   /pick player            FO on the clock (or a commissioner) makes the draft pick
 *   /onclock                who's on the clock
 *   /available [position]   best available players
 *   /schedule [team]        this week's games, or one team's whole schedule
 *   /roster team            a team's roster (from its Discord role + draft picks)
 *   /fa list|join|leave     free agents: see who's available, sign up, drop out
 *   /activity               (staff) teams under the minimum / without an FO
 *   /vote create            (staff) button vote — one vote per person, staff close it to show results
 *
 * Draft picks and sign-ups are saved into the GitHub repo (draft.json). Commits to draft.json trigger the
 * "Post draft picks" GitHub Action, which announces picks, gives team roles and sends DMs.
 *
 * Worker settings → Variables and Secrets:
 *   DISCORD_PUBLIC_KEY  Discord Developer Portal → General Information → Public Key
 *   GITHUB_TOKEN        (secret) fine-grained token with Contents: Read and write on ufa-schedule
 *   DISCORD_BOT_TOKEN   (secret) the bot's token — needed for /fa join and /fa leave (gives/removes the Draftable role)
 *   COMMISH_IDS         Discord user IDs allowed to pick for any team / run staff commands, comma-separated
 *   COMMISH_ROLE_ID     optional: a role ID with the same powers (server admins/managers always have them)
 *   DRAFT_ROLE          optional: name or ID of the draft-pool role (default "Draftable")
 *   REPO                optional, defaults to EliteTuber168/ufa-schedule
 * Bindings: KV namespace bound as VOTES (for /vote).
 */
const BOARD = "https://elitetuber168.github.io/ufa-schedule/draft.html";
const SITE = "https://elitetuber168.github.io/ufa-schedule/";
const TZ = "America/New_York";
const POS = { QB: "QB", RB: "RB", HB: "RB", WR: "WR", TE: "TE", OL: "OL", DE: "DE", DL: "DE", LB: "LB", MLB: "LB", OLB: "LB",
  CB: "CB", S: "S", FS: "S", SS: "S", DB: "DB", K: "K/P", P: "K/P", KP: "K/P", KR: "KR" };

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response("UFA draft bot is running ✅", { status: 200 });
    const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
    const body = await req.text();
    if (!sig || !ts || !(await verify(env.DISCORD_PUBLIC_KEY, sig, ts + body))) return new Response("Bad signature", { status: 401 });
    const i = JSON.parse(body);
    try {
      if (i.type === 1) return json({ type: 1 });                                               // PING
      if (i.type === 4) return json({ type: 8, data: { choices: await autocomplete(i, env) } });
      if (i.type === 3) return await component(i, env);                                         // buttons / menus
      if (i.type === 2) {
        const cmd = i.data.name, sub = (i.data.options || [])[0];
        if (cmd === "pick") return defer(ctx, doPick(i, env));
        if (cmd === "onclock") return await onClock(env);
        if (cmd === "available") return await available(i, env);
        if (cmd === "schedule") return await schedule(i, env);
        if (cmd === "roster") return await roster(i, env);
        if (cmd === "activity") return await activity(i, env);
        if (cmd === "fa" && sub?.name === "list") return await faList(sub, env);
        if (cmd === "fa" && sub?.name === "join") return defer(ctx, faJoin(i, sub, env));
        if (cmd === "fa" && sub?.name === "leave") return defer(ctx, faLeave(i, env));
        if (cmd === "vote" && sub?.name === "create") return await voteCreate(i, sub, env);
      }
      return reply("Unknown command.", true);
    } catch (e) {
      return reply("⚠️ Something went wrong: " + (e.message || e), true);
    }
  },
};

// ---------- helpers ----------
const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
const reply = (content, ephemeral = false) => json({ type: 4, data: { content: content.slice(0, 2000), flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });
const hex = (s) => new Uint8Array(s.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
const opt = (opts, name) => (opts || []).find((o) => o.name === name)?.value;
const uidOf = (i) => i.member?.user?.id || i.user?.id;
const defer = (ctx, work) => { ctx.waitUntil(work); return json({ type: 5, data: { flags: 64 } }); };
const followup = (i) => (content) => fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }) });

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

function isStaff(i, env) {
  const u = uidOf(i), roles = i.member?.roles || [];
  if (String(env.COMMISH_IDS || "").split(/[\s,]+/).includes(u)) return true;
  if (env.COMMISH_ROLE_ID && roles.includes(env.COMMISH_ROLE_ID)) return true;
  try { return (BigInt(i.member?.permissions || "0") & 0x28n) !== 0n; } catch { return false; }   // Administrator / Manage Server
}

// GitHub
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
async function loadRosters(env) { try { return (await getJSON(env, "rosters.json")).D.teams || {}; } catch (e) { if (e.status === 404) return {}; throw e; } }

// Discord REST (bot token)
async function discord(env, method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, { method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error(`Discord ${r.status}`); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}

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
function avatarUrl(gid, m) {
  const u = m.user;
  if (m.avatar) return `https://cdn.discordapp.com/guilds/${gid}/users/${u.id}/avatars/${m.avatar}.png?size=96`;
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=96`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
}

// ---------- autocomplete ----------
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

// ---------- draft ----------
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
  const say = followup(i);
  try {
    const user = uidOf(i), raw = String(opt(i.data.options, "player") || "").trim(), commish = isStaff(i, env);
    const N = names(await loadSched(env));
    for (let attempt = 0; attempt < 3; attempt++) {
      const { D, sha } = await loadDraft(env), H = helpers(D), n = D.picks.length;
      if (D.status === "setup") return say("The draft hasn't started yet.");
      if (D.status === "paused") return say("⏸️ The draft is paused right now.");
      if (D.status === "done" || n >= H.total) return say("🏁 The draft is already complete.");
      const s = H.slot(n), fo = H.team(s.team).foId;
      if (user !== fo && !commish) return say(`❌ You're not on the clock. It's **${N[s.team] || s.team}**'s pick${fo ? ` (<@${fo}>)` : ""}.`);
      let p = /^\d+$/.test(raw) ? D.pool.find((x) => x.id === +raw) : null;
      if (!p) { const q = raw.toLowerCase(); const m = H.avail.filter((x) => x.name.toLowerCase() === q); p = m.length === 1 ? m[0] : null;
        if (!p) { const c = H.avail.filter((x) => x.name.toLowerCase().includes(q)); if (c.length === 1) p = c[0];
          else return say(c.length ? `More than one player matches "${raw}": ${c.slice(0, 8).map((x) => x.name).join(", ")}. Pick one from the list.` : `No available player called "${raw}".`); } }
      if (H.taken.has(p.id)) return say(`❌ **${p.name}** has already been drafted.`);
      D.picks.push({ player: p.id, at: Date.now(), by: user });
      D.clockStart = Date.now();
      if (D.picks.length >= H.total) D.status = "done";
      try { await putJSON(env, "draft.json", D, sha, `Pick #${s.overall}: ${s.team} select ${p.name} (via /pick)`); }
      catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
      return say(`✅ **Pick is in!** ${N[s.team] || s.team} select **${p.name}**${posTxt(p) ? " (" + posTxt(p) + ")" : ""} — Round ${s.round}, Pick ${s.pick}.\nThe bot will announce it in the draft channel in a few seconds.`);
    }
    return say("⚠️ The draft was busy — try /pick again.");
  } catch (e) {
    return say("⚠️ Couldn't save the pick: " + (e.message || e) + ([401, 403, 404].includes(e.status) ? " (check the Worker's GITHUB_TOKEN)" : ""));
  }
}

// ---------- schedule ----------
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

// ---------- rosters / free agents ----------
async function roster(i, env) {
  const S = await loadSched(env), t = findTeam(S, opt(i.data.options, "team"));
  if (!t) return reply("No team by that name.", true);
  const [{ D }, R] = await Promise.all([loadDraft(env), loadRosters(env)]), H = helpers(D);
  const byDiscord = Object.fromEntries(D.pool.filter((p) => p.discord).map((p) => [p.discord, p]));
  const picks = {};
  D.picks.forEach((pk, n) => { const s = H.slot(n); if (s.team === t.abbr) picks[pk.player] = `R${s.round}P${s.pick}`; });
  const members = R[t.abbr] || [], seen = new Set();
  const lines = members.map((m) => {
    const p = byDiscord[m.id]; if (p) seen.add(p.id);
    return `${m.fo ? "👑" : "•"} <@${m.id}>${m.fo ? " — FO" : ""}${p && posTxt(p) ? ` (${posTxt(p)})` : ""}${p && picks[p.id] ? ` · ${picks[p.id]}` : ""}`;
  });
  for (const [pid, where] of Object.entries(picks)) if (!seen.has(+pid)) {
    const p = D.pool.find((x) => x.id === +pid) || { name: "?" };
    lines.push(`• ${p.discord ? `<@${p.discord}>` : `**${p.name}**`}${posTxt(p) ? ` (${posTxt(p)})` : ""} · ${where}`);
  }
  return reply(`🏈 **${t.name}** — ${lines.length} player${lines.length === 1 ? "" : "s"}\n` + (lines.length ? lines.join("\n") : "No players yet.") + `\n-# Rosters update hourly · ${BOARD}#/teams`);
}

async function faList(sub, env) {
  const pos = String(opt(sub.options, "position") || "").toUpperCase().trim();
  const { D } = await loadDraft(env), { avail } = helpers(D);
  const all = avail.filter((p) => !pos || (p.pos || []).includes(pos)), list = all.slice(0, 20);
  if (!list.length) return reply(pos ? `No free agents at ${pos}.` : "No free agents right now.", true);
  return reply(`🆓 **Free agents${pos ? " — " + pos : ""}** (${all.length})\n` + list.map((p) => `• ${p.discord ? `<@${p.discord}>` : `**${p.name}**`}${posTxt(p) ? ` (${posTxt(p)})` : ""}`).join("\n")
    + (all.length > list.length ? `\n…and ${all.length - list.length} more: ${BOARD}#/players` : "") + "\nNot on a team? Sign up with **/fa join**.", true);
}

async function draftRole(env, gid) {
  const want = String(env.DRAFT_ROLE || "Draftable").toLowerCase().trim();
  const roles = await discord(env, "GET", `/guilds/${gid}/roles`);
  return roles.find((r) => r.id === want || r.name.toLowerCase().trim() === want);
}

async function faJoin(i, sub, env) {
  const say = followup(i);
  try {
    if (!env.DISCORD_BOT_TOKEN) return say("⚠️ Sign-ups aren't switched on yet — the commissioner needs to add DISCORD_BOT_TOKEN to the bot's settings.");
    const m = i.member, uid = m.user.id, gid = i.guild_id;
    const raw = String(opt(sub.options, "positions") || ""), pos = parsePos(raw);
    if (!pos.length) return say(`Couldn't read any positions from "${raw}". Try something like **WR/CB** or **QB, LB**.`);
    const N = names(await loadSched(env));
    let name = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const { D, sha } = await loadDraft(env), H = helpers(D);
      const onTeam = D.teams.find((t) => t.roleId && (m.roles || []).includes(t.roleId));
      if (onTeam) return say(`You're already on the **${N[onTeam.abbr] || onTeam.abbr}** roster.`);
      let p = D.pool.find((x) => x.discord === uid);
      if (p && H.taken.has(p.id)) return say("You've already been drafted.");
      if (attempt === 0) {
        const role = await draftRole(env, gid);
        if (!role) return say("⚠️ Couldn't find the draft-pool role. Ask the commissioner to check the DRAFT_ROLE setting.");
        await discord(env, "PUT", `/guilds/${gid}/members/${uid}/roles/${role.id}`);
      }
      if (!p) { p = { id: Math.max(0, ...D.pool.map((x) => x.id)) + 1, name: cleanName(m.nick || m.user.global_name || m.user.username) || m.user.username, pos: [], discord: uid }; D.pool.push(p); }
      p.pos = pos; p.avatar = avatarUrl(gid, m); p.locked = true; name = p.name;
      D.positions = D.positions || [];
      for (const x of pos) if (!D.positions.includes(x)) D.positions.push(x);
      try { await putJSON(env, "draft.json", D, sha, `Free agent sign-up: ${p.name} (${pos.join("/")})`); }
      catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
      return say(`✅ You're in the player pool as **${name}** (${pos.join("/")}). FOs can find you on the board: ${BOARD}#/players\nChange positions any time by running **/fa join** again.`);
    }
    return say("⚠️ Busy right now — try again.");
  } catch (e) {
    return say("⚠️ Couldn't sign you up: " + (e.message || e) + (e.status === 403 ? " (the bot needs Manage Roles, above the Draftable role)" : ""));
  }
}

async function faLeave(i, env) {
  const say = followup(i);
  try {
    if (!env.DISCORD_BOT_TOKEN) return say("⚠️ The commissioner needs to add DISCORD_BOT_TOKEN to the bot's settings first.");
    const uid = uidOf(i), gid = i.guild_id;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { D, sha } = await loadDraft(env), H = helpers(D);
      const p = D.pool.find((x) => x.discord === uid);
      if (p && H.taken.has(p.id)) return say("You've already been drafted — talk to your FO or a commissioner.");
      if (attempt === 0) { const role = await draftRole(env, gid); if (role) await discord(env, "DELETE", `/guilds/${gid}/members/${uid}/roles/${role.id}`); }
      if (!p) return say("👋 You're not in the player pool.");
      D.pool = D.pool.filter((x) => x !== p);
      try { await putJSON(env, "draft.json", D, sha, `Free agent left the pool: ${p.name}`); }
      catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
      return say("👋 You've been taken out of the player pool. Rejoin any time with **/fa join**.");
    }
    return say("⚠️ Busy right now — try again.");
  } catch (e) { return say("⚠️ Couldn't remove you: " + (e.message || e)); }
}

// ---------- staff: activity ----------
async function activity(i, env) {
  if (!isStaff(i, env)) return reply("Only commissioners can use this.", true);
  const [S, R] = await Promise.all([loadSched(env), loadRosters(env)]);
  const cfg = { minPlayers: 5, requireFO: true, ...(S.settings || {}) };
  const under = [], noFo = [], empty = [];
  for (const t of S.teams) {
    const r = R[t.abbr]; if (!r) continue;
    if (!r.length) { empty.push(t.abbr); continue; }
    if (r.length < cfg.minPlayers) under.push(`${t.abbr} (${r.length})`);
    if (!r.some((m) => m.fo)) noFo.push(t.abbr);
  }
  const big = S.teams.filter((t) => (R[t.abbr] || []).length >= cfg.minPlayers).length;
  return reply([`📋 **Activity** — minimum ${cfg.minPlayers} players`,
    under.length ? `⚠️ Under the minimum: ${under.join(", ")}` : "✅ No teams under the minimum",
    noFo.length ? `👤 No FO: ${noFo.join(", ")}` : "", empty.length ? `🫥 Empty: ${empty.join(", ")}` : "",
    `${big} teams at or above the minimum. (From Discord roles, updated hourly.)`].filter(Boolean).join("\n"), true);
}

// ---------- staff: votes ----------
const TTL = 60 * 60 * 24 * 90;
function pollText(p) {
  return `🗳️ **${p.title}**\nOne vote per person — you can change it until voting closes.` + (p.ends ? ` Closes <t:${Math.floor(p.ends / 1000)}:R>.` : "");
}
function pollRows(id, options) {
  const rows = options.length <= 5
    ? [{ type: 1, components: options.map((o, k) => ({ type: 2, style: 1, label: o.slice(0, 80), custom_id: `v:${id}:${k}` })) }]
    : [{ type: 1, components: [{ type: 3, custom_id: `vs:${id}`, placeholder: "Choose your vote", options: options.map((o, k) => ({ label: o.slice(0, 100), value: String(k) })) }] }];
  rows.push({ type: 1, components: [{ type: 2, style: 2, label: "📊 Results (staff)", custom_id: `vr:${id}` }, { type: 2, style: 4, label: "🔒 Close voting (staff)", custom_id: `vc:${id}` }] });
  return rows;
}
async function tally(env, id, n) {
  const counts = Array(n).fill(0); let cursor;
  do {
    const r = await env.VOTES.list({ prefix: `vote:${id}:`, cursor });
    for (const k of r.keys) { const x = k.metadata?.i; if (x >= 0 && x < n) counts[x]++; }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return counts;
}
function resultsText(p, counts, final) {
  const total = counts.reduce((a, b) => a + b, 0), top = Math.max(...counts);
  const rows = p.options.map((o, k) => [o, counts[k]]).sort((a, b) => b[1] - a[1])
    .map(([o, c]) => `${final && total && c === top ? "🏆" : "▫️"} **${o}** — ${c} vote${c === 1 ? "" : "s"}` + (total ? ` (${Math.round((c / total) * 100)}%) ` + "█".repeat(Math.round((c / total) * 10)) : ""));
  return `${final ? "🔒 **Final results" : "📊 **Results so far"} — ${p.title}**\n${rows.join("\n")}\n${total} total vote${total === 1 ? "" : "s"}.` + (final ? "" : "\n-# Votes from the last minute may not show yet.");
}

async function voteCreate(i, sub, env) {
  if (!isStaff(i, env)) return reply("Only commissioners can start a vote.", true);
  if (!env.VOTES) return reply("⚠️ Voting storage isn't set up yet (the Worker needs a KV namespace bound as VOTES).", true);
  const title = String(opt(sub.options, "title") || "").trim().slice(0, 200);
  const options = [...new Set(String(opt(sub.options, "options") || "").split(/[,|\n]/).map((s) => s.trim()).filter(Boolean))];
  const hours = Number(opt(sub.options, "hours") || 0);
  if (options.length < 2 || options.length > 25) return reply("Give between 2 and 25 options, separated by commas.", true);
  const id = Date.now().toString(36);
  const poll = { title, options, ends: hours > 0 ? Date.now() + hours * 3600000 : null, by: uidOf(i) };
  await env.VOTES.put(`poll:${id}`, JSON.stringify(poll), { expirationTtl: TTL });
  return json({ type: 4, data: { content: pollText(poll), components: pollRows(id, options), allowed_mentions: { parse: [] } } });
}

async function component(i, env) {
  const [kind, id, k] = String(i.data.custom_id || "").split(":");
  if (!["v", "vs", "vr", "vc"].includes(kind)) return reply("That button doesn't do anything anymore.", true);
  if (!env.VOTES) return reply("⚠️ Voting storage isn't set up.", true);
  const poll = JSON.parse((await env.VOTES.get(`poll:${id}`)) || "null");
  if (!poll) return reply("This vote has expired.", true);
  if (kind === "v" || kind === "vs") {
    const idx = kind === "vs" ? Number(i.data.values?.[0]) : Number(k);
    if (poll.closed || (poll.ends && Date.now() > poll.ends)) return reply("🔒 Voting is closed.", true);
    if (!(idx >= 0 && idx < poll.options.length)) return reply("That option doesn't exist.", true);
    await env.VOTES.put(`vote:${id}:${uidOf(i)}`, String(idx), { metadata: { i: idx }, expirationTtl: TTL });
    return reply(`✅ Your vote: **${poll.options[idx]}**. You can change it until voting closes.`, true);
  }
  if (!isStaff(i, env)) return reply("Only commissioners can do that.", true);
  const counts = await tally(env, id, poll.options.length);
  if (kind === "vr") return reply(resultsText(poll, counts, false), true);
  poll.closed = true;
  await env.VOTES.put(`poll:${id}`, JSON.stringify(poll), { expirationTtl: TTL });
  return json({ type: 7, data: { content: resultsText(poll, counts, true), components: [], allowed_mentions: { parse: [] } } });
}
