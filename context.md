# YouTube Migration Pipeline — Project Context

## Purpose

CLI tool that migrates **subscriptions**, **liked videos**, and **playlists** from a source YouTube account to a target YouTube account via the YouTube Data API v3. Designed for incremental, resumable execution over multiple days due to API quota limits (~200 writes/day).

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    migrate.ts (CLI Orchestrator)              │
│  Parses args, loads auth, runs migration modules in order    │
└────────┬──────────────────┬──────────────────┬───────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌────────────────────┐
│  migrate-    │  │  migrate-    │  │  migrate-           │
│  subscriptions│  │  likes.ts    │  │  playlists.ts       │
│  .ts         │  │              │  │                     │
│              │  │              │  │  • fetch playlists   │
│  • fetch     │  │  • fetch     │  │  • create on target  │
│  • push      │  │  • push      │  │  • fetch items       │
└──────┬───────┘  └──────┬───────┘  │  • push items        │
       │                 │          └──────────┬────────────┘
       │                 │                     │
       ▼                 ▼                     ▼
┌──────────────────────────────────────────────────────────────┐
│                      quota.ts (Quota Manager)                │
│  Tracks daily API unit consumption (10k/day limit)           │
│  withRetry() — exponential backoff on 429/5xx                │
│  Throws QuotaExhaustedError on 403 quotaExceeded             │
└──────────────────────────────────────────────────────────────┘
       │                 │                     │
       ▼                 ▼                     ▼
┌──────────────────────────────────────────────────────────────┐
│                     ledger.ts (State Manager)                │
│  SQLite DB (migration.db) — WAL mode for crash safety        │
│  Tables: subscriptions, liked_videos, playlists,             │
│          playlist_items, migration_meta                      │
│  Tracks: pending / done / error status per item              │
└──────────────────────────────────────────────────────────────┘
       │                 │                     │
       ▼                 ▼                     ▼
┌──────────────────────────────────────────────────────────────┐
│                       auth.ts (OAuth 2.0)                    │
│  Dual authentication — source & target YouTube accounts      │
│  Local HTTP server on :3000 to capture OAuth redirect        │
│  Persists tokens to source_tokens.json / target_tokens.json  │
│  Auto-refreshes expired access tokens                        │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow

### Phase 1: Authentication (one-time)

```
User runs `npm run auth:source` / `npm run auth:target`
  → auth.ts generates Google OAuth consent URL
  → User opens URL in browser, grants YouTube access
  → Google redirects to localhost:3000/oauth2callback with auth code
  → auth.ts exchanges code for access + refresh tokens
  → Tokens saved to source_tokens.json / target_tokens.json
```

### Phase 2: Migration (repeatable)

```
User runs `npm run migrate`
  → migrate.ts loads both auth clients from saved tokens
  → migrate.ts initializes SQLite ledger + quota manager
  → For each enabled module (subs → likes → playlists):

    FETCH PHASE (reads from source account, 1 unit/call):
      → Paginate YouTube API (50 items/page via nextPageToken)
      → Store each item ID in SQLite with status = 'pending'
      → Save pagination cursor in migration_meta for resume

    PUSH PHASE (writes to target account, 50 units/call):
      → Query ledger for items where status = 'pending'
      → Call YouTube API to subscribe/like/insert on target
      → Mark item as 'done' or 'error' in ledger
      → On QuotaExhaustedError → halt, print summary, exit

  → Next run: ledger skips 'done' items, resumes from 'pending'
```

### Playlist-Specific Flow

```
1. Fetch source playlists → store (source_id, title) in playlists table
2. Create matching empty playlists on target → store (source_id → target_id) mapping
3. Fetch items from each source playlist → store in playlist_items table
4. Push items into mapped target playlists using target_id
```

## File Reference

| File | Role | Key Exports |
|---|---|---|
| `src/auth.ts` | OAuth 2.0 authentication | `authenticateAccount()`, `getAuthClient()`, `createOAuth2Client()` |
| `src/ledger.ts` | SQLite state persistence | `Ledger` class — `upsertSubscription()`, `getPendingLikes()`, `markDone()`, etc. |
| `src/quota.ts` | API quota tracking + retries | `QuotaManager` class, `withRetry()`, `QuotaExhaustedError` |
| `src/migrate-subscriptions.ts` | Subscriptions migration | `fetchSubscriptions()`, `pushSubscriptions()` |
| `src/migrate-likes.ts` | Liked videos migration | `fetchLikedVideos()`, `pushLikedVideos()` |
| `src/migrate-playlists.ts` | Playlists + items migration | `fetchPlaylists()`, `createTargetPlaylists()`, `fetchPlaylistItems()`, `pushPlaylistItems()` |
| `src/migrate.ts` | CLI entry point / orchestrator | `main()` — parses args, runs modules in sequence |

## API Cost Reference

| Operation | Units | Example |
|---|---|---|
| Read (list, get) | 1 | `subscriptions.list`, `videos.list` |
| Write (insert, rate) | 50 | `subscriptions.insert`, `videos.rate` |
| **Daily limit** | **10,000** | ~200 writes/day (configured to 9,500 for headroom) |

## Key Config

| Env Variable | Purpose |
|---|---|
| `CLIENT_ID` | OAuth client ID from Google Cloud |
| `CLIENT_SECRET` | OAuth client secret |
| `REDIRECT_URI` | OAuth callback URL (`http://localhost:3000/oauth2callback`) |
| `DAILY_QUOTA_LIMIT` | Max API units per run (default: 9500) |

## CLI Commands

```bash
npm run auth:source       # Authenticate source YouTube account
npm run auth:target       # Authenticate target YouTube account
npm run migrate           # Run full migration (--all)
npm run migrate:subs      # Migrate subscriptions only
npm run migrate:likes     # Migrate liked videos only
npm run migrate:playlists # Migrate playlists only

# Manual options
npx tsx src/migrate.ts --all --dry-run   # Preview without writes
```
