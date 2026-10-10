"use strict";

/*
 * BANAT-ONLY MESSENGER BOT
 * ------------------------
 * No AI. No games. No economy. No RPG. No music. No database.
 *
 * ACTIVATION:
 *   Send: !banat on
 *
 * OTHER COMMANDS:
 *   !banat off
 *   !banat toggle
 *   !banat status
 *   !banat help
 *
 * After "!banat on", Banat stays active for that thread until "!banat off".
 * BANAT_DEFAULT_ON=true can be used to start every thread in active mode.
 *
 * CELESTIAL dashboard: open the Railway URL "/" and paste the cookie there.
 * Dashboard "Auto reply" switch = chat in every thread (with anti-spam, see autoreply.js).
 */

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const store = require("./store");
const autoreply = require("./autoreply");

// Dashboard key: created on first visit to the dashboard (stored hashed in store.js).
// No environment variable needed.

// Railway: if a Volume is attached, keep the cookie there so it survives redeploys.
if (!process.env.CELESTIAL_SESSION_FILE && process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  process.env.CELESTIAL_SESSION_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "appstate.json");
}

const PORT = Number(process.env.PORT || 10000);
const DEFAULT_ON = /^(1|true|yes|on)$/i.test(process.env.BANAT_DEFAULT_ON || "false");
const GLOBAL_SEND_LIMIT = Math.max(1, Number(process.env.BANAT_GLOBAL_SEND_LIMIT || 2));
const THREAD_COOLDOWN_MS = Math.max(0, Number(process.env.BANAT_THREAD_COOLDOWN_MS || 12000));
const RETRY_DELAYS = [1500, 4000, 8000];

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();
let globalActive = 0;
let botUserID = "";
let botPaused = false;
let messengerConnected = false;
let loginError = null;
let lastConnectedAt = null;
let lastDisconnectedAt = null;

// --- dashboard / session control state ---
let currentApi = null;
let stopListener = null;
let loginInProgress = false;
let loginGen = 0;               // bumps on every (re)login/disconnect so stale callbacks are ignored
let sessionOverride = null;     // cookie pasted from the dashboard
let lastError = null;
let lastMessageAt = null;
const stats = { received: 0, sent: 0, commands: 0, errors: 0 };
const events = [];

function pushEvent(type, message) {
  events.unshift({ type, message, at: new Date().toISOString() });
  if (events.length > 100) events.length = 100;
}

function noteError(where, error) {
  stats.errors++;
  lastError = { where, message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() };
  pushEvent("error", `${where}: ${lastError.message}`);
}

// --- watchdog / auto-recovery state ---
const MAX_RECONNECTS = Math.max(1, Number(process.env.BANAT_MAX_RECONNECTS || 10));
const PROBE_INTERVAL_MS = Math.max(60000, Number(process.env.BANAT_PROBE_INTERVAL_MS || 3 * 60 * 1000));
const MEMORY_LIMIT_MB = Math.max(150, Number(process.env.BANAT_MEMORY_LIMIT_MB || 450));
const LOGIN_TIMEOUT_MS = 60000;
const RETRY_AFTER_GIVE_UP_MS = 30 * 60 * 1000;
let manualStop = false;         // true only when YOU press Disconnect on the dashboard
let reconnectTimer = null;
let reconnectAttempts = 0;
let nextRetryAt = null;
let loginTimer = null;
let probeFailures = 0;
let lastProbeAt = null;
let lastProbeOk = null;
let offlineSince = Date.now();

// Never let a stray error kill the process.
process.on("uncaughtException", (error) => {
  console.error("[BANAT] uncaughtException:", error);
  noteError("uncaught", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[BANAT] unhandledRejection:", error);
  noteError("unhandled", error);
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[BANAT] ${sig} received, shutting down`);
    manualStop = true;
    try { disconnectBot(); } catch (_) {}
    setTimeout(() => process.exit(0), 300);
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function parseMaybeJson(text) {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch (_) { return trimmed; }
}

function readSession() {
  // 1) cookie pasted on the dashboard (this run)
  if (sessionOverride) return parseMaybeJson(sessionOverride);

  // 2) cookie saved by the dashboard (survives restarts if disk is persistent)
  const candidates = [
    process.env.CELESTIAL_SESSION_FILE,
    path.join(process.cwd(), "appstate.json"),
    path.join(process.cwd(), "cookies.json")
  ].filter(Boolean);
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) return parseMaybeJson(fs.readFileSync(filePath, "utf8"));
  }

  // 3) environment variables
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;
  if (raw) return parseMaybeJson(raw);

  throw new Error(
    "No Facebook session found. Paste a cookie in the CELESTIAL dashboard."
  );
}

function normalizeSession(value) {
  // ws3-fca 2.0.1 expects the saved Facebook session as a cookie string,
  // not { appState: [...] }. Convert exported cookie/appstate JSON into
  // the header format that version accepts.
  if (typeof value === "string") {
    const cookie = value.trim();
    if (!cookie) throw new Error("Facebook cookie session is empty.");
    return cookie;
  }

  const entries =
    Array.isArray(value) ? value :
    Array.isArray(value?.appState) ? value.appState :
    Array.isArray(value?.cookies) ? value.cookies :
    null;

  if (!entries) {
    throw new Error(
      "Facebook session must be a cookie string or a JSON array of cookie/appState entries."
    );
  }

  const parts = entries
    .map(cookie => {
      const key = cookie?.key ?? cookie?.name;
      const val = cookie?.value;
      if (key == null || val == null) return null;
      return String(key).trim() + "=" + String(val);
    })
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Facebook session contains no valid cookie entries.");
  }

  return parts.join("; ");
}

function enqueue(threadID, job) {
  const key = String(threadID);
  const current = threadQueues.get(key) || Promise.resolve();
  const next = current.catch(() => {}).then(job).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key);
  });
  threadQueues.set(key, next);
  return next;
}

async function acquireGlobalSlot() {
  while (globalActive >= GLOBAL_SEND_LIMIT) await sleep(150);
  globalActive++;
}

function releaseGlobalSlot() { globalActive = Math.max(0, globalActive - 1); }

function is1545012(error) {
  const text = JSON.stringify(error || "");
  return /1545012|temporarily unavailable|message could not be sent/i.test(text);
}

function trafficSendMessage(api, message, threadID, callback, replyToMessageID = null) {
  const key = String(threadID);
  return enqueue(key, async () => {
    const now = Date.now();
    const cooldownUntil = Number(threadCooldown.get(key) || 0);
    if (cooldownUntil > now) {
      callback(new Error(`thread cooldown active for ${cooldownUntil - now}ms`));
      return;
    }

    const sinceLast = now - Number(threadLastSent.get(key) || 0);
    if (sinceLast < THREAD_COOLDOWN_MS) await sleep(THREAD_COOLDOWN_MS - sinceLast);

    await acquireGlobalSlot();
    try {
      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const result = await new Promise((resolve, reject) => {
            let settled = false;
            const done = (err, info) => {
              if (settled) return;
              settled = true;
              err ? reject(err) : resolve(info);
            };
            try {
              let returned;
              if (replyToMessageID) returned = api.sendMessage(message, threadID, done, replyToMessageID);
              else returned = api.sendMessage(message, threadID, done);
              if (returned && typeof returned.then === "function") returned.then(info => done(null, info)).catch(done);
            } catch (e) { reject(e); }
          });
          threadLastSent.set(key, Date.now());
          callback(null, result);
          return;
        } catch (error) {
          lastErr = error;
          if (!is1545012(error) || attempt >= RETRY_DELAYS.length) break;
          threadCooldown.set(key, Date.now() + Math.min(15000, RETRY_DELAYS[attempt]));
          await sleep(RETRY_DELAYS[attempt]);
          threadCooldown.delete(key);
        }
      }
      if (is1545012(lastErr)) threadCooldown.set(key, Date.now() + 5 * 60 * 1000);
      callback(lastErr);
    } finally {
      releaseGlobalSlot();
    }
  });
}

function isBanatCommand(body) {
  return /^!banat(?:\s|$)/i.test(String(body || "").trim());
}

function commandSendMessage(api, message, threadID, replyToMessageID = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(info);
    };

    try {
      const returned = replyToMessageID
        ? api.sendMessage(message, threadID, done, replyToMessageID)
        : api.sendMessage(message, threadID, done);

      if (returned && typeof returned.then === "function") {
        returned.then(info => done(null, info)).catch(done);
      }
    } catch (error) {
      done(error);
    }
  });
}

function sendCommandReply(api, event, message) {
  const threadID = String(event.threadID);
  commandSendMessage(api, message, threadID, event.messageID || null)
    .then(() => { stats.sent++; console.log(`[BANAT] command reply sent: ${message}`); })
    .catch(error => { noteError("command reply", error); console.error("[BANAT] command reply failed:", error?.message || error); });
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const parts = String(body).trim().split(/\s+/);
  const sub = (parts[1] || "status").toLowerCase();

  if (sub === "on" || sub === "enable" || sub === "start") {
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
    console.log(`[BANAT] activated thread ${threadID} by ${event.senderID || "unknown"}`);
    sendCommandReply(api, event, "banat is on. say whatever u want 😭");
    return true;
  }

  if (sub === "off" || sub === "disable" || sub === "stop") {
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    autoreply.forgetThread(threadID);
    console.log(`[BANAT] deactivated thread ${threadID}`);
    sendCommandReply(api, event, "banat off. peace 😭");
    return true;
  }

  if (sub === "toggle") {
    const next = !isBanatConversationModeActive(threadID);
    setBanatConversationMode(threadID, next, event.senderID);
    if (next) activeThreads.add(threadID);
    else { activeThreads.delete(threadID); autoreply.forgetThread(threadID); }
    console.log(`[BANAT] toggled thread ${threadID}: ${next ? "ON" : "OFF"}`);
    sendCommandReply(api, event, next ? "banat is on 😭" : "banat is off");
    return true;
  }

  if (sub === "status") {
    const on = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
    sendCommandReply(api, event, on ? "banat: ON 🟢" : "banat: OFF 🔴");
    return true;
  }

  if (sub === "help") {
    sendCommandReply(api, event, "!banat on · !banat off · !banat toggle · !banat status");
    return true;
  }

  sendCommandReply(api, event, "unknown banat command. use !banat help");
  return true;
}

async function sendBanat(api, event, text) {
  try {
    const result = await sendBanatReplyWithTyping(api, text, String(event.threadID), event.messageID || null, {
      trafficSendMessage,
      incomingText: event.body || ""
    });
    stats.sent++;
    pushEvent("reply", `thread ${event.threadID}: ${String(text).slice(0, 60)}`);
    return result;
  } catch (error) {
    noteError("reply", error);
    throw error;
  }
}

const dotLast = new Map();

function reactMessage(api, emoji, messageID, force) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(info);
    };
    try {
      const returned = api.setMessageReaction(emoji, messageID, done, force);
      if (returned && typeof returned.then === "function") returned.then(info => done(null, info)).catch(done);
    } catch (error) {
      done(error);
    }
  });
}

function handleDot(api, event, on) {
  const threadID = String(event.threadID);

  // "." turns Banat ON for this thread, ".." turns it OFF (same as !banat on / !banat off)
  if (on) {
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
  } else {
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    autoreply.forgetThread(threadID);
  }
  console.log(`[BANAT] dot ${on ? "ON" : "OFF"} thread ${threadID} by ${event.senderID || "unknown"}`);

  if (!event.messageID || typeof api.setMessageReaction !== "function") return;

  // small per-thread throttle on the reaction so spamming dots can't hammer Facebook
  const now = Date.now();
  if (now - Number(dotLast.get(threadID) || 0) < 3000) return;
  dotLast.set(threadID, now);

  const emoji = on ? "❤" : "💤";
  // ❤ is a standard Messenger reaction; 💤 needs the "custom reaction" flag. Retry with the other flag if one fails.
  (async () => {
    try { await reactMessage(api, emoji, event.messageID, !on); }
    catch (_) { await reactMessage(api, emoji, event.messageID, on); }
  })()
    .then(() => { stats.sent++; pushEvent("reaction", `thread ${threadID}: ${emoji}`); })
    .catch(error => { noteError("dot reaction", error); console.error("[BANAT] dot reaction failed:", error?.message || error); });
}

function onMessage(api, event) {
  if (!event) return;
  if (event.type && event.type !== "message") return;
  if (botPaused) return;
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;

  // Admin-only mode: only registered admins can use the bot.
  // Skipped while no admin exists yet, so you can't lock yourself out.
  if (store.list().length && store.getSettings().admin_only && !store.rankOf(event.senderID)) return;

  stats.received++;
  lastMessageAt = new Date().toISOString();
  pushEvent("message", `thread ${event.threadID} · ${event.senderID || "?"}: ${body.slice(0, 60)}`);

  // "." = Banat ON (reacts ❤), ".." = Banat OFF (reacts 💤).
  if (body === "." || body === "..") { stats.commands++; handleDot(api, event, body === "."); return; }

  if (isBanatCommand(body)) { stats.commands++; handleBanatCommand(api, event, body); return; }

  const threadID = String(event.threadID);
  const senderID = String(event.senderID || "");

  // Dashboard "Auto reply: ON" = chat in every thread. Otherwise only "."/!banat on threads or direct targets.
  const active = autoreply.isOn() || activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
  const target = classifyBanatTarget({ event, body, botID: botUserID });
  if (!active && !target.shouldRespond) return;

  // Anti-spam for every automatic reply (duplicates, per-person cooldown, per-thread and hourly caps, random skip)
  if (autoreply.check({ senderID, threadID, body, isAdmin: Boolean(store.rankOf(senderID)) })) return;

  // Never repeat a recent reply in the same thread
  const reply = autoreply.pickReply(body, threadID, getTriggerReply, getBanatConversationReply);
  if (!reply) {
    console.warn(`[BANAT] no reply generated for message in ${threadID}`);
    return;
  }
  console.log(`[BANAT] auto reply in ${threadID} to ${senderID || "unknown"}`);
  sendBanat(api, event, reply).catch(error => console.error("[BANAT] reply error:", error));
}

function start(api, gen) {
  currentApi = api;
  offlineSince = null;
  probeFailures = 0;
  messengerConnected = true;
  loginError = null;
  lastConnectedAt = new Date().toISOString();
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}

  if (DEFAULT_ON) console.log("[BANAT] BANAT_DEFAULT_ON enabled.");

  const stop = api.listenMqtt((error, event) => {
    if (gen !== loginGen) return; // stale listener from an old session
    if (error) {
      noteError("listener", error);
      console.error("[BANAT] listener error:", error);
      const text = JSON.stringify(error?.message || error || "");
      if (/not logged in|checkpoint|login approval|session.*(expired|invalid)|invalid.*session|authentication/i.test(text)) {
        loginError = String(error?.message || error);
        disconnectBot();
        scheduleReconnect("session error");
      }
      return;
    }
    try {
      if (DEFAULT_ON && event?.threadID && event?.senderID && String(event.senderID) !== botUserID) {
        const key = String(event.threadID);
        if (!activeThreads.has(key)) {
          activeThreads.add(key);
          setBanatConversationMode(key, true, event.senderID);
        }
      }
      onMessage(api, event);
    } catch (e) {
      noteError("message handler", e);
      console.error("[BANAT] message handler error:", e);
    }
  });

  stopListener = typeof stop === "function"
    ? stop
    : (typeof api.stopListening === "function" ? () => api.stopListening() : null);

  // Bring back the group chats you started from the dashboard (after a restart / reconnect)
  for (const t of autoreply.listThreads()) {
    activeThreads.add(t.id);
    try { setBanatConversationMode(t.id, true, "dashboard"); } catch (_) {}
  }

  console.log(`[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`);
}

// Stops the bot locally. Does NOT call api.logout(), so the Facebook cookie stays valid.
function disconnectBot() {
  loginGen++;
  clearTimeout(loginTimer);
  loginTimer = null;
  try { if (stopListener) stopListener(); } catch (_) {}
  stopListener = null;
  currentApi = null;
  if (messengerConnected) lastDisconnectedAt = new Date().toISOString();
  messengerConnected = false;
  loginInProgress = false;
  offlineSince = offlineSince || Date.now();
  console.log("[BANAT] disconnected");
}

function resetRetry() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
  nextRetryAt = null;
}

// Auto-reconnect with exponential backoff: 5s, 10s, 20s ... up to 5 min.
function scheduleReconnect(reason) {
  if (manualStop || reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECTS) {
    pushEvent("watchdog", `Gave up after ${MAX_RECONNECTS} tries. Will retry in 30 min, or paste a fresh cookie.`);
    return;
  }
  const delay = Math.min(300000, 5000 * 2 ** reconnectAttempts);
  reconnectAttempts++;
  nextRetryAt = new Date(Date.now() + delay).toISOString();
  pushEvent("watchdog", `${reason} -> reconnect #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
  console.log(`[BANAT] ${reason}; reconnect #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    nextRetryAt = null;
    if (manualStop) return;
    disconnectBot();
    loginBot();
  }, delay);
}

function loginBot() {
  const gen = ++loginGen;
  let cookie;
  try {
    cookie = normalizeSession(readSession());
  } catch (error) {
    messengerConnected = false;
    loginInProgress = false;
    loginError = String(error?.message || error);
    console.error("[BANAT] no usable session:", loginError);
    return; // nothing to retry until a cookie is pasted
  }

  loginInProgress = true;
  loginError = null;
  console.log("[BANAT] logging in with saved Facebook session...");
  console.log(`[BANAT] session format: cookie string (${cookie.length} chars)`);

  // If login hangs, give up on this attempt and retry.
  clearTimeout(loginTimer);
  loginTimer = setTimeout(() => {
    if (gen !== loginGen || !loginInProgress) return;
    loginGen++;
    loginInProgress = false;
    loginError = "login timed out";
    noteError("login", "timed out");
    scheduleReconnect("login timeout");
  }, LOGIN_TIMEOUT_MS);

  try {
    login(cookie, (error, api) => {
      if (gen !== loginGen) return; // superseded by a newer login/disconnect
      clearTimeout(loginTimer);
      loginInProgress = false;
      if (error) {
        messengerConnected = false;
        loginError = String(error?.message || error);
        noteError("login", error);
        console.error("[BANAT] login failed:", error);
        scheduleReconnect("login failed");
        return;
      }
      start(api, gen);
    });
  } catch (error) {
    clearTimeout(loginTimer);
    loginInProgress = false;
    loginError = String(error?.message || error);
    noteError("login", error);
    scheduleReconnect("login error");
  }
}

// Light "are you still logged in?" check every few minutes.
function probe() {
  if (!messengerConnected || !currentApi || manualStop) return;
  const api = currentApi;
  const gen = loginGen;
  if (typeof api.getUserInfo !== "function" || !botUserID) return;

  let done = false;
  let timer = null;
  const finish = (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (gen !== loginGen) return;
    lastProbeAt = new Date().toISOString();
    if (!err) {
      probeFailures = 0;
      lastProbeOk = true;
      reconnectAttempts = 0;
      return;
    }
    lastProbeOk = false;
    probeFailures++;
    noteError("watchdog probe", err);
    if (probeFailures >= 3) {
      probeFailures = 0;
      pushEvent("watchdog", "Probe failed 3 times, restarting connection");
      disconnectBot();
      scheduleReconnect("probe failed");
    }
  };

  timer = setTimeout(() => finish(new Error("probe timeout")), 30000);
  try {
    const r = api.getUserInfo(botUserID, (err) => finish(err || null));
    if (r && typeof r.then === "function") r.then(() => finish(null)).catch(finish);
  } catch (e) {
    finish(e);
  }
}

function hasSession() {
  try { normalizeSession(readSession()); return true; } catch (_) { return false; }
}

// Memory guard + "stuck offline" guard, once a minute.
function guard() {
  const mb = process.memoryUsage().rss / 1048576;
  if (mb > MEMORY_LIMIT_MB) {
    console.error(`[BANAT] memory ${Math.round(mb)}MB > ${MEMORY_LIMIT_MB}MB, restarting`);
    pushEvent("watchdog", `Memory ${Math.round(mb)}MB too high, restarting process`);
    setTimeout(() => process.exit(1), 500); // Railway restarts it (see railway.json)
    return;
  }
  if (
    !messengerConnected && !loginInProgress && !manualStop && !reconnectTimer &&
    reconnectAttempts >= MAX_RECONNECTS && offlineSince &&
    Date.now() - offlineSince > RETRY_AFTER_GIVE_UP_MS && hasSession()
  ) {
    reconnectAttempts = 0;
    offlineSince = Date.now();
    scheduleReconnect("periodic retry");
  }
}

// ---------------- group chats (dashboard) ----------------
const OPENER_DEFAULT = process.env.BANAT_OPENER || "sige tumakbo ka na HAHAHAHAHA";
let groupsCache = { at: 0, list: [] };
let lastGroupStart = 0;

function fetchThreadList(api, limit) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, list) => { if (settled) return; settled = true; err ? reject(err instanceof Error ? err : new Error(String(err?.message || err?.error || JSON.stringify(err)))) : resolve(list || []); };
    const timer = setTimeout(() => done(new Error("Facebook took too long to return the chat list")), 30000);
    try {
      const r = api.getThreadList(limit, null, ["INBOX"], (err, list) => { clearTimeout(timer); done(err, list); });
      if (r && typeof r.then === "function") r.then((l) => { clearTimeout(timer); done(null, l); }).catch((e) => { clearTimeout(timer); done(e); });
    } catch (e) { clearTimeout(timer); done(e); }
  });
}

async function listGroups(refresh) {
  const api = currentApi;
  if (!api || !messengerConnected) throw new Error("Bot is not connected to Messenger");
  if (typeof api.getThreadList !== "function") throw new Error("This ws3-fca version has no getThreadList()");

  // cache so the dashboard can't hammer Facebook (refresh at most every 10s)
  const age = Date.now() - groupsCache.at;
  if (!groupsCache.at || (refresh && age > 10000) || age > 5 * 60 * 1000) {
    const raw = await fetchThreadList(api, 50);
    groupsCache = {
      at: Date.now(),
      list: raw
        .filter((t) => t && (t.isGroup === true || t.threadType === 2))
        .map((t) => ({
          id: String(t.threadID),
          name: String(t.name || t.threadName || "Unnamed group").slice(0, 80),
          members: (t.participantIDs || t.participants || []).length,
          ts: Number(t.timestamp || 0)
        }))
    };
  }

  const known = new Set(groupsCache.list.map((g) => g.id));
  const saved = new Map(autoreply.listThreads().map((t) => [t.id, t.name]));
  const extra = [...activeThreads].filter((id) => !known.has(id)).map((id) => ({ id, name: saved.get(id) || ("Group " + id), members: 0, ts: 0 }));

  return [...groupsCache.list, ...extra]
    .map((g) => ({ id: g.id, name: g.name, members: g.members, active: activeThreads.has(g.id) }))
    .sort((a, b) => Number(b.active) - Number(a.active));
}

async function startGroup(threadID, name, message) {
  const api = currentApi;
  if (!api || !messengerConnected) throw new Error("Bot is not connected to Messenger");
  threadID = String(threadID || "").trim();
  if (!/^\d{5,25}$/.test(threadID)) throw new Error("Invalid group ID");
  if (Date.now() - lastGroupStart < 8000) throw new Error("Teka lang, mag-antay ng ilang segundo bago mag-start ng isa pang GC");
  lastGroupStart = Date.now();

  const text = String(message || "").trim().slice(0, 200) || OPENER_DEFAULT;
  const label = String(name || "").slice(0, 80);
  activeThreads.add(threadID);
  try { setBanatConversationMode(threadID, true, "dashboard"); } catch (_) {}
  autoreply.rememberThread(threadID, label);

  try {
    // goes through your humanizer (typing delay etc.) and the same send queue/cooldowns as normal replies
    await sendBanatReplyWithTyping(api, text, threadID, null, { trafficSendMessage, incomingText: "" });
    stats.sent++;
    autoreply.openerSent(threadID);
    pushEvent("group", `started ${label || threadID}: ${text.slice(0, 60)}`);
  } catch (error) {
    // a failed opener must not leave the GC half-started
    activeThreads.delete(threadID);
    try { setBanatConversationMode(threadID, false); } catch (_) {}
    autoreply.forgetThread(threadID);
    noteError("group start", error);
    throw new Error("Hindi na-send ang message sa GC: " + (error?.message || error));
  }
}

async function stopGroup(threadID) {
  threadID = String(threadID || "").trim();
  activeThreads.delete(threadID);
  try { setBanatConversationMode(threadID, false); } catch (_) {}
  autoreply.forgetThread(threadID);
  pushEvent("group", `stopped ${threadID}`);
}

function threadsInCooldown() {
  const now = Date.now();
  let n = 0;
  for (const until of threadCooldown.values()) if (Number(until) > now) n++;
  return n;
}

try {
  require("./dashboard-api")(PORT, () => ({
    ok: true,
    facebook_connected: messengerConnected,
    facebook_user_id: botUserID || null,
    facebook_user_name: null,
    session_active: messengerConnected,
    bot_running: messengerConnected && !botPaused,
    paused: botPaused,
    login_in_progress: loginInProgress,
    login_error: loginError,
    last_error: lastError,
    last_connected_at: lastConnectedAt,
    last_disconnected_at: lastDisconnectedAt,
    last_message_at: lastMessageAt,
    messages_received: stats.received,
    replies_sent: stats.sent,
    commands_used: stats.commands,
    errors: stats.errors,
    active_threads: activeThreads.size,
    threads_in_cooldown: threadsInCooldown(),
    default_on: DEFAULT_ON,
    global_send_limit: GLOBAL_SEND_LIMIT,
    thread_cooldown_ms: THREAD_COOLDOWN_MS,
    auto_reconnect: !manualStop,
    reconnect_attempts: reconnectAttempts,
    next_retry_at: nextRetryAt,
    watchdog_gave_up: reconnectAttempts >= MAX_RECONNECTS && !messengerConnected,
    probe_failures: probeFailures,
    last_probe_ok: lastProbeOk,
    last_probe_at: lastProbeAt,
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    memory_limit_mb: MEMORY_LIMIT_MB,
    admin_count: store.list().length,
    admin_only: Boolean(store.getSettings().admin_only),
    ...autoreply.snapshot(),
    updated_at: new Date().toISOString()
  }), {
    setPaused: (paused) => { botPaused = Boolean(paused); },
    getPaused: () => botPaused,
    getEvents: () => events,
    listGroups,
    startGroup,
    stopGroup,
    setBio: (bio) => new Promise((resolve, reject) => {
      const api = currentApi;
      if (!api || !messengerConnected) return reject(new Error("Bot is not connected to Messenger"));
      if (typeof api.changeBio !== "function") return reject(new Error("This ws3-fca version has no changeBio()"));
      let settled = false;
      const done = (err, res) => {
        if (settled) return;
        settled = true;
        if (err) reject(err instanceof Error ? err : new Error(String(err?.message || err?.error || JSON.stringify(err))));
        else resolve(res);
      };
      try {
        const ret = api.changeBio(String(bio || "").slice(0, 101), true, done);
        if (ret && typeof ret.then === "function") ret.then((r) => done(null, r)).catch(done);
      } catch (e) { done(e); }
    }),
    connectSession: async (raw) => {
      sessionOverride = raw;
      manualStop = false;
      resetRetry();
      disconnectBot();
      loginBot();
    },
    reconnect: async () => {
      manualStop = false;
      resetRetry();
      disconnectBot();
      loginBot();
    },
    disconnect: async () => {
      sessionOverride = null;
      manualStop = true;
      resetRetry();
      disconnectBot();
    }
  });
} catch (error) {
  console.error("[BANAT] dashboard API failed:", error);
}

setInterval(probe, PROBE_INTERVAL_MS).unref();
setInterval(guard, 60000).unref();

loginBot();

module.exports = { trafficSendMessage, onMessage, handleBanatCommand };
