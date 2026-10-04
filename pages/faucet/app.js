/* Pearl Testnet Faucet frontend — zero dependencies.
 *
 * Validates Pearl bech32 segwit addresses locally (BIP-173 style), then POSTs
 * the drip request to the configured faucet backend. Never fabricates results:
 * every success/error shown comes from the backend's real HTTP response.
 */
'use strict';

/* ---------- bech32m (BIP-350) ----------
 * Pearl addresses are bech32m-encoded, witness version 1+ only (Taproot, P2MR);
 * v0 addresses are rejected. Source: upstream node/btcutil/address.go
 * (decodeSegWitAddress: "Pearl only supports witness versions 1+ (bech32m).
 * Version 0 (bech32) addresses are rejected."). */
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Decode a bech32m address. Returns { hrp, version, program } or throws Error.
 * Witness version must be 1..16; program 2..40 bytes (upstream rules).
 */
function bech32Decode(addr) {
  if (typeof addr !== 'string') throw new Error('address must be a string');
  const s = addr.trim();
  if (s.length < 8 || s.length > 90) throw new Error('invalid length');
  const hasLower = s !== s.toUpperCase();
  const hasUpper = s !== s.toLowerCase();
  if (hasLower && hasUpper) throw new Error('mixed case not allowed');
  const lower = s.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('missing separator');
  const hrp = lower.slice(0, pos);
  const dataPart = lower.slice(pos + 1);
  const data = [];
  for (const ch of dataPart) {
    const d = BECH32_CHARSET.indexOf(ch);
    if (d === -1) throw new Error('invalid bech32 character');
    data.push(d);
  }
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== BECH32M_CONST) {
    throw new Error('checksum mismatch (not valid bech32m)');
  }
  const payload = data.slice(0, -6);
  if (payload.length < 1) throw new Error('empty payload');
  const version = payload[0];
  // Pearl rejects witness v0 entirely; only v1+ (Taproot, P2MR).
  if (version < 1 || version > 16) throw new Error('unsupported witness version (Pearl requires v1+)');
  // convert 5-bit groups back to 8-bit bytes
  let acc = 0, bits = 0;
  const program = [];
  for (let i = 1; i < payload.length; i++) {
    acc = (acc << 5) | payload[i];
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      program.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) throw new Error('invalid padding');
  if (program.length < 2 || program.length > 40) throw new Error('invalid program length');
  return { hrp, version, program: new Uint8Array(program) };
}

const NETWORK_HRP = { testnet: 'tprl', testnet2: 'tprl' };

function validatePearlAddress(addr, network) {
  const expected = NETWORK_HRP[network];
  const dec = bech32Decode(addr);
  if (dec.hrp !== expected) {
    throw new Error(`wrong network prefix: got "${dec.hrp}", expected "${expected}" for ${network}`);
  }
  return dec;
}

/** Escape for innerHTML interpolation — the backend base URL is free-text
 * user input and status fields come from that backend's JSON, so both must
 * render as text (the URL previously got only a partial `<`-escape and the
 * network name none at all). Top-level so node tests can pin it directly. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- UI wiring (browser only; pure functions above stay testable) ---------- */
if (typeof document !== 'undefined') {
const $ = (id) => document.getElementById(id);
const BACKEND_KEY = 'pearl-faucet-backend';
const DEFAULT_BACKEND = 'http://127.0.0.1:8090';

const dripForm = $('dripForm');
const addrInput = $('addrInput');
const addrNote = $('addrNote');
const backendInput = $('backendInput');
const networkSel = $('networkSel');
const dripBtn = $('dripBtn');
const formErr = $('formErr');
const resultBox = $('result');
const resultTitle = $('resultTitle');
const resultBody = $('resultBody');
const copyTxBtn = $('copyTxBtn');
const connBadge = $('connBadge');
const backendHint = $('backendHint');

backendInput.value = localStorage.getItem(BACKEND_KEY) || DEFAULT_BACKEND;

function backendUrl() {
  return (backendInput.value || DEFAULT_BACKEND).trim().replace(/\/+$/, '');
}

function showFormError(msg) {
  formErr.textContent = msg;
  formErr.hidden = !msg;
}

function showResult(ok, title, body, txid) {
  resultBox.hidden = false;
  resultBox.className = 'result ' + (ok ? 'success' : 'failure');
  resultTitle.textContent = title;
  resultBody.textContent = body;
  copyTxBtn.hidden = !txid;
  if (txid) copyTxBtn.dataset.txid = txid;
}

function setConn(ok, text) {
  connBadge.textContent = '\u25CF ' + text;
  connBadge.classList.toggle('ok', !!ok);
}

// Live address validation feedback
addrInput.addEventListener('input', () => {
  const v = addrInput.value.trim();
  addrInput.classList.remove('invalid');
  addrNote.className = 'field-note';
  if (!v) {
    addrNote.textContent = 'Bech32m segwit address (witness v1+, Taproot) on the selected network. Validated locally before sending.';
    return;
  }
  try {
    const dec = validatePearlAddress(v, networkSel.value);
    addrNote.textContent = `Valid ${dec.hrp} address — witness v${dec.version}, ${dec.program.length}-byte program.`;
    addrNote.classList.add('good');
  } catch (e) {
    addrInput.classList.add('invalid');
    addrNote.textContent = 'Invalid: ' + e.message;
    addrNote.classList.add('bad');
  }
});
networkSel.addEventListener('change', () => addrInput.dispatchEvent(new Event('input')));

async function refreshStatus() {
  const base = backendUrl();
  $('stBackend').textContent = base;
  try {
    const res = await fetch(base + '/api/status');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const st = await res.json();
    $('stNetwork').textContent = st.network || '?';
    $('stMaxDrip').textContent = (st.maxDripPRL ?? '?') + ' tPRL';
    $('stCooldown').textContent = (st.dripCooldownHours ?? '?') + 'h';
    $('stDailyCap').textContent = (st.dailyCapPRL ?? '?') + ' tPRL';
    $('stWallet').textContent = st.walletConfigured ? 'yes' : 'no (drips will fail)';
    $('statusErr').hidden = true;
    setConn(true, 'backend connected');
    backendHint.classList.add('ok');
    backendHint.innerHTML = '<strong>Backend connected.</strong> Requests below go to <code>' +
      esc(base) + '</code> on ' + esc(st.network || 'testnet') + '.';
  } catch (e) {
    $('statusErr').textContent = 'Could not reach the faucet backend at ' + base +
      ' (' + e.message + '). Start one — see "Run your own" below.';
    $('statusErr').hidden = false;
    setConn(false, 'backend unreachable');
  }
}

dripForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showFormError('');
  resultBox.hidden = true;

  const network = networkSel.value;
  const address = addrInput.value.trim();
  try {
    validatePearlAddress(address, network);
  } catch (e) {
    showFormError('Address invalid: ' + e.message);
    return;
  }

  const base = backendUrl();
  localStorage.setItem(BACKEND_KEY, base);
  dripBtn.disabled = true;
  dripBtn.textContent = 'Requesting\u2026';
  try {
    const res = await fetch(base + '/api/drip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, network }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      showResult(true, 'Drip sent!',
        `Transaction ${data.txid} broadcast on Pearl ${network}. ` +
        `It needs confirmations before the balance is spendable (coinbase-style maturity does not apply, but allow a few blocks).`,
        data.txid);
    } else {
      const msg = data.error || ('backend returned HTTP ' + res.status);
      const detail = data.detail ? ' — ' + data.detail : '';
      showResult(false, 'Drip failed', msg + detail, null);
    }
  } catch (e) {
    showResult(false, 'Request failed',
      'Could not reach the faucet backend at ' + base + ' (' + e.message + '). ' +
      'Is it running? See "Run your own" below.', null);
  } finally {
    dripBtn.disabled = false;
    dripBtn.textContent = 'Request tPRL';
    refreshStatus();
  }
});

$('refreshBtn').addEventListener('click', refreshStatus);
backendInput.addEventListener('change', () => {
  localStorage.setItem(BACKEND_KEY, backendUrl());
  refreshStatus();
});
copyTxBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(copyTxBtn.dataset.txid || '');
    copyTxBtn.textContent = 'Copied!';
    setTimeout(() => { copyTxBtn.textContent = 'Copy txid'; }, 1500);
  } catch { /* clipboard unavailable */ }
});
$('copyDonateBtn').addEventListener('click', async () => {
  const btn = $('copyDonateBtn');
  try {
    await navigator.clipboard.writeText($('donateAddr').textContent.trim());
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy address'; }, 1500);
  } catch { /* clipboard unavailable */ }
});

refreshStatus();
addrInput.dispatchEvent(new Event('input'));
} // end browser-only UI wiring

// Expose for node-based unit tests (no-op in browsers without module systems)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bech32Decode, validatePearlAddress, esc };
}
