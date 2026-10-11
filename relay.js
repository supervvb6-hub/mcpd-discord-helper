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

  // where to look: a normal channel, or — for a FORUM like #seizure-reporting — every monthly post (thread)
  // in it that could have something new. A new month's thread is picked up by itself.
  let sources = [{ id: channel, name: ch.name }];
  if (ch.type === 15 || ch.type === 16) {                              // forum / media channel
    const since = Number((big(state.lastId) >> 22n) + 1420070400000n);  // time of the last post we handled
    const found = {};
    const act = await discord('GET', `/guilds/${guild}/threads/active`);
    (act && act.threads || []).filter((t) => t.parent_id === channel).forEach((t) => { found[t.id] = t.name; });
    // threads that went quiet and were archived since last time (only matters if runs were missed)
    try {
      const arc = await discord('GET', `/channels/${channel}/threads/archived/public?limit=50`);
      (arc && arc.threads || []).forEach((t) => {
        const at = Date.parse((t.thread_metadata || {}).archive_timestamp || 0);
        if (at > since) found[t.id] = t.name;
      });
    } catch (err) { console.log('Archived threads not checked: ' + err.message); }
    sources = Object.keys(found).map((id) => ({ id, name: found[id] }));
    console.log(`Forum #${ch.name}: checking ${sources.map((x) => '"' + x.name + '"').join(', ') || 'no open threads'}`);
  }

  // new posts since last time, from every source, oldest first
  let posts = [], cutoff = null;
  for (const src of sources) {
    let after = state.lastId, got = 0;
    while (true) {
      const page = await discord('GET', `/channels/${src.id}/messages?limit=100&after=${after}`);
      if (!page || !page.length) break;
      page.sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1));
      page.forEach((m) => { m.channel_id = m.channel_id || src.id; });
      posts = posts.concat(page);
      got += page.length;
      after = page[page.length - 1].id;
      if (page.length < 100) break;
      if (got >= MAX_POSTS) { if (cutoff === null || big(after) < big(cutoff)) cutoff = after; break; }   // rest next run
    }
  }
  posts.sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1));
  if (cutoff !== null) posts = posts.filter((m) => big(m.id) <= big(cutoff));

  // Discord hides what's in posts (text AND pictures) unless "Message Content Intent" is on
  const people = posts.filter((p) => !(p.author && p.author.bot) && p.type === 0);
  const hidden = people.filter((p) => !p.content && !(p.attachments || []).length && !(p.embeds || []).length && !(p.sticker_items || []).length);
  if (people.length && hidden.length === people.length)
    throw new Stop('Discord is hiding the posts\' contents and pictures from the bot. Developer Portal → your app → Bot → turn ON "Message Content Intent" → Save Changes. (The posts are not lost: they are read on the next run after that.)');
  const notImg = people.filter((p) => (p.attachments || []).length && !(p.attachments || []).some(isImage))
    .map((p) => (p.attachments || []).map((a) => a.content_type || a.filename).join(', '));
  if (notImg.length) console.log('Posts with files that are not PNG/JPG pictures (skipped): ' + notImg.join(' | '));

  let lastDone = state.lastId, added = 0, review = 0, read = 0, busy = false;
  for (const p of posts) {
    const imgs = (p.attachments || []).filter(isImage);
    if (imgs.length && !(p.author && p.author.bot)) {
      let nick = '';
      if (guild) { try { nick = ((await discord('GET', `/guilds/${guild}/members/${p.author.id}`)) || {}).nick || ''; } catch {} }
      const r = await sheet({
        action: 'post', guild, nick,
        msg: {
          id: p.id, channel_id: p.channel_id, timestamp: p.timestamp,
          author: { id: p.author.id, username: p.author.username, global_name: p.author.global_name },
          attachments: imgs.map((a) => ({ url: a.url, filename: a.filename, content_type: a.content_type })),
        },
      });
      if (!r.ok) {
        if (r.busy) { busy = true; break; }                          // spreadsheet busy → rest next run
        throw new Stop('Spreadsheet: ' + r.error);
      }
      if (r.react) await react(p.channel_id || channel, p.id, r.react);
      added += r.added || 0;
      if (r.review) review++;
      read++;
    }
    lastDone = p.id;
  }

  const summary = `Last run (${new Date().toUTCString()}): ${posts.length} new post(s), ${read} with screenshots · ${added} row(s) added for review · ` +
                  `${review} sent to the "Discord Evidence" tab${busy ? ' · spreadsheet was busy, the rest waits for the next run' : ''}`;
  await sheet({ action: 'done', lastId: lastDone, summary });
  console.log(summary);
}

main().catch(async (err) => {
  console.error(err.message);
  if (SHEET_URL && SHEET_KEY) { try { await sheet({ action: 'error', message: err.message }); } catch {} }
  if (err instanceof Stop) process.exitCode = 1;                     // red ✗ on GitHub (and GitHub emails you)
});
