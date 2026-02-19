/* ================= REQUEST HEADERS (AMAN UNTUK BROWSER) ================= */
const REQUEST_HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-ID,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,id;q=0.6',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
};

/* ================= INSTANT LOAD ================= */
const priceCache = {
    data: null,
    timestamp: 0,
    isValid: () => Date.now() - priceCache.timestamp < 10000,
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
            localStorage.setItem('gold_cache', JSON.stringify({
                data,
                timestamp: Date.now()
            }));
        } catch (e) { }
    }
};

// Load from localStorage
try {
    const saved = localStorage.getItem('gold_cache');
    if (saved) {
        const parsed = JSON.parse(saved);
        if (Date.now() - parsed.timestamp < 30000) {
            priceCache.data = parsed.data;
            priceCache.timestamp = parsed.timestamp;
        }
    }
} catch (e) { }

/* ================= GLOBAL STATE ================= */
let state = {
    countdown: 60,
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
    priceAnimationTimeoutId: null,
    priceAnimationFrameId: null
};

/* ================= DOM CACHE ================= */
const dom = {};

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
const SIMULATION_STORAGE_THROTTLE_MS = 5000;
const SIMULATION_BUY_BASE = 50000000;
const SIMULATION_SELL_BASE = 48325000;
const DEBUG = false;

function debugLog(...args) {
    if (DEBUG) console.log(...args);
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
        const width = Math.max(0, Math.min(100, (state.countdown / 60) * 100));
        dom.countdownBar.style.width = `${width}%`;
    }
}

function setCuanColorClass(isPositive) {
    if (!dom.cuan) return;
    dom.cuan.classList.toggle('text-green-600', isPositive);
    dom.cuan.classList.toggle('dark:text-green-400', isPositive);
    dom.cuan.classList.toggle('text-red-600', !isPositive);
    dom.cuan.classList.toggle('dark:text-red-400', !isPositive);
}

function triggerPriceChangeAnimation() {
    if (!dom.hargaBeli || !dom.hargaJual) return;

    dom.hargaBeli.classList.remove('price-update');
    dom.hargaJual.classList.remove('price-update');

    if (state.priceAnimationFrameId) {
        cancelAnimationFrame(state.priceAnimationFrameId);
    }
    if (state.priceAnimationTimeoutId) {
        clearTimeout(state.priceAnimationTimeoutId);
    }

    state.priceAnimationFrameId = requestAnimationFrame(() => {
        dom.hargaBeli.classList.add('price-update');
        dom.hargaJual.classList.add('price-update');

        state.priceAnimationTimeoutId = setTimeout(() => {
            dom.hargaBeli.classList.remove('price-update');
            dom.hargaJual.classList.remove('price-update');
            state.priceAnimationTimeoutId = null;
        }, 300);
    });
}

/* ================= RENDER CACHED DATA INSTANTLY ================= */
function renderCachedData() {
    const cached = priceCache.get();
    if (!cached || !dom.hargaBeli) return false;

    debugLog('Rendering cached data');

    // Update harga
    dom.hargaBeli.textContent = formatRupiah(cached.buy);
    dom.hargaJual.textContent = formatRupiah(cached.sell);
    state.lastRenderedBuy = Number(cached.buy);
    state.lastRenderedSell = Number(cached.sell);
    state.currentBuy = Number(cached.buy);
    state.currentSell = Number(cached.sell);

    // Update timestamp
    if (dom.lastUpdate) {
        const updated = new Date(cached.updated);
        dom.lastUpdate.textContent = formatTimeIdHms(updated);
    }

    // Hitung spread
    const spread = cached.buy - cached.sell;
    const spreadPercent = ((spread / cached.buy) * 100).toFixed(2);
    if (dom.spreadNominal) dom.spreadNominal.textContent = formatRupiah(spread);
    if (dom.spreadPersen) dom.spreadPersen.textContent = `(${spreadPercent}%)`;

    // Hitung gram
    const gramBeli = (SIMULATION_BUY_BASE / cached.buy).toFixed(4);
    const gramJual = (SIMULATION_SELL_BASE / cached.sell).toFixed(4);
    const nilaiJual = (SIMULATION_BUY_BASE / cached.buy * cached.sell);
    const cuan = nilaiJual - SIMULATION_SELL_BASE;

    if (dom.gramBeli) dom.gramBeli.textContent = `${gramBeli} g`;
    if (dom.gramJual) dom.gramJual.textContent = `${gramJual} g`;
    if (dom.nilaiJual) dom.nilaiJual.textContent = formatRupiah(nilaiJual);

    // Cuan
    if (dom.cuan) {
        dom.cuan.textContent = formatRupiah(cuan);
        setCuanColorClass(cuan >= 0);
    }

    return true;
}

/* ================= FUNGSI BARU: HANDLE TOUCH UNTUK TRADING VIEW ================= */
function fixTradingViewTouch() {
    const tvIframe = document.getElementById('tvIframe');
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
    tvIframe.addEventListener('touchend', function (e) {
        isTouching = false;
        isHorizontalDrag = false;
        document.body.classList.remove('chart-touching');
        setChartTouchVisual('idle');
        detachBodyTouchMoveLock();
    });

    // Saat sentuhan dibatalkan
    tvIframe.addEventListener('touchcancel', function (e) {
        isTouching = false;
        isHorizontalDrag = false;
        document.body.classList.remove('chart-touching');
        setChartTouchVisual('idle');
        detachBodyTouchMoveLock();
    });
}

/* ================= INIT DOM ================= */
document.addEventListener('DOMContentLoaded', () => {
    debugLog('DOM Ready');

    // Cache DOM elements
    const ids = [
        'hargaBeli', 'hargaJual', 'spreadNominal', 'spreadPersen',
        'gramBeli', 'gramJual', 'nilaiJual', 'cuan', 'lastUpdate',
        'countdown', 'countdownBar', 'simulationResults', 'noSimulation',
        'simulationStatus', 'markBuyBtn', 'markSellBtn',
        'refreshApiBtn', 'themeText', 'bigRefreshBtn',
        'chartWidthBtn', 'chartWidthMenu', 'dashboardGrid',
        'leftPanel', 'rightPanel', 'clearSimulationBtn', 'simulationTimestamp',
        'darkModeBtn', 'refreshIframeBtn', 'fullscreenBtn', 'timeIframe', 'tvIframe',
        'manualGramInput', 'manualGramError', 'applyManualBuyBtn', 'applyManualSellBtn',
        'manualBuyPricePreview', 'manualSellPricePreview',
        'manualGramAccordion', 'accordionToggleBtn', 'accordionContent', 'accordionChevron'
    ];

    ids.forEach(id => {
        dom[id] = document.getElementById(id);
    });

    // Tampilkan data cache INSTANTLY
    const hasCache = renderCachedData();

    // Load simulation from storage
    loadSimulationFromStorage();

    // Load chart width preference
    const savedWidth = localStorage.getItem('chartWidth');
    if (savedWidth) {
        state.chartWidth = savedWidth;
        applyChartWidth(savedWidth);
    }

    // Bind events
    if (dom.clearSimulationBtn) {
        dom.clearSimulationBtn.addEventListener('click', clearSimulation);
    }

    // Setup accordion toggle
    if (dom.accordionToggleBtn && dom.accordionContent && dom.accordionChevron) {
        dom.accordionToggleBtn.addEventListener('click', () => {
            const isHidden = dom.accordionContent.classList.contains('hidden');
            
            if (isHidden) {
                // Open accordion
                dom.accordionContent.classList.remove('hidden');
                dom.accordionChevron.classList.add('rotated');
                
                // Animasi smooth via class (opsional, bisa pakai CSS transition)
                dom.accordionContent.style.maxHeight = dom.accordionContent.scrollHeight + 'px';
            } else {
                // Close accordion
                dom.accordionContent.style.maxHeight = '0px';
                setTimeout(() => {
                    dom.accordionContent.classList.add('hidden');
                    dom.accordionChevron.classList.remove('rotated');
                    dom.accordionContent.style.maxHeight = '';
                }, 300); // Sama dengan durasi CSS transition
            }
        });
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
        applyManualGramSimulation('buy');
    });

    dom.applyManualSellBtn?.addEventListener('click', () => {
        applyManualGramSimulation('sell');
    });

    updateManualPricePreview();

    if (dom.refreshApiBtn) {
        dom.refreshApiBtn.addEventListener('click', () => {
            state.isManualRefresh = true;
            state.isAutoFetching = false;
            state.isRetrying = false;
            state.retryCount = 0;
            state.targetMinute = null;
            clearRetryTimeout();

            if (state.fetchController) state.fetchController.abort();
            fetchHarga();
        });
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
            state.isManualRefresh = true;
            state.isAutoFetching = false;
            state.isRetrying = false;
            state.retryCount = 0;
            state.targetMinute = null;
            clearRetryTimeout();

            if (state.fetchController) state.fetchController.abort();

            if (dom.bigRefreshIcon) {
                dom.bigRefreshIcon.classList.remove('refresh-spin-once');
                void dom.bigRefreshIcon.offsetWidth;
                dom.bigRefreshIcon.classList.add('refresh-spin-once');
            }

            fetchHarga();
        });
    }

    // Chart width controls
    if (dom.chartWidthBtn) {
        dom.chartWidthBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = dom.chartWidthMenu;
            menu.classList.toggle('hidden');
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

    // Close chart width menu when clicking outside
    document.addEventListener('click', () => {
        if (dom.chartWidthMenu && !dom.chartWidthMenu.classList.contains('hidden')) {
            dom.chartWidthMenu.classList.add('hidden');
        }
    });

    // Dark mode button
    const darkBtn = dom.darkModeBtn;
    if (darkBtn) {
        darkBtn.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('darkMode', isDark);

            // Update TradingView
            const tvIframe = dom.tvIframe;
            if (tvIframe) {
                tvIframe.src = tvIframe.src.replace(/theme=\w+/, `theme=${isDark ? 'dark' : 'light'}`);
            }

            // Update button text
            if (dom.themeText) {
                dom.themeText.textContent = isDark ? 'Light' : 'Dark';
            }
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

    // Start timers
    startTimers();

    // Fetch data
    setTimeout(() => {
        if (!hasCache) {
            fetchHarga();
        } else {
            setTimeout(fetchHarga, 500);
        }
    }, 100);

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
            dom.lastUpdate.textContent = `Retrying... (${state.retryCount}/${state.MAX_RETRY})`;
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

    // Timeout 3 detik
    const timeoutId = setTimeout(() => {
        isTimedOut = true;
        controller.abort();
    }, 3000);

    try {
        const start = Date.now();

        // Gunakan header yang bisa diatur dari browser
        const headers = new Headers();
        Object.entries(REQUEST_HEADERS).forEach(([key, value]) => {
            headers.set(key, value);
        });

        const res = await fetch('https://api.treasury.id/api/v1/antigrvty/gold/rate', {
            method: 'POST',
            signal: controller.signal,
            headers: headers,
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow',
            referrer: window.location.href,
            referrerPolicy: 'no-referrer-when-downgrade'
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
            handleRetryLogic(now);
        }

    } catch (err) {

        if (err.name === 'AbortError') {
            if (!isTimedOut) {
                debugLog('Fetch dibatalkan oleh request baru');
                return;
            }

            if (dom.lastUpdate) {
                dom.lastUpdate.textContent = 'Timeout (3s)';
            }
            debugLog('Fetch timeout');

            if (!state.isManualRefresh) {
                handleFetchError('timeout');
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
            handleFetchError('other');
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

/* ================= LOGIKA RETRY UNTUK AUTO-FETCH SAJA ================= */
function handleRetryLogic(now) {
    if (!state.targetMinute) {
        state.targetMinute = now.getMinutes();
    }

    if (state.retryCount >= state.MAX_RETRY) {
        debugLog('Max retry reached, stopping');
        state.isRetrying = false;
        state.retryCount = 0;
        state.targetMinute = null;
        clearRetryTimeout();
        return;
    }

    state.retryCount++;
    const delay = Math.min(2000, 500 + (state.retryCount * 300));
    debugLog(`Retry ${state.retryCount}/${state.MAX_RETRY} in ${delay}ms`);

    clearRetryTimeout();
    state.retryTimeoutId = setTimeout(() => {
        state.retryTimeoutId = null;
        if (state.isAutoFetching && state.isRetrying) {
            fetchHarga();
        }
    }, delay);
}

/* ================= HANDLE ERROR UNTUK AUTO-FETCH SAJA ================= */
function handleFetchError(errorType) {
    if (state.isAutoFetching && state.isRetrying) {
        if (state.retryCount >= state.MAX_RETRY) {
            state.isRetrying = false;
            state.retryCount = 0;
            state.targetMinute = null;
            clearRetryTimeout();
            return;
        }

        state.retryCount++;
        const delay = Math.min(2000, 500 + (state.retryCount * 300));
        debugLog(`Retry after ${errorType} ${state.retryCount}/${state.MAX_RETRY} in ${delay}ms`);

        clearRetryTimeout();
        state.retryTimeoutId = setTimeout(() => {
            state.retryTimeoutId = null;
            if (state.isAutoFetching && state.isRetrying) {
                fetchHarga();
            }
        }, delay);
    }
}

/* ================= UPDATE UI ================= */
function updateUI(data) {
    if (!dom.hargaBeli) return;

    const buy = Number(data.buy);
    const sell = Number(data.sell);
    if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) return;
    state.currentBuy = buy;
    state.currentSell = sell;

    const priceChanged = state.lastRenderedBuy !== buy || state.lastRenderedSell !== sell;

    if (priceChanged) {
        // Update harga
        dom.hargaBeli.textContent = formatRupiah(buy);
        dom.hargaJual.textContent = formatRupiah(sell);

        // Animation
        triggerPriceChangeAnimation();

        // Spread
        const spread = buy - sell;
        const spreadPercent = (spread / buy * 100).toFixed(2);
        if (dom.spreadNominal) dom.spreadNominal.textContent = formatRupiah(spread);
        if (dom.spreadPersen) dom.spreadPersen.textContent = `(${spreadPercent}%)`;

        // Gram calculations
        const gramBeli = (SIMULATION_BUY_BASE / buy).toFixed(4);
        const gramJual = (SIMULATION_SELL_BASE / sell).toFixed(4);
        const nilaiJual = (SIMULATION_BUY_BASE / buy * sell);
        const cuan = nilaiJual - SIMULATION_SELL_BASE;

        if (dom.gramBeli) dom.gramBeli.textContent = `${gramBeli} g`;
        if (dom.gramJual) dom.gramJual.textContent = `${gramJual} g`;
        if (dom.nilaiJual) dom.nilaiJual.textContent = formatRupiah(nilaiJual);

        // Cuan
        if (dom.cuan) {
            dom.cuan.textContent = formatRupiah(cuan);
            setCuanColorClass(cuan >= 0);
        }

        state.lastRenderedBuy = buy;
        state.lastRenderedSell = sell;
    }

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
function setProfitColorClass(el, isPositive) {
    if (!el) return;
    el.classList.remove('text-green-600', 'dark:text-green-400', 'text-red-600', 'dark:text-red-400');
    if (isPositive) {
        el.classList.add('text-green-600', 'dark:text-green-400');
    } else {
        el.classList.add('text-red-600', 'dark:text-red-400');
    }
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
        node.className = 'space-y-3 simulation-active animate-fade-in';
        node.innerHTML = mode === 'buy'
            ? `
        <div class="grid grid-cols-2 gap-2">
            <div class="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Gram Beli (50jt)</p>
                <p data-slot="markedGram" class="text-base font-bold text-green-600 dark:text-green-400 font-numeric">-</p>
            </div>
            <div class="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Gram Sekarang</p>
                <p data-slot="currentGram" class="text-base font-bold text-gray-900 dark:text-gray-100 font-numeric">-</p>
            </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
            <div class="bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/10 dark:to-orange-900/10 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Selisih Gram</p>
                <p data-slot="gramDiff" class="text-base font-bold font-numeric">-</p>
            </div>
            <div class="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Profit / Loss</p>
                <p data-slot="profitLoss" class="text-lg font-bold font-numeric">-</p>
            </div>
        </div>`
            : `
        <div class="grid grid-cols-2 gap-2">
            <div class="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-900/20 dark:to-rose-900/20 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Gram Jual (48.325jt)</p>
                <p data-slot="markedGram" class="text-base font-bold text-red-600 dark:text-red-400 font-numeric">-</p>
            </div>
            <div class="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Gram Sekarang</p>
                <p data-slot="currentGram" class="text-base font-bold text-gray-900 dark:text-gray-100 font-numeric">-</p>
            </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
            <div class="bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/10 dark:to-orange-900/10 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Selisih Gram</p>
                <p data-slot="gramDiff" class="text-base font-bold font-numeric">-</p>
            </div>
            <div class="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 p-2.5 rounded-lg">
                <p class="text-xxs text-gray-600 dark:text-gray-400 mb-1">Profit / Loss</p>
                <p data-slot="profitLoss" class="text-lg font-bold font-numeric">-</p>
            </div>
        </div>`;
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
        profitLossEl: node.querySelector('[data-slot="profitLoss"]')
    };
    state.simulationSlots[mode] = slots;
    return slots;
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

    const isPositive = profitLoss >= 0;
    setProfitColorClass(gramDiffEl, isPositive);
    setProfitColorClass(profitLossEl, isPositive);
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

let previewTimeout;
function updateManualPricePreview() {
    clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
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
    if (mode !== 'buy' && mode !== 'sell') return;

    const gram = parsePositiveFloat(dom.manualGramInput?.value || '');
    if (!gram) {
        setManualGramError('Masukkan gram valid lebih dari 0');
        return;
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

    // Tampilkan accordion manual gram jika ada simulasi aktif
    if (dom.manualGramAccordion) {
        dom.manualGramAccordion.classList.remove('hidden');
    }

    const inactiveMode = mode === 'buy' ? 'sell' : 'buy';
    const inactiveNode = state.simulationNodes[inactiveMode] ||
        document.getElementById(inactiveMode === 'buy' ? 'buySimulation' : 'sellSimulation');
    if (inactiveNode) inactiveNode.remove();
    state.simulationNodes[inactiveMode] = null;
    state.simulationSlots[inactiveMode] = null;

    if (mode === 'buy' && state.simulation.buyPrice) {
        const markedGram = SIMULATION_BUY_BASE / state.simulation.buyPrice;
        state.simulation.gram = markedGram;
        const currentGram = SIMULATION_SELL_BASE / sell;
        const gramDiff = markedGram - currentGram;
        const profitLoss = (markedGram * sell) - SIMULATION_SELL_BASE;

        saveSimulationToStorage();
        const node = ensureSimulationNode('buy');
        updateSimulationCardValues('buy', node, markedGram, currentGram, gramDiff, profitLoss);

        if (dom.simulationStatus) {
            updateSimulationStatus(markedGram, profitLoss, 'buy');
        }

    } else if (mode === 'sell' && state.simulation.sellPrice) {
        const markedGram = SIMULATION_SELL_BASE / state.simulation.sellPrice;
        state.simulation.gram = markedGram;
        const currentGram = SIMULATION_BUY_BASE / buy;
        const gramDiff = currentGram - markedGram;
        const profitLoss = SIMULATION_BUY_BASE - (markedGram * buy);

        saveSimulationToStorage();
        const node = ensureSimulationNode('sell');
        updateSimulationCardValues('sell', node, markedGram, currentGram, gramDiff, profitLoss);

        if (dom.simulationStatus) {
            updateSimulationStatus(markedGram, profitLoss, 'sell');
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

        localStorage.setItem('gold_simulation', JSON.stringify({
            simulation: state.simulation,
            timestamp: now
        }));
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
            if (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
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

    // Sembunyikan accordion
    if (dom.manualGramAccordion) {
        dom.manualGramAccordion.classList.add('hidden');
        if (dom.accordionContent) {
            dom.accordionContent.classList.add('hidden');
            dom.accordionChevron?.classList.remove('rotated');
        }
    }

    const clearBtn = dom.clearSimulationBtn;
    if (clearBtn) clearBtn.classList.add('hidden');

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

    debugLog('Simulasi dihapus');
}

/* ================= FUNGSI BARU: UPDATE STATUS SIMULASI ================= */
function updateSimulationStatus(markedGram, profitLoss, mode) {
    const profitClassStatus = profitLoss >= 0
        ? 'text-green-700 dark:text-green-400'
        : 'text-red-700 dark:text-red-400';

    const price = mode === 'buy' ? state.simulation.buyPrice : state.simulation.sellPrice;
    const priceLabel = mode === 'buy' ? 'Harga Beli' : 'Harga Jual';
    const priceColor = mode === 'buy' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
    const modeColor = mode === 'buy' ? 'bg-green-500' : 'bg-red-500';
    const modeText = mode === 'buy' ? 'Simulasi Beli' : 'Simulasi Jual';
    const modeTextColor = mode === 'buy' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';

    const timestampEl = dom.simulationTimestamp;
    if (timestampEl) {
        const now = new Date();
        timestampEl.textContent = `Update terakhir : ${formatTimeIdHms(now)}`;
    }

    dom.simulationStatus.innerHTML = `
    <div class="text-left space-y-3">
        <div class="flex items-center justify-between">
            <div class="flex items-center">
                <div class="status-indicator ${modeColor} animate-pulse mr-2"></div>
                <div>
                    <p class="text-sm font-semibold ${modeTextColor}">${modeText}</p>
                    <p class="text-xxs text-gray-500 dark:text-gray-400">${priceLabel} yang ditandai</p>
                </div>
            </div>
            <div class="text-right">
                <p class="text-sm font-bold ${profitClassStatus} font-numeric">${formatRupiah(profitLoss)}</p>
                <p class="text-xxs font-medium ${profitClassStatus}">${profitLoss >= 0 ? 'PROFIT' : 'RUGI'}</p>
            </div>
        </div>
        
        <div class="grid grid-cols-2 gap-3">
            <div class="bg-white/50 dark:bg-gray-800/50 p-2 rounded-lg">
                <p class="text-xxs text-gray-500 dark:text-gray-400 mb-1">${priceLabel}</p>
                <p class="text-sm font-bold ${priceColor} font-numeric">${formatRupiah(price)}</p>
            </div>
            <div class="bg-white/50 dark:bg-gray-800/50 p-2 rounded-lg">
                <p class="text-xxs text-gray-500 dark:text-gray-400 mb-1">Gram</p>
                <p class="text-sm font-bold text-blue-600 dark:text-blue-400 font-numeric">${markedGram.toFixed(4)} g</p>
            </div>
        </div>
    </div>`;
}

/* ================= TIMERS ================= */
function resetCountdown() {
    state.countdown = 60;
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

    const now = new Date();
    if (now.getSeconds() === 1 && !state.isFetching) {
        debugLog('Auto-fetch detik 1');

        state.isAutoFetching = true;
        state.isRetrying = true;
        state.retryCount = 0;
        state.targetMinute = null;
        clearRetryTimeout();

        fetchHarga();
    }
}

/* ================= INITIAL SETUP ================= */
if (localStorage.getItem('darkMode') === 'true') {
    document.documentElement.classList.add('dark');
} else if (!localStorage.getItem('darkMode') &&
    window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
}