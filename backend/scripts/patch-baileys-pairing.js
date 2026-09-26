/**
 * Patches baileys@7 for WhatsApp companion_reg_refresh pairing.
 * Without this, phones show: "Couldn't link device".
 * Based on WhiskeySockets/Baileys#2765
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
    const utils = fs.readFileSync(path.join(root, 'lib', 'Utils', 'companion-reg-client-utils.js'), 'utf8');
    return socket.includes('companion_reg_refresh') && utils.includes('handleCompanionRegRefresh');
  } catch {
    return false;
  }
}

function patchUtils(root) {
  const file = path.join(root, 'lib', 'Utils', 'companion-reg-client-utils.js');
  if (!fs.existsSync(file)) {
    console.warn('[patch-baileys] companion-reg-client-utils.js not found');
    return false;
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('handleCompanionRegRefresh')) {
    console.log('[patch-baileys] utils already patched');
    return true;
  }

  if (!src.includes("from 'crypto'") && !src.includes('from "crypto"')) {
    src = `import { randomBytes } from 'crypto';\n` + src;
  }
  if (!src.includes('getBinaryNodeChild')) {
    src = `import { getBinaryNodeChild } from '../WABinary/index.js';\n` + src;
  }

  const addition = `
export const makePairingQRRenderer = (refs, render) => {
    let index = 0;
    let current;
    return {
        next() {
            const ref = refs[index];
            if (ref === undefined) return false;
            index += 1;
            current = ref;
            render(ref);
            return true;
        },
        refresh() {
            if (current === undefined) return false;
            render(current);
            return true;
        }
    };
};

const COMPANION_REG_REFRESH_CHILDREN = ['companion_reg_refresh', 'pair-device-rotate-qr'];

export const handleCompanionRegRefresh = (node, { creds, emitCredsUpdate, refreshQR, logger }) => {
    if (!COMPANION_REG_REFRESH_CHILDREN.some(tag => getBinaryNodeChild(node, tag))) {
        logger?.warn?.({ node }, 'companion_reg_refresh carries neither expected child; ignoring');
        return 'ignored_malformed';
    }
    if (creds.me) {
        logger?.debug?.({ id: node.attrs.id }, 'companion_reg_refresh on registered session; keeping adv secret');
        return 'ignored_registered';
    }
    creds.advSecretKey = randomBytes(32).toString('base64');
    emitCredsUpdate({ advSecretKey: creds.advSecretKey });
    logger?.info?.({ id: node.attrs.id }, 'rotated adv secret; re-rendering pairing QR');
    refreshQR();
    return 'rotated';
};
`;

  src = src.replace(/\/\/# sourceMappingURL=.*$/m, '') + '\n' + addition + '\n';
  fs.writeFileSync(file, src);
  console.log('[patch-baileys] patched companion-reg-client-utils.js');
  return true;
}

function patchSocket(root) {
  const file = path.join(root, 'lib', 'Socket', 'socket.js');
  if (!fs.existsSync(file)) {
    console.warn('[patch-baileys] socket.js not found');
    return false;
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('companion_reg_refresh') && src.includes('makePairingQRRenderer')) {
    console.log('[patch-baileys] socket already patched');
    return true;
  }

  if (!src.includes('handleCompanionRegRefresh')) {
    src = src.replace(
      'buildPairingQRData,',
      'buildPairingQRData, handleCompanionRegRefresh, makePairingQRRenderer,'
    );
  }

  const oldBlock = `    // QR gen
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        const iq = {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'result',
                id: stanza.attrs.id
            }
        };
        await sendNode(iq);
        const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');
        const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const advB64 = creds.advSecretKey;
        let qrMs = qrTimeout || 60000; // time to let a QR live
        const genPairQR = () => {
            if (!ws.isOpen) {
                return;
            }
            const refNode = refNodes.shift();
            if (!refNode) {
                void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));
                return;
            }
            const ref = refNode.content.toString('utf-8');
            const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser);
            ev.emit('connection.update', { qr });
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000; // shorter subsequent qrs
        };
        genPairQR();
    });`;

  const newBlock = `    // QR gen (patched: companion_reg_refresh support)
    let refreshPairingQR;
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        const iq = {
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'result',
                id: stanza.attrs.id
            }
        };
        await sendNode(iq);
        const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device');
        const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const refs = refNodes.map((refNode) => refNode.content.toString('utf-8'));
        const renderer = makePairingQRRenderer(refs, (ref) => {
            const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser);
            ev.emit('connection.update', { qr });
        });
        refreshPairingQR = () => void renderer.refresh();
        let qrMs = qrTimeout || 60000;
        const genPairQR = () => {
            if (!ws.isOpen) {
                return;
            }
            if (!renderer.next()) {
                void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }));
                return;
            }
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000;
        };
        genPairQR();
    });
    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
        handleCompanionRegRefresh(node, {
            creds,
            emitCredsUpdate: (update) => ev.emit('creds.update', update),
            refreshQR: () => refreshPairingQR && refreshPairingQR(),
            logger
        });
    });`;

  if (src.includes(oldBlock)) {
    src = src.replace(oldBlock, newBlock);
  } else {
    const re = /\/\/ QR gen\n\s*ws\.on\('CB:iq,type:set,pair-device', async \(stanza\) => \{[\s\S]*?genPairQR\(\);\n\s*\}\);/;
    if (!re.test(src)) {
      console.error('[patch-baileys] pair-device handler not found — baileys version mismatch');
      return false;
    }
    src = src.replace(re, newBlock);
  }

  fs.writeFileSync(file, src);
  console.log('[patch-baileys] patched socket.js');
  return true;
}

function ensurePatched() {
  const root = findBaileysRoot();
  if (!root) {
    console.warn('[patch-baileys] baileys not installed — skip');
    return false;
  }
  if (isPatched(root)) {
    console.log('[patch-baileys] already OK:', root);
    return true;
  }
  console.log('[patch-baileys] patching', root);
  const ok1 = patchUtils(root);
  const ok2 = patchSocket(root);
  const done = ok1 && ok2 && isPatched(root);
  console.log(done ? '[patch-baileys] OK — companion_reg_refresh enabled' : '[patch-baileys] FAILED');
  return done;
}

if (require.main === module) {
  ensurePatched();
}

module.exports = { ensurePatched, isPatched, findBaileysRoot };
