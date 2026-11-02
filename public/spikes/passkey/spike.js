// Spike: does each passkey provider give stable PRF output on this domain?
// Decides which unlock options Phase 7 of docs/plans/2026-11-02-fill-and-sign.md offers.
// No server is involved. PRF output is never stored or shown, only a short hash, so two
// runs (or two devices) can be compared. Test passkeys are named so they're easy to spot.

const KEY = 'spike-passkey'; // localStorage prefix, separate from the app's data
const SPIKE_NAME = 'spike-passkey-pdf-remix';
const SALT_TEXT = 'pdf-remix-prf-spike-v1'; // fixed, so a synced passkey can be compared across devices

// Only a label for the results: the raw AAGUID is always recorded too.
const KNOWN_AAGUIDS = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
};

const $ = (id) => document.getElementById(id);
const results = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent, run: 1, credentials: [], experiments: {}, log: [] };

// ---------- persistence ----------
function save() {
  try {
    localStorage.setItem(`${KEY}.results`, JSON.stringify(results));
  } catch {
    /* localStorage can be unavailable: results then live only until the page closes */
  }
}

function log(msg, data) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}` + (data === undefined ? '' : ' ' + JSON.stringify(data));
  results.log.push(line);
  $('log').textContent += line + '\n';
  save();
}

const rows = {};
function renderRow(name, status, details) {
  let tr = rows[name];
  if (!tr) {
    tr = document.createElement('tr');
    for (let i = 0; i < 3; i++) tr.appendChild(document.createElement('td'));
    rows[name] = tr;
    $('summary').tBodies[0].appendChild(tr);
  }
  tr.cells[0].textContent = name;
  tr.cells[1].textContent = status;
  tr.cells[1].className = status.toLowerCase();
  tr.cells[2].textContent = JSON.stringify(details);
}

function verdict(name, status, details) {
  const full = `Run ${results.run}: ${name}`;
  results.experiments[full] = { status, ...details };
  renderRow(full, status, details);
  log(`${full}: ${status}`, details);
}

/** Records a failed result, then stops the step so it stays current. */
class Reported extends Error {}
function fail(name, details) {
  verdict(name, 'FAIL', details);
  throw new Reported();
}

// ---------- WebAuthn helpers ----------
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text) => Uint8Array.from(text.match(/../g), (b) => parseInt(b, 16));
const toBase64Url = (hexText) => btoa(String.fromCharCode(...fromHex(hexText))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const salt = () => new TextEncoder().encode(SALT_TEXT);
const current = () => results.credentials.at(-1);

function aaguidOf(authData) {
  const bytes = new Uint8Array(authData);
  const flags = bytes[32];
  const h = hex(bytes.slice(37, 53));
  const aaguid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { aaguid, provider: KNOWN_AAGUIDS[aaguid] ?? (/^0+(-0+)*$/.test(aaguid) ? 'hidden (all zeros)' : 'unknown'), backupEligible: Boolean(flags & 0x08), backedUp: Boolean(flags & 0x10) };
}

/** A short hash, so outputs can be compared without keeping the output itself. */
async function prfSummary(first) {
  if (!first) return null;
  const bytes = new Uint8Array(first);
  return {
    length: bytes.length,
    allZero: bytes.every((b) => b === 0),
    hash: hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16),
  };
}

async function getPrf(allowCurrent) {
  const allowCredentials = allowCurrent ? [{ type: 'public-key', id: fromHex(current().id) }] : [];
  const credential = await navigator.credentials.get({
    publicKey: { challenge: random(32), userVerification: 'required', allowCredentials, extensions: { prf: { eval: { first: salt() } } } },
  });
  const summary = await prfSummary(credential.getClientExtensionResults().prf?.results?.first);
  return { id: hex(credential.rawId), summary };
}

const needCredential = () => {
  if (!current()) throw new Error('Create a passkey first');
};

// ---------- the experiments ----------
async function checkSupport() {
  if (!window.PublicKeyCredential) throw new Error('This browser has no passkey support');
  const caps = (await PublicKeyCredential.getClientCapabilities?.()) ?? null;
  const platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  verdict('Browser support', 'INFO', {
    summary: caps ? (caps['extension:prf'] ? 'PRF REPORTED' : 'PRF NOT REPORTED') : 'NOT REPORTED',
    prfCapability: caps ? (caps['extension:prf'] ?? null) : null,
    platformAuthenticator: platform,
    host: location.hostname,
  });
}

async function createPasskey() {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'PDF Remix passkey test' },
      user: { id: random(16), name: `${SPIKE_NAME}-run-${results.run}`, displayName: 'PDF Remix test, safe to delete' },
      challenge: random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      extensions: { prf: {} },
    },
  });
  const prf = credential.getClientExtensionResults().prf;
  const info = aaguidOf(credential.response.getAuthenticatorData());
  const enabled = prf?.enabled === true;
  results.credentials.push({ id: hex(credential.rawId), run: results.run, provider: info.provider, removed: false });
  const details = {
    summary: enabled ? 'PRF ENABLED' : 'PRF NOT ENABLED',
    prfEnabled: prf?.enabled ?? null,
    ...info,
    attachment: credential.authenticatorAttachment,
    transports: credential.response.getTransports?.() ?? [],
    prfBytesAtCreate: Boolean(prf?.results?.first),
  };
  if (!enabled) fail('Create passkey', details);
  verdict('Create passkey', 'PASS', details);
}

async function firstGet() {
  needCredential();
  const { summary } = await getPrf(true);
  current().hash = summary?.hash;
  const ok = summary && summary.length === 32 && !summary.allZero;
  if (!ok) fail('Unlock, first time', { summary: 'NO USABLE PRF BYTES', prf: summary });
  verdict('Unlock, first time', 'PASS', { summary: 'PRF BYTES RETURNED', prf: summary });
}

async function secondGet() {
  needCredential();
  const { summary } = await getPrf(true);
  const same = Boolean(summary) && summary.hash === current().hash;
  if (!same) fail('Unlock, second time', { summary: 'BYTES DIFFER', prf: summary, firstHash: current().hash });
  verdict('Unlock, second time', 'PASS', { summary: 'SAME BYTES', prf: summary, firstHash: current().hash });
}

// For a synced passkey on a second device, or one on a phone: nothing here has to know its id.
async function anyPasskey() {
  const { id, summary } = await getPrf(false);
  const known = results.credentials.find((c) => c.id === id);
  const ok = summary && summary.length === 32 && !summary.allZero;
  const matches = known?.hash ? summary?.hash === known.hash : null;
  const details = { prf: summary, credentialId: id, createdInThisBrowser: Boolean(known), matchesEarlierHash: matches };
  if (!ok) fail('Unlock with any saved passkey', { summary: 'NO USABLE PRF BYTES', ...details });
  if (matches === false) fail('Unlock with any saved passkey', { summary: 'BYTES DIFFER', ...details });
  verdict('Unlock with any saved passkey', 'PASS', { summary: 'PRF BYTES RETURNED', ...details });
}

// Finds what to remove from the saved list, not from memory, so it still works after a reload.
async function removePasskeys() {
  const toRemove = results.credentials.filter((c) => !c.removed);
  const signal = PublicKeyCredential.signalUnknownCredential;
  if (!signal) {
    verdict('Remove test passkeys', 'INFO', { summary: 'REMOVE BY HAND', names: toRemove.map((c) => `${SPIKE_NAME}-run-${c.run}`) });
    return;
  }
  for (const c of toRemove) {
    await PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: toBase64Url(c.id) });
    c.removed = true;
  }
  verdict('Remove test passkeys', 'INFO', { summary: 'ASKED PROVIDER TO REMOVE', count: toRemove.length, note: `Some providers ignore this. Anything named ${SPIKE_NAME} is safe to delete by hand.` });
}

// ---------- guided steps ----------
const STEPS = [
  { label: '1. Check this browser', run: checkSupport },
  {
    label: '2. Create a test passkey',
    hint: 'Pick the provider to test in the browser’s dialog.',
    run: createPasskey,
    alt: 'Already synced here from another device',
    altTo: 4,
  },
  { label: '3. Unlock', run: firstGet },
  { label: '4. Unlock again', run: secondGet },
  { label: '5. Unlock with any saved passkey', hint: 'Pick the same passkey again. On a second device, pick the synced one.', run: anyPasskey },
  {
    label: '6. Remove the test passkeys',
    run: removePasskeys,
    alt: 'Keep for testing on another device',
    altTo: 6,
  },
];

function getStep() {
  try {
    return Math.min(Math.max(parseInt(localStorage.getItem(`${KEY}.step`) || '0', 10) || 0, 0), STEPS.length);
  } catch {
    return 0;
  }
}
function setStep(n) {
  try {
    localStorage.setItem(`${KEY}.step`, String(n));
  } catch {
    /* the position is then lost on reload; results are unaffected */
  }
}

let failed = false;

async function advance(i, how) {
  const step = STEPS[i];
  try {
    if (how === 'alt') {
      verdict(step.label, 'INFO', { summary: step.alt });
      setStep(step.altTo);
    } else {
      await step.run();
      setStep(i + 1);
    }
    failed = false;
  } catch (e) {
    // A failed step stays current. The error name tells cancelled from unsupported.
    if (!(e instanceof Reported)) verdict(step.label, 'FAIL', { summary: e?.name ?? 'ERROR', error: String(e?.message ?? e) });
    failed = true;
  }
  renderWizard();
}

function renderWizard() {
  const cur = getStep();
  $('wizFailed').hidden = !failed;
  const ol = $('wiz');
  ol.textContent = '';
  STEPS.forEach((step, i) => {
    const li = document.createElement('li');
    const buttons = [[step.label, 'run']];
    if (step.alt) buttons.push([step.alt, 'alt']);
    for (const [text, how] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.disabled = i !== cur;
      b.addEventListener('click', () => advance(i, how));
      li.appendChild(b);
    }
    const note = document.createElement('span');
    note.textContent = i < cur ? ' ✓' : i === cur && step.hint ? ` ${step.hint}` : '';
    li.appendChild(note);
    ol.appendChild(li);
  });
  $('wizDone').hidden = cur < STEPS.length;
}

// ---------- copy, restore ----------
async function copy() {
  save();
  const text = JSON.stringify(results, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    log('results copied to clipboard');
  } catch {
    window.prompt('Copy the results JSON', text);
  }
}

function restore() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(`${KEY}.results`) || 'null');
  } catch {
    /* ignore a corrupt save */
  }
  if (!saved || typeof saved.experiments !== 'object') return;
  Object.assign(results, { startedAt: saved.startedAt, run: saved.run || 1, credentials: saved.credentials || [], experiments: saved.experiments, log: saved.log || [] });
  for (const [name, { status, ...details }] of Object.entries(results.experiments)) renderRow(name, status, details);
  $('log').textContent = results.log.join('\n') + (results.log.length ? '\n' : '');
  log(`restored ${Object.keys(results.experiments).length} saved results after a reload`);
}

$('wizReset').addEventListener('click', () => {
  results.run += 1;
  save();
  setStep(0);
  failed = false;
  renderWizard();
});
$('copy').addEventListener('click', copy);
restore();
renderWizard();
