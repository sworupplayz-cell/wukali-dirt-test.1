#!/usr/bin/env bash
# Installs the headless-Chromium toolkit used by tests/e2e.js into /tmp
# (kept outside the repo: ~80 MB of browser binaries).
set -e
mkdir -p /tmp/e2e
cd /tmp/e2e
[ -f package.json ] || npm init -y > /dev/null
npm install --no-audit --no-fund @sparticuz/chromium puppeteer-core > /dev/null
# Extract the bundled shared libraries (libnss3 etc.) chromium needs.
node -e "
const zlib = require('zlib'), fs = require('fs');
const src = '/tmp/e2e/node_modules/@sparticuz/chromium/bin/al2023.tar.br';
fs.writeFileSync('/tmp/al2023.tar', zlib.brotliDecompressSync(fs.readFileSync(src)));
"
mkdir -p /tmp/al2023lib
tar xf /tmp/al2023.tar -C /tmp/al2023lib
node -e "
const { createRequire } = require('module');
const req = createRequire('/tmp/e2e/x.js');
req('@sparticuz/chromium').default.executablePath().then((p) => console.log('chromium at', p));
"
echo "browser toolkit ready"
