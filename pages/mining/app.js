/* Pearl Mining Calculator — zero-dependency static app.
 *
 * Emission math mirrors upstream `CalcBlockSubsidy` in
 * node/blockchain/validate.go EXACTLY (BigInt integer arithmetic):
 *   subsidy(h) = TOTAL_SUPPLY * EMISSION_CONSTANT /
 *                ((h + EC) * (h - 1 + EC))          (grains; h=0 -> 0)
 *   TOTAL_SUPPLY = 2_100_000_000 PRL = 2100000000 * 1e8 grains
 *   EMISSION_CONSTANT = (4*365*24*3600) / 194 = 650226   (mainnet & testnets:
 *     TargetTimePerBlock is 194s on all networks, node/chaincfg/params.go)
 * Verified: h=1 -> 3229.64134063, h=650226 -> 807.41219776,
 *           h=1300452 -> 358.84977369, h=3251130 -> 89.71242042
 *
 * Cumulative supply closed form (telescoping sum, matches upstream
 * emission_test.go):  supply(h) = TOTAL * h / (h + EC)
 */
(function () {
  'use strict';

  /* ---------- exact emission math ---------- */
  var GRAINS_PER_PRL = 100000000n;
  var TOTAL_SUPPLY_GRAINS = 2100000000n * GRAINS_PER_PRL;
  var EMISSION_CONSTANT = 650226n; // (4*365*24*3600)/194, integer division
  var BLOCK_SECS = 194;
  var BLOCKS_PER_DAY = 86400 / BLOCK_SECS; // ~445.36

  function subsidyGrains(h) {
    if (!h || h <= 0) return 0n;
    var H = BigInt(Math.floor(h));
    return (TOTAL_SUPPLY_GRAINS * EMISSION_CONSTANT) /
      ((H + EMISSION_CONSTANT) * (H - 1n + EMISSION_CONSTANT));
  }
  function subsidyPrl(h) { return Number(subsidyGrains(h)) / 1e8; }
  function cumulativePrl(h) { // closed form; float is fine for display/chart
    var H = Number(h);
    return 2100000000 * H / (H + 650226);
  }

  /* ---------- dom helpers ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    height: $('inHeight'), hash: $('inHash'), hashUnit: $('inHashUnit'),
    netHash: $('inNetHash'), netHashUnit: $('inNetHashUnit'),
    price: $('inPrice'), watts: $('inWatts'), kwh: $('inKwh'),
    calcErr: $('calcErr'), nodeErr: $('nodeErr'),
    conn: $('connBadge'),
    heightEcho: $('outHeightEcho'), subsidy: $('outSubsidy'),
    share: $('outShare'), blocksDay: $('outBlocksDay'),
    prlDay: $('outPrlDay'), prlWeek: $('outPrlWeek'),
    prlMonth: $('outPrlMonth'), prlYear: $('outPrlYear'),
    usdBlock: $('usdBlock'), usdDay: $('outUsdDay'), usdMonth: $('outUsdMonth'),
    costMonth: $('outCostMonth'), profitMonth: $('outProfitMonth'),
    breakEven: $('outBreakEven')
  };

  function fmt(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toLocaleString('en-US', {
      minimumFractionDigits: digits === undefined ? 2 : digits,
      maximumFractionDigits: digits === undefined ? 2 : digits
    });
  }
  function fmtInt(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  }
  function num(id) {
    var v = parseFloat($(id).value);
    return isFinite(v) && v >= 0 ? v : NaN;
  }
  function showErr(el, msg) {
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = msg;
  }
  var UNITS = [[1e15, 'PH/s'], [1e12, 'TH/s'], [1e9, 'GH/s'], [1e6, 'MH/s'], [1e3, 'KH/s'], [1, 'H/s']];
  function fmtHash(hps) {
    if (!isFinite(hps) || hps < 0) return '—';
    for (var i = 0; i < UNITS.length; i++) {
      if (hps >= UNITS[i][0]) return fmt(hps / UNITS[i][0]) + ' ' + UNITS[i][1];
    }
    return fmt(hps) + ' H/s';
  }

  /* ---------- calculator ---------- */
  function recalc() {
    var h = num('inHeight');
    var hash = num('inHash') * parseFloat(els.hashUnit.value);
    var netHash = num('inNetHash') * parseFloat(els.netHashUnit.value);
    var price = num('inPrice');
    var watts = num('inWatts');
    var kwh = num('inKwh');

    showErr(els.calcErr, '');

    if (!isFinite(h) || h < 1) {
      els.heightEcho.textContent = '—';
      els.subsidy.textContent = 'Enter a block height';
      ['share','blocksDay','prlDay','prlWeek','prlMonth','prlYear'].forEach(function (k) { els[k].textContent = '—'; });
      els.usdBlock.hidden = true;
      drawChart();
      return;
    }
    var hi = Math.floor(h);
    els.heightEcho.textContent = '#' + fmtInt(hi);
    var sub = subsidyPrl(hi);
    els.subsidy.textContent = fmt(sub) + ' PRL';

    var share = (isFinite(hash) && isFinite(netHash) && netHash > 0 && hash >= 0)
      ? Math.min(hash / netHash, 1) : NaN;
    var prlDay = isFinite(share) ? sub * BLOCKS_PER_DAY * share : NaN;

    els.share.textContent = isFinite(share) ? fmt(share * 100, 4) + ' %' : '—';
    els.blocksDay.textContent = isFinite(share) ? fmt(BLOCKS_PER_DAY * share, 3) : '—';
    els.prlDay.textContent = isFinite(prlDay) ? fmt(prlDay) : '—';
    els.prlWeek.textContent = isFinite(prlDay) ? fmt(prlDay * 7) : '—';
    els.prlMonth.textContent = isFinite(prlDay) ? fmt(prlDay * 30) : '—';
    els.prlYear.textContent = isFinite(prlDay) ? fmt(prlDay * 365.25, 0) : '—';

    if (isFinite(price) && price > 0 && isFinite(prlDay)) {
      els.usdBlock.hidden = false;
      var usdDay = prlDay * price;
      els.usdDay.textContent = '$' + fmt(usdDay);
      els.usdMonth.textContent = '$' + fmt(usdDay * 30);
      var costMonth = (isFinite(watts) && isFinite(kwh) && watts > 0)
        ? (watts / 1000) * 24 * 30 * kwh : 0;
      els.costMonth.textContent = '$' + fmt(costMonth);
      var profit = usdDay * 30 - costMonth;
      els.profitMonth.textContent = (profit < 0 ? '−$' : '$') + fmt(Math.abs(profit));
      els.profitMonth.style.color = profit < 0 ? 'var(--bad)' : 'var(--accent-3)';
      // break-even: monthly revenue == monthly power cost  =>  price* = cost / prl30
      els.breakEven.textContent = prlDay * 30 > 0
        ? '$' + fmt(costMonth / (prlDay * 30), 4) : '—';
    } else {
      els.usdBlock.hidden = true;
    }
    drawChart();
  }
  ['inHeight','inHash','inHashUnit','inNetHash','inNetHashUnit','inPrice','inWatts','inKwh']
    .forEach(function (id) {
      $(id).addEventListener('input', recalc);
      $(id).addEventListener('change', recalc);
    });

  /* ---------- chart ---------- */
  var chartMode = 'subsidy';
  var canvas = $('chart');
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      chartMode = t.getAttribute('data-chart');
      drawChart();
    });
  });

  function drawChart() {
    if (!canvas || !canvas.getContext) return;
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth || 900;
    var H = parseInt(canvas.getAttribute('height'), 10) || 300;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) return; // canvas 2d unavailable (e.g. headless test env)
    ctx.scale(dpr, dpr);

    var padL = 64, padR = 16, padT = 18, padB = 34;
    var iw = W - padL - padR, ih = H - padT - padB;
    var H_MAX = 2000000; // ~12.3 years of blocks
    var N = 360;

    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px ui-monospace, Menlo, monospace';

    function xPos(h) { return padL + (h / H_MAX) * iw; }

    if (chartMode === 'subsidy') {
      // log-scale subsidy curve
      var lo = 1, hi = 4000; // log10 bounds
      function yPos(v) {
        var t = (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
        return padT + ih - t * ih;
      }
      // gridlines: 1000, 100, 10, 1
      ctx.strokeStyle = 'rgba(35,49,84,0.9)'; ctx.fillStyle = '#94a2c0';
      ctx.lineWidth = 1; ctx.textAlign = 'right';
      [1000, 100, 10, 1].forEach(function (g) {
        var y = yPos(g);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillText(g >= 1000 ? (g / 1000) + 'k' : String(g), padL - 8, y + 4);
      });
      ctx.textAlign = 'center';
      for (var yr = 0; yr <= 12; yr += 2) {
        var hx = yr * 162556;
        if (hx > H_MAX) break;
        ctx.fillText('~' + yr + 'y', xPos(hx), H - 12);
      }
      // area + line
      var grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
      grad.addColorStop(0, 'rgba(125,211,252,0.45)');
      grad.addColorStop(1, 'rgba(125,211,252,0.02)');
      ctx.beginPath();
      ctx.moveTo(xPos(1), yPos(subsidyPrl(1)));
      for (var i = 1; i <= N; i++) {
        var hh = 1 + (H_MAX - 1) * i / N;
        ctx.lineTo(xPos(hh), yPos(subsidyPrl(hh)));
      }
      ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineTo(xPos(H_MAX), padT + ih); ctx.lineTo(xPos(1), padT + ih); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.fillStyle = '#94a2c0'; ctx.textAlign = 'left';
      ctx.fillText('PRL / block (log scale)', padL + 6, padT + 14);
    } else {
      // linear cumulative supply
      var maxS = 2100000000;
      function y2(v) { return padT + ih - (v / maxS) * ih; }
      ctx.strokeStyle = 'rgba(35,49,84,0.9)'; ctx.fillStyle = '#94a2c0';
      ctx.lineWidth = 1; ctx.textAlign = 'right';
      [0.5, 1, 1.5, 2].forEach(function (b) {
        var y = y2(b * 1e9);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillText(b + 'B', padL - 8, y + 4);
      });
      ctx.textAlign = 'center';
      for (var yr2 = 0; yr2 <= 12; yr2 += 2) {
        var hx2 = yr2 * 162556;
        if (hx2 > H_MAX) break;
        ctx.fillText('~' + yr2 + 'y', xPos(hx2), H - 12);
      }
      // 50% line at emission constant
      var y50 = y2(maxS / 2);
      ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(252,211,77,0.55)';
      ctx.beginPath(); ctx.moveTo(padL, y50); ctx.lineTo(W - padR, y50); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fcd34d'; ctx.textAlign = 'left';
      ctx.fillText('1.05B (50%) @ h=650,226', xPos(650226) + 8, y50 - 8);
      var grad2 = ctx.createLinearGradient(0, padT, 0, padT + ih);
      grad2.addColorStop(0, 'rgba(196,181,253,0.45)');
      grad2.addColorStop(1, 'rgba(196,181,253,0.02)');
      ctx.beginPath();
      ctx.moveTo(xPos(1), y2(cumulativePrl(1)));
      for (var j = 1; j <= N; j++) {
        var hhj = 1 + (H_MAX - 1) * j / N;
        ctx.lineTo(xPos(hhj), y2(cumulativePrl(hhj)));
      }
      ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineTo(xPos(H_MAX), padT + ih); ctx.lineTo(xPos(1), padT + ih); ctx.closePath();
      ctx.fillStyle = grad2; ctx.fill();
      ctx.fillStyle = '#94a2c0'; ctx.textAlign = 'left';
      ctx.fillText('Cumulative PRL (of 2.1B max)', padL + 6, padT + 14);
    }

    // current-height marker (from calculator input)
    var hv = parseFloat(els.height.value);
    if (isFinite(hv) && hv >= 1 && hv <= H_MAX) {
      var mx = xPos(hv);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(110,231,183,0.7)';
      ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + ih); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#6ee7b7'; ctx.textAlign = mx > W - 120 ? 'right' : 'left';
      ctx.fillText('h=' + fmtInt(hv), mx + (mx > W - 120 ? -6 : 6), padT + 12);
    }
  }
  window.addEventListener('resize', drawChart);

  /* ---------- milestone table (computed live, exact formula) ---------- */
  var MILESTONES = [
    { h: 1,       note: 'First subsidy block' },
    { h: 99000,   note: 'Salted-seed hard fork (mainnet)' },
    { h: 100000,  note: '' },
    { h: 650226,  note: 'Emission constant — ~50% issued' },
    { h: 1300452, note: '2 × emission constant' },
    { h: 1950678, note: '3 × emission constant' },
    { h: 3251130, note: '5 × emission constant' }
  ];
  function yrsAfterGenesis(h) { return (h * BLOCK_SECS) / (365.25 * 86400); }
  var tbody = $('milestoneBody');
  MILESTONES.forEach(function (m) {
    var tr = document.createElement('tr');
    var date = yrsAfterGenesis(m.h);
    tr.innerHTML = '<td class="mono">' + fmtInt(m.h) + '</td>' +
      '<td>≈ ' + fmt(date, 1) + ' yr after genesis</td>' +
      '<td class="mono">' + fmt(subsidyPrl(m.h)) + '</td>' +
      '<td>' + m.note + '</td>';
    tbody.appendChild(tr);
  });

  /* ---------- live node (pearld JSON-RPC) ---------- */
  var LS_KEY = 'pearl-mining-rpc';
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }
  var settings = loadSettings();
  $('rpcUrl').value = settings.url || '';
  $('rpcUser').value = settings.user || '';
  $('rpcPass').value = settings.pass || '';

  function setConn(state, text) {
    els.conn.className = 'conn' + (state ? ' ' + state : '');
    els.conn.innerHTML = '&#9679; ' + text;
  }

  function rpc(method, params) {
    var s = loadSettings();
    if (!s.url) return Promise.reject(new Error('No RPC endpoint configured — enter one above.'));
    var headers = { 'Content-Type': 'application/json' };
    if (s.user) {
      var creds = (typeof btoa === 'function') ? btoa(s.user + ':' + (s.pass || '')) : '';
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
          ' — is pearld running (rpcuser/rpcpass set) and does it allow CORS from this page?');
      }
      throw e;
    });
  }

  function pickUnit(hps) { // choose a unit so the displayed value stays readable
    for (var i = 0; i < UNITS.length; i++) {
      if (hps >= UNITS[i][0]) return UNITS[i];
    }
    return UNITS[UNITS.length - 1];
  }
  function setSelect(sel, value) {
    for (var i = 0; i < sel.options.length; i++) {
      if (String(sel.options[i].value) === String(value)) { sel.selectedIndex = i; return; }
    }
  }

  $('fetchBtn').addEventListener('click', function () {
    showErr(els.nodeErr, '');
    saveSettings({ url: $('rpcUrl').value.trim(), user: $('rpcUser').value, pass: $('rpcPass').value });
    setConn('', 'connecting…');
    Promise.all([rpc('getblockcount'), rpc('getmininginfo')]).then(function (res) {
      var height = res[0], mi = res[1] || {};
      $('nHeight').textContent = fmtInt(height);
      $('nHashps').textContent = fmtHash(mi.networkhashps);
      $('nDiff').textContent = fmtInt(mi.difficulty);
      var liveSub = subsidyPrl(height);
      $('nSubsidy').textContent = fmt(liveSub) + ' PRL';
      // feed the calculator
      els.height.value = height;
      if (isFinite(mi.networkhashps) && mi.networkhashps > 0) {
        var u = pickUnit(mi.networkhashps);
        els.netHash.value = (mi.networkhashps / u[0]).toPrecision(4).replace(/\.?0+$/, '');
        setSelect(els.netHashUnit, String(u[0]));
      }
      setConn('ok', 'live — node connected');
      recalc();
    }).catch(function (e) {
      setConn('bad', 'connection failed');
      showErr(els.nodeErr, e.message);
    });
  });

  $('fillLiveBtn').addEventListener('click', function () {
    document.getElementById('node').scrollIntoView({ behavior: 'smooth' });
    $('fetchBtn').focus();
  });

  ['rpcUrl', 'rpcUser', 'rpcPass'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      saveSettings({ url: $('rpcUrl').value.trim(), user: $('rpcUser').value, pass: $('rpcPass').value });
    });
  });

  /* ---------- donate copy ---------- */
  $('copyAddr').addEventListener('click', function () {
    var t = $('donateAddr').textContent.trim();
    function done(btn, label) {
      var old = btn.textContent;
      btn.textContent = label;
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    var btn = $('copyAddr');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { done(btn, 'Copied'); },
        function () { done(btn, 'Copy failed'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(btn, 'Copied'); }
      catch (e) { done(btn, 'Copy failed'); }
      document.body.removeChild(ta);
    }
  });

  /* ---------- init ---------- */
  if (settings.url) setConn('', 'node configured');
  recalc();
})();
