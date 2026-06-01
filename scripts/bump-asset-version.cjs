const fs = require('fs');
const path = require('path');

const indexPath = path.resolve(__dirname, '..', 'index.html');
const version = new Date()
  .toISOString()
  .replace(/\D/g, '')
  .slice(0, 14);

const assets = ['tailwind.css', 'style.css', 'script.js'];
let html = fs.readFileSync(indexPath, 'utf8');

for (const asset of assets) {
  const pattern = new RegExp(`${asset.replace('.', '\\.')}(?:\\?v=[^"']*)?`, 'g');
  html = html.replace(pattern, `${asset}?v=${version}`);
}

fs.writeFileSync(indexPath, html);
console.log(`Asset version bumped to ${version}`);
