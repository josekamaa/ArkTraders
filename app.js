// script.js — Arktraders Hub Main Application Logic

/* ═══════════════════════════════════════════════════════
   DERIV API — FULL INTEGRATION
   App ID: 133647 | Domain: arktradershub.com
   ═══════════════════════════════════════════════════════ */
const APP_ID = 133647;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const OAUTH_URL = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}`;
const STORAGE_KEY = 'deriv_session';

/* ═══════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════ */
let socket = null;
let pingTimer = null;
let session = null; // { accounts:[{acct,token,currency}], activeIdx:0 }
let tickSub = null; // current chart tick subscription id
let chartTicks = []; // array of {quote, time}
let chartCtx = null;
let botRunning = false;
let botTimer = null;
let currentContract = null;
let bbStats = { total: 0, wins: 0, pl: 0, curStake: 0 };

// Public chart WebSocket (no login required)
let pubSocket = null;
let pubPing = null;

// Journal entries
let journalEntries = JSON.parse(localStorage.getItem('ark_journal') || '[]');

/* ═══════════════════════════════════════════════════════
   PUBLIC CHART WEBSOCKET
   ═══════════════════════════════════════════════════════ */
function connectPublicWS(symbol) {
  if (pubSocket) {
    pubSocket.close();
    pubSocket = null;
  }
  clearInterval(pubPing);
  chartTicks = [];
  drawChart();

  pubSocket = new WebSocket(WS_URL);
  pubSocket.onopen = () => {
    pubSocket.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    pubPing = setInterval(() => {
      if (pubSocket && pubSocket.readyState === WebSocket.OPEN)
        pubSocket.send(JSON.stringify({ ping: 1 }));
    }, 25000);
  };
  pubSocket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.msg_type === 'tick' && msg.tick) handleChartTick(msg.tick);
  };
  pubSocket.onerror = () => {
    setTimeout(() => connectPublicWS(document.getElementById('chart-symbol').value), 4000);
  };
  pubSocket.onclose = () => clearInterval(pubPing);
}

/* ═══════════════════════════════════════════════════════
   OAUTH HANDLERS
   ═══════════════════════════════════════════════════════ */
function derivLogin() {
  window.location.href = OAUTH_URL;
}

function derivLogout() {
  stopBot();
  if (socket) {
    socket.close();
    socket = null;
  }
  clearInterval(pingTimer);
  session = null;
  localStorage.removeItem(STORAGE_KEY);
  updateAuthUI(null);
  updateStatusBar(false, 'Disconnected — log in to connect');
}

function parseOAuthParams() {
  const p = new URLSearchParams(window.location.search);
  const accounts = [];
  let i = 1;
  while (p.has(`acct${i}`)) {
    accounts.push({
      acct: p.get(`acct${i}`),
      token: p.get(`token${i}`),
      currency: (p.get(`cur${i}`) || 'USD').toUpperCase()
    });
    i++;
  }
  return accounts.length ? accounts : null;
}

function saveSession(accounts) {
  const s = { accounts, activeIdx: 0 };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  return s;
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════
   UI HELPERS
   ═══════════════════════════════════════════════════════ */
function updateAuthUI(acctInfo) {
  const ad = document.getElementById('account-display');
  const lb = document.getElementById('login-buttons');
  if (acctInfo) {
    lb.style.display = 'none';
    ad.style.display = 'flex';
    const _ai = document.getElementById('acct-id');
    if (_ai) _ai.textContent = acctInfo.acct;
    const _ab = document.getElementById('acct-balance');
    if (_ab) _ab.textContent = acctInfo.balance != null
      ? `${parseFloat(acctInfo.balance).toFixed(2)} ${acctInfo.currency}`
      : acctInfo.currency || '';
  } else {
    lb.style.display = 'flex';
    ad.style.display = 'none';
  }
}

function updateStatusBar(connected, label) {
  const dot = document.getElementById('ws-dot');
  const txt = document.getElementById('ws-status');
  if (dot) dot.style.background = connected === true ? 'var(--green)' : connected === false ? 'var(--red)' : 'var(--amber)';
  if (txt) txt.textContent = label;
  const mobDot = document.getElementById('mob-ws-dot');
  const mobLabel = document.getElementById('mob-ws-label');
  if (mobDot) mobDot.style.background = dot ? dot.style.background : '';
  if (mobLabel) mobLabel.textContent = label;
}

function updateBalance(balance, currency) {
  const el = document.getElementById('acct-balance');
  if (el) el.textContent = `${parseFloat(balance).toFixed(2)} ${currency}`;
}

/* ═══════════════════════════════════════════════════════
   MAIN WEBSOCKET CONNECTION
   ═══════════════════════════════════════════════════════ */
function connectWS(token, acctObj) {
  if (socket) {
    socket.close();
    socket = null;
  }
  updateStatusBar(null, 'Connecting…');

  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    updateStatusBar(true, 'Connected to Deriv API');
    socket.send(JSON.stringify({ authorize: token }));
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 }));
    }, 25000);
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.msg_type === 'authorize') {
      if (msg.error) {
        updateStatusBar(false, 'Auth error: ' + msg.error.message);
        return;
      }
      const info = msg.authorize;
      const _aid = document.getElementById('acct-id');
      if (_aid) _aid.textContent = acctObj.acct;
      const _abd = document.getElementById('acct-balance');
      if (_abd) _abd.textContent = `${parseFloat(info.balance).toFixed(2)} ${info.currency}`;
      document.getElementById('login-buttons').style.display = 'none';
      document.getElementById('account-display').style.display = 'flex';
      socket.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      startTickSubscription(document.getElementById('chart-symbol').value);
    }

    if (msg.msg_type === 'balance' && msg.balance) {
      updateBalance(msg.balance.balance, msg.balance.currency);
      const rcBal = document.getElementById('rc-balance');
      if (rcBal && !rcBal.value) rcBal.value = parseFloat(msg.balance.balance).toFixed(2);
    }

    if (msg.msg_type === 'tick' && msg.tick) {
      handleChartTick(msg.tick);
    }

    if (msg.msg_type === 'proposal' && msg.proposal && botRunning) {
      if (msg.error) {
        setBotStatus('⚠️ ' + msg.error.message, false);
        return;
      }
      socket.send(JSON.stringify({ buy: msg.proposal.id, price: msg.proposal.ask_price }));
    }

    if (msg.msg_type === 'buy') {
      if (msg.error) {
        setBotStatus('❌ Buy error: ' + msg.error.message, false);
        return;
      }
      currentContract = msg.buy.contract_id;
      setBotStatus(`⏳ Contract #${currentContract} open — waiting for result…`, null);
      socket.send(JSON.stringify({ proposal_open_contract: 1, contract_id: currentContract, subscribe: 1 }));
    }

    if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
      const poc = msg.proposal_open_contract;
      if (poc.is_sold || poc.status === 'sold') {
        const won = poc.profit > 0;
        const profit = parseFloat(poc.profit);
        bbStats.total++;
        if (won) bbStats.wins++;
        bbStats.pl += profit;

        const strategy = document.getElementById('bb-strategy').value;
        const initStake = parseFloat(document.getElementById('bb-stake').value);
        if (strategy === 'martingale') {
          bbStats.curStake = won ? initStake : bbStats.curStake * 2;
        } else if (strategy === 'dalembert') {
          bbStats.curStake = won ? Math.max(initStake, bbStats.curStake - initStake) : bbStats.curStake + initStake;
        } else {
          bbStats.curStake = initStake;
        }

        updateBotStats();
        addTradeLogEntry(poc.contract_id, won, profit, poc.entry_spot, poc.exit_tick_display_value);
        setBotStatus(won ? `✅ WIN +$${Math.abs(profit).toFixed(2)}` : `❌ LOSS -$${Math.abs(profit).toFixed(2)}`, won);

        const sl = parseFloat(document.getElementById('bb-stoploss').value);
        const tp = parseFloat(document.getElementById('bb-takeprofit').value);
        if (bbStats.pl <= -sl) {
          stopBot('🛑 Stop Loss hit ($' + sl + ')');
          return;
        }
        if (bbStats.pl >= tp) {
          stopBot('🎯 Take Profit hit ($' + tp + ')');
          return;
        }

        if (botRunning) botTimer = setTimeout(placeNextTrade, 1500);
      }
    }

    if (msg.msg_type === 'ping') { /* ok */ }
  };

  socket.onerror = () => updateStatusBar(false, 'WebSocket error — check connection');

  socket.onclose = (e) => {
    clearInterval(pingTimer);
    updateStatusBar(false, e.wasClean ? 'Disconnected' : 'Connection lost — reload to retry');
  };
}

/* ═══════════════════════════════════════════════════════
   LIVE CHART FUNCTIONS
   ═══════════════════════════════════════════════════════ */
const MAX_TICKS = 80;

function startTickSubscription(symbol) {
  connectPublicWS(symbol);
}

function changeChartSymbol() {
  const sym = document.getElementById('chart-symbol').value;
  chartTicks = [];
  const _lp = document.getElementById('chart-live-price');
  if (_lp) _lp.textContent = '—';
  const _pc = document.getElementById('chart-price-change');
  if (_pc) _pc.textContent = '—';
  const _tt = document.getElementById('tick-table');
  if (_tt) _tt.innerHTML = '';
  const frame = document.getElementById('deriv-chart-frame');
  if (frame) frame.src = `https://charts.deriv.com/?symbol=${sym}&granularity=0&chart_type=mountain`;
  connectPublicWS(sym);
}

function clearChart() {
  chartTicks = [];
  const _clp2 = document.getElementById('chart-live-price');
  if (_clp2) _clp2.textContent = '—';
  const _cpc2 = document.getElementById('chart-price-change');
  if (_cpc2) _cpc2.textContent = '—';
  const _tt2 = document.getElementById('tick-table');
  if (_tt2) _tt2.innerHTML = '';
  drawChart();
}

function handleChartTick(tick) {
  const quote = parseFloat(tick.quote);
  const time = tick.epoch;
  chartTicks.push({ quote, time });
  if (chartTicks.length > MAX_TICKS) chartTicks.shift();

  const priceEl = document.getElementById('chart-live-price');
  const changeEl = document.getElementById('chart-price-change');
  if (priceEl) priceEl.textContent = quote.toFixed(tick.pip_size || 2);

  if (chartTicks.length >= 2) {
    const prev = chartTicks[chartTicks.length - 2].quote;
    const diff = quote - prev;
    const pct = ((diff / prev) * 100).toFixed(3);
    const up = diff >= 0;
    changeEl.textContent = (up ? '▲ +' : '▼ ') + Math.abs(diff).toFixed(tick.pip_size || 2) + ' (' + (up ? '+' : '') + pct + '%)';
    changeEl.style.color = up ? 'var(--green)' : 'var(--red)';
    changeEl.style.background = up ? 'rgba(29,158,117,0.1)' : 'rgba(226,75,74,0.1)';
  }

  drawChart();
  updateTickTable(quote, time);
}

function drawChart() {
  const canvas = document.getElementById('tick-chart');
  if (!canvas) return;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight || 260;
  canvas.width = W * window.devicePixelRatio;
  canvas.height = H * window.devicePixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const bg = dark ? '#1c1b19' : '#ffffff';
  const gridC = dark ? 'rgba(240,239,233,0.05)' : 'rgba(26,25,22,0.05)';
  const textC = dark ? '#9a9890' : '#9a9890';
  const lineC = '#e84b1a';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  if (chartTicks.length < 2) {
    ctx.fillStyle = textC;
    ctx.font = '13px DM Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for ticks…', W / 2, H / 2);
    return;
  }

  const quotes = chartTicks.map(t => t.quote);
  const minQ = Math.min(...quotes);
  const maxQ = Math.max(...quotes);
  const range = maxQ - minQ || 1;
  const pad = { t: 20, r: 10, b: 30, l: 60 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  const xOf = (i) => pad.l + (i / (chartTicks.length - 1)) * cW;
  const yOf = (q) => pad.t + (1 - (q - minQ) / range) * cH;

  ctx.strokeStyle = gridC;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + (g / 4) * cH;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    const val = maxQ - (g / 4) * range;
    ctx.fillStyle = textC;
    ctx.font = '10px DM Sans, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(2), pad.l - 6, y + 4);
  }

  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, 'rgba(232,75,26,0.18)');
  grad.addColorStop(1, 'rgba(232,75,26,0)');
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(chartTicks[0].quote));
  chartTicks.forEach((t, i) => ctx.lineTo(xOf(i), yOf(t.quote)));
  ctx.lineTo(xOf(chartTicks.length - 1), H - pad.b);
  ctx.lineTo(xOf(0), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = lineC;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  chartTicks.forEach((t, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(t.quote)) : ctx.lineTo(xOf(i), yOf(t.quote)));
  ctx.stroke();

  const lx = xOf(chartTicks.length - 1);
  const ly = yOf(chartTicks[chartTicks.length - 1].quote);
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, Math.PI * 2);
  ctx.fillStyle = lineC;
  ctx.fill();
}

function updateTickTable(quote, epoch) {
  const tb = document.getElementById('tick-table');
  if (!tb) return;
  const time = new Date(epoch * 1000).toLocaleTimeString();
  const div = document.createElement('div');
  div.style.cssText = 'background:var(--surface2);border-radius:6px;padding:5px 8px;font-size:12px';
  div.innerHTML = `<span style="color:var(--text3)">${time}</span><br><b style="color:var(--text)">${quote}</b>`;
  tb.insertBefore(div, tb.firstChild);
  if (tb.children.length > 20) tb.removeChild(tb.lastChild);
}

/* ═══════════════════════════════════════════════════════
   BOT RUNNER
   ═══════════════════════════════════════════════════════ */
function toggleBot() {
  if (!session) {
    alert('Please log in to Deriv first.');
    return;
  }
  if (botRunning) {
    stopBot('⏹ Manually stopped');
  } else {
    startBot();
  }
}

function startBot() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    alert('Not connected to Deriv. Please log in first.');
    return;
  }
  const stakeEl = document.getElementById('bb-stake');
  botRunning = true;
  bbStats = { total: 0, wins: 0, pl: 0, curStake: stakeEl ? parseFloat(stakeEl.value) : 0.35 };
  updateBotStats();
  const logEl = document.getElementById('bb-trade-log');
  const emptyEl = document.getElementById('bb-log-empty');
  if (logEl) logEl.innerHTML = '';
  if (emptyEl) emptyEl.style.display = 'block';

  const btn = document.getElementById('bb-run-btn');
  if (btn) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop Bot';
    btn.style.background = 'var(--red)';
  }
  setBotStatus('🤖 Bot started — placing first trade…', null);
  placeNextTrade();
}

function stopBot(reason) {
  botRunning = false;
  clearTimeout(botTimer);
  currentContract = null;

  const btn = document.getElementById('bb-run-btn');
  if (btn) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Bot';
    btn.style.background = 'var(--accent)';
  }
  if (reason) setBotStatus(reason, null);
}

function placeNextTrade() {
  if (!botRunning || !socket || socket.readyState !== WebSocket.OPEN) return;
  const symbol = document.getElementById('bb-symbol').value;
  const contract = document.getElementById('bb-contract').value;
  const duration = parseInt(document.getElementById('bb-duration').value);
  const stake = bbStats.curStake || parseFloat(document.getElementById('bb-stake').value);

  setBotStatus(`📡 Requesting proposal — ${symbol} / ${contract} / $${stake.toFixed(2)}…`, null);

  const req = {
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: contract,
    currency: session.accounts[session.activeIdx].currency || 'USD',
    duration: duration,
    duration_unit: 't',
    symbol: symbol
  };

  if (contract === 'DIGITOVER') req.barrier = '4';
  if (contract === 'DIGITUNDER') req.barrier = '5';
  if (contract === 'DIGITMATCH' || contract === 'DIGITDIFF') req.barrier = '5';

  socket.send(JSON.stringify(req));
}

function setBotStatus(msg, won) {
  const el = document.getElementById('bb-status-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.background = won === true ? 'rgba(29,158,117,0.12)' :
                        won === false ? 'rgba(226,75,74,0.12)' :
                        'var(--surface2)';
  el.style.color = won === true ? 'var(--green)' :
                   won === false ? 'var(--red)' :
                   'var(--text2)';
}

function updateBotStats() {
  const wr = bbStats.total ? ((bbStats.wins / bbStats.total) * 100).toFixed(1) + '%' : '—';
  const pl = bbStats.pl;
  const losses = bbStats.total - bbStats.wins;
  const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  safeSet('bb-total', bbStats.total);
  safeSet('bb-winrate', wr);
  const plEl = document.getElementById('bb-pl');
  if (plEl) {
    plEl.textContent = (pl >= 0 ? '+' : '') + '$' + Math.abs(pl).toFixed(2);
    plEl.className = 'rc-stat-val ' + (pl >= 0 ? 'green' : 'red');
  }
  const stakeEl = document.getElementById('bb-stake');
  safeSet('bb-curstake', '$' + (bbStats.curStake || (stakeEl ? parseFloat(stakeEl.value) : 0)).toFixed(2));

  safeSet('rp-num-runs', bbStats.total);
  safeSet('rp-contracts-won', bbStats.wins);
  safeSet('rp-contracts-lost', losses);
  const rpPl = document.getElementById('rp-total-pl');
  if (rpPl) {
    rpPl.textContent = (pl >= 0 ? '+' : '') + pl.toFixed(2) + ' USD';
    rpPl.className = 'rp-stat-value ' + (pl >= 0 ? 'green' : 'red');
  }
}

function addTradeLogEntry(id, won, profit, entry, exit) {
  const log = document.getElementById('bb-trade-log');
  if (!log) return;
  const empty = document.getElementById('bb-log-empty');
  if (empty) empty.style.display = 'none';
  const div = document.createElement('div');
  div.style.cssText = `display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;font-size:12px;background:${won ? 'rgba(29,158,117,0.08)' : 'rgba(226,75,74,0.08)'}`;
  div.innerHTML = `
    <span style="font-weight:700;color:${won ? 'var(--green)' : 'var(--red)'}">${won ? 'WIN' : 'LOSS'}</span>
    <span style="color:var(--text2);flex:1">Contract #${id}</span>
    <span style="font-weight:600;color:${won ? 'var(--green)' : 'var(--red)'}">${won ? '+' : '-'}$${Math.abs(profit).toFixed(2)}</span>`;
  log.insertBefore(div, log.firstChild);
  if (log.children.length > 30) log.removeChild(log.lastChild);
}

/* ═══════════════════════════════════════════════════════
   RISK CALCULATOR & JOURNAL
   ═══════════════════════════════════════════════════════ */
function runAICalc() {
  const balance = parseFloat(document.getElementById('rc-balance').value);
  const target = parseFloat(document.getElementById('rc-target').value);
  const stake = parseFloat(document.getElementById('rc-stake').value);
  const payout = parseFloat(document.getElementById('rc-payout').value);
  const runs = parseInt(document.getElementById('rc-runs').value);

  if (!balance || !target || !stake || !payout || !runs) {
    document.getElementById('rc-result').style.display = 'none';
    return;
  }

  const payoutMult = payout / 100;
  const profitPerWin = stake * payoutMult;
  const tradesNeeded = Math.ceil(target / profitPerWin);
  const winRate = (tradesNeeded / runs) * 100;
  const maxLoss = stake * runs;
  const netProfit = (tradesNeeded * profitPerWin) - ((runs - tradesNeeded) * stake);

  const _rtn = document.getElementById('rc-trades-needed');
  if (_rtn) _rtn.textContent = tradesNeeded;
  const _rwr = document.getElementById('rc-win-rate');
  if (_rwr) _rwr.textContent = winRate.toFixed(1) + '%';
  const _rml = document.getElementById('rc-max-loss');
  if (_rml) _rml.textContent = '$' + maxLoss.toFixed(2);
  const _rnp = document.getElementById('rc-net-profit');
  if (_rnp) _rnp.textContent = (netProfit >= 0 ? '+' : '') + '$' + netProfit.toFixed(2);
  document.getElementById('rc-net-profit').className = 'rc-stat-val ' + (netProfit >= 0 ? 'green' : 'red');

  let tip = '';
  if (winRate > 80) tip = '⚠️ This plan requires a very high win rate (' + winRate.toFixed(1) + '%). Consider lowering your target or increasing stake.';
  else if (winRate > 60) tip = '📊 Moderate win rate needed. Achievable with a solid strategy, but monitor carefully.';
  else if (winRate < 40) tip = '✅ Low win-rate threshold — this is a conservative, well-spaced plan. Great risk management!';
  else tip = '💡 Balanced plan. Aim for consistent entries and stick to your stake size.';
  if (stake < 0.35) tip += ' Note: Deriv minimum stake is $0.35.';

  const _rat = document.getElementById('rc-ai-tip');
  if (_rat) _rat.textContent = tip;
  document.getElementById('rc-result').style.display = 'block';
}

function saveJournalEntry() {
  const balance = parseFloat(document.getElementById('rc-balance').value) || 0;
  const target = parseFloat(document.getElementById('rc-target').value) || 0;
  const stake = parseFloat(document.getElementById('rc-stake').value) || 0;
  const payout = parseFloat(document.getElementById('rc-payout').value) || 0;
  const runs = parseInt(document.getElementById('rc-runs').value) || 0;
  const netEl = document.getElementById('rc-net-profit');
  const pl = netEl ? parseFloat(netEl.textContent.replace(/[^0-9.-]/g, '')) || 0 : 0;

  const entry = {
    id: Date.now(),
    date: new Date().toLocaleDateString('en-GB'),
    result: pl >= 0 ? 'win' : 'loss',
    notes: `Balance $${balance} → Target $${target} | Stake $${stake} | Payout ${payout}% | ${runs} runs`,
    stake,
    pl: pl >= 0 ? pl : -Math.abs(pl)
  };
  journalEntries.unshift(entry);
  persistJournal();
  renderJournal();
}

function openNewEntry() {
  const f = document.getElementById('journal-new-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if (f.style.display === 'block') {
    document.getElementById('jf-date').value = new Date().toISOString().split('T')[0];
  }
}

function addManualEntry() {
  const date = document.getElementById('jf-date').value;
  const result = document.getElementById('jf-result').value;
  const notes = document.getElementById('jf-notes').value || '—';
  const stake = parseFloat(document.getElementById('jf-stake').value) || 0;
  const pl = parseFloat(document.getElementById('jf-pl').value) || 0;
  if (!date) return;
  journalEntries.unshift({ id: Date.now(), date: new Date(date).toLocaleDateString('en-GB'), result, notes, stake, pl });
  persistJournal();
  renderJournal();
  document.getElementById('journal-new-form').style.display = 'none';
}

function deleteEntry(id) {
  journalEntries = journalEntries.filter(e => e.id !== id);
  persistJournal();
  renderJournal();
}

function persistJournal() {
  try {
    localStorage.setItem('ark_journal', JSON.stringify(journalEntries));
  } catch (e) {}
}

function renderJournal() {
  const list = document.getElementById('journal-list');
  const empty = document.getElementById('journal-empty');
  if (!journalEntries.length) {
    empty.style.display = 'flex';
    list.querySelectorAll('.j-entry').forEach(e => e.remove());
    return;
  }
  empty.style.display = 'none';
  list.querySelectorAll('.j-entry').forEach(e => e.remove());
  journalEntries.forEach(e => {
    const label = e.result === 'win' ? 'W' : e.result === 'loss' ? 'L' : '~';
    const plSign = e.pl >= 0 ? '+' : '';
    const div = document.createElement('div');
    div.className = 'j-entry';
    div.innerHTML = `
      <div class="j-entry-badge ${e.result}">${label}</div>
      <div class="j-entry-body">
        <div class="j-entry-top">
          <span class="j-entry-date">${e.date}</span>
          <span class="j-entry-pl ${e.pl >= 0 ? 'pos' : 'neg'}">${plSign}$${Math.abs(e.pl).toFixed(2)}</span>
        </div>
        <div class="j-entry-notes">${e.notes}</div>
      </div>
      <button class="j-entry-del" onclick="deleteEntry(${e.id})" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>`;
    list.appendChild(div);
  });
}

/* ═══════════════════════════════════════════════════════
   UI NAVIGATION & HELPERS
   ═══════════════════════════════════════════════════════ */
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('sun-icon').style.display = isDark ? 'block' : 'none';
  document.getElementById('moon-icon').style.display = isDark ? 'none' : 'block';
  document.getElementById('sidebar-sun').style.display = isDark ? 'block' : 'none';
  document.getElementById('sidebar-moon').style.display = isDark ? 'none' : 'block';
  const _stl = document.getElementById('sidebar-theme-label');
  if (_stl) _stl.textContent = isDark ? 'Light mode' : 'Dark mode';
  setTimeout(drawChart, 50);
}

function showPage(id, tabEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  if (tabEl && tabEl.classList.contains('nav-tab')) {
    tabEl.classList.add('active');
  } else {
    const match = document.querySelector(`.nav-tab[onclick*="'${id}'"]`);
    if (match) match.classList.add('active');
  }

  document.querySelectorAll('.mob-tab-btn').forEach(b => b.classList.remove('active'));
  if (tabEl && tabEl.classList.contains('mob-tab-btn')) {
    tabEl.classList.add('active');
    tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  } else {
    const mobTab = document.querySelector(`.mob-tab-btn[data-page="${id}"]`);
    if (mobTab) {
      mobTab.classList.add('active');
      mobTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  document.querySelectorAll('.mob-drawer-item[data-page]').forEach(b => b.classList.remove('active'));
  const drawerItem = document.querySelector(`.mob-drawer-item[data-page="${id}"]`);
  if (drawerItem) drawerItem.classList.add('active');

  window.scrollTo({ top: 0 });

  if (id === 'charts') setTimeout(drawChart, 80);
}

function openMobDrawer() {
  document.getElementById('mob-drawer').classList.add('open');
  document.getElementById('mob-overlay').classList.add('open');
}

function closeMobDrawer() {
  document.getElementById('mob-drawer').classList.remove('open');
  document.getElementById('mob-overlay').classList.remove('open');
}

function switchPanelTab(el) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

function calcRisk() { /* legacy kept for compat */ }

function tick() {
  const now = new Date();
  const _clk = document.getElementById('clock');
  if (_clk) _clk.textContent = now.toISOString().replace('T', ' ').substring(0, 19) + ' GMT';
}

/* ═══════════════════════════════════════════════════════
   RIPPLE EFFECT
   ═══════════════════════════════════════════════════════ */
(function initRipple() {
  const SELECTORS = 'button, .nav-tab, .bot-use-btn, .load-option, .bot-card, .welcome-link, .panel-tab, .sidebar-item';
  function attachRipple(el) {
    if (el.dataset.ripple) return;
    el.dataset.ripple = '1';
    el.classList.add('ripple-host');
    el.addEventListener('pointerdown', function (e) {
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;
      const wave = document.createElement('span');
      wave.className = 'ripple-wave';
      wave.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
      el.appendChild(wave);
      wave.addEventListener('animationend', () => wave.remove());
    });
  }
  function scanAndAttach() {
    document.querySelectorAll(SELECTORS).forEach(attachRipple);
  }
  scanAndAttach();
  new MutationObserver(scanAndAttach).observe(document.body, { childList: true, subtree: true });
})();

/* ═══════════════════════════════════════════════════════
   SPLASH SCREEN
   ═══════════════════════════════════════════════════════ */
(function runSplash() {
  const bar = document.getElementById('splash-bar');
  const subTxt = document.getElementById('splash-sub');
  const splash = document.getElementById('splash');

  const steps = [
    { pct: 20, msg: 'Loading assets…' },
    { pct: 45, msg: 'Connecting to Deriv API…' },
    { pct: 70, msg: 'Preparing trading engine…' },
    { pct: 90, msg: 'Almost ready…' },
    { pct: 100, msg: 'Welcome to ArkTraders Hub!' },
  ];

  let i = 0;
  function next() {
    if (i >= steps.length) {
      setTimeout(() => splash.classList.add('hidden'), 400);
      return;
    }
    const s = steps[i++];
    bar.style.width = s.pct + '%';
    subTxt.textContent = s.msg;
    setTimeout(next, i === steps.length ? 700 : 480);
  }

  setTimeout(next, 300);
})();

/* ═══════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════ */
(function init() {
  const oauthAccounts = parseOAuthParams();
  if (oauthAccounts) {
    session = saveSession(oauthAccounts);
    window.history.replaceState({}, document.title, window.location.pathname);
  } else {
    session = loadSession();
  }

  if (session && session.accounts && session.accounts.length > 0) {
    const acct = session.accounts[session.activeIdx] || session.accounts[0];
    updateAuthUI({ acct: acct.acct, balance: null, currency: acct.currency });
    connectWS(acct.token, acct);
  } else {
    updateStatusBar(false, 'Not connected — click Log in');
  }

  connectPublicWS(document.getElementById('chart-symbol').value);
  tick();
  setInterval(tick, 1000);
  window.addEventListener('resize', () => {
    const pc = document.getElementById('page-charts');
    if (pc && pc.classList.contains('active')) drawChart();
  });

  const origShowPage = showPage;
  window.showPage = function (id, tabEl) {
    origShowPage(id, tabEl);
    const mc = document.getElementById('main-content');
    if (mc) mc.style.padding = (id === 'botbuilder') ? '0' : '24px';
  };

  renderJournal();
})();