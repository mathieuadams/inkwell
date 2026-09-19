import { createAuth } from './auth.js';
import { createApi } from './api.js';
import { prepareFile, rasterizeSvg } from './image.js';

const $ = (id) => document.getElementById(id);

const LANGS = [
  ['French', '🇫🇷'], ['Spanish', '🇪🇸'], ['German', '🇩🇪'], ['Portuguese', '🇧🇷'],
  ['Italian', '🇮🇹'], ['Japanese', '🇯🇵'], ['English', '🇬🇧'],
];

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="1080" viewBox="0 0 420 540">
  <defs><pattern id="rule" width="420" height="38" patternUnits="userSpaceOnUse" y="96"><line x1="0" y1="37.5" x2="420" y2="37.5" stroke="#C9D6EA" stroke-width="1.2"/></pattern></defs>
  <rect width="420" height="540" fill="#FFFEF7"/><rect width="420" height="540" fill="url(#rule)"/>
  <line x1="52" y1="0" x2="52" y2="540" stroke="#F2A7A7" stroke-width="1.4"/>
  <g font-family="'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive" fill="#1F3A93" transform="rotate(-1.2 210 270)">
    <text x="66" y="80" font-size="34" font-weight="600">Weekend plans</text>
    <path d="M66 90 q70 6 190 -2" stroke="#1F3A93" stroke-width="2" fill="none"/>
    <text x="66" y="160" font-size="22">Farmers market at 9 - bring bags</text>
    <text x="66" y="198" font-size="22">Call Mom about Sunday lunch</text>
    <text x="66" y="236" font-size="22">Fix the bike tire</text>
    <text x="66" y="274" font-size="22">Book dentist for next week</text>
    <text x="66" y="350" font-size="24" font-weight="600">Don't forget: water the plants!</text>
  </g></svg>`;

const PLANS = [
  { id: 'starter', name: 'Starter', price: 5, pages: 20, perks: ['20 pages a month', 'Translate into any language', 'Copy or download text', 'Notes are not saved'] },
  { id: 'plus', name: 'Plus', price: 10, pages: 150, featured: true, perks: ['150 pages a month', 'Translate into any language', 'Notes and photos kept 30 days', 'Access from any device'] },
  { id: 'pro', name: 'Pro', price: 25, pages: 500, perks: ['500 pages a month', 'Translate into any language', 'Notes kept while subscribed', 'Build a searchable archive'] },
];
const PLAN_NAMES = { free: 'Free', starter: 'Starter', plus: 'Plus', pro: 'Pro' };

let auth;
let api;
const state = { note: null, lang: 'French', lastBlob: null, saveTimer: null, previewUrl: null, busy: false, account: null };

bindUi();
renderLangs();
initTheme();
boot();

/* ------------------------------------------------------------------ boot */

async function boot() {
  let cfg;
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    cfg = await res.json();
  } catch {
    $('fatal').textContent = 'Inkwell isn’t configured. Deploy the stack, or run "npm run web:config" for local development.';
    $('fatal').hidden = false;
    return;
  }
  auth = createAuth(cfg);
  api = createApi(cfg, auth);

  const billingReturn = new URLSearchParams(location.search).get('billing');
  try {
    await auth.handleRedirect();
  } catch (e) {
    toast(e.message);
  }
  if (billingReturn) history.replaceState(null, '', '/');
  await auth.accessToken();
  renderAccount();
  if (!auth.isSignedIn()) return;

  await refreshAccount();
  refreshRecent();
  if (billingReturn === 'success') waitForSubscription();
  if (billingReturn === 'cancel') toast('Checkout cancelled. You have not been charged.');
}

/* ------------------------------------------------------------------ plans & billing */

async function refreshAccount() {
  try {
    state.account = await api.account();
    renderUsage();
  } catch (e) {
    if (e.status !== 401) console.warn('Account unavailable', e);
  }
  return state.account;
}

function setAccount(account) {
  if (!account) return;
  state.account = account;
  renderUsage();
}

function renderUsage() {
  const a = state.account;
  $('usageBtn').hidden = !a;
  if (!a) return;
  $('usagePlan').textContent = PLAN_NAMES[a.plan] || a.plan;
  $('usageText').textContent = a.plan === 'free'
    ? `${Math.max(0, a.pagesLimit - a.pagesUsed)} free ${a.pagesLimit - a.pagesUsed === 1 ? 'page' : 'pages'} left`
    : `${a.pagesUsed} / ${a.pagesLimit} pages`;
  $('usageBtn').classList.toggle('low', a.pagesUsed >= a.pagesLimit);
  $('storageHint').hidden = a.storesNotes;
}

/** Stripe's webhook can land a few seconds after the redirect back. */
async function waitForSubscription() {
  toast('Payment received. Activating your plan…');
  for (let i = 0; i < 8; i++) {
    const a = await refreshAccount();
    if (a?.hasSubscription) {
      toast(`${PLAN_NAMES[a.plan]} is active. ${a.pagesLimit} pages this month.`);
      refreshRecent();
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  toast('Your plan will show up in a moment. Refresh the page if it doesn’t.');
}

function openPlans(message) {
  const a = state.account;
  $('plansMsg').hidden = !message;
  $('plansMsg').textContent = message || '';
  $('plansTitle').textContent = a?.hasSubscription ? 'Your plan' : 'Choose a plan';
  const grid = $('planGrid');
  grid.replaceChildren();
  for (const p of PLANS) {
    const current = a?.hasSubscription && a.plan === p.id;
    const card = document.createElement('div');
    card.className = `plan-card${p.featured ? ' featured' : ''}${current ? ' current' : ''}`;
    card.innerHTML = `<div class="plan-name"></div><div class="plan-price">$${p.price}<small> / month</small></div><ul></ul>`;
    const name = card.querySelector('.plan-name');
    name.textContent = p.name;
    if (p.featured) name.insertAdjacentHTML('beforeend', '<span class="plan-badge">Popular</span>');
    const ul = card.querySelector('ul');
    for (const perk of p.perks) {
      const li = document.createElement('li');
      li.textContent = perk;
      ul.append(li);
    }
    const btn = document.createElement('button');
    btn.className = `btn ${p.featured || current ? 'btn-primary' : ''}`;
    btn.textContent = current ? 'Manage plan' : a?.hasSubscription ? `Switch to ${p.name}` : `Choose ${p.name}`;
    btn.onclick = () => (a?.hasSubscription ? goToPortal(btn) : goToCheckout(p.id, btn));
    card.append(btn);
    grid.append(card);
  }
  if (!$('plansDialog').open) $('plansDialog').showModal();
}

async function goToCheckout(plan, btn) {
  btn.disabled = true;
  btn.textContent = 'Opening checkout…';
  try {
    const { url } = await api.checkout(plan);
    location.assign(url);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = 'Try again';
  }
}

async function goToPortal(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    const { url } = await api.portal();
    location.assign(url);
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
  }
}

function renderAccount() {
  const signedIn = auth.isSignedIn();
  $('signedOut').hidden = signedIn;
  $('drop').hidden = !signedIn;
  $('recent').hidden = !signedIn;
  $('account').hidden = !signedIn;
  $('signInTop').hidden = signedIn;
  const email = auth.email();
  $('userEmail').textContent = email || 'Signed in';
  $('avatar').textContent = (email[0] || '•').toUpperCase();
}

/* ------------------------------------------------------------------ UI wiring */

function bindUi() {
  $('signInBtn').onclick = () => auth?.signIn();
  $('signInTop').onclick = () => auth?.signIn();
  $('signUpBtn').onclick = () => auth?.signUp();
  $('signOutBtn').onclick = () => auth?.signOut();
  $('billingBtn').onclick = () => { $('account').open = false; state.account?.hasSubscription ? goToPortal() : openPlans(); };
  $('usageBtn').onclick = () => openPlans();
  $('storageUpgradeBtn').onclick = () => openPlans();
  $('plansClose').onclick = () => $('plansDialog').close();
  $('plansDialog').addEventListener('click', (e) => { if (e.target === $('plansDialog')) $('plansDialog').close(); });
  window.addEventListener('beforeunload', (e) => {
    if (state.note && state.note.saved === false) e.preventDefault();
  });

  $('homeLink').onclick = (e) => { e.preventDefault(); showCapture(); };
  $('backBtn').onclick = showCapture;
  $('newBtn').onclick = showCapture;
  $('deleteBtn').onclick = deleteCurrent;
  $('retryBtn').onclick = () => state.lastBlob && runExtraction(state.lastBlob);

  $('cameraInput').onchange = (e) => startWithFile(e.target.files[0]);
  $('fileInput').onchange = (e) => startWithFile(e.target.files[0]);
  $('sampleBtn').onclick = startWithSample;

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => startWithFile(e.dataTransfer.files[0]));

  $('tabText').onclick = () => selectTab('text');
  $('tabTr').onclick = () => selectTab('tr');
  $('toTrBtn').onclick = () => selectTab('tr');

  $('editor').addEventListener('input', onEdit);
  $('copyBtn').onclick = () => copy($('editor').value, 'Text copied');
  $('downloadBtn').onclick = downloadText;
  $('translateBtn').onclick = translate;
  $('copyTrBtn').onclick = () => copy($('output').textContent, 'Translation copied');
  $('shareBtn').onclick = share;
  $('moreLangs').onchange = (e) => { if (e.target.value) { state.lang = e.target.value; renderLangs(); showCachedTranslation(); } };
}

function initTheme() {
  $('themeBtn').onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
  };
}

/* ------------------------------------------------------------------ views */

function showCapture() {
  if (state.note && state.note.saved === false && !confirm('This note isn’t saved on your plan. Leave it?')) return;
  flushSave();
  $('workspace').hidden = true;
  $('capture').hidden = false;
  $('cameraInput').value = '';
  $('fileInput').value = '';
  state.note = null;
  window.scrollTo({ top: 0 });
  if (auth?.isSignedIn()) refreshRecent();
}

function openWorkspace(title) {
  $('capture').hidden = true;
  $('workspace').hidden = false;
  $('noteTitle').textContent = title;
  state.note = null;
  selectTab('text');
  showSkeleton(true);
  $('count').textContent = '';
  resetTranslation();
  window.scrollTo({ top: 0 });
}

function selectTab(which) {
  const text = which === 'text';
  $('tabText').setAttribute('aria-selected', String(text));
  $('tabTr').setAttribute('aria-selected', String(!text));
  $('panelText').hidden = !text;
  $('panelTr').hidden = text;
}

function showSkeleton(on) {
  $('skeleton').hidden = !on;
  $('editor').hidden = on;
}

function setBusy(on) {
  state.busy = on;
  $('pageFrame').classList.toggle('scanning', on);
  for (const id of ['copyBtn', 'downloadBtn', 'toTrBtn', 'deleteBtn', 'translateBtn']) {
    $(id).disabled = on || !state.note;
  }
}

function setStatus(kind, text, { retry = false } = {}) {
  $('dot').className = `dot ${kind}`;
  $('status').classList.toggle('err', kind === 'err');
  $('statusText').textContent = text;
  $('retryBtn').hidden = !retry;
}

function showPreview({ blob, url, type, name }) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  const box = $('pageContent');
  box.replaceChildren();
  if (type === 'application/pdf') {
    const div = document.createElement('div');
    div.className = 'pdf-placeholder';
    div.textContent = name || 'PDF document';
    box.append(div);
    return;
  }
  const img = document.createElement('img');
  img.alt = 'Photo of your note';
  if (blob) {
    state.previewUrl = URL.createObjectURL(blob);
    img.src = state.previewUrl;
  } else {
    img.src = url;
  }
  box.append(img);
}

/* ------------------------------------------------------------------ extraction */

async function startWithFile(file) {
  if (!file) return;
  let blob;
  try {
    blob = await prepareFile(file);
  } catch (e) {
    toast(e.message);
    return;
  }
  openWorkspace(file.name.replace(/\.[^.]+$/, '') || 'Untitled note');
  showPreview({ blob, type: blob.type, name: file.name });
  runExtraction(blob);
}

async function startWithSample() {
  try {
    const blob = await rasterizeSvg(SAMPLE_SVG, 840, 1080);
    openWorkspace('Sample note');
    showPreview({ blob, type: blob.type });
    runExtraction(blob);
  } catch {
    toast('The sample note couldn’t be created in this browser.');
  }
}

async function runExtraction(blob) {
  state.lastBlob = blob;
  showSkeleton(true);
  setBusy(true);
  setStatus('busy', 'Uploading photo…');
  try {
    const key = await api.upload(blob);
    setStatus('busy', 'Reading your handwriting…');
    const note = await api.extract(key);
    loadNote(note);
    setStatus('done', note.saved
      ? 'Done. Check the text and fix anything that looks off.'
      : 'Done. Your plan doesn’t save notes, so copy or download what you need.');
  } catch (e) {
    setStatus('err', e.message, { retry: ![401, 402, 413, 415].includes(e.status) });
    if (e.status === 402) openPlans(e.message);
  } finally {
    setBusy(false);
  }
}

function loadNote(note) {
  note.translations ??= {};
  note.saved ??= true;
  setAccount(note.account);
  state.note = note;
  $('deleteBtn').hidden = !note.saved;
  $('noteTitle').textContent = note.title;
  $('editor').value = note.text;
  showSkeleton(false);
  updateCount();
  showCachedTranslation();
}

async function openNote(id) {
  openWorkspace('Opening note…');
  $('pageContent').replaceChildren();
  setBusy(true);
  setStatus('busy', 'Opening note…');
  try {
    const note = await api.getNote(id);
    showPreview({ url: note.imageUrl, type: note.sourceType, name: note.title });
    loadNote(note);
    setStatus('done', `Saved ${formatDate(note.updatedAt).toLowerCase()}`);
  } catch (e) {
    setStatus('err', e.message);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ editing */

function onEdit() {
  updateCount();
  if (!state.note) return;
  if (Object.keys(state.note.translations).length) state.note.translations = {};
  resetTranslation();
  if (!state.note.saved) return;
  setStatus('', 'Unsaved changes');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveText, 1200);
}

function flushSave() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    saveText();
  }
}

async function saveText() {
  state.saveTimer = null;
  const note = state.note;
  if (!note) return;
  const text = $('editor').value;
  try {
    const saved = await api.updateNote(note.id, { text });
    note.text = saved.text;
    note.updatedAt = saved.updatedAt;
    if (state.note === note) setStatus('done', 'Saved');
  } catch (e) {
    if (state.note === note) setStatus('err', `Not saved: ${e.message}`);
  }
}

function updateCount() {
  const v = $('editor').value.trim();
  const words = v ? v.split(/\s+/).length : 0;
  const lines = v ? v.split('\n').length : 0;
  $('count').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

async function deleteCurrent() {
  const note = state.note;
  if (!note || !confirm('Delete this note and its photo? This can’t be undone.')) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    await api.deleteNote(note.id);
    toast('Note deleted');
    showCapture();
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------------------------ translation */

function renderLangs() {
  const wrap = $('langs');
  wrap.replaceChildren();
  for (const [name, flag] of LANGS) {
    const b = document.createElement('button');
    b.className = 'lang';
    b.setAttribute('aria-pressed', String(name === state.lang));
    b.innerHTML = `<span aria-hidden="true">${flag}</span>`;
    b.append(name);
    b.onclick = () => { state.lang = name; $('moreLangs').value = ''; renderLangs(); showCachedTranslation(); };
    wrap.append(b);
  }
}

function resetTranslation() {
  $('output').className = 'output empty';
  $('output').textContent = 'Pick a language, then choose Translate.';
  $('copyTrBtn').disabled = true;
  $('shareBtn').disabled = true;
}

function showTranslation(text) {
  $('output').className = 'output';
  $('output').textContent = text;
  $('copyTrBtn').disabled = false;
  $('shareBtn').disabled = false;
}

function showCachedTranslation() {
  const cached = state.note?.translations?.[state.lang];
  if (cached) showTranslation(cached.text);
  else resetTranslation();
}

async function translate() {
  const text = $('editor').value;
  if (!text.trim()) { toast('Add some text first'); selectTab('text'); return; }
  const cached = state.note?.translations?.[state.lang];
  if (cached) { showTranslation(cached.text); return; }

  clearTimeout(state.saveTimer); // the translate call saves the text too
  state.saveTimer = null;
  const note = state.note;
  const lang = state.lang;
  $('translateBtn').disabled = true;
  $('output').className = 'output';
  $('output').innerHTML = '<div class="skeleton bare"><i style="width:45%"></i><i style="width:85%"></i><i style="width:70%"></i><i style="width:90%"></i></div>';
  try {
    const res = await api.translate(text, lang, note?.saved ? note.id : undefined);
    setAccount(res.account);
    if (note) {
      if (note.text !== text) { note.text = text; note.translations = {}; }
      note.translations[lang] = { text: res.text };
      if (note.saved) setStatus('done', 'Saved');
    }
    if (state.note === note && state.lang === lang) showTranslation(res.text);
  } catch (e) {
    $('output').className = 'output empty error';
    $('output').textContent = e.message;
    if (e.status === 402) openPlans(e.message);
  } finally {
    $('translateBtn').disabled = !state.note;
  }
}

/* ------------------------------------------------------------------ recent notes */

async function refreshRecent() {
  try {
    const { notes } = await api.listNotes();
    renderRecent(notes);
  } catch (e) {
    if (e.status !== 401) toast(e.message);
  }
}

function renderRecent(notes) {
  const list = $('recentList');
  list.replaceChildren();
  $('recentEmpty').hidden = notes.length > 0 || state.account?.storesNotes === false;
  for (const n of notes) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'recent-item';
    btn.innerHTML = '<span class="recent-thumb" aria-hidden="true">Aa</span><span class="grow"><span class="recent-title"></span><span class="recent-meta"></span></span><span class="pill"></span>';
    btn.querySelector('.recent-title').textContent = n.title;
    btn.querySelector('.recent-meta').textContent = `${formatDate(n.updatedAt)} · ${n.preview.replace(/\s+/g, ' ')}`;
    btn.querySelector('.pill').textContent = pill(n);
    btn.onclick = () => openNote(n.id);
    li.append(btn);
    list.append(li);
  }
}

const short = (lang) => (lang || '??').slice(0, 2).toUpperCase();
const pill = (n) => (n.translations.length ? `${short(n.language)} → ${n.translations.map(short).join(', ')}` : short(n.language));

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}

/* ------------------------------------------------------------------ actions */

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Copy isn’t available here. Select the text and copy it manually.');
  }
}

function downloadText() {
  const name = ($('noteTitle').textContent || 'note').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'note';
  const url = URL.createObjectURL(new Blob([$('editor').value], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Downloaded');
}

async function share() {
  const text = $('output').textContent;
  if (navigator.share) {
    try { await navigator.share({ title: $('noteTitle').textContent, text }); } catch { /* dismissed */ }
  } else {
    copy(text, 'Sharing isn’t supported here, so the translation was copied');
  }
}

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
