// Apps Script の .gs ファイルを Node で読み込むためのヘルパー（テスト専用）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function loadGas(files, extraGlobals = {}) {
  const context = vm.createContext({
    console,
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep: () => {},
    },
    ...extraGlobals,
  });
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8');
    vm.runInContext(code, context, { filename: f });
  }
  return context;
}

module.exports = { loadGas };
