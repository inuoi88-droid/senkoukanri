// WebPush.gs の暗号処理を Node の crypto / web-push ライブラリと突き合わせて検証する
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadGas } = require('./load-gas');

const ctx = loadGas(['WebPush.gs']);
const WP = ctx.WebPush;
const _ = WP._;
const toBuf = (a) => Buffer.from(a);
const fromBuf = (b) => Array.from(b);

let ece = null;
try {
  ece = require('http_ece');
} catch (e) {
  // http_ece が無ければその検証だけ省略
}

test('sha256 / hmac は Node と一致', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 200, 1000]) {
    const data = crypto.randomBytes(len);
    assert.deepStrictEqual(toBuf(_.sha256(fromBuf(data))), crypto.createHash('sha256').update(data).digest());
    const key = crypto.randomBytes(len % 100 + 1);
    assert.deepStrictEqual(
      toBuf(_.hmacSha256(fromBuf(key), fromBuf(data))),
      crypto.createHmac('sha256', key).update(data).digest()
    );
  }
  const long = crypto.randomBytes(100);
  assert.deepStrictEqual(
    toBuf(_.hmacSha256(fromBuf(long), [1, 2, 3])),
    crypto.createHmac('sha256', long).update(Buffer.from([1, 2, 3])).digest()
  );
});

test('utf8 / base64url', () => {
  const s = 'IBM 三次面接 📩 のご案内';
  assert.deepStrictEqual(toBuf(_.utf8Encode(s)), Buffer.from(s, 'utf8'));
  for (let len = 0; len < 40; len++) {
    const b = crypto.randomBytes(len);
    const enc = _.b64urlEncode(fromBuf(b));
    assert.strictEqual(enc, b.toString('base64url'));
    assert.deepStrictEqual(toBuf(_.b64urlDecode(enc)), b);
  }
});

test('公開鍵の導出と ECDH は Node と一致', () => {
  for (let i = 0; i < 5; i++) {
    const a = crypto.createECDH('prime256v1');
    a.generateKeys();
    const b = crypto.createECDH('prime256v1');
    b.generateKeys();
    assert.deepStrictEqual(toBuf(_.publicKeyFromPrivate(fromBuf(a.getPrivateKey()))), a.getPublicKey());
    assert.deepStrictEqual(
      toBuf(_.ecdh(fromBuf(a.getPrivateKey()), fromBuf(b.getPublicKey()))),
      a.computeSecret(b.getPublicKey())
    );
  }
});

test('generateKeyPair の鍵は Node でも有効', () => {
  const kp = _.generateKeyPair();
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(toBuf(kp.privateKey));
  assert.deepStrictEqual(e.getPublicKey(), toBuf(kp.publicKey));
});

test('ECDSA 署名は Node で検証できる', () => {
  for (let i = 0; i < 5; i++) {
    const kp = _.generateKeyPair();
    const msg = crypto.randomBytes(50 + i);
    const sig = toBuf(_.ecdsaSign(kp.privateKey, fromBuf(msg)));
    assert.strictEqual(sig.length, 64);
    const pub = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: toBuf(kp.publicKey.slice(1, 33)).toString('base64url'), y: toBuf(kp.publicKey.slice(33)).toString('base64url') },
      format: 'jwk',
    });
    assert.ok(crypto.verify('sha256', msg, { key: pub, dsaEncoding: 'ieee-p1363' }, sig));
  }
});

test('ECDSA は RFC 6979 A.2.5 のテストベクタと一致', () => {
  const priv = Buffer.from('C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721', 'hex');
  const sig = toBuf(_.ecdsaSign(fromBuf(priv), _.utf8Encode('sample'))).toString('hex').toUpperCase();
  assert.strictEqual(
    sig,
    'EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716' +
      'F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8'
  );
});

test('AES-128-GCM は Node と一致', () => {
  for (const len of [0, 1, 15, 16, 17, 100, 333]) {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const pt = crypto.randomBytes(len);
    const c = crypto.createCipheriv('aes-128-gcm', key, iv);
    const expected = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    assert.deepStrictEqual(toBuf(_.aesGcmEncrypt(fromBuf(key), fromBuf(iv), fromBuf(pt))), expected);
  }
});

function makeSubscription() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ua,
    auth,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def',
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  };
}

// RFC 8291 の手順どおりに Node の crypto で復号する
function decryptRfc8291(body, ua, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  assert.strictEqual(rs, 4096);
  const ecdhSecret = ua.computeSecret(asPublic);
  const prkKey = crypto.createHmac('sha256', auth).update(ecdhSecret).digest();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = crypto.createHmac('sha256', prkKey).update(Buffer.concat([keyInfo, Buffer.from([1])])).digest();
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const cek = crypto.createHmac('sha256', prk).update(Buffer.from('Content-Encoding: aes128gcm\0\x01')).digest().subarray(0, 16);
  const nonce = crypto.createHmac('sha256', prk).update(Buffer.from('Content-Encoding: nonce\0\x01')).digest().subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(pt[pt.length - 1], 2, '最後のレコード区切りは 0x02');
  return pt.subarray(0, pt.length - 1).toString('utf8');
}

test('暗号化したペイロードを RFC 8291 の手順で復号できる', () => {
  const { ua, auth, subscription } = makeSubscription();
  const msg = JSON.stringify({ title: '⏰ 1時間後: IBM 三次面接', body: '10/15(水) 14:00〜 Zoom' });
  const body = toBuf(_.encryptPayload(msg, subscription.keys.p256dh, subscription.keys.auth));
  assert.strictEqual(decryptRfc8291(body, ua, auth), msg);
});

test('http_ece（web-push が使うライブラリ）でも復号できる', { skip: !ece }, () => {
  const { ua, auth, subscription } = makeSubscription();
  const msg = JSON.stringify({ title: 'テスト', body: 'あいうえお'.repeat(50) });
  const body = toBuf(_.encryptPayload(msg, subscription.keys.p256dh, subscription.keys.auth));
  const out = ece.decrypt(body, { version: 'aes128gcm', privateKey: ua, authSecret: auth });
  assert.strictEqual(out.toString('utf8'), msg);
});

test('固定の鍵・salt では http_ece の暗号化結果とバイト単位で一致', { skip: !ece }, () => {
  const { ua, auth, subscription } = makeSubscription();
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const salt = crypto.randomBytes(16);
  const msg = 'When I grow up, I want to be a watermelon';
  const mine = toBuf(_.encryptPayload(msg, subscription.keys.p256dh, subscription.keys.auth, {
    privateKey: fromBuf(as.getPrivateKey()),
    salt: fromBuf(salt),
  }));
  const ref = ece.encrypt(Buffer.from(msg), {
    version: 'aes128gcm',
    privateKey: as,
    dh: ua.getPublicKey(),
    authSecret: auth,
    salt,
    rs: 4096,
  });
  assert.deepStrictEqual(mine, ref);
});

test('VAPID の JWT は ES256 として検証でき、aud/exp/sub が正しい', () => {
  const keys = WP.generateVapidKeys();
  const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH-abc';
  const auth = _.vapidAuthorization(endpoint, 'mailto:test@example.com', keys.publicKey, keys.privateKey, 1_800_000_000);
  const m = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.strictEqual(m[2], keys.publicKey);
  const [h, c, s] = m[1].split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepStrictEqual(claims, { aud: 'https://web.push.apple.com', exp: 1_800_000_000 + 43200, sub: 'mailto:test@example.com' });
  const pubBytes = Buffer.from(keys.publicKey, 'base64url');
  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pubBytes.subarray(1, 33).toString('base64url'), y: pubBytes.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('buildRequest は必要なヘッダーを付ける', () => {
  const { ua, auth, subscription } = makeSubscription();
  const keys = WP.generateVapidKeys();
  const req = WP.buildRequest(subscription, { title: 't' }, { ...keys, subject: 'mailto:a@example.com' });
  assert.strictEqual(req.url, subscription.endpoint);
  assert.strictEqual(req.headers['Content-Encoding'], 'aes128gcm');
  assert.strictEqual(req.headers.TTL, '43200');
  assert.match(req.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.strictEqual(decryptRfc8291(toBuf(req.body), ua, auth), JSON.stringify({ title: 't' }));
});
