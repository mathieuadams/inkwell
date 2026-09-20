import { createAuth } from './auth.js';
import { createApi } from './api.js';
import { prepareFile, rasterizeSvg } from './image.js';

const $ = (id) => document.getElementById(id);

const LANGS = [
  ['French', '🇫🇷'], ['Spanish', '🇪🇸'], ['German', '🇩🇪'], ['Portuguese', '🇧🇷'],
  ['Italian', '🇮🇹'], ['Japanese', '🇯🇵'], ['English', '🇬🇧'],
];

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="1080" viewBox="0 0 420 540">
  <defs><pattern id="rule" width="420" height="34" patternUnits="userSpaceOnUse" y="70"><line x1="0" y1="33.5" x2="420" y2="33.5" stroke="#CFC2A6" stroke-width="1.1"/></pattern></defs>
  <rect width="420" height="540" fill="#FBF3E2"/><rect width="420" height="540" fill="url(#rule)"/>
  <line x1="46" y1="0" x2="46" y2="540" stroke="#E0B7A8" stroke-width="1.2"/>
  <g font-family="'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive" fill="#2C3E7B" transform="rotate(-1.4 210 270)">
    <text x="60" y="62" font-size="26">Liebe Constanze!</text>
    <text x="60" y="118" font-size="19">Damit Du wieder einmal Post</text>
    <text x="60" y="152" font-size="19">aus Deutschland bekommst,</text>
    <text x="60" y="186" font-size="19">schicke ich Dir diese Karte.</text>
    <text x="60" y="254" font-size="19">Wie geht es Dir denn so?</text>
    <text x="60" y="288" font-size="19">Musst Du viel lernen?</text>
    <text x="60" y="356" font-size="19">Ich komme im Dezember</text>
    <text x="60" y="390" font-size="19">nach England. Bist Du da</text>
    <text x="60" y="424" font-size="19">schon zu Hause?</text>
    <text x="60" y="470" font-size="20">Ich wuerde mich sehr freuen!</text>
  </g></svg>`;

const PLANS = [
  { id: 'starter', name: 'Starter', price: 5, pages: 20, perks: ['20 pages a month', 'Translate into any language', 'Copy or download text', 'Notes are not saved'] },
  { id: 'plus', name: 'Plus', price: 10, pages: 150, featured: true, perks: ['150 pages a month', 'Translate into any language', 'Notes and photos kept 30 days', 'Access from any device'] },
  { id: 'pro', name: 'Pro', price: 25, pages: 500, perks: ['500 pages a month', 'Translate into any language', 'Notes kept while subscribed', 'Build a searchable archive'] },
];
const PLAN_NAMES = { free: 'Free', starter: 'Starter', plus: 'Plus', pro: 'Pro' };
// Display prices; the amount charged is each Stripe product's default price.
const TOPUPS = [{ pages: 20, price: 3 }, { pages: 50, price: 6 }, { pages: 100, price: 10 }];
const MAX_BATCH = 20;
const BATCH_CONCURRENCY = 2;
const BONUS_KEY = 'inkwell.bonusBefore';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let auth;
let api;
const state = { note: null, lang: 'French', lastBlob: null, saveTimer: null, previewUrl: null, busy: false, account: null, batch: null };

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
  if (billingReturn === 'topup') waitForTopup();
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
  const left = Math.max(0, a.pagesLimit - a.pagesUsed);
  $('usageText').textContent = a.plan === 'free'
    ? `${left} free ${left === 1 ? 'page' : 'pages'} left`
    : `${a.pagesUsed} / ${a.pagesLimit} pages`;
  if (a.bonusPages > 0) {
    const bonus = document.createElement('span');
    bonus.className = 'bonus';
    bonus.textContent = ` +${a.bonusPages}`;
    bonus.title = `${a.bonusPages} top-up pages`;
    $('usageText').append(bonus);
  }
  $('usageBtn').classList.toggle('low', left === 0 && !a.bonusPages);
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

async function waitForTopup() {
  toast('Payment received. Adding your pages…');
  const before = Number(sessionStorage.getItem(BONUS_KEY) ?? 0);
  sessionStorage.removeItem(BONUS_KEY);
  for (let i = 0; i < 8; i++) {
    const a = await refreshAccount();
    if (a && a.bonusPages > before) {
      toast(`Done. ${a.bonusPages} top-up pages available.`);
      return;
    }
    await sleep(2000);
  }
  toast('Your pages will show up in a moment. Refresh the page if they don’t.');
}

function pagesAvailable() {
  const a = state.account;
  return a ? Math.max(0, a.pagesLimit - a.pagesUsed) + (a.bonusPages || 0) : Infinity;
}

function renderTopups() {
  const a = state.account;
  $('topupBox').hidden = a?.topupsReady === false;
  const wrap = $('topupOptions');
  wrap.replaceChildren();
  for (const t of TOPUPS) {
    const btn = document.createElement('button');
    btn.className = 'btn topup-btn';
    btn.innerHTML = `<b>+${t.pages} pages</b><small>$${t.price}</small>`;
    btn.onclick = () => buyTopup(t.pages, btn);
    wrap.append(btn);
  }
}

async function buyTopup(pages, btn) {
  btn.disabled = true;
  try {
    sessionStorage.setItem(BONUS_KEY, String(state.account?.bonusPages ?? 0));
    const { url } = await api.topup(pages);
    location.assign(url);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

function planCard(p, { current = false, label, onClick }) {
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
  btn.textContent = label;
  btn.onclick = () => onClick(btn);
  card.append(btn);
  return card;
}

/** Pricing on the signed-out landing page: every button starts sign-up. */
function renderLandingPlans() {
  const grid = $('landingPlans');
  if (!grid) return;
  grid.replaceChildren();
  for (const p of PLANS) {
    grid.append(planCard(p, { label: `Start with ${p.name}`, onClick: () => auth?.signUp() }));
  }
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
    grid.append(planCard(p, {
      current,
      label: current ? 'Manage plan' : a?.hasSubscription ? `Switch to ${p.name}` : `Choose ${p.name}`,
      onClick: (btn) => (a?.hasSubscription ? goToPortal(btn) : goToCheckout(p.id, btn)),
    }));
  }
  renderTopups();
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
  $('landing').hidden = signedIn;
  $('capture').hidden = !signedIn;
  $('recent').hidden = !signedIn;
  $('account').hidden = !signedIn;
  $('signInTop').hidden = signedIn;
  if (!signedIn) renderLandingPlans();
  const email = auth.email();
  $('userEmail').textContent = email || 'Signed in';
  $('avatar').textContent = (email[0] || '•').toUpperCase();
}

/* ------------------------------------------------------------------ UI wiring */

function bindUi() {
  for (const el of document.querySelectorAll('.js-signin')) el.onclick = () => auth?.signIn();
  for (const el of document.querySelectorAll('.js-signup')) el.onclick = () => auth?.signUp();
  $('signOutBtn').onclick = () => auth?.signOut();
  $('billingBtn').onclick = () => { $('account').open = false; state.account?.hasSubscription ? goToPortal() : openPlans(); };
  $('usageBtn').onclick = () => openPlans();
  $('storageUpgradeBtn').onclick = () => openPlans();
  $('plansClose').onclick = () => $('plansDialog').close();
  $('plansDialog').addEventListener('click', (e) => { if (e.target === $('plansDialog')) $('plansDialog').close(); });
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedWork()) e.preventDefault();
  });

  $('homeLink').onclick = (e) => { e.preventDefault(); showCapture(); };
  $('backBtn').onclick = () => (state.batch ? showBatch() : showCapture());
  $('newBtn').onclick = showCapture;
  $('batchBackBtn').onclick = showCapture;
  $('batchDownloadBtn').onclick = downloadAll;
  $('deleteBtn').onclick = deleteCurrent;
  $('retryBtn').onclick = () => state.lastBlob && runExtraction(state.lastBlob);

  $('cameraInput').onchange = (e) => startWithFile(e.target.files[0]);
  $('fileInput').onchange = (e) => startWithFiles(e.target.files);
  $('sampleBtn').onclick = startWithSample;

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => startWithFiles(e.dataTransfer.files));

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

function hasUnsavedWork() {
  if (state.batch?.running) return true;
  if (state.batch?.items.some((i) => i.note && i.note.saved === false)) return true;
  return Boolean(state.note && state.note.saved === false);
}

function showCapture() {
  if (!auth?.isSignedIn()) { renderAccount(); return; }
  if (state.batch?.running && !confirm('Some notes are still being converted. Stop and leave?')) return;
  if (!state.batch?.running && hasUnsavedWork() && !confirm('These notes aren’t saved on your plan. Leave them?')) return;
  flushSave();
  if (state.batch) state.batch.cancelled = true;
  state.batch = null;
  $('workspace').hidden = true;
  $('batch').hidden = true;
  $('capture').hidden = false;
  $('cameraInput').value = '';
  $('fileInput').value = '';
  state.note = null;
  window.scrollTo({ top: 0 });
  if (auth?.isSignedIn()) refreshRecent();
}

function openWorkspace(title) {
  $('capture').hidden = true;
  $('batch').hidden = true;
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
  for (const id of ['copyBtn', 'downloadBtn', 'toTrBtn', 'deleteBtn']) {
    $(id).disabled = on || !state.note;
  }
  // Translate only needs text in the editor, so it's never tied to note state.
  $('translateBtn').disabled = on;
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
    openWorkspace('Sample letter');
    showPreview({ blob, type: blob.type });
    runExtraction(blob);
  } catch {
    toast('The sample letter couldn’t be created in this browser.');
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
      ? 'Done. Compare it with the page and fix anything it misread.'
      : 'Done. Your plan doesn’t save pages, so copy or download what you need.');
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
  setBusy(state.busy); // enable Copy / Download / Translate now that a note is loaded
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
  if (!state.note.saved) {
    state.note.text = $('editor').value;
    return;
  }
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
    $('translateBtn').disabled = false;
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

function saveFile(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Downloaded');
}

function downloadText() {
  const name = ($('noteTitle').textContent || 'note').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'note';
  saveFile(`${name}.txt`, $('editor').value);
}

async function share() {
  const text = $('output').textContent;
  if (navigator.share) {
    try { await navigator.share({ title: $('noteTitle').textContent, text }); } catch { /* dismissed */ }
  } else {
    copy(text, 'Sharing isn’t supported here, so the translation was copied');
  }
}

/* ------------------------------------------------------------------ batch upload */

const BATCH_LABELS = {
  queued: 'Waiting',
  preparing: 'Preparing photo…',
  uploading: 'Uploading…',
  reading: 'Reading handwriting…',
  done: 'Done',
};

function startWithFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  if (files.length === 1) return startWithFile(files[0]);
  if (files.length > MAX_BATCH) toast(`Only the first ${MAX_BATCH} files will be converted.`);
  const selected = files.slice(0, MAX_BATCH);

  const available = pagesAvailable();
  if (available === 0) {
    openPlans('You’re out of pages. Top up or upgrade to convert these notes.');
    return;
  }
  if (available < selected.length) {
    toast(`You have ${available} pages left, so only the first ${available} will be converted.`);
  }
  startBatch(selected);
}

function startBatch(files) {
  state.batch = {
    items: files.map((file) => ({ file, name: file.name, status: 'queued', note: null, blob: null, thumb: null, error: '' })),
    running: true,
    cancelled: false,
    quotaShown: false,
  };
  $('cameraInput').value = '';
  $('fileInput').value = '';
  showBatch();
  processBatch(state.batch);
}

async function processBatch(batch) {
  const worker = async () => {
    while (!batch.cancelled) {
      const item = batch.items.find((i) => i.status === 'queued');
      if (!item) return;
      item.status = 'preparing';
      renderBatch(batch);
      try {
        item.blob = await prepareFile(item.file);
        if (item.blob.type !== 'application/pdf') item.thumb = URL.createObjectURL(item.blob);
        item.status = 'uploading';
        renderBatch(batch);
        const key = await api.upload(item.blob);
        item.status = 'reading';
        renderBatch(batch);
        const note = await api.extract(key);
        note.translations ??= {};
        setAccount(note.account);
        delete note.account;
        item.note = note;
        item.status = 'done';
      } catch (e) {
        item.status = 'error';
        item.error = e.message;
        if (e.status === 402) {
          for (const other of batch.items) {
            if (other.status === 'queued') { other.status = 'error'; other.error = 'Out of pages'; }
          }
          if (!batch.quotaShown && !batch.cancelled) {
            batch.quotaShown = true;
            openPlans(e.message);
          }
        }
      }
      renderBatch(batch);
    }
  };
  await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));
  batch.running = false;
  renderBatch(batch);
  if (!batch.cancelled && state.account?.storesNotes) refreshRecent();
}

function showBatch() {
  flushSave();
  state.note = null;
  $('capture').hidden = true;
  $('workspace').hidden = true;
  $('batch').hidden = false;
  renderBatch(state.batch);
  window.scrollTo({ top: 0 });
}

function renderBatch(batch) {
  if (!batch || batch !== state.batch || $('batch').hidden) return;
  const total = batch.items.length;
  const done = batch.items.filter((i) => i.status === 'done').length;
  const failed = batch.items.filter((i) => i.status === 'error').length;
  $('batchTitle').textContent = batch.running ? `Converting ${total} notes` : `${done} of ${total} notes converted`;
  $('batchBar').style.width = `${Math.round(((done + failed) / total) * 100)}%`;
  $('batchStatus').textContent = batch.running
    ? `${done} done${failed ? `, ${failed} failed` : ''}. Keep this page open.`
    : state.account?.storesNotes
      ? 'Saved to your notes. Open one to edit or translate it.'
      : 'Not saved on your plan. Download all, or open a note to copy or translate it.';
  $('batchDownloadBtn').disabled = done === 0;

  const list = $('batchList');
  list.replaceChildren();
  for (const item of batch.items) {
    const li = document.createElement('li');
    const el = document.createElement(item.status === 'done' ? 'button' : 'div');
    el.className = 'batch-item';

    let thumb;
    if (item.thumb) {
      thumb = document.createElement('img');
      thumb.src = item.thumb;
      thumb.alt = '';
    } else {
      thumb = document.createElement('div');
      thumb.className = 'pdf-placeholder';
      thumb.textContent = item.blob?.type === 'application/pdf' ? 'PDF' : '';
    }
    thumb.classList.add('batch-thumb');

    const info = document.createElement('div');
    info.className = 'batch-info';
    const name = document.createElement('span');
    name.className = 'batch-name';
    name.textContent = item.note?.title || item.name;
    const st = document.createElement('span');
    st.className = `batch-state ${item.status === 'error' ? 'err' : item.status === 'done' ? 'done' : ''}`;
    const dot = document.createElement('span');
    dot.className = `dot ${item.status === 'done' ? 'done' : item.status === 'error' ? 'err' : item.status === 'queued' ? '' : 'busy'}`;
    st.append(dot, item.status === 'error' ? item.error : BATCH_LABELS[item.status]);
    info.append(name, st);

    el.append(thumb, info);
    if (item.status === 'done') el.onclick = () => openBatchItem(item);
    li.append(el);
    list.append(li);
  }
}

function openBatchItem(item) {
  openWorkspace(item.note.title);
  showPreview({ blob: item.blob, type: item.blob.type, name: item.name });
  loadNote(item.note);
  setStatus('done', item.note.saved ? 'Saved' : 'Not saved on your plan. Copy or download what you need.');
}

function downloadAll() {
  const notes = (state.batch?.items ?? []).filter((i) => i.note);
  if (!notes.length) return;
  const text = notes
    .map((i) => `${i.note.title}\n${'='.repeat(Math.min(60, i.note.title.length))}\n\n${i.note.text.trim()}\n`)
    .join('\n\n');
  saveFile(`inkwell-notes-${new Date().toISOString().slice(0, 10)}.txt`, text);
}

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
