"use strict";

// Persistent store for admins (owner / moderator), settings and bot profile.
// Saved next to the cookie: Railway Volume if attached, otherwise the project folder.

const fs = require("fs");
const path = require("path");

const DIR = process.env.CELESTIAL_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const FILE = process.env.CELESTIAL_DATA_FILE || path.join(DIR, "celestial-data.json");
const RANKS = ["owner", "moderator"];

let data = { admins: [], settings: { admin_only: true }, profile: { name: "", bio: "" } };

try {
  const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (Array.isArray(j.admins)) data.admins = j.admins.filter((a) => a && /^\d{5,20}$/.test(String(a.id)) && RANKS.includes(a.rank));
  data.settings = Object.assign({ admin_only: true }, j.settings || {});
  data.profile = Object.assign({ name: "", bio: "" }, j.profile || {});
} catch (_) {}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const fail = (m) => Object.assign(new Error(m), { status: 400 });

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

function getSettings() { return { ...data.settings }; }
function setSettings(patch) { Object.assign(data.settings, patch); save(); return getSettings(); }
function getProfile() { return { ...data.profile }; }
function setProfile(p) {
  data.profile = { name: String(p.name || "").trim().slice(0, 40), bio: String(p.bio || "").trim().slice(0, 101) };
  save();
  return getProfile();
}

module.exports = { rankOf, get, list, add, remove, getSettings, setSettings, getProfile, setProfile, RANKS };
