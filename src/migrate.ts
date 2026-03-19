#!/usr/bin/env node
import 'dotenv/config';
import { getAuthClient } from './auth.js';
import { Ledger } from './ledger.js';
import { QuotaManager, QuotaExhaustedError } from './quota.js';
import { fetchSubscriptions, pushSubscriptions } from './migrate-subscriptions.js';
import { fetchLikedVideos, pushLikedVideos } from './migrate-likes.js';
import {
  fetchPlaylists,
  createTargetPlaylists,
  fetchPlaylistItems,
  pushPlaylistItems,
} from './migrate-playlists.js';

// ── CLI arg parsing ──────────────────────────────────────────────

interface MigrateOptions {
  subscriptions: boolean;
  likes: boolean;
  playlists: boolean;
  dryRun: boolean;
}

function parseArgs(): MigrateOptions {
  const args = new Set(process.argv.slice(2).map((a) => a.toLowerCase()));

  const all = args.has('--all');
  return {
    subscriptions: all || args.has('--subscriptions') || args.has('--subs'),
    likes: all || args.has('--likes'),
    playlists: all || args.has('--playlists'),
    dryRun: args.has('--dry-run'),
  };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (!opts.subscriptions && !opts.likes && !opts.playlists) {
    console.log(`
YouTube Migration Pipeline
==========================

Usage: npx tsx src/migrate.ts [options]

Options:
  --all             Migrate everything (subscriptions + likes + playlists)
  --subscriptions   Migrate subscriptions only
  --likes           Migrate liked videos only
  --playlists       Migrate playlists only
  --dry-run         Preview actions without making API writes

Examples:
  npx tsx src/migrate.ts --all
  npx tsx src/migrate.ts --subscriptions --dry-run
  npm run migrate
`);
    process.exit(0);
  }

  console.log('\n🚀 YouTube Migration Pipeline');
  console.log('═'.repeat(50));

  if (opts.dryRun) {
    console.log('⚠  DRY-RUN MODE — no writes will be made.\n');
  }

  // Authenticate both accounts
  console.log('🔐 Loading authentication...');
  const sourceAuth = await getAuthClient('source');
  const targetAuth = await getAuthClient('target');
  console.log('  ✓ Both accounts authenticated.\n');

  const ledger = new Ledger();
  const quota = new QuotaManager();

  try {
    // ── Subscriptions ──────────────────────────────────────────
    if (opts.subscriptions) {
      console.log('━'.repeat(50));
      console.log('📺 SUBSCRIPTIONS');
      console.log('━'.repeat(50));
      await fetchSubscriptions(sourceAuth, ledger, quota);
      await pushSubscriptions(targetAuth, ledger, quota, opts.dryRun);
      printCounts('Subscriptions', ledger.getSubscriptionCounts());
    }

    // ── Liked Videos ───────────────────────────────────────────
    if (opts.likes) {
      console.log('\n' + '━'.repeat(50));
      console.log('❤️  LIKED VIDEOS');
      console.log('━'.repeat(50));
      await fetchLikedVideos(sourceAuth, ledger, quota);
      await pushLikedVideos(targetAuth, ledger, quota, opts.dryRun);
      printCounts('Liked Videos', ledger.getLikeCounts());
    }

    // ── Playlists ──────────────────────────────────────────────
    if (opts.playlists) {
      console.log('\n' + '━'.repeat(50));
      console.log('📋 PLAYLISTS');
      console.log('━'.repeat(50));
      await fetchPlaylists(sourceAuth, ledger, quota);
      await createTargetPlaylists(targetAuth, ledger, quota, opts.dryRun);
      await fetchPlaylistItems(sourceAuth, ledger, quota);
      await pushPlaylistItems(targetAuth, ledger, quota, opts.dryRun);
      printCounts('Playlists', ledger.getPlaylistCounts());
      printCounts('Playlist Items', ledger.getPlaylistItemCounts());
    }

    console.log('\n' + '═'.repeat(50));
    console.log('🏁 Migration run complete!');
    console.log(quota.summary());

  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      console.log('\n' + '═'.repeat(50));
      console.log('⚠  QUOTA EXHAUSTED — halting gracefully.');
      console.log('   Progress has been saved. Re-run tomorrow to continue.');
      console.log(quota.summary());
      printSummary(ledger, opts);
    } else {
      console.error('\n❌ Unexpected error:', err);
    }
  } finally {
    printSummary(ledger, opts);
    ledger.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function printCounts(label: string, counts: { total: number; done: number; pending: number; errors: number }) {
  console.log(`  📊 ${label}: ${counts.done}/${counts.total} done, ${counts.pending} pending, ${counts.errors} errors`);
}

function printSummary(ledger: Ledger, opts: MigrateOptions) {
  console.log('\n📊 Overall Progress');
  console.log('─'.repeat(40));

  if (opts.subscriptions) {
    printCounts('Subscriptions', ledger.getSubscriptionCounts());
  }
  if (opts.likes) {
    printCounts('Liked Videos', ledger.getLikeCounts());
  }
  if (opts.playlists) {
    printCounts('Playlists', ledger.getPlaylistCounts());
    printCounts('Playlist Items', ledger.getPlaylistItemCounts());
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
