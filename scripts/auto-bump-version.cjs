const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'index.html');
const swPath = path.join(rootDir, 'sw.js');

// 1. Dapatkan tanggal hari ini dalam format WIB (Asia/Jakarta, UTC+7)
const now = new Date();
const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});
const [fullYear, month, day] = formatter.format(now).split('-');
const todayDateStr = `${fullYear.slice(2)}.${month}.${day}`; // contoh: '26.10.01'
const todayPrefix = `v${todayDateStr}`;

// 2. Baca versi saat ini dari index.html
let indexHtml = fs.readFileSync(indexPath, 'utf8');
const versionMatch = indexHtml.match(/id="appVersionBadge"[^>]*>v(\d{2}\.\d{2}\.\d{2})\.(\d+)<\/span>/);

let nextRevision = 1;
if (versionMatch) {
    const existingDate = versionMatch[1];
    const existingRev = parseInt(versionMatch[2], 10);
    if (existingDate === todayDateStr) {
        nextRevision = existingRev + 1;
    } else {
        nextRevision = 1;
    }
}

const newVersion = `${todayPrefix}.${nextRevision}`;

// 3. Buat timestamp untuk cache buster (YYYYMMDDHHmmss)
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
});
const [hour, min, sec] = timeFormatter.format(now).split(':');
const cacheBuster = `${fullYear}${month}${day}${hour}${min}${sec}`;

// 4. Update index.html (badge versi & query buster asset)
indexHtml = indexHtml.replace(
    /(<span id="appVersionBadge"[^>]*>)[^<]*(<\/span>)/,
    `$1${newVersion}$2`
);

const assets = ['tailwind.css', 'style.css', 'script.js'];
for (const asset of assets) {
    const regex = new RegExp(`(${asset.replace('.', '\\.')}\\?v=)[^"']*`, 'g');
    indexHtml = indexHtml.replace(regex, `$1${cacheBuster}`);
}
fs.writeFileSync(indexPath, indexHtml, 'utf8');

// 5. Update sw.js cache name
if (fs.existsSync(swPath)) {
    let swContent = fs.readFileSync(swPath, 'utf8');
    swContent = swContent.replace(
        /const CACHE_NAME = ['"][^'"]*['"];/,
        `const CACHE_NAME = 'pantau-treasury-${newVersion}';`
    );
    fs.writeFileSync(swPath, swContent, 'utf8');
}

console.log(`[PantauTreasury] Auto-bumped version: ${newVersion} (Cache-buster: ${cacheBuster})`);
