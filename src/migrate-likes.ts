import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { Ledger } from './ledger.js';
import { QuotaManager, withRetry } from './quota.js';

const READ_COST = 1;
const WRITE_COST = 50;

/**
 * Fetch all liked videos from the source account and store in ledger.
 */
export async function fetchLikedVideos(
  sourceAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager
): Promise<number> {
  const youtube = google.youtube({ version: 'v3', auth: sourceAuth });

  if (ledger.getMeta('likes_fetched') === 'true') {
    console.log('  ↳ Liked videos already fetched from source. Skipping fetch.');
    return 0;
  }

  let pageToken = ledger.getMeta('likes_page_token') ?? undefined;
  let fetched = 0;

  console.log('  📥 Fetching liked videos from source account...');

  do {
    const response = await withRetry(
      () =>
        youtube.videos.list({
          myRating: 'like',
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
        ledger.upsertLike(item.id, item.snippet?.title ?? '');
        fetched++;
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;

    if (pageToken) {
      ledger.setMeta('likes_page_token', pageToken);
    }

    console.log(`    Fetched ${fetched} liked videos so far...`);
  } while (pageToken);

  ledger.setMeta('likes_fetched', 'true');
  console.log(`  ✅ Fetched ${fetched} total liked videos.`);
  return fetched;
}

/**
 * Push pending likes to the target account.
 */
export async function pushLikedVideos(
  targetAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager,
  dryRun = false
): Promise<{ pushed: number; errors: number }> {
  const youtube = google.youtube({ version: 'v3', auth: targetAuth });
  const pending = ledger.getPendingLikes();

  console.log(`  📤 Pushing ${pending.length} pending likes to target...`);

  let pushed = 0;
  let errors = 0;

  for (const like of pending) {
    if (dryRun) {
      console.log(`    [DRY-RUN] Would like: ${like.video_title} (${like.video_id})`);
      pushed++;
      continue;
    }

    try {
      await withRetry(
        () =>
          youtube.videos.rate({
            id: like.video_id,
            rating: 'like',
          }),
        quota,
        WRITE_COST
      );

      ledger.markLike(like.video_id, 'done');
      pushed++;
      console.log(`    ✓ Liked: ${like.video_title}`);
    } catch (err: any) {
      if (err.name === 'QuotaExhaustedError') throw err;

      ledger.markLike(like.video_id, 'error', err.message);
      errors++;
      console.error(`    ✗ Failed: ${like.video_title} — ${err.message}`);
    }
  }

  console.log(`  ✅ Likes: ${pushed} pushed, ${errors} errors.`);
  return { pushed, errors };
}
