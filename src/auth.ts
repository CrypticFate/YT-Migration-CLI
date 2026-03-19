import 'dotenv/config';
import { google } from 'googleapis';
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/oauth2callback';

const SCOPES = ['https://www.googleapis.com/auth/youtube'];

/**
 * Create a fresh OAuth2 client.
 */
export function createOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

/**
 * Get the path to the tokens file for a given account label.
 */
function tokensPath(label: 'source' | 'target'): string {
  return path.join(ROOT, `${label}_tokens.json`);
}

/**
 * Start a local HTTP server to intercept the OAuth2 callback,
 * waits for the authorization code, then shuts down.
 */
function waitForAuthCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost:${port}`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>✅ Authorization successful!</h1><p>You can close this tab.</p>');
          server.close();
          resolve(code);
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      } catch (err) {
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`  ↳ Listening on http://localhost:${port} for OAuth callback...`);
    });

    server.on('error', reject);
  });
}

/**
 * Run the full interactive OAuth flow for one account.
 * Opens a browser URL, waits for consent, saves tokens.
 */
export async function authenticateAccount(label: 'source' | 'target'): Promise<void> {
  const oauth2 = createOAuth2Client();

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent to always get a refresh_token
  });

  console.log(`\n🔑 Authenticate your ${label.toUpperCase()} YouTube account:`);
  console.log(`  ↳ Open this URL in your browser:\n`);
  console.log(`    ${authUrl}\n`);

  // Extract port from redirect URI
  const redirectUrl = new URL(REDIRECT_URI);
  const port = parseInt(redirectUrl.port, 10) || 3000;

  const code = await waitForAuthCode(port);

  const { tokens } = await oauth2.getToken(code);
  fs.writeFileSync(tokensPath(label), JSON.stringify(tokens, null, 2));

  console.log(`\n✅ Tokens saved to ${label}_tokens.json`);
}

/**
 * Load a previously-authenticated OAuth2 client.
 * Automatically refreshes expired access tokens using the stored refresh token.
 */
export async function getAuthClient(label: 'source' | 'target') {
  const tPath = tokensPath(label);

  if (!fs.existsSync(tPath)) {
    throw new Error(
      `No tokens found for "${label}" account. Run: npm run auth:${label}`
    );
  }

  const tokens = JSON.parse(fs.readFileSync(tPath, 'utf-8'));
  const oauth2 = createOAuth2Client();
  oauth2.setCredentials(tokens);

  // Set up automatic token refresh persistence
  oauth2.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(tPath, JSON.stringify(merged, null, 2));
    console.log(`  ↳ Refreshed ${label} tokens saved.`);
  });

  return oauth2;
}

// ── CLI entry point ──────────────────────────────────────────────
// Only run when this file is executed directly (not when imported)
const isDirectRun = process.argv[1]?.includes('auth');
if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args[0] === 'source' || args[0] === 'target') {
    authenticateAccount(args[0] as 'source' | 'target')
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Auth failed:', err);
        process.exit(1);
      });
  } else {
    console.error('Usage: tsx src/auth.ts <source|target>');
    process.exit(1);
  }
}
