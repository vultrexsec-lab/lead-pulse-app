/**
 * Patches baileys@7.0.0-rc14 for WhatsApp companion_reg_refresh pairing.
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

  // Ensure crypto import
  if (!src.includes("from 'crypto'") && !src.includes('from "crypto"')) {
    src = `import { randomBytes } from 'crypto';\n` + src;
  }

  // Need getBinaryNodeChild - import from WABinary if not present
  if (!src.includes('getBinaryNodeChild')) {
    src = src.replace(
      /import \{ randomBytes \} from 'crypto';/,
      `import { randomBytes } from 'crypto';\nimport { getBinaryNodeChild } from '../WABinary/index.js';`
    );
    if (!src.includes('getBinaryNodeChild')) {
      src = `import { getBinaryNodeChild } from '../WABinary/index.js';\n` + src;
    }
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

  // Expand import from Utils
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

  if (!src.includes(oldBlock)) {
    // try looser match
    if (!src.includes("ws.on('CB:iq,type:set,pair-device'")) {
      console.error('[patch-baileys] pair-device handler not found — baileys version mismatch');
      return false;
    }
    console.warn('[patch-baileys] exact block mismatch, trying regex replace');
    const re = /\/\/ QR gen\n\s*ws\.on\('CB:iq,type:set,pair-device', async \(stanza\) => \{[\s\S]*?genPairQR\(\);\n\s*\}\);/;
    if (!re.test(src)) {
      console.error('[patch-baileys] regex failed — cannot patch socket.js');
      return false;
    }
    src = src.replace(re, newBlock);
  } else {
    src = src.replace(oldBlock, newBlock);
  }

  fs.writeFileSync(file, src);
  console.log('[patch-baileys] patched socket.js');
  return true;
}

function main() {
  const root = findBaileysRoot();
  if (!root) {
    console.warn('[patch-baileys] baileys not installed — skip');
    process.exit(0);
  }
  console.log('[patch-baileys] patching', root);
  const ok1 = patchUtils(root);
  const ok2 = patchSocket(root);
  if (!ok1 || !ok2) {
    console.error('[patch-baileys] FAILED — QR linking may still break');
    process.exit(0); // don't fail install
  }
  console.log('[patch-baileys] OK — companion_reg_refresh enabled');
}

main();
