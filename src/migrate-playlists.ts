import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { Ledger } from './ledger.js';
import { QuotaManager, withRetry } from './quota.js';

const READ_COST = 1;
const WRITE_COST = 50;

/**
 * Fetch all playlists from the source account.
 */
export async function fetchPlaylists(
  sourceAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager
): Promise<number> {
  const youtube = google.youtube({ version: 'v3', auth: sourceAuth });

  if (ledger.getMeta('playlists_fetched') === 'true') {
    console.log('  ↳ Playlists already fetched from source. Skipping fetch.');
    return 0;
  }

  let pageToken = ledger.getMeta('playlists_page_token') ?? undefined;
  let fetched = 0;

  console.log('  📥 Fetching playlists from source account...');

  do {
    const response = await withRetry(
      () =>
        youtube.playlists.list({
          mine: true,
          part: ['snippet'],
          maxResults: 50,
          pageToken,
        }),
      quota,
      READ_COST
    );

    const items = response.data.items ?? [];
    for (const item of items) {
      if (item.id) {
        ledger.upsertPlaylist(item.id, item.snippet?.title ?? '');
        fetched++;
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;

    if (pageToken) {
      ledger.setMeta('playlists_page_token', pageToken);
    }

    console.log(`    Fetched ${fetched} playlists so far...`);
  } while (pageToken);

  ledger.setMeta('playlists_fetched', 'true');
  console.log(`  ✅ Fetched ${fetched} total playlists.`);
  return fetched;
}

/**
 * Create matching playlists on the target account.
 */
export async function createTargetPlaylists(
  targetAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager,
  dryRun = false
): Promise<{ created: number; errors: number }> {
  const youtube = google.youtube({ version: 'v3', auth: targetAuth });
  const pending = ledger.getPendingPlaylists();

  console.log(`  📤 Creating ${pending.length} playlists on target...`);

  let created = 0;
  let errors = 0;

  for (const playlist of pending) {
    if (dryRun) {
      console.log(`    [DRY-RUN] Would create playlist: ${playlist.title}`);
      created++;
      continue;
    }

    try {
      const response = await withRetry(
        () =>
          youtube.playlists.insert({
            part: ['snippet', 'status'],
            requestBody: {
              snippet: {
                title: playlist.title,
                description: `Migrated from source account`,
              },
              status: {
                privacyStatus: 'private', // Create as private, user can change later
              },
            },
          }),
        quota,
        WRITE_COST
      );

      const targetId = response.data.id!;
      ledger.setPlaylistTargetId(playlist.source_id, targetId);
      created++;
      console.log(`    ✓ Created playlist: ${playlist.title} → ${targetId}`);
    } catch (err: any) {
      if (err.name === 'QuotaExhaustedError') throw err;

      ledger.markPlaylist(playlist.source_id, 'error', err.message);
      errors++;
      console.error(`    ✗ Failed: ${playlist.title} — ${err.message}`);
    }
  }

  console.log(`  ✅ Playlists: ${created} created, ${errors} errors.`);
  return { created, errors };
}

/**
 * Fetch items from all source playlists and store in ledger.
 */
export async function fetchPlaylistItems(
  sourceAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager
): Promise<number> {
  const youtube = google.youtube({ version: 'v3', auth: sourceAuth });
  const allPlaylists = ledger.getAllPlaylists();

  let totalFetched = 0;

  for (const playlist of allPlaylists) {
    const metaKey = `playlist_items_fetched_${playlist.source_id}`;
    if (ledger.getMeta(metaKey) === 'true') {
      continue;
    }

    console.log(`  📥 Fetching items from playlist: ${playlist.title}...`);

    let pageToken = ledger.getMeta(`playlist_items_page_${playlist.source_id}`) ?? undefined;
    let fetched = 0;

    do {
      const response = await withRetry(
        () =>
          youtube.playlistItems.list({
            playlistId: playlist.source_id,
            part: ['snippet'],
            maxResults: 50,
            pageToken,
          }),
        quota,
        READ_COST
      );

      const items = response.data.items ?? [];
      for (const item of items) {
        const videoId = item.snippet?.resourceId?.videoId;
        if (videoId) {
          ledger.upsertPlaylistItem(playlist.source_id, videoId, item.snippet?.title ?? '');
          fetched++;
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;

      if (pageToken) {
        ledger.setMeta(`playlist_items_page_${playlist.source_id}`, pageToken);
      }
    } while (pageToken);

    ledger.setMeta(metaKey, 'true');
    totalFetched += fetched;
    console.log(`    Fetched ${fetched} items from: ${playlist.title}`);
  }

  console.log(`  ✅ Fetched ${totalFetched} total playlist items.`);
  return totalFetched;
}

/**
 * Push playlist items to the corresponding target playlists.
 */
export async function pushPlaylistItems(
  targetAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager,
  dryRun = false
): Promise<{ pushed: number; errors: number }> {
  const youtube = google.youtube({ version: 'v3', auth: targetAuth });
  const allPlaylists = ledger.getAllPlaylists();

  let totalPushed = 0;
  let totalErrors = 0;

  for (const playlist of allPlaylists) {
    if (!playlist.target_id) {
      console.log(`  ⚠ Skipping items for "${playlist.title}" — target playlist not yet created.`);
      continue;
    }

    const pending = ledger.getPendingPlaylistItems(playlist.source_id);
    if (pending.length === 0) continue;

    console.log(`  📤 Pushing ${pending.length} items into: ${playlist.title}...`);

    for (const item of pending) {
      if (dryRun) {
        console.log(`    [DRY-RUN] Would add: ${item.video_title} to ${playlist.title}`);
        totalPushed++;
        continue;
      }

      try {
        await withRetry(
          () =>
            youtube.playlistItems.insert({
              part: ['snippet'],
              requestBody: {
                snippet: {
                  playlistId: playlist.target_id!,
                  resourceId: {
                    kind: 'youtube#video',
                    videoId: item.video_id,
                  },
                },
              },
            }),
          quota,
          WRITE_COST
        );

        ledger.markPlaylistItem(item.source_playlist_id, item.video_id, 'done');
        totalPushed++;
        console.log(`    ✓ Added: ${item.video_title}`);
      } catch (err: any) {
        if (err.name === 'QuotaExhaustedError') throw err;

        // Video might be deleted/private — mark as error and continue
        ledger.markPlaylistItem(item.source_playlist_id, item.video_id, 'error', err.message);
        totalErrors++;
        console.error(`    ✗ Failed: ${item.video_title} — ${err.message}`);
      }
    }
  }

  console.log(`  ✅ Playlist items: ${totalPushed} pushed, ${totalErrors} errors.`);
  return { pushed: totalPushed, errors: totalErrors };
}
