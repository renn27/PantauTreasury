/* ================= REQUEST HEADERS (AMAN UNTUK BROWSER) ================= */
const REQUEST_HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-ID,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,id;q=0.6'
};

/* Pre-built Headers instance — tidak perlu dibuat ulang setiap fetch */
const FETCH_HEADERS = new Headers(REQUEST_HEADERS);

/* ================= NAMED CONSTANTS ================= */
const FETCH_TIMEOUT_MS = 3000;
const CACHE_LOCAL_TTL_MS = 30000;
const SIMULATION_TTL_MS = 86400000; // 24 jam
const SIMULATION_STORAGE_THROTTLE_MS = 5000;
const SIMULATION_BUY_BASE = 60000000;
const SIMULATION_SELL_BASE = 58005000;
const SIMULATION_GRAM_SUCCESS_THRESHOLD = 0.04;
const SIMULATION_PROFIT_SUCCESS_THRESHOLD = 100000;
const COUNTDOWN_SECONDS = 60;
const PRICE_HISTORY_LIMIT = 30;
const USD_IDR_WORKER_URL = 'https://tight-morning-90aa.ambaneguriha.workers.dev'; // Cloudflare Worker proxy untuk ticket embegeh.my.id
const USD_IDR_API_URL = 'https://open.er-api.com/v6/latest/USD'; // Fallback jika Worker belum di-set
const USD_IDR_WS_URL = 'wss://embegeh.my.id/ws';
const USD_IDR_POLL_MS = 5 * 60 * 1000; // poll setiap 5 menit (mode fallback)
const DEBUG = false;

/* ================= INSTANT LOAD ================= */
const priceCache = {
    data: null,
    timestamp: 0,
    isValid: () => Date.now() - priceCache.timestamp < CACHE_LOCAL_TTL_MS,
    get: () => priceCache.isValid() ? priceCache.data : null,
    set: (data) => {
        const prev = priceCache.data;
        const isSamePayload = !!prev &&
            prev.buy === data.buy &&
            prev.sell === data.sell &&
            prev.updated === data.updated;

        priceCache.data = data;
        priceCache.timestamp = Date.now();

        if (isSamePayload) {
            return;
        }

        try {
            const payload = JSON.stringify({ data, timestamp: Date.now() });
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => {
                    try { localStorage.setItem('gold_cache', payload); } catch (e) { }
                });
            } else {
                localStorage.setItem('gold_cache', payload);
            }
        } catch (e) { }
    }
};

// Load from localStorage
try {
    const saved = localStorage.getItem('gold_cache');
    if (saved) {
        const parsed = JSON.parse(saved);
        if (Date.now() - parsed.timestamp < CACHE_LOCAL_TTL_MS) {
            priceCache.data = parsed.data;
            priceCache.timestamp = parsed.timestamp;
        }
    }
} catch (e) { }

/* ================= GLOBAL STATE ================= */
let state = {
    countdown: COUNTDOWN_SECONDS,
    countdownExpiredTriggered: false,
    timerTicker: null,
    fetchController: null,
    isAutoFetching: false,
    isManualRefresh: false,
    retryCount: 0,
    MAX_RETRY: 5,
    simulation: {
        buyPrice: null,
        sellPrice: null,
        mode: null,
        gram: null
    },
    chartWidth: '1/4',
    targetMinute: null,
    isRetrying: false,
    lastFetchTime: null,
    isFetching: false,
    fetchSeq: 0,
    retryTimeoutId: null,
    lastRenderedBuy: null,
    lastRenderedSell: null,
    lastSimulationStorageKey: null,
    simulationStorageLastSavedAt: 0,
    usdIdrPollTimeoutId: null,
    usdIdrWs: null,
    usdIdrReconnectAttempt: 0,
    usdIdrLastPrice: null,
    usdIdrLastChange: null,
    usdIdrHistory: [],
    priceHistory: [],
    currentBuy: null,
    currentSell: null,
    simulationNodes: {
        buy: null,
        sell: null
    },
    simulationSlots: {
        buy: null,
        sell: null
    },
    previewTimeout: null
};

/* ================= DOM CACHE ================= */
const dom = {};
const buttonFeedbackOriginalContent = new WeakMap();
const buttonFeedbackTimers = new WeakMap();
const BUTTON_FEEDBACK_CLASSES = [
    'bg-green-600', 'dark:bg-green-700',
    'bg-red-600', 'dark:bg-red-700',
    'text-white', 'scale-105', 'shake',
    'opacity-90', 'cursor-wait'
];
let simStatusSlots = null;

/* ================= FAST HELPER FUNCTIONS ================= */
const formatRupiah = new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0
}).format;
const formatTimeId = new Intl.DateTimeFormat('id-ID').format;
const formatTimeIdHms = new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
}).format;

// Cache DOM elements instantly on script execution (since script is deferred, DOM is ready)
const ids = [
    'buyPriceCard', 'sellPriceCard', 'hargaBeli', 'hargaJual', 'hargaBeliChange', 'hargaJualChange', 'spreadPersen',
    'gramBeli', 'gramJual', 'nilaiJual', 'cuan', 'lastUpdate',
    'countdown', 'countdownBar', 'simulationResults', 'noSimulation',
    'simulationStatus', 'markBuyBtn', 'markSellBtn',
    'refreshApiBtn', 'themeText', 'bigRefreshBtn',
    'chartWidthBtn', 'chartWidthMenu', 'settingsBtn', 'settingsMenu', 'dashboardGrid',
    'leftPanel', 'rightPanel', 'clearSimulationBtn', 'saveTradeBtn', 'simulationTimestamp',
    'darkModeBtn', 'refreshIframeBtn', 'fullscreenBtn', 'timeIframe', 'tvIframe',
    'manualGramInput', 'manualGramError', 'applyManualBuyBtn', 'applyManualSellBtn',
    'manualBuyPricePreview', 'manualSellPricePreview',
    'openManualGramModalBtn', 'manualGramModal', 'manualGramModalBackdrop', 'closeManualGramModalBtn', 'manualGramModalContent',
    'usdIdrCard', 'usdIdrRate', 'usdIdrTime', 'usdIdrChange',
    'usdIdrHistoryDropdown', 'usdIdrHistoryList', 'usdIdrHistoryCount',
    'buyPriceHistoryDropdown', 'buyPriceHistoryList', 'buyPriceHistoryCount',
    'sellPriceHistoryDropdown', 'sellPriceHistoryList', 'sellPriceHistoryCount',
    'promoBadge', 'promoPriceVal', 'limitBulanVal'
];
ids.forEach(id => {
    dom[id] = document.getElementById(id);
});

// Load promo/limit from cache
try {
    const savedPromo = localStorage.getItem('promo_limit_cache');
    if (savedPromo) {
        const parsed = JSON.parse(savedPromo);
        renderPromoLimitInfo(parsed.promo_status, parsed.limit_bulan, parsed.promo_price);
    }
} catch (e) { }

// Render cached data immediately
loadPriceHistory();
renderPriceHistoryDropdown('buy');
renderPriceHistoryDropdown('sell');
renderCachedData();
// Fetch fresh data immediately (starts network request parallel to DOM Ready parsing)
fetchHarga();
renderCachedUsdIdr();
connectUsdIdrFeed();

function debugLog(...args) {
    if (DEBUG) console.log(...args);
}

function floor4(num) {
    return Math.floor(num * 10000) / 10000;
}

function fastParse(str) {
    if (!str) return 0;
    let n = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code > 47 && code < 58) n = n * 10 + (code - 48);
    }
    return n;
}

function parsePositiveFloat(rawValue) {
    if (rawValue === null || rawValue === undefined) return null;
    const normalized = String(rawValue).trim().replace(/,/g, '.');
    if (!normalized) return null;
    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value;
}

function isSameMinuteBucket(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate() &&
        a.getHours() === b.getHours() &&
        a.getMinutes() === b.getMinutes();
}

function clearRetryTimeout() {
    if (state.retryTimeoutId) {
        clearTimeout(state.retryTimeoutId);
        state.retryTimeoutId = null;
    }
}

function getSimulationStorageKey() {
    const sim = state.simulation || {};
    return [
        sim.mode || '',
        sim.buyPrice || '',
        sim.sellPrice || '',
        sim.gram !== null && sim.gram !== undefined ? Number(sim.gram).toFixed(6) : ''
    ].join('|');
}

function updateCountdownDisplay() {
    if (dom.countdown) dom.countdown.textContent = `${state.countdown}s`;
    if (dom.countdownBar) {
        const progress = Math.max(0, Math.min(1, state.countdown / COUNTDOWN_SECONDS));
        dom.countdownBar.style.transform = `scaleX(${progress})`;
    }
}

/* Unified color class setter — menggantikan setCuanColorClass & setProfitColorClass */
function setProfitColorClass(el, isPositive) {
    if (!el) return;
    const cl = el.classList;
    cl.remove('text-green-600', 'dark:text-green-400', 'text-red-600', 'dark:text-red-400');
    if (isPositive) {
        cl.add('text-green-600', 'dark:text-green-400');
    } else {
        cl.add('text-red-600', 'dark:text-red-400');
    }
}

function renderPriceValue(el, current, previous) {
    if (!el) return;

    el.classList.remove('price-loading');
    el.removeAttribute('aria-busy');
    el.textContent = formatRupiah(current);

    if (!Number.isFinite(previous) || current === previous) return;

    const isUp = current > previous;
    const rollClass = isUp ? 'price-roll-up' : 'price-roll-down';
    const cardClass = isUp ? 'price-card-rise' : 'price-card-fall';
    const card = el.closest('.glass-card');

    el.classList.remove('price-roll-up', 'price-roll-down');
    card?.classList.remove('price-card-rise', 'price-card-fall');
    void el.offsetWidth;
    el.classList.add(rollClass);
    card?.classList.add(cardClass);
}

function renderPriceChangeIndicator(el, current, previous) {
    if (!el) return;

    el.classList.remove('price-change-up', 'price-change-down', 'price-change-neutral');

    if (!Number.isFinite(previous) || previous <= 0) {
        el.textContent = '-';
        el.setAttribute('aria-label', 'Belum ada perubahan harga');
        el.classList.add('price-change-neutral');
        return;
    }

    const change = current - previous;
    if (change === 0) {
        el.innerHTML = `
            <svg class="price-change-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 12h12"></path>
            </svg>
            <span>${formatRupiah(0)}</span>
        `;
        el.setAttribute('aria-label', 'Harga tetap Rp 0');
        el.classList.add('price-change-neutral');
        return;
    }

    const arrowPath = change > 0
        ? 'M7 17L17 7M8 7h9v9'
        : 'M7 7l10 10m0-9v9H8';
    const label = change > 0 ? 'Harga naik' : 'Harga turun';
    const direction = change > 0 ? 'price-change-up' : 'price-change-down';
    const formattedChange = formatRupiah(Math.abs(change));
    el.innerHTML = `
        <svg class="price-change-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="${arrowPath}"></path>
        </svg>
        <span>${formattedChange}</span>
    `;
    el.setAttribute('aria-label', `${label} ${formattedChange}`);
    el.classList.add(direction);
}

function getPriceHistoryStorageKey() {
    return 'treasury_price_history';
}

function loadPriceHistory() {
    try {
        const saved = localStorage.getItem(getPriceHistoryStorageKey());
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return;

        state.priceHistory = parsed
            .map(item => ({
                buy: Number(item.buy),
                sell: Number(item.sell),
                updated: item.updated
            }))
            .filter(item => Number.isFinite(item.buy) && Number.isFinite(item.sell) && item.updated)
            .slice(-PRICE_HISTORY_LIMIT);
    } catch (e) { }
}

function savePriceHistory() {
    try {
        localStorage.setItem(
            getPriceHistoryStorageKey(),
            JSON.stringify(state.priceHistory.slice(-PRICE_HISTORY_LIMIT))
        );
    } catch (e) { }
}

function addPriceHistoryEntry(data) {
    const buy = Number(data.buy);
    const sell = Number(data.sell);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || !data.updated) return;

    const latest = state.priceHistory[state.priceHistory.length - 1];
    if (latest && latest.updated === data.updated && latest.buy === buy && latest.sell === sell) {
        return;
    }

    state.priceHistory.push({ buy, sell, updated: data.updated });
    state.priceHistory = state.priceHistory.slice(-PRICE_HISTORY_LIMIT);
    savePriceHistory();
    renderPriceHistoryDropdown('buy');
    renderPriceHistoryDropdown('sell');
}

function getPriceHistoryElements(type) {
    const isBuy = type === 'buy';
    return {
        card: isBuy ? dom.buyPriceCard : dom.sellPriceCard,
        dropdown: isBuy ? dom.buyPriceHistoryDropdown : dom.sellPriceHistoryDropdown,
        list: isBuy ? dom.buyPriceHistoryList : dom.sellPriceHistoryList,
        count: isBuy ? dom.buyPriceHistoryCount : dom.sellPriceHistoryCount
    };
}

function renderPriceHistoryDropdown(type) {
    const { list, count } = getPriceHistoryElements(type);
    if (!list) return;

    const history = state.priceHistory || [];
    if (count) count.textContent = String(history.length);

    if (!history.length) {
        list.innerHTML = '<p class="price-history-empty">Menunggu data</p>';
        return;
    }

    const valueKey = type === 'buy' ? 'buy' : 'sell';
    list.innerHTML = history
        .slice()
        .reverse()
        .map((item, index, reversed) => {
            const nextOlder = reversed[index + 1];
            const value = Number(item[valueKey]);
            const change = nextOlder ? value - Number(nextOlder[valueKey]) : 0;
            const directionClass = change > 0
                ? 'usd-idr-history-pill-up'
                : change < 0
                    ? 'usd-idr-history-pill-down'
                    : 'usd-idr-history-pill-neutral';
            const arrowPath = change > 0
                ? 'M7 17L17 7M8 7h9v9'
                : change < 0
                    ? 'M7 7l10 10m0-9v9H8'
                    : 'M6 12h12';
            const updated = new Date(item.updated);
            const time = Number.isNaN(updated.getTime()) ? '-' : formatTimeIdHms(updated);

            return `
            <div class="price-history-item price-history-item--clickable" data-price="${value}" data-type="${type}" role="button" tabindex="0" title="Klik untuk simulasi ${type === 'buy' ? 'beli' : 'jual'} Rp ${value.toLocaleString('id-ID')}">
                <span class="price-history-time font-numeric">${time}</span>
                <span class="price-history-price font-numeric">${formatRupiah(value)}</span>
                <span class="usd-idr-history-pill ${directionClass} font-numeric">
                    <svg class="usd-idr-history-pill-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="${arrowPath}"></path>
                    </svg>
                    <span>${change === 0 ? formatRupiah(0) : formatRupiah(Math.abs(change))}</span>
                </span>
            </div>
        `;
        })
        .join('');
}

/**
 * Trigger simulasi langsung dari klik row harga di dropdown.
 * @param {'buy'|'sell'} type
 * @param {number} price
 */
function simulateFromHistory(type, price) {
    if (!price || price <= 0) return;
    if (type === 'buy') {
        state.simulation.buyPrice = price;
        state.simulation.sellPrice = null;
        state.simulation.mode = 'buy';
        state.simulation.gram = SIMULATION_BUY_BASE / price;
        dom.markBuyBtn?.classList.add('simulation-active');
        dom.markSellBtn?.classList.remove('simulation-active');
    } else {
        state.simulation.sellPrice = price;
        state.simulation.buyPrice = null;
        state.simulation.mode = 'sell';
        state.simulation.gram = SIMULATION_SELL_BASE / price;
        dom.markSellBtn?.classList.add('simulation-active');
        dom.markBuyBtn?.classList.remove('simulation-active');
    }
    updateSimulation();
    // Tutup dropdown setelah memilih
    togglePriceHistoryDropdown(type, false);
    // Scroll ke area simulasi
    dom.simulationResults?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Pasang event delegation pada list container untuk klik row harga.
 * Dipanggil setiap kali dropdown dibuka (innerHTML bisa berubah).
 */
function attachPriceHistoryClickDelegation(list, type) {
    if (!list || list._historyClickBound) return;
    list._historyClickBound = true;
    list.addEventListener('click', (e) => {
        const row = e.target.closest('.price-history-item--clickable');
        if (!row) return;
        const price = Number(row.dataset.price);
        const rowType = row.dataset.type || type;
        simulateFromHistory(rowType, price);
    });
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.price-history-item--clickable');
        if (!row) return;
        e.preventDefault();
        const price = Number(row.dataset.price);
        const rowType = row.dataset.type || type;
        simulateFromHistory(rowType, price);
    });
}

function togglePriceHistoryDropdown(type, forceOpen) {
    const { card, dropdown } = getPriceHistoryElements(type);
    if (!card || !dropdown) return;

    const shouldOpen = forceOpen === undefined
        ? dropdown.classList.contains('hidden')
        : forceOpen;

    dropdown.classList.toggle('hidden', !shouldOpen);
    card.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

    if (shouldOpen) {
        const otherType = type === 'buy' ? 'sell' : 'buy';
        togglePriceHistoryDropdown(otherType, false);
        toggleUsdIdrHistoryDropdown(false);
        renderPriceHistoryDropdown(type);
        // Pasang event delegation setelah render
        const { list } = getPriceHistoryElements(type);
        attachPriceHistoryClickDelegation(list, type);
    }
}

function parseUsdIdrPrice(rawPrice) {
    if (!rawPrice) return null;
    const normalized = String(rawPrice).trim().replace(/,/g, '');
    const value = Number(normalized);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function formatUsdIdrRate(value) {
    return new Intl.NumberFormat('id-ID', {
        minimumFractionDigits: 4,
        maximumFractionDigits: 4
    }).format(value);
}

function renderUsdIdrRate(price, time, comparisonPrice) {
    if (!dom.usdIdrRate) return;

    const value = parseUsdIdrPrice(price);
    if (!value) return;

    const previous = comparisonPrice === undefined ? state.usdIdrLastPrice : comparisonPrice;
    state.usdIdrLastPrice = value;

    dom.usdIdrRate.textContent = formatUsdIdrRate(value);
    dom.usdIdrRate.classList.remove(
        'text-green-600', 'dark:text-green-400',
        'text-red-600', 'dark:text-red-400',
        'text-gray-900', 'dark:text-gray-100'
    );

    if (Number.isFinite(previous) && previous !== value) {
        const isUp = value > previous;
        dom.usdIdrRate.classList.add(
            isUp ? 'text-green-600' : 'text-red-600',
            isUp ? 'dark:text-green-400' : 'dark:text-red-400'
        );
    } else {
        dom.usdIdrRate.classList.add('text-gray-900', 'dark:text-gray-100');
    }

    if (Number.isFinite(previous) && previous > 0 && previous !== value) {
        renderUsdIdrChangeIndicator(value, previous);
    }

    setUsdIdrStatus(time || 'Live');

    try {
        localStorage.setItem('usd_idr_cache', JSON.stringify({ price, time, savedAt: Date.now() }));
    } catch (e) { }
}

function setUsdIdrStatus(text) {
    if (!dom.usdIdrTime) return;
    dom.usdIdrTime.textContent = text;
}

function renderUsdIdrChangeIndicator(current, previous) {
    if (!dom.usdIdrChange) return;

    dom.usdIdrChange.classList.remove('price-change-up', 'price-change-down', 'price-change-neutral');

    const change = current - previous;
    const arrowPath = change > 0
        ? 'M7 17L17 7M8 7h9v9'
        : 'M7 7l10 10m0-9v9H8';
    const direction = change > 0 ? 'price-change-up' : 'price-change-down';
    const label = change > 0 ? 'USD IDR naik' : 'USD IDR turun';
    const formattedChange = formatUsdIdrRate(Math.abs(change));

    dom.usdIdrChange.innerHTML = `
        <svg class="usd-idr-history-pill-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="${arrowPath}"></path>
        </svg>
        <span>${formattedChange}</span>
    `;
    dom.usdIdrChange.setAttribute('aria-label', `${label} ${formattedChange}`);
    dom.usdIdrChange.classList.add(direction);

    state.usdIdrLastChange = {
        current,
        previous,
        direction,
        formattedChange,
        label
    };

    try {
        localStorage.setItem('usd_idr_change_cache', JSON.stringify(state.usdIdrLastChange));
    } catch (e) { }
}

function renderCachedUsdIdrChange() {
    if (!dom.usdIdrChange) return;

    try {
        const saved = localStorage.getItem('usd_idr_change_cache');
        if (!saved) return;
        const cached = JSON.parse(saved);
        if (!cached || !cached.direction || !cached.formattedChange) return;

        state.usdIdrLastChange = cached;
        const arrowPath = cached.direction === 'price-change-up'
            ? 'M7 17L17 7M8 7h9v9'
            : 'M7 7l10 10m0-9v9H8';

        dom.usdIdrChange.classList.remove('price-change-up', 'price-change-down', 'price-change-neutral');
        dom.usdIdrChange.innerHTML = `
            <svg class="usd-idr-history-pill-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="${arrowPath}"></path>
            </svg>
            <span>${cached.formattedChange}</span>
        `;
        dom.usdIdrChange.setAttribute('aria-label', `${cached.label || 'USD IDR berubah'} ${cached.formattedChange}`);
        dom.usdIdrChange.classList.add(cached.direction);
    } catch (e) { }
}

function findUsdIdrComparisonPrice(history, latestValue) {
    if (Number.isFinite(state.usdIdrLastPrice) && state.usdIdrLastPrice > 0 && state.usdIdrLastPrice !== latestValue) {
        return state.usdIdrLastPrice;
    }

    for (let i = history.length - 2; i >= 0; i--) {
        const candidate = parseUsdIdrPrice(history[i]?.price);
        if (candidate && candidate !== latestValue) return candidate;
    }

    return state.usdIdrLastPrice;
}

function renderUsdIdrHistory(history) {
    if (!Array.isArray(history) || !history.length) return;

    const normalizedHistory = history
        .map(item => ({
            price: item?.price,
            time: item?.time,
            value: parseUsdIdrPrice(item?.price)
        }))
        .filter(item => item.value);

    if (!normalizedHistory.length) return;

    state.usdIdrHistory = normalizedHistory;
    renderUsdIdrHistoryDropdown();

    let latest = null;
    for (let i = history.length - 1; i >= 0; i--) {
        const value = parseUsdIdrPrice(history[i]?.price);
        if (value) {
            latest = { ...history[i], value };
            break;
        }
    }

    if (!latest) return;

    const comparisonPrice = findUsdIdrComparisonPrice(history, latest.value);
    renderUsdIdrRate(latest.price, latest.time, comparisonPrice);
}

function renderUsdIdrHistoryDropdown() {
    if (!dom.usdIdrHistoryList) return;

    const history = state.usdIdrHistory || [];
    if (dom.usdIdrHistoryCount) dom.usdIdrHistoryCount.textContent = String(history.length);

    if (!history.length) {
        dom.usdIdrHistoryList.innerHTML = '<p class="usd-idr-history-empty">Menunggu data</p>';
        return;
    }

    dom.usdIdrHistoryList.innerHTML = history
        .slice()
        .reverse()
        .map((item, index, reversed) => {
            const nextOlder = reversed[index + 1];
            const change = nextOlder ? item.value - nextOlder.value : 0;
            const directionClass = change > 0
                ? 'usd-idr-history-pill-up'
                : change < 0
                    ? 'usd-idr-history-pill-down'
                    : 'usd-idr-history-pill-neutral';
            const arrowPath = change > 0
                ? 'M7 17L17 7M8 7h9v9'
                : change < 0
                    ? 'M7 7l10 10m0-9v9H8'
                    : 'M6 12h12';
            const pillValue = change === 0 ? '0,0000' : formatUsdIdrRate(Math.abs(change));

            return `
            <div class="usd-idr-history-item">
                <span class="usd-idr-history-time font-numeric">${item.time || '-'}</span>
                <span class="usd-idr-history-price font-numeric">${formatUsdIdrRate(item.value)}</span>
                <span class="usd-idr-history-pill ${directionClass} font-numeric">
                    <svg class="usd-idr-history-pill-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="${arrowPath}"></path>
                    </svg>
                    <span>${pillValue}</span>
                </span>
            </div>
        `;
        })
        .join('');
}

function toggleUsdIdrHistoryDropdown(forceOpen) {
    if (!dom.usdIdrCard || !dom.usdIdrHistoryDropdown) return;

    const shouldOpen = forceOpen === undefined
        ? dom.usdIdrHistoryDropdown.classList.contains('hidden')
        : forceOpen;

    dom.usdIdrHistoryDropdown.classList.toggle('hidden', !shouldOpen);
    dom.usdIdrCard.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

    if (shouldOpen) {
        togglePriceHistoryDropdown('buy', false);
        togglePriceHistoryDropdown('sell', false);
        renderUsdIdrHistoryDropdown();
    }
}

function renderCachedUsdIdr() {
    try {
        const saved = localStorage.getItem('usd_idr_cache');
        if (!saved) return;
        const cached = JSON.parse(saved);
        if (!cached || !cached.price) return;
        renderUsdIdrRate(cached.price, cached.time);
        renderCachedUsdIdrChange();
        setUsdIdrStatus(cached.time ? `Cached ${cached.time}` : 'Cached');
    } catch (e) { }
}

function setUsdIdrUnavailableStatus(text = 'Tidak tersedia') {
    if (state.usdIdrLastPrice) {
        setUsdIdrStatus(text);
        return;
    }

    if (dom.usdIdrRate) dom.usdIdrRate.textContent = '-';
    if (dom.usdIdrChange) {
        dom.usdIdrChange.textContent = '-';
        dom.usdIdrChange.classList.remove('price-change-up', 'price-change-down');
        dom.usdIdrChange.classList.add('price-change-neutral');
        dom.usdIdrChange.setAttribute('aria-label', text);
    }
    setUsdIdrStatus(text);
}

function scheduleUsdIdrPoll(immediate = false) {
    if (state.usdIdrPollTimeoutId) {
        clearTimeout(state.usdIdrPollTimeoutId);
        state.usdIdrPollTimeoutId = null;
    }
    const delay = immediate ? 0 : USD_IDR_POLL_MS;
    state.usdIdrPollTimeoutId = setTimeout(connectUsdIdrFeed, delay);
}

function closeUsdIdrFeed() {
    if (state.usdIdrPollTimeoutId) {
        clearTimeout(state.usdIdrPollTimeoutId);
        state.usdIdrPollTimeoutId = null;
    }
}

async function connectUsdIdrFeed() {
    if (!dom.usdIdrRate) return;
    if (document.hidden || navigator.onLine === false) {
        scheduleUsdIdrPoll();
        return;
    }

    // === MODE 1: embegeh WebSocket via Cloudflare Worker proxy ===
    if (USD_IDR_WORKER_URL) {
        try {
            const ticketRes = await fetch(USD_IDR_WORKER_URL);
            if (!ticketRes.ok) throw new Error(`Ticket HTTP ${ticketRes.status}`);
            const ticketData = await ticketRes.json();
            const ticket = ticketData.ticket;
            if (!ticket) throw new Error('Tiket tidak valid');

            // Tutup koneksi lama jika ada
            if (state.usdIdrWs) {
                state.usdIdrWs.onclose = null;
                state.usdIdrWs.close();
                state.usdIdrWs = null;
            }

            const ws = new WebSocket(`${USD_IDR_WS_URL}?ticket=${ticket}`);
            state.usdIdrWs = ws;

            ws.onopen = () => {
                state.usdIdrReconnectAttempt = 0;
                if (!state.usdIdrLastPrice) setUsdIdrStatus('Live');
            };

            ws.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    if (payload.usd_idr_history) renderUsdIdrHistory(payload.usd_idr_history);
                    if (payload.limit_bulan !== undefined || payload.promo_status !== undefined || payload.promo_price !== undefined) {
                        renderPromoLimitInfo(payload.promo_status, payload.limit_bulan, payload.promo_price);
                    }
                } catch (e) { }
            };

            ws.onerror = () => {
                if (ws.readyState === WebSocket.OPEN) ws.close();
            };

            ws.onclose = () => {
                if (state.usdIdrWs === ws) state.usdIdrWs = null;
                setUsdIdrUnavailableStatus(state.usdIdrLastPrice ? 'Reconnecting...' : 'Tidak tersedia');
                // Reconnect: ambil tiket baru lagi
                state.usdIdrPollTimeoutId = setTimeout(connectUsdIdrFeed, 15000);
            };

            return; // Selesai - koneksi WS berhasil dibuat
        } catch (e) {
            debugLog('embegeh WS error, fallback ke polling:', e);
            // Lanjut ke mode fallback di bawah
        }
    }

    // === MODE 2: Fallback - HTTP Polling open.er-api.com ===
    try {
        const res = await fetch(USD_IDR_API_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.result !== 'success' || !data.rates || !data.rates.IDR) {
            throw new Error('Data tidak valid');
        }

        const idrRate = data.rates.IDR;
        const timeLabel = new Date().toLocaleTimeString('id-ID', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });

        const newEntry = { price: idrRate.toFixed(4), time: timeLabel, value: idrRate };
        state.usdIdrHistory = [...state.usdIdrHistory, newEntry].slice(-30);
        renderUsdIdrHistoryDropdown();

        const previous = state.usdIdrLastPrice;
        renderUsdIdrRate(idrRate.toFixed(4), `Live ${timeLabel}`, previous);

        scheduleUsdIdrPoll();
    } catch (e) {
        debugLog('USD/IDR fetch error:', e);
        setUsdIdrUnavailableStatus(state.usdIdrLastPrice ? 'Gagal, coba lagi...' : 'Tidak tersedia');
        state.usdIdrPollTimeoutId = setTimeout(connectUsdIdrFeed, 30000);
    }
}

/* ================= SHARED: Compute Derived Values ================= */
function computeDerivedValues(buy, sell) {
    const spread = buy - sell;
    const spreadPercent = (spread / buy * 100).toFixed(2);
    const gramBeli = floor4(SIMULATION_BUY_BASE / buy);
    const gramJual = floor4(SIMULATION_SELL_BASE / sell);
    const nilaiJual = (SIMULATION_BUY_BASE / buy * sell);
    const cuan = nilaiJual - SIMULATION_SELL_BASE;
    return { spread, spreadPercent, gramBeli, gramJual, nilaiJual, cuan };
}

/* ================= SHARED: Render Derived Values to DOM ================= */
function renderDerivedValues(values) {
    const { spread, spreadPercent, gramBeli, gramJual, nilaiJual, cuan } = values;

    if (dom.spreadPersen) dom.spreadPersen.textContent = `-${spreadPercent} %`;
    if (dom.gramBeli) dom.gramBeli.textContent = `${gramBeli.toFixed(4)} g`;
    if (dom.gramJual) dom.gramJual.textContent = `${gramJual} g`;
    if (dom.nilaiJual) dom.nilaiJual.textContent = formatRupiah(nilaiJual);

    if (dom.cuan) {
        dom.cuan.textContent = formatRupiah(cuan);
        setProfitColorClass(dom.cuan, cuan >= 0);
    }
}

/* ================= SHARED: Render Promo & Limit Info ================= */
function renderPromoLimitInfo(promoStatus, limitBulan, promoPrice) {
    if (dom.promoBadge) {
        if (promoStatus === true || promoStatus === 'true') {
            dom.promoBadge.textContent = 'ON';
            dom.promoBadge.className = 'text-xxs px-1.5 py-0.5 rounded-full font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
        } else {
            dom.promoBadge.textContent = 'OFF';
            dom.promoBadge.className = 'text-xxs px-1.5 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
        }
    }
    
    if (dom.limitBulanVal) {
        dom.limitBulanVal.textContent = limitBulan !== undefined && limitBulan !== null ? limitBulan : '-';
    }
    
    if (dom.promoPriceVal) {
        dom.promoPriceVal.textContent = promoPrice ? formatRupiah(promoPrice) : '-';
    }
    
    // Save to cache
    try {
        localStorage.setItem('promo_limit_cache', JSON.stringify({
            promo_status: promoStatus,
            limit_bulan: limitBulan,
            promo_price: promoPrice
        }));
    } catch (e) {}
}

/* ================= SHARED: Manual Refresh ================= */
function triggerManualRefresh() {
    state.isManualRefresh = true;
    state.isAutoFetching = false;
    state.isRetrying = false;
    state.retryCount = 0;
    state.targetMinute = null;
    clearRetryTimeout();

    if (state.fetchController) state.fetchController.abort();
    fetchHarga();
}

/* ================= SHARED: Button Feedback ================= */
function showButtonFeedback(btn, type, duration) {
    if (!btn) return;
    if (!buttonFeedbackOriginalContent.has(btn)) {
        buttonFeedbackOriginalContent.set(btn, btn.innerHTML);
    }

    const previousTimer = buttonFeedbackTimers.get(btn);
    if (previousTimer) {
        clearTimeout(previousTimer);
        buttonFeedbackTimers.delete(btn);
    }

    const originalContent = buttonFeedbackOriginalContent.get(btn);

    const icons = {
        success: '<path stroke-linecap="round" stroke-linejoin="round" d="M5 12l4.5 4.5L19 7" />',
        error: '<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />',
        loading: '<path stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 00-14.8-4L4 9m0 0V4m0 5h5M4 13a8 8 0 0014.8 4L20 15m0 0v5m0-5h-5" />'
    };

    const labels = { success: 'Tersimpan', error: 'Gagal', loading: 'Menyimpan' };
    const spinClass = type === 'loading' ? ' animate-spin' : '';
    const colorClasses = {
        success: ['bg-green-600', 'text-white', 'dark:bg-green-700', 'scale-105'],
        error: ['bg-red-600', 'text-white', 'dark:bg-red-700', 'shake'],
        loading: ['opacity-90', 'cursor-wait']
    };

    const label = labels[type] || '';
    const labelHtml = label ? `<span class="text-xs">${label}</span>` : '';

    btn.innerHTML = `
        <span class="flex items-center gap-1 px-1">
            <svg class="ui-icon w-4 h-4${spinClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                ${icons[type]}
            </svg>
            ${labelHtml}
        </span>
    `;

    const classes = colorClasses[type] || [];
    btn.classList.remove(...BUTTON_FEEDBACK_CLASSES);
    btn.classList.add(...classes);
    btn.disabled = type === 'loading';

    if (type === 'loading') {
        return; // Tidak auto-restore untuk loading
    }

    const timeoutId = setTimeout(() => {
        btn.innerHTML = originalContent;
        btn.disabled = false;
        btn.classList.remove(...BUTTON_FEEDBACK_CLASSES);
        buttonFeedbackTimers.delete(btn);
    }, duration || 1000);
    buttonFeedbackTimers.set(btn, timeoutId);
}

/* ================= SHARED: Schedule Retry ================= */
function scheduleRetry(reason) {
    if (!state.isAutoFetching) return;

    if (state.retryCount >= state.MAX_RETRY) {
        debugLog(`Max retry reached (${reason}), stopping`);
        state.isRetrying = false;
        state.retryCount = 0;
        state.targetMinute = null;
        clearRetryTimeout();
        return;
    }

    state.retryCount++;
    const delay = Math.min(2000, 500 + (state.retryCount * 300));
    debugLog(`Retry ${reason} ${state.retryCount}/${state.MAX_RETRY} in ${delay}ms`);

    clearRetryTimeout();
    state.retryTimeoutId = setTimeout(() => {
        state.retryTimeoutId = null;
        if (state.isAutoFetching && state.isRetrying) {
            fetchHarga();
        }
    }, delay);
}

/* ================= RENDER CACHED DATA INSTANTLY ================= */
function renderCachedData() {
    const cached = priceCache.get();
    if (!cached || !dom.hargaBeli) return false;

    debugLog('Rendering cached data');

    const buy = Number(cached.buy);
    const sell = Number(cached.sell);

    // Update harga
    renderPriceValue(dom.hargaBeli, buy, null);
    renderPriceValue(dom.hargaJual, sell, null);
    state.lastRenderedBuy = buy;
    state.lastRenderedSell = sell;
    state.currentBuy = buy;
    state.currentSell = sell;
    renderPriceChangeIndicator(dom.hargaBeliChange, buy, null);
    renderPriceChangeIndicator(dom.hargaJualChange, sell, null);

    // Update timestamp
    if (dom.lastUpdate) {
        const updated = new Date(cached.updated);
        dom.lastUpdate.textContent = formatTimeIdHms(updated);
    }

    // Hitung dan render derived values
    const values = computeDerivedValues(buy, sell);
    renderDerivedValues(values);

    return true;
}

/* ================= FUNGSI BARU: HANDLE TOUCH UNTUK TRADING VIEW ================= */
function fixTradingViewTouch() {
    const tvIframe = dom.tvIframe;
    const chartContainer = document.querySelector('.chart-container');

    if (!tvIframe || !chartContainer) return;

    // Deteksi device sentuh
    const isTouchDevice = ('ontouchstart' in window) ||
        (navigator.maxTouchPoints > 0);

    if (!isTouchDevice) return;

    debugLog('Mode sentuh aktif - optimasi Trading View');

    let isTouching = false;
    let startX, startY;
    let isHorizontalDrag = false;
    let isBodyTouchMoveAttached = false;
    let touchVisualState = 'idle';

    const handleBodyTouchMove = function (e) {
        if (isHorizontalDrag) {
            e.preventDefault();
        }
    };

    const attachBodyTouchMoveLock = function () {
        if (isBodyTouchMoveAttached) return;
        document.body.addEventListener('touchmove', handleBodyTouchMove, { passive: false });
        isBodyTouchMoveAttached = true;
    };

    const detachBodyTouchMoveLock = function () {
        if (!isBodyTouchMoveAttached) return;
        document.body.removeEventListener('touchmove', handleBodyTouchMove);
        isBodyTouchMoveAttached = false;
    };

    const setChartTouchVisual = function (nextState) {
        if (touchVisualState === nextState) return;
        chartContainer.classList.remove('chart-touch-active', 'chart-touch-drag');
        if (nextState === 'start') {
            chartContainer.classList.add('chart-touch-active');
        } else if (nextState === 'drag') {
            chartContainer.classList.add('chart-touch-drag');
        }
        touchVisualState = nextState;
    };

    const resetTouchState = function () {
        isTouching = false;
        isHorizontalDrag = false;
        document.body.classList.remove('chart-touching');
        setChartTouchVisual('idle');
        detachBodyTouchMoveLock();
    };

    // Saat mulai menyentuh
    tvIframe.addEventListener('touchstart', function (e) {
        isTouching = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isHorizontalDrag = false;

        // Lock scroll halaman
        document.body.classList.add('chart-touching');
        attachBodyTouchMoveLock();

        // Feedback visual (opsional)
        setChartTouchVisual('start');

    }, { passive: true });

    // Saat menggerakkan jari
    tvIframe.addEventListener('touchmove', function (e) {
        if (!isTouching) return;

        const moveX = Math.abs(e.touches[0].clientX - startX);
        const moveY = Math.abs(e.touches[0].clientY - startY);

        // DETEKSI GESER HORIZONTAL (mau geser chart)
        if (moveX > moveY && moveX > 10) {
            isHorizontalDrag = true;
            e.preventDefault(); // CEGAH SCROLL HALAMAN!

            // Feedback visual berbeda (opsional)
            setChartTouchVisual('drag');
        }

    }, { passive: false }); // passive: false PENTING untuk bisa preventDefault

    // Saat selesai menyentuh
    tvIframe.addEventListener('touchend', resetTouchState);

    // Saat sentuhan dibatalkan
    tvIframe.addEventListener('touchcancel', resetTouchState);
}

function updateThemeButtonText(isDark) {
    if (dom.themeText) {
        dom.themeText.textContent = isDark ? 'Light' : 'Dark';
    }
}

function syncTradingViewTheme(isDark) {
    const tvIframe = dom.tvIframe;
    if (!tvIframe) return;

    const nextTheme = isDark ? 'dark' : 'light';
    const templateSrc = tvIframe.dataset?.src;
    if (templateSrc) {
        const nextSrc = templateSrc.replace('{theme}', nextTheme);
        if (tvIframe.src !== nextSrc) {
            tvIframe.src = nextSrc;
        }
        return;
    }

    if (tvIframe.src) {
        tvIframe.src = tvIframe.src.replace(/theme=\w+/, `theme=${nextTheme}`);
    }
}

/* ================= INIT DOM ================= */
document.addEventListener('DOMContentLoaded', () => {
    debugLog('DOM Ready');

    // Load simulation from storage
    loadSimulationFromStorage();

    // Load chart width preference
    const savedWidth = localStorage.getItem('chartWidth');
    if (savedWidth) {
        state.chartWidth = savedWidth;
        applyChartWidth(savedWidth);
    }

    const initialIsDark = document.documentElement.classList.contains('dark');
    updateThemeButtonText(initialIsDark);
    if (dom.tvIframe && !dom.tvIframe.getAttribute('src')) {
        syncTradingViewTheme(initialIsDark);
    }

    // Bind events
    if (dom.clearSimulationBtn) {
        dom.clearSimulationBtn.addEventListener('click', clearSimulation);
    }

    // Setup modal toggle
    const closeManualGramModal = () => {
        if (dom.manualGramModal && dom.manualGramModalContent) {
            dom.manualGramModal.classList.add('opacity-0');
            dom.manualGramModalContent.classList.remove('scale-100');
            dom.manualGramModalContent.classList.add('scale-95');
            setTimeout(() => {
                dom.manualGramModal.classList.add('hidden');
            }, 300);
        }
    };

    const openManualGramModal = () => {
        if (dom.manualGramModal && dom.manualGramModalContent) {
            dom.manualGramModal.classList.remove('hidden');
            // Force reflow
            void dom.manualGramModal.offsetWidth;
            dom.manualGramModal.classList.remove('opacity-0');
            dom.manualGramModalContent.classList.remove('scale-95');
            dom.manualGramModalContent.classList.add('scale-100');

            // Focus on input when opened
            setTimeout(() => {
                if (dom.manualGramInput) dom.manualGramInput.focus();
            }, 100);
        }
    };

    if (dom.openManualGramModalBtn) {
        dom.openManualGramModalBtn.addEventListener('click', openManualGramModal);
    }

    if (dom.closeManualGramModalBtn) {
        dom.closeManualGramModalBtn.addEventListener('click', closeManualGramModal);
    }

    if (dom.manualGramModalBackdrop) {
        dom.manualGramModalBackdrop.addEventListener('click', closeManualGramModal);
    }

    if (dom.markBuyBtn) {
        dom.markBuyBtn.addEventListener('click', () => {
            const price = Number.isFinite(state.currentBuy) && state.currentBuy > 0
                ? state.currentBuy
                : fastParse(dom.hargaBeli.textContent);
            if (price > 0) {
                state.simulation.buyPrice = price;
                state.simulation.sellPrice = null;
                state.simulation.mode = 'buy';
                state.simulation.gram = SIMULATION_BUY_BASE / price;

                dom.markBuyBtn.classList.add('simulation-active');
                if (dom.markSellBtn) dom.markSellBtn.classList.remove('simulation-active');

                updateSimulation();
            }
        });
    }

    if (dom.markSellBtn) {
        dom.markSellBtn.addEventListener('click', () => {
            const price = Number.isFinite(state.currentSell) && state.currentSell > 0
                ? state.currentSell
                : fastParse(dom.hargaJual.textContent);
            if (price > 0) {
                state.simulation.sellPrice = price;
                state.simulation.buyPrice = null;
                state.simulation.mode = 'sell';
                state.simulation.gram = SIMULATION_SELL_BASE / price;

                dom.markSellBtn.classList.add('simulation-active');
                if (dom.markBuyBtn) dom.markBuyBtn.classList.remove('simulation-active');

                updateSimulation();
            }
        });
    }

    if (dom.manualGramInput) {
        dom.manualGramInput.addEventListener('input', updateManualPricePreview);
        dom.manualGramInput.addEventListener('blur', updateManualPricePreview);
    }

    dom.applyManualBuyBtn?.addEventListener('click', () => {
        if (applyManualGramSimulation('buy')) closeManualGramModal();
    });

    dom.applyManualSellBtn?.addEventListener('click', () => {
        if (applyManualGramSimulation('sell')) closeManualGramModal();
    });

    updateManualPricePreview();

    if (dom.refreshApiBtn) {
        dom.refreshApiBtn.addEventListener('click', triggerManualRefresh);
    }

    // Big refresh button
    if (dom.bigRefreshBtn) {
        dom.bigRefreshIcon = dom.bigRefreshBtn.querySelector('svg');
        if (dom.bigRefreshIcon) {
            dom.bigRefreshIcon.classList.add('refresh-icon');
            dom.bigRefreshIcon.addEventListener('animationend', () => {
                dom.bigRefreshIcon.classList.remove('refresh-spin-once');
            });
        }

        dom.bigRefreshBtn.addEventListener('click', () => {
            if (dom.bigRefreshIcon) {
                dom.bigRefreshIcon.classList.remove('refresh-spin-once');
                void dom.bigRefreshIcon.offsetWidth;
                dom.bigRefreshIcon.classList.add('refresh-spin-once');
            }
            triggerManualRefresh();
        });
    }

    if (dom.settingsBtn) {
        dom.settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dom.settingsMenu?.classList.toggle('hidden');
            dom.chartWidthMenu?.classList.add('hidden');
        });
    }

    if (dom.settingsMenu) {
        dom.settingsMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('.settings-menu-item')) {
                setTimeout(() => dom.settingsMenu.classList.add('hidden'), 0);
            }
        });
    }

    if (dom.usdIdrCard) {
        dom.usdIdrCard.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleUsdIdrHistoryDropdown();
        });

        dom.usdIdrCard.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            toggleUsdIdrHistoryDropdown();
        });
    }

    dom.usdIdrHistoryDropdown?.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    [
        { type: 'buy', card: dom.buyPriceCard, dropdown: dom.buyPriceHistoryDropdown },
        { type: 'sell', card: dom.sellPriceCard, dropdown: dom.sellPriceHistoryDropdown }
    ].forEach(({ type, card, dropdown }) => {
        if (card) {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePriceHistoryDropdown(type);
            });

            card.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                togglePriceHistoryDropdown(type);
            });
        }

        dropdown?.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    });

    // Chart width controls
    if (dom.chartWidthBtn) {
        dom.chartWidthBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = dom.chartWidthMenu;
            menu.classList.toggle('hidden');
            dom.settingsMenu?.classList.add('hidden');
        });
    }

    if (dom.chartWidthMenu) {
        dom.chartWidthMenu.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        const widthButtons = dom.chartWidthMenu.querySelectorAll('button[data-width]');
        widthButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const width = btn.getAttribute('data-width');
                applyChartWidth(width);
                dom.chartWidthMenu.classList.add('hidden');
            });
        });
    }

    // Close floating chart menus when clicking outside
    document.addEventListener('click', () => {
        if (dom.chartWidthMenu && !dom.chartWidthMenu.classList.contains('hidden')) {
            dom.chartWidthMenu.classList.add('hidden');
        }
        if (dom.settingsMenu && !dom.settingsMenu.classList.contains('hidden')) {
            dom.settingsMenu.classList.add('hidden');
        }
        toggleUsdIdrHistoryDropdown(false);
        togglePriceHistoryDropdown('buy', false);
        togglePriceHistoryDropdown('sell', false);
    });

    // Dark mode button
    const darkBtn = dom.darkModeBtn;
    if (darkBtn) {
        darkBtn.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('darkMode', isDark);

            // Update TradingView
            syncTradingViewTheme(isDark);

            // Update button text
            updateThemeButtonText(isDark);
        });
    }

    // Other buttons
    dom.refreshIframeBtn?.addEventListener('click', () => {
        const timeIframe = dom.timeIframe;
        const tvIframe = dom.tvIframe;
        if (timeIframe) timeIframe.src = timeIframe.src;
        if (tvIframe) tvIframe.src = tvIframe.src;
    });

    dom.fullscreenBtn?.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    });

    // Tombol Save
    dom.saveTradeBtn?.addEventListener("click", saveTradingToDatabase)

    // Start timers
    startTimers();

    // Pause/resume timer saat tab hidden/visible
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (state.timerTicker) {
                clearInterval(state.timerTicker);
                state.timerTicker = null;
            }
            closeUsdIdrFeed();
        } else {
            if (!state.timerTicker) {
                startTimers();
            }
            if (state.countdown <= 0 && !state.isFetching) {
                fetchHarga();
            }
            connectUsdIdrFeed();
        }
    });

    window.addEventListener('offline', () => {
        closeUsdIdrFeed();
        setUsdIdrUnavailableStatus('Offline');
    });

    window.addEventListener('online', () => {
        state.usdIdrReconnectAttempt = 0;
        connectUsdIdrFeed();
    });



    // PERBAIKAN: Panggil fungsi touch handler setelah iframe siap
    setTimeout(fixTradingViewTouch, 500);
});

/* ================= CHART WIDTH MANAGEMENT ================= */
function applyChartWidth(width) {
    state.chartWidth = width;
    localStorage.setItem('chartWidth', width);

    if (!dom.dashboardGrid || !dom.leftPanel || !dom.rightPanel) return;

    // Remove all width classes
    dom.dashboardGrid.classList.remove('grid-cols-4', 'grid-cols-3', 'grid-cols-2');
    dom.leftPanel.classList.remove('col-span-3', 'col-span-2', 'col-span-1');
    dom.rightPanel.classList.remove('col-span-1');

    switch (width) {
        case '1/4':
            dom.dashboardGrid.classList.add('grid-cols-4');
            dom.leftPanel.classList.add('col-span-3');
            dom.rightPanel.classList.add('col-span-1');
            break;
        case '1/3':
            dom.dashboardGrid.classList.add('grid-cols-3');
            dom.leftPanel.classList.add('col-span-2');
            dom.rightPanel.classList.add('col-span-1');
            break;
        case '1/2':
            dom.dashboardGrid.classList.add('grid-cols-2');
            dom.leftPanel.classList.add('col-span-1');
            dom.rightPanel.classList.add('col-span-1');
            break;
    }
}

/* ================= HYPER-FAST FETCH ================= */
async function fetchHarga() {
    debugLog('Fetching data...');

    const fetchSeq = ++state.fetchSeq;
    state.isFetching = true;
    state.lastFetchTime = Date.now();

    // TAMPILKAN STATUS FETCHING di UI
    if (dom.lastUpdate) {
        if (state.isRetrying) {
            dom.lastUpdate.textContent = `retry (${state.retryCount}/${state.MAX_RETRY})`;
        } else {
            dom.lastUpdate.textContent = 'Fetching...';
        }
    }

    // Cancel previous fetch
    if (state.fetchController) {
        state.fetchController.abort();
    }

    const controller = new AbortController();
    state.fetchController = controller;
    let isTimedOut = false;

    // Timeout
    const timeoutId = setTimeout(() => {
        isTimedOut = true;
        controller.abort();
    }, FETCH_TIMEOUT_MS);

    try {
        const start = Date.now();

        const res = await fetch('https://api.treasury.id/api/v1/antigrvty/gold/rate', {
            method: 'POST',
            signal: controller.signal,
            headers: FETCH_HEADERS,
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow',
            referrerPolicy: 'no-referrer'
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const json = await res.json();
        const data = json.data;
        if (!data) {
            throw new Error('Invalid API response');
        }

        const fetchTime = Date.now() - start;
        debugLog(`Fetch: ${fetchTime}ms`);

        // Process data
        const result = {
            buy: data.buying_rate,
            sell: data.selling_rate,
            updated: data.updated_at
        };

        // Periksa apakah data sudah sesuai dengan menit saat ini
        const updated = new Date(result.updated);
        const now = new Date();
        const isCurrentMinute = isSameMinuteBucket(updated, now);

        debugLog(`Data updated at: ${formatTimeId(updated)}`);
        debugLog(`Current time: ${formatTimeId(now)}`);
        debugLog(`Is current minute: ${isCurrentMinute}`);

        // Jika ini adalah fetch pertama di detik 1
        if (state.isAutoFetching && !state.targetMinute) {
            state.targetMinute = now.getMinutes();
            debugLog(`Setting target minute: ${state.targetMinute}`);
        }

        // Update UI dan cache
        updateUI(result);
        priceCache.set(result);

        // Reset manual refresh flag jika berhasil
        state.isManualRefresh = false;

        // Jika data sudah sesuai dengan menit saat ini, berhenti retry
        if (state.isRetrying && isCurrentMinute) {
            debugLog('Data sudah sesuai dengan menit saat ini, berhenti retry');
            state.isRetrying = false;
            state.retryCount = 0;
            state.targetMinute = null;
            clearRetryTimeout();
        }

        // Jika dalam mode auto-fetch dan data belum sesuai
        if (state.isAutoFetching && !isCurrentMinute) {
            if (!state.targetMinute) {
                state.targetMinute = now.getMinutes();
            }
            state.isRetrying = true;
            scheduleRetry('stale-data');
        }

    } catch (err) {

        if (err.name === 'AbortError') {
            if (!isTimedOut) {
                debugLog('Fetch dibatalkan oleh request baru');
                return;
            }

            if (dom.lastUpdate) {
                dom.lastUpdate.textContent = `Timeout (${FETCH_TIMEOUT_MS / 1000}s)`;
            }
            debugLog('Fetch timeout');

            if (!state.isManualRefresh) {
                scheduleRetry('timeout');
            } else {
                setTimeout(() => {
                    const cached = priceCache.get();
                    if (cached && dom.lastUpdate) {
                        dom.lastUpdate.textContent = formatTimeIdHms(new Date(cached.updated));
                    }
                    state.isManualRefresh = false;
                }, 2000);
            }
            return;
        }

        console.error('Fetch error:', err);

        if (dom.lastUpdate) {
            dom.lastUpdate.textContent = 'Fetch error';
        }

        if (!state.isManualRefresh) {
            scheduleRetry('error');
        } else {
            state.isManualRefresh = false;
        }
    } finally {
        clearTimeout(timeoutId);
        if (state.fetchController === controller) {
            state.fetchController = null;
        }
        if (state.fetchSeq === fetchSeq) {
            state.isFetching = false;
        }
    }
}

/* ================= UPDATE UI ================= */
function updateUI(data) {
    if (!dom.hargaBeli) return;

    const buy = Number(data.buy);
    const sell = Number(data.sell);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) return;
    const previousBuy = state.lastRenderedBuy;
    const previousSell = state.lastRenderedSell;
    state.currentBuy = buy;
    state.currentSell = sell;
    addPriceHistoryEntry(data);

    const priceChanged = previousBuy !== buy || previousSell !== sell;

    if (priceChanged) {
        // Update harga
        renderPriceValue(dom.hargaBeli, buy, previousBuy);
        renderPriceValue(dom.hargaJual, sell, previousSell);

        // Compute dan render derived values
        const values = computeDerivedValues(buy, sell);
        renderDerivedValues(values);

        state.lastRenderedBuy = buy;
        state.lastRenderedSell = sell;
    }

    renderPriceChangeIndicator(dom.hargaBeliChange, buy, previousBuy);
    renderPriceChangeIndicator(dom.hargaJualChange, sell, previousSell);

    // Timestamp
    if (dom.lastUpdate) {
        const updated = new Date(data.updated);
        dom.lastUpdate.textContent = formatTimeIdHms(updated);
    }

    // Reset countdown
    resetCountdown();

    // Update simulation
    if (state.simulation.mode) {
        updateSimulation();
    }
}

/* ================= SIMULATION ================= */
function buildSimulationTemplate(mode) {
    const isBuy = mode === 'buy';
    const gradientFrom = isBuy ? 'green' : 'red';
    const gradientTo = isBuy ? 'emerald' : 'rose';
    const colorClass = isBuy ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
    const baseLabel = isBuy ? 'Gram Beli (60jt)' : 'Gram Jual (58.005jt)';

    return `
        <div class="simulation-result-row grid grid-cols-2 gap-2">
            <div class="simulation-result-tile bg-gradient-to-br from-${gradientFrom}-50 to-${gradientTo}-50 dark:from-${gradientFrom}-900/20 dark:to-${gradientTo}-900/20 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">${baseLabel}</p>
                <p data-slot="markedGram" class="text-base font-bold ${colorClass} font-numeric">-</p>
            </div>
            <div class="simulation-result-tile bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Gram Sekarang</p>
                <p data-slot="currentGram" class="text-base font-bold text-gray-900 dark:text-gray-100 font-numeric">-</p>
            </div>
        </div>
        <div class="simulation-result-row grid grid-cols-2 gap-2">
            <div class="simulation-result-tile simulation-result-tone-neutral p-2.5 rounded-lg" data-metric="gramDiff">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Selisih Gram</p>
                <p data-slot="gramDiff" class="text-base font-bold font-numeric">-</p>
            </div>
            <div class="simulation-result-tile simulation-result-tone-neutral p-2.5 rounded-lg" data-metric="profitLoss">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Profit / Loss</p>
                <p data-slot="profitLoss" class="text-lg font-bold font-numeric">-</p>
            </div>
        </div>`;
}

function ensureSimulationNode(mode) {
    if (!dom.simulationResults) return null;

    let node = state.simulationNodes[mode];
    const id = mode === 'buy' ? 'buySimulation' : 'sellSimulation';
    if (!node || !node.isConnected) {
        node = document.getElementById(id);
    }

    if (!node) {
        node = document.createElement('div');
        node.id = id;
        node.className = 'space-y-3 animate-fade-in';
        node.innerHTML = buildSimulationTemplate(mode);
        dom.simulationResults.appendChild(node);
    }

    state.simulationNodes[mode] = node;
    return node;
}

function getSimulationSlotRefs(mode, node) {
    const cached = state.simulationSlots[mode];
    if (cached && cached.root === node && cached.root.isConnected) {
        return cached;
    }

    const slots = {
        root: node,
        markedGramEl: node.querySelector('[data-slot="markedGram"]'),
        currentGramEl: node.querySelector('[data-slot="currentGram"]'),
        gramDiffEl: node.querySelector('[data-slot="gramDiff"]'),
        profitLossEl: node.querySelector('[data-slot="profitLoss"]'),
        gramDiffTile: node.querySelector('[data-metric="gramDiff"]'),
        profitLossTile: node.querySelector('[data-metric="profitLoss"]')
    };
    state.simulationSlots[mode] = slots;
    return slots;
}

function setSimulationMetricTone(tile, valueEl, value, successThreshold) {
    const isNegative = value < 0;
    const isSuccess = value > successThreshold;
    const tone = isNegative ? 'negative' : (isSuccess ? 'success' : 'neutral');

    if (tile) {
        tile.classList.remove(
            'simulation-result-tone-negative',
            'simulation-result-tone-neutral',
            'simulation-result-tone-success'
        );
        tile.classList.add(`simulation-result-tone-${tone}`);
    }

    setProfitColorClass(valueEl, !isNegative);
}

function updateSimulationCardValues(mode, node, markedGram, currentGram, gramDiff, profitLoss) {
    if (!node) return;

    const slots = getSimulationSlotRefs(mode, node);
    const markedGramEl = slots.markedGramEl;
    const currentGramEl = slots.currentGramEl;
    const gramDiffEl = slots.gramDiffEl;
    const profitLossEl = slots.profitLossEl;

    if (markedGramEl) markedGramEl.textContent = `${markedGram.toFixed(4)} g`;
    if (currentGramEl) currentGramEl.textContent = `${currentGram.toFixed(4)} g`;
    if (gramDiffEl) gramDiffEl.textContent = `${gramDiff >= 0 ? '+' : ''}${gramDiff.toFixed(4)} g`;
    if (profitLossEl) profitLossEl.textContent = formatRupiah(profitLoss);

    setSimulationMetricTone(
        slots.gramDiffTile,
        gramDiffEl,
        gramDiff,
        SIMULATION_GRAM_SUCCESS_THRESHOLD
    );
    setSimulationMetricTone(
        slots.profitLossTile,
        profitLossEl,
        profitLoss,
        SIMULATION_PROFIT_SUCCESS_THRESHOLD
    );
}

function setManualGramError(message = '') {
    if (!dom.manualGramError) return;
    if (message) {
        dom.manualGramError.textContent = message;
        dom.manualGramError.classList.remove('hidden');
        return;
    }
    dom.manualGramError.classList.add('hidden');
}

function updateManualPricePreview() {
    clearTimeout(state.previewTimeout);
    state.previewTimeout = setTimeout(() => {
        if (!dom.manualBuyPricePreview || !dom.manualSellPricePreview) return;

        const gram = parsePositiveFloat(dom.manualGramInput?.value || '');
        if (!gram) {
            dom.manualBuyPricePreview.textContent = '-';
            dom.manualSellPricePreview.textContent = '-';
            return;
        }

        const buyPrice = SIMULATION_BUY_BASE / gram;
        const sellPrice = SIMULATION_SELL_BASE / gram;
        dom.manualBuyPricePreview.textContent = formatRupiah(buyPrice);
        dom.manualSellPricePreview.textContent = formatRupiah(sellPrice);
        setManualGramError('');
    }, 300); // Debounce 300ms
}

function applyManualGramSimulation(mode) {
    if (mode !== 'buy' && mode !== 'sell') return false;

    const gram = parsePositiveFloat(dom.manualGramInput?.value || '');
    if (!gram) {
        setManualGramError('Masukkan gram valid lebih dari 0');
        return false;
    }

    setManualGramError('');
    updateManualPricePreview();

    if (mode === 'buy') {
        state.simulation.buyPrice = SIMULATION_BUY_BASE / gram;
        state.simulation.sellPrice = null;
        state.simulation.mode = 'buy';
        dom.markBuyBtn?.classList.add('simulation-active');
        dom.markSellBtn?.classList.remove('simulation-active');
    } else {
        state.simulation.sellPrice = SIMULATION_SELL_BASE / gram;
        state.simulation.buyPrice = null;
        state.simulation.mode = 'sell';
        dom.markSellBtn?.classList.add('simulation-active');
        dom.markBuyBtn?.classList.remove('simulation-active');
    }

    state.simulation.gram = gram;
    saveSimulationToStorage();
    updateSimulation();
    return true;
}

function updateSimulation() {
    if (!dom.simulationResults) return;

    const buy = Number(state.currentBuy);
    const sell = Number(state.currentSell);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) return;

    const mode = state.simulation.mode;
    if (!mode) return;

    if (dom.noSimulation) dom.noSimulation.style.display = 'none';
    const clearBtn = dom.clearSimulationBtn;
    if (clearBtn) clearBtn.classList.remove('hidden');

    if (dom.saveTradeBtn) {
        dom.saveTradeBtn.classList.remove("hidden")
    }

    // Tampilkan tombol modal manual gram jika ada simulasi aktif
    if (dom.openManualGramModalBtn) {
        dom.openManualGramModalBtn.classList.remove('hidden');
    }

    const inactiveMode = mode === 'buy' ? 'sell' : 'buy';
    const inactiveNode = state.simulationNodes[inactiveMode] ||
        document.getElementById(inactiveMode === 'buy' ? 'buySimulation' : 'sellSimulation');
    if (inactiveNode) inactiveNode.remove();
    state.simulationNodes[inactiveMode] = null;
    state.simulationSlots[inactiveMode] = null;

    if (mode === 'buy' && state.simulation.buyPrice) {

        const markedGram = floor4(SIMULATION_BUY_BASE / state.simulation.buyPrice);
        state.simulation.gram = markedGram;
        const currentGram = floor4(SIMULATION_SELL_BASE / sell);
        const gramDiff = markedGram - currentGram;
        const profitLoss = gramDiff * sell;

        saveSimulationToStorage();
        const node = ensureSimulationNode('buy');
        updateSimulationCardValues('buy', node, markedGram, currentGram, gramDiff, profitLoss);

        if (dom.simulationStatus) {
            updateSimulationStatus('buy');
        }

    } else if (mode === 'sell' && state.simulation.sellPrice) {

        const markedGram = floor4(SIMULATION_SELL_BASE / state.simulation.sellPrice);
        state.simulation.gram = markedGram;
        const currentGram = floor4(SIMULATION_BUY_BASE / buy);
        const gramDiff = currentGram - markedGram;
        const profitLoss = gramDiff * sell;
        saveSimulationToStorage();
        const node = ensureSimulationNode('sell');
        updateSimulationCardValues('sell', node, markedGram, currentGram, gramDiff, profitLoss);

        if (dom.simulationStatus) {
            updateSimulationStatus('sell');
        }
    }
}

/* ================= FUNGSI BARU: SIMPAN SIMULASI KE STORAGE ================= */
function saveSimulationToStorage() {
    try {
        const now = Date.now();
        const key = getSimulationStorageKey();
        const isSamePayload = key === state.lastSimulationStorageKey;
        const isWithinThrottleWindow = (now - state.simulationStorageLastSavedAt) < SIMULATION_STORAGE_THROTTLE_MS;
        if (isSamePayload && isWithinThrottleWindow) {
            return;
        }

        const payload = JSON.stringify({
            simulation: state.simulation,
            timestamp: now
        });
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => {
                try { localStorage.setItem('gold_simulation', payload); } catch (e) { }
            });
        } else {
            localStorage.setItem('gold_simulation', payload);
        }
        state.lastSimulationStorageKey = key;
        state.simulationStorageLastSavedAt = now;
        debugLog('Simulasi disimpan ke localStorage');
    } catch (e) {
        console.error('Gagal menyimpan simulasi:', e);
    }
}

/* ================= FUNGSI BARU: LOAD SIMULASI DARI STORAGE ================= */
function loadSimulationFromStorage() {
    try {
        const saved = localStorage.getItem('gold_simulation');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Date.now() - parsed.timestamp < SIMULATION_TTL_MS) {
                state.simulation = parsed.simulation;
                state.lastSimulationStorageKey = getSimulationStorageKey();
                state.simulationStorageLastSavedAt = Number(parsed.timestamp) || Date.now();
                debugLog('Simulasi dimuat dari localStorage:', state.simulation);

                const timestampEl = dom.simulationTimestamp;
                if (timestampEl) {
                    const savedTime = new Date(parsed.timestamp);
                    timestampEl.textContent = `Update terakhir : ${formatTimeIdHms(savedTime)}`;
                }

                if (state.simulation.mode === 'buy' && state.simulation.buyPrice) {
                    dom.markBuyBtn?.classList.add('simulation-active');
                    dom.markSellBtn?.classList.remove('simulation-active');
                } else if (state.simulation.mode === 'sell' && state.simulation.sellPrice) {
                    dom.markSellBtn?.classList.add('simulation-active');
                    dom.markBuyBtn?.classList.remove('simulation-active');
                }

                setTimeout(() => {
                    const buy = Number(state.currentBuy);
                    const sell = Number(state.currentSell);
                    if (buy > 0 && sell > 0) {
                        updateSimulation();
                    }
                }, 500);

                return true;
            }
        }
    } catch (e) {
        console.error('Gagal memuat simulasi:', e);
    }
    return false;
}

/* ================= FUNGSI BARU: CLEAR SIMULATION ================= */
function clearSimulation() {
    state.simulation = {
        buyPrice: null,
        sellPrice: null,
        mode: null,
        gram: null
    };
    state.lastSimulationStorageKey = null;
    state.simulationStorageLastSavedAt = 0;

    localStorage.removeItem('gold_simulation');

    const oldSimulations = document.querySelectorAll('#buySimulation, #sellSimulation');
    oldSimulations.forEach(sim => sim.remove());
    state.simulationNodes.buy = null;
    state.simulationNodes.sell = null;
    state.simulationSlots.buy = null;
    state.simulationSlots.sell = null;

    if (dom.noSimulation) dom.noSimulation.style.display = 'block';
    if (dom.markBuyBtn) dom.markBuyBtn.classList.remove('simulation-active');
    if (dom.markSellBtn) dom.markSellBtn.classList.remove('simulation-active');

    // Sembunyikan tombol modal
    if (dom.openManualGramModalBtn) {
        dom.openManualGramModalBtn.classList.add('hidden');
    }

    const clearBtn = dom.clearSimulationBtn;
    if (clearBtn) clearBtn.classList.add('hidden');

    dom.saveTradeBtn?.classList.add("hidden")

    const timestampEl = dom.simulationTimestamp;
    if (timestampEl) {
        timestampEl.textContent = 'Update terakhir : -';
    }

    if (dom.simulationStatus) {
        dom.simulationStatus.innerHTML = `
            <p class="text-xs text-gray-500 dark:text-gray-400 text-ellipsis">
                Klik tombol untuk memulai simulasi
            </p>`;
    }
    simStatusSlots = null;

    debugLog('Simulasi dihapus');
}

/* ================= FUNGSI BARU: UPDATE STATUS SIMULASI ================= */
const SIM_STATUS_COLOR_CLASSES = ['text-green-500', 'text-red-500', 'text-green-600', 'dark:text-green-400', 'text-red-600', 'dark:text-red-400'];

function ensureSimStatusTemplate() {
    if (simStatusSlots && simStatusSlots.root && simStatusSlots.root.isConnected) {
        return simStatusSlots;
    }

    dom.simulationStatus.innerHTML = `
    <div class="simulation-status-summary text-left">
        <div class="simulation-status-mode flex items-center">
            <svg class="ui-icon w-4 h-4 animate-pulse mr-2 flex-shrink-0" data-slot="modeIcon"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d=""></path>
            </svg>
            <p class="text-base font-semibold" data-slot="modeText"></p>
        </div>
        <div class="simulation-status-value text-right">
            <p class="text-xxs text-gray-500 dark:text-gray-400" data-slot="priceLabel"></p>
            <p class="simulation-status-price font-bold font-numeric" data-slot="priceValue"></p>
        </div>
    </div>`;

    const root = dom.simulationStatus.firstElementChild;
    simStatusSlots = {
        root: root,
        modeIcon: root.querySelector('[data-slot="modeIcon"]'),
        modeIconPath: root.querySelector('[data-slot="modeIcon"] path'),
        modeText: root.querySelector('[data-slot="modeText"]'),
        priceLabel: root.querySelector('[data-slot="priceLabel"]'),
        priceValue: root.querySelector('[data-slot="priceValue"]')
    };
    return simStatusSlots;
}

function updateSimulationStatus(mode) {
    const slots = ensureSimStatusTemplate();
    if (!slots) return;

    const isBuy = mode === 'buy';
    const price = isBuy ? state.simulation.buyPrice : state.simulation.sellPrice;

    const timestampEl = dom.simulationTimestamp;
    if (timestampEl) {
        timestampEl.textContent = `Update terakhir : ${formatTimeIdHms(new Date())}`;
    }

    // Update icon color
    const icon = slots.modeIcon;
    icon.classList.remove(...SIM_STATUS_COLOR_CLASSES);
    icon.classList.add(isBuy ? 'text-green-500' : 'text-red-500');

    // Update icon path
    slots.modeIconPath.setAttribute('d', isBuy ? 'M7 17L17 7M8 7h9v9' : 'M7 7l10 10m0-9v9H8');

    // Update mode text
    const modeTextEl = slots.modeText;
    modeTextEl.textContent = isBuy ? 'Simulasi Beli' : 'Simulasi Jual';
    modeTextEl.classList.remove(...SIM_STATUS_COLOR_CLASSES);
    modeTextEl.classList.add(...(isBuy ? ['text-green-600', 'dark:text-green-400'] : ['text-red-600', 'dark:text-red-400']));

    // Update price label
    slots.priceLabel.textContent = isBuy ? 'Harga Beli' : 'Harga Jual';

    // Update price value
    const priceEl = slots.priceValue;
    priceEl.textContent = formatRupiah(price);
    priceEl.classList.remove(...SIM_STATUS_COLOR_CLASSES);
    priceEl.classList.add(...(isBuy ? ['text-green-600', 'dark:text-green-400'] : ['text-red-600', 'dark:text-red-400']));
}

/* ================= TIMERS ================= */
function resetCountdown() {
    state.countdown = COUNTDOWN_SECONDS;
    state.countdownExpiredTriggered = false;
    updateCountdownDisplay();
}

function startTimers() {
    if (state.timerTicker) {
        clearInterval(state.timerTicker);
    }
    updateCountdownDisplay();
    state.timerTicker = setInterval(tickTimers, 1000);
}

function tickTimers() {
    if (state.countdown > 0) {
        state.countdown--;
        updateCountdownDisplay();
    }

    if (state.countdown <= 0 && !state.countdownExpiredTriggered) {
        state.countdown = 0;
        state.countdownExpiredTriggered = true;
        updateCountdownDisplay();
        if (!state.isFetching) {
            fetchHarga();
        }
    }

    if (!state.isFetching && new Date().getSeconds() === 1) {
        debugLog('Auto-fetch detik 1');

        state.isAutoFetching = true;
        state.isRetrying = true;
        state.retryCount = 0;
        state.targetMinute = null;
        clearRetryTimeout();

        fetchHarga();
    }
}

async function saveTradingToDatabase() {
    if (!state.simulation.mode) {
        // Jika tidak ada simulasi, kasih efek error cepat
        showButtonFeedback(dom.saveTradeBtn, 'error', 800);
        return;
    }

    // Simpan referensi tombol
    const saveBtn = dom.saveTradeBtn;

    // Ubah tombol menjadi "Menyimpan..." dengan spinner
    showButtonFeedback(saveBtn, 'loading');

    const mode = state.simulation.mode;
    const gram = state.simulation.gram;
    const price = mode === "buy" ? state.simulation.buyPrice : state.simulation.sellPrice;
    const buy = state.currentBuy;
    const sell = state.currentSell;

    let currentGram, gramDiff, profitLoss;

    if (mode === "buy") {
        currentGram = SIMULATION_SELL_BASE / sell;
        gramDiff = gram - currentGram;
        profitLoss = gramDiff * sell;
    } else {
        currentGram = SIMULATION_BUY_BASE / buy;
        gramDiff = currentGram - gram;
        profitLoss = gramDiff * sell;
    }

    const payload = {
        mode: mode.toUpperCase(),
        waktu: new Date().toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta"
        }),
        harga: Math.round(price),
        harga_buy_realtime: Math.round(buy),
        harga_sell_realtime: Math.round(sell),
        gram: floor4(gram),
        selisih_gram: floor4(gramDiff),
        profit_loss: Math.round(profitLoss)
    };

    try {
        const response = await fetch("https://script.google.com/macros/s/AKfycbxfldyX2pupfiwgGekeMg_HrARNgWI802WXspZLQmSauxYHJ-VBUfSNTYNpw6lmduac4A/exec", {
            method: "POST",
            body: JSON.stringify(payload),
            mode: 'no-cors'
        });

        // SUKSES
        showButtonFeedback(saveBtn, 'success', 1500);

    } catch (err) {
        console.error("Gagal simpan", err);

        // GAGAL
        showButtonFeedback(saveBtn, 'error', 1500);
    }
}

/* ================= INITIAL SETUP ================= */
try {
    if (localStorage.getItem('darkMode') === 'true' ||
        (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
} catch (e) { }
