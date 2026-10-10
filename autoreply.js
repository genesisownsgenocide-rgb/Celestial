"use strict";

// Auto reply master switch (ON/OFF from the dashboard) + anti-spam + "never repeat" picker.
// Kept in its own file so it works with your store.js without touching it.

const fs = require("fs");
const path = require("path");

const DIR = process.env.CELESTIAL_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const FILE = process.env.CELESTIAL_AUTOREPLY_FILE || path.join(DIR, "autoreply.json");

const state = { on: false, threads: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
  state.on = Boolean(j.on);
  if (j.threads && typeof j.threads === "object") state.threads = j.threads;
} catch (_) {}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state), { mode: 0o600 });
  } catch (e) { console.error("[AUTOREPLY] could not save state:", e.message); }
}

const isOn = () => state.on;
const setOn = (v) => { state.on = Boolean(v); save(); return state.on; };

// Group chats started from the dashboard (kept across restarts)
const rememberThread = (id, name) => { state.threads[String(id)] = { name: String(name || ""), at: new Date().toISOString() }; save(); };
const forgetThread = (id) => { if (state.threads[String(id)]) { delete state.threads[String(id)]; save(); } };
const listThreads = () => Object.entries(state.threads).map(([id, t]) => ({ id, name: t.name, at: t.at }));

// ---------------- anti-spam ----------------
const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const AS = {
  threadMax: Math.max(1, num(process.env.BANAT_THREAD_MAX, 12)),                       // replies per window, per thread
  threadWindowMs: Math.max(1000, num(process.env.BANAT_THREAD_WINDOW_MS, 10 * 60 * 1000)),
  senderCooldownMs: Math.max(0, num(process.env.BANAT_SENDER_COOLDOWN_MS, 8000)),      // gap between replies to one person
  hourlyMax: Math.max(1, num(process.env.BANAT_HOURLY_MAX, 120)),                      // total replies per hour
  skipMin: Math.max(0, Math.floor(num(process.env.BANAT_SKIP_MIN, 1))),                // after a reply, skip this many messages (random min..max)
  skipMax: Math.max(0, Math.floor(num(process.env.BANAT_SKIP_MAX, 3))),
  maxSilenceMs: Math.max(1000, num(process.env.BANAT_MAX_SILENCE_MS, 90000)),          // never stay quiet longer than this in an active chat
  dupWindowMs: 30000
};

AS.skipMax = Math.max(AS.skipMin, AS.skipMax);

const threadReplies = new Map();
const threadState = new Map(); // threadID -> { skipLeft, lastReplyAt }
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function tstate(id) {
  let s = threadState.get(id);
  if (!s) { s = { skipLeft: 0, lastReplyAt: 0 }; threadState.set(id, s); }
  return s;
}
// after a reply: skip a random 1-3 of the next messages
function noteReply(id) { const s = tstate(id); s.lastReplyAt = Date.now(); s.skipLeft = rnd(AS.skipMin, AS.skipMax); }
// after the dashboard opener: reply to the very next message
function openerSent(id) { const s = tstate(id); s.lastReplyAt = Date.now(); s.skipLeft = 0; }
const senderLast = new Map();
const recentIncoming = new Map();
const hourly = [];
const reasons = {};
let suppressed = 0;

function hourlyCount() {
  const now = Date.now();
  while (hourly.length && now - hourly[0] > 3600000) hourly.shift();
  return hourly.length;
}

// returns null when the reply is allowed, otherwise the reason it was blocked
function check({ senderID, threadID, body, isAdmin }) {
  const now = Date.now();
  const dupKey = senderID + "|" + String(body).toLowerCase().slice(0, 200);
  const lastDup = recentIncoming.get(dupKey);
  recentIncoming.set(dupKey, now);
  if (recentIncoming.size > 500) {
    for (const [k, t] of recentIncoming) if (now - t > AS.dupWindowMs) recentIncoming.delete(k);
  }

  const st = tstate(threadID);
  let why = null;
  if (lastDup && now - lastDup < AS.dupWindowMs) why = "duplicate";
  else if (!isAdmin && st.skipLeft > 0 && now - st.lastReplyAt < AS.maxSilenceMs) { st.skipLeft--; why = "skip"; }
  else if (!isAdmin && now - (senderLast.get(senderID) || 0) < AS.senderCooldownMs) why = "sender_cooldown";
  else if (hourlyCount() >= AS.hourlyMax) why = "hourly_cap";
  else {
    const arr = (threadReplies.get(threadID) || []).filter((t) => now - t < AS.threadWindowMs);
    threadReplies.set(threadID, arr);
    if (arr.length >= AS.threadMax) why = "thread_cap";
    else {
      arr.push(now);
      hourly.push(now);
      senderLast.set(senderID, now);
      noteReply(threadID);
    }
  }

  if (why) { suppressed++; reasons[why] = (reasons[why] || 0) + 1; }
  return why;
}

// ---------------- never repeat a recent reply in the same thread ----------------
const recentByThread = new Map();
function pickReply(body, threadID, getTriggerReply, getConversationReply) {
  const seen = recentByThread.get(threadID) || [];
  let reply = null;
  for (let i = 0; i < 8; i++) {
    reply = getTriggerReply(body, threadID) || getConversationReply(body, threadID);
    if (!reply || !seen.includes(reply)) break;
  }
  if (reply) {
    seen.push(reply);
    while (seen.length > 40) seen.shift();
    recentByThread.set(threadID, seen);
  }
  return reply;
}

function snapshot() {
  return {
    auto_reply: state.on,
    replies_last_hour: hourlyCount(),
    replies_suppressed: suppressed,
    suppressed_by: { ...reasons },
    antispam: {
      thread_max: AS.threadMax,
      thread_window_s: AS.threadWindowMs / 1000,
      sender_cooldown_s: AS.senderCooldownMs / 1000,
      hourly_max: AS.hourlyMax,
      skip_messages: AS.skipMin + "-" + AS.skipMax,
      max_silence_s: AS.maxSilenceMs / 1000
    }
  };
}

module.exports = { isOn, setOn, check, pickReply, snapshot, rememberThread, forgetThread, listThreads, openerSent };
