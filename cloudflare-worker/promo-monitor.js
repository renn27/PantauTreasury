/**
 * Cloudflare Worker: Treasury Promo Monitor (PWA Web Push 24/7)
 * 
 * 100% Murni PWA Web Push (Standar W3C RFC 8291 / RFC 8292).
 * Tidak memerlukan Telegram atau aplikasi pihak ketiga.
 * Notifikasi dikirim langsung ke HP/PC via Service Worker PWA.
 */

// URL Firebase Database Treasury Promo
const FIREBASE_SETTINGS_URL = 'https://monitor-treasury-default-rtdb.firebaseio.com/admin_settings.json';

// Kunci VAPID Resmi ECDSA P-256 (Dapat di-override via Environment Variables)
const DEFAULT_VAPID_PUBLIC_KEY = 'BAAxHYI3EH7oFyKkwfd9P-TIpAfhEl5GD9WzP74nckzJa_NtmCxr-p9WDIHjpJO7soyltRMJFXaGwWIzNDoK4vc';
const DEFAULT_VAPID_PRIVATE_KEY = 'PhPpF6zUB5ofT5BFrPvMoGLJCQsDVOtvjLBDfFjpqXw';
const DEFAULT_VAPID_SUBJECT = 'mailto:admin@pantautreasury.com';

// Cache memory lokal (jika KV belum di-bind di dashboard)
const memorySubscriptions = new Map();
let memoryLastStatus = null;
let memoryLastPrice = null;

export default {
    /**
     * Pemicu Cron Trigger (Dijadwalkan setiap 1 menit: "* * * * *")
     */
    async scheduled(event, env, ctx) {
        ctx.waitUntil(checkPromoAndBroadcastPush(env));
    },

    /**
     * Endpoint HTTP untuk manajemen Subscription PWA dan pengujian
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // 1. Endpoint /vapid-public-key: Berikan public key ke frontend
        if (url.pathname === '/vapid-public-key') {
            const pubKey = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
            return new Response(JSON.stringify({ public_key: pubKey }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 2. Endpoint /subscribe: Simpan langganan Web Push dari browser HP
        if (url.pathname === '/subscribe' && request.method === 'POST') {
            try {
                const sub = await request.json();
                if (!sub || !sub.endpoint) {
                    return new Response(JSON.stringify({ error: 'Invalid subscription object' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json', ...corsHeaders }
                    });
                }

                const subId = await hashString(sub.endpoint);
                const subStr = JSON.stringify(sub);

                if (env.PROMO_KV) {
                    // Simpan di KV dengan masa berlaku 60 hari
                    await env.PROMO_KV.put(`sub:${subId}`, subStr, { expirationTtl: 60 * 60 * 24 * 60 });
                }
                // Simpan juga di memory Map sebagai fallback
                memorySubscriptions.set(subId, sub);

                return new Response(JSON.stringify({ success: true, message: 'PWA Push Subscription saved successfully' }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }
        }

        // 3. Endpoint /unsubscribe: Hapus langganan
        if (url.pathname === '/unsubscribe' && request.method === 'POST') {
            try {
                const body = await request.json();
                if (body && body.endpoint) {
                    const subId = await hashString(body.endpoint);
                    if (env.PROMO_KV) {
                        await env.PROMO_KV.delete(`sub:${subId}`);
                    }
                    memorySubscriptions.delete(subId);
                }
                return new Response(JSON.stringify({ success: true, message: 'Unsubscribed' }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }
        }

        // 4. Endpoint /test-push: Kirim push notifikasi uji coba ke seluruh HP terdaftar
        if (url.pathname === '/test-push') {
            const testPayload = {
                title: '🔔 TES NOTIFIKASI PWA TREASURY',
                body: `Koneksi Web Push Berhasil! HP Anda siap menerima alarm saat promo ON. Waktu: ${new Date().toLocaleTimeString('id-ID')} WIB`,
                url: './'
            };

            const results = await broadcastWebPush(env, testPayload);
            return new Response(JSON.stringify({
                success: true,
                message: 'Test notification triggered',
                device_count: results.total,
                sent_success: results.success,
                failed_or_expired: results.failed
            }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 5. Endpoint /reset-status: Reset status agar bisa menguji transisi ulang
        if (url.pathname === '/reset-status') {
            if (env.PROMO_KV) {
                await env.PROMO_KV.delete('last_promo_status');
            }
            memoryLastStatus = null;
            return new Response(JSON.stringify({ success: true, message: 'Status reset to null' }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 6. Endpoint /check-now: Cek promo secara manual (opsi ?force=true untuk tembak notifikasi langsung)
        if (url.pathname === '/check-now') {
            const force = url.searchParams.get('force') === 'true';
            const res = await checkPromoAndBroadcastPush(env, force);
            return new Response(JSON.stringify(res, null, 2), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 7. Endpoint / (Status): Menampilkan status live
        try {
            const promo = await fetchFirebasePromo();
            let subscriberCount = memorySubscriptions.size;
            let lastStatus = memoryLastStatus;

            if (env.PROMO_KV) {
                lastStatus = await env.PROMO_KV.get('last_promo_status');
                const list = await env.PROMO_KV.list({ prefix: 'sub:' });
                subscriberCount = Math.max(subscriberCount, list.keys.length);
            }

            return new Response(JSON.stringify({
                service: 'PantauTreasury PWA Push Monitor',
                status: 'ACTIVE_24_7',
                current_time_wib: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB',
                registered_pwa_devices: subscriberCount,
                live_promo_status: Boolean(promo?.promo_status),
                live_promo_price: promo?.promo_price ? Number(promo.promo_price) : 0,
                stored_prev_status: lastStatus,
                kv_storage_bound: Boolean(env.PROMO_KV),
                vapid_public_key: (env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY).slice(0, 20) + '...'
            }, null, 2), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }
    }
};

/**
 * Fetch status promo langsung dari Firebase RTDB Cuan Mania
 */
async function fetchFirebasePromo() {
    const res = await fetch(FIREBASE_SETTINGS_URL, {
        headers: { 'Accept': 'application/json' },
        cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!res.ok) {
        throw new Error(`Firebase returned HTTP ${res.status}`);
    }
    return await res.json();
}

/**
 * Mengambil status tersimpan dari KV atau memory fallback
 */
async function getStoredStatus(env) {
    if (env.PROMO_KV) {
        try {
            const val = await env.PROMO_KV.get('last_promo_status');
            if (val !== null && val !== undefined) return val;
        } catch (e) {
            console.warn('KV get error:', e);
        }
    }
    return memoryLastStatus;
}

/**
 * Menyimpan status ke KV dan memory
 */
async function setStoredStatus(env, status, price) {
    if (env.PROMO_KV) {
        try {
            await env.PROMO_KV.put('last_promo_status', String(status));
            await env.PROMO_KV.put('last_promo_price', String(price));
            await env.PROMO_KV.put('last_check_time', new Date().toISOString());
        } catch (e) {
            console.warn('KV put error:', e);
        }
    }
    memoryLastStatus = String(status);
    memoryLastPrice = String(price);
}

/**
 * Logika Pengecekan Promo dan Broadcast Web Push
 */
async function checkPromoAndBroadcastPush(env, forceCheck = false) {
    try {
        const data = await fetchFirebasePromo();
        if (!data) return { error: 'No data from Firebase' };

        const currentStatus = Boolean(data.promo_status);
        const promoPrice = Number(data.promo_price) || 0;
        const formattedPrice = promoPrice > 0 ? `Rp ${promoPrice.toLocaleString('id-ID')}` : '-';

        const prevStatusStr = await getStoredStatus(env);
        const prevBool = prevStatusStr === 'true' ? true : (prevStatusStr === 'false' ? false : null);

        let triggered = false;
        let pushResult = null;

        // Pemicu Notifikasi:
        // Kirim jika forceCheck === true ATAU jika status sekarang ON dan status sebelumnya BUKAN true
        const shouldTrigger = forceCheck || (currentStatus === true && prevBool !== true);

        if (shouldTrigger) {
            triggered = true;

            const payload = {
                title: '🔥 PROMO TREASURY AKTIF (ON)!',
                body: `Batas Beli: ${formattedPrice} | Segera buka aplikasi PantauTreasury untuk eksekusi!`,
                url: './'
            };

            pushResult = await broadcastWebPush(env, payload);
        }

        // Simpan status terbaru ke KV & Memory
        await setStoredStatus(env, currentStatus, promoPrice);

        return {
            checked_at: new Date().toISOString(),
            current_status: currentStatus,
            prev_status: prevBool,
            triggered,
            force_check: forceCheck,
            push_result: pushResult
        };
    } catch (e) {
        console.error('Check promo error:', e);
        return { error: e.message };
    }
}

/**
 * Mengirimkan Web Push ke seluruh subscriber PWA yang tersimpan
 */
async function broadcastWebPush(env, payload) {
    const subMap = new Map();

    // 1. Ambil dari KV jika ada
    if (env.PROMO_KV) {
        try {
            const list = await env.PROMO_KV.list({ prefix: 'sub:' });
            for (const key of list.keys) {
                const raw = await env.PROMO_KV.get(key.name);
                if (raw) {
                    try {
                        const sub = JSON.parse(raw);
                        if (sub && sub.endpoint) {
                            subMap.set(key.name, sub);
                        }
                    } catch (e) { }
                }
            }
        } catch (e) {
            console.warn('KV list error:', e);
        }
    }

    // 2. Gabungkan dengan memory subscriptions
    for (const [key, sub] of memorySubscriptions.entries()) {
        const fullKey = `sub:${key}`;
        if (!subMap.has(fullKey)) {
            subMap.set(fullKey, sub);
        }
    }

    const subscriptions = Array.from(subMap.entries()).map(([k, v]) => ({ key: k, sub: v }));

    const vapidPub = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
    const vapidPriv = env.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE_KEY;
    const vapidSub = env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;

    let successCount = 0;
    let failedCount = 0;

    for (const item of subscriptions) {
        try {
            const status = await sendWebPush(item.sub, payload, vapidPub, vapidPriv, vapidSub);
            if (status >= 200 && status < 300) {
                successCount++;
            } else if (status === 404 || status === 410) {
                failedCount++;
                if (env.PROMO_KV) {
                    await env.PROMO_KV.delete(item.key).catch(() => {});
                }
                memorySubscriptions.delete(item.key.replace(/^sub:/, ''));
            } else {
                failedCount++;
            }
        } catch (err) {
            failedCount++;
            console.error('Error sending push to', item.sub?.endpoint, err);
        }
    }

    return { total: subscriptions.length, success: successCount, failed: failedCount };
}

/**
 * Mengirim satu pesan Web Push (RFC 8291 + RFC 8292)
 */
async function sendWebPush(subscription, payload, pubKeyB64, privKeyB64, subject) {
    const endpoint = subscription.endpoint;
    const aud = new URL(endpoint).origin;

    // 1. Buat VAPID JWT Token
    const jwtToken = await createVapidJwt(aud, pubKeyB64, privKeyB64, subject);

    // 2. Enkripsi Payload dengan format RFC 8291 aes128gcm jika ada keys
    let bodyData = null;
    const headers = {
        'TTL': '86400',
        'Urgency': 'high',
        'Authorization': `vapid t=${jwtToken}, k=${pubKeyB64}`
    };

    if (subscription.keys && subscription.keys.p256dh && subscription.keys.auth && payload) {
        try {
            const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
            const encryptedBody = await encryptWebPushPayload(subscription.keys.p256dh, subscription.keys.auth, payloadBytes);
            bodyData = encryptedBody;
            headers['Content-Encoding'] = 'aes128gcm';
            headers['Content-Type'] = 'application/octet-stream';
        } catch (e) {
            console.warn('Payload encryption failed, falling back to tickle push:', e);
            bodyData = null;
        }
    }

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: bodyData
    });

    return res.status;
}

/**
 * Membuat JWT VAPID (ES256) menggunakan Web Crypto standard
 */
async function createVapidJwt(aud, pubKeyB64, privKeyB64, subject) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 43200; // 12 jam

    const pubBuf = base64UrlToUint8Array(pubKeyB64);
    const x = uint8ArrayToBase64Url(pubBuf.slice(1, 33));
    const y = uint8ArrayToBase64Url(pubBuf.slice(33, 65));

    const jwk = {
        kty: 'EC',
        crv: 'P-256',
        x: x,
        y: y,
        d: privKeyB64,
        ext: true
    };

    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

    const header = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify({ aud, exp, sub: subject })));
    const unsigned = `${header}.${claims}`;

    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
    const sigB64 = uint8ArrayToBase64Url(new Uint8Array(sig));

    return `${unsigned}.${sigB64}`;
}

/**
 * Enkripsi Web Push Payload (RFC 8291 aes128gcm)
 */
async function encryptWebPushPayload(receiverP256dhB64, receiverAuthB64, plaintextBytes) {
    const receiverRawPub = base64UrlToUint8Array(receiverP256dhB64);
    const receiverAuth = base64UrlToUint8Array(receiverAuthB64);

    const salt = crypto.getRandomValues(new Uint8Array(16));

    // Ephemeral local keypair
    const localPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const localRawPub = new Uint8Array(await crypto.subtle.exportKey('raw', localPair.publicKey));

    // ECDH Shared Secret
    const receiverPubKey = await crypto.subtle.importKey('raw', receiverRawPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverPubKey }, localPair.privateKey, 256);

    // HKDF derive IKM
    const infoPrefix = new TextEncoder().encode('WebPush: info\0');
    const ikmInfo = new Uint8Array(infoPrefix.length + receiverRawPub.byteLength + localRawPub.byteLength);
    ikmInfo.set(infoPrefix, 0);
    ikmInfo.set(receiverRawPub, infoPrefix.length);
    ikmInfo.set(localRawPub, infoPrefix.length + receiverRawPub.byteLength);

    const authKey = await crypto.subtle.importKey('raw', receiverAuth, { name: 'HKDF' }, false, ['deriveBits']);
    const ikmBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(sharedSecret), info: ikmInfo }, authKey, 256);

    // PRK to CEK and Nonce
    const prkKey = await crypto.subtle.importKey('raw', ikmBits, { name: 'HKDF' }, false, ['deriveBits']);
    const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
    const cekBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: cekInfo }, prkKey, 128);

    const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
    const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: nonceInfo }, prkKey, 96);

    // AES-GCM Encrypt
    const cek = await crypto.subtle.importKey('raw', cekBits, { name: 'AES-GCM' }, false, ['encrypt']);
    
    // Padding record (0x02 delimiter)
    const record = new Uint8Array(plaintextBytes.length + 1);
    record.set(plaintextBytes, 0);
    record[plaintextBytes.length] = 2;

    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBits }, cek, record);

    // Header aes128gcm: salt (16) + rs (4) + idlen (1) + localPub (65) + ciphertext
    const rs = 4096;
    const body = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.byteLength);
    body.set(salt, 0);
    const view = new DataView(body.buffer);
    view.setUint32(16, rs, false);
    body[20] = 65;
    body.set(localRawPub, 21);
    body.set(new Uint8Array(ciphertext), 21 + 65);

    return body;
}

// Helpers
function base64UrlToUint8Array(base64Url) {
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        output[i] = raw.charCodeAt(i);
    }
    return output;
}

function uint8ArrayToBase64Url(uint8Array) {
    let binary = '';
    for (let i = 0; i < uint8Array.byteLength; i++) {
        binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashString(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return uint8ArrayToBase64Url(new Uint8Array(buf)).slice(0, 16);
}
