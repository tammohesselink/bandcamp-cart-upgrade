// Uploads the extension zip to the Chrome Web Store and submits it for review.
// Usage: node scripts/publish-chrome-web-store.mjs bandcamp-cart-player.zip
// Run by .github/workflows/publish.yml; see "Releasing" in the README for the one-time setup.
import { createSign } from 'crypto';
import { readFileSync } from 'fs';

const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const UPLOAD_POLL_INTERVAL_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

const zipPath = process.argv[2];
if (!zipPath) throw new Error('Usage: node scripts/publish-chrome-web-store.mjs <zip>');

const serviceAccountKey = JSON.parse(requireEnv('CHROME_WEB_STORE_SERVICE_ACCOUNT_KEY'));
const itemName = `publishers/${requireEnv('CHROME_WEB_STORE_PUBLISHER_ID')}/items/${requireEnv('CHROME_WEB_STORE_ITEM_ID')}`;

const accessToken = await fetchAccessToken();

console.log(`Uploading ${zipPath} to ${itemName}…`);
const upload = await callApi('POST', `/upload/v2/${itemName}:upload`, readFileSync(zipPath));
let uploadState = upload.uploadState;
const uploadDeadline = Date.now() + UPLOAD_TIMEOUT_MS;
while (uploadState === 'IN_PROGRESS') {
  if (Date.now() > uploadDeadline)
    throw new Error('Timed out waiting for the upload to be processed');
  await new Promise((resolve) => setTimeout(resolve, UPLOAD_POLL_INTERVAL_MS));
  uploadState = (await callApi('GET', `/v2/${itemName}:fetchStatus`)).lastAsyncUploadState;
}
if (uploadState !== 'SUCCEEDED') throw new Error(`Upload ended in state ${uploadState}`);
console.log(`Uploaded version ${upload.crxVersion ?? '(processed asynchronously)'}`);

// No body: the version goes live as soon as it passes review, with the rollout percentage
// that is set in the developer dashboard.
const publish = await callApi('POST', `/v2/${itemName}:publish`);
for (const warning of publish.warningInfo?.warnings ?? []) {
  console.warn(`Warning (${warning.reason}): ${warning.description}`);
}
console.log(`Submitted for review; item state is now ${publish.state}`);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// Exchanges a JWT signed with the service account's private key for an access token
// (https://developers.google.com/identity/protocols/oauth2/service-account#httprest).
async function fetchAccessToken() {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const claims = base64url({
    iss: serviceAccountKey.client_email,
    scope: SCOPE,
    aud: serviceAccountKey.token_uri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  });
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(serviceAccountKey.private_key, 'base64url');

  const response = await fetch(serviceAccountKey.token_uri, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Getting an access token failed (${response.status}): ${await response.text()}`
    );
  }
  return (await response.json()).access_token;
}

function base64url(json) {
  return Buffer.from(JSON.stringify(json)).toString('base64url');
}

async function callApi(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
    body,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}
