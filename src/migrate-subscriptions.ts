import { google, youtube_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { Ledger } from './ledger.js';
import { QuotaManager, withRetry } from './quota.js';

const READ_COST = 1;
const WRITE_COST = 50;

/**
 * Fetch all subscriptions from the source account and store in ledger.
 */
export async function fetchSubscriptions(
  sourceAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager
): Promise<number> {
  const youtube = google.youtube({ version: 'v3', auth: sourceAuth });

  // Check if we've already finished fetching
  if (ledger.getMeta('subscriptions_fetched') === 'true') {
    console.log('  ↳ Subscriptions already fetched from source. Skipping fetch.');
    return 0;
  }

  let pageToken = ledger.getMeta('subscriptions_page_token') ?? undefined;
  let fetched = 0;

  console.log('  📥 Fetching subscriptions from source account...');

  do {
    const response = await withRetry(
      () =>
        youtube.subscriptions.list({
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
      const channelId = item.snippet?.resourceId?.channelId;
      const title = item.snippet?.title ?? '';
      if (channelId) {
        ledger.upsertSubscription(channelId, title);
        fetched++;
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;

    if (pageToken) {
      ledger.setMeta('subscriptions_page_token', pageToken);
    }

    console.log(`    Fetched ${fetched} subscriptions so far...`);
  } while (pageToken);

  ledger.setMeta('subscriptions_fetched', 'true');
  console.log(`  ✅ Fetched ${fetched} total subscriptions.`);
  return fetched;
}

/**
 * Push pending subscriptions to the target account.
 */
export async function pushSubscriptions(
  targetAuth: OAuth2Client,
  ledger: Ledger,
  quota: QuotaManager,
  dryRun = false
): Promise<{ pushed: number; errors: number }> {
  const youtube = google.youtube({ version: 'v3', auth: targetAuth });
  const pending = ledger.getPendingSubscriptions();

  console.log(`  📤 Pushing ${pending.length} pending subscriptions to target...`);

  let pushed = 0;
  let errors = 0;

  for (const sub of pending) {
    if (dryRun) {
      console.log(`    [DRY-RUN] Would subscribe to: ${sub.channel_title} (${sub.channel_id})`);
      pushed++;
      continue;
    }

    try {
      await withRetry(
        () =>
          youtube.subscriptions.insert({
            part: ['snippet'],
            requestBody: {
              snippet: {
                resourceId: {
                  kind: 'youtube#channel',
                  channelId: sub.channel_id,
                },
              },
            },
          }),
        quota,
        WRITE_COST
      );

      ledger.markSubscription(sub.channel_id, 'done');
      pushed++;
      console.log(`    ✓ Subscribed to: ${sub.channel_title}`);
    } catch (err: any) {
      // If it's a quota error, re-throw to stop the whole run
      if (err.name === 'QuotaExhaustedError') throw err;

      // Already subscribed is not really an error
      const reason = err?.errors?.[0]?.reason ?? err?.response?.data?.error?.errors?.[0]?.reason ?? '';
      if (reason === 'subscriptionDuplicate') {
        ledger.markSubscription(sub.channel_id, 'done');
        pushed++;
        console.log(`    ✓ Already subscribed: ${sub.channel_title}`);
        continue;
      }

      ledger.markSubscription(sub.channel_id, 'error', err.message);
      errors++;
      console.error(`    ✗ Failed: ${sub.channel_title} — ${err.message}`);
    }
  }

  console.log(`  ✅ Subscriptions: ${pushed} pushed, ${errors} errors.`);
  return { pushed, errors };
}
