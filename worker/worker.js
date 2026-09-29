/**
 * UFA Draft bot — Cloudflare Worker that handles Discord slash commands.
 *
 *   /pick player:<autocomplete>   FO on the clock (or a commissioner) makes the pick
 *   /onclock                      who's on the clock right now
 *   /available [position]         best available players (big-board order)
 *
 * The pick is saved straight into draft.json in the GitHub repo. That commit triggers the
 * "Post draft picks" GitHub Action, which announces it in #draft and DMs the next FO.
 *
 * Worker settings → Variables and Secrets:
 *   DISCORD_PUBLIC_KEY  (secret)  Discord Developer Portal → General Information → Public Key
 *   GITHUB_TOKEN        (secret)  fine-grained token with Contents: Read and write on ufa-schedule
 *   COMMISH_IDS         (text)    Discord user IDs allowed to pick for any team, comma-separated
 *   COMMISH_ROLE_ID     (text)    optional: a Discord role ID that can also pick for anyone
 *   REPO                (text)    optional, defaults to EliteTuber168/ufa-schedule
 */
const BOARD = "https://elitetuber168.github.io/ufa-schedule/draft.html";

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response("UFA draft bot is running ✅", { status: 200 });
    const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
    const body = await req.text();
    if (!sig || !ts || !(await verify(env.DISCORD_PUBLIC_KEY, sig, ts + body))) return new Response("Bad signature", { status: 401 });
    const i = JSON.parse(body);
    try {
      if (i.type === 1) return json({ type: 1 });                                         // PING
      if (i.type === 4) return json({ type: 8, data: { choices: await autocomplete(i, env) } });
      if (i.type === 2) {
        const cmd = i.data.name;
        if (cmd === "pick") { ctx.waitUntil(doPick(i, env)); return json({ type: 5, data: { flags: 64 } }); }
        if (cmd === "onclock") return await onClock(env);
        if (cmd === "available") return await available(i, env);
      }
      return reply("Unknown command.", true);
    } catch (e) {
      return reply("⚠️ Something went wrong: " + (e.message || e), true);
    }
  },
};

// ---------- helpers ----------
const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
const reply = (content, ephemeral = false) => json({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });
const hex = (s) => new Uint8Array(s.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

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

async function loadDraft(env) {
  const f = await gh(env, "draft.json");
  return { D: JSON.parse(b64d(f.content)), sha: f.sha };
}
let TEAMS = null;
async function teamNames(env) {
  if (!TEAMS) { const f = await gh(env, "schedule.json"); TEAMS = Object.fromEntries(JSON.parse(b64d(f.content)).teams.map((t) => [t.abbr, t.name])); }
  return TEAMS;
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

// ---------- commands ----------
async function autocomplete(i, env) {
  const focused = (i.data.options || []).find((o) => o.focused);
  const q = String(focused?.value || "").toLowerCase();
  const { D } = await loadDraft(env), { avail } = helpers(D);
  return avail.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 25)
    .map((p) => ({ name: `${p.rank ? "#" + p.rank + " " : ""}${p.name}${posTxt(p) ? " — " + posTxt(p) : ""}`.slice(0, 100), value: String(p.id) }));
}

async function onClock(env) {
  const { D } = await loadDraft(env), H = helpers(D), N = await teamNames(env), n = D.picks.length;
  if (D.status === "setup") return reply("The draft hasn't started yet.");
  if (D.status === "done" || n >= H.total) return reply(`🏁 The draft is complete. ${BOARD}#/teams`);
  const s = H.slot(n), fo = H.team(s.team).foId;
  let left = "";
  if (D.pickMinutes && D.clockStart) { const m = Math.round((D.clockStart + D.pickMinutes * 60000 - Date.now()) / 60000); left = m >= 0 ? ` · ${m} min left` : ` · ${-m} min over`; }
  const last = n ? (() => { const p = D.pool.find((x) => x.id === D.picks[n - 1].player) || { name: "?" }; return `\nLast pick: **${N[H.slot(n - 1).team] || H.slot(n - 1).team}** — ${p.name}`; })() : "";
  return reply(`⏰ **On the clock:** ${N[s.team] || s.team}${fo ? ` (<@${fo}>)` : ""} — Round ${s.round}, Pick ${s.pick} (#${s.overall})${left}${D.status === "paused" ? " · ⏸️ paused" : ""}${last}\n${BOARD}`);
}

async function available(i, env) {
  const pos = String((i.data.options || []).find((o) => o.name === "position")?.value || "").toUpperCase().trim();
  const { D } = await loadDraft(env), { avail } = helpers(D);
  const list = avail.filter((p) => !pos || (p.pos || []).includes(pos)).slice(0, 15);
  if (!list.length) return reply(pos ? `No available players at ${pos}.` : "No players available.", true);
  return reply(`**Best available${pos ? " — " + pos : ""}:**\n` + list.map((p, k) => `${p.rank ? "#" + p.rank : k + 1 + "."} **${p.name}**${posTxt(p) ? " (" + posTxt(p) + ")" : ""}${p.tier ? " · T" + p.tier : ""}`).join("\n"), true);
}

async function doPick(i, env) {
  const say = (content) => fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
  try {
    const user = i.member?.user?.id || i.user?.id, roles = i.member?.roles || [];
    const raw = String((i.data.options || []).find((o) => o.name === "player")?.value || "").trim();
    const commish = String(env.COMMISH_IDS || "").split(/[\s,]+/).includes(user) || (env.COMMISH_ROLE_ID && roles.includes(env.COMMISH_ROLE_ID));
    const N = await teamNames(env);
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
      try {
        await gh(env, "draft.json", { method: "PUT", body: JSON.stringify({
          message: `Pick #${s.overall}: ${s.team} select ${p.name} (via /pick)`, content: b64e(JSON.stringify(D, null, 1) + "\n"), sha }) });
      } catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
      return say(`✅ **Pick is in!** ${N[s.team] || s.team} select **${p.name}**${posTxt(p) ? " (" + posTxt(p) + ")" : ""} — Round ${s.round}, Pick ${s.pick}.\nThe bot will announce it in the draft channel in a few seconds.`);
    }
    return say("⚠️ The draft was busy — try /pick again.");
  } catch (e) {
    return say("⚠️ Couldn't save the pick: " + (e.message || e) + (e.status === 401 || e.status === 403 || e.status === 404 ? " (check the Worker's GITHUB_TOKEN)" : ""));
  }
}
