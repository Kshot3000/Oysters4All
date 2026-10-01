/* Pearl Block Explorer — zero-dependency JSON-RPC client for pearld.
 * Talks to getinfo / getblockcount / getbestblockhash / getblockhash / getblock.
 * Settings persist in localStorage; nothing leaves the browser except RPC calls
 * to the endpoint the user configured.
 */
(function () {
  'use strict';

  var LS_KEY = 'pearl-explorer-rpc';
  var $ = function (id) { return document.getElementById(id); };

  var connBadge = $('connBadge');
  var demoHint = $('demoHint');
  var statusErr = $('statusErr');
  var lookupErr = $('lookupErr');
  var settingsErr = $('settingsErr');

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }

  var settings = loadSettings();
  $('rpcUrl').value = settings.url || '';
  $('rpcUser').value = settings.user || '';
  $('rpcPass').value = settings.pass || '';

  function setConn(state, text) {
    connBadge.className = 'conn' + (state ? ' ' + state : '');
    connBadge.textContent = '\u25CF ' + text;
  }
  function showErr(el, msg) {
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = msg;
  }

  function rpc(method, params) {
    var s = settings;
    if (!s.url) return Promise.reject(new Error('No RPC endpoint configured — set one under Settings.'));
    var headers = { 'Content-Type': 'application/json' };
    if (s.user) {
      var creds = typeof btoa === 'function' ? btoa(s.user + ':' + (s.pass || '')) : '';
      if (creds) headers.Authorization = 'Basic ' + creds;
    }
    return fetch(s.url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: method, method: method, params: params || [] })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' from RPC endpoint');
      return res.json();
    }).then(function (body) {
      if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
      return body.result;
    }).catch(function (e) {
      if (e instanceof TypeError) {
        throw new Error('Cannot reach ' + s.url +
          ' — is pearld running and does it allow CORS from this page? See Settings.');
      }
      throw e;
    });
  }

  function fmtTime(ts) {
    if (typeof ts !== 'number') return '—';
    return new Date(ts * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
  }
  function fmtNum(n) {
    return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
  }

  function refreshStatus() {
    showErr(statusErr, '');
    Promise.all([
      rpc('getblockcount'),
      rpc('getbestblockhash'),
      rpc('getinfo'),
    ]).then(function (results) {
      var count = results[0], bestHash = results[1], info = results[2];
      $('stHeight').textContent = fmtNum(count);
      $('stHash').textContent = bestHash || '—';
      $('stChain').textContent = info && info.testnet ? 'testnet' : 'mainnet';
      $('stDiff').textContent = info && typeof info.difficulty === 'number' ? String(info.difficulty) : '—';
      $('stPeers').textContent = info && typeof info.connections === 'number' ? String(info.connections) : '—';
      $('stHeaders').textContent = info && typeof info.protocolversion === 'number' ? String(info.protocolversion) : '—';
      setConn('on', 'connected');
      demoHint.classList.add('ok');
      demoHint.innerHTML = '<strong>Connected:</strong> live data from <span class="mono">' +
        escapeHtml(settings.url) + '</span>';
    }).catch(function (e) {
      if (/No RPC endpoint/.test(e.message)) {
        setConn('', 'not connected');
        showErr(statusErr, e.message);
        return;
      }
      setConn('err', 'connection failed');
      showErr(statusErr, e.message);
      // a failed refresh must not leave a stale "Connected:" hint behind
      demoHint.classList.remove('ok');
      demoHint.innerHTML = '<strong>Not connected:</strong> the last refresh failed — ' +
        'fix the endpoint under Settings and try again.';
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function lookup(q) {
    showErr(lookupErr, '');
    $('blockDetail').hidden = true;
    var isHeight = /^\d+$/.test(q);
    var hashPromise = isHeight
      ? rpc('getblockhash', [parseInt(q, 10)])
      : Promise.resolve(q);
    hashPromise.then(function (hash) {
      return rpc('getblock', [hash, 1]);
    }).then(function (block) {
      $('bdHeight').textContent = fmtNum(block.height);
      $('bdHash').textContent = block.hash || '—';
      $('bdPrev').textContent = block.previousblockhash || '(genesis)';
      $('bdTime').textContent = fmtTime(block.time);
      var txs = block.tx || [];
      $('bdTxCount').textContent = fmtNum(block.nTx != null ? block.nTx : txs.length);
      var size = block.vsize != null ? block.vsize : block.size;
      $('bdSize').textContent = size != null ? fmtNum(size) + ' bytes' : '—';
      $('bdMerkle').textContent = block.merkleroot || '—';
      $('bdNonce').textContent = [block.nonce, block.bits].filter(function (v) { return v != null; }).join(' / ') || '—';
      $('txCount').textContent = '(' + txs.length + ' shown)';
      var list = $('txList');
      list.innerHTML = '';
      txs.slice(0, 200).forEach(function (tx, i) {
        var li = document.createElement('li');
        li.textContent = (typeof tx === 'string' ? tx : (tx.txid || JSON.stringify(tx))) + (i === 0 ? '  ← coinbase' : '');
        list.appendChild(li);
      });
      $('blockDetail').hidden = false;
      $('blockDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      showErr(lookupErr, 'Lookup failed: ' + e.message);
    });
  }

  // wire up
  $('refreshBtn').addEventListener('click', refreshStatus);
  $('lookupForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('lookupInput').value.trim();
    if (q) lookup(q);
  });
  $('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    showErr(settingsErr, '');
    var url = $('rpcUrl').value.trim();
    if (!url) {
      showErr(settingsErr, 'Enter an RPC endpoint URL, e.g. http://127.0.0.1:44107');
      return;
    }
    settings = { url: url, user: $('rpcUser').value.trim(), pass: $('rpcPass').value };
    saveSettings(settings);
    setConn('', 'connecting…');
    refreshStatus();
  });
  $('copyBtn').addEventListener('click', function () {
    var addr = $('donateAddr').textContent.trim();
    var done = function () {
      $('copyBtn').textContent = 'Copied!';
      setTimeout(function () { $('copyBtn').textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(addr).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = addr; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      document.body.removeChild(ta); done();
    }
  });

  if (settings.url) refreshStatus();
})();
