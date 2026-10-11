// MCPD CompStat — Discord evidence helper
// Runs on GitHub every ~10 minutes. Reads NEW posts in the evidence channel as the MCPD CompStat bot,
// hands each post with screenshots to the CompStat spreadsheet (which reads them and adds them as Pending),
// then reacts 📥 (added for review) or 👀 (you need to enter it) on the post.
// Nothing secret is in this file: the bot token, the spreadsheet address and its key are GitHub Secrets.

const TOKEN = (process.env.DISCORD_TOKEN || '').trim().replace(/^Bot\s+/i, '');
const SHEET_URL = (process.env.SHEET_URL || '').trim();
const SHEET_KEY = (process.env.SHEET_KEY || '').trim();
const API = 'https://discord.com/api/v10';
const MAX_POSTS = 500;                       // per run; anything more waits for the next run

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (id) => BigInt(id || '0');

class Stop extends Error {}                  // a problem you need to fix (makes the run show a red ✗)

// ---- the spreadsheet --------------------------------------------------------------------
async function sheet(body) {
  let lastErr;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(SHEET_URL, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, key: SHEET_KEY }),
      });
      const text = await res.text();
      try { return JSON.parse(text); }
      catch {
        throw new Stop('The spreadsheet did not answer properly. Check that SHEET_URL is the Web app URL ending in /exec ' +
                       'and that the deployment\'s "Who has access" is "Anyone". (It answered: ' + text.slice(0, 150).replace(/\s+/g, ' ') + ')');
      }
    } catch (err) {
      if (err instanceof Stop) throw err;
      lastErr = err; await sleep(3000 * (a + 1));                    // Google hiccup → try again
    }
  }
  throw new Error('Could not reach the spreadsheet: ' + (lastErr && lastErr.message));
}

// ---- Discord --------------------------------------------------------------------------------
async function discord(method, path) {
  for (let a = 0; a < 5; a++) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bot ' + TOKEN, 'User-Agent': 'DiscordBot (https://github.com, 1.0)' },
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (res.ok) return j;
    if (res.status === 429) { await sleep(Math.min(15000, ((j && j.retry_after) || 2) * 1000 + 250)); continue; }
    if (res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
    const why = j && j.message ? ' [Discord: ' + j.message + ' ' + (j.code || '') + ']' : '';
    if (res.status === 401) throw new Stop('Discord says the bot token is wrong (401)' + why + ' — reset it and update the DISCORD_TOKEN secret on GitHub.');
    if (res.status === 403) throw new Stop('The bot can\'t see the evidence channel (403)' + why + ' — check the bot is in the server and has View Channel + Read Message History there.');
    if (res.status === 404) throw new Stop('Discord can\'t find the evidence channel (404)' + why + ' — was it deleted? Run "Discord evidence: set up" in the spreadsheet with the new channel ID.');
    throw new Stop('Discord answered ' + res.status + why + ' for ' + path);
  }
  throw new Error('Discord is busy — trying again next run');
}

async function react(channel, id, emoji) {
  try { await discord('PUT', `/channels/${channel}/messages/${id}/reactions/${encodeURIComponent(emoji)}/@me`); }
  catch (err) { console.log('Reaction skipped: ' + err.message); }   // no "Add Reactions" permission → just skip
}

const isImage = (a) => /^image\/(png|jpe?g)/i.test(a.content_type || '') || /\.(png|jpe?g)$/i.test(a.filename || '');

// ---- one run --------------------------------------------------------------------------------
async function main() {
  const missing = ['DISCORD_TOKEN', 'SHEET_URL', 'SHEET_KEY'].filter((k) => !(process.env[k] || '').trim());
  if (missing.length) throw new Stop('Missing GitHub secret(s): ' + missing.join(', ') + ' — Settings → Secrets and variables → Actions.');

  const state = await sheet({ action: 'state' });
  if (!state.ok) throw new Stop('Spreadsheet: ' + state.error);
  const channel = state.channel;
  const ch = await discord('GET', `/channels/${channel}`);
  const guild = ch.guild_id || '';

  // first run after set up → start from NOW (old posts are not read)
  if (!state.lastId || state.lastId === '0') {
    const now = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();   // a Discord ID for "this moment"
    await sheet({ action: 'done', lastId: now, summary: `Connected to #${ch.name}. Reading new posts from ${new Date().toUTCString()}.` });
    console.log(`Connected to #${ch.name}. From now on, new posts are read.`);
    return;
  }

  // new posts since last time, oldest first
  let after = state.lastId, posts = [];
  while (posts.length < MAX_POSTS) {
    const page = await discord('GET', `/channels/${channel}/messages?limit=100&after=${after}`);
    if (!page || !page.length) break;
    page.sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1));
    posts = posts.concat(page);
    after = page[page.length - 1].id;
    if (page.length < 100) break;
  }

  let lastDone = state.lastId, added = 0, review = 0, read = 0, busy = false;
  for (const p of posts) {
    const imgs = (p.attachments || []).filter(isImage);
    if (imgs.length && !(p.author && p.author.bot)) {
      let nick = '';
      if (guild) { try { nick = ((await discord('GET', `/guilds/${guild}/members/${p.author.id}`)) || {}).nick || ''; } catch {} }
      const r = await sheet({
        action: 'post', guild, nick,
        msg: {
          id: p.id, timestamp: p.timestamp,
          author: { id: p.author.id, username: p.author.username, global_name: p.author.global_name },
          attachments: imgs.map((a) => ({ url: a.url, filename: a.filename, content_type: a.content_type })),
        },
      });
      if (!r.ok) {
        if (r.busy) { busy = true; break; }                          // spreadsheet busy → rest next run
        throw new Stop('Spreadsheet: ' + r.error);
      }
      if (r.react) await react(channel, p.id, r.react);
      added += r.added || 0;
      if (r.review) review++;
      read++;
    }
    lastDone = p.id;
  }

  const summary = `Last run: ${posts.length} new post(s), ${read} with screenshots · ${added} row(s) added for review · ` +
                  `${review} sent to the "Discord Evidence" tab${busy ? ' · spreadsheet was busy, the rest waits for the next run' : ''}`;
  await sheet({ action: 'done', lastId: lastDone, summary });
  console.log(summary);
}

main().catch(async (err) => {
  console.error(err.message);
  if (SHEET_URL && SHEET_KEY) { try { await sheet({ action: 'error', message: err.message }); } catch {} }
  if (err instanceof Stop) process.exitCode = 1;                     // red ✗ on GitHub (and GitHub emails you)
});
