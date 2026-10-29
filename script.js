/* ================= NAMED CONSTANTS ================= */
const FETCH_TIMEOUT_MS = 7000;
const CACHE_LOCAL_TTL_MS = 30000;
const SIMULATION_TTL_MS = 86400000; // 24 jam
const SIMULATION_STORAGE_THROTTLE_MS = 5000;
const SIMULATION_BUY_BASE = 60000000;
const SIMULATION_SELL_BASE = 58006500;
const SIMULATION_GRAM_SUCCESS_THRESHOLD = 0.04;
const SIMULATION_PROFIT_SUCCESS_THRESHOLD = 100000;
const PRICE_HISTORY_LIMIT = 30;
const SIM_STATUS_COLOR_CLASSES = ['text-green-500', 'text-red-500', 'text-green-600', 'dark:text-green-400', 'text-red-600', 'dark:text-red-400'];
const MY_USD_IDR_WS_URL = '';
const MY_USD_IDR_API_URL = 'https://susdidr.vercel.app/api/index';
const USD_IDR_POLL_MS = 6 * 1000;
const DEBUG = false;

/* ================= TREASURY REALTIME CONFIG ================= */
const TREASURY_PUSHER_KEY = '52e99bd2c3c42e577e13';
const TREASURY_PUSHER_CLUSTER = 'ap1';
const TREASURY_PUSHER_CHANNEL = 'gold-rate';
const TREASURY_PUSHER_EVENT = 'gold-rate-event';
const TREASURY_API_V2_PRICE_URL = 'https://webv2-api.treasury.id/api/v1/external/wp/gold/price';

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

// Load from localStorage (Instant Hydration)
try {
    const saved = localStorage.getItem('gold_cache');
    if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.data) {
            priceCache.data = parsed.data;
            priceCache.timestamp = parsed.timestamp || 0;
        }
    }
} catch (e) { }

/* ================= GLOBAL STATE ================= */
let savedServerOffset = 0;
try {
    const saved = localStorage.getItem('server_time_offset');
    if (saved) savedServerOffset = Number(saved) || 0;
} catch (e) { }

let state = {
    timerTicker: null,
    fetchController: null,
    isAutoFetching: false,
    retryCount: 0,
    MAX_RETRY: 5,
    simulation: {
        buyPrice: null,
        sellPrice: null,
        mode: null,
        gram: null,
        profitHistory: []
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
    usdIdrFetchController: null,
    usdIdrEtag: null,
    usdIdrWs: null,
    usdIdrPingInterval: null,
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
    previewTimeout: null,
    serverTimeOffset: savedServerOffset,
    lastAutoFetchMinute: null,
    treasuryPusher: null,
    treasuryPusherChannel: null,
    lastUsdIdrTreasury: null,
    lastWsEventTime: null,
    lastClockSyncTime: 0,
    isClockSynced: false,
    bestClockSyncRtt: Infinity,
    lastDisplayedSecond: 0,
    lastWatchdogFetchTime: 0
};

/* ================= SERVER TIME SYNCHRONIZATION (LANGSUNG DARI KONEKSI SERVER TREASURY) ================= */
function getServerNow() {
    return new Date(Date.now() + (state.serverTimeOffset || 0));
}

function applyTreasuryServerTime(serverIsoStr, roundtripMs = 0, clientEndMs = Date.now()) {
    if (!serverIsoStr) return;
    const parsedDate = new Date(serverIsoStr);
    if (Number.isNaN(parsedDate.getTime())) return;

    const roundtrip = Math.max(0, roundtripMs || 0);
    // Abaikan sampel jika latensi terlalu tinggi (> 1000ms akibat cold TLS handshake) saat jam sudah pernah tersinkronisasi
    if (state.isClockSynced && roundtrip > 1000) return;

    // Waktu Server Sebenarnya saat response tiba = timestamp server (ms) + 1/2 RTT murni
    const actualServerMs = parsedDate.getTime() + Math.round(roundtrip / 2);
    const newOffset = actualServerMs - clientEndMs;
    const currentOffset = state.serverTimeOffset || 0;
    const drift = newOffset - currentOffset;

    if (!state.isClockSynced) {
        state.serverTimeOffset = newOffset;
        state.isClockSynced = true;
        state.bestClockSyncRtt = roundtrip;
        try {
            localStorage.setItem('server_time_offset', String(state.serverTimeOffset));
        } catch (e) { }
        if (state.timerTicker) {
            startTimers();
        } else {
            updateServerClock(getServerNow());
        }
        return;
    }

    // Jitter Deadband Filter:
    // Jika jam sudah sinkron dan selisih < 500ms, itu hanya fluktuasi kecil RTT jaringan.
    // Lakukan penghalusan (PLL smoothing) tanpa mereset fase timer agar detikan tidak pernah mengulang detik!
    if (Math.abs(drift) < 500) {
        if (roundtrip <= state.bestClockSyncRtt * 1.3) {
            state.bestClockSyncRtt = Math.min(state.bestClockSyncRtt, roundtrip);
            state.serverTimeOffset = Math.round(currentOffset + drift * 0.25);
            try {
                localStorage.setItem('server_time_offset', String(state.serverTimeOffset));
            } catch (e) { }
        }
        return;
    }

    // Jika selisih >= 500ms (misal setelah perangkat bangun dari sleep), perbarui offset dan selaraskan ulang timer
    state.serverTimeOffset = newOffset;
    state.bestClockSyncRtt = Math.min(state.bestClockSyncRtt, roundtrip);
    try {
        localStorage.setItem('server_time_offset', String(state.serverTimeOffset));
    } catch (e) { }
    if (state.timerTicker) {
        startTimers();
    } else {
        updateServerClock(getServerNow());
    }
}

/**
 * Mengambil jam fisik real-time berpresisi milidetik langsung dari koneksi server Treasury (webv2-api.treasury.id)
 * melalui properti JSON meta.timestamp (bebas blokir CORS header Date dan tidak bergantung pada created_at maupun Vercel).
 * Jika sampel pertama terkena waktu tunggu Cold DNS/TLS (> 200ms), otomatis melakukan 1x probe kilat kedua
 * di koneksi Keep-Alive yang sudah hangat (~50ms RTT) untuk akurasi setingkat jam atom.
 */
async function syncServerClock(force = false) {
    if (!force && state.isClockSynced && state.lastClockSyncTime && (Date.now() - state.lastClockSyncTime < 60000)) {
        return;
    }

    const probeOnce = async () => {
        const t0 = Date.now();
        const res = await fetch(`https://webv2-api.treasury.id/?_t=${ t0 }`, {
            method: 'GET',
            cache: 'no-store',
            headers: { 'Accept': 'application/json' }
        });
        const json = await res.json();
        const t1 = Date.now();
        const ts = json?.errors?.[0]?.meta?.timestamp || json?.meta?.timestamp;
        return { ts, rtt: t1 - t0, endMs: t1 };
    };

    try {
        let best = await probeOnce();
        // Jika request pertama terkena overhead Cold DNS + TLS Handshake (> 200ms),
        // langsung ambil sampel ke-2 pada koneksi HTTP/2 Keep-Alive yang sudah hangat (~50ms RTT)
        // agar waktu handshake TLS tidak menggeser hitungan roundtrip / 2!
        if (best.rtt > 200) {
            try {
                const warmSample = await probeOnce();
                if (warmSample.ts && warmSample.rtt < best.rtt) {
                    best = warmSample;
                }
            } catch (e) { }
        }

        if (best && best.ts) {
            state.lastClockSyncTime = Date.now();
            applyTreasuryServerTime(best.ts, best.rtt, best.endMs);
            debugLog('Jam fisik server disinkronkan langsung dari koneksi Treasury:', best.ts, `RTT: ${best.rtt}ms`, `Offset: ${state.serverTimeOffset}ms`);
        }
    } catch (err) {
        debugLog('Gagal sinkronisasi jam server Treasury:', err);
    }
}

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
const formatTimeId = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta' }).format;
const formatTimeIdHms = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
}).format;
const formatTimeIdHm = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
}).format;
const formatUsdIdrRate = new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
}).format;

const wibDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

const serverDateFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long'
});

function getWibDateStr(date = null) {
    const target = date ? (date instanceof Date ? date : parseTreasuryDate(date)) : getServerNow();
    if (!target || Number.isNaN(target.getTime())) return '';
    return wibDateFormatter.format(target);
}

function formatMinuteOnly(val) {
    if (!val) return '-';

    if (typeof val === 'string') {
        const trimmed = val.trim();
        // Cek jika sudah berupa jam dan menit saja (contoh: "20.29" atau "20:29")
        if (/^\d{1,2}[:.]\d{2}$/.test(trimmed)) {
            return trimmed.replace(':', '.');
        }
        // Cek jika hanya string waktu jam.menit.detik (contoh: "20:29:01" atau "20.29.01")
        if (/^\d{1,2}[:.]\d{2}[:.]\d{2}$/.test(trimmed)) {
            const p = trimmed.split(/[:.]/);
            return `${p[0].padStart(2, '0')}.${p[1]}`;
        }
    }

    const d = val instanceof Date ? val : parseTreasuryDate(val);
    if (d && !Number.isNaN(d.getTime())) {
        return formatTimeIdHm(d).replace(':', '.');
    }

    return String(val);
}

// Cache DOM elements instantly on script execution (since script is deferred, DOM is ready)
const ids = [
    'buyPriceCard', 'sellPriceCard', 'hargaBeli', 'hargaJual', 'hargaBeliChange', 'hargaJualChange', 'spreadPersen',
    'gramBeli', 'gramJual', 'nilaiJual', 'cuan', 'lastUpdate',
    'simulationResults', 'noSimulation',
    'simulationStatus', 'markBuyBtn', 'markSellBtn',
    'themeText',
    'chartWidthBtn', 'chartWidthMenu', 'chartWidthSubmenuWrapper', 'settingsBtn', 'settingsMenu', 'dashboardGrid',
    'leftPanel', 'rightPanel', 'clearSimulationBtn', 'simulationTimestamp',
    'darkModeBtn', 'themeIconPath', 'fullscreenBtn', 'installPwaBtn', 'tvIframe', 'chartSkeleton',
    'serverClockHms', 'serverClockDate', 'serverClockOffset',
    'manualGramInput', 'manualGramError', 'applyManualBuyBtn', 'applyManualSellBtn',
    'manualBuyPricePreview', 'manualSellPricePreview',
    'openManualGramModalBtn', 'manualGramModal', 'manualGramModalBackdrop', 'closeManualGramModalBtn', 'manualGramModalContent',
    'usdIdrCard', 'usdIdrRate', 'usdIdrTime', 'usdIdrChange',
    'usdIdrHistoryDropdown', 'usdIdrHistoryList', 'usdIdrHistoryCount',
    'buyPriceHistoryDropdown', 'buyPriceHistoryList', 'buyPriceHistoryCount',
    'sellPriceHistoryDropdown', 'sellPriceHistoryList', 'sellPriceHistoryCount',
    'backendStatusDot', 'backendVersionBadge', 'usdIdrTreasuryWs',
    'treasuryWsBadge', 'treasuryWsBadgeDot', 'treasuryWsBadgeText'
];
ids.forEach(id => {
    dom[id] = document.getElementById(id);
});


// Render cached data immediately
loadPriceHistory();
renderPriceHistoryDropdown('buy');
renderPriceHistoryDropdown('sell');
attachPriceHistoryClickDelegation(dom.buyPriceHistoryList, 'buy');
attachPriceHistoryClickDelegation(dom.sellPriceHistoryList, 'sell');
renderCachedData();
loadSimulationFromStorage();
// Tampilkan jam server langsung di frame pertama
updateServerClock(getServerNow());
renderCachedUsdIdr();
connectUsdIdrFeed();

// Render cached USD/IDR Treasury (WebSocket)
try {
    const savedUsdWs = localStorage.getItem('treasury_usdidr_ws');
    if (savedUsdWs && dom.usdIdrTreasuryWs) {
        dom.usdIdrTreasuryWs.textContent = formatRupiah(Number(savedUsdWs));
    }
} catch (e) { }

function debugLog(...args) {
    if (DEBUG) console.log(...args);
}

function floor4(num) {
    if (!Number.isFinite(num)) return 0;
    return Math.floor((Number(num) + 1e-9) * 10000) / 10000;
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

/**
 * Normalisasi dan parse string tanggal Treasury (misal: "2026-09-05 12:40:02")
 * Menghasilkan Date object valid dengan zona waktu WIB (UTC+7) yang aman untuk Safari/iOS & lintas zona waktu.
 * Mengembalikan null jika input tidak valid / korup agar tidak mengaburkan data.
 */
function parseTreasuryDate(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return Number.isNaN(dateStr.getTime()) ? null : dateStr;
    if (typeof dateStr === 'number') {
        const d = new Date(dateStr);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const cleanStr = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(cleanStr)) {
        const d = new Date(cleanStr.replace(' ', 'T') + '+07:00');
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(cleanStr)) {
        const d = new Date(cleanStr + '+07:00');
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(cleanStr);
    return Number.isNaN(d.getTime()) ? null : d;
}

function isSameMinuteBucket(a, b) {
    if (!a || !b) return false;
    const dateA = a instanceof Date ? a : parseTreasuryDate(a);
    const dateB = b instanceof Date ? b : parseTreasuryDate(b);
    if (!dateA || !dateB) return false;
    const timeA = dateA.getTime();
    const timeB = dateB.getTime();
    if (Number.isNaN(timeA) || Number.isNaN(timeB)) return false;
    return Math.floor(timeA / 60000) === Math.floor(timeB / 60000);
}

function clearRetryTimeout() {
    if (state.retryTimeoutId) {
        clearTimeout(state.retryTimeoutId);
        state.retryTimeoutId = null;
    }
}

function getSimulationStorageKey() {
    const sim = state.simulation || {};
    const historyLen = Array.isArray(sim.profitHistory) ? sim.profitHistory.length : 0;
    return [
        sim.mode || '',
        sim.buyPrice || '',
        sim.sellPrice || '',
        sim.gram !== null && sim.gram !== undefined ? Number(sim.gram).toFixed(6) : '',
        Boolean(sim.isManual),
        sim.time || '',
        sim.startTime || '',
        historyLen
    ].join('|');
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

    requestAnimationFrame(() => {
        el.classList.add(rollClass);
        card?.classList.add(cardClass);
    });
}

function getPreviousPriceForIndicator(type, currentPrice) {
    const history = state.priceHistory || [];
    const valueKey = type === 'buy' ? 'buy' : 'sell';
    if (!history.length) return null;

    const lastIdx = history.length - 1;
    const lastVal = Number(history[lastIdx][valueKey]);

    // Jika entri terakhir di riwayat adalah harga saat ini dan ada entri sebelumnya di riwayat
    if (lastVal === currentPrice) {
        if (lastIdx > 0) {
            const prevVal = Number(history[lastIdx - 1][valueKey]);
            return Number.isFinite(prevVal) ? prevVal : null;
        }
        return null;
    }

    // Jika entri terakhir di riwayat adalah harga sebelumnya
    return Number.isFinite(lastVal) ? lastVal : null;
}
const getPreviousDistinctPrice = getPreviousPriceForIndicator;

function renderPriceChangeIndicator(el, current, previous) {
    if (!el) return;

    el.classList.remove('price-change-up', 'price-change-down', 'price-change-neutral');

    if (!Number.isFinite(previous) || !Number.isFinite(current)) {
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
    const today = getWibDateStr();
    return today ? `treasury_price_history_${today}` : 'treasury_price_history';
}

function dedupePriceHistory(history) {
    if (!Array.isArray(history)) return [];

    const todayStr = getWibDateStr();
    const seenMinutes = new Map();

    for (const item of history) {
        const buy = Number(item.buy);
        const sell = Number(item.sell);
        const rawTimeStr = item.updated;
        if (!Number.isFinite(buy) || !Number.isFinite(sell) || !rawTimeStr) continue;

        const dateObj = parseTreasuryDate(rawTimeStr);
        if (!dateObj || Number.isNaN(dateObj.getTime())) continue;

        // Hanya sertakan riwayat untuk hari ini (WIB) agar tidak tercampur dengan hari kemarin
        if (todayStr && getWibDateStr(dateObj) !== todayStr) {
            continue;
        }

        // Key keunikan per menit (1 menit = 60.000 ms) agar ada riwayat lengkap setiap menitnya
        const minuteKey = Math.floor(dateObj.getTime() / 60000);
        const existing = seenMinutes.get(minuteKey);
        const existingDate = existing ? parseTreasuryDate(existing.updated) : null;
        if (!existing || !existingDate || dateObj.getTime() >= existingDate.getTime()) {
            seenMinutes.set(minuteKey, {
                buy,
                sell,
                updated: dateObj.toISOString()
            });
        }
    }

    const result = Array.from(seenMinutes.values());
    result.sort((a, b) => {
        const tA = parseTreasuryDate(a.updated)?.getTime() || 0;
        const tB = parseTreasuryDate(b.updated)?.getTime() || 0;
        return tA - tB;
    });
    return result.slice(-PRICE_HISTORY_LIMIT);
}

function loadPriceHistory() {
    try {
        const todayKey = getPriceHistoryStorageKey();
        let saved = localStorage.getItem(todayKey);

        if (!saved) {
            const legacy = localStorage.getItem('treasury_price_history');
            if (legacy) {
                const parsedLegacy = JSON.parse(legacy);
                if (Array.isArray(parsedLegacy)) {
                    state.priceHistory = dedupePriceHistory(parsedLegacy);
                    savePriceHistory();
                    return;
                }
            }
            return;
        }

        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return;

        state.priceHistory = dedupePriceHistory(parsed);
        savePriceHistory();
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

    const dateParsed = parseTreasuryDate(data.updated);
    if (!dateParsed || Number.isNaN(dateParsed.getTime())) return;

    const currentHistory = state.priceHistory || [];
    const newMinuteKey = Math.floor(dateParsed.getTime() / 60000);

    // Cek apakah sudah ada entri di menit yang sama dengan harga yang sama
    if (currentHistory.length > 0) {
        const lastEntry = currentHistory[currentHistory.length - 1];
        const lastDate = parseTreasuryDate(lastEntry.updated);
        const lastMinuteKey = lastDate ? Math.floor(lastDate.getTime() / 60000) : -1;

        if (lastMinuteKey === newMinuteKey && Number(lastEntry.buy) === buy && Number(lastEntry.sell) === sell) {
            // Sudah ada entri untuk menit ini dan harganya sama, tidak perlu menduplikasi
            return;
        }
    }

    const newHistory = dedupePriceHistory([...currentHistory, {
        buy,
        sell,
        updated: dateParsed.toISOString()
    }]);

    state.priceHistory = newHistory.slice(-PRICE_HISTORY_LIMIT);
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

function renderPriceHistoryDropdown(type, forceRender = false) {
    const { card, dropdown, list, count } = getPriceHistoryElements(type);
    if (!list) return;

    const history = state.priceHistory || [];
    if (count) count.textContent = String(history.length);

    // LAZY RENDER OPTIMIZATION: Tunda pembuatan HTML jika dropdown sedang tertutup
    if (!forceRender && dropdown && dropdown.classList.contains('hidden')) {
        return;
    }

    if (!history.length) {
        list.innerHTML = '<p class="price-history-empty">Menunggu data</p>';
        return;
    }

    const savedScrollTop = list.scrollTop;
    const valueKey = type === 'buy' ? 'buy' : 'sell';
    list.innerHTML = history
        .slice()
        .reverse()
        .map((item, index, reversed) => {
            const value = Number(item[valueKey]);
            const nextOlder = reversed[index + 1];
            const prevValue = nextOlder ? Number(nextOlder[valueKey]) : null;
            const change = prevValue !== null ? value - prevValue : 0;
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
            const updated = parseTreasuryDate(item.updated);
            const time = (!updated || Number.isNaN(updated.getTime())) ? '-' : formatMinuteOnly(updated);
            const formattedDiff = formatRupiah(Math.abs(change));

            return `
            <div class="price-history-item price-history-item--clickable" data-price="${value}" data-type="${type}" data-time="${item.updated}" role="button" tabindex="0" title="Klik untuk simulasi ${type === 'buy' ? 'beli' : 'jual'} Rp ${value.toLocaleString('id-ID')}">
                <span class="price-history-time font-numeric">${time}</span>
                <span class="price-history-price font-numeric">${formatRupiah(value)}</span>
                <span class="usd-idr-history-pill ${directionClass} font-numeric">
                    <svg class="usd-idr-history-pill-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="${arrowPath}"></path>
                    </svg>
                    <span>${formattedDiff}</span>
                </span>
            </div>
        `;
        })
        .join('');

    if (savedScrollTop > 0) {
        list.scrollTop = savedScrollTop;
    }
}

/**
 * Sinkronisasi total riwayat profit simulasi secara deterministik dari state.priceHistory.
 * Memastikan setiap pergerakan harga di riwayat memiliki entri profit yang sinkron tanpa gap waktu.
 */
function syncSimulationProfitHistory() {
    if (!state.simulation) return;
    const mode = state.simulation.mode;
    if (!mode) return;

    const isBuy = mode === 'buy';
    const price = isBuy ? Number(state.simulation.buyPrice) : Number(state.simulation.sellPrice);
    if (!Number.isFinite(price) || price <= 0) return;

    const historyList = state.priceHistory || [];
    const profitHistoryEntries = [];

    let startIndex = -1;
    const startTime = state.simulation.startTime;
    if (startTime) {
        startIndex = historyList.findIndex(item => item.updated === startTime);
        if (startIndex === -1) {
            const targetMs = parseTreasuryDate(startTime)?.getTime() ?? NaN;
            if (!Number.isNaN(targetMs)) {
                startIndex = historyList.findIndex(item => (parseTreasuryDate(item.updated)?.getTime() ?? -1) >= targetMs);
            }
        }
    }

    if (startIndex === -1) {
        startIndex = historyList.findIndex(item => Number(item[mode]) === price);
    }
    if (startIndex === -1) {
        startIndex = 0;
    }

    const relevantPriceSlice = historyList.slice(startIndex);

    for (const hItem of relevantPriceSlice) {
        const hBuy = Number(hItem.buy);
        const hSell = Number(hItem.sell);
        const hDate = parseTreasuryDate(hItem.updated);
        const hTimeMs = hDate ? hDate.getTime() : NaN;

        if (!Number.isFinite(hBuy) || !Number.isFinite(hSell) || Number.isNaN(hTimeMs)) continue;

        let profitLoss = 0;
        let gramDiff = 0;

        if (isBuy) {
            const markedGram = (state.simulation.isManual && Number.isFinite(Number(state.simulation.gram)) && Number(state.simulation.gram) > 0)
                ? Number(state.simulation.gram)
                : floor4(SIMULATION_BUY_BASE / price);
            const currentGram = floor4(SIMULATION_SELL_BASE / hSell);
            gramDiff = floor4(markedGram - currentGram);
            const nilaiJual = markedGram * hSell;
            profitLoss = Math.round(nilaiJual - SIMULATION_SELL_BASE);
        } else {
            const markedGram = (state.simulation.isManual && Number.isFinite(Number(state.simulation.gram)) && Number(state.simulation.gram) > 0)
                ? Number(state.simulation.gram)
                : floor4(SIMULATION_SELL_BASE / price);
            const currentGram = floor4(SIMULATION_BUY_BASE / hBuy);
            gramDiff = floor4(currentGram - markedGram);
            profitLoss = Math.round(gramDiff * hSell);
        }

        profitHistoryEntries.push({
            profitLoss: profitLoss,
            gramDiff: gramDiff,
            time: formatMinuteOnly(hDate),
            timestamp: hTimeMs
        });
    }

    // Pastikan jika ada harga live sekarang yang belum masuk riwayat, kita sertakan
    const liveBuy = Number(state.currentBuy);
    const liveSell = Number(state.currentSell);
    if (Number.isFinite(liveBuy) && Number.isFinite(liveSell) && liveBuy > 0 && liveSell > 0) {
        let liveProfitLoss = 0;
        let liveGramDiff = 0;
        if (isBuy) {
            const markedGram = (state.simulation.isManual && Number.isFinite(Number(state.simulation.gram)) && Number(state.simulation.gram) > 0)
                ? Number(state.simulation.gram)
                : floor4(SIMULATION_BUY_BASE / price);
            const currentGram = floor4(SIMULATION_SELL_BASE / liveSell);
            liveGramDiff = floor4(markedGram - currentGram);
            const nilaiJual = markedGram * liveSell;
            liveProfitLoss = Math.round(nilaiJual - SIMULATION_SELL_BASE);
        } else {
            const markedGram = (state.simulation.isManual && Number.isFinite(Number(state.simulation.gram)) && Number(state.simulation.gram) > 0)
                ? Number(state.simulation.gram)
                : floor4(SIMULATION_SELL_BASE / price);
            const currentGram = floor4(SIMULATION_BUY_BASE / liveBuy);
            liveGramDiff = floor4(currentGram - markedGram);
            liveProfitLoss = Math.round(liveGramDiff * liveSell);
        }

        const serverNow = getServerNow();
        profitHistoryEntries.push({
            profitLoss: liveProfitLoss,
            gramDiff: liveGramDiff,
            time: formatMinuteOnly(serverNow),
            timestamp: serverNow.getTime()
        });
    }

    state.simulation.profitHistory = dedupeProfitHistory(profitHistoryEntries);
    saveSimulationToStorage();
    renderProfitHistoryDropdown(mode);
}

/**
 * Trigger simulasi langsung dari klik row harga di dropdown dengan kalkulasi retroaktif.
 * @param {'buy'|'sell'} type
 * @param {number} price
 * @param {string} [updatedTime]
 */
function simulateFromHistory(type, price, updatedTime) {
    if (!price || price <= 0) return;

    toggleProfitHistoryDropdown('buy', false);
    toggleProfitHistoryDropdown('sell', false);

    const isBuy = type === 'buy';
    const mode = isBuy ? 'buy' : 'sell';

    state.simulation.buyPrice = isBuy ? price : null;
    state.simulation.sellPrice = !isBuy ? price : null;
    state.simulation.mode = mode;
    state.simulation.isManual = false;
    state.simulation.startTime = updatedTime || null;
    state.simulation.time = updatedTime ? formatMinuteOnly(updatedTime) : formatMinuteOnly(getServerNow());

    if (isBuy) {
        state.simulation.gram = SIMULATION_BUY_BASE / price;
        dom.markBuyBtn?.classList.add('simulation-active');
        dom.markSellBtn?.classList.remove('simulation-active');
    } else {
        state.simulation.gram = SIMULATION_SELL_BASE / price;
        dom.markSellBtn?.classList.add('simulation-active');
        dom.markBuyBtn?.classList.remove('simulation-active');
    }

    syncSimulationProfitHistory();
    updateSimulation(true);
    togglePriceHistoryDropdown(type, false);
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
        const time = row.dataset.time;
        simulateFromHistory(rowType, price, time);
    });
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.price-history-item--clickable');
        if (!row) return;
        e.preventDefault();
        const price = Number(row.dataset.price);
        const rowType = row.dataset.type || type;
        const time = row.dataset.time;
        simulateFromHistory(rowType, price, time);
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
        renderPriceHistoryDropdown(type, true);
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

// formatUsdIdrRate di-cache sebagai singleton di bagian FAST HELPER FUNCTIONS

function parseTimestampToDate(val) {
    if (!val) return null;
    if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
    if (typeof val === 'number') {
        const d = new Date(val);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof val === 'string') {
        let trimmed = val.trim();
        // Cek format YYYY-MM-DD HH:mm:ss
        if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
            trimmed = trimmed.replace(' ', 'T') + '+07:00';
        }
        const d = new Date(trimmed);
        if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
}

function formatUsdIdrDisplayTime(time, rawTimestamp) {
    const dateObj = parseTimestampToDate(rawTimestamp) || parseTimestampToDate(time);

    if (!dateObj) {
        return {
            display: time || 'Live',
            fullTitle: `Status: ${time || 'Live'}`
        };
    }

    const now = typeof getServerNow === 'function' ? getServerNow() : new Date();

    const isToday = dateObj.getFullYear() === now.getFullYear() &&
        dateObj.getMonth() === now.getMonth() &&
        dateObj.getDate() === now.getDate();

    let displayStr = '';
    if (isToday) {
        displayStr = formatTimeIdHms(dateObj).replace(/\./g, ':');
    } else {
        const day = String(dateObj.getDate()).padStart(2, '0');
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const hm = formatTimeIdHm(dateObj).replace(/\./g, ':');
        displayStr = `${day}/${month} ${hm}`;
    }

    const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

    const dayName = dayNames[dateObj.getDay()];
    const dateNum = dateObj.getDate();
    const monthName = monthNames[dateObj.getMonth()];
    const yearNum = dateObj.getFullYear();
    const timeStr = formatTimeIdHms(dateObj);

    const fullTitle = `Terakhir diupdate: ${dayName}, ${dateNum} ${monthName} ${yearNum} ${timeStr} WIB (Google Finance)`;

    return {
        display: displayStr,
        fullTitle
    };
}

function renderUsdIdrRate(price, time, comparisonPrice, rawTimestamp) {
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

    const { display, fullTitle } = formatUsdIdrDisplayTime(time, rawTimestamp);
    setUsdIdrStatus(display, fullTitle);

    try {
        localStorage.setItem('usd_idr_cache', JSON.stringify({
            price,
            time,
            rawTimestamp,
            displayTime: display,
            fullTitle,
            savedAt: Date.now()
        }));
    } catch (e) { }
}

function setUsdIdrStatus(text, fullTitle = '') {
    if (!dom.usdIdrTime) return;
    dom.usdIdrTime.textContent = text;
    if (fullTitle) {
        dom.usdIdrTime.title = fullTitle;
        if (dom.usdIdrCard) dom.usdIdrCard.title = fullTitle;
    }
}

function setBackendConnectionStatus(isOnline, message = '') {
    if (!dom.backendStatusDot) return;
    if (isOnline) {
        dom.backendStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-green-500 inline-block ml-1 shadow-sm';
        dom.backendStatusDot.title = message || 'Backend Vercel: Online';
    } else {
        dom.backendStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-red-500 inline-block ml-1 shadow-sm animate-pulse';
        dom.backendStatusDot.title = message || 'Backend Vercel: Offline (Fallback Aktif)';
    }
}

function updateBackendVersionDisplay(version, commitSha) {
    if (!version) return;
    if (dom.backendVersionBadge) {
        dom.backendVersionBadge.textContent = 'API ' + version;
        dom.backendVersionBadge.style.display = 'inline-block';
        dom.backendVersionBadge.title = `Backend Vercel: ${version}${commitSha ? ' (' + commitSha + ')' : ''}`;
    }
    setBackendConnectionStatus(true, `Backend Vercel: Online (${version}${commitSha ? ' - ' + commitSha : ''})`);
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

function dedupeUsdIdrHistory(items) {
    if (!Array.isArray(items) || !items.length) return [];

    const todayStr = getWibDateStr();
    const sorted = items
        .map(item => ({
            price: item?.price,
            time: item?.time,
            market_time: item?.market_time || item?.time,
            updated_at: item?.updated_at,
            timestamp: item?.timestamp,
            value: item?.value || parseUsdIdrPrice(item?.price)
        }))
        .filter(item => item.value && item.time);

    if (!sorted.length) return [];

    sorted.sort((a, b) => {
        const dateA = parseTimestampToDate(a.timestamp || a.updated_at);
        const dateB = parseTimestampToDate(b.timestamp || b.updated_at);
        const timeA = dateA ? dateA.getTime() : 0;
        const timeB = dateB ? dateB.getTime() : 0;
        if (timeA && timeB && timeA !== timeB) return timeA - timeB;
        return String(a.time).localeCompare(String(b.time));
    });

    // Filter hanya untuk hari ini (WIB) jika ada data hari ini, agar riwayat kemarin tidak menumpuk
    let dayFiltered = sorted;
    if (todayStr) {
        const todayItems = sorted.filter(item => {
            const d = parseTimestampToDate(item.timestamp || item.updated_at);
            return !d || getWibDateStr(d) === todayStr;
        });
        if (todayItems.length > 0) {
            dayFiltered = todayItems;
        } else {
            dayFiltered = sorted.slice(-1);
        }
    }

    // Deduplikasi entri berurutan dengan harga (value) yang sama persis
    // agar cold-start serverless tidak memicu baris perubahan 0,0000 palsu
    const deduped = [];
    for (const item of dayFiltered) {
        if (!deduped.length) {
            deduped.push({ ...item });
            continue;
        }
        const prev = deduped[deduped.length - 1];
        if (Math.abs(prev.value - item.value) < 1e-6) {
            // Harga tidak berubah: pertahankan waktu pencatatan awal perubahan, perbarui metadata market_time terbaru
            if (item.market_time) prev.market_time = item.market_time;
            if (item.timestamp) prev.timestamp = item.timestamp;
            if (item.updated_at) prev.updated_at = item.updated_at;
        } else if (prev.time === item.time) {
            // Waktu sama persis namun nilai terupdate: gunakan entri terbaru
            deduped[deduped.length - 1] = { ...item };
        } else {
            deduped.push({ ...item });
        }
    }

    return deduped.slice(-20);
}

function renderUsdIdrHistory(history, currentRateInfo = null) {
    if (!Array.isArray(history) || !history.length) return;

    const combined = [...(state.usdIdrHistory || []), ...history];
    const mergedHistory = dedupeUsdIdrHistory(combined);
    if (!mergedHistory.length) return;

    state.usdIdrHistory = mergedHistory;
    renderUsdIdrHistoryDropdown();

    try {
        localStorage.setItem('usd_idr_history_cache', JSON.stringify(mergedHistory));
    } catch (e) { }

    const latest = mergedHistory[mergedHistory.length - 1];
    if (!latest) return;

    const comparisonPrice = findUsdIdrComparisonPrice(mergedHistory, latest.value);
    const displayTime = (currentRateInfo && currentRateInfo.time) || latest.market_time || latest.time;
    const rawTs = (currentRateInfo && (currentRateInfo.timestamp || currentRateInfo.updated_at)) || latest.timestamp || latest.updated_at;
    renderUsdIdrRate(latest.price, displayTime, comparisonPrice, rawTs);
}

function renderUsdIdrHistoryDropdown(forceRender = false) {
    if (!dom.usdIdrHistoryList) return;

    const history = state.usdIdrHistory || [];
    if (dom.usdIdrHistoryCount) dom.usdIdrHistoryCount.textContent = String(history.length);

    // LAZY RENDER OPTIMIZATION: Tunda pembuatan HTML jika dropdown sedang tertutup
    if (!forceRender && dom.usdIdrHistoryDropdown && dom.usdIdrHistoryDropdown.classList.contains('hidden')) {
        return;
    }

    if (!history.length) {
        dom.usdIdrHistoryList.innerHTML = '<p class="usd-idr-history-empty">Menunggu data</p>';
        return;
    }

    const savedScrollTop = dom.usdIdrHistoryList.scrollTop;
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

            const itemTitle = item.market_time && item.market_time !== item.time
                ? `Waktu Server: ${item.time} WIB | Waktu Google Finance: ${item.market_time} WIB`
                : `Waktu: ${item.time} WIB`;

            return `
            <div class="usd-idr-history-item" title="${itemTitle}">
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

    if (savedScrollTop > 0) {
        dom.usdIdrHistoryList.scrollTop = savedScrollTop;
    }
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
        renderUsdIdrHistoryDropdown(true);
    }
}

function renderCachedUsdIdr() {
    try {
        const saved = localStorage.getItem('usd_idr_cache');
        if (!saved) return;
        const cached = JSON.parse(saved);
        if (!cached || !cached.price) return;

        // Pulihkan riwayat kurs dari cache jika ada (bersihkan duplikasi waktu lama & harga berulang)
        const savedHistory = localStorage.getItem('usd_idr_history_cache');
        if (savedHistory) {
            try {
                const parsedHistory = JSON.parse(savedHistory);
                if (Array.isArray(parsedHistory) && parsedHistory.length) {
                    state.usdIdrHistory = dedupeUsdIdrHistory(parsedHistory);
                    renderUsdIdrHistoryDropdown();
                }
            } catch (err) { }
        }

        renderUsdIdrRate(cached.price, cached.time, undefined, cached.rawTimestamp);
        renderCachedUsdIdrChange();
        if (cached.displayTime) {
            setUsdIdrStatus(cached.displayTime, cached.fullTitle || '');
        }
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
    if (state.usdIdrFetchController) {
        state.usdIdrFetchController.abort();
        state.usdIdrFetchController = null;
    }
    if (state.usdIdrPingInterval) {
        clearInterval(state.usdIdrPingInterval);
        state.usdIdrPingInterval = null;
    }
    if (state.usdIdrWs) {
        state.usdIdrWs.onclose = null;
        state.usdIdrWs.onerror = null;
        state.usdIdrWs.close();
        state.usdIdrWs = null;
    }
}

/* ================= WEBSOCKET HANDLERS (VERSI MANDIRI) ================= */
function setupUsdIdrWsHandlers(ws) {
    const startPing = () => {
        if (!state.usdIdrLastPrice) setUsdIdrStatus('Live');

        if (state.usdIdrPingInterval) clearInterval(state.usdIdrPingInterval);
        state.usdIdrPingInterval = setInterval(() => {
            if (state.usdIdrWs && state.usdIdrWs.readyState === WebSocket.OPEN) {
                try { state.usdIdrWs.send('ping'); } catch (e) { }
            }
        }, 25000);
    };

    ws.onopen = () => {
        debugLog('Terhubung ke Server WebSocket USD/IDR Sendiri!');
        startPing();
    };

    ws.onmessage = async (event) => {
        try {
            if (typeof event.data === 'string') {
                if (event.data === 'pong') return;
                const payload = JSON.parse(event.data);

                // Tangani data riwayat dan pembaruan harga realtime
                if (payload.usd_idr_history && Array.isArray(payload.usd_idr_history)) {
                    renderUsdIdrHistory(payload.usd_idr_history);
                } else if (payload.history && Array.isArray(payload.history)) {
                    renderUsdIdrHistory(payload.history);
                } else if (payload.price) {
                    renderUsdIdrRate(payload.price, payload.time);
                }
            }
        } catch (e) {
            debugLog('Error parsing WS message:', e);
        }
    };

    ws.onerror = (err) => {
        debugLog('WebSocket Error:', err);
        if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    ws.onclose = () => {
        if (state.usdIdrPingInterval) {
            clearInterval(state.usdIdrPingInterval);
            state.usdIdrPingInterval = null;
        }
        if (state.usdIdrWs === ws) state.usdIdrWs = null;
        setUsdIdrUnavailableStatus(state.usdIdrLastPrice ? 'Reconnecting...' : 'Menghubungkan...');

        // Coba hubungkan ulang setelah 5 detik
        state.usdIdrPollTimeoutId = setTimeout(connectUsdIdrFeed, 5000);
    };
}

/* ================= MERGE & BACKFILL GOLD HISTORY ================= */
function mergeGoldHistory(incomingHistory) {
    if (!Array.isArray(incomingHistory) || !incomingHistory.length) return;

    const currentHistory = state.priceHistory || [];
    const formattedIncoming = incomingHistory.map(item => {
        let updated = item.updated_at || item.updated;
        if (!updated && item.time) {
            const timeStr = String(item.time).trim();
            if (timeStr.includes(':')) {
                const todayStr = getWibDateStr();
                updated = `${todayStr} ${timeStr}`;
            } else {
                updated = timeStr;
            }
        }
        return {
            buy: Number(item.buy),
            sell: Number(item.sell),
            updated: updated
        };
    }).filter(item => item.buy > 0 && item.sell > 0 && item.updated && parseTreasuryDate(item.updated));

    const merged = dedupePriceHistory([...currentHistory, ...formattedIncoming]);
    const isDifferent = merged.length !== currentHistory.length ||
        (merged.length > 0 && currentHistory.length > 0 && (
            merged[merged.length - 1].updated !== currentHistory[currentHistory.length - 1].updated ||
            merged[merged.length - 1].buy !== currentHistory[currentHistory.length - 1].buy
        ));

    if (isDifferent) {
        state.priceHistory = merged.slice(-PRICE_HISTORY_LIMIT);
        savePriceHistory();
        renderPriceHistoryDropdown('buy');
        renderPriceHistoryDropdown('sell');

        // Jika ada simulasi aktif, sinkronkan ulang seluruh riwayat profit simulasi secara otomatis
        if (state.simulation && state.simulation.mode) {
            syncSimulationProfitHistory();
        }
    }
}

/* ================= KONEKSI KE FEED USD/IDR ================= */
async function connectUsdIdrFeed() {
    if (!dom.usdIdrRate) return;
    if (document.hidden || navigator.onLine === false) {
        scheduleUsdIdrPoll();
        return;
    }

    closeUsdIdrFeed();

    // 1. Coba koneksi langsung ke WebSocket Server Sendiri jika URL tersedia
    if (MY_USD_IDR_WS_URL) {
        try {
            debugLog('Menghubungkan ke WebSocket USD/IDR:', MY_USD_IDR_WS_URL);
            const ws = new WebSocket(MY_USD_IDR_WS_URL);
            state.usdIdrWs = ws;
            setupUsdIdrWsHandlers(ws);
            return;
        } catch (e) {
            debugLog('Gagal inisialisasi WebSocket:', e);
        }
    }

    // 2. Fallback / Mode Utama: Gunakan REST API Vercel (Khusus USD/IDR & Sinkronisasi Waktu Server)
    const controller = new AbortController();
    state.usdIdrFetchController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
        debugLog('Mengambil data USD/IDR dari REST API...');
        const reqStart = Date.now();
        const headers = { 'Accept': 'application/json' };
        if (state.usdIdrEtag) {
            headers['If-None-Match'] = state.usdIdrEtag;
        }

        const res = await fetch(MY_USD_IDR_API_URL, {
            signal: controller.signal,
            headers
        });

        const newEtag = res.headers.get('ETag');
        if (newEtag) {
            state.usdIdrEtag = newEtag;
        }

        if (res.status === 304) {
            debugLog('USD/IDR data 304 Not Modified (cached via ETag)');
            setBackendConnectionStatus(true, 'Backend Vercel: Online (304 Cached)');
            scheduleUsdIdrPoll();
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data && data.version) {
            updateBackendVersionDisplay(data.version, data.commit_sha);
        }

        // Update USD/IDR & Riwayat USD/IDR (tanpa menyentuh state harga emas WebSocket Treasury)
        const rateObj = data.usd_idr || data;
        const hasHistory = (data.usd_idr_history && Array.isArray(data.usd_idr_history) && data.usd_idr_history.length)
            || (data.history && Array.isArray(data.history) && data.history.length);

        if (data.usd_idr_history && Array.isArray(data.usd_idr_history)) {
            renderUsdIdrHistory(data.usd_idr_history, rateObj);
        } else if (data.history && Array.isArray(data.history)) {
            renderUsdIdrHistory(data.history, rateObj);
        }

        // Hanya panggil renderUsdIdrRate langsung jika belum dirender via renderUsdIdrHistory (hindari double call reset warna)
        if (!hasHistory && rateObj && rateObj.price) {
            renderUsdIdrRate(rateObj.price, rateObj.time, undefined, rateObj.timestamp || rateObj.updated_at);
        }

        setBackendConnectionStatus(true, 'Backend Vercel: Online');
        scheduleUsdIdrPoll();
    } catch (e) {
        if (e.name === 'AbortError') return;
        debugLog('REST API fetch error:', e);
        setBackendConnectionStatus(false, 'Backend Vercel: Gangguan / Offline');
        setUsdIdrUnavailableStatus(state.usdIdrLastPrice ? 'Gagal, coba lagi...' : 'Tidak tersedia');
        state.usdIdrPollTimeoutId = setTimeout(connectUsdIdrFeed, USD_IDR_POLL_MS);
    } finally {
        clearTimeout(timeoutId);
        if (state.usdIdrFetchController === controller) {
            state.usdIdrFetchController = null;
        }
    }
}

/* ================= TREASURY PUSHER WEBSOCKET (REALTIME LIVE ENGINE) ================= */
function renderUsdIdrTreasuryWs(rate) {
    if (!dom.usdIdrTreasuryWs) return;
    const num = Number(rate);
    if (!Number.isFinite(num) || num <= 0) return;

    const prev = state.lastUsdIdrTreasury;
    state.lastUsdIdrTreasury = num;
    dom.usdIdrTreasuryWs.textContent = formatRupiah(num);

    if (prev && prev !== num) {
        dom.usdIdrTreasuryWs.classList.remove('price-flash-green', 'price-flash-red');
        void dom.usdIdrTreasuryWs.offsetWidth;
        dom.usdIdrTreasuryWs.classList.add(num > prev ? 'price-flash-green' : 'price-flash-red');
    }

    try {
        localStorage.setItem('treasury_usdidr_ws', String(num));
    } catch (e) { }
}

function updateTreasuryWsStatus(status) {
    if (!dom.treasuryWsBadge || !dom.treasuryWsBadgeText) return;

    dom.treasuryWsBadge.classList.remove('ws-live', 'ws-connecting', 'ws-fallback');

    if (status === 'connected') {
        dom.treasuryWsBadge.classList.add('ws-live');
        dom.treasuryWsBadgeText.textContent = 'Live WS';
        dom.treasuryWsBadge.title = 'Koneksi Pusher WebSocket Real-Time Terhubung (0-delay push)';
    } else if (status === 'connecting') {
        dom.treasuryWsBadge.classList.add('ws-connecting');
        dom.treasuryWsBadgeText.textContent = 'Menghubungkan...';
        dom.treasuryWsBadge.title = 'Sedang menyambungkan ke Pusher WebSocket Treasury...';
    } else {
        dom.treasuryWsBadge.classList.add('ws-fallback');
        dom.treasuryWsBadgeText.textContent = 'Fallback REST';
        dom.treasuryWsBadge.title = 'WebSocket tidak aktif — Watchdog polling REST aktif';
    }
}

function initTreasuryPusher() {
    if (typeof Pusher === 'undefined') {
        debugLog('Pusher library belum siap di window, mencoba muat dinamis...');
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/pusher-js@8.3.0/dist/web/pusher.min.js';
        s.onload = () => initTreasuryPusher();
        document.head.appendChild(s);
        return;
    }

    if (state.treasuryPusher) {
        if (state.treasuryPusher.connection && state.treasuryPusher.connection.state !== 'connected') {
            state.treasuryPusher.connect();
        }
        return;
    }

    try {
        debugLog('Menghubungkan ke Pusher WebSocket Treasury...');
        const pusher = new Pusher(TREASURY_PUSHER_KEY, {
            cluster: TREASURY_PUSHER_CLUSTER,
            forceTLS: true
        });

        const channel = pusher.subscribe(TREASURY_PUSHER_CHANNEL);

        channel.bind(TREASURY_PUSHER_EVENT, function (data) {
            debugLog('Pusher Treasury live update diterima:', data);
            handleTreasuryPusherEvent(data);
        });

        pusher.connection.bind('state_change', function (states) {
            debugLog('Status koneksi Pusher Treasury:', states.current);
            updateTreasuryWsStatus(states.current);
            if (states.current === 'connected') {
                syncServerClock();
            }
        });

        state.treasuryPusher = pusher;
        state.treasuryPusherChannel = channel;
        updateTreasuryWsStatus(pusher.connection.state);
    } catch (err) {
        debugLog('Gagal inisialisasi Pusher Treasury:', err);
        updateTreasuryWsStatus('failed');
    }
}

function handleTreasuryPusherEvent(raw) {
    try {
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!payload || !payload.buying_rate || !payload.selling_rate) return;

        const buy = Number(String(payload.buying_rate).replace(/\./g, ''));
        const sell = Number(String(payload.selling_rate).replace(/\./g, ''));
        if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) return;

        const updated = payload.created_at || new Date().toISOString();
        const result = {
            buy,
            sell,
            updated
        };

        // 1. Update UI dan Cache seketika tanpa jeda
        updateUI(result);
        priceCache.set(result);
        state.lastWsEventTime = Date.now();
        state.lastAutoFetchMinute = Math.floor(getServerNow().getTime() / 60000);

        // 3. Render Card Baru USD/IDR Treasury (dari WebSocket)
        if (payload.usdidr) {
            renderUsdIdrTreasuryWs(payload.usdidr);
        }



        state.isFetching = false;
        state.isAutoFetching = false;
        state.isRetrying = false;
        state.retryCount = 0;
        state.targetMinute = null;
        clearRetryTimeout();
    } catch (err) {
        debugLog('Error parsing payload Pusher Treasury:', err);
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
    if (dom.gramJual) dom.gramJual.textContent = `${gramJual.toFixed(4)} g`;
    if (dom.nilaiJual) dom.nilaiJual.textContent = formatRupiah(nilaiJual);

    if (dom.cuan) {
        dom.cuan.textContent = formatRupiah(cuan);
        setProfitColorClass(dom.cuan, cuan >= 0);
    }
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
    // Retry loop dinonaktifkan karena Pusher WebSocket menangani update live secara otomatis
    clearRetryTimeout();
    state.isAutoFetching = false;
    state.isRetrying = false;
    state.retryCount = 0;
    state.targetMinute = null;
}

/* ================= RENDER CACHED DATA INSTANTLY ================= */
function renderCachedData() {
    let cached = priceCache.data || priceCache.get();

    // Pastikan card menggunakan data teraktual: jika priceHistory memiliki data lebih baru dari gold_cache, prioritaskan priceHistory
    if (state.priceHistory && state.priceHistory.length > 0) {
        const latestHistory = state.priceHistory[state.priceHistory.length - 1];
        const historyTime = parseTreasuryDate(latestHistory.updated)?.getTime() ?? NaN;
        const cachedTime = cached ? (parseTreasuryDate(cached.updated)?.getTime() ?? 0) : 0;
        if (!cached || (!Number.isNaN(historyTime) && historyTime >= cachedTime)) {
            cached = {
                buy: latestHistory.buy,
                sell: latestHistory.sell,
                updated: latestHistory.updated
            };
            priceCache.data = cached;
        }
    }

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
    const displayPrevBuy = getPreviousPriceForIndicator('buy', buy);
    const displayPrevSell = getPreviousPriceForIndicator('sell', sell);
    renderPriceChangeIndicator(dom.hargaBeliChange, buy, displayPrevBuy);
    renderPriceChangeIndicator(dom.hargaJualChange, sell, displayPrevSell);

    // Update timestamp
    if (dom.lastUpdate) {
        const updated = parseTreasuryDate(cached.updated);
        dom.lastUpdate.textContent = updated ? formatTimeIdHms(updated) : '-';
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

const THEME_ICONS = {
    moon: 'M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z',
    sun: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z'
};

function updateThemeButtonText(isDark) {
    if (dom.themeIconPath) {
        dom.themeIconPath.setAttribute('d', isDark ? THEME_ICONS.sun : THEME_ICONS.moon);
    }
    if (dom.darkModeBtn) {
        dom.darkModeBtn.setAttribute('title', isDark ? 'Mode Terang (Light)' : 'Mode Gelap (Dark)');
        dom.darkModeBtn.setAttribute('aria-label', isDark ? 'Beralih ke mode terang' : 'Beralih ke mode gelap');
    }
    if (dom.themeText) {
        dom.themeText.textContent = isDark ? 'Light' : 'Dark';
    }
}

/* ================= TRADINGVIEW WIDGET OPTIMIZATION ================= */
let savedTvSrc = null;
let tvSuspendTimeoutId = null;

function syncTradingViewTheme(isDark) {
    const tvIframe = dom.tvIframe;
    if (!tvIframe) return;

    const nextTheme = isDark ? 'dark' : 'light';
    const templateSrc = tvIframe.dataset?.src;

    // Jika sedang dalam status suspend, update savedTvSrc agar saat restore tetap sesuai tema baru
    if (savedTvSrc) {
        savedTvSrc = savedTvSrc.replace(/theme=\w+/, `theme=${nextTheme}`);
    }

    // Jika chart belum pernah dimuat (masih lazy / belum scroll ke viewport di HP), jangan paksa download iframe
    const currentSrc = tvIframe.getAttribute('src');
    if (!currentSrc || currentSrc === 'about:blank') {
        return;
    }

    let nextSrc = '';
    if (templateSrc) {
        nextSrc = templateSrc.replace('{theme}', nextTheme);
    } else if (tvIframe.src) {
        nextSrc = tvIframe.src.replace(/theme=\w+/, `theme=${nextTheme}`);
    }

    if (nextSrc && tvIframe.src !== nextSrc) {
        // Transisi halus: fade out sedikit agar tidak ada flicker/flashbang putih yang menyilaukan
        tvIframe.style.opacity = '0.35';
        const onLoaded = () => {
            tvIframe.style.opacity = '1';
            tvIframe.removeEventListener('load', onLoaded);
        };
        tvIframe.addEventListener('load', onLoaded, { once: true });
        tvIframe.src = nextSrc;
    }
}

function initTradingViewLazy() {
    const tvIframe = dom.tvIframe;
    const chartContainer = document.querySelector('.chart-container');
    if (!tvIframe || !chartContainer) return;

    let hasLoaded = false;
    const loadChart = () => {
        if (hasLoaded) return;
        hasLoaded = true;

        const isDark = document.documentElement.classList.contains('dark');
        const theme = isDark ? 'dark' : 'light';
        const templateSrc = tvIframe.dataset?.src;
        if (templateSrc) {
            tvIframe.src = templateSrc.replace('{theme}', theme);
        }

        const onChartLoaded = () => {
            tvIframe.classList.remove('opacity-0');
            tvIframe.classList.add('opacity-100');
            tvIframe.style.opacity = '1';
            if (dom.chartSkeleton) {
                dom.chartSkeleton.classList.add('opacity-0');
            }
            setTimeout(fixTradingViewTouch, 300);
        };

        tvIframe.addEventListener('load', onChartLoaded, { once: true });
    };

    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    loadChart();
                    obs.unobserve(entry.target);
                }
            });
        }, {
            root: null,
            rootMargin: '200px 0px', // Pre-load 200px sebelum masuk viewport di mobile
            threshold: 0
        });

        observer.observe(chartContainer);
    } else {
        // Fallback browser lama
        loadChart();
    }
}

/* ================= INIT DOM ================= */
document.addEventListener('DOMContentLoaded', () => {
    debugLog('DOM Ready');

    // Load chart width preference
    const savedWidth = localStorage.getItem('chartWidth');
    if (savedWidth) {
        state.chartWidth = savedWidth;
        applyChartWidth(savedWidth);
    } else {
        updateActiveChartWidthUI(state.chartWidth || '1/4');
    }

    const initialIsDark = document.documentElement.classList.contains('dark');
    updateThemeButtonText(initialIsDark);

    // Inisialisasi TradingView secara pintar & lazy (Intersection Observer 200px)
    if (document.readyState === 'complete') {
        initTradingViewLazy();
    } else {
        window.addEventListener('load', initTradingViewLazy);
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

    // Keyboard accessibility untuk modal manual gram (ESC to close)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.manualGramModal && !dom.manualGramModal.classList.contains('hidden')) {
            closeManualGramModal();
        }
    });

    if (dom.manualGramInput) {
        dom.manualGramInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const activeMode = state.simulation.mode || 'buy';
                if (applyManualGramSimulation(activeMode)) {
                    closeManualGramModal();
                }
            }
        });
    }

    if (dom.markBuyBtn) {
        dom.markBuyBtn.addEventListener('click', () => {
            const price = Number.isFinite(state.currentBuy) && state.currentBuy > 0
                ? state.currentBuy
                : fastParse(dom.hargaBeli.textContent);
            if (price > 0) {
                resetSimulationProfitHistory();
                const currentPriceObj = priceCache.get();
                const timeStr = currentPriceObj?.updated
                    ? formatMinuteOnly(currentPriceObj.updated)
                    : formatMinuteOnly(getServerNow());
                state.simulation.buyPrice = price;
                state.simulation.sellPrice = null;
                state.simulation.mode = 'buy';
                state.simulation.time = timeStr;
                state.simulation.startTime = currentPriceObj?.updated || new Date().toISOString();
                state.simulation.isManual = false;
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
                resetSimulationProfitHistory();
                const currentPriceObj = priceCache.get();
                const timeStr = currentPriceObj?.updated
                    ? formatMinuteOnly(currentPriceObj.updated)
                    : formatMinuteOnly(getServerNow());
                state.simulation.sellPrice = price;
                state.simulation.buyPrice = null;
                state.simulation.mode = 'sell';
                state.simulation.time = timeStr;
                state.simulation.startTime = currentPriceObj?.updated || new Date().toISOString();
                state.simulation.isManual = false;
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
            if (e.target.closest('#chartWidthBtn') || e.target.closest('#chartWidthMenu')) {
                return;
            }
            if (e.target.closest('.settings-menu-item')) {
                setTimeout(() => {
                    dom.settingsMenu?.classList.add('hidden');
                    dom.chartWidthMenu?.classList.add('hidden');
                }, 0);
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

    // Chart width controls (Flyout Submenu inside Settings)
    let chartWidthSubmenuTimer = null;
    const submenuWrapper = dom.chartWidthSubmenuWrapper || document.getElementById('chartWidthSubmenuWrapper');

    if (submenuWrapper) {
        submenuWrapper.addEventListener('mouseenter', () => {
            if (chartWidthSubmenuTimer) {
                clearTimeout(chartWidthSubmenuTimer);
                chartWidthSubmenuTimer = null;
            }
            dom.chartWidthMenu?.classList.remove('hidden');
        });

        submenuWrapper.addEventListener('mouseleave', () => {
            chartWidthSubmenuTimer = setTimeout(() => {
                dom.chartWidthMenu?.classList.add('hidden');
            }, 200);
        });
    }

    if (dom.chartWidthBtn) {
        dom.chartWidthBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (chartWidthSubmenuTimer) {
                clearTimeout(chartWidthSubmenuTimer);
                chartWidthSubmenuTimer = null;
            }
            dom.chartWidthMenu?.classList.toggle('hidden');
        });
    }

    if (dom.chartWidthMenu) {
        dom.chartWidthMenu.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        const widthButtons = dom.chartWidthMenu.querySelectorAll('button[data-width]');
        widthButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const width = btn.getAttribute('data-width');
                applyChartWidth(width);
                dom.chartWidthMenu?.classList.add('hidden');
                dom.settingsMenu?.classList.add('hidden');
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
        toggleProfitHistoryDropdown('buy', false);
        toggleProfitHistoryDropdown('sell', false);
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

    dom.fullscreenBtn?.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    });

    dom.installPwaBtn?.addEventListener('click', async () => {
        console.log('Install PWA button clicked. deferredPrompt:', deferredPrompt);
        if (!deferredPrompt) {
            console.warn('Install PWA clicked but deferredPrompt is null or unavailable.');
            alert('Aplikasi tidak dapat diinstal secara langsung dari tombol ini. Pastikan Anda membuka situs menggunakan HTTPS atau localhost, menggunakan browser yang didukung (Chrome/Edge/Opera), dan tidak berada di tab Private/Incognito. Jika sudah memenuhi syarat, Anda juga bisa menginstal langsung dari menu browser (titik tiga -> Instal Aplikasi).');
            return;
        }
        try {
            dom.installPwaBtn.disabled = true;
            console.log('Calling deferredPrompt.prompt()...');
            await deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`PWA install prompt completed. User choice outcome: ${outcome}`);
            deferredPrompt = null;
            dom.installPwaBtn.classList.add('hidden');
        } catch (error) {
            console.error('Error during PWA installation prompt:', error);
            alert('Gagal membuka menu instalasi: ' + error.message);
        } finally {
            dom.installPwaBtn.disabled = false;
        }
    });



    // Start timers
    startTimers();

    // Segera sinkronkan jam fisik server langsung dari koneksi server Treasury (webv2-api.treasury.id)
    syncServerClock(true);

    // Start Pusher WebSocket for instant Treasury Gold push
    initTreasuryPusher();

    // Cold-Start Guard: Jika belum ada cache harga emas atau cache sudah lebih tua dari 55 detik,
    // ambil snapshot awal via REST agar pengguna tidak perlu menunggu hingga 59 detik untuk event menit Pusher berikutnya
    if (!priceCache.data || (Date.now() - priceCache.timestamp > 55000)) {
        fetchHarga();
    }

    // Pause/resume timer dan TradingView suspend saat tab hidden/visible
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (state.timerTicker) {
                clearTimeout(state.timerTicker);
                clearInterval(state.timerTicker);
                state.timerTicker = null;
            }
            closeUsdIdrFeed();

            // Suspend TradingView WebGL/WebSocket jika tablet tidur/terkunci > 30 detik (hemat baterai & RAM)
            if (dom.tvIframe && dom.tvIframe.src && dom.tvIframe.src !== 'about:blank') {
                tvSuspendTimeoutId = setTimeout(() => {
                    if (document.hidden && dom.tvIframe) {
                        savedTvSrc = dom.tvIframe.src;
                        dom.tvIframe.src = 'about:blank';
                        debugLog('TradingView suspended (hemat baterai & RAM tablet/HP)');
                    }
                }, 30000);
            }
        } else {
            if (tvSuspendTimeoutId) {
                clearTimeout(tvSuspendTimeoutId);
                tvSuspendTimeoutId = null;
            }

            // Pulihkan TradingView jika sebelumnya di-suspend saat layar mati > 30 detik
            if (dom.tvIframe && savedTvSrc && dom.tvIframe.src.includes('about:blank')) {
                dom.tvIframe.style.opacity = '0.35';
                const onRestoreLoad = () => {
                    dom.tvIframe.style.opacity = '1';
                    dom.tvIframe.removeEventListener('load', onRestoreLoad);
                };
                dom.tvIframe.addEventListener('load', onRestoreLoad, { once: true });
                dom.tvIframe.src = savedTvSrc;
                savedTvSrc = null;
                debugLog('TradingView restored dengan memori bersih');
            }

            if (!state.timerTicker) {
                startTimers();
            }
            syncServerClock();
            if (state.treasuryPusher && state.treasuryPusher.connection && state.treasuryPusher.connection.state !== 'connected') {
                state.treasuryPusher.connect();
            } else {
                initTreasuryPusher();
            }
            connectUsdIdrFeed();

            // Refresh harga emas jika tab dibuka kembali DAN WebSocket sedang tidak terhubung
            const isWsActive = state.treasuryPusher?.connection?.state === 'connected';
            if (!isWsActive && (!state.lastFetchTime || (Date.now() - state.lastFetchTime > 30000))) {
                debugLog('Tab kembali aktif & WS belum live, menyegarkan data harga via REST...');
                fetchHarga();
            }
        }
    });

    window.addEventListener('offline', () => {
        closeUsdIdrFeed();
        setUsdIdrUnavailableStatus('Offline');
    });

    window.addEventListener('online', () => {
        state.usdIdrReconnectAttempt = 0;
        syncServerClock(true);
        if (state.treasuryPusher && state.treasuryPusher.connection && state.treasuryPusher.connection.state !== 'connected') {
            state.treasuryPusher.connect();
        } else {
            initTreasuryPusher();
        }
        connectUsdIdrFeed();

        // Hanya fetch REST jika Pusher belum terhubung setelah 1.5 detik
        setTimeout(() => {
            if (state.treasuryPusher?.connection?.state !== 'connected') {
                state.isAutoFetching = true;
                clearRetryTimeout();
                fetchHarga();
            }
        }, 1500);
    });



    // PERBAIKAN: Panggil fungsi touch handler setelah iframe siap
    setTimeout(fixTradingViewTouch, 500);
});

/* ================= CHART WIDTH MANAGEMENT ================= */
function updateActiveChartWidthUI(activeWidth) {
    if (!dom.chartWidthMenu) return;
    const widthButtons = dom.chartWidthMenu.querySelectorAll('button[data-width]');
    widthButtons.forEach(btn => {
        const w = btn.getAttribute('data-width');
        const isCurrent = (w === activeWidth);
        btn.classList.toggle('bg-blue-50', isCurrent);
        btn.classList.toggle('dark:bg-blue-900/30', isCurrent);
        btn.classList.toggle('text-blue-600', isCurrent);
        btn.classList.toggle('dark:text-blue-400', isCurrent);
        btn.classList.toggle('font-medium', isCurrent);

        let checkIcon = btn.querySelector('.chart-width-check');
        if (isCurrent && !checkIcon) {
            btn.insertAdjacentHTML('beforeend', '<svg class="chart-width-check ui-icon w-3.5 h-3.5 text-blue-500 dark:text-blue-400 flex-shrink-0 ml-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>');
        } else if (!isCurrent && checkIcon) {
            checkIcon.remove();
        }
    });
}

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

    updateActiveChartWidthUI(width);
}

/* ================= HYPER-FAST FETCH (TREASURY WEBV2 API & FALLBACK) ================= */
async function fetchHarga(force = false) {
    debugLog('Fetching data harga emas terbaru...');

    const fetchSeq = ++state.fetchSeq;
    state.isFetching = true;
    state.lastFetchTime = Date.now();



    // Cancel previous fetch
    if (state.fetchController) {
        state.fetchController.abort();
    }

    const controller = new AbortController();
    state.fetchController = controller;

    const timeoutId = setTimeout(() => {
        controller.abort();
    }, FETCH_TIMEOUT_MS);

    try {
        const start = Date.now();
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const fmt = (d) => `${wibDateFormatter.format(d)} ${formatTimeIdHms(d).replace(/\./g, ':')}`;

        // Mengambil data harga emas langsung dari API Resmi WebV2 Treasury
        const res = await fetch(TREASURY_API_V2_PRICE_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*'
            },
            body: JSON.stringify({
                start_date: fmt(yesterday),
                end_date: fmt(now),
                type: 'daily',
                region: 'id',
                assetType: 'gold'
            }),
            cache: 'no-store'
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const json = await res.json();
        const prices = json?.data?.attributes?.prices;
        if (!prices || !prices.length) {
            throw new Error('Invalid Treasury API response');
        }

        const latestPrice = prices[prices.length - 1];
        let updatedStr = '';
        if (latestPrice.datetime && latestPrice.datetime.includes(' - ')) {
            const parts = latestPrice.datetime.split(' - ');
            const dateParts = parts[0].split('/');
            const fullYear = dateParts[2].length === 2 ? `20${dateParts[2]}` : dateParts[2];
            updatedStr = `${fullYear}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')} ${parts[1].trim()}:00`;
        } else {
            updatedStr = fmt(now);
        }

        const result = {
            buy: Number(latestPrice.buy_price),
            sell: Number(latestPrice.sell_price),
            updated: updatedStr
        };

        // Update UI dan simpan ke cache HANYA jika data tidak usang dibanding riwayat live saat ini
        if (state.priceHistory && state.priceHistory.length > 0) {
            const incomingTime = parseTreasuryDate(result.updated)?.getTime() ?? NaN;
            const latestHistoryTime = parseTreasuryDate(state.priceHistory[state.priceHistory.length - 1].updated)?.getTime() ?? NaN;
            if (!Number.isNaN(incomingTime) && !Number.isNaN(latestHistoryTime) && incomingTime < latestHistoryTime) {
                debugLog('fetchHarga: Data dari REST API lebih usang dari riwayat live, mengabaikan.');
                state.lastFetchTime = Date.now();
                return;
            }
        }

        const didUpdate = updateUI(result);
        if (didUpdate) {
            priceCache.set(result);
        }
        state.lastFetchTime = Date.now();

    } catch (err) {
        if (err.name === 'AbortError') {
            debugLog('Fetch harga dibatalkan / timeout');
        } else {
            console.error('Fetch harga error, mencoba fallback Tier 2 ke proxy Vercel:', err);
        }

        // Automatic Multi-Tier Fallback: Ambil data emas dari backend proxy Vercel (?include_gold=true)
        try {
            const fallbackRes = await fetch(`${MY_USD_IDR_API_URL}?include_gold=true`, {
                cache: 'no-store',
                headers: { 'Accept': 'application/json' }
            });
            if (fallbackRes.ok) {
                const fbJson = await fallbackRes.json();
                if (fbJson.gold_history && Array.isArray(fbJson.gold_history) && fbJson.gold_history.length > 0) {
                    mergeGoldHistory(fbJson.gold_history);
                }
                const fbGold = fbJson.gold || fbJson.treasury_gold;
                if (fbGold && fbGold.buy && fbGold.sell) {
                    const fallbackResult = {
                        buy: Number(fbGold.buy),
                        sell: Number(fbGold.sell),
                        updated: fbGold.updated_at || fbJson.server_time || fbJson.timestamp || new Date().toISOString()
                    };
                    const didUpdateFb = updateUI(fallbackResult);
                    if (didUpdateFb) {
                        priceCache.set(fallbackResult);
                    }
                    state.lastFetchTime = Date.now();
                    debugLog('Data harga emas sukses dipulihkan via Tier 2 Vercel proxy fallback!');
                }
            }
        } catch (fbErr) {
            debugLog('Tier 2 fallback proxy juga gagal:', fbErr);
        }
    } finally {
        clearTimeout(timeoutId);
        if (state.fetchController === controller) {
            state.fetchController = null;
        }
        if (state.fetchSeq === fetchSeq) {
            state.isFetching = false;
        }
        state.isAutoFetching = false;
        state.isRetrying = false;
        clearRetryTimeout();


    }
}

/* ================= UPDATE UI ================= */
function updateUI(data) {
    if (!dom.hargaBeli) return false;

    const buy = Number(data.buy);
    const sell = Number(data.sell);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) return false;

    // MONOTONIC TIMESTAMP GUARD: Jangan biarkan data usang me-rollback state atau merusak sinkronisasi pill!
    if (data.updated && state.priceHistory && state.priceHistory.length > 0) {
        const incomingTime = parseTreasuryDate(data.updated)?.getTime() ?? NaN;
        const latestHistoryTime = parseTreasuryDate(state.priceHistory[state.priceHistory.length - 1].updated)?.getTime() ?? NaN;
        if (!Number.isNaN(incomingTime) && !Number.isNaN(latestHistoryTime) && incomingTime < latestHistoryTime) {
            debugLog('updateUI: Mengabaikan data usang', data.updated, 'karena ada riwayat lebih baru:', state.priceHistory[state.priceHistory.length - 1].updated);
            return false;
        }
    }

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

    const displayPrevBuy = getPreviousPriceForIndicator('buy', buy);
    const displayPrevSell = getPreviousPriceForIndicator('sell', sell);
    renderPriceChangeIndicator(dom.hargaBeliChange, buy, displayPrevBuy);
    renderPriceChangeIndicator(dom.hargaJualChange, sell, displayPrevSell);

    // Timestamp
    if (dom.lastUpdate) {
        const updated = parseTreasuryDate(data.updated);
        dom.lastUpdate.textContent = updated ? formatTimeIdHms(updated) : '-';
    }

    // Update simulation
    if (state.simulation.mode) {
        updateSimulation();
    }

    return true;
}

/* ================= SIMULATION ================= */
function buildSimulationTemplate(mode) {
    const isBuy = mode === 'buy';
    const gradientFrom = isBuy ? 'green' : 'red';
    const gradientTo = isBuy ? 'emerald' : 'rose';
    const colorClass = isBuy ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
    const baseLabel = isBuy ? 'Gram Beli (60jt)' : 'Gram Jual (58.0065jt)';

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
            <div class="simulation-result-tile simulation-result-tone-neutral p-2.5 rounded-lg relative cursor-pointer group hover:opacity-95 transition-all duration-200" 
                 data-metric="profitLoss" 
                 role="button" 
                 tabindex="0" 
                 aria-expanded="false" 
                 title="Klik untuk melihat riwayat pergerakan Profit / Loss simulasi ini">
                <div class="flex items-end justify-between mb-1">
                    <p class="text-xxs text-gray-600 dark:text-gray-400 leading-tight">Profit / Loss</p>
                    <span data-slot="profitChangePill" class="price-change-indicator price-change-neutral font-numeric !static !m-0">-</span>
                </div>
                <p data-slot="profitLoss" class="text-lg font-bold font-numeric">-</p>

                <div data-slot="profitHistoryDropdown" class="price-history-dropdown profit-history-dropdown price-history-dropdown-right price-history-dropdown-up hidden">
                    <div class="price-history-heading">
                        <span class="font-semibold text-gray-800 dark:text-gray-200">Riwayat Profit / Loss</span>
                        <span data-slot="profitHistoryCount" class="text-xxs font-normal text-gray-500 dark:text-gray-400">0 data</span>
                    </div>
                    <div class="profit-history-subheader font-numeric">
                        <span>Menit</span>
                        <span class="text-right">Selisih Gram</span>
                        <span class="text-right">Profit / Loss</span>
                        <span class="text-right">Perubahan</span>
                    </div>
                    <div data-slot="profitHistoryList" class="price-history-list">
                        <p class="price-history-empty">Menunggu pergerakan harga...</p>
                    </div>
                </div>
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
        profitChangePill: node.querySelector('[data-slot="profitChangePill"]'),
        profitHistoryCount: node.querySelector('[data-slot="profitHistoryCount"]'),
        profitHistoryDropdown: node.querySelector('[data-slot="profitHistoryDropdown"]'),
        profitHistoryList: node.querySelector('[data-slot="profitHistoryList"]'),
        gramDiffTile: node.querySelector('[data-metric="gramDiff"]'),
        profitLossTile: node.querySelector('[data-metric="profitLoss"]')
    };

    if (slots.profitLossTile && !slots.profitLossTile._clickBound) {
        slots.profitLossTile._clickBound = true;
        slots.profitLossTile.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleProfitHistoryDropdown(mode);
        });
    }

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
    resetSimulationProfitHistory();

    const currentPriceObj = priceCache.get();
    const timeStr = currentPriceObj?.updated
        ? formatMinuteOnly(currentPriceObj.updated)
        : formatMinuteOnly(getServerNow());

    if (mode === 'buy') {
        state.simulation.buyPrice = SIMULATION_BUY_BASE / gram;
        state.simulation.sellPrice = null;
        state.simulation.mode = 'buy';
        state.simulation.time = timeStr;
        state.simulation.startTime = currentPriceObj?.updated || new Date().toISOString();
        dom.markBuyBtn?.classList.add('simulation-active');
        dom.markSellBtn?.classList.remove('simulation-active');
    } else {
        state.simulation.sellPrice = SIMULATION_SELL_BASE / gram;
        state.simulation.buyPrice = null;
        state.simulation.mode = 'sell';
        state.simulation.time = timeStr;
        state.simulation.startTime = currentPriceObj?.updated || new Date().toISOString();
        dom.markSellBtn?.classList.add('simulation-active');
        dom.markBuyBtn?.classList.remove('simulation-active');
    }

    state.simulation.gram = gram;
    state.simulation.isManual = true;
    saveSimulationToStorage();
    updateSimulation();
    return true;
}

function resetSimulationProfitHistory() {
    if (!state.simulation) return;
    state.simulation.profitHistory = [];
    toggleProfitHistoryDropdown('buy', false);
    toggleProfitHistoryDropdown('sell', false);

    ['buy', 'sell'].forEach(mode => {
        const node = state.simulationNodes[mode] || document.getElementById(mode === 'buy' ? 'buySimulation' : 'sellSimulation');
        if (node) {
            const slots = getSimulationSlotRefs(mode, node);
            if (slots.profitChangePill) {
                renderPriceChangeIndicator(slots.profitChangePill, null, null);
            }
            if (slots.profitHistoryCount) {
                slots.profitHistoryCount.textContent = '0 data';
            }
        }
    });

    saveSimulationToStorage();
}

function dedupeProfitHistory(history) {
    if (!Array.isArray(history)) return [];

    const seenMinutes = new Map();

    for (const item of history) {
        const profitLoss = Number(item.profitLoss);
        const gramDiff = Number(item.gramDiff);
        const timestamp = Number(item.timestamp) || 0;
        const dateObj = new Date(timestamp);

        if (!Number.isFinite(profitLoss) || Number.isNaN(dateObj.getTime()) || timestamp <= 0) continue;

        // Key keunikan per menit timestamp (1 menit = 60.000 ms)
        const minuteKey = Math.floor(dateObj.getTime() / 60000);

        seenMinutes.set(minuteKey, {
            profitLoss: Math.round(profitLoss),
            gramDiff: floor4(gramDiff),
            time: formatMinuteOnly(dateObj),
            timestamp: dateObj.getTime()
        });
    }

    const result = Array.from(seenMinutes.values());
    result.sort((a, b) => a.timestamp - b.timestamp);
    return result.slice(-30);
}

function addSimulationProfitHistoryEntry(mode, profitLoss, gramDiff) {
    if (!state.simulation) return;
    if (!Array.isArray(state.simulation.profitHistory)) {
        state.simulation.profitHistory = [];
    }

    const history = state.simulation.profitHistory;
    const serverNow = getServerNow();
    const now = serverNow.getTime();
    const timeStr = formatMinuteOnly(serverNow);

    const newHistory = dedupeProfitHistory([...history, {
        profitLoss: Math.round(profitLoss),
        gramDiff: floor4(gramDiff),
        time: timeStr,
        timestamp: now
    }]);

    const isSame = newHistory.length === history.length &&
        newHistory.length > 0 && history.length > 0 &&
        newHistory[newHistory.length - 1].timestamp === history[history.length - 1].timestamp &&
        newHistory[newHistory.length - 1].profitLoss === history[history.length - 1].profitLoss &&
        newHistory[newHistory.length - 1].gramDiff === history[history.length - 1].gramDiff;

    if (isSame) {
        renderProfitHistoryDropdown(mode);
        return;
    }

    state.simulation.profitHistory = newHistory;
    saveSimulationToStorage();
    renderProfitHistoryDropdown(mode);
}

function toggleProfitHistoryDropdown(mode, forceOpen) {
    const node = state.simulationNodes[mode] || document.getElementById(mode === 'buy' ? 'buySimulation' : 'sellSimulation');
    if (!node) return;

    const slots = getSimulationSlotRefs(mode, node);
    const dropdown = slots.profitHistoryDropdown;
    const tile = slots.profitLossTile;
    if (!dropdown || !tile) return;

    const isHidden = dropdown.classList.contains('hidden');
    const nextState = typeof forceOpen === 'boolean' ? forceOpen : isHidden;

    if (nextState) {
        dropdown.classList.remove('hidden');
        tile.setAttribute('aria-expanded', 'true');
        renderProfitHistoryDropdown(mode, true);
    } else {
        dropdown.classList.add('hidden');
        tile.setAttribute('aria-expanded', 'false');
    }
}

function renderProfitHistoryDropdown(mode, forceRender = false) {
    const node = state.simulationNodes[mode] || document.getElementById(mode === 'buy' ? 'buySimulation' : 'sellSimulation');
    if (!node) return;

    const slots = getSimulationSlotRefs(mode, node);
    const list = slots.profitHistoryList;
    const count = slots.profitHistoryCount;
    const pill = slots.profitChangePill;
    const dropdown = slots.profitHistoryDropdown;
    if (!list) return;

    const history = state.simulation.profitHistory || [];
    if (count) count.textContent = `${history.length} data`;

    if (pill) {
        if (history.length === 0) {
            renderPriceChangeIndicator(pill, null, null);
        } else if (history.length === 1) {
            const latest = history[0];
            renderPriceChangeIndicator(pill, Number(latest.profitLoss), 0);
        } else {
            const latest = history[history.length - 1];
            const prev = history[history.length - 2];
            renderPriceChangeIndicator(pill, Number(latest.profitLoss), Number(prev.profitLoss));
        }
    }

    // LAZY RENDER OPTIMIZATION: Tunda pembuatan HTML jika dropdown sedang tertutup
    if (!forceRender && dropdown && dropdown.classList.contains('hidden')) {
        return;
    }

    if (history.length === 0) {
        list.innerHTML = '<p class="price-history-empty">Menunggu pergerakan harga...</p>';
        return;
    }

    const savedScrollTop = list.scrollTop;
    const valueKey = 'profitLoss';
    list.innerHTML = history
        .slice()
        .reverse()
        .map((item, index, reversed) => {
            const nextOlder = reversed[index + 1];
            const value = Number(item[valueKey]);
            const change = nextOlder ? value - Number(nextOlder[valueKey]) : 0;
            const gramDiff = Number(item.gramDiff) || 0;

            const isPositiveValue = value >= 0;
            const valueColorClass = isPositiveValue
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400';

            const gramDiffColorClass = gramDiff > 0
                ? 'text-green-600 dark:text-green-400'
                : gramDiff < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-500 dark:text-gray-400';
            const formattedGramDiff = `${gramDiff > 0 ? '+' : ''}${gramDiff.toFixed(4)} g`;

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

            const formattedChange = formatRupiah(Math.abs(change));
            const formattedValue = value === 0 ? formatRupiah(0) : (value > 0 ? `+${formatRupiah(value)}` : formatRupiah(value));

            return `
            <div class="profit-history-item">
                <span class="price-history-time font-numeric">${item.time}</span>
                <span class="profit-history-gram font-numeric ${gramDiffColorClass}" title="Selisih Gram">${formattedGramDiff}</span>
                <span class="profit-history-price font-numeric ${valueColorClass}">${formattedValue}</span>
                <span class="usd-idr-history-pill ${directionClass} font-numeric" title="Perubahan dibanding menit sebelumnya">
                    <svg class="usd-idr-history-pill-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="${arrowPath}"></path>
                    </svg>
                    <span>${formattedChange}</span>
                </span>
            </div>
            `;
        })
        .join('');

    if (savedScrollTop > 0) {
        list.scrollTop = savedScrollTop;
    }
}

function updateSimulation(skipAddHistory = false) {
    if (!dom.simulationResults) return;

    const buy = Number(state.currentBuy);
    const sell = Number(state.currentSell);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) return;

    const mode = state.simulation.mode;
    if (!mode) return;

    if (dom.noSimulation) dom.noSimulation.style.display = 'none';
    const clearBtn = dom.clearSimulationBtn;
    if (clearBtn) clearBtn.classList.remove('hidden');

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

        const markedGram = (state.simulation.isManual && Number.isFinite(Number(state.simulation.gram)) && Number(state.simulation.gram) > 0)
            ? Number(state.simulation.gram)
            : floor4(SIMULATION_BUY_BASE / state.simulation.buyPrice);
        state.simulation.gram = markedGram;
        const currentGram = floor4(SIMULATION_SELL_BASE / sell);
        const gramDiff = floor4(markedGram - currentGram);
        const nilaiJual = markedGram * sell;
        const profitLoss = Math.round(nilaiJual - SIMULATION_SELL_BASE);

        saveSimulationToStorage();
        const node = ensureSimulationNode('buy');
        updateSimulationCardValues('buy', node, markedGram, currentGram, gramDiff, profitLoss);
        if (!skipAddHistory) {
            syncSimulationProfitHistory();
        } else {
            renderProfitHistoryDropdown('buy');
        }

        if (dom.simulationStatus) {
            updateSimulationStatus('buy');
        }

    } else if (mode === 'sell' && state.simulation.sellPrice) {

        const markedGram = (state.simulation.isManual && Number.isFinite(Number(state.simulation.gram)) && Number(state.simulation.gram) > 0)
            ? Number(state.simulation.gram)
            : floor4(SIMULATION_SELL_BASE / state.simulation.sellPrice);
        state.simulation.gram = markedGram;
        const currentGram = floor4(SIMULATION_BUY_BASE / buy);
        const gramDiff = floor4(currentGram - markedGram);
        const profitLoss = Math.round(gramDiff * sell);
        saveSimulationToStorage();
        const node = ensureSimulationNode('sell');
        updateSimulationCardValues('sell', node, markedGram, currentGram, gramDiff, profitLoss);
        if (!skipAddHistory) {
            syncSimulationProfitHistory();
        } else {
            renderProfitHistoryDropdown('sell');
        }

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
                state.simulation = parsed.simulation || {};
                state.simulation.isManual = Boolean(state.simulation.isManual);
                state.simulation.profitHistory = dedupeProfitHistory(state.simulation.profitHistory);
                state.lastSimulationStorageKey = getSimulationStorageKey();
                state.simulationStorageLastSavedAt = Number(parsed.timestamp) || Date.now();
                debugLog('Simulasi dimuat dari localStorage:', state.simulation);

                const timestampEl = dom.simulationTimestamp;
                if (timestampEl) {
                    const timeDisplay = state.simulation.time ? formatMinuteOnly(state.simulation.time) : formatMinuteOnly(new Date(parsed.timestamp));
                    timestampEl.textContent = `Menit simulasi : ${timeDisplay}`;
                }

                if (state.simulation.mode === 'buy' && state.simulation.buyPrice) {
                    dom.markBuyBtn?.classList.add('simulation-active');
                    dom.markSellBtn?.classList.remove('simulation-active');
                } else if (state.simulation.mode === 'sell' && state.simulation.sellPrice) {
                    dom.markSellBtn?.classList.add('simulation-active');
                    dom.markBuyBtn?.classList.remove('simulation-active');
                }

                // Segera update kartu simulasi dan sinkronkan riwayat profit ke riwayat harga
                const buy = Number(state.currentBuy);
                const sell = Number(state.currentSell);
                if (buy > 0 && sell > 0) {
                    updateSimulation(true);
                }
                syncSimulationProfitHistory();

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
        gram: null,
        isManual: false,
        time: null,
        startTime: null,
        profitHistory: []
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



    const timestampEl = dom.simulationTimestamp;
    if (timestampEl) {
        timestampEl.textContent = 'Menit simulasi : -';
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
function ensureSimStatusTemplate() {
    if (simStatusSlots && simStatusSlots.root && simStatusSlots.root.isConnected) {
        return simStatusSlots;
    }

    dom.simulationStatus.innerHTML = `
    <div class="simulation-status-summary text-left">
        <div class="simulation-status-mode">
            <div class="flex items-center">
                <svg class="ui-icon w-5 h-5 animate-pulse mr-1.5 flex-shrink-0" data-slot="modeIcon"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d=""></path>
                </svg>
                <span class="simulation-status-price font-bold" data-slot="modeText"></span>
            </div>
            <p class="text-xs font-semibold font-numeric mt-1" style="padding-left: 26px;" data-slot="priceDiff"></p>
        </div>
        <div class="simulation-status-value text-right">
            <p class="text-xxs text-gray-500 dark:text-gray-400" data-slot="priceLabel"></p>
            <p class="simulation-status-price font-bold font-numeric mt-1" data-slot="priceValue"></p>
        </div>
    </div>`;

    const root = dom.simulationStatus.firstElementChild;
    simStatusSlots = {
        root: root,
        modeIcon: root.querySelector('[data-slot="modeIcon"]'),
        modeIconPath: root.querySelector('[data-slot="modeIcon"] path'),
        modeText: root.querySelector('[data-slot="modeText"]'),
        priceLabel: root.querySelector('[data-slot="priceLabel"]'),
        priceValue: root.querySelector('[data-slot="priceValue"]'),
        priceDiff: root.querySelector('[data-slot="priceDiff"]')
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
        const timeDisplay = state.simulation.time ? formatMinuteOnly(state.simulation.time) : formatMinuteOnly(getServerNow());
        timestampEl.textContent = `Menit simulasi : ${timeDisplay}`;
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

    // Update price value (fokus utama, ukuran besar dan berwarna hijau/merah)
    const priceEl = slots.priceValue;
    priceEl.textContent = formatRupiah(price);
    priceEl.classList.remove(...SIM_STATUS_COLOR_CLASSES);
    priceEl.classList.add(...(isBuy ? ['text-green-600', 'dark:text-green-400'] : ['text-red-600', 'dark:text-red-400']));

    // Hitung selisih dengan harga saat ini (sekunder, diletakkan di sisi kiri)
    const buy = Number(state.currentBuy);
    const sell = Number(state.currentSell);
    if (slots.priceDiff && buy > 0 && sell > 0) {
        const diff = isBuy ? (buy - price) : (price - sell);
        const formattedDiff = diff === 0 ? 'Rp 0' : (diff > 0 ? `+${formatRupiah(diff)}` : `-${formatRupiah(Math.abs(diff))}`);

        slots.priceDiff.textContent = `(${formattedDiff})`;
        slots.priceDiff.classList.remove('text-green-600', 'dark:text-green-400', 'text-red-600', 'dark:text-red-400', 'text-gray-500', 'dark:text-gray-400');

        if (diff > 0) {
            slots.priceDiff.classList.add('text-green-600', 'dark:text-green-400');
        } else if (diff < 0) {
            slots.priceDiff.classList.add('text-red-600', 'dark:text-red-400');
        } else {
            slots.priceDiff.classList.add('text-gray-500', 'dark:text-gray-400');
        }
    }
}

/* ================= TIMERS ================= */
function startTimers() {
    if (state.timerTicker) {
        clearTimeout(state.timerTicker);
        clearInterval(state.timerTicker);
        state.timerTicker = null;
    }
    // Self-aligning 1-second timer dengan kompensasi jitter timer OS (20ms buffer setelah pergantian detik)
    const scheduleNextTick = () => {
        if (document.hidden) return;
        const rawNowMs = getServerNow().getTime();
        const msIntoSecond = ((rawNowMs % 1000) + 1000) % 1000;

        // Jika timer OS bangun sedikit lebih awal (>= 960ms, artinya <= 40ms sebelum pergantian detik),
        // bulatkan ke detik berikutnya dan jadwalkan tick selanjutnya untuk detik setelahnya agar tidak pernah double-tick
        let delay;
        if (msIntoSecond >= 960) {
            const snappedMs = rawNowMs + (1000 - msIntoSecond);
            tickTimers(new Date(snappedMs));
            delay = (1000 - msIntoSecond) + 1000 + 20;
        } else {
            tickTimers(new Date(rawNowMs));
            delay = (1000 - msIntoSecond) + 20;
        }

        state.timerTicker = setTimeout(scheduleNextTick, delay);
    };
    scheduleNextTick();
}

function tickTimers(overrideServerNow = null) {
    const serverNow = overrideServerNow || getServerNow();

    // Update tampilan jam digital native server Treasury
    updateServerClock(serverNow);

    // Sync ulang jam fisik server Treasury setiap 15 menit terhadap clock drift perangkat
    if (!state.lastClockSyncTime || (Date.now() - state.lastClockSyncTime > 15 * 60 * 1000)) {
        state.lastClockSyncTime = Date.now();
        syncServerClock(true);
    }

    // Watchdog cadangan adaptif: Hanya fetch jika Pusher WebSocket hening saat pergantian menit
    const currentMinuteBucket = Math.floor(serverNow.getTime() / 60000);
    const isNewMinute = state.lastAutoFetchMinute !== currentMinuteBucket;
    const silentMs = state.lastWsEventTime ? (Date.now() - state.lastWsEventTime) : 120000;
    const isPusherSilent = silentMs > 75000;

    // Interval bertahap (adaptive backoff): 2 menit di awal, lalu 5 menit jika hening lama (pasar sepi/tutup)
    const requiredIntervalMs = silentMs > 300000 ? 300000 : 120000;
    const timeSinceLastWatchdog = Date.now() - (state.lastWatchdogFetchTime || 0);

    if (isNewMinute && isPusherSilent && !state.isFetching && timeSinceLastWatchdog >= requiredIntervalMs) {
        state.lastAutoFetchMinute = currentMinuteBucket;
        state.lastWatchdogFetchTime = Date.now();
        debugLog(`Watchdog: WebSocket hening ${(silentMs / 1000).toFixed(0)}s, mengambil data fallback REST (interval: ${requiredIntervalMs / 1000}s)...`);
        fetchHarga();
    }
}

/* ================= NATIVE TREASURY SERVER CLOCK ================= */
function updateServerClock(serverNow) {
    if (!dom.serverClockHms) return;

    // Strict Monotonic Second Guard:
    // Jangan pernah mengizinkan tampilan detik mundur atau mengulang detik yang sudah tampil
    // jika terjadi penyesuaian offset kecil (<= 5 detik)
    const currentSec = Math.floor(serverNow.getTime() / 1000);
    if (state.lastDisplayedSecond && currentSec < state.lastDisplayedSecond && (state.lastDisplayedSecond - currentSec) <= 5) {
        return;
    }
    state.lastDisplayedSecond = currentSec;

    const timeStr = formatTimeIdHms(serverNow).replace(/\./g, ':');

    if (dom.serverClockHms.textContent !== timeStr) {
        dom.serverClockHms.textContent = timeStr;
    }

    if (dom.serverClockDate) {
        const dayKey = getWibDateStr(serverNow);
        if (state._lastClockDayKey !== dayKey) {
            state._lastClockDayKey = dayKey;
            dom.serverClockDate.textContent = serverDateFormatter.format(serverNow);
        }
    }

    if (dom.serverClockOffset) {
        const offsetSec = Math.round((state.serverTimeOffset || 0) / 1000);
        const text = Math.abs(offsetSec) >= 1 ? `Sync (${offsetSec > 0 ? '+' : ''}${offsetSec}s)` : 'Akurat';
        if (dom.serverClockOffset.textContent !== text) {
            dom.serverClockOffset.textContent = text;
            dom.serverClockOffset.title = `Terkoreksi ${offsetSec > 0 ? '+' : ''}${offsetSec} detik dari jam internal perangkat untuk memastikan 100% presisi dengan rilis harga Treasury.`;
        }
    }
}



/* ================= PWA INSTALLATION & SERVICE WORKER ================= */
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (dom.installPwaBtn) {
        dom.installPwaBtn.classList.remove('hidden');
    }
});

window.addEventListener('appinstalled', () => {
    debugLog('PWA was installed successfully!');
    if (dom.installPwaBtn) {
        dom.installPwaBtn.classList.add('hidden');
    }
    deferredPrompt = null;
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then((reg) => debugLog('ServiceWorker registered with scope:', reg.scope))
            .catch((err) => console.error('ServiceWorker registration failed:', err));
    });
}
