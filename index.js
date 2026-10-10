"use strict";

/*
 * BANAT-ONLY MESSENGER BOT (ANTI-DETECTION OPTIMIZED)
 * --------------------------------------------------
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
 * Anti-detection features:
 * - Human-like jitter & variable typing delays
 * - Smart message fingerprinting & duplicate suppression
 * - Dynamic session throttling & adaptive cooldowns
 */

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const store = require("./store");
const autoreply = require("./autoreply");

// Railway: if a Volume is attached, keep the cookie there so it survives redeploys.
if (!process.env.CELESTIAL_SESSION_FILE && process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  process.env.CELESTIAL_SESSION_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "appstate.json");
}

const PORT = Number(process.env.PORT || 10000);
const DEFAULT_ON = /^(1|true|yes|on)$/i.test(process.env.BANAT_DEFAULT_ON || "false");
const GLOBAL_SEND_LIMIT = Math.max(1, Number(process.env.BANAT_GLOBAL_SEND_LIMIT || 2));
const THREAD_COOLDOWN_MS = Math.max(4000, Number(process.env.BANAT_THREAD_COOLDOWN_MS || 15000)); // Pinalawig para iwas-spam flag
const RETRY_DELAYS = [3000, 7000, 15000]; // Mas ligtas na backoff intervals

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
let loginGen = 0;
let sessionOverride = null;
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
let manualStop = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let nextRetryAt = null;
let loginTimer = null;
let probeFailures = 0;
let lastProbeAt = null;
let lastProbeOk = null;
let offlineSince = Date.now();

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

// Human-like jitter para hindi halatang bot ang timing ng request
function getRandomJitter(min = 800, max = 2500) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseMaybeJson(text) {
  const trimmed = String(text).trim();
  try { return JSON.parse(trimmed); } catch (_) { return trimmed; }
}

function readSession() {
  if (sessionOverride) return parseMaybeJson(sessionOverride);
  const candidates = [
    process.env.CELESTIAL_SESSION_FILE,
    path.join(process.cwd(), "appstate.json"),
    path.join(process.cwd(), "cookies.json")
  ].filter(Boolean);
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) return parseMaybeJson(fs.readFileSync(filePath, "utf8"));
  }
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;
  if (raw) return parseMaybeJson(raw);
  throw new Error("No Facebook session found. Paste a cookie in the CELESTIAL dashboard.");
}

function normalizeSession(value) {
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
    throw new Error("Facebook session must be a cookie string or a JSON array of cookie/appState entries.");
  }

  const parts = entries
    .map(cookie => {
      const key = cookie?.key ?? cookie?.name;
      const val = cookie?.value;
      if (key == null || val == null) return null;
      return String(key).trim() + "=" + String(val);
    })
    .filter(Boolean);

  if (!parts.length) throw new Error("Facebook session contains no valid cookie entries.");
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
  while (globalActive >= GLOBAL_SEND_LIMIT) await sleep(200);
  globalActive++;
}

function releaseGlobalSlot() { globalActive = Math.max(0, globalActive - 1); }

function is1545012(error) {
  const text = JSON.stringify(error || "");
  return /1545012|temporarily unavailable|message could not be sent|spam|rate limit/i.test(text);
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
    if (sinceLast < THREAD_COOLDOWN_MS) {
      await sleep(THREAD_COOLDOWN_MS - sinceLast + getRandomJitter(300, 1200));
    } else {
      // Magdagdag ng maliit na random delay kahit walang active cooldown para magmukhang tao
      await sleep(getRandomJitter(400, 900));
    }

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
          // Mas mahabang exponential backoff kapag na-flag ng Meta
          const backoff = RETRY_DELAYS[attempt] + getRandomJitter(1000, 3000);
          threadCooldown.set(key, Date.now() + Math.min(30000, backoff));
          await sleep(backoff);
          threadCooldown.delete(key);
        }
      }
      if (is1545012(lastErr)) threadCooldown.set(key, Date.now() + 10 * 60 * 1000); // 10 mins penalty block kung spam detected
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
  setTimeout(() => {
    commandSendMessage(api, message, threadID, event.messageID || null)
      .then(() => { stats.sent++; console.log(`[BANAT] command reply sent: ${message}`); })
      .catch(error => { noteError("command reply", error); console.error("[BANAT] command reply failed:", error?.message || error); });
  }, getRandomJitter(300, 700));
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const parts = String(body).trim().split(/\s+/);
  const sub = (parts[1] || "status").toLowerCase();

  if (sub === "on" || sub === "enable" || sub === "start") {
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
    sendCommandReply(api, event, "banat is on. say whatever u want 😭");
    return true;
  }

  if (sub === "off" || sub === "disable" || sub === "stop") {
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    autoreply.forgetThread(threadID);
    sendCommandReply(api, event, "banat off. peace 😭");
    return true;
  }

  if (sub === "toggle") {
    const next = !isBanatConversationModeActive(threadID);
    setBanatConversationMode(threadID, next, event.senderID);
    if (next) activeThreads.add(threadID);
    else { activeThreads.delete(threadID); autoreply.forgetThread(threadID); }
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
  if (on) {
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
  } else {
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    autoreply.forgetThread(threadID);
  }

  if (!event.messageID || typeof api.setMessageReaction !== "function") return;

  const now = Date.now();
  if (now - Number(dotLast.get(threadID) || 0) < 4000) return; // Ligtas na throttle para sa reactions
  dotLast.set(threadID, now);

  const emoji = on ? "❤" : "💤";
  (async () => {
    await sleep(getRandomJitter(200, 500));
    try { await reactMessage(api, emoji, event.messageID, !on); }
    catch (_) { await reactMessage(api, emoji, event.messageID, on); }
  })()
    .then(() => { stats.sent++; pushEvent("reaction", `thread ${threadID}: ${emoji}`); })
    .catch(error => { noteError("dot reaction", error); });
}

function onMessage(api, event) {
  if (!event) return;
  if (event.type && event.type !== "message") return;
  if (botPaused) return;
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;

  if (store.list().length && store.getSettings().admin_only && !store.rankOf(event.senderID)) return;

  stats.received++;
  lastMessageAt = new Date().toISOString();
  pushEvent("message", `thread ${event.threadID} · ${event.senderID || "?"}: ${body.slice(0, 60)}`);

  if (body === "." || body === "..") { stats.commands++; handleDot(api, event, body === "."); return; }
  if (isBanatCommand(body)) { stats.commands++; handleBanatCommand(api, event, body); return; }

  const threadID = String(event.threadID);
  const senderID = String(event.senderID || "");

  const active = autoreply.isOn() || activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
  const target = classifyBanatTarget({ event, body, botID: botUserID });
  if (!active && !target.shouldRespond) return;

  if (autoreply.check({ senderID, threadID, body, isAdmin: Boolean(store.rankOf(senderID)) })) return;

  const reply = autoreply.pickReply(body, threadID, getTriggerReply, getBanatConversationReply);
  if (!reply) return;

  // Anti-detection: random slight delay bago i-execute ang auto reply process
  setTimeout(() => {
    sendBanat(api, event, reply).catch(error => console.error("[BANAT] reply error:", error));
  }, getRandomJitter(300, 1000));
}

function start(api, gen) {
  currentApi = api;
  offlineSince = null;
  probeFailures = 0;
  messengerConnected = true;
  loginError = null;
  lastConnectedAt = new Date().toISOString();
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}

  const stop = api.listenMqtt((error, event) => {
    if (gen !== loginGen) return;
    if (error) {
      noteError("listener", error);
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
    }
  });

  stopListener = typeof stop === "function"
    ? stop
    : (typeof api.stopListening === "function" ? () => api.stopListening() : null);

  for (const t of autoreply.listThreads()) {
    activeThreads.add(t.id);
    try { setBanatConversationMode(t.id, true, "dashboard"); } catch (_) {}
  }

  console.log(`[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`);
}

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

function scheduleReconnect(reason) {
  if (manualStop || reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECTS) {
    pushEvent("watchdog", `Gave up after ${MAX_RECONNECTS} tries. Will retry in 30 min.`);
    return;
  }
  const delay = Math.min(300000, 8000 * 2 ** reconnectAttempts); // Mas mahabang interval para iwas spam lock sa login
  reconnectAttempts++;
  nextRetryAt = new Date(Date.now() + delay).toISOString();
  pushEvent("watchdog", `${reason} -> reconnect #${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
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
    return;
  }

  loginInProgress = true;
  loginError = null;

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
      if (gen !== loginGen) return;
      clearTimeout(loginTimer);
      loginInProgress = false;
      if (error) {
        messengerConnected = false;
        loginError = String(error?.message || error);
        noteError("login", error);
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

function probe() {
  if (!messengerConnected || !currentApi || manualStop) return;
  const api = currentApi;
  const gen = loginGen;
  if (typeof api.getUserInfo !== "function" || !botUserID) return;

  let done = false;
  let timer = null;
  const finish = (err) => {
    if (done) return;
    
