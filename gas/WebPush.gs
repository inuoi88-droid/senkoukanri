/**
 * Web Push（RFC 8030 / 8291 / 8292）を Apps Script だけで送るための暗号処理。
 *
 * Apps Script には WebCrypto が無いので、次を純粋な JavaScript で実装しています。
 *   - SHA-256 / HMAC-SHA256
 *   - P-256 楕円曲線（鍵生成・ECDH・ECDSA 署名）
 *   - AES-128-GCM
 *   - VAPID（ES256 の JWT）と aes128gcm 形式のペイロード暗号化
 *
 * このファイルは編集不要です。Code.gs からは WebPush.send() などを呼びます。
 */
var WebPush = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // バイト列ユーティリティ（バイト列は 0〜255 の数値の配列で扱う）
  // ---------------------------------------------------------------------------

  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0x10000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function b64urlEncode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
      if (i + 2 < bytes.length) out += B64[n & 63];
    }
    return out;
  }

  function b64urlDecode(str) {
    var s = String(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=\s]/g, '');
    var out = [];
    var buf = 0;
    var bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s[i]);
      if (v < 0) throw new Error('base64url の形式が不正です');
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
      }
    }
    return out;
  }

  function concat() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      for (var j = 0; j < a.length; j++) out.push(a[j]);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // SHA-256 / HMAC-SHA256
  // ---------------------------------------------------------------------------

  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256(bytes) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var len = bytes.length;
    var msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var bitLenHi = Math.floor((len * 8) / 0x100000000);
    var bitLenLo = (len * 8) >>> 0;
    msg.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff);
    msg.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);

    var w = new Array(64);
    for (var off = 0; off < msg.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        var j = off + i * 4;
        w[i] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) | 0;
      }
      for (i = 16; i < 64; i++) {
        var x = w[i - 15];
        var y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    var out = [];
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function (v) {
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    });
    return out;
  }

  function hmacSha256(key, data) {
    var k = key.length > 64 ? sha256(key) : key.slice();
    while (k.length < 64) k.push(0);
    var ipad = k.map(function (b) { return b ^ 0x36; });
    var opad = k.map(function (b) { return b ^ 0x5c; });
    return sha256(concat(opad, sha256(concat(ipad, data))));
  }

  // ---------------------------------------------------------------------------
  // 乱数（Apps Script では Utilities.getUuid() の暗号論的乱数を SHA-256 で圧縮して使う）
  // ---------------------------------------------------------------------------

  var randomSource = null; // テスト用に差し替え可能

  function randomBytes(n) {
    if (randomSource) return randomSource(n);
    var out = [];
    var counter = 0;
    while (out.length < n) {
      var seed = String(Date.now()) + ':' + counter++;
      for (var i = 0; i < 4; i++) {
        seed += ':' + (typeof Utilities !== 'undefined' ? Utilities.getUuid() : '') + ':' + Math.random();
      }
      out = out.concat(sha256(utf8Encode(seed)));
    }
    return out.slice(0, n);
  }

  // ---------------------------------------------------------------------------
  // P-256 楕円曲線（BigInt を使用。リテラル 0n は使わず BigInt() で生成）
  // ---------------------------------------------------------------------------

  var C = null;

  function curve() {
    if (C) return C;
    if (typeof BigInt !== 'function') {
      throw new Error('この実行環境は BigInt に対応していません（Apps Script の V8 ランタイムを有効にしてください）');
    }
    C = {
      p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
      n: BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
      b: BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b'),
      gx: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
      gy: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
      _0: BigInt(0),
      _1: BigInt(1),
      _2: BigInt(2),
      _3: BigInt(3),
      _4: BigInt(4),
      _8: BigInt(8),
      _255: BigInt(255),
      _256: BigInt(256)
    };
    return C;
  }

  function mod(a, m) {
    var r = a % m;
    return r < C._0 ? r + m : r;
  }

  function modInv(a, m) {
    var lm = C._1, hm = C._0;
    var low = mod(a, m), high = m;
    while (low > C._1) {
      var r = high / low;
      var nm = hm - lm * r;
      var nw = high - low * r;
      hm = lm; high = low; lm = nm; low = nw;
    }
    return mod(lm, m);
  }

  function bytesToBig(bytes) {
    var x = C._0;
    for (var i = 0; i < bytes.length; i++) x = x * C._256 + BigInt(bytes[i]);
    return x;
  }

  function bigToBytes(x, len) {
    var out = new Array(len);
    for (var i = len - 1; i >= 0; i--) {
      out[i] = Number(x & C._255);
      x = x / C._256;
    }
    return out;
  }

  // ヤコビアン座標 {x, y, z}。z = 0 は無限遠点。a = -3 の公式を使用。
  function jDouble(P) {
    var p = C.p;
    if (P.z === C._0 || P.y === C._0) return { x: C._0, y: C._1, z: C._0 };
    var delta = mod(P.z * P.z, p);
    var gamma = mod(P.y * P.y, p);
    var beta = mod(P.x * gamma, p);
    var alpha = mod(C._3 * (P.x - delta) * (P.x + delta), p);
    var x3 = mod(alpha * alpha - C._8 * beta, p);
    var z3 = mod((P.y + P.z) * (P.y + P.z) - gamma - delta, p);
    var y3 = mod(alpha * (C._4 * beta - x3) - C._8 * gamma * gamma, p);
    return { x: x3, y: y3, z: z3 };
  }

  function jAdd(P, Q) {
    var p = C.p;
    if (P.z === C._0) return Q;
    if (Q.z === C._0) return P;
    var z1z1 = mod(P.z * P.z, p);
    var z2z2 = mod(Q.z * Q.z, p);
    var u1 = mod(P.x * z2z2, p);
    var u2 = mod(Q.x * z1z1, p);
    var s1 = mod(P.y * Q.z * z2z2, p);
    var s2 = mod(Q.y * P.z * z1z1, p);
    var h = mod(u2 - u1, p);
    var r = mod(C._2 * (s2 - s1), p);
    if (h === C._0) {
      return r === C._0 ? jDouble(P) : { x: C._0, y: C._1, z: C._0 };
    }
    var i = mod(C._4 * h * h, p);
    var j = mod(h * i, p);
    var v = mod(u1 * i, p);
    var x3 = mod(r * r - j - C._2 * v, p);
    var y3 = mod(r * (v - x3) - C._2 * s1 * j, p);
    var z3 = mod(((P.z + Q.z) * (P.z + Q.z) - z1z1 - z2z2) * h, p);
    return { x: x3, y: y3, z: z3 };
  }

  function scalarMult(k, point) {
    var R = { x: C._0, y: C._1, z: C._0 };
    var Q = { x: point.x, y: point.y, z: C._1 };
    var bits = k.toString(2);
    for (var i = 0; i < bits.length; i++) {
      R = jDouble(R);
      if (bits[i] === '1') R = jAdd(R, Q);
    }
    if (R.z === C._0) throw new Error('無限遠点になりました');
    var zinv = modInv(R.z, C.p);
    var zinv2 = mod(zinv * zinv, C.p);
    return { x: mod(R.x * zinv2, C.p), y: mod(R.y * zinv2 * zinv, C.p) };
  }

  function isOnCurve(P) {
    var p = C.p;
    if (P.x < C._0 || P.x >= p || P.y < C._0 || P.y >= p) return false;
    var lhs = mod(P.y * P.y, p);
    var rhs = mod(P.x * P.x * P.x - C._3 * P.x + C.b, p);
    return lhs === rhs;
  }

  function decodePoint(bytes) {
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('P-256 公開鍵の形式が不正です');
    var P = { x: bytesToBig(bytes.slice(1, 33)), y: bytesToBig(bytes.slice(33, 65)) };
    if (!isOnCurve(P)) throw new Error('P-256 公開鍵が曲線上にありません');
    return P;
  }

  function encodePoint(P) {
    return concat([4], bigToBytes(P.x, 32), bigToBytes(P.y, 32));
  }

  function G() {
    return { x: C.gx, y: C.gy };
  }

  /** 鍵ペアを作る。{ privateKey: 32byte, publicKey: 65byte(非圧縮) } */
  function generateKeyPair() {
    curve();
    var d;
    do {
      d = bytesToBig(randomBytes(32));
    } while (d === C._0 || d >= C.n);
    return { privateKey: bigToBytes(d, 32), publicKey: encodePoint(scalarMult(d, G())) };
  }

  function publicKeyFromPrivate(privateKey) {
    curve();
    return encodePoint(scalarMult(bytesToBig(privateKey), G()));
  }

  function ecdh(privateKey, publicKey) {
    curve();
    var P = decodePoint(publicKey);
    return bigToBytes(scalarMult(bytesToBig(privateKey), P).x, 32);
  }

  /** ECDSA P-256 / SHA-256 署名（RFC 6979 の決定的 k）。r||s の 64 バイトを返す。 */
  function ecdsaSign(privateKey, message) {
    curve();
    var n = C.n;
    var x = bytesToBig(privateKey);
    var h1 = sha256(message);
    var z = bytesToBig(h1);
    var h1Octets = bigToBytes(mod(z, n), 32);
    var xOctets = bigToBytes(x, 32);
    var V = [];
    var K = [];
    for (var i = 0; i < 32; i++) { V.push(1); K.push(0); }
    K = hmacSha256(K, concat(V, [0], xOctets, h1Octets));
    V = hmacSha256(K, V);
    K = hmacSha256(K, concat(V, [1], xOctets, h1Octets));
    V = hmacSha256(K, V);
    for (var guard = 0; guard < 1000; guard++) {
      V = hmacSha256(K, V);
      var k = bytesToBig(V);
      if (k > C._0 && k < n) {
        var r = mod(scalarMult(k, G()).x, n);
        if (r !== C._0) {
          var s = mod(modInv(k, n) * (z + r * x), n);
          if (s !== C._0) return concat(bigToBytes(r, 32), bigToBytes(s, 32));
        }
      }
      K = hmacSha256(K, concat(V, [0]));
      V = hmacSha256(K, V);
    }
    throw new Error('署名に失敗しました');
  }

  // ---------------------------------------------------------------------------
  // AES-128-GCM
  // ---------------------------------------------------------------------------

  var SBOX = null;

  function initSbox() {
    if (SBOX) return;
    SBOX = new Array(256);
    var p = 1, q = 1;
    // GF(2^8) の生成元 3 を使って逆元表を作り、アフィン変換を適用する
    do {
      p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
      q ^= q << 1;
      q ^= q << 2;
      q ^= q << 4;
      q &= 0xff;
      if (q & 0x80) q ^= 0x09;
      var xf = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
      SBOX[p] = (xf ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
  }

  function rotl8(x, s) {
    return ((x << s) | (x >> (8 - s))) & 0xff;
  }

  function xtime(b) {
    return ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
  }

  function aesExpandKey(key) {
    initSbox();
    var w = key.slice();
    var rcon = 1;
    for (var i = 16; i < 176; i += 4) {
      var t = w.slice(i - 4, i);
      if (i % 16 === 0) {
        t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
        rcon = xtime(rcon);
      }
      for (var j = 0; j < 4; j++) w.push(w[i - 16 + j] ^ t[j]);
    }
    return w;
  }

  function aesEncryptBlock(w, input) {
    var s = input.slice();
    var i, r, c;
    for (i = 0; i < 16; i++) s[i] ^= w[i];
    for (r = 1; r <= 10; r++) {
      for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      // ShiftRows（状態は列優先: s[row + 4*col]）
      var t = s.slice();
      for (var row = 1; row < 4; row++) {
        for (c = 0; c < 4; c++) s[row + 4 * c] = t[row + 4 * ((c + row) % 4)];
      }
      if (r !== 10) {
        for (c = 0; c < 4; c++) {
          var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
          var all = a0 ^ a1 ^ a2 ^ a3;
          s[4 * c] ^= all ^ xtime(a0 ^ a1);
          s[4 * c + 1] ^= all ^ xtime(a1 ^ a2);
          s[4 * c + 2] ^= all ^ xtime(a2 ^ a3);
          s[4 * c + 3] ^= all ^ xtime(a3 ^ a0);
        }
      }
      for (i = 0; i < 16; i++) s[i] ^= w[16 * r + i];
    }
    return s;
  }

  function gfMul(X, Y) {
    var R = BigInt('0xe1') << BigInt(120);
    var Z = C._0;
    var V = Y;
    for (var i = 127; i >= 0; i--) {
      if ((X >> BigInt(i)) & C._1) Z ^= V;
      V = V & C._1 ? (V >> C._1) ^ R : V >> C._1;
    }
    return Z;
  }

  function inc32(block) {
    var b = block.slice();
    for (var i = 15; i >= 12; i--) {
      b[i] = (b[i] + 1) & 0xff;
      if (b[i] !== 0) break;
    }
    return b;
  }

  /** AES-128-GCM 暗号化（AAD なし・IV 96bit）。暗号文 || タグ(16byte) を返す。 */
  function aesGcmEncrypt(key, iv, plaintext) {
    curve();
    var w = aesExpandKey(key);
    var H = bytesToBig(aesEncryptBlock(w, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    var j0 = concat(iv, [0, 0, 0, 1]);
    var ctr = j0;
    var ct = [];
    for (var off = 0; off < plaintext.length; off += 16) {
      ctr = inc32(ctr);
      var ks = aesEncryptBlock(w, ctr);
      var end = Math.min(16, plaintext.length - off);
      for (var i = 0; i < end; i++) ct.push(plaintext[off + i] ^ ks[i]);
    }
    var Y = C._0;
    for (off = 0; off < ct.length; off += 16) {
      var blk = ct.slice(off, off + 16);
      while (blk.length < 16) blk.push(0);
      Y = gfMul(Y ^ bytesToBig(blk), H);
    }
    var lenBlock = concat([0, 0, 0, 0, 0, 0, 0, 0], bigToBytes(BigInt(ct.length * 8), 8));
    Y = gfMul(Y ^ bytesToBig(lenBlock), H);
    var tagMask = aesEncryptBlock(w, j0);
    var S = bigToBytes(Y, 16);
    var tag = [];
    for (i = 0; i < 16; i++) tag.push(S[i] ^ tagMask[i]);
    return concat(ct, tag);
  }

  // ---------------------------------------------------------------------------
  // Web Push のペイロード暗号化（RFC 8291 / aes128gcm）
  // ---------------------------------------------------------------------------

  var RECORD_SIZE = 4096;

  /**
   * @param {string|number[]} payload 平文
   * @param {string} p256dh 購読の keys.p256dh（base64url）
   * @param {string} auth 購読の keys.auth（base64url）
   * @param {Object=} opt_fixed テスト用 { privateKey, salt }
   * @return {number[]} リクエストボディ
   */
  function encryptPayload(payload, p256dh, auth, opt_fixed) {
    var plaintext = typeof payload === 'string' ? utf8Encode(payload) : payload;
    if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error('通知の本文が長すぎます');
    var uaPublic = b64urlDecode(p256dh);
    var authSecret = b64urlDecode(auth);
    var kp = opt_fixed && opt_fixed.privateKey
      ? { privateKey: opt_fixed.privateKey, publicKey: publicKeyFromPrivate(opt_fixed.privateKey) }
      : generateKeyPair();
    var asPrivate = kp.privateKey;
    var asPublic = kp.publicKey;
    var salt = opt_fixed && opt_fixed.salt ? opt_fixed.salt : randomBytes(16);

    var ecdhSecret = ecdh(asPrivate, uaPublic);
    var prkKey = hmacSha256(authSecret, ecdhSecret);
    var keyInfo = concat(utf8Encode('WebPush: info'), [0], uaPublic, asPublic);
    var ikm = hmacSha256(prkKey, concat(keyInfo, [1]));
    var prk = hmacSha256(salt, ikm);
    var cek = hmacSha256(prk, concat(utf8Encode('Content-Encoding: aes128gcm'), [0, 1])).slice(0, 16);
    var nonce = hmacSha256(prk, concat(utf8Encode('Content-Encoding: nonce'), [0, 1])).slice(0, 12);

    var ciphertext = aesGcmEncrypt(cek, nonce, concat(plaintext, [2]));
    var header = concat(salt, [0, 0, (RECORD_SIZE >> 8) & 0xff, RECORD_SIZE & 0xff], [asPublic.length], asPublic);
    return concat(header, ciphertext);
  }

  // ---------------------------------------------------------------------------
  // VAPID（RFC 8292）
  // ---------------------------------------------------------------------------

  function vapidAuthorization(endpoint, subject, vapidPublicKey, vapidPrivateKey, nowSec) {
    var m = String(endpoint).match(/^(https:\/\/[^\/]+)/);
    if (!m) throw new Error('購読の endpoint が不正です');
    var header = b64urlEncode(utf8Encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    var claims = b64urlEncode(utf8Encode(JSON.stringify({
      aud: m[1],
      exp: Math.floor(nowSec || Date.now() / 1000) + 12 * 3600,
      sub: subject
    })));
    var signingInput = header + '.' + claims;
    var sig = ecdsaSign(b64urlDecode(vapidPrivateKey), utf8Encode(signingInput));
    var jwt = signingInput + '.' + b64urlEncode(sig);
    return 'vapid t=' + jwt + ', k=' + vapidPublicKey;
  }

  /** VAPID 鍵を作る。{ publicKey, privateKey } はどちらも base64url 文字列。 */
  function generateVapidKeys() {
    var kp = generateKeyPair();
    return { publicKey: b64urlEncode(kp.publicKey), privateKey: b64urlEncode(kp.privateKey) };
  }

  /**
   * 送信リクエストを組み立てる（UrlFetchApp に渡す前の形）。
   * @param {{endpoint:string, keys:{p256dh:string, auth:string}}} subscription
   * @param {Object} message JSON にして送る内容
   * @param {{publicKey:string, privateKey:string, subject:string}} vapid
   */
  function buildRequest(subscription, message, vapid, options) {
    options = options || {};
    var body = encryptPayload(JSON.stringify(message), subscription.keys.p256dh, subscription.keys.auth);
    return {
      url: subscription.endpoint,
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey),
        TTL: String(options.ttl || 43200),
        Urgency: options.urgency || 'high',
        'Content-Encoding': 'aes128gcm'
      },
      body: body
    };
  }

  /**
   * 1 台の端末へ通知を送る（Apps Script 専用）。
   * @return {{status:number, body:string}}
   */
  function send(subscription, message, vapid, options) {
    var req = buildRequest(subscription, message, vapid, options);
    var signed = req.body.map(function (b) { return b > 127 ? b - 256 : b; });
    var res = UrlFetchApp.fetch(req.url, {
      method: 'post',
      contentType: 'application/octet-stream',
      headers: req.headers,
      payload: Utilities.newBlob(signed, 'application/octet-stream'),
      muteHttpExceptions: true
    });
    return { status: res.getResponseCode(), body: res.getContentText() };
  }

  return {
    send: send,
    buildRequest: buildRequest,
    generateVapidKeys: generateVapidKeys,
    // 以下はテスト・内部用
    _: {
      utf8Encode: utf8Encode,
      b64urlEncode: b64urlEncode,
      b64urlDecode: b64urlDecode,
      sha256: sha256,
      hmacSha256: hmacSha256,
      generateKeyPair: generateKeyPair,
      publicKeyFromPrivate: publicKeyFromPrivate,
      ecdh: ecdh,
      ecdsaSign: ecdsaSign,
      aesGcmEncrypt: aesGcmEncrypt,
      encryptPayload: encryptPayload,
      vapidAuthorization: vapidAuthorization,
      setRandomSource: function (fn) { randomSource = fn; }
    }
  };
})();
