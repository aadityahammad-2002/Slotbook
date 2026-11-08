// A dedicated E2E web server: never connects to the main development database.
// Run through Playwright's webServer hook, after compiling the application.
const main = process.env.DATABASE_URL;
const test = process.env.TEST_DATABASE_URL;
if (!main || !test) throw new Error('Main/test database URLs are required in .env');
let mainUrl, testUrl;
try {
  mainUrl = new URL(main);
  testUrl = new URL(test);
} catch {
  throw new Error('Invalid DATABASE_URL or TEST_DATABASE_URL in .env (credentials not shown)');
}
if (!['postgres:', 'postgresql:'].includes(testUrl.protocol) || !testUrl.hostname || !testUrl.username) {
  throw new Error('TEST_DATABASE_URL must be a PostgreSQL connection URL');
}
const mainName = decodeURIComponent(mainUrl.pathname.slice(1));
const testName = decodeURIComponent(testUrl.pathname.slice(1));
if (!testName.endsWith('_test') || !testName || testName === mainName || mainUrl.href === testUrl.href) {
  throw new Error('E2E SAFETY: TEST_DATABASE_URL must use a separate database ending in _test');
}
if (testName !== 'slotbook_ts_test') {
  throw new Error('E2E SAFETY: expected the dedicated slotbook_ts_test database');
}
process.env.DATABASE_URL = test;
process.env.EXPECTED_TEST_DATABASE_NAME = testName;
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.SLOTBOOK_E2E_PORT || '3101';
console.log(`E2E server targeting isolated database ${testName} on port ${process.env.PORT}`);
await import('../dist/server/src/index.js');
