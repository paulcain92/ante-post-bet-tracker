const STORAGE_KEY = 'accaTracker.bets.v1';

let bets = loadBets();
let draggedSelectionBlock = null; // the .selection-block currently being dragged to reorder, in the Add/Edit form
let currentPage = 1;
const PAGE_SIZE = 20;
// Set when the Add/Edit modal is opened from a Top Selections drill-down row, so closing,
// saving, or deleting that bet drops back into the same drill-down list instead of just closing.
let topSelectionsReturnContext = null;

function loadBets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load bets', e);
    return [];
  }
}

function saveBets() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bets));
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function totalStake(bet) {
  return (Number(bet.winStake) || 0) + (bet.betType === 'each-way' ? (Number(bet.eachWayStake) || 0) : 0);
}

function money(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
  const rounded = Math.round(Number(n) * 100) / 100;
  return '£' + (Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2));
}

const FOLD_NAMES = { 1: 'Single', 2: 'Double', 3: 'Treble' };
function formatFoldLabel(n) {
  return FOLD_NAMES[n] || `${n}-fold`;
}

// Converts stored decimal odds (e.g. 109.69, from multiplying several selection prices
// together) into UK fractional odds rounded to a whole number (e.g. "109/1") — an exact
// fraction like 10869/100 is technically accurate but not how anyone reads combined odds.
function decimalToFraction(decimalOdds) {
  const n = Number(decimalOdds);
  if (!isFinite(n) || n <= 1) return null;
  return `${Math.round(n) - 1}/1`;
}

// `rawOdds`, if present, is exactly what was typed into the total-odds field for a
// manually-priced bet — shown as-is rather than reconstructed from the decimal, since
// that's a real bookmaker fraction the user chose, not something the site computed.
function formatOdds(x, rawOdds) {
  if (rawOdds) return escapeHtml(rawOdds);
  if (x === null || x === undefined || x === '') return '—';
  const n = Number(x);
  if (isNaN(n)) return escapeHtml(x);
  return decimalToFraction(n) ?? n.toFixed(2);
}

// Parses "7/2" or "3.5" into decimal odds (e.g. 4.5). Returns NaN if invalid.
function parseOddsToDecimal(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return NaN;
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (!isFinite(num) || !isFinite(den) || den === 0) return NaN;
    return 1 + num / den;
  }
  const d = parseFloat(s);
  return isFinite(d) ? d : NaN;
}

// Parses "1/4" or "0.25" into a plain multiplier (e.g. 0.25). Returns NaN if invalid.
function isWinOnlyFraction(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'win only';
}

// "Win only" carries the full win price through to the place calculation unreduced
// (mathematically the same as a 1/1 fraction) — it just means this leg has no place terms.
function parseFraction(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (isWinOnlyFraction(s)) return 1;
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return NaN;
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (!isFinite(num) || !isFinite(den) || den === 0) return NaN;
    return num / den;
  }
  const d = parseFloat(s);
  return isFinite(d) ? d : NaN;
}

// Combines each selection's price (and, for each-way, its own each-way fraction) into
// accumulator win odds and place odds. NaN means one or more selections are incomplete/invalid.
function computeTotals(selectionsData, betType) {
  if (selectionsData.length === 0) return { winDecimal: NaN, placeDecimal: NaN };

  let winDecimal = 1;
  let placeDecimal = 1;
  let winValid = true;
  let placeValid = betType === 'each-way';

  selectionsData.forEach(s => {
    if (s.void) return; // still part of the bet, but excluded from the odds calculation

    const priceDec = parseOddsToDecimal(s.price);
    if (isNaN(priceDec)) { winValid = false; placeValid = false; return; }
    winDecimal *= priceDec;

    if (betType === 'each-way') {
      const frac = parseFraction(s.ewFraction);
      if (isNaN(frac)) { placeValid = false; return; }
      placeDecimal *= 1 + (priceDec - 1) * frac;
    }
  });

  return {
    winDecimal: winValid ? winDecimal : NaN,
    placeDecimal: placeValid ? placeDecimal : NaN,
  };
}

function computePotentialReturn(totals, betType, winStake, ewStake) {
  if (isNaN(totals.winDecimal)) return NaN;
  if (betType === 'each-way') {
    if (isNaN(totals.placeDecimal)) return NaN;
    return (winStake * totals.winDecimal) + (ewStake * totals.placeDecimal);
  }
  return winStake * totals.winDecimal;
}

// ---------- Screenshot scan (OCR best-effort autofill) ----------

const KNOWN_BOOKMAKERS = ['Bet365', 'Sky Bet', 'Ladbrokes', 'William Hill', 'AK Bets', 'Betano', 'Betway', 'PricedUp', 'Lottoland'];

function findBookmaker(text) {
  for (const name of KNOWN_BOOKMAKERS) {
    if (new RegExp(name.replace(/\s+/g, '\\s*'), 'i').test(text)) return name;
  }
  return null;
}

function isEachWay(text) {
  return /each\s*way|e\/?w\b/i.test(text);
}

function findStakes(text) {
  let winStake = null, ewStake = null;
  const ewMatch = text.match(/each\s*way\s*stake[^\d£]{0,12}£?\s*([\d]+(?:\.\d{1,2})?)/i);
  if (ewMatch) ewStake = parseFloat(ewMatch[1]);

  const winMatch = text.match(/(?:win\s*stake|total\s*stake)[^\d£]{0,12}£?\s*([\d]+(?:\.\d{1,2})?)/i)
    || text.match(/\bstake[^\d£]{0,12}£?\s*([\d]+(?:\.\d{1,2})?)/i);
  if (winMatch) winStake = parseFloat(winMatch[1]);

  return { winStake, ewStake };
}

function findTotalOdds(text) {
  const m = text.match(/(?:total|combined)\s*odds[^\d]{0,12}(\d+\/\d+|\d+\.\d{1,2})/i);
  return m ? m[1] : null;
}

const EACH_WAY_TERMS_RE = /(\d{1,2}\/\d{1,2})\s*(?:odds)?[\s,-]{0,6}(\d{1,2})\s*places?/i;

function findEachWayTerms(text) {
  const m = text.match(EACH_WAY_TERMS_RE);
  return m ? { fraction: m[1], places: m[2] } : null;
}

// ---- OCR memory: learns line-layout patterns and text corrections per bookmaker,
// and grows more familiar with the user's own selections/markets/competitions over time.

const OCR_MEMORY_KEY = 'accaTracker.ocrMemory.v1';

function loadOcrMemory() {
  try {
    const raw = localStorage.getItem(OCR_MEMORY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const rawCorrections = parsed?.corrections || {};
    const corrections = {};
    Object.keys(rawCorrections).forEach(bmKey => {
      const entry = rawCorrections[bmKey] || {};
      // Migrate the old flat { rawSelection: finalValue } shape (selection corrections only)
      // into the newer { selections: {...}, markets: {...} } shape.
      corrections[bmKey] = (entry.selections || entry.markets)
        ? { selections: entry.selections || {}, markets: entry.markets || {} }
        : { selections: entry, markets: {} };
    });
    return {
      corrections,
      lineOffsetStats: parsed?.lineOffsetStats || {},
    };
  } catch (e) {
    return { corrections: {}, lineOffsetStats: {} };
  }
}

function saveOcrMemory() {
  localStorage.setItem(OCR_MEMORY_KEY, JSON.stringify(ocrMemory));
}

let ocrMemory = loadOcrMemory();

// Strips the personal account suffix (e.g. "Bet365 (KR)" -> "Bet365") so layout memory is
// shared across accounts at the same bookmaker, since the slip layout depends on the brand.
function normalizeBookmakerKey(bookmaker) {
  return (bookmaker || 'unknown').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase() || 'unknown';
}

function bumpOffsetStat(bmKey, strategy) {
  if (!ocrMemory.lineOffsetStats[bmKey]) ocrMemory.lineOffsetStats[bmKey] = { sameLine: 0, twoLineCombo: 0, oneLineBack: 0 };
  ocrMemory.lineOffsetStats[bmKey][strategy] = (ocrMemory.lineOffsetStats[bmKey][strategy] || 0) + 1;
}

// `field` is 'selections' or 'markets' — kept separate per bookmaker so a market correction
// can never collide with a selection correction that happens to share the same raw OCR text.
function recordCorrection(bmKey, field, rawKey, finalValue) {
  if (!rawKey || !finalValue || rawKey === finalValue.toLowerCase()) return;
  if (!ocrMemory.corrections[bmKey]) ocrMemory.corrections[bmKey] = { selections: {}, markets: {} };
  ocrMemory.corrections[bmKey][field][rawKey] = finalValue;
}

function getKnownTerms() {
  return {
    selections: [...new Set(bets.flatMap(b => b.selections.map(s => s.selection)).filter(Boolean))],
    markets: [...new Set(bets.flatMap(b => b.selections.map(s => s.market)).filter(Boolean))],
    competitions: [...new Set(bets.flatMap(b => b.selections.map(s => s.competition)).filter(Boolean))],
  };
}

// Bookmakers aren't a fixed list — everyone uses a different set, so this just grows from
// whatever the user has actually typed in before. Starts empty for a brand-new user/browser.
function getKnownBookmakers() {
  return [...new Set(bets.map(b => b.bookmaker).filter(Boolean))];
}

// Only surfaces a selection/market as an autocomplete suggestion once it's been used more
// than `minCount` times across saved bets — keeps one-off/typo'd entries out of the list.
function getFrequentTerms(field, minCount) {
  const counts = {};
  bets.forEach(b => b.selections.forEach(s => {
    const v = s[field];
    if (v) counts[v] = (counts[v] || 0) + 1;
  }));
  return Object.keys(counts).filter(k => counts[k] > minCount);
}

// Looks at past bets for this exact selection name and returns whichever value of `field`
// (e.g. competition) has been paired with it most often — e.g. "Arsenal" -> "English Premier League".
// Only returns a value once that pairing has occurred at least 5 times, so a one-off entry
// (or a typo) doesn't get treated as an established pattern.
function getMostCommonValueForSelection(field, selectionValue) {
  const counts = {};
  bets.forEach(b => b.selections.forEach(s => {
    if (s.selection && s.selection.toLowerCase() === selectionValue.toLowerCase() && s[field]) {
      counts[s[field]] = (counts[s[field]] || 0) + 1;
    }
  }));
  let best = null, bestCount = 0;
  Object.keys(counts).forEach(k => {
    if (counts[k] > bestCount) { bestCount = counts[k]; best = k; }
  });
  return bestCount >= 5 ? best : null;
}

// Auto-fills Competition from the selection's most common past competition, once the
// selection field has a value and Competition hasn't already been filled in (typed or scanned).
function autofillCompetitionFromSelection(block) {
  const selectionValue = block.querySelector('.sel-selection').value.trim();
  const competitionField = block.querySelector('.sel-competition');
  if (!selectionValue || competitionField.value.trim()) return;
  const competition = getMostCommonValueForSelection('competition', selectionValue);
  if (competition) {
    competitionField.value = competition;
    competitionField.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// Snaps OCR text to the closest term the user has already typed before (e.g. corrects
// "Lawrence Shankiand" -> "Lawrence Shankland" once that selection has been entered before).
function snapToKnownTerm(candidate, knownTerms) {
  if (!candidate) return candidate;
  const lower = candidate.toLowerCase();
  let best = null, bestScore = 0;
  for (const term of knownTerms) {
    const termLower = term.toLowerCase();
    if (termLower === lower) return term;
    const maxLen = Math.max(termLower.length, lower.length);
    if (maxLen === 0) continue;
    const score = 1 - levenshtein(lower, termLower) / maxLen;
    if (score > bestScore) { bestScore = score; best = term; }
  }
  return (best && bestScore >= 0.78) ? best : candidate;
}

const OCR_CHROME_RE = /^(single|double|treble|four-?fold|five-?fold|six-?fold|accumulator|acca|each\s*way|e\/?w|multiples?|total\s*odds|combined\s*odds|win\s*stake|each\s*way\s*stake|stake|returns?|potential\s*returns?|bet\s*slip|selections?|bet365|sky\s*bet|ladbrokes|william\s*hill|ak\s*bets|betano|betway|pricedup|lottoland)$/i;

function looksLikeOcrChrome(line) {
  const t = line.trim();
  return OCR_CHROME_RE.test(t) || /^[\d.,£\s]+$/.test(t);
}

// Best-effort: scans each OCR line for a price token (fraction or "@ price") and works out
// the selection (and market, if shown) from nearby lines. Which nearby-line pattern to try
// first is learned per bookmaker from past scans (see lineOffsetStats).
function findSelectionCandidates(text, excludeFraction, bookmaker, knownTerms, globalEwTerms) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // Digit-boundary guards keep this from matching inside a longer run of digits, like the "26/27"
  // tail of a season string ("2026/27") getting misread as an odds fraction.
  const fractionRe = /(?<!\d)(\d{1,3}\/\d{1,2})(?!\d)/;
  const atPriceRe = /@\s*(\d+\.\d{1,2}|(?<!\d)\d{1,3}\/\d{1,2}(?!\d))/;
  const candidates = [];
  const bmKey = normalizeBookmakerKey(bookmaker);
  const stats = ocrMemory.lineOffsetStats[bmKey] || { twoLineCombo: 0, oneLineBack: 0 };
  // On an untrained tie, favour the simpler one-line-back guess (name directly above the price)
  // over two-line-back — it's the more common layout and less likely to grab unrelated text.
  const preferTwoLineFirst = stats.twoLineCombo > stats.oneLineBack;
  const correctionMap = ocrMemory.corrections[bmKey] || { selections: {}, markets: {} };

  lines.forEach((line, idx) => {
    const priceMatch = line.match(fractionRe) || line.match(atPriceRe);
    if (!priceMatch) return;
    const price = priceMatch[1];
    if (excludeFraction && price === excludeFraction) return;

    let selection = '', market = '', strategy = '';
    const sameLineLabel = line.replace(priceMatch[0], '').trim().replace(/^[\d.)\s-]+/, '').trim();

    const tryTwoLineCombo = () => {
      const prev1 = idx >= 1 ? lines[idx - 1] : '';
      const prev2 = idx >= 2 ? lines[idx - 2] : '';
      if (prev2 && !looksLikeOcrChrome(prev2) && !fractionRe.test(prev2)) {
        selection = prev2;
        market = !looksLikeOcrChrome(prev1) ? prev1 : '';
        strategy = 'twoLineCombo';
        return true;
      }
      return false;
    };
    const tryOneLineBack = () => {
      const prev1 = idx >= 1 ? lines[idx - 1] : '';
      if (prev1 && !looksLikeOcrChrome(prev1) && !fractionRe.test(prev1)) {
        selection = prev1;
        strategy = 'oneLineBack';
        return true;
      }
      return false;
    };

    // Check the CLEANED version before committing to sameLine — a price that sits alone on its
    // own line (e.g. "@ 5/2") can leave a meaningless leftover symbol like "@" behind, which
    // would otherwise wrongly look like a same-line label and swallow the whole candidate once
    // that symbol is stripped out below, instead of falling back to the line above.
    const sameLineLabelClean = sameLineLabel.replace(/[^a-zA-Z0-9'&.\s-]/g, '').trim();
    if (sameLineLabelClean.length > 1 && !looksLikeOcrChrome(sameLineLabelClean)) {
      selection = sameLineLabel;
      strategy = 'sameLine';
    } else if (preferTwoLineFirst) {
      tryTwoLineCombo() || tryOneLineBack();
    } else {
      tryOneLineBack() || tryTwoLineCombo();
    }

    selection = selection.replace(/[^a-zA-Z0-9'&.\s-]/g, '').trim();
    market = market.replace(/[^a-zA-Z0-9'&.\s-]/g, '').trim();
    if (!selection || selection.length <= 1 || selection.length >= 60) return;

    const ocrRawSelection = selection.toLowerCase();
    if (correctionMap.selections[ocrRawSelection]) {
      selection = correctionMap.selections[ocrRawSelection];
    } else {
      selection = snapToKnownTerm(selection, knownTerms.selections);
    }
    const ocrRawMarket = market.toLowerCase();
    if (market) {
      if (correctionMap.markets[ocrRawMarket]) {
        market = correctionMap.markets[ocrRawMarket];
      } else {
        market = snapToKnownTerm(market, knownTerms.markets);
      }
    }

    // Each selection can carry its own each-way terms (e.g. one leg pays 4 places instead of
    // the usual 3) — look for one nearby before falling back to whatever applies to the slip
    // as a whole.
    let ewFraction = globalEwTerms ? globalEwTerms.fraction : '';
    let ewPlaces = globalEwTerms ? globalEwTerms.places : '';
    for (let look = idx; look <= Math.min(idx + 5, lines.length - 1); look++) {
      const ewMatch = lines[look].match(EACH_WAY_TERMS_RE);
      if (ewMatch) { ewFraction = ewMatch[1]; ewPlaces = ewMatch[2]; break; }
    }

    candidates.push({ selection, market, price, ocrStrategy: strategy, ocrRawSelection, ocrRawMarket, ewFraction, ewPlaces });
  });

  const seen = new Set();
  return candidates.filter(c => {
    const key = c.selection.toLowerCase() + '|' + c.price;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function parseSlipText(text) {
  const eachWay = isEachWay(text);
  const globalEwTerms = eachWay ? findEachWayTerms(text) : null;
  const { winStake, ewStake } = findStakes(text);
  const bookmaker = findBookmaker(text);

  return {
    bookmaker,
    betType: eachWay ? 'each-way' : 'win',
    winStake,
    ewStake,
    totalOdds: findTotalOdds(text),
    selectionCandidates: findSelectionCandidates(text, globalEwTerms ? globalEwTerms.fraction : null, bookmaker, getKnownTerms(), globalEwTerms),
  };
}

function applyParsedSlip(parsed) {
  const bmField = document.getElementById('f-bookmaker');
  if (parsed.bookmaker && !bmField.value) {
    bmField.value = parsed.bookmaker;
  }

  if (parsed.betType === 'each-way') {
    document.getElementById('f-bet-type').value = 'each-way';
    updateEwFieldsVisibility();
  }

  const winStakeField = document.getElementById('f-win-stake');
  if (parsed.winStake !== null && !winStakeField.value) winStakeField.value = parsed.winStake;

  const ewStakeField = document.getElementById('f-ew-stake');
  if (parsed.ewStake !== null && !ewStakeField.value) ewStakeField.value = parsed.ewStake;

  if (parsed.selectionCandidates.length > 0) {
    selectionsEditor.innerHTML = '';
    parsed.selectionCandidates.forEach(c => {
      addSelectionRow({
        selection: c.selection,
        market: c.market || '',
        competition: '',
        price: c.price,
        ewFraction: c.ewFraction || '',
        ewPlaces: c.ewPlaces || '',
      }, { ocrStrategy: c.ocrStrategy, ocrRawSelection: c.ocrRawSelection, ocrRawMarket: c.ocrRawMarket });
    });
    // OCR doesn't read the competition off the slip, so fall back to the same "used together
    // 5+ times before" auto-fill that applies when typing a selection out by hand.
    selectionsEditor.querySelectorAll('.selection-block').forEach(autofillCompetitionFromSelection);
    updateEwFieldsVisibility();
    recalcModalTotals();
  } else if (parsed.totalOdds) {
    document.getElementById('f-manual-odds').checked = true;
    updateOddsMode();
    document.getElementById('f-odds').value = parsed.totalOdds;
  }
}

async function runScan(file) {
  const statusEl = document.getElementById('scan-status');
  const textWrap = document.getElementById('scan-text-wrap');
  statusEl.hidden = false;
  statusEl.textContent = 'Loading OCR engine…';
  textWrap.hidden = true;

  try {
    const result = await Tesseract.recognize(file, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          statusEl.textContent = `Reading screenshot… ${Math.round(m.progress * 100)}%`;
        } else if (m.status) {
          statusEl.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
        }
      },
    });

    const text = result.data.text || '';
    document.getElementById('scan-text').textContent = text.trim() || '(no text found)';
    textWrap.hidden = false;

    applyParsedSlip(parseSlipText(text));

    statusEl.textContent = "Done — check the fields below and fix anything that's wrong.";
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Could not read the screenshot: ' + err.message;
  }
}

// ---------- Filtering / sorting ----------

// `includeStatus: false` is used by the stats bar, so the status breakdown (Open/Won/Lost/
// Cash out counts) reflects whatever OTHER filters are active (bookmaker, bet type, dates,
// search) without being collapsed down to just the currently-selected status.
function betMatchesFilters(bet, { includeStatus = true } = {}) {
  const search = document.getElementById('search-input').value.trim().toLowerCase();
  const status = document.getElementById('filter-status').value;
  const bookmaker = document.getElementById('filter-bookmaker').value;
  const betType = document.getElementById('filter-bet-type').value;
  const dateFrom = document.getElementById('filter-date-from').value;
  const dateTo = document.getElementById('filter-date-to').value;

  if (includeStatus && status && bet.status !== status) return false;
  if (bookmaker && bet.bookmaker !== bookmaker) return false;
  if (betType && bet.betType !== betType) return false;
  if (dateFrom && bet.datePlaced < dateFrom) return false;
  if (dateTo && bet.datePlaced > dateTo) return false;

  if (search) {
    const hay = bet.selections.map(s => `${s.selection} ${s.market} ${s.competition}`).join(' ').toLowerCase()
      + ' ' + bet.bookmaker.toLowerCase();
    if (!hay.includes(search)) return false;
  }

  return true;
}

function getStatsScopedBets() {
  return bets.filter(bet => betMatchesFilters(bet, { includeStatus: false }));
}

function getFilteredSortedBets() {
  const sortBy = document.getElementById('sort-by').value;
  let list = bets.filter(bet => betMatchesFilters(bet, { includeStatus: true }));

  list.sort((a, b) => {
    switch (sortBy) {
      case 'stake-desc': return totalStake(b) - totalStake(a);
      case 'odds-desc': return (Number(b.totalOdds) || 0) - (Number(a.totalOdds) || 0);
      case 'potential-return-desc': return (Number(b.potentialReturn) || 0) - (Number(a.potentialReturn) || 0);
      case 'actual-return-desc': return (Number(b.actualReturn) || 0) - (Number(a.actualReturn) || 0);
      case 'date-desc':
      default: return b.datePlaced.localeCompare(a.datePlaced) || b.id.localeCompare(a.id);
    }
  });

  return list;
}

// ---------- Rendering ----------

function render() {
  renderBookmakerFilterOptions();
  renderStats();
  renderBetsList();
}

// Bookmaker filter isn't a fixed list either — rebuilt from whatever bookmakers actually
// appear in saved bets, so it starts empty for a new user and grows as they add bets.
function renderBookmakerFilterOptions() {
  const select = document.getElementById('filter-bookmaker');
  const current = select.value;
  const bookmakers = getKnownBookmakers().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  select.innerHTML = `<option value="">All bookmakers</option>` +
    bookmakers.map(bm => `<option value="${escapeHtml(bm)}">${escapeHtml(bm)}</option>`).join('');
  // Always assign (even back to '') rather than only when `current` is still valid — this goes
  // through attachSelectDropdown's intercepted setter, keeping its proxy text in sync with
  // whatever the rebuilt option list actually resolved the value to.
  select.value = bookmakers.includes(current) ? current : '';
}

function renderStats() {
  const statsBets = getStatsScopedBets();
  const total = statsBets.length;
  const open = statsBets.filter(b => b.status === 'open').length;
  const won = statsBets.filter(b => b.status === 'won').length;
  const lost = statsBets.filter(b => b.status === 'lost').length;
  const cashedOut = statsBets.filter(b => b.status === 'cash-out').length;

  const staked = statsBets.reduce((sum, b) => sum + totalStake(b), 0);
  const openStaked = statsBets.filter(b => b.status === 'open').reduce((sum, b) => sum + totalStake(b), 0);

  const settled = statsBets.filter(b => b.status !== 'open');
  let returned = 0;
  settled.forEach(b => {
    if (b.actualReturn !== null && b.actualReturn !== undefined && b.actualReturn !== '') {
      returned += Number(b.actualReturn);
    }
    // lost/cash-out with no actualReturn entered contributes 0
  });
  const settledStaked = settled.reduce((sum, b) => sum + totalStake(b), 0);
  const pl = returned - settledStaked;

  const currentStatus = document.getElementById('filter-status').value;

  const stats = [
    { label: 'Total bets', value: total, status: '', clearsFilter: true },
    { label: 'Open', value: open, status: 'open' },
    { label: 'Won', value: won, status: 'won' },
    { label: 'Lost', value: lost, status: 'lost' },
    { label: 'Cash out', value: cashedOut, status: 'cash-out' },
    { label: 'Total stakes', value: money(staked), detail: 'totalStaked' },
    { label: 'Open stakes', value: money(openStaked), detail: 'openStaked' },
    { label: 'Settled return', value: money(returned), detail: 'settledReturn' },
    { label: 'Profit / Loss', value: money(pl), cls: pl > 0 ? 'pos' : (pl < 0 ? 'neg' : ''), detail: 'pl' },
  ];

  document.getElementById('stats-bar').innerHTML = stats.map(s => {
    const clickable = s.status !== undefined;
    const active = clickable && currentStatus === s.status;
    const hasDetail = s.detail !== undefined;
    return `
    <div class="stat-card ${clickable ? 'stat-card-clickable' : ''} ${hasDetail ? 'stat-card-clickable' : ''} ${active ? 'active' : ''}"
      ${clickable ? `data-status="${s.status}"` : ''} ${hasDetail ? `data-detail="${s.detail}"` : ''}
      ${clickable || hasDetail ? `role="button" tabindex="0"` : ''}>
      <div class="stat-label">${s.label}</div>
      <div class="stat-value ${s.cls || ''}">${s.value}</div>
    </div>
  `;
  }).join('');

  document.querySelectorAll('.stat-card-clickable').forEach(card => {
    const activate = () => {
      if (card.dataset.detail) {
        openStatDetailModal(card.dataset.detail);
        return;
      }
      document.getElementById('filter-status').value = card.dataset.status;
      currentPage = 1;
      render();
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });
}

// Stat cards that open a breakdown view — keyed by the `detail` value set on their stat object
// in renderStats(). Only "Total stakes" is wired up for now; more can be added the same way.
const STAT_DETAIL_METRICS = {
  totalStaked: {
    label: 'Total stakes',
    color: 'var(--accent)',
    getValue: (betsInGroup) => betsInGroup.reduce((sum, b) => sum + totalStake(b), 0),
  },
  openStaked: {
    label: 'Open stakes',
    color: 'var(--accent)',
    getValue: (betsInGroup) => betsInGroup.filter(b => b.status === 'open').reduce((sum, b) => sum + totalStake(b), 0),
  },
  settledReturn: {
    label: 'Settled return',
    color: 'var(--accent)',
    getValue: (betsInGroup) => betsInGroup
      .filter(b => b.status !== 'open')
      .reduce((sum, b) => sum + (b.actualReturn !== null && b.actualReturn !== undefined && b.actualReturn !== '' ? Number(b.actualReturn) : 0), 0),
  },
  // Profit/loss additionally gets a cumulative line chart above its bookmaker breakdown — see
  // openStatDetailModal. Open bets are excluded since they haven't settled yet.
  pl: {
    label: 'Profit / Loss',
    color: (v) => v >= 0 ? 'var(--win-green)' : 'var(--red)',
    getValue: (betsInGroup) => betsInGroup.filter(b => b.status !== 'open').reduce((sum, b) => sum + betPl(b), 0),
  },
};

function betPl(b) {
  const actual = b.actualReturn !== null && b.actualReturn !== undefined && b.actualReturn !== '' ? Number(b.actualReturn) : 0;
  return actual - totalStake(b);
}

// One point per date that has at least one settled bet — "Daily" is that date's own P&L,
// "Total" is the running cumulative P&L up to and including that date.
function getPnlLineSeries() {
  const byDate = {};
  getStatsScopedBets().filter(b => b.status !== 'open').forEach(b => {
    byDate[b.datePlaced] = (byDate[b.datePlaced] || 0) + betPl(b);
  });
  let running = 0;
  return Object.keys(byDate).sort().map(date => {
    running += byDate[date];
    return { label: new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), daily: byDate[date], total: running };
  });
}

function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function groupBetsBy(keyFn) {
  const groups = {};
  getStatsScopedBets().forEach(b => {
    const key = keyFn(b);
    (groups[key] || (groups[key] = [])).push(b);
  });
  return groups;
}

function getMonthlyMetricBreakdown(metricKey) {
  const getValue = STAT_DETAIL_METRICS[metricKey].getValue;
  const byMonth = groupBetsBy(b => b.datePlaced.slice(0, 7));
  return Object.keys(byMonth).sort().map(key => ({ label: formatMonthLabel(key), value: getValue(byMonth[key]) }));
}

function getBookmakerMetricBreakdown(metricKey) {
  const getValue = STAT_DETAIL_METRICS[metricKey].getValue;
  const byBookmaker = groupBetsBy(b => b.bookmaker || 'Unknown');
  return Object.keys(byBookmaker)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map(key => ({ label: key, value: getValue(byBookmaker[key]) }));
}

// Picks a "nice" round step (1/2/5 x a power of ten — e.g. 100, 200, 500, 1000) so axis
// labels land on numbers like 100, 200, 300 rather than whatever the data's actual min/max are.
function computeNiceTicks(minVal, maxVal, targetCount) {
  if (minVal === maxVal) { minVal -= 1; maxVal += 1; }
  const roughStep = (maxVal - minVal) / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;

  const niceMin = Math.floor(minVal / step) * step;
  const niceMax = Math.ceil(maxVal / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}

// Simple hand-rolled SVG bar chart — no charting library dependency. Bars extend up from (or
// down through) a zero baseline, so metrics that can go negative (e.g. profit/loss) still work.
function renderSingleBarChart(container, groups, color) {
  if (groups.length === 0) {
    container.innerHTML = '<p class="chart-empty">No data yet.</p>';
    return;
  }

  const width = 820, height = 240;
  const marginLeft = 60, marginRight = 16, marginTop = 16, marginBottom = 58;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const dataMax = Math.max(0, ...groups.map(g => g.value));
  const dataMin = Math.min(0, ...groups.map(g => g.value));
  const ticks = computeNiceTicks(dataMin, dataMax, 5);
  const minVal = ticks[0];
  const maxVal = ticks[ticks.length - 1];
  const range = (maxVal - minVal) || 1;
  const yScale = (v) => marginTop + plotHeight - ((v - minVal) / range) * plotHeight;

  const groupWidth = plotWidth / groups.length;
  const barPadding = groupWidth * 0.25;
  const barWidth = groupWidth - barPadding * 2;

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="bar-chart" preserveAspectRatio="xMinYMin meet">`;
  ticks.forEach(v => {
    const y = yScale(v);
    svg += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" class="${v === 0 ? 'chart-axis-line' : 'chart-gridline'}" />`;
    svg += `<text x="${marginLeft - 8}" y="${y + 4}" class="chart-axis-label" text-anchor="end">${money(v)}</text>`;
  });

  groups.forEach((g, i) => {
    const groupX = marginLeft + i * groupWidth;
    const y1 = yScale(Math.max(0, g.value));
    const y2 = yScale(Math.min(0, g.value));
    const barH = Math.max(1, Math.abs(y2 - y1));
    const barX = groupX + barPadding;
    const barColor = typeof color === 'function' ? color(g.value) : color;
    svg += `<rect x="${barX.toFixed(1)}" y="${Math.min(y1, y2).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" fill="${barColor}"><title>${escapeHtml(g.label)}: ${money(g.value)}</title></rect>`;
    const labelX = (groupX + groupWidth / 2).toFixed(1);
    svg += `<text x="${labelX}" y="${height - marginBottom + 18}" class="chart-axis-label" text-anchor="middle">${escapeHtml(g.label)}</text>`;
    svg += `<text x="${labelX}" y="${height - marginBottom + 32}" class="chart-value-label" text-anchor="middle">${money(g.value)}</text>`;
  });

  svg += `</svg>`;
  container.innerHTML = svg;
}

// Line chart of cumulative Total P&L over time, plotted against the same nice-rounded Y axis
// as the bar charts.
function renderLineChart(container, series) {
  if (series.length === 0) {
    container.innerHTML = '<p class="chart-empty">No data yet.</p>';
    return;
  }

  const width = 820, height = 240;
  const marginLeft = 60, marginRight = 16, marginTop = 16, marginBottom = 44;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const allValues = series.map(p => p.total);
  const ticks = computeNiceTicks(Math.min(0, ...allValues), Math.max(0, ...allValues), 5);
  const minVal = ticks[0], maxVal = ticks[ticks.length - 1];
  const range = (maxVal - minVal) || 1;
  const yScale = (v) => marginTop + plotHeight - ((v - minVal) / range) * plotHeight;

  const n = series.length;
  const xScale = (i) => n === 1 ? marginLeft + plotWidth / 2 : marginLeft + (i / (n - 1)) * plotWidth;

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="bar-chart" preserveAspectRatio="xMinYMin meet">`;
  ticks.forEach(v => {
    const y = yScale(v);
    svg += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" class="${v === 0 ? 'chart-axis-line' : 'chart-gridline'}" />`;
    svg += `<text x="${marginLeft - 8}" y="${y + 4}" class="chart-axis-label" text-anchor="end">${money(v)}</text>`;
  });

  const points = series.map((p, i) => `${xScale(i).toFixed(1)},${yScale(p.total).toFixed(1)}`).join(' ');
  svg += `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2" />`;

  series.forEach((p, i) => {
    const x = xScale(i).toFixed(1);
    const y = yScale(p.total).toFixed(1);
    const tooltip = `<title>${escapeHtml(p.label)} — Total: ${money(p.total)}</title>`;
    // A larger invisible circle sits behind the visible dot purely to make hovering easy —
    // the tiny visible dot alone is a hard target to land the mouse on.
    svg += `<circle cx="${x}" cy="${y}" r="10" fill="transparent">${tooltip}</circle>`;
    svg += `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--accent)" pointer-events="none">${tooltip}</circle>`;
  });

  const labelStep = Math.max(1, Math.ceil(n / 10));
  series.forEach((p, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return;
    svg += `<text x="${xScale(i).toFixed(1)}" y="${height - marginBottom + 18}" class="chart-axis-label" text-anchor="middle">${escapeHtml(p.label)}</text>`;
  });

  svg += `</svg>`;

  container.innerHTML = `<div class="chart-wrap">${svg}</div>`;
}

function openStatDetailModal(metricKey) {
  const metric = STAT_DETAIL_METRICS[metricKey];
  if (!metric) return;
  document.getElementById('stat-detail-title').textContent = metric.label;
  const body = document.getElementById('stat-detail-body');

  if (metricKey === 'pl') {
    body.innerHTML = `
      <div class="chart-block"><div id="pl-line-chart"></div></div>
      <div class="chart-block">
        <h3>By bookmaker</h3>
        <div class="chart-wrap" id="pl-bookmaker-chart"></div>
      </div>
    `;
    renderLineChart(document.getElementById('pl-line-chart'), getPnlLineSeries());
    renderSingleBarChart(document.getElementById('pl-bookmaker-chart'), getBookmakerMetricBreakdown('pl'), metric.color);
  } else {
    body.innerHTML = `
      <div class="chart-block">
        <h3>By month</h3>
        <div class="chart-wrap" id="stat-detail-monthly-chart"></div>
      </div>
      <div class="chart-block">
        <h3>By bookmaker</h3>
        <div class="chart-wrap" id="stat-detail-bookmaker-chart"></div>
      </div>
    `;
    renderSingleBarChart(document.getElementById('stat-detail-monthly-chart'), getMonthlyMetricBreakdown(metricKey), metric.color);
    renderSingleBarChart(document.getElementById('stat-detail-bookmaker-chart'), getBookmakerMetricBreakdown(metricKey), metric.color);
  }

  document.getElementById('stat-detail-backdrop').hidden = false;
}

// Counts each distinct (selection, market, competition) combo across every OPEN, non-void
// selection in every bet — regardless of the current filters, since this is meant as a global
// "what am I most exposed to right now" view, not scoped to whatever's on screen.
function getTopOpenSelections(limit) {
  const counts = {};
  bets.filter(b => b.status === 'open').forEach(b => {
    (b.selections || []).forEach(s => {
      if (s.void || !s.selection) return;
      const key = `${s.selection}|||${s.market}|||${s.competition}`;
      if (!counts[key]) counts[key] = { selection: s.selection, market: s.market, competition: s.competition, count: 0 };
      counts[key].count++;
    });
  });
  return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, limit);
}

function getOpenBetsForSelection(selection, market, competition) {
  return bets.filter(b => b.status === 'open' && (b.selections || []).some(s =>
    !s.void && s.selection === selection && s.market === market && s.competition === competition
  ));
}

function renderTopSelectionsRanking() {
  document.getElementById('btn-top-selections-back').hidden = true;
  document.getElementById('top-selections-title').textContent = 'Top 10 Open Selections';
  const top = getTopOpenSelections(10);
  const container = document.getElementById('top-selections-list');
  if (top.length === 0) {
    container.innerHTML = '<p class="chart-empty">No open selections yet.</p>';
    return;
  }
  container.innerHTML = top.map((item, i) => `
    <div class="top-selection-row top-selection-row-clickable" data-selection="${escapeHtml(item.selection)}" data-market="${escapeHtml(item.market)}" data-competition="${escapeHtml(item.competition)}" role="button" tabindex="0">
      <span class="top-selection-rank">${i + 1}</span>
      <div class="top-selection-info">
        <b>${escapeHtml(item.selection)}</b>
        <span class="chip-market">${escapeHtml(item.market)}${item.competition ? ' · ' + escapeHtml(item.competition) : ''}</span>
      </div>
      <span class="top-selection-count">${item.count} bet${item.count === 1 ? '' : 's'}</span>
    </div>
  `).join('');

  container.querySelectorAll('.top-selection-row-clickable').forEach(row => {
    const activate = () => renderTopSelectionsDrilldown(row.dataset.selection, row.dataset.market, row.dataset.competition);
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
  });
}

// Read-only version of the main list's chips — no tick buttons, since this is just a quick
// look at what's in the accumulator, not a place to record results.
function buildReadOnlyChips(bet) {
  return bet.selections.map(s => {
    const result = s.result || 'pending';
    const resultClass = s.void ? 'chip-void' : result === 'won' ? 'chip-won' : result === 'placed' ? 'chip-placed' : result === 'lost' ? 'chip-lost' : '';
    return `<span class="chip ${resultClass}">
              <b>${escapeHtml(s.selection)}</b> <span class="chip-market">— ${escapeHtml(s.market)}${s.competition ? ' · ' + escapeHtml(s.competition) : ''}${s.price ? ' @ ' + escapeHtml(s.price) : ''}${s.void ? ' · Void' : ''}</span>
            </span>`;
  }).join('');
}

// Drills into whichever open bets contain this exact (selection, market, competition) combo —
// clicking a row expands its full selection list inline, rather than jumping into editing.
function renderTopSelectionsDrilldown(selection, market, competition) {
  document.getElementById('btn-top-selections-back').hidden = false;
  document.getElementById('top-selections-title').textContent = selection;
  const matches = getOpenBetsForSelection(selection, market, competition);
  const container = document.getElementById('top-selections-list');
  container.innerHTML = matches.map(b => `
    <div class="drilldown-bet-block">
      <div class="drilldown-bet-row" data-id="${b.id}" role="button" tabindex="0">
        <div class="drilldown-bet-info">
          <span class="date">${formatDate(b.datePlaced)}</span>
          <span class="bookmaker">${escapeHtml(b.bookmaker)}</span>
          <span>${formatFoldLabel(b.selections.length)}${b.betType === 'each-way' ? ' · EW' : ''}</span>
        </div>
        <div class="drilldown-bet-figures">
          <span>Odds <b>${formatOdds(b.totalOdds, b.totalOddsRaw)}</b></span>
          <span>Stake <b>${money(totalStake(b))}</b></span>
          <span>Potential <b>${money(b.potentialReturn)}</b></span>
        </div>
      </div>
      <div class="drilldown-bet-detail" hidden>
        <div class="selections-chips">${buildReadOnlyChips(b)}</div>
        <button type="button" class="btn-drilldown-edit" data-id="${b.id}">✏️ Edit bet</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.drilldown-bet-row').forEach(row => {
    const toggle = () => {
      const detail = row.nextElementSibling;
      detail.hidden = !detail.hidden;
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });

  container.querySelectorAll('.btn-drilldown-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bet = bets.find(b => b.id === btn.dataset.id);
      if (!bet) return;
      document.getElementById('top-selections-backdrop').hidden = true;
      openModal(bet, { fromTopSelections: { selection, market, competition } });
    });
  });
}

function openTopSelectionsModal() {
  renderTopSelectionsRanking();
  document.getElementById('top-selections-backdrop').hidden = false;
}

function renderBetsList() {
  const fullList = getFilteredSortedBets();
  const container = document.getElementById('bets-list');
  const emptyState = document.getElementById('empty-state');
  const pagination = document.getElementById('pagination');

  if (fullList.length === 0) {
    container.innerHTML = '';
    emptyState.hidden = false;
    pagination.hidden = true;
    return;
  }
  emptyState.hidden = true;

  const totalPages = Math.max(1, Math.ceil(fullList.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const list = fullList.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  if (totalPages > 1) {
    pagination.hidden = false;
    document.getElementById('pagination-info').textContent = `Page ${currentPage} of ${totalPages}`;
    document.getElementById('btn-prev-page').disabled = currentPage === 1;
    document.getElementById('btn-next-page').disabled = currentPage === totalPages;
  } else {
    pagination.hidden = true;
  }

  const searchQuery = document.getElementById('search-input').value.trim();

  container.innerHTML = list.map(bet => {
    const stake = totalStake(bet);
    const canTrackResults = bet.status === 'open';
    const chips = bet.selections.map((s, selIndex) => {
      const result = s.result || 'pending';
      const resultClass = s.void ? 'chip-void' : result === 'won' ? 'chip-won' : result === 'placed' ? 'chip-placed' : result === 'lost' ? 'chip-lost' : '';
      const tickIcon = result === 'won' ? '✓' : result === 'placed' ? 'P' : result === 'lost' ? '✗' : '';
      const tickTitle = result === 'won' ? 'Won — click to change' : result === 'placed' ? 'Placed (each-way) — click to change' : result === 'lost' ? 'Lost — click to change' : 'Mark as won';
      return `<span class="chip ${resultClass}">
                ${canTrackResults && !s.void ? `<button type="button" class="chip-tick" data-bet-id="${bet.id}" data-sel-index="${selIndex}" title="${tickTitle}">${tickIcon}</button>` : ''}
                <b>${highlightMatch(s.selection, searchQuery)}</b> <span class="chip-market">— ${highlightMatch(s.market, searchQuery)}${s.competition ? ' · ' + highlightMatch(s.competition, searchQuery) : ''}${s.price ? ' @ ' + escapeHtml(s.price) : ''}${s.void ? ' · Void' : ''}</span>
              </span>`;
    }).join('');

    return `
      <div class="bet-card" data-id="${bet.id}">
        <div class="bet-card-top">
          <div class="bet-meta">
            <span class="date">${formatDate(bet.datePlaced)}</span>
            <span class="bookmaker">${escapeHtml(bet.bookmaker)}</span>
            <span class="status-badge status-${bet.status}">${bet.status.replace('-', ' ')}</span>
          </div>
          <div class="bet-figures">
            <span>${formatFoldLabel(bet.selections.length)}${bet.betType === 'each-way' ? ' · EW' : ''}</span>
            <span>Odds <b>${formatOdds(bet.totalOdds, bet.totalOddsRaw)}</b></span>
            <span>Stake <b>${money(stake)}</b></span>
            ${bet.status !== 'won' ? `<span>Potential <b>${money(bet.potentialReturn)}</b></span>` : ''}
            <span>Return <b>${money(bet.actualReturn)}</b></span>
          </div>
          <div class="bet-actions">
            <button class="btn-edit" title="Edit">✏️</button>
            <button class="btn-duplicate" title="Duplicate">📋</button>
            ${bet.status === 'open' ? '<button class="btn-mark-lost" title="Mark as lost">×</button>' : ''}
            <button class="btn-delete" title="Delete">🗑️</button>
          </div>
        </div>
        <div class="selections-chips">${chips}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.chip-tick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetBet = bets.find(b => b.id === btn.dataset.betId);
      if (!targetBet) return;
      const sel = targetBet.selections[Number(btn.dataset.selIndex)];
      if (!sel) return;
      const states = targetBet.betType === 'each-way' ? ['pending', 'won', 'placed', 'lost'] : ['pending', 'won', 'lost'];
      const nextIndex = (states.indexOf(sel.result || 'pending') + 1) % states.length;
      sel.result = states[nextIndex];

      // A single lost leg kills the whole accumulator outright, so settle the bet as lost the
      // moment any selection is ticked lost — same idea as the all-won case below, just the
      // opposite outcome. Checked first since one lost leg overrides any other result.
      if (targetBet.selections.some(s => s.result === 'lost')) {
        targetBet.status = 'lost';
        if (targetBet.actualReturn === null || targetBet.actualReturn === undefined) {
          targetBet.actualReturn = 0;
        }
      } else if (targetBet.selections.every(s => s.result === 'won')) {
        // If every selection has now been ticked won, the bet itself has won outright —
        // settle it automatically so it moves under the right status filter straight away.
        targetBet.status = 'won';
        targetBet.actualReturn = targetBet.potentialReturn;
      }

      saveBets();
      render();
    });
  });

  container.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.bet-card').dataset.id;
      openModal(bets.find(b => b.id === id));
    });
  });

  container.querySelectorAll('.btn-duplicate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.bet-card').dataset.id;
      openModal(bets.find(b => b.id === id), { duplicate: true });
    });
  });

  container.querySelectorAll('.btn-mark-lost').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.bet-card').dataset.id;
      const targetBet = bets.find(b => b.id === id);
      if (!targetBet) return;
      targetBet.status = 'lost';
      if (targetBet.actualReturn === null || targetBet.actualReturn === undefined) {
        targetBet.actualReturn = 0;
      }
      saveBets();
      render();
    });
  });

  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.bet-card').dataset.id;
      if (confirm('Delete this bet? This cannot be undone.')) {
        bets = bets.filter(b => b.id !== id);
        saveBets();
        render();
      }
    });
  });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wraps every occurrence of `query` inside `text` in a <mark>, escaping each segment
// separately so HTML-escaping never desyncs from where the match actually is.
function highlightMatch(text, query) {
  const str = String(text ?? '');
  if (!query) return escapeHtml(str);
  const re = new RegExp('(' + escapeRegExp(query) + ')', 'ig');
  return str.split(re).map((part, i) =>
    i % 2 === 1 ? `<mark class="search-highlight">${escapeHtml(part)}</mark>` : escapeHtml(part)
  ).join('');
}

// ---------- Modal / form ----------

const modalBackdrop = document.getElementById('modal-backdrop');
const betForm = document.getElementById('bet-form');
const selectionsEditor = document.getElementById('selections-editor');

function openModal(bet, options = {}) {
  topSelectionsReturnContext = options.fromTopSelections || null;
  document.getElementById('btn-modal-back').hidden = !options.fromTopSelections;
  const isDuplicate = options.duplicate === true;
  betForm.reset();
  document.getElementById('scan-status').hidden = true;
  document.getElementById('scan-text-wrap').hidden = true;

  if (bet) {
    document.getElementById('modal-title').textContent = isDuplicate ? 'Duplicate Bet' : 'Edit Bet';
    document.getElementById('bet-id').value = isDuplicate ? '' : bet.id;
    document.getElementById('f-date').value = isDuplicate ? new Date().toISOString().slice(0, 10) : bet.datePlaced;
    document.getElementById('f-bookmaker').value = bet.bookmaker;
    document.getElementById('f-status').value = isDuplicate ? 'open' : bet.status;
    document.getElementById('f-bet-type').value = bet.betType;
    document.getElementById('f-win-stake').value = bet.winStake;
    mirrorEwStakeFromWinStake();
    document.getElementById('f-actual-return').value = isDuplicate ? '' : (bet.actualReturn ?? '');
    // A duplicate is meant for editing selections, so odds always recompute live from
    // whatever's in the price fields — never carried over frozen from a manually-entered total.
    document.getElementById('f-manual-odds').checked = isDuplicate ? false : !!bet.oddsManual;
    document.getElementById('btn-delete-bet').hidden = isDuplicate;

    selectionsEditor.innerHTML = '';
    bet.selections.forEach(s => addSelectionRow(s));

    updateEwFieldsVisibility();
    updateOddsMode();
    if (bet.oddsManual && !isDuplicate) {
      document.getElementById('f-odds').value = bet.totalOddsRaw || (bet.totalOdds != null ? Number(bet.totalOdds).toFixed(2) : '');
      document.getElementById('f-potential-return').value = bet.potentialReturn != null ? money(bet.potentialReturn) : '';
    }
    updateActualReturnMode();
  } else {
    document.getElementById('modal-title').textContent = 'Add Bet';
    document.getElementById('bet-id').value = '';
    document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('f-status').value = 'open';
    document.getElementById('f-bet-type').value = 'win';
    document.getElementById('f-manual-odds').checked = false;
    document.getElementById('btn-delete-bet').hidden = true;

    selectionsEditor.innerHTML = '';
    addSelectionRow();
    addSelectionRow();

    updateEwFieldsVisibility();
    updateOddsMode();
  }

  modalBackdrop.hidden = false;
}

function closeModal() {
  modalBackdrop.hidden = true;
  if (topSelectionsReturnContext) {
    const { selection, market, competition } = topSelectionsReturnContext;
    topSelectionsReturnContext = null;
    renderTopSelectionsDrilldown(selection, market, competition);
    document.getElementById('top-selections-backdrop').hidden = false;
  }
}

function updateEwFieldsVisibility() {
  const isEw = document.getElementById('f-bet-type').value === 'each-way';
  const manual = isManualOddsMode();
  document.getElementById('ew-stake-wrap').hidden = !isEw;
  document.getElementById('f-ew-stake').required = isEw;
  selectionsEditor.querySelectorAll('.ew-fields').forEach(el => { el.hidden = !isEw || manual; });
}

function isManualOddsMode() {
  return document.getElementById('f-manual-odds').checked;
}

function updateOddsMode() {
  const manual = isManualOddsMode();
  const oddsField = document.getElementById('f-odds');
  const potentialField = document.getElementById('f-potential-return');

  oddsField.readOnly = !manual;
  potentialField.readOnly = true;
  oddsField.placeholder = '—';
  potentialField.placeholder = '—';

  selectionsEditor.querySelectorAll('.sel-price').forEach(el => {
    el.required = !manual && !el.disabled;
    el.hidden = manual;
    if (manual) el.value = '';
  });
  selectionsEditor.querySelectorAll('.void-toggle').forEach(el => { el.hidden = manual; });

  const isEw = document.getElementById('f-bet-type').value === 'each-way';
  selectionsEditor.querySelectorAll('.ew-fields').forEach(el => {
    el.hidden = !isEw || manual;
    if (manual) {
      el.querySelector('.sel-ew-fraction').value = '';
      el.querySelector('.sel-ew-places').value = '';
      el.querySelector('.places-field').hidden = false;
      el.querySelector('.places-suffix').hidden = true;
    }
  });

  if (manual) {
    document.getElementById('f-place-odds-note').hidden = true;
    recalcManualPotentialReturn();
  } else {
    oddsField.value = '';
    potentialField.value = '';
    recalcModalTotals();
  }
}

function getSelectionRowsData() {
  return [...selectionsEditor.querySelectorAll('.selection-block')].map(block => ({
    selection: block.querySelector('.sel-selection').value.trim(),
    market: block.querySelector('.sel-market').value.trim(),
    competition: block.querySelector('.sel-competition').value.trim(),
    price: block.querySelector('.sel-price').value.trim(),
    ewFraction: block.querySelector('.sel-ew-fraction').value.trim(),
    ewPlaces: block.querySelector('.sel-ew-places').value.trim(),
    void: block.querySelector('.sel-void').checked,
  }));
}

function recalcManualPotentialReturn() {
  const winStake = parseFloat(document.getElementById('f-win-stake').value) || 0;
  const totalOddsDecimal = parseOddsToDecimal(document.getElementById('f-odds').value);
  const potentialField = document.getElementById('f-potential-return');
  potentialField.value = isNaN(totalOddsDecimal) ? '' : money(winStake * totalOddsDecimal);
  updateActualReturnMode();
}

function recalcModalTotals() {
  if (isManualOddsMode()) {
    recalcManualPotentialReturn();
    return;
  }
  const betType = document.getElementById('f-bet-type').value;
  const winStake = parseFloat(document.getElementById('f-win-stake').value) || 0;
  const ewStake = parseFloat(document.getElementById('f-ew-stake').value) || 0;
  const selectionsData = getSelectionRowsData();

  const totals = computeTotals(selectionsData, betType);
  const potential = computePotentialReturn(totals, betType, winStake, ewStake);

  document.getElementById('f-odds').value = isNaN(totals.winDecimal) ? '' : totals.winDecimal.toFixed(2);

  const placeNote = document.getElementById('f-place-odds-note');
  if (betType === 'each-way' && !isNaN(totals.placeDecimal)) {
    placeNote.hidden = false;
    placeNote.textContent = `Place odds: ${totals.placeDecimal.toFixed(2)}`;
  } else {
    placeNote.hidden = true;
  }

  document.getElementById('f-potential-return').value = isNaN(potential) ? '' : money(potential);
  updateActualReturnMode();
}

function addSelectionRow(sel, ocrMeta) {
  const isEw = document.getElementById('f-bet-type').value === 'each-way';
  const manual = isManualOddsMode();
  const block = document.createElement('div');
  block.className = 'selection-block';
  if (ocrMeta?.ocrStrategy) {
    block.dataset.ocrStrategy = ocrMeta.ocrStrategy;
    block.dataset.ocrRawSelection = ocrMeta.ocrRawSelection || '';
    block.dataset.ocrRawMarket = ocrMeta.ocrRawMarket || '';
  }
  block.innerHTML = `
    <div class="selection-row-top">
      <span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <input type="text" placeholder="Selection" class="sel-selection" value="${escapeHtml(sel?.selection)}" required>
      <input type="text" placeholder="Competition" class="sel-competition" value="${escapeHtml(sel?.competition)}">
      <input type="text" placeholder="Market" class="sel-market" value="${escapeHtml(sel?.market)}" required>
      <button type="button" title="Remove selection">&times;</button>
    </div>
    <div class="selection-row-bottom">
      <input type="text" placeholder="Price" class="sel-price" value="${escapeHtml(sel?.price)}" ${manual ? 'hidden' : (sel?.void ? 'disabled' : 'required')}>
      <label class="void-toggle" ${manual ? 'hidden' : ''}>
        <input type="checkbox" class="sel-void" ${sel?.void ? 'checked' : ''}> Void
      </label>
      <div class="ew-fields" ${isEw && !manual ? '' : 'hidden'}>
        <input type="text" placeholder="EW fraction" class="sel-ew-fraction" value="${escapeHtml(sel?.ewFraction)}" readonly>
        <div class="places-field" ${isWinOnlyFraction(sel?.ewFraction) ? 'hidden' : ''}>
          <input type="number" placeholder="Places" class="sel-ew-places" min="1" step="1" value="${escapeHtml(sel?.ewPlaces)}">
          <span class="places-suffix" ${sel?.ewPlaces ? '' : 'hidden'}>places</span>
          <span class="places-spinner">
            <button type="button" class="places-spin-up" tabindex="-1" aria-label="Decrease places">▲</button>
            <button type="button" class="places-spin-down" tabindex="-1" aria-label="Increase places">▼</button>
          </span>
        </div>
      </div>
    </div>
  `;
  block.querySelector('.selection-row-top button').addEventListener('click', () => {
    if (selectionsEditor.children.length > 1) {
      block.remove();
      recalcModalTotals();
    }
  });
  const handle = block.querySelector('.drag-handle');
  handle.addEventListener('dragstart', (e) => {
    draggedSelectionBlock = block;
    e.dataTransfer.effectAllowed = 'move';
    block.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    block.classList.remove('dragging');
    draggedSelectionBlock = null;
  });
  attachAutocomplete(block.querySelector('.sel-selection'), () => getFrequentTerms('selection', 10), () => autofillCompetitionFromSelection(block));
  attachCompetitionAutocomplete(block.querySelector('.sel-competition'));
  attachAutocomplete(block.querySelector('.sel-market'), () => getFrequentTerms('market', 10));
  attachFixedDropdown(block.querySelector('.sel-ew-fraction'), EW_FRACTION_OPTIONS);
  selectionsEditor.appendChild(block);
}

// Custom dropdown for the competition field — native <datalist> matches anywhere in the
// text (so typing "C" would suggest "FIFA World Cup"), and that can't be configured away.
// This only ever suggests terms that start with what's been typed.
function attachCompetitionAutocomplete(input) {
  attachAutocomplete(input, getCompetitionSuggestions);
}

const EW_FRACTION_OPTIONS = ['Win only', '1/5', '1/4', '1/3', '1/2'];

// Read-only themed dropdown for a small fixed set of options (EW fraction) — reuses the exact
// same autocomplete-list/autocomplete-item styling as the search-driven fields (selection,
// market, competition) so all four dropdowns look identical, but opens showing every option
// immediately on click since there's nothing to type or filter.
function attachFixedDropdown(input, options) {
  input.readOnly = true;
  const wrap = document.createElement('div');
  wrap.className = 'autocomplete-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement('div');
  list.className = 'autocomplete-list';
  list.hidden = true;
  wrap.appendChild(list);

  let activeIndex = -1;

  function updateActive() {
    [...list.children].forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  }

  function close() {
    list.hidden = true;
    list.innerHTML = '';
    activeIndex = -1;
  }

  function open() {
    activeIndex = Math.max(0, options.indexOf(input.value));
    list.innerHTML = options.map((v, i) => `<div class="autocomplete-item ${i === activeIndex ? 'active' : ''}" data-index="${i}">${escapeHtml(v)}</div>`).join('');
    list.hidden = false;
  }

  function accept(index) {
    if (index < 0 || index >= options.length) return;
    input.value = options[index];
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  input.addEventListener('mousedown', (e) => {
    e.preventDefault();
    input.focus();
    if (list.hidden) open(); else close();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, options.length - 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      accept(activeIndex);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', (e) => {
    const itemEl = e.target.closest('.autocomplete-item');
    if (itemEl) { e.preventDefault(); accept(Number(itemEl.dataset.index)); }
  });
}

// Fully themed replacement for a native <select> with a small fixed option list (status, bet
// type) — the underlying <select> keeps working exactly as before (same id, value, required,
// 'change' event) for the rest of the code, since a native <select>'s own open dropdown can't
// be fully themed cross-browser. Only its visual rendering is replaced with a clickable proxy
// that opens the same autocomplete-list widget used everywhere else.
function attachSelectDropdown(select) {
  select.tabIndex = -1;
  const parent = select.parentNode;
  const wrap = document.createElement('div');
  wrap.className = 'autocomplete-wrap select-dropdown-wrap';
  parent.insertBefore(wrap, select);
  if (parent.tagName === 'LABEL') {
    // Move the real <select> out of the <label> entirely, rather than leaving it nested inside
    // (just hidden) — a label's default action on click is to focus/activate whichever form
    // control it contains, which would otherwise fight this proxy for focus on every click and
    // close the list almost as soon as it opens. It stays in the form (just relocated) so
    // `.value` reads/writes and the 'change' event keep working everywhere else in the code.
    parent.parentNode.insertBefore(select, parent.nextSibling);
  } else {
    wrap.appendChild(select);
  }
  select.hidden = true;

  const proxy = document.createElement('div');
  proxy.className = 'select-dropdown-proxy';
  proxy.tabIndex = 0;
  wrap.appendChild(proxy);

  const list = document.createElement('div');
  list.className = 'autocomplete-list';
  list.hidden = true;
  wrap.appendChild(list);

  const getOptions = () => [...select.options].filter(o => !o.disabled);

  function syncProxyText() {
    const opt = select.options[select.selectedIndex];
    proxy.textContent = opt ? opt.textContent : '';
  }

  let activeIndex = -1;

  function updateActive() {
    [...list.children].forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  }

  function close() {
    list.hidden = true;
    list.innerHTML = '';
    activeIndex = -1;
  }

  function open() {
    const opts = getOptions();
    activeIndex = Math.max(0, opts.findIndex(o => o.value === select.value));
    list.innerHTML = opts.map((o, i) => `<div class="autocomplete-item ${i === activeIndex ? 'active' : ''}" data-index="${i}">${escapeHtml(o.textContent)}</div>`).join('');
    list.hidden = false;
  }

  function accept(index) {
    const opts = getOptions();
    if (index < 0 || index >= opts.length) return;
    select.value = opts[index].value;
    close();
    syncProxyText();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  proxy.addEventListener('mousedown', (e) => {
    e.preventDefault();
    proxy.focus();
    if (list.hidden) open(); else close();
  });
  // The proxy sits inside a <label>, and a label's default action on 'click' (a separate event
  // from 'mousedown') is to focus/activate its associated form control — here, that's the real
  // (hidden) <select>, not this proxy. Left unchecked, that steals focus straight back off the
  // proxy the instant it's clicked, firing the blur-close handler below almost immediately.
  proxy.addEventListener('click', (e) => e.preventDefault());
  proxy.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, getOptions().length - 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      accept(activeIndex);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  proxy.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', (e) => {
    const itemEl = e.target.closest('.autocomplete-item');
    if (itemEl) { e.preventDefault(); accept(Number(itemEl.dataset.index)); }
  });

  select.addEventListener('change', syncProxyText);
  // Existing code elsewhere sets `.value` directly (e.g. loading a bet into the edit form) —
  // that doesn't fire a 'change' event, so intercept the setter itself to keep the proxy text
  // in sync no matter how the value gets changed. betForm.reset() bypasses even that (native
  // form reset doesn't go through the IDL setter), so also resync on the form's 'reset' event.
  const nativeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    get() { return nativeValueDescriptor.get.call(select); },
    set(v) { nativeValueDescriptor.set.call(select, v); syncProxyText(); },
    configurable: true,
  });
  if (select.form) select.form.addEventListener('reset', () => syncProxyText());
  syncProxyText();
}

// Generic themed autocomplete dropdown — used for competition, selection, market, and
// bookmaker so they all get the site's own styling instead of the browser's unthemed native
// popup. `showAllWhenEmpty` makes clicking into an empty field browse every known value
// immediately (like the old bookmaker <select> did), instead of waiting for the first keystroke
// — appropriate for short lists like bookmakers, not for selection/market which can grow large.
function attachAutocomplete(input, getSuggestions, onAccept, { showAllWhenEmpty = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'autocomplete-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement('div');
  list.className = 'autocomplete-list';
  list.hidden = true;
  wrap.appendChild(list);

  let items = [];
  let activeIndex = -1;

  function updateActive() {
    [...list.children].forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  }

  function close() {
    list.hidden = true;
    list.innerHTML = '';
    items = [];
    activeIndex = -1;
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      if (!showAllWhenEmpty) { close(); return; }
      items = getSuggestions(input).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).slice(0, 20);
    } else {
      items = getSuggestions(input)
        .filter(v => v.toLowerCase().startsWith(query) && v.toLowerCase() !== query)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        .slice(0, 8);
    }
    if (items.length === 0) { close(); return; }
    activeIndex = 0;
    list.innerHTML = items.map((v, i) => `<div class="autocomplete-item ${i === 0 ? 'active' : ''}" data-index="${i}">${escapeHtml(v)}</div>`).join('');
    list.hidden = false;
  }

  function accept(index) {
    if (index < 0 || index >= items.length) return;
    input.value = items[index];
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (onAccept) onAccept();
  }

  input.addEventListener('input', render);
  if (showAllWhenEmpty) {
    // Listening for 'focus' alone isn't enough — if the field happens to already be focused
    // (e.g. the browser auto-focuses the first empty required field when the modal opens),
    // clicking it again fires no new focus event, so the list would never open.
    input.addEventListener('focus', render);
    input.addEventListener('click', render);
  }
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive();
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        accept(activeIndex);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', (e) => {
    const itemEl = e.target.closest('.autocomplete-item');
    if (itemEl) { e.preventDefault(); accept(Number(itemEl.dataset.index)); }
  });
}

// Competition: only suggest terms that have been used at least five times in saved bets,
// merged with whatever's already been typed into other selection rows in this open form,
// so a competition typed on row 1 can still be auto-suggested while typing row 2 even on
// its very first use — before the bet is saved and it becomes part of bet history.
// `excludeInput` is passed so the field currently being typed into never suggests its own
// in-progress text back to itself.
function getCompetitionSuggestions(excludeInput) {
  const frequentCompetitions = getFrequentTerms('competition', 4);
  const liveCompetitions = [...selectionsEditor.querySelectorAll('.sel-competition')]
    .filter(el => el !== excludeInput)
    .map(el => el.value.trim())
    .filter(Boolean);
  return [...new Set([...frequentCompetitions, ...liveCompetitions])];
}


betForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const id = document.getElementById('bet-id').value || makeId();
  const existingBet = bets.find(b => b.id === id);
  const status = document.getElementById('f-status').value;
  const betType = document.getElementById('f-bet-type').value;
  const winStake = Number(document.getElementById('f-win-stake').value) || 0;
  const ewStake = betType === 'each-way' ? (Number(document.getElementById('f-ew-stake').value) || 0) : null;
  const manualOdds = isManualOddsMode();

  const selectionsData = getSelectionRowsData();
  const selections = selectionsData
    .filter(s => s.selection)
    .map(s => {
      // Carry over the won/placed tick from the existing bet's matching selection, so
      // editing a bet (e.g. fixing a price) doesn't wipe out progress tracked on open bets.
      const priorMatch = existingBet?.selections.find(old =>
        old.selection === s.selection && old.market === s.market && old.competition === s.competition
      );
      // Settling a bet as Won manually (rather than ticking each selection individually)
      // should still colour every non-void selection the same way the tick would have. And
      // reverting a bet back to Open (e.g. undoing an accidental lost/won tick) should clear
      // every selection's result too, rather than leaving a stale won/placed/lost mark behind.
      const result = status === 'open' ? null : (status === 'won' && !s.void) ? 'won' : (priorMatch?.result || null);
      return {
        selection: s.selection,
        market: s.market,
        competition: s.competition,
        price: s.price,
        ewFraction: betType === 'each-way' ? s.ewFraction : '',
        ewPlaces: betType === 'each-way' && s.ewPlaces !== '' ? Number(s.ewPlaces) : null,
        result,
        void: s.void,
      };
    });

  if (selections.length === 0) {
    alert('Add at least one selection.');
    return;
  }

  let totalOdds, totalOddsRaw, placeOdds, potentialReturn;

  if (manualOdds) {
    totalOddsRaw = document.getElementById('f-odds').value.trim();
    totalOdds = parseOddsToDecimal(totalOddsRaw);
    if (isNaN(totalOdds)) {
      alert('Enter valid total odds (e.g. 250.0 or 249/1).');
      return;
    }
    placeOdds = null;
    const rawPotential = document.getElementById('f-potential-return').value.trim();
    potentialReturn = rawPotential === '' ? null : Number(rawPotential.replace(/[£,\s]/g, ''));
    if (rawPotential !== '' && isNaN(potentialReturn)) {
      alert('Enter a valid potential return.');
      return;
    }
  } else {
    const totals = computeTotals(selectionsData, betType);
    if (isNaN(totals.winDecimal)) {
      alert('Enter a valid price for every selection (e.g. 7/2 or 3.5), or tick "enter total odds manually".');
      return;
    }
    if (betType === 'each-way' && isNaN(totals.placeDecimal)) {
      alert('Enter valid each-way terms (fraction) for every selection.');
      return;
    }
    totalOdds = totals.winDecimal;
    totalOddsRaw = null;
    placeOdds = betType === 'each-way' ? totals.placeDecimal : null;
    potentialReturn = computePotentialReturn(totals, betType, winStake, ewStake || 0);
    if (isNaN(potentialReturn)) potentialReturn = null;
  }

  const bet = {
    id,
    datePlaced: document.getElementById('f-date').value,
    bookmaker: document.getElementById('f-bookmaker').value.trim(),
    status,
    betType,
    winStake,
    eachWayStake: ewStake,
    oddsManual: manualOdds,
    totalOdds: Number(totalOdds.toFixed(2)),
    totalOddsRaw: totalOddsRaw || null,
    placeOdds: placeOdds !== null ? Number(placeOdds.toFixed(2)) : null,
    potentialReturn: potentialReturn === null ? null : Number(potentialReturn.toFixed(2)),
    actualReturn: document.getElementById('f-actual-return').value === '' ? null : Number(document.getElementById('f-actual-return').value),
    selections,
  };

  const existingIndex = bets.findIndex(b => b.id === id);
  if (existingIndex >= 0) {
    bets[existingIndex] = bet;
  } else {
    bets.push(bet);
    currentPage = 1;
  }

  // Learn from this save: reinforce the line-layout pattern that got a selection right,
  // or record a correction so the same OCR misread — in the selection name or the market —
  // is fixed automatically next time.
  const bmKeyForLearning = normalizeBookmakerKey(bet.bookmaker);
  selectionsEditor.querySelectorAll('.selection-block').forEach(block => {
    const strategy = block.dataset.ocrStrategy;
    if (!strategy) return;
    const finalSelection = block.querySelector('.sel-selection').value.trim();
    if (!finalSelection) return;
    const rawSelectionKey = block.dataset.ocrRawSelection || '';
    if (finalSelection.toLowerCase() === rawSelectionKey) {
      bumpOffsetStat(bmKeyForLearning, strategy);
    } else {
      recordCorrection(bmKeyForLearning, 'selections', rawSelectionKey, finalSelection);
    }

    const rawMarketKey = block.dataset.ocrRawMarket || '';
    const finalMarket = block.querySelector('.sel-market').value.trim();
    if (rawMarketKey && finalMarket.toLowerCase() !== rawMarketKey) {
      recordCorrection(bmKeyForLearning, 'markets', rawMarketKey, finalMarket);
    }
  });
  saveOcrMemory();

  saveBets();
  closeModal();
  render();
});

// Each-way bets always stake the same amount win and each-way — the field is readonly and
// just mirrors the win stake, rather than being independently editable.
function mirrorEwStakeFromWinStake() {
  if (document.getElementById('f-bet-type').value !== 'each-way') return;
  document.getElementById('f-ew-stake').value = document.getElementById('f-win-stake').value;
}

document.getElementById('f-bet-type').addEventListener('change', () => {
  updateEwFieldsVisibility();
  mirrorEwStakeFromWinStake();
  recalcModalTotals();
});
document.getElementById('f-manual-odds').addEventListener('change', updateOddsMode);
document.getElementById('f-win-stake').addEventListener('input', () => {
  mirrorEwStakeFromWinStake();
  recalcModalTotals();
});
document.getElementById('f-odds').addEventListener('input', recalcModalTotals);
// For a win-only bet marked Won, actual return can only ever equal potential return —
// so rather than a one-off copy (which could freeze in a stale value from mid-typing),
// this keeps the field locked and continuously mirrored while that's true.
function updateActualReturnMode() {
  const status = document.getElementById('f-status').value;
  const betType = document.getElementById('f-bet-type').value;
  const actualReturnField = document.getElementById('f-actual-return');
  const isWonWinOnly = status === 'won' && betType === 'win';

  actualReturnField.readOnly = isWonWinOnly;

  if (isWonWinOnly) {
    const rawPotential = document.getElementById('f-potential-return').value.trim();
    const potentialNum = rawPotential === '' ? NaN : Number(rawPotential.replace(/[£,\s]/g, ''));
    actualReturnField.value = isNaN(potentialNum) ? '' : potentialNum;
  } else if (status === 'lost' && actualReturnField.value === '') {
    actualReturnField.value = 0;
  } else if (status === 'open') {
    // Actual return has no meaning until a bet is settled — clear any value left over
    // from a previous status (e.g. reverting a bet that was marked lost by mistake).
    actualReturnField.value = '';
  }
}

document.getElementById('f-status').addEventListener('change', updateActualReturnMode);
attachAutocomplete(document.getElementById('f-bookmaker'), getKnownBookmakers, null, { showAllWhenEmpty: true });
attachSelectDropdown(document.getElementById('f-status'));
attachSelectDropdown(document.getElementById('f-bet-type'));
attachSelectDropdown(document.getElementById('filter-bookmaker'));
attachSelectDropdown(document.getElementById('filter-bet-type'));
attachSelectDropdown(document.getElementById('sort-by'));
selectionsEditor.addEventListener('input', (e) => {
  if (e.target.matches('.sel-price, .sel-ew-fraction, .sel-ew-places')) recalcModalTotals();

  if (e.target.matches('.sel-ew-fraction')) {
    const placesField = e.target.closest('.ew-fields').querySelector('.places-field');
    const winOnly = isWinOnlyFraction(e.target.value);
    placesField.hidden = winOnly;
    if (winOnly) {
      const placesInput = placesField.querySelector('.sel-ew-places');
      placesInput.value = '';
      placesField.querySelector('.places-suffix').hidden = true;
    }
  }

  if (e.target.matches('.sel-ew-places')) {
    e.target.closest('.places-field').querySelector('.places-suffix').hidden = e.target.value.trim() === '';
  }
});
function stepPlacesField(field, direction) {
  // Places field has inverted spin direction: down increments (1, 2, 3...), up decrements.
  const min = Number(field.min) || 1;
  const current = field.value === '' ? min - 1 : Number(field.value);
  const next = direction === 'down' ? current + 1 : Math.max(min, current - 1);
  field.value = next;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
selectionsEditor.addEventListener('keydown', (e) => {
  if (!e.target.matches('.sel-ew-places')) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  stepPlacesField(e.target, e.key === 'ArrowDown' ? 'down' : 'up');
});
selectionsEditor.addEventListener('click', (e) => {
  const spinBtn = e.target.closest('.places-spin-up, .places-spin-down');
  if (!spinBtn) return;
  e.preventDefault();
  const field = spinBtn.closest('.places-field').querySelector('.sel-ew-places');
  stepPlacesField(field, spinBtn.classList.contains('places-spin-down') ? 'down' : 'up');
  field.focus();
});
// Covers typing a selection name out in full and tabbing/clicking away, rather than picking
// it from the dropdown (which triggers the same auto-fill via attachAutocomplete's onAccept).
selectionsEditor.addEventListener('focusout', (e) => {
  if (!e.target.matches('.sel-selection')) return;
  autofillCompetitionFromSelection(e.target.closest('.selection-block'));
});
selectionsEditor.addEventListener('change', (e) => {
  if (!e.target.matches('.sel-void')) return;
  const block = e.target.closest('.selection-block');
  const isVoid = e.target.checked;
  const priceField = block.querySelector('.sel-price');
  priceField.disabled = isVoid;
  priceField.required = !isVoid && !isManualOddsMode();
  const ewFields = block.querySelector('.ew-fields');
  if (ewFields) ewFields.querySelectorAll('input').forEach(inp => { inp.disabled = isVoid; });
  recalcModalTotals();
});
selectionsEditor.addEventListener('dragover', (e) => {
  if (!draggedSelectionBlock) return;
  e.preventDefault();
  const targetBlock = e.target.closest('.selection-block');
  if (!targetBlock || targetBlock === draggedSelectionBlock) return;
  const rect = targetBlock.getBoundingClientRect();
  const isBelowMidpoint = e.clientY > rect.top + rect.height / 2;
  selectionsEditor.insertBefore(draggedSelectionBlock, isBelowMidpoint ? targetBlock.nextSibling : targetBlock);
});
document.getElementById('btn-scan').addEventListener('click', () => {
  document.getElementById('f-screenshot').click();
});
document.getElementById('f-screenshot').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) runScan(file);
});
document.getElementById('btn-add').addEventListener('click', () => openModal(null));
document.getElementById('btn-close-stat-detail').addEventListener('click', () => {
  document.getElementById('stat-detail-backdrop').hidden = true;
});
document.getElementById('btn-top-selections').addEventListener('click', openTopSelectionsModal);
document.getElementById('btn-top-selections-back').addEventListener('click', renderTopSelectionsRanking);
document.getElementById('btn-close-top-selections').addEventListener('click', () => {
  document.getElementById('top-selections-backdrop').hidden = true;
});
document.getElementById('btn-close-modal').addEventListener('click', closeModal);
document.getElementById('btn-modal-back').addEventListener('click', closeModal);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('btn-add-selection').addEventListener('click', () => { addSelectionRow(); recalcModalTotals(); });

document.getElementById('btn-delete-bet').addEventListener('click', () => {
  const id = document.getElementById('bet-id').value;
  if (id && confirm('Delete this bet? This cannot be undone.')) {
    bets = bets.filter(b => b.id !== id);
    saveBets();
    closeModal();
    render();
  }
});

// ---------- Filters ----------

['search-input', 'filter-status', 'filter-bookmaker', 'filter-bet-type', 'filter-date-from', 'filter-date-to', 'sort-by'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => { currentPage = 1; render(); });
  document.getElementById(id).addEventListener('change', () => { currentPage = 1; render(); });
});

document.getElementById('btn-clear-filters').addEventListener('click', () => {
  document.getElementById('search-input').value = '';
  document.getElementById('filter-status').value = '';
  document.getElementById('filter-bookmaker').value = '';
  document.getElementById('filter-bet-type').value = '';
  document.getElementById('filter-date-from').value = '';
  document.getElementById('filter-date-to').value = '';
  document.getElementById('sort-by').value = 'date-desc';
  currentPage = 1;
  render();
});

document.getElementById('btn-prev-page').addEventListener('click', () => {
  currentPage--;
  render();
});
document.getElementById('btn-next-page').addEventListener('click', () => {
  currentPage++;
  render();
});

// ---------- Export / Import ----------

document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(bets, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `acca-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('Invalid file format');
      const mode = confirm(
        `Import ${imported.length} bet(s).\n\nOK = merge with existing bets\nCancel = replace all existing bets`
      );
      if (mode) {
        const existingIds = new Set(bets.map(b => b.id));
        imported.forEach(b => {
          if (existingIds.has(b.id)) b.id = makeId();
          bets.push(b);
        });
      } else {
        bets = imported;
      }
      saveBets();
      render();
    } catch (err) {
      alert('Could not import file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------- Init ----------

render();
