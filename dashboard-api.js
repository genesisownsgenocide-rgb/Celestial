"use strict";

// CELESTIAL — Messenger control dashboard + API (single file, same-origin)
//   /        -> main dashboard (login with the dashboard key)
//   /owner   -> OWNER-ONLY panel (separate owner password): admins, admin-only, bot profile/bio
// No environment variables needed. Both passwords are created in the browser and stored hashed.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");
const autoreply = require("./autoreply");

const CSS = `
:root{--bg:#07060f;--card:#0e0c1c;--line:#26214a;--tx:#ece9ff;--mut:#8b86b8;--ac:#8b7bff;--ac2:#4fd1ff;--ok:#38e0a0;--bad:#ff5a7a}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:var(--tx);min-height:100vh;
background:radial-gradient(900px 500px at 80% -10%,#2a1f6b55,transparent),radial-gradient(700px 400px at -10% 30%,#0b4a6b44,transparent),var(--bg)}
header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
.logo{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;font-size:22px;background:linear-gradient(135deg,var(--ac),var(--ac2))}
h1{font-size:17px;letter-spacing:.3em;margin:0}small{color:var(--mut);letter-spacing:.2em;font-size:10px}
main{padding:14px;max-width:720px;margin:auto;display:grid;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.k{font-size:10px;letter-spacing:.18em;color:var(--mut);text-transform:uppercase}
.v{font-size:18px;font-weight:700;margin-top:4px;word-break:break-word}
.ok{color:var(--ok)}.bad{color:var(--bad)}
.pill{display:inline-block;padding:5px 12px;border-radius:99px;font-size:13px;font-weight:600}
.pill.ok{background:#38e0a022}.pill.bad{background:#ff5a7a22}
h2{margin:0 0 10px;font-size:15px}
textarea,input,select{width:100%;background:#09081a;border:1px solid var(--line);color:var(--tx);border-radius:12px;padding:12px;font:13px monospace}
textarea{min-height:110px}
input[type=checkbox]{width:auto}
button{border:0;border-radius:12px;padding:12px 14px;font-weight:700;color:#fff;background:linear-gradient(135deg,var(--ac),#5a4bd8);cursor:pointer}
button.g{background:#1a1735;border:1px solid var(--line)}button.r{background:#a8233f}button.s{background:#16825a}
button.x{padding:6px 10px;flex:none;min-width:0}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.row button{flex:1;min-width:110px}
.ev{font:12px monospace;padding:7px 0;border-bottom:1px solid var(--line);color:var(--mut)}.ev b{color:var(--tx)}
.kv{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.kv span:first-child{color:var(--mut)}.kv span:last-child{text-align:right;word-break:break-all}
.mt{margin-top:8px}
.cnt{color:var(--mut);font-size:11px;text-align:right;margin-top:4px}
.note{color:var(--mut);font-size:12px;margin:0 0 8px}
#err{display:none;background:#ff5a7a1c;border:1px solid #ff5a7a66;color:#ffb3c1;border-radius:12px;padding:10px;font-size:13px}
#login,#setup{display:none}
`;

// =====================================================================
// MAIN DASHBOARD PAGE  ( / )
// =====================================================================
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CELESTIAL</title>
<style>${CSS}</style></head><body>
<header><div class="logo">✦</div><div><h1>CELESTIAL</h1><small>MESSENGER CONTROL</small></div></header>
<main>
<div id="err"></div>
<div class="card" id="login"><h2>Dashboard key</h2>
<input id="key" type="password" placeholder="Enter dashboard key" autocomplete="off">
<div class="row"><button onclick="saveKey()">Unlock</button></div></div>

<div class="card" id="setup"><h2>First-time setup</h2>
<p class="note">Gumawa ng dashboard key (min 10 characters). Ito ang gagamitin mo para mag-login.</p>
<input id="nk" type="password" placeholder="New key" autocomplete="new-password">
<input id="nk2" class="mt" type="password" placeholder="Repeat key" autocomplete="new-password">
<div class="row"><button onclick="setupKey()">Create key</button></div></div>

<div id="app" style="display:none;gap:12px;grid-template-columns:1fr">
<div class="card"><div class="k">Control room</div>
<div style="margin-top:8px"><span id="conn" class="pill bad">Disconnected</span></div></div>
<div class="grid">
<div class="card"><div class="k">Messenger</div><div class="v" id="m">—</div></div>
<div class="card"><div class="k">Bot</div><div class="v" id="b">—</div></div>
<div class="card"><div class="k">Server uptime</div><div class="v" id="u">—</div></div>
<div class="card"><div class="k">Bot uptime</div><div class="v" id="cu">—</div></div>
<div class="card"><div class="k">Last connected</div><div class="v" id="lc" style="font-size:14px">Never</div></div>
<div class="card"><div class="k">Last disconnected</div><div class="v" id="ld" style="font-size:14px">Never</div></div>
</div>

<div class="card"><h2>Auto reply · all chats</h2>
<div class="v" id="autoState">—</div>
<div class="cnt" id="autoStats" style="text-align:left;margin-top:8px"></div>
<div class="row"><button id="autoBtn" class="s">Turn ON</button></div></div>

<div class="card"><h2>Group chats</h2>
<p class="note">Pili ng GC. Pag-Start, magse-send ang bot ng message sa baba, tapos mag-aauto reply (humanized, may random skip) sa mga mag-chat doon.</p>
<input id="gmsg" value="sige tumakbo ka na HAHAHAHAHA" maxlength="200">
<div class="row"><button class="g" onclick="loadGroups(true)">Refresh list</button></div>
<div id="glist" style="margin-top:8px"><div class="ev">Connect the bot first.</div></div></div>

<div class="card"><h2>Controls</h2>
<div class="row"><button class="s" onclick="act('bot/start')">▶ Start</button>
<button class="r" onclick="act('bot/stop')">■ Stop</button></div>
<div class="row"><button class="g" onclick="act('reconnect')">Reconnect</button>
<button class="g" onclick="act('disconnect')">Disconnect</button></div></div>

<div class="card"><h2>Facebook session</h2>
<div class="kv"><span>Account</span><span id="acc">Not linked</span></div>
<div class="kv"><span>Cookie saved</span><span id="saved">No</span></div>
<div class="kv"><span>Saved at</span><span id="savedAt">—</span></div>
<textarea id="cookie" class="mt" placeholder="Paste cookie / appstate here (JSON array or c_user=...; xs=...)" spellcheck="false"></textarea>
<div class="row"><button onclick="sendCookie()">Save &amp; connect</button></div></div>

<div class="card"><h2>All status data</h2><div id="all"></div></div>
<div class="card"><h2>Activity</h2><div id="ev"><div class="ev">No activity yet.</div></div></div>
<div class="row"><button class="g" onclick="location.href='/owner'">🔒 Owner panel</button>
<button class="g" onclick="localStorage.removeItem('cel_key');location.reload()">Lock dashboard</button></div>
</div></main>
<script>
var KEY=localStorage.getItem('cel_key')||'';
function $(i){return document.getElementById(i)}
function showErr(t){var e=$('err');e.textContent=t||'';e.style.display=t?'block':'none'}
function saveKey(){KEY=$('key').value.trim();localStorage.setItem('cel_key',KEY);start()}
function setupKey(){var a=$('nk').value,b=$('nk2').value;
if(a.length<10)return showErr('Key must be at least 10 characters.');
if(a!==b)return showErr('Keys do not match.');
fetch('/api/dashboard/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:a})})
.then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'Setup failed');return j})})
.then(function(){KEY=a;localStorage.setItem('cel_key',KEY);$('nk').value='';$('nk2').value='';showErr('');start()})
.catch(function(e){showErr(e.message)})}
function api(p,o){o=o||{};o.headers=Object.assign({'x-eclipse-dashboard-key':KEY,'Content-Type':'application/json'},o.headers||{});
return fetch('/api/dashboard/'+p,o).then(function(r){return r.json().then(function(j){if(r.status===401){localStorage.removeItem('cel_key');KEY='';throw new Error('Wrong dashboard key')}if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j})})}
function fmt(s){s=+s||0;var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m '+(s%60)+'s'}
function flat(o,p,out){out=out||[];for(var k in o){var v=o[k],n=p?p+'.'+k:k;if(v&&typeof v==='object'&&!Array.isArray(v))flat(v,n,out);else out.push([n,Array.isArray(v)?JSON.stringify(v):String(v)])}return out}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function act(p){api(p,{method:'POST',body:'{}'}).then(function(){showErr('');refresh()}).catch(function(e){showErr(e.message)})}
function setAuto(on){api('autoreply',{method:'POST',body:JSON.stringify({on:on})}).then(function(){showErr('');refresh()}).catch(function(e){showErr(e.message)})}
function sendCookie(){var c=$('cookie').value.trim();if(!c)return showErr('Paste a cookie first.');
api('connect-session',{method:'POST',body:JSON.stringify({cookie:c})}).then(function(){$('cookie').value='';showErr('');refresh()}).catch(function(e){showErr(e.message)})}
var GLOADED=false;
function renderGroups(g){$('glist').innerHTML=g.length?g.map(function(x){return '<div class="kv"><span style="color:var(--tx)">'+esc(x.name)+'<br><small style="letter-spacing:0;font-size:11px">'+x.members+' members</small></span><button class="'+(x.active?'r':'s')+' x" data-id="'+esc(x.id)+'" data-name="'+esc(x.name)+'" data-active="'+(x.active?1:0)+'" onclick="toggleGroup(this)">'+(x.active?'Stop':'Start')+'</button></div>'}).join(''):'<div class="ev">Walang group chat na nahanap.</div>'}
function loadGroups(force){$('glist').innerHTML='<div class="ev">Loading...</div>';api('groups'+(force?'?refresh=1':'')).then(function(r){showErr('');renderGroups(r.groups||[])}).catch(function(e){$('glist').innerHTML='<div class="ev">'+esc(e.message)+'</div>'})}
function toggleGroup(b){var on=b.dataset.active==='1';
if(!on&&!confirm('Mag-send ng message sa "'+b.dataset.name+'" at mag-auto reply doon?'))return;
b.disabled=true;
api('groups/'+(on?'stop':'start'),{method:'POST',body:JSON.stringify({id:b.dataset.id,name:b.dataset.name,message:$('gmsg').value})}).then(function(){showErr('');loadGroups(false);refresh()}).catch(function(e){b.disabled=false;showErr(e.message)})}
function refresh(){
Promise.all([api('status'),api('health').catch(function(){return {}}),api('session').catch(function(){return {}}),api('events').catch(function(){return {events:[]}})]).then(function(r){
var s=r[0],h=(r[1].runtime||{}),ss=r[2].session||{},ev=r[3].events||[];
$('login').style.display='none';$('setup').style.display='none';$('app').style.display='grid';showErr('');
var on=!!s.facebook_connected;
if(on&&!GLOADED){GLOADED=true;loadGroups(false)}if(!on){GLOADED=false}
var ar=!!s.auto_reply;
$('autoState').textContent=!ar?'OFF':(on?'ON · bot is chatting':'ON · waiting for the bot to log in');
$('autoState').className='v '+(ar&&on?'ok':(ar?'':'bad'));
$('autoBtn').textContent=ar?'Turn OFF':'Turn ON';$('autoBtn').className=ar?'r':'s';$('autoBtn').onclick=function(){setAuto(!ar)};
$('autoStats').textContent='Who: '+(s.admin_only&&s.admin_count?'admins only':'everyone')+' · Replies this hour: '+(s.replies_last_hour||0)+' · Blocked by anti-spam: '+(s.replies_suppressed||0);
$('conn').textContent=on?'Connected':'Disconnected';$('conn').className='pill '+(on?'ok':'bad');
$('m').textContent=on?'ONLINE':'OFFLINE';$('m').className='v '+(on?'ok':'bad');
var run=s.bot_running!==undefined?s.bot_running:(s.paused!==undefined?!s.paused:on);
$('b').textContent=run?'RUNNING':'PAUSED';$('b').className='v '+(run?'ok':'bad');
$('u').textContent=fmt(h.uptime_seconds!==undefined?h.uptime_seconds:s.uptime_seconds);
$('cu').textContent=on&&s.bot_uptime_seconds!==undefined?fmt(s.bot_uptime_seconds):'0s';$('cu').className='v '+(on?'ok':'bad');
function dt(x){return x?new Date(x).toLocaleString():'Never'}
$('lc').textContent=dt(s.last_connected);$('ld').textContent=dt(s.last_disconnected);
$('acc').textContent=ss.account||s.account||'Not linked';
$('saved').textContent=ss.saved?'Yes':'No';$('saved').className=ss.saved?'ok':'bad';
$('savedAt').textContent=ss.saved_at?new Date(ss.saved_at).toLocaleString():'—';
var rows=flat(s).concat(flat({node:h.node_version,pid:h.pid,database:h.database,memory_mb:h.memory?Math.round(h.memory.rss/1048576):null},'runtime'));
$('all').innerHTML=rows.map(function(x){return '<div class="kv"><span>'+esc(x[0])+'</span><span>'+esc(x[1])+'</span></div>'}).join('');
$('ev').innerHTML=ev.length?ev.map(function(e){return '<div class="ev"><b>'+esc(e.type)+'</b> '+esc(e.message)+'<br>'+new Date(e.at).toLocaleTimeString()+'</div>'}).join(''):'<div class="ev">No activity yet.</div>';
}).catch(function(e){if(!KEY){$('app').style.display='none';$('login').style.display='block'}showErr(e.message)})}
function start(){
fetch('/api/dashboard/auth-state').then(function(r){return r.json()}).then(function(a){
if(!a.configured){$('app').style.display='none';$('login').style.display='none';$('setup').style.display='block';return}
$('setup').style.display='none';
if(!KEY){$('app').style.display='none';$('login').style.display='block';return}
refresh()
}).catch(function(e){showErr(e.message)})}
start();setInterval(function(){if(KEY)refresh()},5000);
</script></body></html>`;

// =====================================================================
// OWNER-ONLY PANEL PAGE  ( /owner )
// =====================================================================
const OWNER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CELESTIAL · Owner</title>
<style>${CSS}</style></head><body>
<header><div class="logo">✦</div><div><h1>CELESTIAL</h1><small>OWNER PANEL</small></div></header>
<main>
<div id="err"></div>

<div class="card" id="setup"><h2>Create owner password</h2>
<p class="note">First-time setup. Kailangan munang naka-login ka sa main dashboard (/) sa browser na ito. Min 10 characters.</p>
<input id="sk" type="password" placeholder="Owner password" autocomplete="new-password">
<input id="sk2" class="mt" type="password" placeholder="Repeat owner password" autocomplete="new-password">
<div class="row"><button onclick="setupOwner()">Create owner password</button><button class="g" onclick="location.href='/'">← Dashboard</button></div></div>

<div class="card" id="login"><h2>Owner password</h2>
<input id="ok" type="password" placeholder="Enter owner password" autocomplete="off">
<div class="row"><button onclick="unlock()">Unlock</button><button class="g" onclick="location.href='/'">← Dashboard</button></div></div>

<div id="panel" style="display:none;gap:12px;grid-template-columns:1fr">

<div class="card"><h2>Admin panel</h2>
<p class="note">Admins lang ang makakagamit ng bot kapag naka-on ang "Admin only".</p>
<div class="grid" style="margin-bottom:12px">
<div><div class="k">Owners</div><div class="v ok" id="nOwn">0</div></div>
<div><div class="k">Moderators</div><div class="v" id="nMod">0</div></div></div>
<div class="k">Owners</div><div id="admOwn"><div class="ev">Loading...</div></div>
<div class="k mt">Moderators</div><div id="admMod"><div class="ev">Loading...</div></div>
<div class="k" style="margin-top:14px">Add / update</div>
<input id="aid" class="mt" placeholder="Facebook ID (numbers only)" inputmode="numeric" autocomplete="off">
<input id="an" class="mt" maxlength="40" placeholder="Name (optional)" autocomplete="off">
<select id="ar" class="mt"><option value="moderator">moderator</option><option value="owner">owner</option></select>
<div class="row"><button onclick="addAdm()">Save admin</button><button class="g" onclick="clearAdm()">Clear</button></div></div>

<div class="card"><h2>Bot access</h2>
<div class="kv"><span>Admin only (admins lang ang makakagamit ng bot)</span><span><input id="ao" type="checkbox" onchange="saveSet()"></span></div>
<div class="cnt" style="text-align:left">Hindi ito umiiral hangga't wala pang naka-add na admin, para hindi ka ma-lock out.</div></div>

<div class="card"><h2>Bot Facebook profile</h2>
<input id="pn" maxlength="40" placeholder="Display name (label lang sa bot)" autocomplete="off">
<div class="cnt"><span id="pnc">0</span>/40</div>
<input id="pb" class="mt" maxlength="101" placeholder="Bio (max 101)" autocomplete="off">
<div class="cnt"><span id="pbc">0</span>/101</div>
<div class="row"><button class="g" onclick="saveProf(false)">Save only</button>
<button onclick="saveProf(true)">Save &amp; apply to Facebook</button></div>
<div class="cnt" style="text-align:left">Ang bio lang ang nilalagay sa mismong Facebook account ng bot. Kailangan nakakonekta ang bot.</div></div>

<div class="card"><h2>Security</h2>
<div class="k">Owner password</div>
<input id="op" class="mt" type="password" placeholder="New owner password (min 10)" autocomplete="new-password">
<input id="op2" class="mt" type="password" placeholder="Repeat" autocomplete="new-password">
<div class="row"><button onclick="changeOwnerKey()">Change owner password</button></div>
<div class="k" style="margin-top:14px">Main dashboard key</div>
<input id="dk" class="mt" type="password" placeholder="New dashboard key (min 10)" autocomplete="new-password">
<input id="dk2" class="mt" type="password" placeholder="Repeat" autocomplete="new-password">
<div class="row"><button onclick="changeDashKey()">Change dashboard key</button></div></div>

<div class="row"><button class="g" onclick="location.href='/'">← Dashboard</button>
<button class="g" onclick="sessionStorage.removeItem('cel_owner');location.reload()">Lock owner panel</button></div>
</div></main>
<script>
var OKEY=sessionStorage.getItem('cel_owner')||'';
function $(i){return document.getElementById(i)}
function showErr(t){var e=$('err');e.textContent=t||'';e.style.display=t?'block':'none'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function show(w){['setup','login','panel'].forEach(function(k){$(k).style.display=(k===w)?(k==='panel'?'grid':'block'):'none'})}
function oapi(p,o){o=o||{};o.headers=Object.assign({'x-owner-key':OKEY,'Content-Type':'application/json'},o.headers||{});
return fetch('/api/owner/'+p,o).then(function(r){return r.json().then(function(j){
if(r.status===401){sessionStorage.removeItem('cel_owner');OKEY='';show('login');throw new Error('Wrong owner password')}
if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j})})}

function unlock(){OKEY=$('ok').value.trim();sessionStorage.setItem('cel_owner',OKEY);$('ok').value='';start()}
function setupOwner(){var a=$('sk').value,b=$('sk2').value,dk=localStorage.getItem('cel_key')||'';
if(!dk)return showErr('Mag-login muna sa main dashboard (/) bago gumawa ng owner password.');
if(a.length<10)return showErr('Password must be at least 10 characters.');
if(a!==b)return showErr('Passwords do not match.');
fetch('/api/owner/setup',{method:'POST',headers:{'Content-Type':'application/json','x-eclipse-dashboard-key':dk},body:JSON.stringify({key:a})})
.then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'Setup failed');return j})})
.then(function(){OKEY=a;sessionStorage.setItem('cel_owner',a);$('sk').value='';$('sk2').value='';showErr('');start()})
.catch(function(e){showErr(e.message)})}

function admRow(a){return '<div class="kv"><span style="color:var(--tx)">'+esc(a.name||'-')+'<br><small style="letter-spacing:0;font-size:11px">'+esc(a.id)+'</small></span>'+
'<div style="display:flex;gap:6px"><button class="g x" data-id="'+esc(a.id)+'" data-name="'+esc(a.name||'')+'" data-rank="'+esc(a.rank)+'" onclick="editAdm(this)">Edit</button>'+
'<button class="r x" data-id="'+esc(a.id)+'" onclick="rmAdm(this.dataset.id)">✕</button></div></div>'}
function loadAdm(){oapi('admins').then(function(r){
var o=r.admins.filter(function(a){return a.rank==='owner'}),m=r.admins.filter(function(a){return a.rank==='moderator'});
$('nOwn').textContent=o.length;$('nMod').textContent=m.length;
$('admOwn').innerHTML=o.length?o.map(admRow).join(''):'<div class="ev">Wala pang owner.</div>';
$('admMod').innerHTML=m.length?m.map(admRow).join(''):'<div class="ev">Wala pang moderator.</div>'}).catch(function(e){showErr(e.message)})}
function editAdm(b){$('aid').value=b.dataset.id;$('an').value=b.dataset.name;$('ar').value=b.dataset.rank;$('aid').scrollIntoView({behavior:'smooth',block:'center'})}
function clearAdm(){$('aid').value='';$('an').value='';$('ar').value='moderator'}
function addAdm(){oapi('admins',{method:'POST',body:JSON.stringify({id:$('aid').value.trim(),name:$('an').value,rank:$('ar').value})}).then(function(){clearAdm();showErr('');loadAdm()}).catch(function(e){showErr(e.message)})}
function rmAdm(id){if(!confirm('Remove '+id+'?'))return;oapi('admins/remove',{method:'POST',body:JSON.stringify({id:id})}).then(function(){showErr('');loadAdm()}).catch(function(e){showErr(e.message)})}

function loadSet(){oapi('settings').then(function(r){$('ao').checked=!!r.settings.admin_only}).catch(function(e){showErr(e.message)})}
function saveSet(){oapi('settings',{method:'POST',body:JSON.stringify({admin_only:$('ao').checked})}).then(function(){showErr('')}).catch(function(e){showErr(e.message);loadSet()})}

function cnt(){$('pnc').textContent=$('pn').value.length;$('pbc').textContent=$('pb').value.length}
function loadProf(){oapi('profile').then(function(r){$('pn').value=r.profile.name;$('pb').value=r.profile.bio;cnt()}).catch(function(e){showErr(e.message)})}
function saveProf(apply){oapi('profile',{method:'POST',body:JSON.stringify({name:$('pn').value,bio:$('pb').value})})
.then(function(){return apply?oapi('profile/apply',{method:'POST',body:'{}'}).then(function(){alert('Bio applied to Facebook.')}):null})
.then(function(){showErr('')}).catch(function(e){showErr(e.message)})}

function changeOwnerKey(){var a=$('op').value,b=$('op2').value;
if(a.length<10)return showErr('Password must be at least 10 characters.');
if(a!==b)return showErr('Passwords do not match.');
oapi('change-owner-key',{method:'POST',body:JSON.stringify({new_key:a})})
.then(function(){OKEY=a;sessionStorage.setItem('cel_owner',a);$('op').value='';$('op2').value='';showErr('');alert('Owner password changed.')}).catch(function(e){showErr(e.message)})}
function changeDashKey(){var a=$('dk').value,b=$('dk2').value;
if(a.length<10)return showErr('Key must be at least 10 characters.');
if(a!==b)return showErr('Keys do not match.');
oapi('change-dashboard-key',{method:'POST',body:JSON.stringify({new_key:a})})
.then(function(){localStorage.setItem('cel_key',a);$('dk').value='';$('dk2').value='';showErr('');alert('Dashboard key changed.')}).catch(function(e){showErr(e.message)})}

function loadAll(){loadAdm();loadSet();loadProf()}
$('pn').addEventListener('input',cnt);$('pb').addEventListener('input',cnt);
// loadAll() runs once on unlock, not on a timer, so it never overwrites what you are typing.
function start(){
fetch('/api/owner/state').then(function(r){return r.json()}).then(function(s){
if(!s.configured){show('setup');return}
if(!OKEY){show('login');return}
show('panel');loadAll()
}).catch(function(e){showErr(e.message)})}
start();
</script></body></html>`;

module.exports = function startDashboardApi(port, getStatus, controls = {}) {
  // Dashboard key is created in the browser and stored hashed (store.js).
  // An env var is only an optional emergency override for the MAIN dashboard key.
  const envKey = String(process.env.CELESTIAL_DASHBOARD_API_KEY || process.env.ECLIPSE_DASHBOARD_API_KEY || "").trim();
  const configured = () => store.hasKey() || Boolean(envKey);
  const origin = String(process.env.ECLIPSE_DASHBOARD_ORIGIN || "*");
  const SESSION_FILE = process.env.CELESTIAL_SESSION_FILE || path.join(process.cwd(), "appstate.json");
  const events = [];
  const session = { saved: false, account: null, saved_at: null };

  const log = (type, message) => {
    events.unshift({ type, message, at: new Date().toISOString() });
    if (events.length > 200) events.length = 200;
  };

  // Track Messenger connection uptime by watching getStatus().facebook_connected
  const conn = { since: null, last_connected: null, last_disconnected: null, was: false };
  setInterval(() => {
    let on = false;
    try { on = Boolean(getStatus().facebook_connected); } catch (_) {}
    if (on && !conn.was) {
      conn.since = Date.now();
      conn.last_connected = new Date().toISOString();
      log("connection", "Messenger connected");
    } else if (!on && conn.was) {
      conn.since = null;
      conn.last_disconnected = new Date().toISOString();
      log("connection", "Messenger disconnected");
    }
    conn.was = on;
  }, 2000).unref();

  // Detect an already-saved session on boot (account id only, never the cookie)
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const p = parseCookie(raw);
    if (p) {
      session.saved = true;
      session.account = p.account;
      session.saved_at = fs.statSync(SESSION_FILE).mtime.toISOString();
    }
  } catch (_) {}

  function parseCookie(raw) {
    let pairs = [];
    try {
      const j = JSON.parse(raw);
      const arr = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : null;
      if (arr) pairs = arr.map((c) => [c.key || c.name, c.value]);
    } catch (_) {
      pairs = String(raw).split(";").map((s) => {
        const i = s.indexOf("=");
        return i < 0 ? [] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
      });
    }
    const map = Object.fromEntries(pairs.filter((p) => p[0]));
    if (!map.c_user || !map.xs) return null;
    return { account: "c_user " + map.c_user, id: map.c_user };
  }

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const html = (res, body) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > 200000) { reject(new Error("Body too large")); req.destroy(); }
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const readJson = async (req) => {
    try { return JSON.parse((await readBody(req)) || "{}"); }
    catch (_) { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
  };

  // ---- main dashboard key check ----
  const authorized = (req) => {
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const supplied = String(req.headers["x-eclipse-dashboard-key"] || bearer);
    if (!supplied) return false;
    if (envKey) {
      const a = Buffer.from(supplied);
      const b = Buffer.from(envKey);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return store.verifyKey(supplied);
  };

  // ---- brute-force protection: 5 wrong passwords -> blocked for 60s (per IP, per area) ----
  const fails = new Map();
  const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const isBlocked = (k) => { const f = fails.get(k); return Boolean(f && f.n >= 5 && Date.now() < f.until); };
  const noteFail = (k) => {
    const now = Date.now();
    if (fails.size > 1000) fails.clear();
    const f = fails.get(k);
    if (f && now <= f.until) { f.n++; f.until = now + 60000; }
    else fails.set(k, { n: 1, until: now + 60000 });
  };

  const runtime = () => ({
    watchdog: { ok: true },
    database: null,
    uptime_seconds: Math.floor(process.uptime()),
    node_version: process.version,
    pid: process.pid,
    memory: process.memoryUsage()
  });

  const owners = () => store.list().filter((a) => a.rank === "owner");

  // =====================================================================
  // OWNER API  ( /api/owner/* )  -- protected by the OWNER password only
  // =====================================================================
  const handleOwner = async (req, res, url) => {
    const p = url.pathname;
    const isGet = req.method === "GET";
    const isPost = req.method === "POST";
    const ip = ipOf(req);
    try {
      // public: does an owner password exist yet?
      if (isGet && p === "/api/owner/state") {
        return send(res, 200, { ok: true, configured: store.hasOwnerKey() });
      }

      // first-time owner password: only someone holding the dashboard key can create it
      if (isPost && p === "/api/owner/setup") {
        if (store.hasOwnerKey()) return send(res, 403, { ok: false, error: "Owner password already set" });
        if (!configured()) return send(res, 503, { ok: false, error: "Create the dashboard key first" });
        if (isBlocked("d:" + ip)) return send(res, 429, { ok: false, error: "Too many wrong attempts. Try again in a minute." });
        if (!authorized(req)) { noteFail("d:" + ip); return send(res, 401, { ok: false, error: "Login to the main dashboard first" }); }
        const b = await readJson(req);
        store.setOwnerKey(b.key);
        log("security", "Owner password created");
        return send(res, 200, { ok: true });
      }

      // everything below needs the owner password
      if (!store.hasOwnerKey()) return send(res, 503, { ok: false, error: "Owner password not set yet" });
      if (isBlocked("o:" + ip)) return send(res, 429, { ok: false, error: "Too many wrong attempts. Try again in a minute." });
      if (!store.verifyOwnerKey(String(req.headers["x-owner-key"] || ""))) {
        noteFail("o:" + ip);
        return send(res, 401, { ok: false, error: "Owner authorization required" });
      }
      fails.delete("o:" + ip);

      // ----- admins -----
      if (isGet && p === "/api/owner/admins") return send(res, 200, { ok: true, admins: store.list() });
      if (isPost && p === "/api/owner/admins") {
        const b = await readJson(req);
        const id = String(b.id || "").trim();
        const cur = store.get(id);
        if (cur && cur.rank === "owner" && b.rank !== "owner" && owners().length <= 1) {
          return send(res, 400, { ok: false, error: "Hindi puwedeng i-demote ang huling owner" });
        }
        const admin = store.add(id, b.rank, b.name);
        log("admin", `Set ${admin.id} as ${admin.rank}`);
        return send(res, 200, { ok: true, admin });
      }
      if (isPost && p === "/api/owner/admins/remove") {
        const b = await readJson(req);
        const id = String(b.id || "").trim();
        const cur = store.get(id);
        if (cur && cur.rank === "owner" && owners().length <= 1) {
          return send(res, 400, { ok: false, error: "Hindi puwedeng tanggalin ang huling owner" });
        }
        const removed = store.remove(id);
        if (removed) log("admin", `Removed ${id}`);
        return send(res, 200, { ok: removed });
      }

      // ----- settings (admin only) -----
      if (isGet && p === "/api/owner/settings") return send(res, 200, { ok: true, settings: store.getSettings() });
      if (isPost && p === "/api/owner/settings") {
        const b = await readJson(req);
        const settings = store.setSettings({ admin_only: !!b.admin_only }); // whitelist
        log("settings", `admin_only = ${settings.admin_only}`);
        return send(res, 200, { ok: true, settings });
      }

      // ----- bot profile / bio -----
      if (isGet && p === "/api/owner/profile") return send(res, 200, { ok: true, profile: store.getProfile() });
      if (isPost && p === "/api/owner/profile") {
        const b = await readJson(req);
        const profile = store.setProfile(b);
        log("profile", "Bot profile updated");
        return send(res, 200, { ok: true, profile });
      }
      if (isPost && p === "/api/owner/profile/apply") {
        if (typeof controls.setBio !== "function") return send(res, 501, { ok: false, error: "Profile apply is not wired in index.js" });
        const bio = store.getProfile().bio;
        await controls.setBio(bio);
        log("profile", "Bio applied to Facebook");
        return send(res, 200, { ok: true, bio });
      }

      // ----- security -----
      if (isPost && p === "/api/owner/change-owner-key") {
        const b = await readJson(req);
        store.setOwnerKey(b.new_key);
        log("security", "Owner password changed");
        return send(res, 200, { ok: true });
      }
      if (isPost && p === "/api/owner/change-dashboard-key") {
        const b = await readJson(req);
        store.setKey(b.new_key);
        log("security", "Dashboard key changed");
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { ok: false, error: "Unsupported owner endpoint" });
    } catch (e) {
      return send(res, e.status || 500, { ok: false, error: e.message });
    }
  };

  // =====================================================================
  // HTTP SERVER
  // =====================================================================
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-ECLIPSE-DASHBOARD-KEY, X-OWNER-KEY");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "celestial", dashboard_api: configured() });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return html(res, PAGE);
    if (url.pathname === "/owner" || url.pathname === "/owner/") return html(res, OWNER_PAGE);

    if (url.pathname.startsWith("/api/owner/")) return handleOwner(req, res, url);

    if (!url.pathname.startsWith("/api/dashboard/")) {
      return send(res, 404, { ok: false, error: "Not found" });
    }

    // Public routes (no key yet): tell the page whether a key exists, and allow the very first setup.
    if (req.method === "GET" && url.pathname === "/api/dashboard/auth-state") {
      return send(res, 200, { ok: true, configured: configured() });
    }
    if (req.method === "POST" && url.pathname === "/api/dashboard/setup") {
      try {
        if (configured()) return send(res, 403, { ok: false, error: "Already set up" });
        const b = await readJson(req);
        store.setKey(b.key);
        log("security", "Dashboard key created");
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, e.status || 500, { ok: false, error: e.message });
      }
    }

    if (!configured()) return send(res, 503, { ok: false, error: "Setup required. Open the dashboard and create a key." });
    const ip = ipOf(req);
    if (isBlocked("d:" + ip)) return send(res, 429, { ok: false, error: "Too many wrong attempts. Try again in a minute." });
    if (!authorized(req)) { noteFail("d:" + ip); return send(res, 401, { ok: false, error: "Dashboard authorization required" }); }
    fails.delete("d:" + ip);

    const p = url.pathname;
    const isGet = req.method === "GET";
    const isPost = req.method === "POST";

    try {
      if (isGet && p === "/api/dashboard/status") {
        return send(res, 200, Object.assign({}, getStatus(), {
          session_saved: session.saved,
          bot_uptime_seconds: conn.since ? Math.floor((Date.now() - conn.since) / 1000) : 0,
          last_connected: conn.last_connected,
          last_disconnected: conn.last_disconnected
        }));
      }
      if (isGet && p === "/api/dashboard/health") return send(res, 200, { ok: true, runtime: runtime() });
      if (isGet && p === "/api/dashboard/session") return send(res, 200, { ok: true, session });
      if (isGet && p === "/api/dashboard/events") {
        const extra = typeof controls.getEvents === "function" ? controls.getEvents() : [];
        const merged = [...events, ...extra].sort((a, b) => new Date(b.at) - new Date(a.at));
        return send(res, 200, { ok: true, events: merged.slice(0, 80) });
      }
      if (isGet && p === "/api/dashboard/snapshot") return send(res, 200, { ok: true, snapshot: null, degraded: true });
      if (isGet && p === "/api/dashboard/analytics") {
        return send(res, 200, { ok: true, analytics: { generated_at: new Date().toISOString(), hours: 24, economy: [], rpg: [], battles: [], moderation: [] } });
      }
      if (isGet && p === "/api/dashboard/user") {
        return send(res, 200, { ok: true, inspector: { generated_at: new Date().toISOString(), user: null } });
      }

      if (isPost && p === "/api/dashboard/autoreply") {
        const b = await readJson(req);
        const on = autoreply.setOn(Boolean(b.on));
        log("autoreply", "Auto reply " + (on ? "ON" : "OFF"));
        return send(res, 200, { ok: true, auto_reply: on });
      }

      if (isGet && p === "/api/dashboard/groups") {
        if (typeof controls.listGroups !== "function") return send(res, 501, { ok: false, error: "Group list is not wired in index.js" });
        const groups = await controls.listGroups(url.searchParams.get("refresh") === "1");
        return send(res, 200, { ok: true, groups });
      }
      if (isPost && (p === "/api/dashboard/groups/start" || p === "/api/dashboard/groups/stop")) {
        const b = await readJson(req);
        if (p.endsWith("/start")) {
          if (typeof controls.startGroup !== "function") return send(res, 501, { ok: false, error: "Group start is not wired in index.js" });
          await controls.startGroup(b.id, b.name, b.message);
          log("group", "Started " + (b.name || b.id));
        } else {
          if (typeof controls.stopGroup !== "function") return send(res, 501, { ok: false, error: "Group stop is not wired in index.js" });
          await controls.stopGroup(b.id);
          log("group", "Stopped " + (b.name || b.id));
        }
        return send(res, 200, { ok: true });
      }

      if (isPost && p === "/api/dashboard/bot/start") {
        if (typeof controls.setPaused !== "function") return send(res, 501, { ok: false, error: "Bot start control is unavailable" });
        controls.setPaused(false);
        log("bot", "Bot started");
        return send(res, 200, { ok: true, bot_running: Boolean(getStatus().facebook_connected) });
      }
      if (isPost && p === "/api/dashboard/bot/stop") {
        if (typeof controls.setPaused !== "function") return send(res, 501, { ok: false, error: "Bot stop control is unavailable" });
        controls.setPaused(true);
        log("bot", "Bot paused");
        return send(res, 200, { ok: true, bot_running: false });
      }

      if (isPost && p === "/api/dashboard/connect-session") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch (_) { return send(res, 400, { ok: false, error: "Invalid request" }); }
        const raw = String(body.cookie || "").trim();
        const parsed = parseCookie(raw);
        if (!parsed) return send(res, 400, { ok: false, error: "Cookie must contain c_user and xs" });
        fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
        fs.writeFileSync(SESSION_FILE, raw, { mode: 0o600 });
        session.saved = true;
        session.account = parsed.account;
        session.saved_at = new Date().toISOString();
        log("session", "Cookie saved for " + parsed.account);
        // Hook into the bot: index.js passes controls.connectSession(raw, parsed)
        if (typeof controls.connectSession === "function") {
          try { await controls.connectSession(raw, parsed); log("session", "Connect requested"); }
          catch (e) { log("error", "Connect failed: " + e.message); return send(res, 500, { ok: false, error: "Saved, but connect failed: " + e.message }); }
        }
        return send(res, 200, { ok: true, session });
      }

      if (isPost && p === "/api/dashboard/reconnect") {
        if (typeof controls.reconnect !== "function") return send(res, 501, { ok: false, error: "Reconnect is not wired in index.js yet" });
        await controls.reconnect(); log("session", "Reconnect requested");
        return send(res, 200, { ok: true });
      }
      if (isPost && p === "/api/dashboard/disconnect") {
        if (typeof controls.disconnect === "function") await controls.disconnect();
        try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
        session.saved = false; session.account = null; session.saved_at = null;
        log("session", "Disconnected and cookie removed");
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { ok: false, error: "Unsupported dashboard endpoint" });
    } catch (e) {
      return send(res, e.status || 500, { ok: false, error: e.message });
    }
  });

  server.listen(port, () => console.log("[CELESTIAL] dashboard + API server :" + port));
  return server;
};
