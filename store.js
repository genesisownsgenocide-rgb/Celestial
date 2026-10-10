"use strict";

// Persistent store: admins (owner / moderator), settings, bot profile,
// and two hashed passwords (dashboard key + owner panel password).
// Saved next to the cookie: Railway Volume if attached, otherwise the project folder.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = process.env.CELESTIAL_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const FILE = process.env.CELESTIAL_DATA_FILE || path.join(DIR, "celestial-data.json");
const RANKS = ["owner", "moderator"];
const MIN_KEY_LEN = 10;

let data = {
  admins: [],
  settings: { admin_only: true },
  profile: { name: "", bio: "" },
  auth: null,   // dashboard key (hashed)
  owner: null   // owner panel password (hashed)
};

const validRec = (r) => r && typeof r.salt === "string" && typeof r.hash === "string" ? { salt: r.salt, hash: r.hash } : null;

try {
  const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (Array.isArray(j.admins)) data.admins = j.admins.filter((a) => a && /^\d{5,20}$/.test(String(a.id)) && RANKS.includes(a.rank));
  data.settings = Object.assign({ admin_only: true }, j.settings || {});
  data.profile = Object.assign({ name: "", bio: "" }, j.profile || {});
  data.auth = validRec(j.auth);
  data.owner = validRec(j.owner);
} catch (_) {}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const fail = (m) => Object.assign(new Error(m), { status: 400 });

// ---------- password helpers (salted scrypt, never plain text) ----------
function makeRec(key) {
  key = String(key || "");
  if (key.length < MIN_KEY_LEN) throw fail("Password must be at least " + MIN_KEY_LEN + " characters");
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(key, salt, 32).toString("hex") };
}
function checkRec(rec, key) {
  if (!rec || !key) return false;
  const a = Buffer.from(crypto.scryptSync(String(key), rec.salt, 32).toString("hex"));
  const b = Buffer.from(rec.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// dashboard key
function hasKey() { return Boolean(data.auth); }
function setKey(key) { data.auth = makeRec(key); save(); return true; }
function verifyKey(key) { return checkRec(data.auth, key); }

// owner panel password
function hasOwnerKey() { return Boolean(data.owner); }
function setOwnerKey(key) { data.owner = makeRec(key); save(); return true; }
function verifyOwnerKey(key) { return checkRec(data.owner, key); }

// ---------- admins ----------
function rankOf(id) {
  const a = data.admins.find((x) => x.id === String(id));
  return a ? a.rank : null;
}
function get(id) { return data.admins.find((x) => x.id === String(id)) || null; }
function list() { return data.admins.map((a) => ({ ...a })); }

function add(id, rank, name) {
  id = String(id || "").trim();
  if (!/^\d{5,20}$/.test(id)) throw fail("Invalid Facebook ID (numbers only)");
  if (!RANKS.includes(rank)) throw fail("Rank must be owner or moderator");
  name = String(name || "").trim().slice(0, 40);
  const ex = get(id);
  if (ex) {
    ex.rank = rank;
    if (name) ex.name = name;
  } else {
    data.admins.push({ id, rank, name, added_at: new Date().toISOString() });
  }
  save();
  return get(id);
}

function remove(id) {
  const before = data.admins.length;
  data.admins = data.admins.filter((a) => a.id !== String(id));
  if (data.admins.length === before) return false;
  save();
  return true;
}

// ---------- settings / profile ----------
function getSettings() { return { ...data.settings }; }
function setSettings(patch) { Object.assign(data.settings, patch); save(); return getSettings(); }
function getProfile() { return { ...data.profile }; }
function setProfile(p) {
  data.profile = { name: String(p.name || "").trim().slice(0, 40), bio: String(p.bio || "").trim().slice(0, 101) };
  save();
  return getProfile();
}

module.exports = {
  rankOf, get, list, add, remove,
  getSettings, setSettings, getProfile, setProfile,
  hasKey, setKey, verifyKey,
  hasOwnerKey, setOwnerKey, verifyOwnerKey,
  RANKS
};
