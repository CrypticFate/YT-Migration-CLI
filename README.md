# YT Migration CLI

A Node.js/TypeScript CLI tool to migrate your YouTube account — **subscriptions**, **liked videos**, and **playlists** — from one Google account to another using the YouTube Data API v3.

Built for incremental, resumable execution. Progress is tracked in a local SQLite database, so the tool picks up exactly where it left off across multiple runs.

## Why?

YouTube has no built-in account migration feature. If you're switching Google accounts, you'd have to manually re-subscribe to every channel, re-like every video, and recreate every playlist. This tool automates that.

> **Note:** Watch history cannot be migrated — Google deprecated that API for privacy reasons.

## Prerequisites

- **Node.js** v18+
- A **Google Cloud** project with the YouTube Data API v3 enabled
- An **OAuth 2.0 Client ID** (Desktop or Web application type)

## Setup

### 1. Google Cloud Configuration

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
2. Enable the **YouTube Data API v3** under APIs & Services → Library
3. Configure the **OAuth consent screen** (External) and add both your YouTube accounts as test users
4. Create an **OAuth Client ID** under Credentials → Create Credentials
5. Add `http://localhost:3000/oauth2callback` as an Authorized redirect URI

### 2. Install & Configure

```bash
git clone https://github.com/CrypticFate/YT-Migration-CLI.git
cd YT-Migration-CLI
npm install
```

Create a `.env` file in the project root:

```env
CLIENT_ID=your-client-id.apps.googleusercontent.com
CLIENT_SECRET=your-client-secret
REDIRECT_URI=http://localhost:3000/oauth2callback
DAILY_QUOTA_LIMIT=9500
```

### 3. Authenticate Both Accounts

```bash
# Log into your SOURCE (old) YouTube account
npm run auth:source

# Log into your TARGET (new) YouTube account
npm run auth:target
```

Each command prints a URL — open it in your browser, grant access, and the tokens are saved locally.

## Usage

### Migrate Everything

```bash
npm run migrate
```

### Migrate Selectively

```bash
npm run migrate:subs       # Subscriptions only
npm run migrate:likes      # Liked videos only
npm run migrate:playlists  # Playlists only
```

### Preview Without Writing

```bash
npx tsx src/migrate.ts --all --dry-run
```

### Combine Flags

```bash
npx tsx src/migrate.ts --subscriptions --likes --dry-run
```

## Quota & Multi-Day Execution

YouTube's API has a **10,000 unit/day** quota. Write operations cost **50 units** each, allowing ~200 writes per day.

| Operation | Cost |
|---|---|
| Read (list, get) | 1 unit |
| Write (subscribe, like, add to playlist) | 50 units |

For accounts with hundreds of subscriptions/likes, the tool will hit the daily limit and halt gracefully. Just re-run it the next day — the SQLite ledger ensures nothing is repeated.

### Automate with Cron

```bash
# Run daily at 6 AM until migration is complete
crontab -e
0 6 * * * cd /path/to/YT-Migration-CLI && npx tsx src/migrate.ts --all >> migration.log 2>&1
```

## Project Structure

```
├── src/
│   ├── auth.ts                   # OAuth 2.0 dual-account authentication
│   ├── ledger.ts                 # SQLite state management (migration.db)
│   ├── quota.ts                  # API quota tracking + exponential backoff
│   ├── migrate-subscriptions.ts  # Subscriptions fetch & push
│   ├── migrate-likes.ts          # Liked videos fetch & push
│   ├── migrate-playlists.ts      # Playlists + items fetch & push
│   └── migrate.ts                # CLI entry point / orchestrator
├── .env                          # OAuth credentials (not committed)
├── migration.db                  # SQLite ledger (created at runtime)
├── source_tokens.json            # Source account tokens (not committed)
├── target_tokens.json            # Target account tokens (not committed)
└── context.md                    # Detailed architecture documentation
```

## How It Works

1. **Authenticate** both YouTube accounts via OAuth 2.0 (one-time)
2. **Fetch** all items from the source account (cheap reads — 1 unit each)
3. **Push** items to the target account (expensive writes — 50 units each)
4. **Track** every item's status (`pending` / `done` / `error`) in SQLite
5. **Resume** on next run — skips completed items, retries from where it stopped

## Available Scripts

| Script | Description |
|---|---|
| `npm run auth:source` | Authenticate source YouTube account |
| `npm run auth:target` | Authenticate target YouTube account |
| `npm run migrate` | Migrate everything (subs + likes + playlists) |
| `npm run migrate:subs` | Migrate subscriptions only |
| `npm run migrate:likes` | Migrate liked videos only |
| `npm run migrate:playlists` | Migrate playlists only |
| `npm run build` | Compile TypeScript to `dist/` |

## License

MIT
