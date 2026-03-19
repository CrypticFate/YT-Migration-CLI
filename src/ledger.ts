import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'migration.db');

export type ItemStatus = 'pending' | 'done' | 'error';

export interface PendingSubscription {
  channel_id: string;
  channel_title: string;
}

export interface PendingLike {
  video_id: string;
  video_title: string;
}

export interface PlaylistRecord {
  source_id: string;
  target_id: string | null;
  title: string;
  status: ItemStatus;
}

export interface PendingPlaylistItem {
  source_playlist_id: string;
  video_id: string;
  video_title: string;
}

export class Ledger {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        channel_id    TEXT PRIMARY KEY,
        channel_title TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'pending',
        error         TEXT
      );

      CREATE TABLE IF NOT EXISTS liked_videos (
        video_id    TEXT PRIMARY KEY,
        video_title TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT
      );

      CREATE TABLE IF NOT EXISTS playlists (
        source_id   TEXT PRIMARY KEY,
        target_id   TEXT,
        title       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT
      );

      CREATE TABLE IF NOT EXISTS playlist_items (
        source_playlist_id TEXT NOT NULL,
        video_id           TEXT NOT NULL,
        video_title        TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'pending',
        error              TEXT,
        PRIMARY KEY (source_playlist_id, video_id)
      );

      CREATE TABLE IF NOT EXISTS migration_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  // ── Meta ────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM migration_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare('INSERT INTO migration_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
  }

  // ── Subscriptions ──────────────────────────────────────────────

  upsertSubscription(channelId: string, channelTitle: string) {
    this.db
      .prepare(
        `INSERT INTO subscriptions (channel_id, channel_title, status)
         VALUES (?, ?, 'pending')
         ON CONFLICT(channel_id) DO NOTHING`
      )
      .run(channelId, channelTitle);
  }

  getPendingSubscriptions(): PendingSubscription[] {
    return this.db
      .prepare("SELECT channel_id, channel_title FROM subscriptions WHERE status = 'pending'")
      .all() as PendingSubscription[];
  }

  markSubscription(channelId: string, status: ItemStatus, error?: string) {
    this.db
      .prepare('UPDATE subscriptions SET status = ?, error = ? WHERE channel_id = ?')
      .run(status, error ?? null, channelId);
  }

  getSubscriptionCounts() {
    return this.getCounts('subscriptions');
  }

  // ── Liked Videos ───────────────────────────────────────────────

  upsertLike(videoId: string, videoTitle: string) {
    this.db
      .prepare(
        `INSERT INTO liked_videos (video_id, video_title, status)
         VALUES (?, ?, 'pending')
         ON CONFLICT(video_id) DO NOTHING`
      )
      .run(videoId, videoTitle);
  }

  getPendingLikes(): PendingLike[] {
    return this.db
      .prepare("SELECT video_id, video_title FROM liked_videos WHERE status = 'pending'")
      .all() as PendingLike[];
  }

  markLike(videoId: string, status: ItemStatus, error?: string) {
    this.db
      .prepare('UPDATE liked_videos SET status = ?, error = ? WHERE video_id = ?')
      .run(status, error ?? null, videoId);
  }

  getLikeCounts() {
    return this.getCounts('liked_videos');
  }

  // ── Playlists ──────────────────────────────────────────────────

  upsertPlaylist(sourceId: string, title: string) {
    this.db
      .prepare(
        `INSERT INTO playlists (source_id, title, status)
         VALUES (?, ?, 'pending')
         ON CONFLICT(source_id) DO NOTHING`
      )
      .run(sourceId, title);
  }

  setPlaylistTargetId(sourceId: string, targetId: string) {
    this.db
      .prepare("UPDATE playlists SET target_id = ?, status = 'done' WHERE source_id = ?")
      .run(targetId, sourceId);
  }

  getPendingPlaylists(): PlaylistRecord[] {
    return this.db
      .prepare("SELECT source_id, target_id, title, status FROM playlists WHERE status = 'pending'")
      .all() as PlaylistRecord[];
  }

  getAllPlaylists(): PlaylistRecord[] {
    return this.db.prepare('SELECT source_id, target_id, title, status FROM playlists').all() as PlaylistRecord[];
  }

  getPlaylistCounts() {
    return this.getCounts('playlists');
  }

  markPlaylist(sourceId: string, status: ItemStatus, error?: string) {
    this.db
      .prepare('UPDATE playlists SET status = ?, error = ? WHERE source_id = ?')
      .run(status, error ?? null, sourceId);
  }

  // ── Playlist Items ─────────────────────────────────────────────

  upsertPlaylistItem(sourcePlaylistId: string, videoId: string, videoTitle: string) {
    this.db
      .prepare(
        `INSERT INTO playlist_items (source_playlist_id, video_id, video_title, status)
         VALUES (?, ?, ?, 'pending')
         ON CONFLICT(source_playlist_id, video_id) DO NOTHING`
      )
      .run(sourcePlaylistId, videoId, videoTitle);
  }

  getPendingPlaylistItems(sourcePlaylistId: string): PendingPlaylistItem[] {
    return this.db
      .prepare(
        "SELECT source_playlist_id, video_id, video_title FROM playlist_items WHERE source_playlist_id = ? AND status = 'pending'"
      )
      .all(sourcePlaylistId) as PendingPlaylistItem[];
  }

  markPlaylistItem(sourcePlaylistId: string, videoId: string, status: ItemStatus, error?: string) {
    this.db
      .prepare(
        'UPDATE playlist_items SET status = ?, error = ? WHERE source_playlist_id = ? AND video_id = ?'
      )
      .run(status, error ?? null, sourcePlaylistId, videoId);
  }

  getPlaylistItemCounts() {
    return this.getCounts('playlist_items');
  }

  // ── Helpers ────────────────────────────────────────────────────

  private getCounts(table: string) {
    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }
    ).count;
    const done = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE status = 'done'`)
        .get() as { count: number }
    ).count;
    const pending = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE status = 'pending'`)
        .get() as { count: number }
    ).count;
    const errors = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE status = 'error'`)
        .get() as { count: number }
    ).count;
    return { total, done, pending, errors };
  }

  close() {
    this.db.close();
  }
}
