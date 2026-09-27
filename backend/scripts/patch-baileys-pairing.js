/**
 * Apply companion_reg_refresh fix to installed baileys.
 * Prefer copying vendored patched files (reliable on Render).
 */
const fs = require('fs');
const path = require('path');

function findBaileysRoot() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'baileys'),
    path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'lib', 'Socket', 'socket.js'))) return p;
  }
  return null;
}

function isPatched(root) {
  try {
    const socket = fs.readFileSync(path.join(root, 'lib', 'Socket', 'socket.js'), 'utf8');
    return socket.includes('companion_reg_refresh') && socket.includes('makePairingQRRenderer');
  } catch {
    return false;
  }
}

function copyVendored(root) {
  const vendor = path.join(__dirname, '..', 'patches', 'baileys-lib');
  const files = [
    ['Socket/socket.js', 'lib/Socket/socket.js'],
    ['Utils/companion-reg-client-utils.js', 'lib/Utils/companion-reg-client-utils.js'],
  ];
  for (const [fromRel, toRel] of files) {
    const from = path.join(vendor, fromRel);
    const to = path.join(root, toRel);
    if (!fs.existsSync(from)) {
      console.warn('[patch-baileys] missing vendor file', from);
      return false;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log('[patch-baileys] copied', toRel);
  }
  return true;
}

function ensurePatched() {
  const root = findBaileysRoot();
  if (!root) {
    console.warn('[patch-baileys] baileys not installed — skip');
    return false;
  }
  if (isPatched(root)) {
    console.log('[patch-baileys] already OK');
    return true;
  }
  console.log('[patch-baileys] applying vendored fix →', root);
  const ok = copyVendored(root);
  if (ok && isPatched(root)) {
    console.log('[patch-baileys] OK — companion_reg_refresh enabled');
    return true;
  }
  console.error('[patch-baileys] FAILED');
  return false;
}

if (require.main === module) {
  const ok = ensurePatched();
  process.exit(ok ? 0 : 0);
}

module.exports = { ensurePatched, isPatched, findBaileysRoot };
