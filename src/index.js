import 'dotenv/config';
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  ModalBuilder,
  PermissionFlagsBits,
  Partials,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  UserSelectMenuBuilder,
  TextInputStyle,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CONFIGURED_GUILD_IDS = String(process.env.GUILD_IDS ?? process.env.GUILD_ID ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const GUILD_IDS = new Set(CONFIGURED_GUILD_IDS);
const MIN_ACCOUNT_AGE_HOURS = Number(process.env.MIN_ACCOUNT_AGE_HOURS ?? 0);

if (!TOKEN || GUILD_IDS.size === 0) {
  console.error('Missing DISCORD_TOKEN or GUILD_IDS/GUILD_ID in .env');
  process.exit(1);
}

mkdirSync('data/guilds', { recursive: true });
const guildDbContext = new AsyncLocalStorage();
const guildDbs = new Map();

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    xp INTEGER NOT NULL DEFAULT 0,
    verified_at INTEGER,
    joined_at INTEGER,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS daily_xp (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    message_xp INTEGER NOT NULL DEFAULT 0,
    voice_xp INTEGER NOT NULL DEFAULT 0,
    social_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS xp_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    actor_id TEXT
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    inviter_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS referrals (
    member_id TEXT PRIMARY KEY,
    inviter_id TEXT NOT NULL,
    invite_code TEXT,
    joined_at INTEGER NOT NULL,
    valid_awarded INTEGER NOT NULL DEFAULT 0,
    l2_awarded INTEGER NOT NULL DEFAULT 0,
    l3_awarded INTEGER NOT NULL DEFAULT 0,
    creator_awarded INTEGER NOT NULL DEFAULT 0,
    founder_awarded INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS social_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    submitted_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    xp_awarded INTEGER NOT NULL DEFAULT 0,
    review_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS signal_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    section TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    submitted_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    xp_awarded INTEGER NOT NULL DEFAULT 0,
    review_message_id TEXT,
    published_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS creator_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS creator_post_reactions (
    submission_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (submission_id, user_id, emoji_key)
  );

  CREATE TABLE IF NOT EXISTS member_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    website TEXT,
    x TEXT,
    linkedin TEXT,
    telegram TEXT,
    other TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    submitted_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    review_message_id TEXT,
    directory_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS team_profiles (
    user_id TEXT PRIMARY KEY,
    role_title TEXT NOT NULL,
    website TEXT,
    x TEXT,
    linkedin TEXT,
    telegram TEXT,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS founder_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    website TEXT,
    social TEXT,
    role_title TEXT,
    studio_interest TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    submitted_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    review_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by TEXT NOT NULL,
    title TEXT,
    body TEXT,
    image_url TEXT,
    cta_json TEXT,
    x_only INTEGER NOT NULL DEFAULT 0,
    discord_message_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS voice_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    started_by TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS voice_event_progress (
    event_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    qualified_minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS voice_event_speakers (
    event_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    hand_raised_at INTEGER,
    speaker_started_at INTEGER,
    awarded_at INTEGER,
    awarded_by TEXT,
    PRIMARY KEY (event_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS voice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    official_event_id INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_open ON voice_sessions(user_id, left_at);
  CREATE INDEX IF NOT EXISTS idx_voice_sessions_joined_at ON voice_sessions(joined_at);


  CREATE TABLE IF NOT EXISTS message_candidates (
    message_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    fingerprint TEXT,
    base_score INTEGER NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    reaction_count INTEGER NOT NULL DEFAULT 0,
    moderator_bonus INTEGER NOT NULL DEFAULT 0,
    awarded INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    awarded_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS message_engagement (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, kind)
  );

  CREATE TABLE IF NOT EXISTS activity_daily (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    reactions INTEGER NOT NULL DEFAULT 0,
    voice_entries INTEGER NOT NULL DEFAULT 0,
    commands INTEGER NOT NULL DEFAULT 0,
    onboarding INTEGER NOT NULL DEFAULT 0,
    submissions INTEGER NOT NULL DEFAULT 0,
    first_activity_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  );


  CREATE TABLE IF NOT EXISTS booster_daily (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    boost_count INTEGER NOT NULL DEFAULT 1,
    xp_awarded INTEGER NOT NULL DEFAULT 0,
    awarded_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS booster_overrides (
    user_id TEXT PRIMARY KEY,
    boost_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS member_activation (
    user_id TEXT PRIMARY KEY,
    interests_set INTEGER NOT NULL DEFAULT 0,
    language_set INTEGER NOT NULL DEFAULT 0,
    introduced_at INTEGER,
    first_impact_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS member_participation (
    user_id TEXT PRIMARY KEY,
    lane TEXT NOT NULL DEFAULT 'community',
    selected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kreator_profiles (
    user_id TEXT PRIMARY KEY,
    primary_url TEXT NOT NULL,
    primary_followers INTEGER NOT NULL DEFAULT 0,
    secondary_url TEXT,
    secondary_followers INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    submitted_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    review_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS user_interests (
    user_id TEXT NOT NULL,
    interest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, interest)
  );

  CREATE TABLE IF NOT EXISTS language_roles (
    role_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT,
    channel_id TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS member_languages (
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS language_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    language_name TEXT NOT NULL,
    emoji TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by TEXT,
    role_id TEXT,
    channel_id TEXT,
    review_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS language_request_supporters (
    request_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS language_catalog_custom (
    language_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🌐',
    created_at INTEGER NOT NULL,
    approved_by TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS language_preferences (
    user_id TEXT NOT NULL,
    language_key TEXT NOT NULL,
    selected_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, language_key)
  );

  CREATE TABLE IF NOT EXISTS language_demand_reviews (
    language_key TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    review_message_id TEXT,
    last_notified_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS product_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    updated_by TEXT,
    public_message_id TEXT,
    review_message_id TEXT,
    staff_note TEXT
  );

  CREATE TABLE IF NOT EXISTS community_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    start_at INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    voice_channel_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    public_message_id TEXT,
    native_scheduled_event_id TEXT,
    event_access TEXT NOT NULL DEFAULT 'verified',
    permission_snapshot_json TEXT,
    permissions_applied_at INTEGER,
    permissions_restored_at INTEGER,
    reminded_30 INTEGER NOT NULL DEFAULT 0,
    reminded_5 INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    ended_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS event_rsvps (
    event_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS event_attendance (
    event_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS managed_channels (
    channel_id TEXT PRIMARY KEY,
    category_name TEXT,
    access TEXT NOT NULL DEFAULT 'verified',
    links_allowed INTEGER NOT NULL DEFAULT 0,
    kxp_enabled INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wallets (
    user_id TEXT NOT NULL,
    network TEXT NOT NULL,
    address TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    reward_eligible_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, network)
  );

  CREATE TABLE IF NOT EXISTS wallet_profiles (
    user_id TEXT PRIMARY KEY,
    primary_network TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_submission_rewards (
    user_id TEXT NOT NULL,
    item TEXT NOT NULL,
    awarded_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item)
  );

  CREATE TABLE IF NOT EXISTS unattributed_joins (
    user_id TEXT PRIMARY KEY,
    joined_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT,
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS join_attribution (
    user_id TEXT PRIMARY KEY,
    source TEXT,
    inviter_id TEXT,
    detected_inviter_id TEXT,
    source_confirmed INTEGER NOT NULL DEFAULT 0,
    inviter_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallet_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    network TEXT NOT NULL,
    old_address TEXT,
    new_address TEXT,
    changed_at INTEGER NOT NULL,
    actor_id TEXT NOT NULL
  );
`;

function ensureSqliteColumn(database, table, column, definition) {
  const exists = database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function isAllowedGuild(guildId) {
  return !!guildId && GUILD_IDS.has(String(guildId));
}

function guildDatabasePath(guildId) {
  return `data/guilds/${String(guildId)}.sqlite`;
}

function runWithGuild(guildId, fn) {
  const id = String(guildId ?? '');
  if (!isAllowedGuild(id)) return undefined;
  return guildDbContext.run(id, fn);
}

function currentGuildId() {
  const guildId = guildDbContext.getStore();
  if (!guildId) throw new Error('LINKO database access attempted without a guild context');
  return guildId;
}

function currentDatabase() {
  return getGuildDb(currentGuildId());
}

const db = {
  prepare(...args) { return currentDatabase().prepare(...args); },
  exec(...args) { return currentDatabase().exec(...args); },
};

const DEFAULT_SETTINGS = {
  community_name: '',
  project_tagline: '',
  project_description: '',
  project_audience: '',
  project_member_value: '',
  project_products: '',
  project_status: '',
  project_first_action: '',
  project_guidance: '',
  project_primary_label: '',
  project_primary_url: '',
  project_secondary_label: '',
  project_secondary_url: '',
  profile_preset: 'klineo',
  module_signal_room: '1',
  module_kreator: '1',
  module_founder_hub: '1',
  module_liquidity_studio: '1',
  xp_label: 'KXP',
  kxp_message: '1',
  kxp_voice_interval: '2',
  kxp_voice_speaker_bonus: '2',
  kxp_valid_referral: '1',
  kxp_social_post: '2',
  creator_reaction_threshold: '100',
  creator_reaction_kxp: '1',
  creator_reaction_cap: '3',
  campaign_leaderboard_retention_days: '7',
  kxp_bug_report: '3',
  kxp_profile_submission: '1',
  kxp_boost_daily: '2',
  referral_activity_min_events: '1',
  referral_activity_min_days: '2',
  referral_claim_window_hours: '72',
  message_daily_cap: '10',
  message_cooldown_seconds: '180',
  impact_min_score: '2',
  impact_delay_seconds: '180',
  impact_candidate_window_minutes: '30',
  impact_min_words: '5',
  impact_min_alpha_chars: '18',
  voice_interval_minutes: '15',
  kxp_leaderboard_visibility: 'public',
  community_leaderboard_visibility: 'public',
  referral_leaderboard_visibility: 'public',
  creator_leaderboard_visibility: 'public',
  campaign_leaderboard_visibility: 'public',
  image_welcome: '',
  image_verify: '',
  image_social: '',
  image_founder: '',
  image_official: '',
  official_website: '',
  official_liquidity_studio: '',
  official_x: '',
  official_telegram: '',
  official_linkedin: '',
  official_docs: '',
  official_support: '',
  brand_accent: '',
  health_window_days: '7',
  health_auto_refresh_hours: '12',
  event_reminder_30: '1',
  event_reminder_5: '1',
  leaderboard_limit: '50',
  wallet_change_lock_hours: '24',
};

function initializeGuildDatabase(database) {
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(SCHEMA_SQL);

  ensureSqliteColumn(database, 'wallet_profiles', 'x_account', 'TEXT');
  ensureSqliteColumn(database, 'wallet_profiles', 'telegram_account', 'TEXT');
  ensureSqliteColumn(database, 'wallet_profiles', 'linkedin_account', 'TEXT');
  ensureSqliteColumn(database, 'social_submissions', 'campaign_id', 'INTEGER');
  ensureSqliteColumn(database, 'social_submissions', 'creator_eligible', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'social_submissions', 'submitter_lane', "TEXT NOT NULL DEFAULT 'community'");
  ensureSqliteColumn(database, 'social_submissions', 'share_message_id', 'TEXT');
  ensureSqliteColumn(database, 'social_submissions', 'reaction_xp_awarded', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'social_submissions', 'reaction_milestones_awarded', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'community_events', 'native_scheduled_event_id', 'TEXT');
  ensureSqliteColumn(database, 'community_events', 'event_access', "TEXT NOT NULL DEFAULT 'verified'");
  ensureSqliteColumn(database, 'community_events', 'permission_snapshot_json', 'TEXT');
  ensureSqliteColumn(database, 'community_events', 'permissions_applied_at', 'INTEGER');
  ensureSqliteColumn(database, 'community_events', 'permissions_restored_at', 'INTEGER');

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  const voiceRewardMigration = database.prepare("SELECT value FROM settings WHERE key='voice_rewards_v109_migrated'").get();
  if (!voiceRewardMigration) {
    const currentVoiceAward = database.prepare("SELECT value FROM settings WHERE key='kxp_voice_interval'").get()?.value;
    if (String(currentVoiceAward ?? '') === '1') database.prepare("UPDATE settings SET value='2' WHERE key='kxp_voice_interval'").run();
    database.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice_rewards_v109_migrated', ?)").run(String(Date.now()));
  }

  // Compatibility migration if an existing guild database is ever copied into the sharded layout.
  for (const ref of database.prepare('SELECT member_id, inviter_id, invite_code, joined_at, valid_awarded FROM referrals').all()) {
    const exists = database.prepare('SELECT user_id FROM join_attribution WHERE user_id = ?').get(ref.member_id);
    if (exists) continue;
    const code = String(ref.invite_code ?? '');
    const isManual = code.startsWith('manual:');
    const isSelf = code.startsWith('self:');
    const tracked = !!code && !isManual && !isSelf;
    const confirmed = tracked || isManual || Number(ref.valid_awarded) === 1;
    database.prepare(`INSERT OR IGNORE INTO join_attribution
      (user_id, source, inviter_id, detected_inviter_id, source_confirmed, inviter_confirmed, created_at, updated_at)
      VALUES (?, 'member', ?, ?, 1, ?, ?, ?)`)
      .run(ref.member_id, ref.inviter_id, tracked ? ref.inviter_id : null, confirmed ? 1 : 0, Number(ref.joined_at ?? Date.now()), Date.now());
  }
}


function tableExists(database, table) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function tableColumns(database, table) {
  if (!tableExists(database, table)) return [];
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}
function minNullable(a, b) {
  const vals = [a, b].filter((v) => v !== null && v !== undefined);
  return vals.length ? Math.min(...vals.map(Number)) : null;
}
function maxNullable(a, b) {
  const vals = [a, b].filter((v) => v !== null && v !== undefined);
  return vals.length ? Math.max(...vals.map(Number)) : null;
}
function copyLegacyRowsIgnore(legacy, target, table, omit = []) {
  if (!tableExists(legacy, table) || !tableExists(target, table)) return 0;
  const targetCols = new Set(tableColumns(target, table));
  const cols = tableColumns(legacy, table).filter((col) => targetCols.has(col) && !omit.includes(col));
  if (!cols.length) return 0;
  const placeholders = cols.map(() => '?').join(',');
  const stmt = target.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  let copied = 0;
  for (const row of legacy.prepare(`SELECT ${cols.join(',')} FROM ${table}`).all()) {
    const result = stmt.run(...cols.map((col) => row[col]));
    copied += Number(result.changes ?? 0);
  }
  return copied;
}

function migrateLegacyKlineoDatabase(guildId, guildName) {
  const id = String(guildId);
  if (String(guildName ?? '').trim().toLowerCase() !== 'klineo') return null;
  const legacyPath = 'data/linko.sqlite';
  if (!existsSync(legacyPath)) return null;

  const target = getGuildDb(id);
  const markerKey = 'legacy_v1051_migrated_at';
  if (target.prepare('SELECT value FROM settings WHERE key=?').get(markerKey)?.value) return null;

  mkdirSync('data/backups', { recursive: true });
  const backupPath = `data/backups/${id}-pre-v1051-migration-${Date.now()}.sqlite`;
  target.exec(`VACUUM INTO '${backupPath}'`);

  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  const summary = { users: 0, legacyXp: 0, xpLog: 0, social: 0, referrals: 0, events: 0, suggestions: 0 };

  try {
    target.exec('BEGIN IMMEDIATE');

    if (tableExists(legacy, 'users')) {
      const getUser = target.prepare('SELECT xp, verified_at, joined_at, last_seen_at FROM users WHERE user_id=?');
      const insertUser = target.prepare('INSERT INTO users (user_id,xp,verified_at,joined_at,last_seen_at) VALUES (?,?,?,?,?)');
      const updateUser = target.prepare('UPDATE users SET xp=?, verified_at=?, joined_at=?, last_seen_at=? WHERE user_id=?');
      for (const row of legacy.prepare('SELECT user_id,xp,verified_at,joined_at,last_seen_at FROM users').all()) {
        const cur = getUser.get(row.user_id);
        const oldXp = Number(row.xp ?? 0);
        summary.legacyXp += oldXp;
        if (!cur) {
          insertUser.run(row.user_id, oldXp, row.verified_at, row.joined_at, row.last_seen_at);
        } else {
          updateUser.run(
            Number(cur.xp ?? 0) + oldXp,
            minNullable(cur.verified_at, row.verified_at),
            minNullable(cur.joined_at, row.joined_at),
            maxNullable(cur.last_seen_at, row.last_seen_at),
            row.user_id
          );
        }
        summary.users++;
      }
    }

    if (tableExists(legacy, 'daily_xp')) {
      const getDailyRow = target.prepare('SELECT message_xp,voice_xp,social_count FROM daily_xp WHERE user_id=? AND day=?');
      const insertDaily = target.prepare('INSERT INTO daily_xp (user_id,day,message_xp,voice_xp,social_count) VALUES (?,?,?,?,?)');
      const updateDaily = target.prepare('UPDATE daily_xp SET message_xp=?,voice_xp=?,social_count=? WHERE user_id=? AND day=?');
      for (const row of legacy.prepare('SELECT user_id,day,message_xp,voice_xp,social_count FROM daily_xp').all()) {
        const cur = getDailyRow.get(row.user_id, row.day);
        if (!cur) insertDaily.run(row.user_id,row.day,row.message_xp,row.voice_xp,row.social_count);
        else updateDaily.run(
          Number(cur.message_xp ?? 0) + Number(row.message_xp ?? 0),
          Number(cur.voice_xp ?? 0) + Number(row.voice_xp ?? 0),
          Number(cur.social_count ?? 0) + Number(row.social_count ?? 0),
          row.user_id,row.day
        );
      }
    }

    if (tableExists(legacy, 'xp_log')) {
      const existsLog = target.prepare("SELECT 1 FROM xp_log WHERE user_id=? AND amount=? AND reason=? AND created_at=? AND COALESCE(actor_id,'')=COALESCE(?,'') LIMIT 1");
      const insertLog = target.prepare('INSERT INTO xp_log (user_id,amount,reason,created_at,actor_id) VALUES (?,?,?,?,?)');
      for (const row of legacy.prepare('SELECT user_id,amount,reason,created_at,actor_id FROM xp_log ORDER BY id').all()) {
        if (existsLog.get(row.user_id,row.amount,row.reason,row.created_at,row.actor_id)) continue;
        insertLog.run(row.user_id,row.amount,row.reason,row.created_at,row.actor_id);
        summary.xpLog++;
      }
    }

    if (tableExists(legacy, 'member_activation')) {
      const getAct = target.prepare('SELECT * FROM member_activation WHERE user_id=?');
      const insAct = target.prepare('INSERT INTO member_activation (user_id,interests_set,language_set,introduced_at,first_impact_at) VALUES (?,?,?,?,?)');
      const updAct = target.prepare('UPDATE member_activation SET interests_set=?,language_set=?,introduced_at=?,first_impact_at=? WHERE user_id=?');
      for (const row of legacy.prepare('SELECT * FROM member_activation').all()) {
        const cur = getAct.get(row.user_id);
        if (!cur) insAct.run(row.user_id,row.interests_set,row.language_set,row.introduced_at,row.first_impact_at);
        else updAct.run(
          Math.max(Number(cur.interests_set ?? 0), Number(row.interests_set ?? 0)),
          Math.max(Number(cur.language_set ?? 0), Number(row.language_set ?? 0)),
          minNullable(cur.introduced_at,row.introduced_at),
          minNullable(cur.first_impact_at,row.first_impact_at),
          row.user_id
        );
      }
    }

    summary.referrals += copyLegacyRowsIgnore(legacy,target,'referrals');
    summary.social += copyLegacyRowsIgnore(legacy,target,'social_submissions',['id']);
    summary.suggestions += copyLegacyRowsIgnore(legacy,target,'product_suggestions',['id']);

    for (const table of [
      'invite_codes','message_candidates','message_engagement','user_interests','language_roles',
      'member_languages','managed_channels','wallets','wallet_profiles','profile_submission_rewards',
      'unattributed_joins','join_attribution','team_profiles'
    ]) copyLegacyRowsIgnore(legacy,target,table);
    for (const table of ['member_profiles','founder_applications','wallet_history']) copyLegacyRowsIgnore(legacy,target,table,['id']);

    const voiceMap = new Map();
    if (tableExists(legacy,'voice_events')) {
      const findVoice = target.prepare('SELECT id FROM voice_events WHERE name=? AND channel_id=? AND started_at=? LIMIT 1');
      const insertVoice = target.prepare('INSERT INTO voice_events (name,channel_id,started_by,started_at,ended_at,active) VALUES (?,?,?,?,?,?)');
      for (const row of legacy.prepare('SELECT * FROM voice_events ORDER BY id').all()) {
        let mapped = findVoice.get(row.name,row.channel_id,row.started_at)?.id;
        if (!mapped) mapped = Number(insertVoice.run(row.name,row.channel_id,row.started_by,row.started_at,row.ended_at,row.active).lastInsertRowid);
        voiceMap.set(Number(row.id), Number(mapped));
      }
      if (tableExists(legacy,'voice_event_progress')) {
        const ins = target.prepare('INSERT OR IGNORE INTO voice_event_progress (event_id,user_id,qualified_minutes) VALUES (?,?,?)');
        for (const row of legacy.prepare('SELECT * FROM voice_event_progress').all()) {
          const mapped = voiceMap.get(Number(row.event_id));
          if (mapped) ins.run(mapped,row.user_id,row.qualified_minutes);
        }
      }
    }

    const eventMap = new Map();
    if (tableExists(legacy,'community_events')) {
      const findEvent = target.prepare('SELECT id FROM community_events WHERE title=? AND start_at=? AND created_at=? LIMIT 1');
      const insertEvent = target.prepare('INSERT INTO community_events (title,description,start_at,duration_minutes,voice_channel_id,status,created_by,created_at,public_message_id,reminded_30,reminded_5,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const row of legacy.prepare('SELECT * FROM community_events ORDER BY id').all()) {
        let mapped = findEvent.get(row.title,row.start_at,row.created_at)?.id;
        if (!mapped) {
          mapped = Number(insertEvent.run(row.title,row.description,row.start_at,row.duration_minutes,row.voice_channel_id,row.status,row.created_by,row.created_at,row.public_message_id,row.reminded_30,row.reminded_5,row.started_at,row.ended_at).lastInsertRowid);
          summary.events++;
        }
        eventMap.set(Number(row.id), Number(mapped));
      }
      if (tableExists(legacy,'event_rsvps')) {
        const ins = target.prepare('INSERT OR IGNORE INTO event_rsvps (event_id,user_id,status,updated_at) VALUES (?,?,?,?)');
        for (const row of legacy.prepare('SELECT * FROM event_rsvps').all()) {
          const mapped = eventMap.get(Number(row.event_id));
          if (mapped) ins.run(mapped,row.user_id,row.status,row.updated_at);
        }
      }
      if (tableExists(legacy,'event_attendance')) {
        const ins = target.prepare('INSERT OR IGNORE INTO event_attendance (event_id,user_id,first_seen_at,last_seen_at,minutes) VALUES (?,?,?,?,?)');
        for (const row of legacy.prepare('SELECT * FROM event_attendance').all()) {
          const mapped = eventMap.get(Number(row.event_id));
          if (mapped) ins.run(mapped,row.user_id,row.first_seen_at,row.last_seen_at,row.minutes);
        }
      }
    }

    target.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(markerKey, String(Date.now()));
    target.exec('COMMIT');
    console.log(`[LEGACY MIGRATION ${id}] COMPLETE · users=${summary.users} · legacyXP=${summary.legacyXp} · xpLog=${summary.xpLog} · referrals=${summary.referrals} · social=${summary.social} · suggestions=${summary.suggestions} · events=${summary.events} · backup=${backupPath}`);
    return summary;
  } catch (error) {
    try { target.exec('ROLLBACK'); } catch {}
    console.error(`[LEGACY MIGRATION ${id}] FAILED:`, error);
    throw error;
  } finally {
    legacy.close();
  }
}

function getGuildDb(guildId) {
  const id = String(guildId);
  let database = guildDbs.get(id);
  if (database) return database;
  database = new DatabaseSync(guildDatabasePath(id));
  initializeGuildDatabase(database);
  guildDbs.set(id, database);
  return database;
}

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? DEFAULT_SETTINGS[key] ?? null;
}
function getSettingInt(key) {
  return Number.parseInt(getSetting(key) ?? '0', 10) || 0;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function normalizeXpLabel(raw) {
  const label = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z]{1,6}$/.test(label) ? label : null;
}

function xpLabel() {
  return normalizeXpLabel(getSetting('xp_label')) ?? 'KXP';
}

function communityName() {
  const value = String(getSetting('community_name') ?? '').trim();
  return value || 'Community';
}

function communityNameUpper() {
  return communityName().toUpperCase().slice(0, 40);
}

function normalizeBrandAccent(raw) {
  const match = String(raw ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function brandAccent() {
  return normalizeBrandAccent(getSetting('brand_accent')) ?? '#FF5A1F';
}

function accentRgba(hex, alpha) {
  const normalized = normalizeBrandAccent(hex) ?? '#FF5A1F';
  const value = Number.parseInt(normalized.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function moduleEnabled(key) {
  return getSetting(`module_${key}`) !== '0';
}

function applyServerPreset(preset) {
  const name = preset === 'community' ? 'community' : 'klineo';
  setSetting('profile_preset', name);
  const values = name === 'klineo'
    ? { signal_room: 1, kreator: 1, founder_hub: 1, liquidity_studio: 1 }
    : { signal_room: 1, kreator: 0, founder_hub: 0, liquidity_studio: 0 };
  for (const [key, enabled] of Object.entries(values)) setSetting(`module_${key}`, enabled ? 1 : 0);
  return values;
}

function coreRoleName() {
  return communityName().toLowerCase() === 'klineo' ? 'KLINEO CORE' : 'COMMUNITY CORE';
}

function teamRoleName() {
  return communityName().toLowerCase() === 'klineo' ? 'KLINEO TEAM' : 'COMMUNITY TEAM';
}

function categoryName(key) {
  if (key === 'community') return `💬・${communityNameUpper()} COMMUNITY`;
  if (key === 'social' || key === 'creators') return '🎨・KREATOR HUB';
  if (key === 'kxp') return `⚡・${xpLabel()}`;
  return CATEGORY_NAMES[key];
}

function xpSlug() {
  return xpLabel().toLowerCase();
}
function xpChannelName(kind) {
  if (kind === 'how') return `⚡・how-to-earn-${xpSlug()}`;
  if (kind === 'leaderboard') return `🏆・${xpSlug()}-leaderboard`;
  if (kind === 'log') return `⚡・${xpSlug()}-log`;
  throw new Error(`Unknown XP channel kind: ${kind}`);
}
function xpChannelBase(kind) {
  return baseChannelName(xpChannelName(kind));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const BRAND = {
  lime: 0xB8F03A,
  limeSoft: 0xC5F24D,
  white: 0xFFFFFF,
  gray: 0x9CA3AF,
  darkGray: 0x6B7280,
  cyan: 0x22D3EE,
  emerald: 0x10B981,
  rose: 0xFB7185,
  blue: 0x60A5FA,
};

const RANKS = [
  { key: 'l1', name: 'OBSERVER', threshold: 0, color: BRAND.darkGray },
  { key: 'l2', name: 'SCOUT', threshold: 300, color: BRAND.blue },
  { key: 'l3', name: 'ANALYST', threshold: 1000, color: BRAND.cyan },
  { key: 'l4', name: 'OPERATOR', threshold: 2000, color: BRAND.emerald },
  { key: 'l5', name: 'STRATEGIST', threshold: 10000, color: BRAND.lime },
  { key: 'l6', name: 'VANGUARD', threshold: 25000, color: BRAND.limeSoft },
  { key: 'l7', name: 'PRIME', threshold: 50000, color: BRAND.white },
];

const ROLE_SPECS = [
  { key: 'core', name: 'KLINEO CORE', color: BRAND.white, hoist: true, permissions: [PermissionFlagsBits.Administrator] },
  { key: 'team', name: 'KLINEO TEAM', color: BRAND.lime, hoist: true, permissions: [] },
  {
    key: 'moderator',
    name: 'MODERATOR',
    color: BRAND.cyan,
    hoist: true,
    permissions: [
      PermissionFlagsBits.ViewAuditLog,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ManageNicknames,
      PermissionFlagsBits.MuteMembers,
      PermissionFlagsBits.DeafenMembers,
      PermissionFlagsBits.MoveMembers,
      PermissionFlagsBits.ManageEvents,
    ],
  },
  { key: 'verified', name: 'VERIFIED MEMBER', color: BRAND.gray, hoist: false, permissions: [] },
  { key: 'studio', name: 'STUDIO CLIENT', color: 0xF59E0B, hoist: true, permissions: [] },
  { key: 'founder', name: 'VERIFIED FOUNDER', color: BRAND.emerald, hoist: true, permissions: [] },
  { key: 'partner', name: 'PARTNER', color: BRAND.blue, hoist: true, permissions: [] },
  { key: 'creator', name: 'KREATOR', color: 0xA855F7, hoist: true, permissions: [] },
  { key: 'ambassador', name: 'AMBASSADOR', color: BRAND.limeSoft, hoist: true, permissions: [] },
  ...[...RANKS].reverse().map((rank) => ({ ...rank, hoist: false, permissions: [] })),
];

function roleSpecsForServer() {
  return ROLE_SPECS
    .filter((spec) => {
      if (spec.key === 'creator') return moduleEnabled('kreator');
      if (spec.key === 'founder') return moduleEnabled('founder_hub');
      if (spec.key === 'studio') return moduleEnabled('liquidity_studio');
      return true;
    })
    .map((spec) => {
      if (spec.key === 'core') return { ...spec, name: coreRoleName() };
      if (spec.key === 'team') return { ...spec, name: teamRoleName() };
      return spec;
    });
}

const PUBLIC_NO_LINK_CHANNELS = new Set([
  'general', 'market-chat', 'trade-setups', 'ai-agent-lab', 'product-feedback', 'bug-reports', 'help',
  'introductions', 'wins-and-learnings',
]);

const SIGNAL_CHANNELS = new Set(['analyst-chat', 'trade-analysis', 'market-thesis', 'ai-strategies']);
const MESSAGE_XP_CHANNELS = new Set([
  ...PUBLIC_NO_LINK_CHANNELS,
  ...SIGNAL_CHANNELS,
  'strategist-room', 'vanguard-lounge', 'prime-room',
]);
MESSAGE_XP_CHANNELS.delete('bug-reports'); // Bug reports earn KXP only after staff validation.
const messageCooldowns = new Map();
const inviteUseCaches = new Map();
const statsUpdateTimers = new Map();
const leaderboardUpdateTimers = new Map();
const healthUpdateTimers = new Map();
const announcementDrafts = new Map();
const modInboxUpdateTimers = new Map();
const setupPhases = new Map();

function inviteCacheForGuild(guildId) {
  const id = String(guildId);
  if (!inviteUseCaches.has(id)) inviteUseCaches.set(id, new Map());
  return inviteUseCaches.get(id);
}

function scheduleGuildTimeout(timerMap, guild, delay, fn) {
  const id = String(guild.id);
  const current = timerMap.get(id);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => runWithGuild(id, fn), delay);
  timerMap.set(id, timer);
}

function setSetupPhase(phase) {
  const guildId = guildDbContext.getStore() ?? 'global';
  setupPhases.set(String(guildId), phase);
  console.log(`[LINKO SETUP ${guildId}] ${phase}`);
}

function getSetupPhase() {
  const guildId = guildDbContext.getStore() ?? 'global';
  return setupPhases.get(String(guildId)) ?? 'idle';
}

function errorText(error) {
  if (!error) return 'Unknown error';
  return error.stack || error.message || String(error);
}

function logLinkoError(context, error) {
  const line = `\n[${new Date().toISOString()}] ${context}\n${errorText(error)}\n`;
  console.error(line);
  try { appendFileSync('data/linko-errors.log', line, 'utf8'); } catch {}
}

function contextualError(context, error) {
  const wrapped = new Error(`${context}: ${error?.message ?? String(error)}`);
  wrapped.cause = error;
  if (error?.stack) wrapped.stack += `\n--- caused by ---\n${error.stack}`;
  return wrapped;
}

const CATEGORY_NAMES = {
  stats: '📊・SERVER STATS',
  start: '👋・START HERE',
  community: '💬・KLINEO COMMUNITY',
  kxp: '⚡・KXP',
  signal: '📈・SIGNAL ROOM',
  social: '🎨・KREATOR HUB',
  creators: '🎨・KREATOR HUB',
  founders: '🏛️・FOUNDERS HUB',
  studio: '💧・LIQUIDITY STUDIO',
  high: '◆・HIGHER LEVELS',
  voice: '🎙️・VOICE',
  languages: '🌍・COMMUNITIES',
  staff: '🛡️・STAFF',
};

const CHANNEL_NAMES = {
  welcome: '👋・welcome', rules: '📜・rules', verify: '✅・verify', links: '🔗・official-links', announcements: '📢・announcements',
  general: '💬・general', marketChat: '📊・market-chat', tradeSetups: '🎯・trade-setups', aiAgentLab: '🤖・ai-agent-lab',
  productUpdates: '🚀・product-updates', productFeedback: '💡・product-feedback', bugReports: '🐞・bug-reports', help: '🆘・help', introductions: '👤・introductions', wins: '🏆・wins-and-learnings',
  howKxp: '⚡・how-to-earn-kxp', botCommands: '🤖・bot-commands', leaderboard: '🏆・kxp-leaderboard', communityLeaderboard: '👥・community-leaderboard', referralLeaderboard: '🤝・referral-leaderboard', rankUps: '📈・rank-ups', referrals: '🤝・referrals', events: '📅・events',
  analystChat: '🧠・analyst-chat', tradeAnalysis: '📉・trade-analysis', marketThesis: '🌐・market-thesis', aiStrategies: '🤖・ai-strategies',
  sharePost: '📣・published-kontents', contentMissions: '🎯・content-missions', creatorLeaderboard: '🏅・kreator-leaderboard', campaignLeaderboard: '🏁・campaign-leaderboard',
  creatorLounge: '🎨・kreator-lounge', contentCollabs: '🤝・content-and-collabs', creatorOpportunities: '💼・creator-opportunities',
  founderLobby: '🏛️・founder-lobby', founderDirectory: '📇・founder-directory', liquidityStudio: '💧・liquidity-studio', marketStructure: '📐・market-structure', founderResources: '📚・founder-resources', studioRequests: '📩・studio-requests',
  studioAnnouncements: '📢・studio-announcements', clientSupport: '🆘・client-support',
  strategist: '♟️・strategist-room', vanguard: '🛡️・vanguard-lounge', prime: '💎・prime-room',
  productRoadmap: '🧩・product-roadmap', languageAccess: '🌐・language-access',
  teamChat: '💬・team-chat', modCommands: '🛠️・mod-commands', communityHealth: '📊・community-health', modInbox: '📥・mod-inbox', suggestionReview: '💡・suggestion-review', verificationLog: '✅・verification-log', founderVerification: '🏛️・founder-verification', kreatorApplications: '🎨・kreator-applications', socialSubmissions: '📥・content-submissions', moderation: '🛡️・moderation', securityAlerts: '🚨・security-alerts', kxpLog: '⚡・kxp-log', walletLog: '🔐・wallet-log', botLog: '🤖・bot-log',
};

const INTERESTS = [
  ['trading', 'TRADING', BRAND.lime],
  ['ai', 'AI', BRAND.cyan],
  ['markets', 'MARKETS', BRAND.blue],
  ['product', 'PRODUCT', BRAND.emerald],
  ['founders', 'FOUNDERS', 0xF59E0B],
  ['liquidity', 'LIQUIDITY', BRAND.rose],
  ['creators', 'CREATORS', BRAND.limeSoft],
];
const INTEREST_ROLE_PREFIX = 'INTEREST · ';
const LANGUAGE_ROLE_PREFIX = 'COMM · ';

const LANGUAGE_DEMAND_THRESHOLD = 3;
// Compatibility note: the existing language_* SQLite tables remain in place so v10.16
// preferences survive this migration. Entries now represent Community choices and may
// be a country, region, or language-led community.
const BASE_LANGUAGE_CATALOG = [
  { key: 'english', name: 'Global', emoji: '🌐', global: true, aliases: ['english', 'global english', 'global'] },
  { key: 'hindi', name: 'India / Hindi', emoji: '🇮🇳', aliases: ['india', 'hindi', 'hindhi', 'hindy', 'india hindi'] },
  { key: 'urdu', name: 'Pakistan / Urdu', emoji: '🇵🇰', aliases: ['pakistan', 'urdu', 'pakistan urdu'] },
  { key: 'arabic', name: 'Arabic / GCC', emoji: '🌍', aliases: ['arabic', 'gcc', 'arabic gcc'] },
  { key: 'german', name: 'Germany / German', emoji: '🇩🇪', aliases: ['german', 'deutsch', 'germany', 'germany german'] },
  { key: 'nigeria', name: 'Nigeria', emoji: '🇳🇬', aliases: ['nigeria', 'nigerian', 'ng'] },
  { key: 'french', name: 'France / French', emoji: '🇫🇷', aliases: ['french', 'francais', 'français', 'france', 'france french'] },
  { key: 'spanish', name: 'Spanish', emoji: '🇪🇸', aliases: ['spanish', 'espanol', 'español', 'spain'] },
  { key: 'portuguese', name: 'Portugal / Portuguese', emoji: '🇵🇹', aliases: ['portuguese', 'portugues', 'português', 'portugal'] },
  { key: 'italian', name: 'Italy / Italian', emoji: '🇮🇹', aliases: ['italian', 'italiano', 'italy'] },
  { key: 'polish', name: 'Poland / Polish', emoji: '🇵🇱', aliases: ['polish', 'polski', 'poland'] },
  { key: 'czech', name: 'Czechia / Czech', emoji: '🇨🇿', aliases: ['czech', 'cesky', 'čeština', 'czechia'] },
  { key: 'croatian', name: 'Balkans', emoji: '🌍', aliases: ['croatian', 'hrvatski', 'croatia', 'balkan', 'balkans'] },
  { key: 'romanian', name: 'Romania / Romanian', emoji: '🇷🇴', aliases: ['romanian', 'romana', 'română', 'romania'] },
  { key: 'turkish', name: 'Türkiye / Turkish', emoji: '🇹🇷', aliases: ['turkish', 'turkce', 'türkçe', 'turkey', 'türkiye'] },
  { key: 'indonesian', name: 'Indonesia', emoji: '🇮🇩', aliases: ['indonesian', 'bahasa indonesia', 'indonesia'] },
  { key: 'vietnamese', name: 'Vietnam', emoji: '🇻🇳', aliases: ['vietnamese', 'vietnam'] },
  { key: 'chinese', name: 'China / Chinese', emoji: '🇨🇳', aliases: ['chinese', 'mandarin', 'simplified chinese', 'china'] },
  { key: 'korean', name: 'Korea / Korean', emoji: '🇰🇷', aliases: ['korean', 'korea'] },
  { key: 'japanese', name: 'Japan / Japanese', emoji: '🇯🇵', aliases: ['japanese', 'japan'] },
  // Kept hidden only for backwards compatibility with existing v10.16 selections.
  { key: 'bengali', name: 'Bangladesh / Bengali', emoji: '🇧🇩', aliases: ['bengali', 'bangla', 'bangladesh'], hidden: true },
  { key: 'tamil', name: 'India / Tamil', emoji: '🇮🇳', aliases: ['tamil'], hidden: true },
];
const VISIBLE_COMMUNITY_CATALOG = BASE_LANGUAGE_CATALOG.filter((entry) => !entry.hidden);
function normalizeLanguageInput(raw) {
  return String(raw ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function baseLanguageByKey(key) { return BASE_LANGUAGE_CATALOG.find((x) => x.key === key) ?? null; }


function baseChannelName(name = '') {
  const i = name.indexOf('・');
  return i >= 0 ? name.slice(i + 1) : name;
}

const LEGACY_ROLE_NAMES = new Map([
  ['CREATOR', 'KREATOR'],
  ['L1 · OBSERVER', 'OBSERVER'], ['L2 · SCOUT', 'SCOUT'], ['L3 · ANALYST', 'ANALYST'], ['L4 · OPERATOR', 'OPERATOR'],
  ['L5 · STRATEGIST', 'STRATEGIST'], ['L6 · VANGUARD', 'VANGUARD'], ['L7 · PRIME', 'PRIME'],
]);
const LEGACY_CATEGORY_NAMES = new Map([
  ['00・START HERE', CATEGORY_NAMES.start], ['01・KLINEO COMMUNITY', CATEGORY_NAMES.community], ['02・KXP', CATEGORY_NAMES.kxp],
  ['03・SIGNAL ROOM', CATEGORY_NAMES.signal], ['04・KLINEO SOCIAL', CATEGORY_NAMES.social], ['05・CREATOR HUB', CATEGORY_NAMES.creators],
  ['📣・KLINEO SOCIAL', CATEGORY_NAMES.social], ['🎨・CREATOR HUB', CATEGORY_NAMES.creators],
  ['🎨・KREATOR HUB', CATEGORY_NAMES.creators],
  ['06・FOUNDERS HUB', CATEGORY_NAMES.founders], ['07・LIQUIDITY STUDIO', CATEGORY_NAMES.studio], ['08・HIGHER LEVELS', CATEGORY_NAMES.high],
  ['09・VOICE', CATEGORY_NAMES.voice], ['10・STAFF', CATEGORY_NAMES.staff],
]);
const LEGACY_CHANNEL_NAMES = new Map([
  ['welcome', CHANNEL_NAMES.welcome], ['rules', CHANNEL_NAMES.rules], ['verify', CHANNEL_NAMES.verify], ['official-links', CHANNEL_NAMES.links], ['announcements', CHANNEL_NAMES.announcements],
  ['general', CHANNEL_NAMES.general], ['market-chat', CHANNEL_NAMES.marketChat], ['trade-setups', CHANNEL_NAMES.tradeSetups], ['ai-agent-lab', CHANNEL_NAMES.aiAgentLab],
  ['product-updates', CHANNEL_NAMES.productUpdates], ['product-feedback', CHANNEL_NAMES.productFeedback], ['bug-reports', CHANNEL_NAMES.bugReports], ['help', CHANNEL_NAMES.help], ['introductions', CHANNEL_NAMES.introductions], ['wins-and-learnings', CHANNEL_NAMES.wins],
  ['how-to-earn-kxp', CHANNEL_NAMES.howKxp], ['bot-commands', CHANNEL_NAMES.botCommands], ['leaderboard', CHANNEL_NAMES.leaderboard], ['🏆・leaderboard', CHANNEL_NAMES.leaderboard], ['kxp-leaderboard', CHANNEL_NAMES.leaderboard], ['community-leaderboard', CHANNEL_NAMES.communityLeaderboard], ['referral-leaderboard', CHANNEL_NAMES.referralLeaderboard], ['rank-ups', CHANNEL_NAMES.rankUps], ['referrals', CHANNEL_NAMES.referrals], ['events', CHANNEL_NAMES.events],
  ['analyst-chat', CHANNEL_NAMES.analystChat], ['trade-analysis', CHANNEL_NAMES.tradeAnalysis], ['market-thesis', CHANNEL_NAMES.marketThesis], ['ai-strategies', CHANNEL_NAMES.aiStrategies],
  ['share-your-post', CHANNEL_NAMES.sharePost], ['submit-your-post', CHANNEL_NAMES.sharePost], ['published-kontents', CHANNEL_NAMES.sharePost], ['community-directory', '🌐・community-directory'], ['content-missions', CHANNEL_NAMES.contentMissions], ['creator-leaderboard', CHANNEL_NAMES.creatorLeaderboard], ['🏅・creator-leaderboard', CHANNEL_NAMES.creatorLeaderboard], ['kreator-leaderboard', CHANNEL_NAMES.creatorLeaderboard], ['campaign-leaderboard', CHANNEL_NAMES.campaignLeaderboard],
  ['creator-lounge', CHANNEL_NAMES.creatorLounge], ['kreator-lounge', CHANNEL_NAMES.creatorLounge], ['content-and-collabs', CHANNEL_NAMES.contentCollabs], ['creator-opportunities', CHANNEL_NAMES.creatorOpportunities],
  ['founder-lobby', CHANNEL_NAMES.founderLobby], ['founder-directory', CHANNEL_NAMES.founderDirectory], ['liquidity-studio', CHANNEL_NAMES.liquidityStudio], ['market-structure', CHANNEL_NAMES.marketStructure], ['founder-resources', CHANNEL_NAMES.founderResources], ['studio-requests', CHANNEL_NAMES.studioRequests],
  ['studio-announcements', CHANNEL_NAMES.studioAnnouncements], ['client-support', CHANNEL_NAMES.clientSupport],
  ['strategist-room', CHANNEL_NAMES.strategist], ['vanguard-lounge', CHANNEL_NAMES.vanguard], ['prime-room', CHANNEL_NAMES.prime],
  ['team-chat', CHANNEL_NAMES.teamChat], ['mod-commands', CHANNEL_NAMES.modCommands], ['verification-log', CHANNEL_NAMES.verificationLog], ['profile-submissions', '📇・profile-submissions'], ['founder-verification', CHANNEL_NAMES.founderVerification], ['social-submissions', CHANNEL_NAMES.socialSubmissions], ['content-submissions', CHANNEL_NAMES.socialSubmissions], ['moderation', CHANNEL_NAMES.moderation], ['security-alerts', CHANNEL_NAMES.securityAlerts], ['kxp-log', CHANNEL_NAMES.kxpLog], ['wallet-log', CHANNEL_NAMES.walletLog], ['bot-log', CHANNEL_NAMES.botLog],
  ['Analyst Room', '🔊 Analyst Room'], ['Founder Roundtable', '🎙️ Founder Roundtable'], ['Strategy Room', '🎙️ Strategy Room'], ['Vanguard Room', '🎙️ Vanguard Room'],
  ['Trading Floor', '📈 Trading Floor'], ['Market Room', '🌐 Market Room'], ['AI Lab', '🤖 AI Lab'], ['Co-Working', '💻 Co-Working'], ['Community Lounge', '💬 Community Lounge'], ['KlineO AMA', '🎙️ KlineO AMA'], ['AFK', '💤 AFK'],
]);


const commands = [
  new SlashCommandBuilder()
    .setName('setup-linko')
    .setDescription('Build or sync LINKO in this Discord server.')
    .addBooleanOption((o) => o.setName('confirm').setDescription('Set true to build/sync.').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setup-klineo')
    .setDescription('KlineO alias: build or sync LINKO in this Discord server.')
    .addBooleanOption((o) => o.setName('confirm').setDescription('Set true to build/sync.').setRequired(true)),

  new SlashCommandBuilder().setName('rank').setDescription('Show your community rank and progress.')
    .addUserOption((o) => o.setName('member').setDescription('Optional member to view.')),
  new SlashCommandBuilder().setName('points').setDescription('Show your server XP balance.')
    .addUserOption((o) => o.setName('member').setDescription('Optional member to view.')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show a community leaderboard.')
    .addStringOption((o) => o.setName('type').setDescription('Leaderboard type').addChoices(
      { name: 'Overall KXP', value: 'kxp' }, { name: 'Community', value: 'community' }, { name: 'Referrals', value: 'referrals' },
      { name: 'KREATOR', value: 'creators' }, { name: 'Creator Campaign', value: 'campaign' },
    ))
    .addIntegerOption((o) => o.setName('campaign').setDescription('Campaign ID when viewing a campaign leaderboard').setMinValue(1)),
  new SlashCommandBuilder().setName('invite').setDescription('Create your tracked community invite link.'),
  new SlashCommandBuilder().setName('invites').setDescription('Show your community referral stats.'),
  new SlashCommandBuilder()
    .setName('join-source')
    .setDescription('Required before verification: tell LINKO how you joined community.')
    .addStringOption((o) => o.setName('source').setDescription('How did you find/join community?').setRequired(true).addChoices(
      { name: 'Invited by a community member', value: 'member' },
      { name: 'Found community myself', value: 'organic' },
      { name: 'X / social media', value: 'x' },
      { name: 'Telegram', value: 'telegram' },
      { name: 'Event / AMA', value: 'event' },
      { name: 'Partner / creator', value: 'partner' },
    ))
    .addUserOption((o) => o.setName('member').setDescription('Required only if a community member invited you.')),
  new SlashCommandBuilder()
    .setName('confirm-invited')
    .setDescription('Confirm that you personally invited a pending community member.')
    .addUserOption((o) => o.setName('member').setDescription('The member you invited').setRequired(true)),
  new SlashCommandBuilder()
    .setName('referred-by')
    .setDescription('Legacy shortcut: tell LINKO who invited you.')
    .addUserOption((o) => o.setName('member').setDescription('The community member who invited you').setRequired(true)),
  new SlashCommandBuilder().setName('commands').setDescription('Show the community member command guide.'),
  new SlashCommandBuilder().setName('profile').setDescription('Open your private LINKO member profile and onboarding dashboard.'),

  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your submitted community payout wallet addresses. LINKO never connects or signs.')
    .addSubcommand((sc) => sc.setName('view').setDescription('Privately view your submitted EVM and Solana wallets.'))
    .addSubcommand((sc) => sc.setName('set').setDescription('Add or change a submitted wallet address.')
      .addStringOption((o) => o.setName('network').setDescription('Wallet network').setRequired(true).addChoices(
        { name: 'EVM', value: 'evm' }, { name: 'Solana', value: 'solana' },
      ))
      .addStringOption((o) => o.setName('address').setDescription('Public wallet address only').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('x').setDescription('Your X account, e.g. @username or x.com/username').setRequired(true).setMaxLength(120))
      .addStringOption((o) => o.setName('telegram').setDescription('Your Telegram username, e.g. @username or t.me/username').setRequired(true).setMaxLength(120)))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Remove a submitted wallet address.')
      .addStringOption((o) => o.setName('network').setDescription('Wallet network').setRequired(true).addChoices(
        { name: 'EVM', value: 'evm' }, { name: 'Solana', value: 'solana' },
      )))
    .addSubcommand((sc) => sc.setName('primary').setDescription('Choose which submitted wallet is your primary payout wallet.')
      .addStringOption((o) => o.setName('network').setDescription('Primary network').setRequired(true).addChoices(
        { name: 'EVM', value: 'evm' }, { name: 'Solana', value: 'solana' },
      ))),

  new SlashCommandBuilder().setName('kreator-profile').setDescription('Submit or view your required KREATOR profile for approval.'),

  new SlashCommandBuilder()
    .setName('submit-content')
    .setDescription('Submit social content or a Signal Room contribution for review.')
    .addSubcommand((sc) => sc.setName('social').setDescription('Submit a social post for review.')
      .addStringOption((o) => o.setName('platform').setDescription('Platform').setRequired(true).addChoices(
        { name: 'X', value: 'x' }, { name: 'LinkedIn', value: 'linkedin' }, { name: 'YouTube', value: 'youtube' },
        { name: 'TikTok', value: 'tiktok' }, { name: 'Instagram', value: 'instagram' },
      ))
      .addStringOption((o) => o.setName('url').setDescription('Direct URL to your post').setRequired(true))
      .addIntegerOption((o) => o.setName('campaign').setDescription('KREATOR only: optional active campaign ID').setMinValue(1)))
    .addSubcommand((sc) => sc.setName('signal').setDescription('Submit original content for a Signal Room section.')
      .addStringOption((o) => o.setName('section').setDescription('Where should approved content be published?').setRequired(true).addChoices(
        { name: 'Analyst Chat', value: 'analyst-chat' },
        { name: 'Trade Analysis', value: 'trade-analysis' },
        { name: 'Market Thesis', value: 'market-thesis' },
        { name: 'AI Strategies', value: 'ai-strategies' },
      ))
      .addStringOption((o) => o.setName('title').setDescription('Short title').setRequired(true).setMaxLength(120))
      .addStringOption((o) => o.setName('content').setDescription('Your analysis / signal / thesis').setRequired(true).setMaxLength(3500))
      .addStringOption((o) => o.setName('source').setDescription('Optional supporting https:// source').setMaxLength(500))),

  new SlashCommandBuilder()
    .setName('creator-campaign')
    .setDescription('Staff: manage community creator campaigns.')
    .addSubcommand((sc) => sc.setName('create').setDescription('Create a creator campaign.')
      .addStringOption((o) => o.setName('name').setDescription('Campaign name').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('description').setDescription('Short campaign brief').setMaxLength(300)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List creator campaigns.'))
    .addSubcommand((sc) => sc.setName('close').setDescription('Close a creator campaign and freeze its board.')
      .addIntegerOption((o) => o.setName('campaign').setDescription('Campaign ID').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('social-card')
    .setDescription('Generate a shareable community social card.')
    .addStringOption((o) => o.setName('type').setDescription('Card type').setRequired(true).addChoices(
      { name: 'Progress', value: 'progress' }, { name: 'Referral', value: 'referral' },
      { name: 'Community Impact', value: 'impact' }, { name: 'Founder', value: 'founder' },
    )),

  new SlashCommandBuilder()
    .setName('official-links')
    .setDescription('Staff: manage verified community official links.')
    .addSubcommand((sc) => sc.setName('view').setDescription('View configured official links.'))
    .addSubcommand((sc) => sc.setName('publish').setDescription('Refresh the public Official Links card.'))
    .addSubcommand((sc) => sc.setName('set').setDescription('Core: set an official community link.')
      .addStringOption((o) => o.setName('type').setDescription('Official link type').setRequired(true).addChoices(
        { name: 'Website', value: 'website' }, { name: 'Liquidity Studio', value: 'liquidity_studio' },
        { name: 'X', value: 'x' }, { name: 'Telegram', value: 'telegram' }, { name: 'LinkedIn', value: 'linkedin' },
        { name: 'Docs', value: 'docs' }, { name: 'Support', value: 'support' },
      ))
      .addStringOption((o) => o.setName('url').setDescription('Verified https:// URL').setRequired(true).setMaxLength(300)))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Core: remove an official community link.')
      .addStringOption((o) => o.setName('type').setDescription('Official link type').setRequired(true).addChoices(
        { name: 'Website', value: 'website' }, { name: 'Liquidity Studio', value: 'liquidity_studio' },
        { name: 'X', value: 'x' }, { name: 'Telegram', value: 'telegram' }, { name: 'LinkedIn', value: 'linkedin' },
        { name: 'Docs', value: 'docs' }, { name: 'Support', value: 'support' },
      ))),

  new SlashCommandBuilder()
    .setName('team-profile')
    .setDescription('Staff: manage official community founder/team profiles.')
    .addSubcommand((sc) => sc.setName('list').setDescription('List configured team profiles.'))
    .addSubcommand((sc) => sc.setName('set').setDescription('Core: add or update an official team profile.')
      .addUserOption((o) => o.setName('member').setDescription('Official community team member').setRequired(true))
      .addStringOption((o) => o.setName('role').setDescription('Role/title, e.g. Founder & CEO').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('website').setDescription('Website URL').setMaxLength(300))
      .addStringOption((o) => o.setName('x').setDescription('X profile URL').setMaxLength(300))
      .addStringOption((o) => o.setName('linkedin').setDescription('LinkedIn profile URL').setMaxLength(300))
      .addStringOption((o) => o.setName('telegram').setDescription('Telegram profile URL').setMaxLength(300)))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Core: remove an official team profile.')
      .addUserOption((o) => o.setName('member').setDescription('Team member').setRequired(true))),

  new SlashCommandBuilder().setName('apply-founder').setDescription('Apply for verified Founder Hub access.'),

  new SlashCommandBuilder()
    .setName('give-xp')
    .setDescription('Staff: audited manual XP, including verified platform/trading activity.')
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('Positive or negative XP').setRequired(true).setMinValue(-10000).setMaxValue(10000))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(180)),

  new SlashCommandBuilder()
    .setName('remove-xp')
    .setDescription('Staff: remove XP from a member.')
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('XP to remove').setRequired(true).setMinValue(1).setMaxValue(10000))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(180)),

  new SlashCommandBuilder()
    .setName('user-kxp')
    .setDescription('Staff: show a detailed XP report for a member.')
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)),

  new SlashCommandBuilder()
    .setName('set-boost-count')
    .setDescription('Staff: set a verified active boost count for a member.')
    .addUserOption((o) => o.setName('member').setDescription('Server booster').setRequired(true))
    .addIntegerOption((o) => o.setName('count').setDescription('Active boosts; use 0 to clear override').setRequired(true).setMinValue(0).setMaxValue(20)),

  new SlashCommandBuilder()
    .setName('referral-stats')
    .setDescription('Staff: show referral stats for a member.')
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)),

  new SlashCommandBuilder()
    .setName('confirm-referral')
    .setDescription('Staff: manually confirm a real 7-day referral when no tracked invite was used.')
    .addUserOption((o) => o.setName('member').setDescription('Member who was referred').setRequired(true))
    .addUserOption((o) => o.setName('inviter').setDescription('Member who invited them').setRequired(true)),

  new SlashCommandBuilder()
    .setName('impact-status')
    .setDescription('Staff: inspect LINKO impact signals for a Discord message.')
    .addStringOption((o) => o.setName('message').setDescription('Discord message link').setRequired(true).setMaxLength(300)),

  new SlashCommandBuilder()
    .setName('mark-impactful')
    .setDescription('Staff: confirm a message as impactful and award normal message XP.')
    .addStringOption((o) => o.setName('message').setDescription('Discord message link').setRequired(true).setMaxLength(300)),

  new SlashCommandBuilder()
    .setName('remove-message-xp')
    .setDescription('Staff: reverse XP previously awarded to a qualified community message.')
    .addStringOption((o) => o.setName('message').setDescription('Discord message link').setRequired(true).setMaxLength(300)),

  new SlashCommandBuilder().setName('impact-settings').setDescription('Staff: view LINKO message-impact qualification settings.'),
  new SlashCommandBuilder()
    .setName('set-impact')
    .setDescription('Staff: tune LINKO message-impact qualification settings.')
    .addStringOption((o) => o.setName('setting').setDescription('Impact setting').setRequired(true).addChoices(
      { name: 'Minimum impact score', value: 'impact_min_score' },
      { name: 'Evaluation delay (seconds)', value: 'impact_delay_seconds' },
      { name: 'Candidate window (minutes)', value: 'impact_candidate_window_minutes' },
      { name: 'Minimum words', value: 'impact_min_words' },
      { name: 'Minimum alphabetic characters', value: 'impact_min_alpha_chars' },
    ))
    .addIntegerOption((o) => o.setName('value').setDescription('New value').setRequired(true).setMinValue(1).setMaxValue(1440)),

  new SlashCommandBuilder().setName('refresh-leaderboard').setDescription('Staff: refresh all persistent leaderboards now.'),
  new SlashCommandBuilder()
    .setName('export-leaderboard')
    .setDescription('Staff: export the complete leaderboard/community ranking as CSV.')
    .addStringOption((o) => o.setName('type').setDescription('CSV export type').setRequired(true).addChoices(
      { name: 'Overall Leaderboard', value: 'kxp' },
      { name: 'Community Leaderboard', value: 'community' },
      { name: 'KREATOR Leaderboard', value: 'creators' },
      { name: 'Referral Leaderboard', value: 'referrals' },
      { name: 'Full Community', value: 'full' },
    )),
  new SlashCommandBuilder()
    .setName('wallet-admin')
    .setDescription('Core: privately inspect a member’s submitted wallet addresses.')
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder()
    .setName('export-wallets')
    .setDescription('Core: export submitted wallet addresses as a private CSV.')
    .addStringOption((o) => o.setName('network').setDescription('Wallets to export').setRequired(true).addChoices(
      { name: 'All', value: 'all' }, { name: 'EVM', value: 'evm' }, { name: 'Solana', value: 'solana' },
    )),
  new SlashCommandBuilder().setName('refresh-stats').setDescription('Staff: refresh live server counters now.'),
  new SlashCommandBuilder().setName('mod-help').setDescription('Staff: show the LINKO moderator command guide.'),

  new SlashCommandBuilder()
    .setName('project-profile')
    .setDescription('Core/Admin: view or configure the project context LINKO uses.')
    .addSubcommand((sc) => sc.setName('view').setDescription('View the current project profile.'))
    .addSubcommand((sc) => sc.setName('configure').setDescription('Open the core project profile form.'))
    .addSubcommand((sc) => sc.setName('details').setDescription('Edit products, status, first action, website and guidance.'))
    .addSubcommand((sc) => sc.setName('links').setDescription('Edit the branded product links shown in the welcome message.')),

  new SlashCommandBuilder()
    .setName('server-settings')
    .setDescription('Administrator: view or change this server\'s LINKO profile.')
    .addSubcommand((sc) => sc.setName('view').setDescription('View server-level LINKO settings.'))
    .addSubcommand((sc) => sc.setName('community-name').setDescription('Set the community/project display name.')
      .addStringOption((o) => o.setName('name').setDescription('Example: community, Polkadot').setRequired(true).setMinLength(2).setMaxLength(40)))
    .addSubcommand((sc) => sc.setName('xp-name').setDescription('Set the server XP label (1-6 letters).')
      .addStringOption((o) => o.setName('name').setDescription('Example: KXP, DOTXP, XP').setRequired(true).setMinLength(1).setMaxLength(6)))
    .addSubcommand((sc) => sc.setName('brand-color').setDescription('Set the accent color used on LINKO shareable cards.')
      .addStringOption((o) => o.setName('hex').setDescription('6-digit hex, e.g. #FF5A1F').setRequired(true).setMinLength(6).setMaxLength(7)))
    .addSubcommand((sc) => sc.setName('preset').setDescription('Apply a safe module preset before setup.')
      .addStringOption((o) => o.setName('type').setDescription('Server profile preset').setRequired(true).addChoices(
        { name: 'KlineO Full', value: 'klineo' },
        { name: 'Core Community', value: 'community' },
      )))
    .addSubcommand((sc) => sc.setName('module').setDescription('Enable or disable an optional LINKO module.')
      .addStringOption((o) => o.setName('name').setDescription('Module').setRequired(true).addChoices(
        { name: 'Signal Room', value: 'signal_room' },
        { name: 'KREATOR', value: 'kreator' },
        { name: 'Founder Hub', value: 'founder_hub' },
        { name: 'Liquidity Studio', value: 'liquidity_studio' },
      ))
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or disable').setRequired(true))),

  new SlashCommandBuilder().setName('xp-settings').setDescription('Staff: view current XP earning settings.'),
  new SlashCommandBuilder().setName('kxp-settings').setDescription('KlineO alias: view current XP earning settings.'),
  new SlashCommandBuilder()
    .setName('set-xp')
    .setDescription('Staff: change an XP reward value from Discord.')
    .addStringOption((o) => o.setName('event').setDescription('XP event').setRequired(true).addChoices(
      { name: 'Qualifying message', value: 'kxp_message' },
      { name: 'Official voice · 15-minute listening', value: 'kxp_voice_interval' },
      { name: 'Official voice · speaker participation bonus', value: 'kxp_voice_speaker_bonus' },
      { name: 'Valid referral', value: 'kxp_valid_referral' },
      { name: 'Approved social post', value: 'kxp_social_post' },
      { name: 'Creator reaction milestone', value: 'creator_reaction_kxp' },
      { name: 'Valid bug report', value: 'kxp_bug_report' },
      { name: 'Profile / wallet first-time submission', value: 'kxp_profile_submission' },
      { name: 'Active server boost / day', value: 'kxp_boost_daily' },
    ))
    .addIntegerOption((o) => o.setName('amount').setDescription('XP amount').setRequired(true).setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('set-kxp')
    .setDescription('KlineO alias: change an XP reward value from Discord.')
    .addStringOption((o) => o.setName('event').setDescription('XP event').setRequired(true).addChoices(
      { name: 'Qualifying message', value: 'kxp_message' },
      { name: 'Official voice · 15-minute listening', value: 'kxp_voice_interval' },
      { name: 'Official voice · speaker participation bonus', value: 'kxp_voice_speaker_bonus' },
      { name: 'Valid referral', value: 'kxp_valid_referral' },
      { name: 'Approved social post', value: 'kxp_social_post' },
      { name: 'Creator reaction milestone', value: 'creator_reaction_kxp' },
      { name: 'Valid bug report', value: 'kxp_bug_report' },
      { name: 'Profile / wallet first-time submission', value: 'kxp_profile_submission' },
      { name: 'Active server boost / day', value: 'kxp_boost_daily' },
    ))
    .addIntegerOption((o) => o.setName('amount').setDescription('XP amount').setRequired(true).setMinValue(0).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName('leaderboard-settings')
    .setDescription('Staff: view or change leaderboard visibility.')    .addStringOption((o) => o.setName('board').setDescription('Leaderboard').addChoices(
      { name: 'Overall KXP', value: 'kxp' }, { name: 'Community', value: 'community' }, { name: 'Referrals', value: 'referrals' },
      { name: 'KREATOR', value: 'creators' }, { name: 'Creator Campaigns', value: 'campaign' },
    ))
    .addStringOption((o) => o.setName('visibility').setDescription('Visibility').addChoices(
      { name: 'Public to verified members', value: 'public' }, { name: 'Private to staff', value: 'private' },
    )),

  new SlashCommandBuilder()
    .setName('voice-event')
    .setDescription('Staff: control official voice events that can earn XP.')
    .addSubcommand((s) => s.setName('start').setDescription('Start XP for an official voice or Stage event.')
      .addChannelOption((o) => o.setName('channel').setDescription('Official event Voice/Stage channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
      .addStringOption((o) => o.setName('name').setDescription('Event name').setRequired(true).setMaxLength(80)))
    .addSubcommand((s) => s.setName('speaker').setDescription('Staff: confirm a speaker bonus for the active official event.')
      .addUserOption((o) => o.setName('member').setDescription('Verified member who participated as a speaker').setRequired(true)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the currently active voice XP event.'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the currently active voice XP event.')),

  new SlashCommandBuilder()
    .setName('approve-bug')
    .setDescription('Staff: award the configured XP for a valid bug report.')
    .addUserOption((o) => o.setName('member').setDescription('Member who reported the bug').setRequired(true))
    .addStringOption((o) => o.setName('reference').setDescription('Bug/message reference').setRequired(false).setMaxLength(180)),

  new SlashCommandBuilder()
    .setName('server-image')
    .setDescription('Staff: manage community welcome and section images.')
    .addSubcommand((sc) => sc.setName('set').setDescription('Upload/set an image for a community section.')
      .addStringOption((o) => o.setName('slot').setDescription('Image slot').setRequired(true).addChoices(
        { name: 'Welcome', value: 'welcome' }, { name: 'Verification', value: 'verify' }, { name: 'Official Links', value: 'official' }, { name: 'Social', value: 'social' }, { name: 'Founder Hub', value: 'founder' },
      ))
      .addAttachmentOption((o) => o.setName('image').setDescription('PNG/JPG/WEBP image').setRequired(true)))
    .addSubcommand((sc) => sc.setName('clear').setDescription('Remove a configured section image.')
      .addStringOption((o) => o.setName('slot').setDescription('Image slot').setRequired(true).addChoices(
        { name: 'Welcome', value: 'welcome' }, { name: 'Verification', value: 'verify' }, { name: 'Official Links', value: 'official' }, { name: 'Social', value: 'social' }, { name: 'Founder Hub', value: 'founder' },
      )))
    .addSubcommand((sc) => sc.setName('status').setDescription('Show which community section images are configured.')),

  new SlashCommandBuilder()
    .setName('grant-klineo-role')
    .setDescription('Staff: grant a community access role.')
    .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('role').setDescription('Role').setRequired(true).addChoices(
      { name: 'Verified Founder', value: 'VERIFIED FOUNDER' },
      { name: 'Studio Client', value: 'STUDIO CLIENT' },
      { name: 'Partner', value: 'PARTNER' },
      { name: 'Kreator', value: 'KREATOR' },
      { name: 'Ambassador', value: 'AMBASSADOR' },
    )),

  new SlashCommandBuilder()
    .setName('create-client-space')
    .setDescription('Staff: create a private Liquidity Studio workspace.')
    .addStringOption((o) => o.setName('project').setDescription('Project name').setRequired(true).setMaxLength(40))
    .addUserOption((o) => o.setName('member').setDescription('Primary client representative').setRequired(true)),

  new SlashCommandBuilder().setName('onboarding').setDescription('Show your community activation checklist.'),

  new SlashCommandBuilder()
    .setName('interest')
    .setDescription('Manage your community interest roles.')
    .addSubcommand((sc) => sc.setName('add').setDescription('Add an interest.')
      .addStringOption((o) => o.setName('interest').setDescription('Interest').setRequired(true).addChoices(
        { name: 'Trading', value: 'trading' }, { name: 'AI', value: 'ai' }, { name: 'Markets', value: 'markets' },
        { name: 'Product', value: 'product' }, { name: 'Founders', value: 'founders' }, { name: 'Liquidity', value: 'liquidity' }, { name: 'Creators', value: 'creators' },
      )))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Remove an interest.')
      .addStringOption((o) => o.setName('interest').setDescription('Interest').setRequired(true).addChoices(
        { name: 'Trading', value: 'trading' }, { name: 'AI', value: 'ai' }, { name: 'Markets', value: 'markets' },
        { name: 'Product', value: 'product' }, { name: 'Founders', value: 'founders' }, { name: 'Liquidity', value: 'liquidity' }, { name: 'Creators', value: 'creators' },
      )))
    .addSubcommand((sc) => sc.setName('list').setDescription('Show your selected interests.')),

  new SlashCommandBuilder()
    .setName('language')
    .setDescription('Manage your community language channels.')
    .addSubcommand((sc) => sc.setName('add').setDescription('Join a language community.')
      .addRoleOption((o) => o.setName('role').setDescription('A COMM · role created by LINKO').setRequired(true)))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Leave a language community.')
      .addRoleOption((o) => o.setName('role').setDescription('A COMM · role created by LINKO').setRequired(true)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List available community languages.')),

  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Submit a community product suggestion.')
    .addStringOption((o) => o.setName('title').setDescription('Short suggestion title').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('details').setDescription('What should change and why?').setRequired(true).setMaxLength(1200)),

  new SlashCommandBuilder().setName('events').setDescription('Show upcoming community community events.'),

  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Core/Team: preview and publish an official announcement.')
    .addStringOption((o) => o.setName('title').setDescription('Optional announcement title').setMaxLength(200))
    .addAttachmentOption((o) => o.setName('image').setDescription('Optional announcement image'))
    .addStringOption((o) => o.setName('message').setDescription('Optional announcement message').setMaxLength(4000))
    .addStringOption((o) => o.setName('link1').setDescription('Optional CTA or X post URL').setMaxLength(500))
    .addStringOption((o) => o.setName('label1').setDescription('Optional CTA label; X links always become SHOW LOVE ON X').setMaxLength(80))
    .addStringOption((o) => o.setName('link2').setDescription('Optional second CTA URL').setMaxLength(500))
    .addStringOption((o) => o.setName('label2').setDescription('Optional second CTA label').setMaxLength(80))
    .addStringOption((o) => o.setName('link3').setDescription('Optional third CTA URL').setMaxLength(500))
    .addStringOption((o) => o.setName('label3').setDescription('Optional third CTA label').setMaxLength(80)),

  new SlashCommandBuilder()
    .setName('community-health')
    .setDescription('Staff: show community community health metrics.')
    .addIntegerOption((o) => o.setName('days').setDescription('Reporting window in days').setMinValue(1).setMaxValue(90)),
  new SlashCommandBuilder()
    .setName('health-card')
    .setDescription('Staff: generate a shareable community health image.')
    .addIntegerOption((o) => o.setName('days').setDescription('Reporting window in days').setMinValue(1).setMaxValue(90)),
  new SlashCommandBuilder().setName('refresh-health').setDescription('Staff: refresh the persistent community-health dashboard.'),
  new SlashCommandBuilder().setName('mod-inbox').setDescription('Staff: show the consolidated LINKO moderation inbox.'),

  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Staff: manage community community events.')
    .addSubcommand((sc) => sc.setName('create').setDescription('Create and publish a community event.')
      .addStringOption((o) => o.setName('title').setDescription('Event title').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('date').setDescription('UTC date, DD-MM-YYYY, e.g. 20-10-2026').setRequired(true).setMaxLength(10))
      .addStringOption((o) => o.setName('time').setDescription('UTC time, 24-hour HH:MM, e.g. 16:00').setRequired(true).setMaxLength(5))
      .addIntegerOption((o) => o.setName('duration').setDescription('Duration in minutes').setRequired(true).setMinValue(15).setMaxValue(720))
      .addStringOption((o) => o.setName('description').setDescription('Event description').setMaxLength(1000))
      .addChannelOption((o) => o.setName('voice').setDescription('Optional Voice/Stage room').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
      .addStringOption((o) => o.setName('access').setDescription('Who may enter the event Voice/Stage room').addChoices(
        { name: 'Everyone in Server', value: 'everyone' },
        { name: 'Verified Members', value: 'verified' },
        { name: 'Keep Current Channel Permissions', value: 'existing' },
      )))
    .addSubcommand((sc) => sc.setName('list').setDescription('List upcoming/live events.'))
    .addSubcommand((sc) => sc.setName('access').setDescription('Change who can enter an event Voice/Stage room.')
      .addIntegerOption((o) => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('type').setDescription('Event room access').setRequired(true).addChoices(
        { name: 'Everyone in Server', value: 'everyone' },
        { name: 'Verified Members', value: 'verified' },
        { name: 'Keep Current Channel Permissions', value: 'existing' },
      )))
    .addSubcommand((sc) => sc.setName('start').setDescription('Start an event and its official voice-XP window.')
      .addIntegerOption((o) => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand((sc) => sc.setName('end').setDescription('End an event.')
      .addIntegerOption((o) => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand((sc) => sc.setName('cancel').setDescription('Cancel an event.')
      .addIntegerOption((o) => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand((sc) => sc.setName('attendance').setDescription('Show event attendance.')
      .addIntegerOption((o) => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Staff: manage community product suggestions.')
    .addSubcommand((sc) => sc.setName('list').setDescription('List recent open suggestions.'))
    .addSubcommand((sc) => sc.setName('status').setDescription('Change a suggestion status.')
      .addIntegerOption((o) => o.setName('id').setDescription('Suggestion ID').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('status').setDescription('New status').setRequired(true).addChoices(
        { name: 'Reviewing', value: 'reviewing' }, { name: 'Planned', value: 'planned' }, { name: 'Building', value: 'building' },
        { name: 'Shipped', value: 'shipped' }, { name: 'Declined', value: 'declined' },
      ))
      .addStringOption((o) => o.setName('note').setDescription('Optional staff note').setMaxLength(300))),

  new SlashCommandBuilder()
    .setName('language-manager')
    .setDescription('Staff: create or manage demand-approved communities.')
    .addSubcommand((sc) => sc.setName('create').setDescription('Create a community role + private community channel.')
      .addStringOption((o) => o.setName('name').setDescription('Language name, e.g. Deutsch').setRequired(true).setMaxLength(30))
      .addStringOption((o) => o.setName('emoji').setDescription('Flag/emoji, e.g. 🇩🇪').setRequired(true).setMaxLength(12))
      .addStringOption((o) => o.setName('slug').setDescription('Channel slug, e.g. deutsch').setRequired(true).setMaxLength(30)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List configured communities.'))
    .addSubcommand((sc) => sc.setName('archive').setDescription('Archive a community.')
      .addRoleOption((o) => o.setName('role').setDescription('COMM · role').setRequired(true))),

  new SlashCommandBuilder()
    .setName('channel-manager')
    .setDescription('Staff: safely create, edit or archive extra community channels.')
    .addSubcommand((sc) => sc.setName('create').setDescription('Create a managed text or voice channel.')
      .addStringOption((o) => o.setName('name').setDescription('Channel name').setRequired(true).setMaxLength(50))
      .addStringOption((o) => o.setName('category').setDescription('Category name').setRequired(true).setMaxLength(50))
      .addStringOption((o) => o.setName('type').setDescription('Channel type').setRequired(true).addChoices({ name: 'Text', value: 'text' }, { name: 'Voice', value: 'voice' }))
      .addStringOption((o) => o.setName('access').setDescription('Who can see/use it').setRequired(true).addChoices(
        { name: 'Verified Members', value: 'verified' }, { name: 'ANALYST+', value: 'analyst' }, { name: 'STRATEGIST+', value: 'strategist' },
        { name: 'Verified Founders', value: 'founders' }, { name: 'Studio Clients', value: 'studio' }, { name: 'Creators', value: 'creators' }, { name: 'Staff Only', value: 'staff' },
      ))
      .addStringOption((o) => o.setName('emoji').setDescription('Optional emoji prefix').setMaxLength(12))
      .addStringOption((o) => o.setName('topic').setDescription('Optional topic').setMaxLength(300))
      .addBooleanOption((o) => o.setName('links').setDescription('Allow links in this channel?'))
      .addBooleanOption((o) => o.setName('kxp').setDescription('Allow impact-scored message XP here?'))
      .addIntegerOption((o) => o.setName('slowmode').setDescription('Text-channel slowmode seconds').setMinValue(0).setMaxValue(21600)))
    .addSubcommand((sc) => sc.setName('batch-create').setDescription('Create up to 10 managed channels with the same rules.')
      .addStringOption((o) => o.setName('names').setDescription('Comma-separated channel names, max 10').setRequired(true).setMaxLength(500))
      .addStringOption((o) => o.setName('category').setDescription('Category name').setRequired(true).setMaxLength(50))
      .addStringOption((o) => o.setName('type').setDescription('Channel type').setRequired(true).addChoices({ name: 'Text', value: 'text' }, { name: 'Voice', value: 'voice' }))
      .addStringOption((o) => o.setName('access').setDescription('Who can see/use them').setRequired(true).addChoices(
        { name: 'Verified Members', value: 'verified' }, { name: 'ANALYST+', value: 'analyst' }, { name: 'STRATEGIST+', value: 'strategist' },
        { name: 'Verified Founders', value: 'founders' }, { name: 'Studio Clients', value: 'studio' }, { name: 'KREATOR', value: 'creators' }, { name: 'Staff Only', value: 'staff' },
      ))
      .addStringOption((o) => o.setName('emoji').setDescription('Optional emoji prefix').setMaxLength(12))
      .addStringOption((o) => o.setName('topic').setDescription('Optional topic for text channels').setMaxLength(300))
      .addBooleanOption((o) => o.setName('links').setDescription('Allow links in these channels?'))
      .addBooleanOption((o) => o.setName('kxp').setDescription('Allow impact-scored XP in these channels?'))
      .addIntegerOption((o) => o.setName('slowmode').setDescription('Text-channel slowmode seconds').setMinValue(0).setMaxValue(21600)))
    .addSubcommand((sc) => sc.setName('rename').setDescription('Rename a managed channel.')
      .addChannelOption((o) => o.setName('channel').setDescription('Managed channel').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(50)))
    .addSubcommand((sc) => sc.setName('archive').setDescription('Archive and lock a managed channel.')
      .addChannelOption((o) => o.setName('channel').setDescription('Managed channel').setRequired(true)))
    .addSubcommand((sc) => sc.setName('delete').setDescription('Core: permanently delete a managed channel.')
      .addChannelOption((o) => o.setName('channel').setDescription('Managed channel').setRequired(true)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List LINKO-managed extra channels.')),
].map((c) => c.toJSON());

function now() { return Date.now(); }
function dayKey(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
function overwrite(id, allow = [], deny = []) { return { id, allow, deny }; }
function isAdmin(interaction) {
  return interaction.guild?.ownerId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}
function hasCoreRole(member) {
  const names = new Set([coreRoleName(), 'KLINEO CORE', 'COMMUNITY CORE']);
  return member?.roles?.cache?.some((r) => names.has(r.name));
}
function canPublishAnnouncement(member) {
  const names = new Set([coreRoleName(), teamRoleName()]);
  return member?.roles?.cache?.some((r) => names.has(r.name));
}
function isXPostUrl(raw) {
  try {
    const u = new URL(String(raw ?? '').trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.protocol === 'https:' && (host === 'x.com' || host === 'twitter.com') && /\/status\/\d+/.test(u.pathname);
  } catch { return false; }
}
function announcementUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (!officialLinkUrlValid(value)) throw new Error('Announcement CTA links must be valid HTTPS URLs.');
  return value;
}
function announcementButtonLabel(url, custom, index) {
  if (isXPostUrl(url)) return 'SHOW LOVE ON X';
  const label = String(custom ?? '').trim();
  return label ? label.slice(0, 80) : `OPEN LINK${index > 1 ? ` ${index}` : ''}`;
}
function announcementLinkRow(links = []) {
  if (!links.length) return null;
  return new ActionRowBuilder().addComponents(...links.slice(0, 3).map((link, index) =>
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(link.url)
      .setLabel(announcementButtonLabel(link.url, link.label, index + 1))
  ));
}
function buildAnnouncementPayload(draft) {
  const links = draft.links ?? [];
  const linkRow = announcementLinkRow(links);

  if (draft.xOnly) {
    return {
      content: `**𝕏 NEW ON X**\n${links[0].url}`,
      embeds: [],
      components: linkRow ? [linkRow] : [],
    };
  }

  const title = draft.title || `📣 ${communityNameUpper()} ANNOUNCEMENT`;
  const embeds = [];
  if (draft.imageUrl) {
    embeds.push(new EmbedBuilder()
      .setColor(BRAND.lime)
      .setTitle(title)
      .setImage(draft.imageUrl));
    if (draft.body) {
      embeds.push(new EmbedBuilder()
        .setColor(BRAND.lime)
        .setDescription(draft.body)
        .setFooter({ text: `${communityName()} Official Announcement` })
        .setTimestamp());
    } else {
      embeds[0].setFooter({ text: `${communityName()} Official Announcement` }).setTimestamp();
    }
  } else {
    const embed = new EmbedBuilder().setColor(BRAND.lime).setTitle(title);
    if (draft.body) embed.setDescription(draft.body);
    embed.setFooter({ text: `${communityName()} Official Announcement` }).setTimestamp();
    embeds.push(embed);
  }

  return { embeds, components: linkRow ? [linkRow] : [] };
}
function staffRoleNames() {
  return [coreRoleName(), teamRoleName(), 'MODERATOR'];
}
function hasStaffRole(member) {
  const names = new Set([...staffRoleNames(), 'KLINEO CORE', 'KLINEO TEAM', 'COMMUNITY CORE', 'COMMUNITY TEAM']);
  return member?.roles?.cache?.some((r) => names.has(r.name));
}
function hasVerifiedRole(member) { return member?.roles?.cache?.some((r) => r.name === 'VERIFIED MEMBER'); }
function hasKreatorRole(member) { return member?.roles?.cache?.some((r) => r.name === 'KREATOR' || r.name === 'CREATOR'); }
function participationRow(userId) { return db.prepare('SELECT * FROM member_participation WHERE user_id=?').get(userId) ?? null; }
function participationLane(memberOrUserId) {
  const userId = typeof memberOrUserId === 'string' ? memberOrUserId : memberOrUserId?.id;
  if (!userId) return null;
  if (typeof memberOrUserId !== 'string' && hasKreatorRole(memberOrUserId)) return 'kreator';
  return participationRow(userId)?.lane ?? null;
}
function setParticipationLane(userId, lane) {
  const t = now();
  db.prepare(`INSERT INTO member_participation (user_id,lane,selected_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET lane=excluded.lane,updated_at=excluded.updated_at`).run(userId, lane, t, t);
}
function kreatorProfile(userId) { return db.prepare('SELECT * FROM kreator_profiles WHERE user_id=?').get(userId) ?? null; }
function kreatorProfileApproved(userId) { return kreatorProfile(userId)?.status === 'approved'; }
function isCommunityLeaderboardEligible(member) {
  if (!member || member.user.bot || !hasVerifiedRole(member) || hasKreatorRole(member)) return false;
  const lane = participationLane(member);
  return !lane || lane === 'community';
}
function creatorProfilePlatform(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    const defs = [
      ['X', ['x.com','twitter.com']], ['YouTube', ['youtube.com','youtu.be']], ['TikTok', ['tiktok.com']],
      ['Instagram', ['instagram.com']], ['LinkedIn', ['linkedin.com']], ['Telegram', ['t.me','telegram.me']],
    ];
    return defs.find(([, hosts]) => hosts.some((d) => h === d || h.endsWith(`.${d}`)))?.[0] ?? null;
  } catch { return null; }
}
function creatorProfileUrlValid(url) { return !!creatorProfilePlatform(url); }
function rankForXp(xp) { return [...RANKS].reverse().find((r) => xp >= r.threshold) ?? RANKS[0]; }
function nextRankForXp(xp) { return RANKS.find((r) => r.threshold > xp) ?? null; }
function ensureUserRow(userId, joinedAt = null, seenAt = null) {
  db.prepare(`INSERT INTO users (user_id, xp, joined_at, last_seen_at) VALUES (?, 0, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      joined_at = COALESCE(users.joined_at, excluded.joined_at),
      last_seen_at = CASE
        WHEN excluded.last_seen_at IS NULL THEN users.last_seen_at
        WHEN users.last_seen_at IS NULL THEN excluded.last_seen_at
        ELSE MAX(users.last_seen_at, excluded.last_seen_at)
      END`).run(userId, joinedAt, seenAt);
  db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(userId);
}
function touchActivity(userId, kind = 'command', at = now()) {
  if (!userId) return;
  ensureUserRow(userId, null, at);
  const day = dayKey(at);
  const counts = {
    message: [1,0,0,0,0,0],
    reaction: [0,1,0,0,0,0],
    voice: [0,0,1,0,0,0],
    command: [0,0,0,1,0,0],
    onboarding: [0,0,0,0,1,0],
    submission: [0,0,0,0,0,1],
  }[kind] ?? [0,0,0,1,0,0];
  db.prepare(`INSERT INTO activity_daily
    (user_id, day, messages, reactions, voice_entries, commands, onboarding, submissions, first_activity_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET
      messages = activity_daily.messages + excluded.messages,
      reactions = activity_daily.reactions + excluded.reactions,
      voice_entries = activity_daily.voice_entries + excluded.voice_entries,
      commands = activity_daily.commands + excluded.commands,
      onboarding = activity_daily.onboarding + excluded.onboarding,
      submissions = activity_daily.submissions + excluded.submissions,
      first_activity_at = MIN(activity_daily.first_activity_at, excluded.first_activity_at),
      last_activity_at = MAX(activity_daily.last_activity_at, excluded.last_activity_at)`)
    .run(userId, day, ...counts, at, at);
}
function getXp(userId) { ensureUserRow(userId); return Number(db.prepare('SELECT xp FROM users WHERE user_id = ?').get(userId)?.xp ?? 0); }
function getDaily(userId) {
  const day = dayKey();
  db.prepare('INSERT OR IGNORE INTO daily_xp (user_id, day) VALUES (?, ?)').run(userId, day);
  return db.prepare('SELECT * FROM daily_xp WHERE user_id = ? AND day = ?').get(userId, day);
}
async function backfillRecentActivity(guild, days = 7) {
  const needActivity = !getSetting('activity_backfill_v1_at');
  const needQuality = !getSetting('quality_backfill_v1_at');
  if (!needActivity && !needQuality) return;

  const cutoff = now() - Math.max(1, days) * 86400000;
  let scanned = 0;
  let recorded = 0;
  let qualityCandidates = 0;
  const users = new Set();
  const recentMessages = [];
  const MAX_TOTAL = 10000;
  const MAX_PER_CHANNEL = 1500;

  for (const channel of guild.channels.cache.values()) {
    if (scanned >= MAX_TOTAL) break;
    if (!channel?.isTextBased?.() || !channel.messages?.fetch) continue;
    let before;
    let channelScanned = 0;
    let reachedCutoff = false;

    while (!reachedCutoff && channelScanned < MAX_PER_CHANNEL && scanned < MAX_TOTAL) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch?.size) break;
      for (const message of batch.values()) {
        scanned++;
        channelScanned++;
        if ((message.createdTimestamp ?? 0) < cutoff) {
          reachedCutoff = true;
          continue;
        }
        if (!message.author?.bot) {
          if (needActivity) touchActivity(message.author.id, 'message', message.createdTimestamp ?? now());
          if (needQuality) recentMessages.push(message);
          users.add(message.author.id);
          recorded++;
        }
        if (scanned >= MAX_TOTAL || channelScanned >= MAX_PER_CHANNEL) break;
      }
      before = batch.last()?.id;
      if (!before || batch.size < 100) break;
    }
  }

  if (needQuality && recentMessages.length) {
    recentMessages.sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));

    // First pass creates the same candidate records LINKO would create live.
    for (const message of recentMessages) {
      const row = await ensureCandidateFromMessage(message).catch(() => null);
      if (row) qualityCandidates++;
    }

    // Second pass reconstructs reply/reaction signal without awarding retroactive XP.
    for (const message of recentMessages) {
      if (message.reference?.messageId && message.reference?.guildId === guild.id) {
        const a = analyzeImpactMessage(message.content);
        if (a.qualifiesAsCandidate) await recordImpactEngagement(message.reference.messageId, message.author.id, 'reply');
      }
      const hasReaction = message.reactions?.cache?.some((reaction) => Number(reaction.count ?? 0) > 0);
      if (hasReaction) {
        db.prepare('UPDATE message_candidates SET reaction_count = MAX(reaction_count, 1) WHERE message_id = ?').run(message.id);
      }
    }
  }

  if (needActivity) setSetting('activity_backfill_v1_at', String(now()));
  if (needQuality) setSetting('quality_backfill_v1_at', String(now()));
  console.log(`[LINKO HEALTH] Backfill complete: ${recorded} human messages, ${users.size} active members, ${qualityCandidates} quality candidates, ${scanned} messages scanned.`);
}
function containsLink(content) {
  return /(https?:\/\/|www\.|discord\.gg\/|discord\.com\/invite\/|(?:^|\s)[a-z0-9][a-z0-9.-]*\.(?:com|io|xyz|net|org|gg|app|ai|finance|exchange)\b)/i.test(content);
}
function canShareSignalLinks(member) {
  return hasStaffRole(member) || member.roles.cache.some((r) => ['STRATEGIST', 'VANGUARD', 'PRIME'].includes(r.name));
}


const TRIVIAL_MESSAGE_EXACT = new Set([
  'lol', 'lmao', 'lmfao', 'rofl', 'haha', 'hahaha', 'hehe', 'gm', 'gn', 'hi', 'hey', 'hello', 'yo', 'sup', 'wassup',
  'nice', 'nice bro', 'cool', 'thanks', 'thank you', 'thx', 'ok', 'okay', 'yes', 'no', 'yep', 'nope', 'wow', 'wen',
  'good', 'great', 'awesome', 'based', 'bullish', 'bearish', 'wagmi', 'ngmi', 'fr', 'true', 'same', 'agreed', 'bro', 'bruh',
]);
const IMPACT_RELEVANCE_RE = /\b(klineo|liquidity|market|markets|trade|trading|trader|chart|btc|bitcoin|eth|ethereum|price|volume|resistance|support|stop\s*loss|entry|exit|position|portfolio|risk|leverage|futures|signal|strategy|ai|agent|terminal|order|exchange|integration|feature|product|bug|feedback|ui|ux|mobile|api|founder|studio|execution|slippage|spread|liquidation)\b/i;
const IMPACT_EXPLANATION_RE = /\b(because|think|suggest|issue|tested|noticed|works|working|doesn['’]?t|should|could|would|why|how|what|when|where|feedback|maybe|however|improve|problem|idea|reason|example|means|looks|seems|compare|difference)\b|\?/i;

function normalizeImpactText(content) {
  return String(content ?? '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(/<#\d+>/g, ' ')
    .replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, ' ')
    .replace(/[`*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function impactWords(text) { return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []; }
function impactFingerprint(text) {
  return normalizeImpactText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 300);
}
function repeatedSpam(text) {
  if (/(.)\1{4,}/iu.test(text)) return true;
  const words = impactWords(text.toLowerCase());
  if (words.length >= 4) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    const max = Math.max(...counts.values());
    if (max / words.length >= 0.6) return true;
  }
  return false;
}
function analyzeImpactMessage(content) {
  const text = normalizeImpactText(content);
  const words = impactWords(text);
  const alphaChars = (text.match(/\p{L}/gu) ?? []).length;
  const minWords = Math.max(1, getSettingInt('impact_min_words'));
  const minAlpha = Math.max(1, getSettingInt('impact_min_alpha_chars'));
  const lower = text.toLowerCase();
  const trivial = TRIVIAL_MESSAGE_EXACT.has(lower) || (words.length <= 3 && /^(lol+|ha+|he+|gm+|gn+|hi+|hey+|yo+|sup+|wass+u+p+|nice+|cool+|wow+|bro+|bruh+)[!?.\s]*$/i.test(lower));
  const hardReject = !text || containsLink(text) || repeatedSpam(text) || trivial || words.length < minWords || alphaChars < minAlpha;
  if (hardReject) return { qualifiesAsCandidate: false, baseScore: 0, text, words: words.length, alphaChars, relevant: false, explanatory: false, fingerprint: impactFingerprint(text) };
  const relevant = IMPACT_RELEVANCE_RE.test(text);
  const explanatory = IMPACT_EXPLANATION_RE.test(text) && words.length >= 6;
  const substantial = words.length >= 7 || text.length >= 45;
  let baseScore = 0;
  if (substantial) baseScore += 1;
  if (relevant) baseScore += 1;
  if (explanatory) baseScore += 1;
  baseScore = Math.min(baseScore, 2);
  return { qualifiesAsCandidate: baseScore > 0, baseScore, text, words: words.length, alphaChars, relevant, explanatory, fingerprint: impactFingerprint(text) };
}
function candidateScore(row) {
  return Number(row.base_score ?? 0) + (Number(row.reply_count ?? 0) > 0 ? 1 : 0) + (Number(row.reaction_count ?? 0) > 0 ? 1 : 0) + Number(row.moderator_bonus ?? 0);
}
function qualifiedMessageCountBetween(start, end = now()) {
  const threshold = Math.max(1, getSettingInt('impact_min_score'));
  return Number(db.prepare(`SELECT COUNT(*) AS c
    FROM message_candidates
    WHERE created_at >= ? AND created_at < ? AND revoked = 0
      AND (base_score
        + CASE WHEN reply_count > 0 THEN 1 ELSE 0 END
        + CASE WHEN reaction_count > 0 THEN 1 ELSE 0 END
        + moderator_bonus) >= ?`).get(start, end, threshold)?.c ?? 0);
}
function parseDiscordMessageLink(raw, guildId) {
  const m = String(raw ?? '').trim().match(/(?:https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/)(\d+)\/(\d+)\/(\d+)/i);
  if (!m || m[1] !== String(guildId)) return null;
  return { channelId: m[2], messageId: m[3] };
}
async function ensureCandidateFromMessage(message) {
  if (!message?.guild || !isAllowedGuild(message.guild.id) || message.author?.bot || !message.member || !hasVerifiedRole(message.member)) return null;
  const base = baseChannelName(message.channel.name);
  if (!MESSAGE_XP_CHANNELS.has(base) || base === 'bug-reports') return null;
  const analysis = analyzeImpactMessage(message.content);
  if (!analysis.qualifiesAsCandidate) return null;
  if (analysis.fingerprint) {
    const duplicate = db.prepare('SELECT message_id FROM message_candidates WHERE user_id = ? AND fingerprint = ? AND created_at >= ? LIMIT 1').get(message.author.id, analysis.fingerprint, now() - 24 * 60 * 60 * 1000);
    if (duplicate && duplicate.message_id !== message.id) return null;
  }
  db.prepare(`INSERT OR IGNORE INTO message_candidates
    (message_id, user_id, channel_id, created_at, fingerprint, base_score)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(message.id, message.author.id, message.channel.id, message.createdTimestamp ?? now(), analysis.fingerprint, analysis.baseScore);
  return db.prepare('SELECT * FROM message_candidates WHERE message_id = ?').get(message.id);
}
function lastQualifiedMessageAwardAt(userId) {
  return Number(db.prepare("SELECT created_at FROM xp_log WHERE user_id = ? AND reason LIKE 'Qualified community message:%' ORDER BY created_at DESC LIMIT 1").get(userId)?.created_at ?? 0);
}
async function awardImpactCandidate(guild, row, actorId = null, manual = false) {
  if (!row || Number(row.awarded) || Number(row.revoked)) return false;
  const member = await guild.members.fetch(row.user_id).catch(() => null);
  if (!member || member.user.bot || !hasVerifiedRole(member)) return false;
  const daily = getDaily(row.user_id);
  const cap = Math.max(0, getSettingInt('message_daily_cap'));
  const remaining = Math.max(0, cap - Number(daily.message_xp));
  if (!remaining) return false;
  const cooldownMs = Math.max(0, getSettingInt('message_cooldown_seconds')) * 1000;
  const lastAward = lastQualifiedMessageAwardAt(row.user_id);
  if (!manual && lastAward && now() - lastAward < cooldownMs) return false;
  const award = Math.min(Math.max(0, getSettingInt('kxp_message')), remaining);
  if (!award) return false;
  db.prepare('UPDATE daily_xp SET message_xp = message_xp + ? WHERE user_id = ? AND day = ?').run(award, row.user_id, dayKey());
  db.prepare('UPDATE message_candidates SET awarded = 1, awarded_at = ? WHERE message_id = ?').run(now(), row.message_id);
  db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(row.user_id);
  db.prepare('UPDATE member_activation SET first_impact_at = COALESCE(first_impact_at, ?) WHERE user_id = ?').run(now(), row.user_id);
  const channel = guild.channels.cache.get(row.channel_id);
  const score = candidateScore(row);
  await addXp(guild, row.user_id, award, `Qualified community message:#${channel?.name ?? row.channel_id}:${row.message_id} (impact ${score})`, actorId);
  return true;
}
async function evaluateImpactCandidates(guild) {
  const delayMs = Math.max(1, getSettingInt('impact_delay_seconds')) * 1000;
  const windowMs = Math.max(1, getSettingInt('impact_candidate_window_minutes')) * 60 * 1000;
  const threshold = Math.max(1, getSettingInt('impact_min_score'));
  const rows = db.prepare('SELECT * FROM message_candidates WHERE awarded = 0 AND revoked = 0 AND created_at <= ? AND created_at >= ? ORDER BY created_at ASC LIMIT 250').all(now() - delayMs, now() - windowMs);
  for (const row of rows) {
    if (candidateScore(row) < threshold) continue;
    await awardImpactCandidate(guild, row, null, false);
  }
  const staleCutoff = now() - 91 * 86400000;
  db.prepare('DELETE FROM message_engagement WHERE message_id IN (SELECT message_id FROM message_candidates WHERE created_at < ?)').run(staleCutoff);
  db.prepare('DELETE FROM message_candidates WHERE created_at < ? AND awarded = 0').run(staleCutoff);
}
async function recordImpactEngagement(messageId, userId, kind) {
  const candidate = db.prepare('SELECT * FROM message_candidates WHERE message_id = ?').get(messageId);
  if (!candidate || candidate.user_id === userId || Number(candidate.revoked)) return false;
  const result = db.prepare('INSERT OR IGNORE INTO message_engagement (message_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(messageId, userId, kind, now());
  if (!result.changes) return false;
  if (kind === 'reply') db.prepare('UPDATE message_candidates SET reply_count = reply_count + 1 WHERE message_id = ?').run(messageId);
  if (kind === 'reaction') db.prepare('UPDATE message_candidates SET reaction_count = reaction_count + 1 WHERE message_id = ?').run(messageId);
  return true;
}
async function resolveMessageForStaff(guild, raw) {
  const parsed = parseDiscordMessageLink(raw, guild.id);
  if (!parsed) throw new Error(`Use a full Discord message link from this ${communityName()} server.`);
  const channel = guild.channels.cache.get(parsed.channelId) ?? await guild.channels.fetch(parsed.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('Message channel could not be found.');
  const message = await channel.messages.fetch(parsed.messageId).catch(() => null);
  if (!message) throw new Error('Message could not be found or LINKO cannot access it.');
  return message;
}
function activationRow(userId) {
  ensureUserRow(userId);
  return db.prepare('SELECT * FROM member_activation WHERE user_id = ?').get(userId) ?? {};
}
function interestByKey(key) { return INTERESTS.find((x) => x[0] === key) ?? null; }
function slugifyChannelName(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'channel';
}
function languageRows() { return db.prepare('SELECT * FROM language_roles WHERE archived = 0 ORDER BY name COLLATE NOCASE').all(); }
function customLanguageCatalogRows() { return db.prepare("SELECT * FROM language_catalog_custom WHERE active=1 ORDER BY name COLLATE NOCASE").all(); }
function languageCatalog() {
  return [...BASE_LANGUAGE_CATALOG, ...customLanguageCatalogRows().map((r) => ({ key: r.language_key, name: r.name, emoji: r.emoji || '🌐', global: false, custom: true, aliases: [r.name] }))];
}
function languageCatalogEntry(key) { return languageCatalog().find((x) => x.key === key) ?? null; }
function languageCatalogFindByInput(raw) {
  const normalized = normalizeLanguageInput(raw);
  if (!normalized) return null;
  for (const entry of languageCatalog()) {
    const aliases = [entry.name, ...(entry.aliases ?? [])].map(normalizeLanguageInput);
    if (aliases.includes(normalized)) return entry;
  }
  return null;
}
function activeLanguageRowForEntry(entry) {
  if (!entry || entry.global) return null;
  return db.prepare('SELECT * FROM language_roles WHERE LOWER(name)=LOWER(?) AND archived=0 LIMIT 1').get(entry.name) ?? null;
}
function languagePreferenceKeys(userId) { return db.prepare('SELECT language_key FROM language_preferences WHERE user_id=? ORDER BY language_key').all(userId).map((r) => r.language_key); }
function languageDemandCount(languageKey) { return Number(db.prepare('SELECT COUNT(*) AS c FROM language_preferences WHERE language_key=?').get(languageKey)?.c ?? 0); }
function staffLanguageReviewChannel(guild) {
  return guild.channels.cache.find((c) => baseChannelName(c.name) === 'moderation' && c.isTextBased())
    ?? guild.channels.cache.find((c) => baseChannelName(c.name) === 'mod-commands' && c.isTextBased())
    ?? guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased())
    ?? null;
}
function ensureCatalogFromExistingLanguageRoles() {
  for (const row of languageRows()) {
    let entry = languageCatalogFindByInput(row.name);
    if (!entry) {
      let key = `custom-${slugifyChannelName(row.name)}`;
      let suffix = 2;
      while (languageCatalogEntry(key)) key = `custom-${slugifyChannelName(row.name)}-${suffix++}`;
      db.prepare('INSERT OR IGNORE INTO language_catalog_custom (language_key,name,emoji,created_at,approved_by,active) VALUES (?,?,?,?,?,1)')
        .run(key, row.name, row.emoji || '🌐', now(), row.created_by || null);
      entry = languageCatalogEntry(key);
    }
    if (!entry) continue;
    const members = db.prepare('SELECT user_id FROM member_languages WHERE role_id=?').all(row.role_id);
    for (const m of members) db.prepare('INSERT OR IGNORE INTO language_preferences (user_id,language_key,selected_at) VALUES (?,?,?)').run(m.user_id, entry.key, now());
  }
}
function languageRequestReviewButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`language_request_approve:${id}`).setLabel('Approve Catalog').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`language_request_decline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  );
}
function languageRequestEmbed(row) {
  return new EmbedBuilder().setColor(row.status === 'approved' ? BRAND.emerald : row.status === 'declined' ? BRAND.rose : BRAND.blue)
    .setTitle(`🌍 Catalog request #${row.id} · ${row.language_name}`)
    .addFields(
      { name: 'Requested by', value: `<@${row.user_id}>`, inline: true },
      { name: 'Suggested icon', value: row.emoji || '🌐', inline: true },
      { name: 'Status', value: `**${String(row.status).toUpperCase()}**`, inline: true },
      ...(row.note ? [{ name: 'Note', value: row.note.slice(0, 1024) }] : []),
    )
    .setFooter({ text: `LINKO language catalog request #${row.id}` })
    .setTimestamp(new Date(Number(row.reviewed_at || row.created_at)));
}
function languageDemandReviewButtons(languageKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`language_demand_create:${languageKey}`).setLabel('CREATE COMMUNITY').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`language_demand_notnow:${languageKey}`).setLabel('NOT NOW').setStyle(ButtonStyle.Secondary),
  );
}
function languageDemandEmbed(entry, count, status = 'pending') {
  return new EmbedBuilder().setColor(status === 'created' ? BRAND.emerald : BRAND.blue)
    .setTitle(`${entry.emoji} ${entry.name} · Language demand`)
    .setDescription(`**${count} member${count === 1 ? '' : 's'}** selected this language. LINKO only creates a dedicated language community after staff approval.`)
    .addFields(
      { name: 'Threshold', value: `**${LANGUAGE_DEMAND_THRESHOLD} members**`, inline: true },
      { name: 'Current demand', value: `**${count}**`, inline: true },
      { name: 'Status', value: `**${String(status).toUpperCase().replace('_',' ')}**`, inline: true },
    )
    .setFooter({ text: `Language key: ${entry.key} · English (Global) never creates a separate channel` })
    .setTimestamp();
}
async function ensureLanguageDemandReview(guild, languageKey) {
  const entry = languageCatalogEntry(languageKey);
  if (!entry || entry.global || activeLanguageRowForEntry(entry)) return false;
  const count = languageDemandCount(languageKey);
  const existing = db.prepare('SELECT * FROM language_demand_reviews WHERE language_key=?').get(languageKey);
  if (count < LANGUAGE_DEMAND_THRESHOLD) {
    if (existing?.status === 'pending' && existing.review_message_id) {
      const reviewChannel = staffLanguageReviewChannel(guild);
      const msg = reviewChannel ? await reviewChannel.messages.fetch(existing.review_message_id).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [languageDemandEmbed(entry, count, 'waiting')], components: [] }).catch(() => {});
      db.prepare("UPDATE language_demand_reviews SET status='waiting',last_notified_count=?,updated_at=?,updated_by=NULL WHERE language_key=?").run(count, now(), languageKey);
      scheduleModInboxUpdate(guild);
    }
    return false;
  }
  if (existing?.status === 'created') return false;
  if (existing?.status === 'not_now' && count < Number(existing.last_notified_count || 0) + LANGUAGE_DEMAND_THRESHOLD) return false;
  const reviewChannel = staffLanguageReviewChannel(guild);
  if (!reviewChannel) return false;
  if (existing?.status === 'pending' && existing.review_message_id) {
    const msg = await reviewChannel.messages.fetch(existing.review_message_id).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [languageDemandEmbed(entry, count, 'pending')], components: [languageDemandReviewButtons(languageKey)] }).catch(() => {});
      db.prepare('UPDATE language_demand_reviews SET last_notified_count=?,updated_at=? WHERE language_key=?').run(count, now(), languageKey);
      return true;
    }
  }
  const msg = await reviewChannel.send({ embeds: [languageDemandEmbed(entry, count, 'pending')], components: [languageDemandReviewButtons(languageKey)] });
  db.prepare(`INSERT INTO language_demand_reviews (language_key,status,review_message_id,last_notified_count,updated_at,updated_by) VALUES (?,?,?,?,?,NULL)
    ON CONFLICT(language_key) DO UPDATE SET status='pending',review_message_id=excluded.review_message_id,last_notified_count=excluded.last_notified_count,updated_at=excluded.updated_at,updated_by=NULL`)
    .run(languageKey, 'pending', msg.id, count, now());
  scheduleModInboxUpdate(guild);
  return true;
}
async function syncPreferredLanguageRole(guild, member, entry, selected) {
  if (!entry || entry.global) return;
  const row = activeLanguageRowForEntry(entry);
  if (!row) return;
  const role = guild.roles.cache.get(row.role_id);
  if (!role) return;
  if (selected) {
    if (!member.roles.cache.has(role.id)) await member.roles.add(role, `${communityName()} preferred language`).catch(() => {});
    db.prepare('INSERT OR IGNORE INTO member_languages (user_id,role_id,created_at) VALUES (?,?,?)').run(member.id, role.id, now());
  } else {
    if (member.roles.cache.has(role.id)) await member.roles.remove(role, `${communityName()} preferred language removed`).catch(() => {});
    db.prepare('DELETE FROM member_languages WHERE user_id=? AND role_id=?').run(member.id, role.id);
  }
}
async function enrollPreferredLanguageMembers(guild, entry, role) {
  const preferred = db.prepare('SELECT user_id FROM language_preferences WHERE language_key=?').all(entry.key);
  let enrolled = 0;
  for (const pref of preferred) {
    const member = await guild.members.fetch(pref.user_id).catch(() => null);
    if (!member || member.user.bot) continue;
    if (!member.roles.cache.has(role.id)) await member.roles.add(role, `${entry.name} language community created`).catch(() => {});
    db.prepare('INSERT OR IGNORE INTO member_languages (user_id,role_id,created_at) VALUES (?,?,?)').run(member.id, role.id, now());
    enrolled++;
  }
  return enrolled;
}
async function createLanguageCommunity(guild, { name = null, languageKey = null, emoji = null, slug = null, actorId = null, actorTag = 'LINKO' }) {
  const entry = languageKey ? languageCatalogEntry(languageKey) : languageCatalogFindByInput(name);
  if (!entry) throw new Error('That community is not in the approved LINKO community catalog. Add it through the community request flow first.');
  if (entry.global) throw new Error('Global uses the main community and does not need a separate channel.');
  const cleanName = entry.name;
  const cleanEmoji = entry.emoji || emoji || '🌐';
  const existingRow = activeLanguageRowForEntry(entry);
  if (existingRow) return { role: guild.roles.cache.get(existingRow.role_id) ?? null, channel: existingRow.channel_id ? guild.channels.cache.get(existingRow.channel_id) ?? null : null, row: existingRow, existed: true, entry };
  const roleName = `${LANGUAGE_ROLE_PREFIX}${cleanName}`;
  let role = guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) role = await guild.roles.create({ name: roleName, color: BRAND.blue, hoist: false, reason: `Community space created by ${actorTag}` });
  let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAMES.languages);
  if (!category) category = await ensureCategory(guild, CATEGORY_NAMES.languages, [overwrite(guild.roles.everyone.id, [], [PermissionFlagsBits.ViewChannel])]);
  const staff = staffRoleNames().map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
  const perms = privateFor(guild.roles.everyone, [role, ...staff]);
  const channelSlug = slugifyChannelName(slug || cleanName);
  const chName = `${cleanEmoji}・${channelSlug}`;
  let channel = guild.channels.cache.find((c) => c.parentId === category.id && c.name === chName && c.type === ChannelType.GuildText);
  if (!channel) channel = await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category.id, topic: `${cleanName} · ${communityName()} community space.`, permissionOverwrites: perms, reason: 'LINKO community demand manager' });
  db.prepare(`INSERT INTO language_roles (role_id,name,emoji,channel_id,created_by,created_at,archived) VALUES (?,?,?,?,?,?,0)
    ON CONFLICT(role_id) DO UPDATE SET name=excluded.name, emoji=excluded.emoji, channel_id=excluded.channel_id, archived=0`)
    .run(role.id, cleanName, cleanEmoji, channel.id, actorId, now());
  db.prepare(`INSERT INTO managed_channels (channel_id,category_name,access,links_allowed,kxp_enabled,created_by,created_at,archived) VALUES (?,?,?,?,?,?,?,0)
    ON CONFLICT(channel_id) DO UPDATE SET links_allowed=0, kxp_enabled=0, archived=0`)
    .run(channel.id, CATEGORY_NAMES.languages, 'language', 0, 0, actorId, now());
  const row = db.prepare('SELECT * FROM language_roles WHERE role_id=?').get(role.id);
  const enrolled = await enrollPreferredLanguageMembers(guild, entry, role);
  db.prepare(`INSERT INTO language_demand_reviews (language_key,status,review_message_id,last_notified_count,updated_at,updated_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT(language_key) DO UPDATE SET status='created',last_notified_count=excluded.last_notified_count,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .run(entry.key, 'created', null, languageDemandCount(entry.key), now(), actorId);
  const log = guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
  if (log) await log.send(`🌍 ${actorTag} created community **${cleanName}** → ${channel}. **${enrolled}** interested member(s) enrolled automatically.`).catch(() => {});
  return { role, channel, row, existed: false, entry, enrolled };
}
async function migrateLegacyLanguageSpacesToCommunityDemand(guild) {
  if (getSetting('community_demand_v10_17_migrated') === '1') return;
  const legacyAccess = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildText && baseChannelName(ch.name) === 'language-access');
  if (legacyAccess) await legacyAccess.delete('LINKO v10.17: profile-based community selection').catch((error) => logLinkoError('community-migration:language-access', error));

  const rows = languageRows();
  for (const row of rows) {
    const channel = row.channel_id ? guild.channels.cache.get(row.channel_id) : null;
    if (channel) await channel.delete('LINKO v10.17: rebuild community spaces from demand').catch((error) => logLinkoError(`community-migration:channel:${row.channel_id}`, error));
    const role = guild.roles.cache.get(row.role_id);
    if (role) await role.delete('LINKO v10.17: rebuild community roles from demand').catch((error) => logLinkoError(`community-migration:role:${row.role_id}`, error));
    db.prepare('UPDATE language_roles SET archived=1 WHERE role_id=?').run(row.role_id);
    if (row.channel_id) db.prepare('UPDATE managed_channels SET archived=1 WHERE channel_id=?').run(row.channel_id);
  }
  db.prepare('DELETE FROM member_languages').run();
  db.prepare('DELETE FROM language_demand_reviews').run();

  const legacyCategory = guild.channels.cache.find((ch) =>
    ch.type === ChannelType.GuildCategory && ['🌍・LANGUAGES', '🌍・COMMUNITIES'].includes(ch.name)
  );
  if (legacyCategory && guild.channels.cache.filter((ch) => ch.parentId === legacyCategory.id).size === 0) {
    await legacyCategory.delete('LINKO v10.17: create Communities category only after approved demand').catch((error) => logLinkoError('community-migration:category', error));
  }
  setSetting('community_demand_v10_17_migrated', 1);
}

async function showLanguageRequestModal(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
  const modal = new ModalBuilder().setCustomId('linko_language_request_modal').setTitle('Request another community');
  const name = new TextInputBuilder().setCustomId('language').setLabel('Country / region / language').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30).setPlaceholder('e.g. Nigeria, Brazil, Sinhala');
  const emoji = new TextInputBuilder().setCustomId('emoji').setLabel('Suggested flag / emoji (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setPlaceholder('e.g. 🇳🇬');
  const note = new TextInputBuilder().setCustomId('note').setLabel('Optional context for moderators').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300).setPlaceholder('Why should this community be added?');
  modal.addComponents(new ActionRowBuilder().addComponents(name), new ActionRowBuilder().addComponents(emoji), new ActionRowBuilder().addComponents(note));
  return interaction.showModal(modal);
}
function managedChannelRow(channelId) { return db.prepare('SELECT * FROM managed_channels WHERE channel_id = ? AND archived = 0').get(channelId); }
function suggestionStatusLabel(status) {
  return ({ submitted: 'Submitted', reviewing: 'Reviewing', planned: 'Planned', building: 'Building', shipped: 'Shipped', declined: 'Declined' })[status] ?? status;
}
function suggestionColor(status) {
  return ({ submitted: BRAND.gray, reviewing: BRAND.cyan, planned: BRAND.blue, building: BRAND.lime, shipped: BRAND.emerald, declined: BRAND.rose })[status] ?? BRAND.gray;
}
function buildSuggestionEmbed(row) {
  return new EmbedBuilder().setColor(suggestionColor(row.status)).setTitle(`#${row.id} · ${row.title}`)
    .setDescription(row.details).addFields(
      { name: 'Status', value: `**${suggestionStatusLabel(row.status)}**`, inline: true },
      { name: 'Submitted by', value: `<@${row.user_id}>`, inline: true },
      ...(row.staff_note ? [{ name: 'Staff note', value: row.staff_note.slice(0, 1024) }] : []),
    ).setFooter({ text: `${communityName()} Product Suggestion #${row.id}` }).setTimestamp(new Date(row.updated_at || row.created_at));
}
async function updateSuggestionMessages(guild, id) {
  const row = db.prepare('SELECT * FROM product_suggestions WHERE id = ?').get(id);
  if (!row) return;
  const embed = buildSuggestionEmbed(row);
  for (const [base, messageId] of [['product-roadmap', row.public_message_id], ['suggestion-review', row.review_message_id]]) {
    if (!messageId) continue;
    const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === base && c.isTextBased());
    if (!channel) continue;
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) continue;
    const components = base === 'suggestion-review' && !['shipped','declined'].includes(row.status) ? [suggestionReviewButtons(row.id)] : [];
    await msg.edit({ embeds: [embed], components }).catch(() => {});
  }
}
function suggestionReviewButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suggestion_status:${id}:reviewing`).setLabel('Reviewing').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`suggestion_status:${id}:planned`).setLabel('Planned').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`suggestion_status:${id}:building`).setLabel('Building').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`suggestion_status:${id}:shipped`).setLabel('Shipped').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`suggestion_status:${id}:declined`).setLabel('Declined').setStyle(ButtonStyle.Danger),
  );
}
async function setSuggestionStatus(guild, id, status, actorId, note = '') {
  const row = db.prepare('SELECT * FROM product_suggestions WHERE id = ?').get(id);
  if (!row) throw new Error('Suggestion not found.');
  db.prepare('UPDATE product_suggestions SET status = ?, updated_at = ?, updated_by = ?, staff_note = ? WHERE id = ?').run(status, now(), actorId, note || row.staff_note || '', id);
  await updateSuggestionMessages(guild, id);
  const member = await guild.members.fetch(row.user_id).catch(() => null);
  if (member) await member.send(`💡 Your ${communityName()} suggestion **#${id} — ${row.title}** is now **${suggestionStatusLabel(status)}**.${note ? `\nStaff note: ${note}` : ''}`).catch(() => {});
  scheduleModInboxUpdate(guild); scheduleHealthUpdate(guild);
}
function parseEventStartUtc(dateRaw, timeRaw) {
  const dateText = String(dateRaw ?? '').trim();
  const timeText = String(timeRaw ?? '').trim();
  const dateMatch = dateText.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!dateMatch) throw new Error('Invalid event date. Use DD-MM-YYYY, e.g. 20-10-2026.');
  const timeMatch = timeText.match(/^(\d{2}):(\d{2})$/);
  if (!timeMatch) throw new Error('Invalid event time. Use 24-hour UTC HH:MM, e.g. 16:00.');
  const [, dd, mm, yyyy] = dateMatch;
  const [, hh, min] = timeMatch;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const hour = Number(hh);
  const minute = Number(min);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Invalid UTC date/time. Use e.g. Date 20-10-2026 and Time 16:00.');
  }
  const ts = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const check = new Date(ts);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    throw new Error('Invalid UTC date/time. Use e.g. Date 20-10-2026 and Time 16:00.');
  }
  return ts;
}
function eventRsvpCounts(id) {
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM event_rsvps WHERE event_id = ? GROUP BY status').all(id);
  const out = { going: 0, interested: 0 };
  for (const r of rows) if (r.status in out) out[r.status] = Number(r.c);
  return out;
}
function eventAccessLabel(access) {
  return ({ everyone: 'Everyone in Server', verified: 'Verified Members', existing: 'Keep Current Channel Permissions' })[access] ?? 'Verified Members';
}
function permissionSnapshot(channel) {
  return JSON.stringify([...channel.permissionOverwrites.cache.values()].map((ow) => ({
    id: ow.id,
    type: ow.type,
    allow: ow.allow.bitfield.toString(),
    deny: ow.deny.bitfield.toString(),
  })));
}
function parsePermissionSnapshot(raw) {
  if (!raw) return [];
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('Invalid event permission snapshot.');
  return rows.map((row) => ({ id: String(row.id), type: Number(row.type), allow: BigInt(row.allow ?? '0'), deny: BigInt(row.deny ?? '0') }));
}
function overwriteWithAccess(rows, id, type, allowBits = [], denyBits = []) {
  const allowMask = allowBits.reduce((mask, bit) => mask | bit, 0n);
  const denyMask = denyBits.reduce((mask, bit) => mask | bit, 0n);
  const touched = allowMask | denyMask;
  let row = rows.find((item) => item.id === String(id));
  if (!row) { row = { id: String(id), type, allow: 0n, deny: 0n }; rows.push(row); }
  row.type = type;
  row.allow = (BigInt(row.allow) & ~touched) | allowMask;
  row.deny = (BigInt(row.deny) & ~touched) | denyMask;
  return rows;
}
function liveCommunityEventForChannel(channelId) {
  if (!channelId) return null;
  try { return db.prepare("SELECT * FROM community_events WHERE status='live' AND voice_channel_id=? ORDER BY id DESC LIMIT 1").get(String(channelId)) ?? null; }
  catch { return null; }
}
async function syncEventsChannelVisibility(guild) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
  if (!channel) return false;
  const everyone = guild.roles.everyone;
  const verified = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const staff = staffRoleNames().map((name) => guild.roles.cache.find((r) => r.name === name)).filter(Boolean);
  const overwrites = [
    overwrite(everyone.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]),
    ...(verified ? [overwrite(verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages])] : []),
    ...staff.map((role) => overwrite(role.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
  ];
  await channel.permissionOverwrites.set(overwrites, 'LINKO public events visibility');
  return true;
}
async function preparePlannedCommunityEventVisibility(guild, row) {
  if (!row?.voice_channel_id || row.event_access !== 'everyone') return false;
  const channel = guild.channels.cache.get(row.voice_channel_id);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw new Error('Event Voice/Stage room is missing.');
  const snapshot = row.permission_snapshot_json || permissionSnapshot(channel);
  const rows = parsePermissionSnapshot(snapshot);
  overwriteWithAccess(rows, guild.roles.everyone.id, 0, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.Connect]);
  await channel.permissionOverwrites.set(rows, `LINKO event #${row.id} planned visibility`);
  db.prepare('UPDATE community_events SET permission_snapshot_json=?, permissions_applied_at=?, permissions_restored_at=NULL WHERE id=?').run(snapshot, now(), row.id);
  return true;
}
async function createNativeScheduledEvent(guild, row) {
  if (row.native_scheduled_event_id) return guild.scheduledEvents.fetch(row.native_scheduled_event_id).catch(() => null);
  const start = new Date(Number(row.start_at));
  const end = new Date(Number(row.start_at) + Number(row.duration_minutes) * 60000);
  let entityType = GuildScheduledEventEntityType.External;
  const options = {
    name: row.title.slice(0, 100),
    description: (row.description || `${communityName()} community event`).slice(0, 1000),
    scheduledStartTime: start,
    scheduledEndTime: end,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    reason: `LINKO community event #${row.id}`,
  };
  if (row.voice_channel_id) {
    const channel = guild.channels.cache.get(row.voice_channel_id);
    if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw new Error('Event Voice/Stage room is missing.');
    entityType = channel.type === ChannelType.GuildStageVoice ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice;
    options.channel = channel.id;
  } else {
    options.entityMetadata = { location: `${communityName()} Discord` };
  }
  options.entityType = entityType;
  const nativeEvent = await guild.scheduledEvents.create(options);
  db.prepare('UPDATE community_events SET native_scheduled_event_id=? WHERE id=?').run(nativeEvent.id, row.id);
  return nativeEvent;
}
async function backfillNativeScheduledEvents(guild) {
  const rows = db.prepare("SELECT * FROM community_events WHERE status='planned' AND native_scheduled_event_id IS NULL ORDER BY start_at ASC").all();
  for (let row of rows) {
    if (Number(row.start_at) <= now()) continue;
    try {
      await preparePlannedCommunityEventVisibility(guild, row);
      row = db.prepare('SELECT * FROM community_events WHERE id=?').get(row.id);
      const nativeEvent = await createNativeScheduledEvent(guild, row);
      const log = guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
      if (log && nativeEvent) await log.send(`📅 Backfilled LINKO event **#${row.id} ${row.title}** into Discord Scheduled Events.`).catch(() => {});
    } catch (error) {
      logLinkoError(`native-event-backfill:#${row.id}`, error);
    }
  }
}
async function syncNativeScheduledEventStatus(guild, row, status) {
  if (!row?.native_scheduled_event_id) return false;
  const nativeEvent = await guild.scheduledEvents.fetch(row.native_scheduled_event_id).catch(() => null);
  if (!nativeEvent || nativeEvent.status === status) return !!nativeEvent;
  await nativeEvent.setStatus(status, `LINKO event #${row.id} status sync`);
  return true;
}
async function applyCommunityEventAccess(guild, row) {
  if (!row?.voice_channel_id || row.event_access === 'existing') return false;
  const channel = guild.channels.cache.get(row.voice_channel_id);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw new Error('Event Voice/Stage room is missing.');
  let snapshot = row.permission_snapshot_json;
  if (!snapshot || Number(row.permissions_restored_at)) snapshot = permissionSnapshot(channel);
  const rows = parsePermissionSnapshot(snapshot);
  const everyone = guild.roles.everyone;
  const access = row.event_access === 'everyone' ? 'everyone' : 'verified';
  if (access === 'everyone') {
    overwriteWithAccess(rows, everyone.id, 0, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak], []);
  } else {
    overwriteWithAccess(rows, everyone.id, 0, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
    const verified = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
    if (!verified) throw new Error('VERIFIED MEMBER role is missing. Run /setup-linko first.');
    overwriteWithAccess(rows, verified.id, 0, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak], []);
    for (const name of staffRoleNames()) {
      const role = guild.roles.cache.find((r) => r.name === name);
      if (role) overwriteWithAccess(rows, role.id, 0, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak], []);
    }
  }
  await channel.permissionOverwrites.set(rows, `LINKO event #${row.id} access: ${eventAccessLabel(access)}`);
  db.prepare('UPDATE community_events SET permission_snapshot_json=?, permissions_applied_at=?, permissions_restored_at=NULL WHERE id=?').run(snapshot, now(), row.id);
  return true;
}
async function restoreCommunityEventAccess(guild, row) {
  if (!row?.voice_channel_id || !row.permission_snapshot_json || Number(row.permissions_restored_at)) return false;
  const channel = guild.channels.cache.get(row.voice_channel_id);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) return false;
  const rows = parsePermissionSnapshot(row.permission_snapshot_json);
  await channel.permissionOverwrites.set(rows, `LINKO event #${row.id} restore previous permissions`);
  db.prepare('UPDATE community_events SET permissions_restored_at=? WHERE id=?').run(now(), row.id);
  return true;
}
function eventStatusLabel(status) { return ({ planned: 'Scheduled', live: 'LIVE', ended: 'Ended', cancelled: 'Cancelled' })[status] ?? status; }
function buildEventEmbed(row) {
  const counts = eventRsvpCounts(row.id);
  const startSec = Math.floor(Number(row.start_at) / 1000);
  const endSec = Math.floor((Number(row.start_at) + Number(row.duration_minutes) * 60000) / 1000);
  const e = new EmbedBuilder().setColor(row.status === 'live' ? BRAND.lime : row.status === 'cancelled' ? BRAND.rose : row.status === 'ended' ? BRAND.gray : BRAND.cyan)
    .setTitle(`${row.status === 'live' ? '🔴 ' : '📅 '}#${row.id} · ${row.title}`)
    .setDescription(row.description || `${communityName()} community event`)
    .addFields(
      { name: 'Status', value: `**${eventStatusLabel(row.status)}**`, inline: true },
      { name: 'Starts', value: `<t:${startSec}:F>\n<t:${startSec}:R>`, inline: true },
      { name: 'Ends', value: `<t:${endSec}:t>`, inline: true },
      { name: 'RSVP', value: `✅ Going: **${counts.going}**\n⭐ Interested: **${counts.interested}**`, inline: true },
      ...(row.voice_channel_id ? [
        { name: 'Voice room', value: `<#${row.voice_channel_id}>`, inline: true },
        { name: 'Room access', value: `**${eventAccessLabel(row.event_access)}**`, inline: true },
      ] : []),
    ).setFooter({ text: `${communityName()} Event #${row.id}` });
  return e;
}
function eventButtons(id, status) {
  if (!['planned','live'].includes(status)) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event_rsvp:${id}:going`).setLabel('Going').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`event_rsvp:${id}:interested`).setLabel('Interested').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`event_rsvp:${id}:cancel`).setLabel('Clear RSVP').setStyle(ButtonStyle.Secondary),
  )];
}
async function updateEventMessage(guild, id) {
  const row = db.prepare('SELECT * FROM community_events WHERE id = ?').get(id);
  if (!row?.public_message_id) return;
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
  if (!channel) return;
  const msg = await channel.messages.fetch(row.public_message_id).catch(() => null);
  if (msg) await msg.edit({ embeds: [buildEventEmbed(row)], components: eventButtons(id, row.status) }).catch(() => {});
}
async function recordLiveEventAttendance(guild, row) {
  if (!row.voice_channel_id) return;
  const channel = guild.channels.cache.get(row.voice_channel_id);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) return;
  for (const member of channel.members.values()) {
    if (member.user.bot) continue;
    db.prepare(`INSERT INTO event_attendance (event_id, user_id, first_seen_at, last_seen_at, minutes) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(event_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, minutes = minutes + 1`)
      .run(row.id, member.id, now(), now());
  }
}
async function endCommunityEvent(guild, id, actorId = null, automatic = false) {
  const row = db.prepare('SELECT * FROM community_events WHERE id = ?').get(id);
  if (!row || !['planned','live'].includes(row.status)) return null;
  db.prepare('UPDATE community_events SET status = ?, ended_at = ? WHERE id = ?').run('ended', now(), id);
  await syncNativeScheduledEventStatus(guild, { ...row, status: 'ended' }, GuildScheduledEventStatus.Completed).catch((error) => logLinkoError('native-event-complete', error));
  const active = getActiveVoiceEvent();
  if (active && row.voice_channel_id && active.channel_id === row.voice_channel_id) await stopVoiceEvent(guild).catch(() => {});
  await restoreCommunityEventAccess(guild, row).catch((error) => logLinkoError('event-permission-restore', error));
  await updateEventMessage(guild, id);
  const eventsChannel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
  if (eventsChannel) {
    const attendance = db.prepare('SELECT user_id, minutes FROM event_attendance WHERE event_id=? ORDER BY minutes DESC, user_id LIMIT 10').all(id);
    const totalAttendees = Number(db.prepare('SELECT COUNT(*) AS c FROM event_attendance WHERE event_id=?').get(id)?.c ?? 0);
    const rsvp = eventRsvpCounts(id);
    const recap = new EmbedBuilder().setColor(BRAND.emerald).setTitle(`✅ Event Recap · ${row.title}`)
      .setDescription(`${automatic ? 'LINKO closed this event automatically at the scheduled end time.' : `This ${communityName()} event has ended.`}`)
      .addFields(
        { name: 'Attendance', value: `Voice attendees: **${totalAttendees}**\nRSVP Going: **${rsvp.going}**\nInterested: **${rsvp.interested}**`, inline: true },
        ...(attendance.length ? [{ name: 'Top attendance', value: attendance.slice(0,5).map((a) => `<@${a.user_id}> — **${a.minutes} min**`).join('\n') }] : []),
      ).setTimestamp();
    await eventsChannel.send({ embeds: [recap] }).catch(() => {});
  }
  scheduleHealthUpdate(guild); scheduleModInboxUpdate(guild);
  return row;
}
async function processCommunityEvents(guild) {
  const upcoming = db.prepare("SELECT * FROM community_events WHERE status = 'planned' ORDER BY start_at ASC").all();
  for (const row of upcoming) {
    const delta = Number(row.start_at) - now();
    const ch = guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
    if (getSettingInt('event_reminder_30') && delta <= 30 * 60 * 1000 && delta > 5 * 60 * 1000 && !Number(row.reminded_30)) {
      db.prepare('UPDATE community_events SET reminded_30 = 1 WHERE id = ?').run(row.id);
      if (ch) await ch.send(`⏰ **30-minute reminder:** ${row.title} starts <t:${Math.floor(Number(row.start_at)/1000)}:R>.`).catch(() => {});
    }
    if (getSettingInt('event_reminder_5') && delta <= 5 * 60 * 1000 && delta > -15 * 60 * 1000 && !Number(row.reminded_5)) {
      db.prepare('UPDATE community_events SET reminded_5 = 1 WHERE id = ?').run(row.id);
      if (ch) await ch.send(`🚨 **Starting soon:** ${row.title} begins <t:${Math.floor(Number(row.start_at)/1000)}:R>.`).catch(() => {});
    }
  }
  const live = db.prepare("SELECT * FROM community_events WHERE status = 'live'").all();
  for (const row of live) {
    await recordLiveEventAttendance(guild, row);
    const scheduledEnd = Number(row.start_at) + Number(row.duration_minutes) * 60000;
    if (now() >= scheduledEnd) await endCommunityEvent(guild, row.id, null, true);
  }
}
function voiceMetricsBetween(start, end) {
  const rows = db.prepare(`SELECT user_id, joined_at, left_at FROM voice_sessions
    WHERE joined_at < ? AND COALESCE(left_at, ?) > ?`).all(end, end, start);
  const users = new Set();
  let seconds = 0;
  for (const row of rows) {
    const from = Math.max(Number(row.joined_at), Number(start));
    const to = Math.min(Number(row.left_at ?? end), Number(end));
    if (to <= from) continue;
    users.add(String(row.user_id));
    seconds += Math.floor((to - from) / 1000);
  }
  return { participants: users.size, seconds };
}
function formatVoiceDuration(seconds) {
  const mins = Math.max(0, Math.floor(Number(seconds ?? 0) / 60));
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours && rem) return `${hours}h ${rem}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}
function healthMetrics(guild, days = 7) {
  const cutoff = now() - days * 86400000;
  const humans = guild.members.cache.filter((m) => !m.user.bot);
  const verifiedRole = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const verified = verifiedRole ? humans.filter((m) => m.roles.cache.has(verifiedRole.id)).size : 0;
  const online = humans.filter((m) => m.presence && m.presence.status !== 'offline').size;
  const joins = Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE joined_at >= ?').get(cutoff)?.c ?? 0);
  const verifications = Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE verified_at >= ?').get(cutoff)?.c ?? 0);
  const activeMembers = Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM activity_daily WHERE last_activity_at >= ?').get(cutoff)?.c ?? 0);
  const activeRate = humans.size ? Math.round((activeMembers / humans.size) * 100) : 0;
  const contributors = Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM xp_log WHERE created_at >= ? AND amount > 0').get(cutoff)?.c ?? 0);
  const qualifiedMessages = qualifiedMessageCountBetween(cutoff, now());
  const validReferrals = Number(db.prepare("SELECT COUNT(*) AS c FROM xp_log WHERE created_at >= ? AND (reason LIKE 'Valid 7-day referral:%' OR reason LIKE 'Moderator-confirmed 7-day referral:%') AND amount > 0").get(cutoff)?.c ?? 0);
  const social = Number(db.prepare("SELECT COUNT(*) AS c FROM social_submissions WHERE status = 'approved' AND reviewed_at >= ?").get(cutoff)?.c ?? 0);
  const suggestions = Number(db.prepare('SELECT COUNT(*) AS c FROM product_suggestions WHERE created_at >= ?').get(cutoff)?.c ?? 0);
  const voice = voiceMetricsBetween(cutoff, now());
  const eventAttendees = Number(db.prepare(`SELECT COUNT(DISTINCT ea.user_id) AS c FROM event_attendance ea JOIN community_events ce ON ce.id = ea.event_id WHERE COALESCE(ce.ended_at, ce.start_at) >= ?`).get(cutoff)?.c ?? 0);
  const activated = Number(db.prepare(`SELECT COUNT(*) AS c
    FROM users u
    LEFT JOIN member_activation a ON a.user_id=u.user_id
    WHERE u.verified_at >= ?
      AND (
        a.interests_set=1 OR a.language_set=1 OR a.introduced_at IS NOT NULL OR a.first_impact_at IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM activity_daily ad
          WHERE ad.user_id = u.user_id AND ad.last_activity_at >= u.verified_at
        )
      )`).get(cutoff)?.c ?? 0);
  const activationRate = verifications ? Math.min(100, Math.round((activated / verifications) * 100)) : null;
  const rankCounts = Object.fromEntries(RANKS.map((r) => [r.name, 0]));
  for (const m of humans.values()) if (verifiedRole && m.roles.cache.has(verifiedRole.id)) rankCounts[rankForXp(getXp(m.id)).name]++;
  return { days, total: humans.size, verified, online, joins, verifications, activeMembers, activeRate, contributors, qualifiedMessages, validReferrals, social, suggestions, voiceParticipants: voice.participants, voiceSeconds: voice.seconds, eventAttendees, activated, activationRate, rankCounts };
}
function buildHealthEmbed(guild, days = 7) {
  const m = healthMetrics(guild, days);
  const ranks = RANKS.map((r) => `${r.name}: **${m.rankCounts[r.name]}**`).join(' · ');
  return new EmbedBuilder().setColor(BRAND.lime).setTitle(`📊 ${communityName()} Community Health · ${days}d`)
    .addFields(
      { name: 'Community', value: `Members: **${m.total}**\nVerified: **${m.verified}**\nOnline now: **${m.online}**`, inline: true },
      { name: `${days}d growth`, value: `New joins: **${m.joins}**\nVerified: **${m.verifications}**\nActivation: **${m.activationRate}%**`, inline: true },
      { name: `${days}d engagement`, value: `Active members: **${m.activeMembers}** (**${m.activeRate}%**)\nQualified messages: **${m.qualifiedMessages}**\nVoice participants: **${m.voiceParticipants}** (${formatVoiceDuration(m.voiceSeconds)})\nEvent attendees: **${m.eventAttendees}**`, inline: true },
      { name: 'Growth loops', value: `Valid referrals: **${m.validReferrals}**\nApproved social posts: **${m.social}**\nProduct suggestions: **${m.suggestions}**`, inline: true },
      { name: 'Rank distribution', value: ranks || 'No data' },
    ).setFooter({ text: '[KLINEO-COMMUNITY-HEALTH] · Auto-updated by LINKO' }).setTimestamp();
}
async function updateCommunityHealthDashboard(guild, days = getSettingInt('health_window_days') || 7) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'community-health' && c.isTextBased());
  if (!channel) return;
  await seedMessage(channel, '[KLINEO-COMMUNITY-HEALTH]', { embeds: [buildHealthEmbed(guild, days)] });
}
function scheduleHealthUpdate(_guild) {
  // Deliberately no immediate dashboard write here.
  // Health metrics remain live in the database; the persistent dashboard refreshes every 12h,
  // or immediately when staff run /refresh-health.
}
function modInboxCounts() {
  const cutoff = now() - 7 * 86400000;
  return {
    social: Number(db.prepare("SELECT COUNT(*) AS c FROM social_submissions WHERE status='pending'").get()?.c ?? 0),
    signalContent: moduleEnabled('signal_room') ? Number(db.prepare("SELECT COUNT(*) AS c FROM signal_submissions WHERE status='pending'").get()?.c ?? 0) : 0,
    kreatorProfiles: moduleEnabled('kreator') ? Number(db.prepare("SELECT COUNT(*) AS c FROM kreator_profiles WHERE status='pending'").get()?.c ?? 0) : 0,
    founders: moduleEnabled('founder_hub') ? Number(db.prepare("SELECT COUNT(*) AS c FROM founder_applications WHERE status='pending'").get()?.c ?? 0) : 0,
    suggestions: Number(db.prepare("SELECT COUNT(*) AS c FROM product_suggestions WHERE status IN ('submitted','reviewing')").get()?.c ?? 0),
    languageRequests: Number(db.prepare("SELECT COUNT(*) AS c FROM language_requests WHERE status='pending'").get()?.c ?? 0),
    languageDemand: Number(db.prepare("SELECT COUNT(*) AS c FROM language_demand_reviews WHERE status='pending'").get()?.c ?? 0),
    impact: Number(db.prepare('SELECT COUNT(*) AS c FROM message_candidates WHERE awarded=0 AND revoked=0 AND created_at >= ?').get(cutoff)?.c ?? 0),
    events: Number(db.prepare("SELECT COUNT(*) AS c FROM community_events WHERE status IN ('planned','live')").get()?.c ?? 0),
    unverified: Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE joined_at >= ? AND verified_at IS NULL').get(cutoff)?.c ?? 0),
    unattributed: Number(db.prepare('SELECT COUNT(*) AS c FROM unattributed_joins WHERE resolved = 0').get()?.c ?? 0),
    pendingInviterConfirmations: Number(db.prepare("SELECT COUNT(*) AS c FROM join_attribution WHERE source = 'member' AND source_confirmed = 1 AND inviter_confirmed = 0").get()?.c ?? 0),
  };
}
function buildModInboxEmbed() {
  const c = modInboxCounts();
  const total = c.social + c.signalContent + c.kreatorProfiles + c.founders + c.suggestions + c.languageRequests + c.languageDemand;
  return new EmbedBuilder().setColor(total ? BRAND.rose : BRAND.emerald).setTitle('📥 LINKO Moderator Inbox')
    .setDescription(total ? `**${total} review item${total === 1 ? '' : 's'} need attention.**` : '**No pending review items.**')
    .addFields(
      { name: 'Reviews', value: `KREATOR profiles: **${c.kreatorProfiles}**\nSocial posts: **${c.social}**\nSignal content: **${c.signalContent}**\nFounder applications: **${c.founders}**\nProduct suggestions: **${c.suggestions}**\nCatalog requests: **${c.languageRequests}**\nCommunity demand reviews: **${c.languageDemand}**`, inline: true },
      { name: 'Operations', value: `Impact candidates evaluating: **${c.impact}**\nUpcoming/live events: **${c.events}**\nNew unverified (7d): **${c.unverified}**\nJoin source missing: **${c.unattributed}**\nAwaiting inviter confirmation: **${c.pendingInviterConfirmations}**`, inline: true },
    ).setFooter({ text: '[KLINEO-MOD-INBOX] · Auto-updated by LINKO' }).setTimestamp();
}
async function updateModInbox(guild) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'mod-inbox' && c.isTextBased());
  if (!channel) return;
  await seedMessage(channel, '[KLINEO-MOD-INBOX]', { embeds: [buildModInboxEmbed()] });
}
function scheduleModInboxUpdate(guild) {
  scheduleGuildTimeout(modInboxUpdateTimers, guild, 3000, () => updateModInbox(guild).catch(console.error));
}
function accessRoleNames(access) {
  return ({
    verified: ['VERIFIED MEMBER'], analyst: ['ANALYST','OPERATOR','STRATEGIST','VANGUARD','PRIME'], strategist: ['STRATEGIST','VANGUARD','PRIME'],
    founders: ['VERIFIED FOUNDER','STUDIO CLIENT'], studio: ['STUDIO CLIENT'], creators: ['KREATOR'], staff: staffRoleNames(),
  })[access] ?? ['VERIFIED MEMBER'];
}
function accessOverwrites(guild, access) {
  const roles = accessRoleNames(access).map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
  const staff = staffRoleNames().map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
  const all = [...new Map([...roles, ...staff].map((r) => [r.id, r])).values()];
  return privateFor(guild.roles.everyone, all);
}
function accessVoiceOverwrites(guild, access) {
  const roles = accessRoleNames(access).map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
  const staff = staffRoleNames().map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
  const all = [...new Map([...roles, ...staff].map((r) => [r.id, r])).values()];
  return privateVoiceFor(guild.roles.everyone, all);
}
async function ensureManagedCategory(guild, categoryName, access) {
  const display = categoryName.includes('・') ? categoryName : `🧩・${String(categoryName).trim().toUpperCase()}`;
  let cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === display);
  if (!cat) cat = await guild.channels.create({ name: display, type: ChannelType.GuildCategory, permissionOverwrites: accessOverwrites(guild, access), reason: 'LINKO channel manager' });
  return cat;
}

function sanitizeProjectName(input) {
  return input.trim().replace(/[^a-zA-Z0-9 _.-]/g, '').replace(/\s+/g, ' ').slice(0, 40);
}
function platformUrlValid(platform, raw) {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    const allowed = {
      x: ['x.com', 'twitter.com'],
      linkedin: ['linkedin.com'],
      youtube: ['youtube.com', 'youtu.be'],
      tiktok: ['tiktok.com'],
      instagram: ['instagram.com'],
    };
    return u.protocol === 'https:' && (allowed[platform] ?? []).some((d) => h === d || h.endsWith(`.${d}`));
  } catch { return false; }
}

const IMAGE_SLOTS = { welcome: 'image_welcome', verify: 'image_verify', official: 'image_official', social: 'image_social', founder: 'image_founder' };
function safePublicUrl(raw) {
  if (!raw) return true;
  try { const u = new URL(raw); return ['https:', 'http:'].includes(u.protocol); } catch { return false; }
}
function profileValue(raw) { return String(raw ?? '').trim().slice(0, 180); }
function projectProfile() {
  return {
    name: communityName(),
    tagline: String(getSetting('project_tagline') ?? '').trim(),
    description: String(getSetting('project_description') ?? '').trim(),
    audience: String(getSetting('project_audience') ?? '').trim(),
    memberValue: String(getSetting('project_member_value') ?? '').trim(),
    products: String(getSetting('project_products') ?? '').trim(),
    status: String(getSetting('project_status') ?? '').trim(),
    firstAction: String(getSetting('project_first_action') ?? '').trim(),
    guidance: String(getSetting('project_guidance') ?? '').trim(),
    primaryLabel: String(getSetting('project_primary_label') ?? '').trim(),
    primaryUrl: String(getSetting('project_primary_url') || getSetting('official_website') || '').trim(),
    secondaryLabel: String(getSetting('project_secondary_label') ?? '').trim(),
    secondaryUrl: String(getSetting('project_secondary_url') || getSetting('official_liquidity_studio') || '').trim(),
  };
}
function projectProfileCoreComplete() {
  const p = projectProfile();
  return !!(p.name && p.name !== 'Community' && p.tagline && p.description && p.audience && p.memberValue);
}
function projectProfileComplete() {
  const p = projectProfile();
  return projectProfileCoreComplete() && !!(p.products && p.firstAction);
}
function projectLinkLabel(raw, url, fallback = 'Website') {
  const explicit = String(raw ?? '').trim().replace(/[\[\]]/g, '').slice(0, 80);
  if (explicit) return explicit;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || fallback;
  } catch { return fallback; }
}
function projectLinkMarkdown(label, url, fallback) {
  if (!url) return '';
  return `[${projectLinkLabel(label, url, fallback)}](${url})`;
}
function projectProfileSummaryEmbed() {
  const p = projectProfile();
  const e = new EmbedBuilder().setColor(BRAND.lime).setTitle(`${p.name} — Project Profile`);
  if (p.tagline) e.setDescription(`**${p.tagline}**`);
  if (p.description) e.addFields({ name: 'What is the project?', value: p.description.slice(0, 1024) });
  if (p.audience) e.addFields({ name: 'Who is it for?', value: p.audience.slice(0, 1024) });
  if (p.memberValue) e.addFields({ name: 'What members get here', value: p.memberValue.slice(0, 1024) });
  if (p.products) e.addFields({ name: 'Products / services', value: p.products.slice(0, 1024) });
  if (p.status) e.addFields({ name: 'Current status / milestone', value: p.status.slice(0, 1024) });
  if (p.firstAction) e.addFields({ name: 'First action for a new member', value: p.firstAction.slice(0, 1024) });
  if (p.guidance) e.addFields({ name: 'LINKO wording guidance', value: p.guidance.slice(0, 1024) });
  const official = [
    projectLinkMarkdown(p.primaryLabel, p.primaryUrl, 'Website'),
    p.secondaryUrl && p.secondaryUrl !== p.primaryUrl ? projectLinkMarkdown(p.secondaryLabel, p.secondaryUrl, 'Second product') : '',
  ].filter(Boolean);
  if (official.length) e.addFields({ name: 'Project links', value: official.join('\n').slice(0, 1024) });
  return e.setFooter({ text: 'LINKO Project Profile' });
}
async function showProjectProfileModal(interaction, mode = 'edit') {
  const p = projectProfile();
  const modal = new ModalBuilder()
    .setCustomId(mode === 'setup' ? 'project_profile_setup_modal' : 'project_profile_modal')
    .setTitle(mode === 'setup' ? 'Set up project profile' : 'Edit project profile');

  const fields = [
    new TextInputBuilder().setCustomId('project_name').setLabel('Project / community name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40).setValue(p.name === 'Community' ? interaction.guild.name.slice(0, 40) : p.name.slice(0, 40)),
    new TextInputBuilder().setCustomId('project_tagline').setLabel('One-line positioning').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(p.tagline.slice(0, 100)),
    new TextInputBuilder().setCustomId('project_description').setLabel('What is the project?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(800).setValue(p.description.slice(0, 800)),
    new TextInputBuilder().setCustomId('project_audience').setLabel('Who is it for?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setValue(p.audience.slice(0, 500)),
    new TextInputBuilder().setCustomId('project_member_value').setLabel('What should members get here?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(800).setValue(p.memberValue.slice(0, 800)),
  ];
  modal.addComponents(...fields.map((field) => new ActionRowBuilder().addComponents(field)));
  return interaction.showModal(modal);
}
function saveProjectProfileFromModal(interaction) {
  const name = interaction.fields.getTextInputValue('project_name').trim().slice(0, 40);
  const tagline = interaction.fields.getTextInputValue('project_tagline').trim().slice(0, 100);
  const description = interaction.fields.getTextInputValue('project_description').trim().slice(0, 800);
  const audience = interaction.fields.getTextInputValue('project_audience').trim().slice(0, 500);
  const memberValue = interaction.fields.getTextInputValue('project_member_value').trim().slice(0, 800);
  setSetting('community_name', name);
  setSetting('project_tagline', tagline);
  setSetting('project_description', description);
  setSetting('project_audience', audience);
  setSetting('project_member_value', memberValue);
}
function projectProfileDetailsActionRow(mode = 'edit') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(mode === 'setup' ? 'project_profile_details_setup' : 'project_profile_details_edit')
      .setLabel(mode === 'setup' ? 'CONTINUE PROJECT SETUP' : 'EDIT PROJECT DETAILS')
      .setStyle(ButtonStyle.Primary),
  );
}
async function showProjectProfileDetailsModal(interaction, mode = 'edit') {
  const p = projectProfile();
  const modal = new ModalBuilder()
    .setCustomId(mode === 'setup' ? 'project_profile_details_setup_modal' : 'project_profile_details_modal')
    .setTitle(mode === 'setup' ? 'Project details · step 2 of 2' : 'Edit project details');

  const fields = [
    new TextInputBuilder().setCustomId('project_products').setLabel('Main products / services').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(700).setValue(p.products.slice(0, 700)),
    new TextInputBuilder().setCustomId('project_status').setLabel('Current status / milestone').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300).setValue(p.status.slice(0, 300)),
    new TextInputBuilder().setCustomId('project_first_action').setLabel('What should a new member do first?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setValue(p.firstAction.slice(0, 500)),
    new TextInputBuilder().setCustomId('project_primary_url').setLabel('Primary website / app URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300).setValue(p.primaryUrl.slice(0, 300)),
    new TextInputBuilder().setCustomId('project_guidance').setLabel('What should LINKO highlight or avoid?').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(700).setValue(p.guidance.slice(0, 700)),
  ];
  modal.addComponents(...fields.map((field) => new ActionRowBuilder().addComponents(field)));
  return interaction.showModal(modal);
}
function saveProjectProfileDetailsFromModal(interaction) {
  const products = interaction.fields.getTextInputValue('project_products').trim().slice(0, 700);
  const status = interaction.fields.getTextInputValue('project_status').trim().slice(0, 300);
  const firstAction = interaction.fields.getTextInputValue('project_first_action').trim().slice(0, 500);
  const primaryUrl = interaction.fields.getTextInputValue('project_primary_url').trim().slice(0, 300);
  const guidance = interaction.fields.getTextInputValue('project_guidance').trim().slice(0, 700);
  if (primaryUrl && !officialLinkUrlValid(primaryUrl)) return { ok: false, error: 'Primary website/app URL must be a valid https:// URL.' };
  setSetting('project_products', products);
  setSetting('project_status', status);
  setSetting('project_first_action', firstAction);
  setSetting('project_primary_url', primaryUrl);
  setSetting('project_guidance', guidance);
  if (primaryUrl) setSetting('official_website', primaryUrl);
  return { ok: true };
}
async function showProjectProfileLinksModal(interaction) {
  const p = projectProfile();
  const modal = new ModalBuilder()
    .setCustomId('project_profile_links_modal')
    .setTitle('Edit project welcome links');

  const fields = [
    new TextInputBuilder().setCustomId('project_primary_label').setLabel('Primary link label').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80).setValue(p.primaryLabel.slice(0, 80)),
    new TextInputBuilder().setCustomId('project_primary_url').setLabel('Primary product / website URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300).setValue(p.primaryUrl.slice(0, 300)),
    new TextInputBuilder().setCustomId('project_secondary_label').setLabel('Second link label').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80).setValue(p.secondaryLabel.slice(0, 80)),
    new TextInputBuilder().setCustomId('project_secondary_url').setLabel('Second product / service URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300).setValue(p.secondaryUrl.slice(0, 300)),
  ];
  modal.addComponents(...fields.map((field) => new ActionRowBuilder().addComponents(field)));
  return interaction.showModal(modal);
}
function saveProjectProfileLinksFromModal(interaction) {
  const primaryLabel = interaction.fields.getTextInputValue('project_primary_label').trim().replace(/[\[\]]/g, '').slice(0, 80);
  const primaryUrl = interaction.fields.getTextInputValue('project_primary_url').trim().slice(0, 300);
  const secondaryLabel = interaction.fields.getTextInputValue('project_secondary_label').trim().replace(/[\[\]]/g, '').slice(0, 80);
  const secondaryUrl = interaction.fields.getTextInputValue('project_secondary_url').trim().slice(0, 300);
  if (primaryLabel && !primaryUrl) return { ok: false, error: 'Primary link label needs a matching URL.' };
  if (secondaryLabel && !secondaryUrl) return { ok: false, error: 'Second link label needs a matching URL.' };
  if (primaryUrl && !officialLinkUrlValid(primaryUrl)) return { ok: false, error: 'Primary project link must be a valid https:// URL.' };
  if (secondaryUrl && !officialLinkUrlValid(secondaryUrl)) return { ok: false, error: 'Second project link must be a valid https:// URL.' };
  setSetting('project_primary_label', primaryLabel);
  setSetting('project_primary_url', primaryUrl);
  setSetting('project_secondary_label', secondaryLabel);
  setSetting('project_secondary_url', secondaryUrl);
  if (primaryUrl) setSetting('official_website', primaryUrl);
  return { ok: true };
}
function seedKlineOProjectProfile(guild) {
  const isKlineO = String(guild?.name ?? '').trim().toLowerCase() === 'klineo' || String(getSetting('community_name') ?? '').trim().toLowerCase() === 'klineo';
  if (!isKlineO) return false;
  if (!getSetting('community_name')) setSetting('community_name', 'KlineO');
  if (!getSetting('project_tagline')) setSetting('project_tagline', 'Agentic operating layer for digital asset markets.');
  if (!getSetting('project_description')) setSetting('project_description', 'KlineO connects AI-driven market intelligence with trading and liquidity operations across two products: KlineO.xyz for agentic trading and execution, and KlineO.io for liquidity intelligence and operations.');
  if (!getSetting('project_audience')) setSetting('project_audience', 'Traders, creators, communities, professional teams, founders, issuers, foundations, ecosystems and exchanges.');
  if (!getSetting('project_member_value')) setSetting('project_member_value', 'Product updates, market discussion, trading workflows, AI-agent experiments, creator opportunities, founder and liquidity conversations, events, feedback loops and KXP-based community progression.');
  if (!getSetting('project_products')) setSetting('project_products', 'KlineO.xyz: agentic trading, execution and workflow tooling for traders, creators, communities and professional teams. KlineO.io: liquidity intelligence and operations for issuers, foundations, ecosystems and exchanges.');
  if (!getSetting('project_status')) setSetting('project_status', 'Beyond early beta, with more than $3.8M in routed trading volume. Binance, Bybit and HyperLiquid are connected, with KuCoin and additional integrations incoming.');
  if (!getSetting('project_first_action')) setSetting('project_first_action', 'Choose the roles that fit you, complete onboarding, then explore KlineO.xyz if you are a trader or creator, or KlineO.io if you represent a project, ecosystem, foundation or exchange.');
  if (!getSetting('project_guidance')) setSetting('project_guidance', 'Keep KlineO.xyz and KlineO.io clearly differentiated. Keep positioning product-led and infrastructure-led. Do not describe KXP as a token or financial asset.');
  if (!getSetting('project_primary_label')) setSetting('project_primary_label', 'KlineO.xyz · Trading & Execution');
  if (!getSetting('project_primary_url')) setSetting('project_primary_url', 'https://klineo.xyz');
  if (!getSetting('project_secondary_label')) setSetting('project_secondary_label', 'KlineO.io · Liquidity Intelligence');
  if (!getSetting('project_secondary_url')) setSetting('project_secondary_url', 'https://klineo.io');
  if (!getSetting('official_website')) setSetting('official_website', 'https://klineo.xyz');
  if (!getSetting('official_liquidity_studio')) setSetting('official_liquidity_studio', 'https://klineo.io');
  if (!getSetting('official_x')) setSetting('official_x', 'https://x.com/klineoxyz');
  return true;
}
function configuredImage(slot) { return getSetting(IMAGE_SLOTS[slot]) || ''; }
function withImageOrPlaceholder(embed, slot, label) {
  const url = configuredImage(slot);
  if (url) return embed.setImage(url);
  return embed.addFields({ name: '🖼️ Image', value: `**${label} image not uploaded yet.**\nStaff: use \`/server-image set\` and upload the image for this section.` });
}
function buildWelcomeEmbed(channels) {
  const name = communityName();
  const label = xpLabel();
  const p = projectProfile();
  const founderLine = moduleEnabled('founder_hub') ? '\nFounders can apply with `/apply-founder`.' : '';
  const socialLine = moduleEnabled('kreator') ? ` Approved creator content can also earn ${label}.` : '';
  const website = p.primaryUrl || getSetting('official_website');
  const secondary = p.secondaryUrl || getSetting('official_liquidity_studio');

  const e = new EmbedBuilder().setColor(BRAND.lime).setTitle(`Welcome to ${name}`);

  if (p.tagline || p.description) {
    e.setDescription(`${p.tagline ? `**${p.tagline}**\n\n` : ''}${p.description || ''}`);
  } else {
    e.setDescription(`${name} is powered by LINKO community operations.`);
  }

  if (p.audience) e.addFields({ name: '👥 Who this is for', value: p.audience.slice(0, 1024) });
  if (p.products) e.addFields({ name: '🧩 Products & services', value: p.products.slice(0, 1024) });
  if (p.status) e.addFields({ name: '📍 Current status', value: p.status.slice(0, 1024) });
  if (p.memberValue) e.addFields({ name: '⚡ What you’ll find here', value: p.memberValue.slice(0, 1024) });

  const productLinks = [];
  if (website) productLinks.push(projectLinkMarkdown(p.primaryLabel, website, 'Website'));
  if (secondary && secondary !== website) productLinks.push(projectLinkMarkdown(p.secondaryLabel, secondary, 'Second product'));
  if (productLinks.length) e.addFields({ name: '🔗 Explore', value: productLinks.join(' · ') });

  e.addFields({
    name: '🚀 Start here',
    value: `1. Read <#${channels.rules.id}>\n2. Run \`/join-source\` and tell LINKO how you joined ${name}\n3. Verify in <#${channels.verify.id}>\n4. Enter as **OBSERVER**\n5. Earn ${label} through meaningful participation, official voice events and valid referrals.${socialLine}${founderLine}\n\nAfter verification, run \`/onboarding\` to choose your interests/languages and complete your activation checklist.`
  });

  if (p.firstAction) e.addFields({ name: '➡️ Your first project step', value: p.firstAction.slice(0, 1024) });

  e.addFields({
    name: '🔐 Security',
    value: `${name} staff will never DM you first asking for funds, seed phrases, private keys or wallet recovery information.`
  });

  e.setFooter({ text: '[KLINEO-WELCOME]' });
  return withImageOrPlaceholder(e, 'welcome', 'Welcome');
}
function buildVerifyEmbed() {
  const name = communityName();
  const e = new EmbedBuilder().setColor(BRAND.lime).setTitle(`Join ${name}`)
    .setDescription(`Click **START ONBOARDING**. LINKO will ask how you joined, then ask you to choose **Community Member** or **KREATOR** before verification. KREATORS submit primary/secondary socials and follower counts for staff approval. No slash commands are required.\n\nAfter verification, your optional socials, interests, languages and payout wallets can be added or updated anytime from **MY LINKO PROFILE**.\n\nBy verifying, you confirm that you have read the rules and understand that ${name} staff will never ask for your seed phrase, private key, or funds via unsolicited DM.`)
    .setFooter({ text: '[KLINEO-VERIFY]' });
  return withImageOrPlaceholder(e, 'verify', 'Verification');
}
function buildSocialEmbed() {
  const label = xpLabel();
  const name = communityName();
  const e = new EmbedBuilder().setColor(BRAND.blue).setTitle(`${name} Published Kontents`)
    .setDescription(`Approved social posts from **Community Members and KREATORS** are published here. Use **/submit-content social** to submit a post for review.\n\nEach approved post earns **+${getSettingInt('kxp_social_post')} ${label}**, maximum 2 rewarded posts/day. Approved KREATORS may also receive reaction milestone rewards and attach active KREATOR campaigns. Community Member posts contribute to Community + Overall rankings. KREATOR posts contribute to KREATOR + Overall rankings.`)
    .setFooter({ text: '[KLINEO-SOCIAL]' });
  return withImageOrPlaceholder(e, 'social', 'Social section');
}
const OFFICIAL_LINKS = {
  website: ['official_website', '🌐 Website'],
  liquidity_studio: ['official_liquidity_studio', '💧 Liquidity Studio'],
  x: ['official_x', '𝕏 X'],
  telegram: ['official_telegram', '💬 Telegram'],
  linkedin: ['official_linkedin', '💼 LinkedIn'],
  docs: ['official_docs', '📚 Docs'],
  support: ['official_support', '🛟 Support'],
};
function officialLinkKey(type) { return OFFICIAL_LINKS[type]?.[0] ?? null; }
function officialLinkUrlValid(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:'; } catch { return false; }
}
function teamProfiles() { return db.prepare('SELECT * FROM team_profiles ORDER BY role_title COLLATE NOCASE, user_id').all(); }
function buildOfficialLinksEmbed() {
  const name = communityName();
  const e = new EmbedBuilder().setColor(BRAND.lime).setTitle(`${name} — Official Links`)
    .setDescription(`Only trust links listed in this channel. ${name} staff will never DM you first asking for funds, seed phrases, private keys or wallet recovery information.`);
  const linkFields = Object.entries(OFFICIAL_LINKS).map(([type, [key, label]]) => ({ type, key, label, value: getSetting(key) })).filter((x) => x.value);
  if (linkFields.length) e.addFields(linkFields.map((x) => ({ name: x.label, value: x.value, inline: true })));
  else e.addFields({ name: '🔗 Official links', value: `**Not configured yet.**\n${coreRoleName()}: use \`/official-links set\` to add verified website and social links.` });
  const profiles = teamProfiles().slice(0, 10);
  if (profiles.length) e.addFields({ name: '👥 Official Founders & Team', value: profiles.map((p) => {
    const links = [p.website && `[Website](${p.website})`, p.x && `[X](${p.x})`, p.linkedin && `[LinkedIn](${p.linkedin})`, p.telegram && `[Telegram](${p.telegram})`].filter(Boolean).join(' · ');
    return `<@${p.user_id}> — **${p.role_title}**${links ? `\n${links}` : ''}`;
  }).join('\n\n') });
  e.setFooter({ text: '[KLINEO-OFFICIAL-LINKS]' });
  return withImageOrPlaceholder(e, 'official', 'Official Links');
}
function buildFounderHubEmbed() {
  const name = communityName();
  const studioText = moduleEnabled('liquidity_studio') ? ` and ${name} Liquidity Studio` : '';
  const e = new EmbedBuilder().setColor(BRAND.emerald).setTitle(`${name} Founder Hub`)
    .setDescription(`Verified founders can discuss market structure and community operations${studioText} here. Use \`/apply-founder\` to submit your project website, project socials, founder socials and role/title. Approved profiles are added to the private Founder Directory.`)
    .setFooter({ text: '[KLINEO-FOUNDERS]' });
  return withImageOrPlaceholder(e, 'founder', 'Founder Hub');
}
async function refreshBrandMessages(guild) {
  const ch = (base) => guild.channels.cache.find((c) => baseChannelName(c.name) === base && c.isTextBased());
  const welcome = ch('welcome'), verify = ch('verify'), links = ch('official-links'), social = ch(baseChannelName(CHANNEL_NAMES.sharePost)), founder = ch('founder-lobby');
  if (welcome && verify) {
    const channels = { rules: ch('rules'), verify };
    if (channels.rules) await seedMessage(welcome, '[KLINEO-WELCOME]', { embeds: [buildWelcomeEmbed(channels)] });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('linko_onboarding_start').setLabel('START ONBOARDING').setStyle(ButtonStyle.Success));
    await seedMessage(verify, '[KLINEO-VERIFY]', { embeds: [buildVerifyEmbed()], components: [row] });
  }
  if (links) await seedMessage(links, '[KLINEO-OFFICIAL-LINKS]', { embeds: [buildOfficialLinksEmbed()] });
  if (social) await seedMessage(social, '[KLINEO-SOCIAL]', { embeds: [buildSocialEmbed()] });
  if (founder) await seedMessage(founder, '[KLINEO-FOUNDERS]', { embeds: [buildFounderHubEmbed()] });
}

async function logCommandUse(interaction) {
  const channel = interaction.guild?.channels?.cache?.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
  if (!channel) return;
  const where = interaction.channelId ? `<#${interaction.channelId}>` : 'unknown channel';
  await channel.send(`⌨️ ${interaction.user} used **/${interaction.commandName}** in ${where}.`).catch(() => {});
}

async function migrateLegacyStructure(guild) {
  await guild.roles.fetch();
  await guild.channels.fetch();
  for (const [oldName, newName] of LEGACY_ROLE_NAMES) {
    const oldRole = guild.roles.cache.find((r) => r.name === oldName && !r.managed);
    const newRole = guild.roles.cache.find((r) => r.name === newName && !r.managed);
    if (oldRole && !newRole) await oldRole.setName(newName, 'LINKO v3 role-name migration').catch(() => {});
  }
  for (const [oldName, newName] of LEGACY_CATEGORY_NAMES) {
    const oldCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === oldName);
    const newCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === newName);
    if (oldCat && !newCat) await oldCat.setName(newName, 'LINKO v3 icon migration').catch(() => {});
  }
  for (const [oldName, newName] of LEGACY_CHANNEL_NAMES) {
    const oldChannel = guild.channels.cache.find((c) => c.name === oldName && c.type !== ChannelType.GuildCategory);
    const newChannel = guild.channels.cache.find((c) => c.name === newName && c.type !== ChannelType.GuildCategory);
    if (oldChannel && !newChannel) await oldChannel.setName(newName, 'LINKO v3 icon migration').catch(() => {});
  }
}

async function ensureCounterChannel(guild, category, kind, label, value, emoji) {
  const prefix = `${emoji}・${label}:`;
  let c = guild.channels.cache.find((x) => x.type === ChannelType.GuildVoice && x.parentId === category.id && x.name.startsWith(prefix));
  const name = `${prefix} ${value}`;
  const perms = [overwrite(guild.roles.everyone.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.Connect])];
  if (!c) c = await guild.channels.create({ name, type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: perms, reason: `LINKO ${kind} counter` });
  else {
    if (c.name !== name) await c.setName(name, `LINKO ${kind} counter refresh`).catch(() => {});
    await c.permissionOverwrites.set(perms, 'LINKO stats counter permissions').catch(() => {});
  }
  return c;
}

async function updateServerStats(guild, fetchPresences = false) {
  if (!guild) return;
  if (fetchPresences) {
    const timedFetch = (promise, ms = 15000) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Discord member fetch timed out after ${ms}ms`)), ms)),
    ]);
    await timedFetch(guild.members.fetch({ withPresences: true })).catch(() => timedFetch(guild.members.fetch()).catch(() => null));
  }
  const category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAMES.stats);
  if (!category) return;
  const humans = guild.members.cache.filter((m) => !m.user.bot);
  const total = humans.size;
  const online = humans.filter((m) => m.presence && m.presence.status !== 'offline').size;
  await ensureCounterChannel(guild, category, 'member', 'Members', total, '👥');
  await ensureCounterChannel(guild, category, 'online', 'Online', online, '🟢');
}

function scheduleStatsUpdate(guild) {
  scheduleGuildTimeout(statsUpdateTimers, guild, 2500, () => updateServerStats(guild, false).catch(console.error));
}

function leaderboardRows(guild, limit = 50) {
  const rows = db.prepare(`
    SELECT u.user_id, u.xp,
      (SELECT COUNT(*) FROM referrals r WHERE r.inviter_id = u.user_id AND r.valid_awarded = 1) AS valid_referrals,
      (SELECT COUNT(*) FROM social_submissions s WHERE s.user_id = u.user_id AND s.status = 'approved') AS approved_social,
      COALESCE((SELECT MAX(created_at) FROM xp_log x WHERE x.user_id = u.user_id), 0) AS last_xp_at
    FROM users u
    WHERE u.xp > 0
    ORDER BY u.xp DESC, valid_referrals DESC, approved_social DESC, last_xp_at ASC, u.user_id ASC
  `).all();
  return rows.filter((r) => {
    const member = guild.members.cache.get(r.user_id);
    return !!member && !member.user.bot && hasVerifiedRole(member);
  }).slice(0, limit);
}

function referralLeaderboardRows(guild, limit = 50) {
  const rows = db.prepare(`
    SELECT r.inviter_id AS user_id,
           SUM(CASE WHEN r.valid_awarded = 1 THEN 1 ELSE 0 END) AS valid_referrals,
           COUNT(*) AS total_referrals,
           COALESCE((SELECT xp FROM users u WHERE u.user_id = r.inviter_id), 0) AS xp
    FROM referrals r
    GROUP BY r.inviter_id
    HAVING valid_referrals > 0
    ORDER BY valid_referrals DESC, total_referrals DESC, xp DESC, inviter_id ASC
  `).all();
  return rows.filter((r) => {
    const member = guild.members.cache.get(r.user_id);
    return !!member && !member.user.bot && hasVerifiedRole(member);
  }).slice(0, limit);
}

function communityLeaderboardRows(guild, limit = 50) {
  const rows = db.prepare(`
    SELECT u.user_id, u.xp,
      (SELECT COUNT(*) FROM referrals r WHERE r.inviter_id = u.user_id AND r.valid_awarded = 1) AS valid_referrals,
      COALESCE((SELECT MAX(created_at) FROM xp_log x WHERE x.user_id = u.user_id), 0) AS last_xp_at
    FROM users u
    WHERE u.xp > 0
    ORDER BY u.xp DESC, valid_referrals DESC, last_xp_at ASC, u.user_id ASC
  `).all();
  return rows.filter((r) => isCommunityLeaderboardEligible(guild.members.cache.get(r.user_id))).slice(0, limit);
}

function creatorLeaderboardRows(guild, limit = 50) {
  const rows = db.prepare(`
    SELECT u.user_id, u.xp,
      (SELECT COUNT(*) FROM social_submissions s WHERE s.user_id=u.user_id AND s.status='approved' AND COALESCE(s.creator_eligible,0)=1) AS approved_posts,
      COALESCE((SELECT SUM(COALESCE(s.xp_awarded,0)+COALESCE(s.reaction_xp_awarded,0)) FROM social_submissions s WHERE s.user_id=u.user_id AND s.status='approved' AND COALESCE(s.creator_eligible,0)=1),0) AS creator_post_kxp,
      COALESCE((SELECT MAX(created_at) FROM xp_log x WHERE x.user_id=u.user_id),0) AS last_xp_at
    FROM users u
    WHERE u.xp > 0
    ORDER BY u.xp DESC, approved_posts DESC, creator_post_kxp DESC, last_xp_at ASC, u.user_id ASC
  `).all();
  return rows.filter((r) => {
    const member = guild.members.cache.get(r.user_id);
    return !!member && !member.user.bot && hasVerifiedRole(member) && hasKreatorRole(member) && kreatorProfileApproved(member.id);
  }).slice(0, limit);
}

function creatorCampaignById(campaignId) {
  return db.prepare('SELECT * FROM creator_campaigns WHERE id = ?').get(campaignId);
}

function creatorCampaigns(status = null) {
  return status
    ? db.prepare('SELECT * FROM creator_campaigns WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM creator_campaigns ORDER BY id DESC').all();
}

function campaignLeaderboardRows(guild, campaignId, limit = 50) {
  const rows = db.prepare(`
    SELECT s.user_id,
           SUM(COALESCE(s.xp_awarded, 0) + COALESCE(s.reaction_xp_awarded, 0)) AS campaign_kxp,
           COUNT(*) AS approved_posts,
           SUM(COALESCE(s.reaction_xp_awarded, 0)) AS reaction_kxp
    FROM social_submissions s
    WHERE s.status = 'approved' AND COALESCE(s.creator_eligible, 0) = 1 AND s.campaign_id = ?
    GROUP BY s.user_id
    HAVING campaign_kxp > 0
    ORDER BY campaign_kxp DESC, approved_posts DESC, reaction_kxp DESC, s.user_id ASC
  `).all(campaignId);
  return rows.filter((r) => {
    const member = guild.members.cache.get(r.user_id);
    return !!member && !member.user.bot && hasVerifiedRole(member) && hasKreatorRole(member) && kreatorProfileApproved(member.id);
  }).slice(0, limit);
}

function creatorReactionCount(submissionId) {
  return Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM creator_post_reactions WHERE submission_id = ?').get(submissionId)?.c ?? 0);
}

function buildCommunityLeaderboardEmbeds(guild, limit = 50) {
  const label = xpLabel();
  const rows = communityLeaderboardRows(guild, limit);
  const chunks = leaderboardChunks(rows, 25);
  return chunks.map((chunk, chunkIndex) => {
    const offset = chunkIndex * 25;
    const lines = chunk.length ? chunk.map((r, i) => {
      const medal = offset + i === 0 ? '🥇 ' : offset + i === 1 ? '🥈 ' : offset + i === 2 ? '🥉 ' : '';
      return `${medal}**${String(offset + i + 1).padStart(2, '0')}.** <@${r.user_id}> — **${Number(r.xp).toLocaleString()} ${label}** · ${rankForXp(Number(r.xp)).name}`;
    }).join('\n') : 'No Community Member activity yet.';
    return new EmbedBuilder().setColor(BRAND.cyan)
      .setTitle(chunkIndex === 0 ? `👥 ${guild.name} Community Leaderboard · Top 50` : `👥 ${guild.name} Community Leaderboard · 26–50`)
      .setDescription(lines)
      .setFooter({ text: `[KLINEO-COMMUNITY-LEADERBOARD] · Community Members only · KREATORS excluded · Auto-updated by LINKO` })
      .setTimestamp();
  });
}

function buildCreatorLeaderboardEmbeds(guild, limit = 50) {
  const label = xpLabel();
  const rows = creatorLeaderboardRows(guild, limit);
  const chunks = leaderboardChunks(rows, 25);
  return chunks.map((chunk, chunkIndex) => {
    const offset = chunkIndex * 25;
    const lines = chunk.length ? chunk.map((r, i) => {
      const medal = offset + i === 0 ? '🥇 ' : offset + i === 1 ? '🥈 ' : offset + i === 2 ? '🥉 ' : '';
      return `${medal}**${String(offset + i + 1).padStart(2, '0')}.** <@${r.user_id}> — **${Number(r.xp).toLocaleString()} ${label}** · ${Number(r.approved_posts)} approved posts`;
    }).join('\n') : 'No approved KREATOR activity yet.';
    return new EmbedBuilder()
      .setColor(0xA855F7)
      .setTitle(chunkIndex === 0 ? `🎨 ${guild.name} KREATOR Leaderboard · Top 50` : `🎨 ${guild.name} KREATOR Leaderboard · 26–50`)
      .setDescription(lines)
      .setFooter({ text: `[KLINEO-KREATOR-LEADERBOARD] · Approved KREATORS only · Ranked by total ${label} · Auto-updated by LINKO` })
      .setTimestamp();
  });
}

function buildCampaignLeaderboardEmbeds(guild, campaignId, limit = 50) {
  const label = xpLabel();
  const campaign = creatorCampaignById(campaignId);
  if (!campaign) return [new EmbedBuilder().setColor(BRAND.rose).setTitle('Creator Campaign').setDescription(`Campaign #${campaignId} was not found.`)];
  const rows = campaignLeaderboardRows(guild, campaignId, limit);
  const chunks = leaderboardChunks(rows, 25);
  return chunks.map((chunk, chunkIndex) => {
    const offset = chunkIndex * 25;
    const lines = chunk.length ? chunk.map((r, i) => {
      const medal = offset + i === 0 ? '🥇 ' : offset + i === 1 ? '🥈 ' : offset + i === 2 ? '🥉 ' : '';
      return `${medal}**${String(offset + i + 1).padStart(2, '0')}.** <@${r.user_id}> — **${Number(r.campaign_kxp).toLocaleString()} ${label}** · ${Number(r.approved_posts)} approved · ${Number(r.reaction_kxp)} reaction ${label}`;
    }).join('\n') : 'No approved KREATOR posts in this campaign yet.';
    return new EmbedBuilder()
      .setColor(0xA855F7)
      .setTitle(chunkIndex === 0 ? `🏁 #${campaign.id} · ${campaign.name}` : `🏁 #${campaign.id} · ${campaign.name} · 26–50`)
      .setDescription(`${campaign.description ? `${campaign.description}\n\n` : ''}${lines}`)
      .setFooter({ text: `[KLINEO-CAMPAIGN-LEADERBOARD:${campaign.id}] · ${String(campaign.status).toUpperCase()} · Points also count toward KREATOR + overall ${label}` })
      .setTimestamp();
  });
}

function leaderboardChunks(rows, size = 25) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out.length ? out : [[]];
}

function buildLeaderboardEmbeds(guild, limit = 50) {
  const label = xpLabel();
  const rows = leaderboardRows(guild, limit);
  const chunks = leaderboardChunks(rows, 25);
  return chunks.map((chunk, chunkIndex) => {
    const offset = chunkIndex * 25;
    const lines = chunk.length ? chunk.map((r, i) => {
      const xp = Number(r.xp ?? 0);
      const rank = rankForXp(xp);
      const medal = offset + i === 0 ? '🥇 ' : offset + i === 1 ? '🥈 ' : offset + i === 2 ? '🥉 ' : '';
      return `${medal}**${String(offset + i + 1).padStart(2, '0')}.** <@${r.user_id}> — **${xp.toLocaleString()} ${label}** · ${rank.name}`;
    }).join('\n') : `No ${label} activity yet.`;
    return new EmbedBuilder()
      .setColor(BRAND.lime)
      .setTitle(chunkIndex === 0 ? `🏆 ${guild.name} Overall ${label} Leaderboard · Top 50` : `🏆 ${guild.name} Overall ${label} Leaderboard · 26–50`)
      .setDescription(lines)
      .setFooter({ text: `[KLINEO-KXP-LEADERBOARD] · Everyone · Community + KREATOR · Auto-updated by LINKO` })
      .setTimestamp();
  });
}

function buildReferralLeaderboardEmbeds(guild, limit = 50) {
  const rows = referralLeaderboardRows(guild, limit);
  const chunks = leaderboardChunks(rows, 25);
  return chunks.map((chunk, chunkIndex) => {
    const offset = chunkIndex * 25;
    const lines = chunk.length ? chunk.map((r, i) => {
      const medal = offset + i === 0 ? '🥇 ' : offset + i === 1 ? '🥈 ' : offset + i === 2 ? '🥉 ' : '';
      return `${medal}**${String(offset + i + 1).padStart(2, '0')}.** <@${r.user_id}> — **${Number(r.valid_referrals).toLocaleString()} valid** · ${Number(r.total_referrals).toLocaleString()} total`;
    }).join('\n') : 'No valid referrals yet.';
    return new EmbedBuilder()
      .setColor(BRAND.cyan)
      .setTitle(chunkIndex === 0 ? `🤝 ${guild.name} Referral Leaderboard · Top 50` : `🤝 ${guild.name} Referral Leaderboard · 26–50`)
      .setDescription(lines)
      .setFooter({ text: `[KLINEO-REFERRAL-LEADERBOARD] · Ranked by valid referrals · Auto-updated by LINKO` })
      .setTimestamp();
  });
}

function leaderboardChannelBase(type) {
  if (type === 'community') return 'community-leaderboard';
  if (type === 'referrals') return 'referral-leaderboard';
  if (type === 'creators') return 'kreator-leaderboard';
  if (type === 'campaign') return 'campaign-leaderboard';
  return xpChannelBase('leaderboard');
}

function leaderboardVisibilityKey(type) {
  if (type === 'community') return 'community_leaderboard_visibility';
  if (type === 'referrals') return 'referral_leaderboard_visibility';
  if (type === 'creators') return 'creator_leaderboard_visibility';
  if (type === 'campaign') return 'campaign_leaderboard_visibility';
  return 'kxp_leaderboard_visibility';
}

function leaderboardIsPublic(type) {
  return getSetting(leaderboardVisibilityKey(type)) !== 'private';
}

function canViewLeaderboard(member, type) {
  return leaderboardIsPublic(type) || hasStaffRole(member) || member?.permissions?.has?.(PermissionFlagsBits.Administrator);
}

async function setLeaderboardChannelVisibility(guild, type, visibility) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === leaderboardChannelBase(type) && c.isTextBased());
  if (!channel) return false;
  setSetupPhase('03/11 · Build permission model + categories');
  const everyone = guild.roles.everyone;
  const verified = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const staff = staffRoleNames().map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
  const overwrites = [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel])];
  if (visibility === 'public' && verified) overwrites.push(overwrite(verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]));
  for (const role of staff) overwrites.push(overwrite(role.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages]));
  await channel.permissionOverwrites.set(overwrites, `LINKO ${type} leaderboard visibility: ${visibility}`);
  return true;
}

async function updateLeaderboardMessage(guild, type = 'kxp') {
  const base = leaderboardChannelBase(type);
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === base && c.isTextBased());
  if (!channel) return;
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const marker = type === 'community' ? '[KLINEO-COMMUNITY-LEADERBOARD]' : type === 'referrals' ? '[KLINEO-REFERRAL-LEADERBOARD]' : type === 'creators' ? '[KLINEO-KREATOR-LEADERBOARD]' : '[KLINEO-KXP-LEADERBOARD]';
  const existing = recent?.find((m) => m.author.id === client.user.id && m.embeds.some((e) => e.footer?.text?.includes(marker) || (type === 'kxp' && e.footer?.text?.includes('[KLINEO-LEADERBOARD]'))));
  const limit = Math.max(1, Math.min(50, getSettingInt('leaderboard_limit') || 50));
  const embeds = type === 'community' ? buildCommunityLeaderboardEmbeds(guild, limit) : type === 'referrals' ? buildReferralLeaderboardEmbeds(guild, limit) : type === 'creators' ? buildCreatorLeaderboardEmbeds(guild, limit) : buildLeaderboardEmbeds(guild, limit);
  const payload = { embeds };
  if (existing) await existing.edit(payload).catch(() => {});
  else await channel.send(payload).catch(() => {});
}

function campaignLeaderboardRetentionSeconds() {
  return Math.max(1, getSettingInt('campaign_leaderboard_retention_days') || 7) * 86400;
}

function visibleCreatorCampaigns() {
  const cutoff = now() - campaignLeaderboardRetentionSeconds();
  return db.prepare(`
    SELECT * FROM creator_campaigns
    WHERE status = 'active'
       OR (status = 'closed' AND COALESCE(closed_at, 0) >= ?)
    ORDER BY id DESC
    LIMIT 10
  `).all(cutoff);
}

function pruneExpiredCampaignReactionRows() {
  const cutoff = now() - campaignLeaderboardRetentionSeconds();
  db.prepare(`
    DELETE FROM creator_post_reactions
    WHERE submission_id IN (
      SELECT s.id
      FROM social_submissions s
      JOIN creator_campaigns c ON c.id = s.campaign_id
      WHERE c.status = 'closed'
        AND COALESCE(c.closed_at, 0) < ?
    )
  `).run(cutoff);
}

async function updateCampaignLeaderboardMessages(guild) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'campaign-leaderboard' && c.isTextBased());
  if (!channel) return;
  pruneExpiredCampaignReactionRows();
  const campaigns = visibleCreatorCampaigns();
  const visibleIds = new Set(campaigns.map((c) => Number(c.id)));
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);

  // Remove expired campaign leaderboard messages. Lifetime KREATOR and overall KXP
  // remain untouched because awarded KXP is already persisted separately.
  if (recent) {
    for (const message of recent.values()) {
      if (message.author.id !== client.user.id) continue;
      const footer = message.embeds.map((e) => e.footer?.text ?? '').find((x) => x.includes('[KLINEO-CAMPAIGN-LEADERBOARD:'));
      if (!footer) continue;
      const match = footer.match(/\[KLINEO-CAMPAIGN-LEADERBOARD:(\d+)\]/);
      if (match && !visibleIds.has(Number(match[1]))) await message.delete().catch(() => {});
    }
  }

  if (!campaigns.length) {
    const marker = '[KLINEO-CAMPAIGN-LEADERBOARD:EMPTY]';
    const existing = recent?.find((m) => m.author.id === client.user.id && m.content?.includes(marker));
    const content = `**${communityName()} Creator Campaign Leaderboards**\n\nNo active or recently closed creator campaigns. Staff can use \`/creator-campaign create\`. Closed campaign boards remain visible for **${getSettingInt('campaign_leaderboard_retention_days')} days**.\n\n${marker}`;
    if (existing) await existing.edit({ content, embeds: [] }).catch(() => {});
    else await channel.send({ content }).catch(() => {});
    return;
  }

  const empty = recent?.find((m) => m.author.id === client.user.id && m.content?.includes('[KLINEO-CAMPAIGN-LEADERBOARD:EMPTY]'));
  if (empty) await empty.delete().catch(() => {});
  for (const campaign of campaigns) {
    const marker = `[KLINEO-CAMPAIGN-LEADERBOARD:${campaign.id}]`;
    const existing = recent?.find((m) => m.author.id === client.user.id && m.embeds.some((e) => e.footer?.text?.includes(marker)));
    const payload = { embeds: buildCampaignLeaderboardEmbeds(guild, campaign.id, Math.max(1, Math.min(50, getSettingInt('leaderboard_limit') || 50))) };
    if (existing) await existing.edit(payload).catch(() => {});
    else await channel.send(payload).catch(() => {});
  }
}

async function updateAllLeaderboards(guild) {
  await updateLeaderboardMessage(guild, 'kxp');
  await updateLeaderboardMessage(guild, 'community');
  await updateLeaderboardMessage(guild, 'referrals');
  await updateLeaderboardMessage(guild, 'creators');
  await updateCampaignLeaderboardMessages(guild);
}

function scheduleLeaderboardUpdate(guild) {
  scheduleGuildTimeout(leaderboardUpdateTimers, guild, 5000, () => updateAllLeaderboards(guild).catch(console.error));
}

function getKxpBreakdown(userId) {
  const total = getXp(userId);
  const rows = db.prepare('SELECT amount, reason FROM xp_log WHERE user_id = ?').all(userId);
  const out = { total, messages: 0, voice: 0, boosts: 0, referrals: 0, social: 0, bugs: 0, profile: 0, manual: 0 };
  for (const row of rows) {
    const amount = Number(row.amount ?? 0);
    const reason = String(row.reason ?? '');
    if (reason.startsWith('Meaningful message') || reason.startsWith('Qualified community message') || reason.startsWith('Reversed qualified community message')) out.messages += amount;
    else if (reason.startsWith('Qualifying voice activity') || reason.startsWith('Official voice event:') || reason.startsWith('Official voice speaker:')) out.voice += amount;
    else if (reason.startsWith('Server boost daily reward:')) out.boosts += amount;
    else if (reason.startsWith('Approved KlineO social contribution') || reason.startsWith('Creator reaction')) out.social += amount;
    else if (reason.startsWith('Valid bug report')) out.bugs += amount;
    else if (reason.startsWith('Profile submission:')) out.profile += amount;
    else if (reason.startsWith('Valid 7-day referral') || reason.startsWith('Moderator-confirmed 7-day referral') || reason.startsWith('Referral ') || reason.startsWith('Referred member ')) out.referrals += amount;
    else out.manual += amount;
  }
  return out;
}

function getReferralStats(userId) {
  const total = Number(db.prepare('SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ?').get(userId)?.c ?? 0);
  const valid = Number(db.prepare('SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ? AND valid_awarded = 1').get(userId)?.c ?? 0);
  const manual = Number(db.prepare("SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ? AND valid_awarded = 1 AND invite_code LIKE 'manual:%'").get(userId)?.c ?? 0);
  const claimed = Number(db.prepare("SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ? AND valid_awarded = 1 AND invite_code LIKE 'self:%'").get(userId)?.c ?? 0);
  const tracked = Math.max(0, valid - manual - claimed);
  const pending = Math.max(0, total - valid);
  const awaitingConfirmation = Number(db.prepare(`SELECT COUNT(*) AS c FROM referrals r JOIN join_attribution j ON j.user_id = r.member_id WHERE r.inviter_id = ? AND r.valid_awarded = 0 AND j.source = 'member' AND j.inviter_confirmed = 0`).get(userId)?.c ?? 0);
  const earned = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM xp_log WHERE user_id = ? AND (reason LIKE 'Valid 7-day referral:%' OR reason LIKE 'Moderator-confirmed 7-day referral:%' OR reason LIKE 'Referral %' OR reason LIKE 'Referred member %')`).get(userId)?.s ?? 0);
  return { total, valid, tracked, manual, claimed, pending, awaitingConfirmation, earned };
}

function walletNetworkLabel(network) {
  return network === 'solana' ? 'Solana' : 'EVM';
}

function walletAddressValid(network, address) {
  const value = String(address ?? '').trim();
  if (network === 'evm') return /^0x[a-fA-F0-9]{40}$/.test(value);
  if (network === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  return false;
}

function maskWallet(address) {
  const value = String(address ?? '');
  if (!value) return '—';
  if (value.length <= 14) return value;
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}

function walletRows(userId) {
  return db.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY network ASC').all(userId);
}

function walletPrimary(userId) {
  return db.prepare('SELECT primary_network FROM wallet_profiles WHERE user_id = ?').get(userId)?.primary_network ?? null;
}

function walletProfile(userId) {
  return db.prepare('SELECT * FROM wallet_profiles WHERE user_id = ?').get(userId) ?? null;
}

function normalizeXAccount(raw) {
  let value = String(raw ?? '').trim();
  try {
    if (/^https?:\/\//i.test(value)) {
      const u = new URL(value);
      const h = u.hostname.toLowerCase().replace(/^www\./, '');
      if (!['x.com', 'twitter.com'].includes(h)) return null;
      value = u.pathname.split('/').filter(Boolean)[0] ?? '';
    }
  } catch { return null; }
  value = value.replace(/^@/, '').trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(value) ? `@${value}` : null;
}

function normalizeTelegramAccount(raw) {
  let value = String(raw ?? '').trim();
  try {
    if (/^https?:\/\//i.test(value)) {
      const u = new URL(value);
      const h = u.hostname.toLowerCase().replace(/^www\./, '');
      if (!['t.me', 'telegram.me'].includes(h)) return null;
      value = u.pathname.split('/').filter(Boolean)[0] ?? '';
    }
  } catch { return null; }
  value = value.replace(/^@/, '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value) ? `@${value}` : null;
}

function normalizeLinkedInAccount(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'linkedin.com') return null;
    return `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}
function verificationButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('linko_onboarding_verify').setLabel(`VERIFY & ENTER ${communityNameUpper().slice(0, 24)}`).setStyle(ButtonStyle.Success),
  );
}
function participationSelectRow() {
  const menu = new StringSelectMenuBuilder().setCustomId('linko_onboarding_participation').setPlaceholder('Choose how you participate').setMinValues(1).setMaxValues(1).addOptions(
    new StringSelectMenuOptionBuilder().setLabel('Community Member').setValue('community').setDescription('Compete on the Community Leaderboard'),
    new StringSelectMenuOptionBuilder().setLabel('KREATOR').setValue('kreator').setDescription('Creator lane, profile review required'),
  );
  return new ActionRowBuilder().addComponents(menu);
}
function participationStepPayload(prefix = '') {
  return {
    content: `${prefix ? `${prefix}\n\n` : ''}**Step 2 of 3 · Choose your participation lane**\nChoose **Community Member** or **KREATOR**. The lanes are exclusive for leaderboard eligibility. KREATORS do not appear on the Community Leaderboard.`,
    components: [participationSelectRow()],
    embeds: [],
  };
}
const KREATOR_REAPPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
function kreatorReapplyRemainingMs(profile) {
  if (!profile || profile.status !== 'declined' || !profile.reviewed_at) return 0;
  return Math.max(0, Number(profile.reviewed_at) + KREATOR_REAPPLY_COOLDOWN_MS - now());
}
function kreatorReapplyText(profile) {
  const ms = kreatorReapplyRemainingMs(profile);
  if (ms <= 0) return null;
  const hours = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
  return `You can re-apply as KREATOR in about **${hours} hour${hours === 1 ? '' : 's'}**.`;
}
async function showKreatorProfileModal(interaction) {
  if (!moduleEnabled('kreator')) return interaction.reply({ content: 'The KREATOR module is disabled in this server.', ephemeral: true });
  const existing = kreatorProfile(interaction.user.id);
  const cooldownText = kreatorReapplyText(existing);
  if (cooldownText) return interaction.reply({ content: cooldownText, ephemeral: true });
  const modal = new ModalBuilder().setCustomId('linko_kreator_profile_modal').setTitle('KREATOR Profile');
  const primary = new TextInputBuilder().setCustomId('primary_url').setLabel('Primary social profile URL').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(220).setPlaceholder('https://x.com/username');
  const primaryFollowers = new TextInputBuilder().setCustomId('primary_followers').setLabel('Primary followers / subscribers').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12).setPlaceholder('12500');
  const secondary = new TextInputBuilder().setCustomId('secondary_url').setLabel('Secondary social URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(220).setPlaceholder('https://youtube.com/@username');
  const secondaryFollowers = new TextInputBuilder().setCustomId('secondary_followers').setLabel('Secondary followers (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setPlaceholder('3500');
  const category = new TextInputBuilder().setCustomId('category').setLabel('Creator niche / category').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80).setPlaceholder('Trading, AI, Crypto, Gaming, Education...');
  if (existing?.primary_url) primary.setValue(existing.primary_url);
  if (existing?.primary_followers != null) primaryFollowers.setValue(String(existing.primary_followers));
  if (existing?.secondary_url) secondary.setValue(existing.secondary_url);
  if (existing?.secondary_followers) secondaryFollowers.setValue(String(existing.secondary_followers));
  if (existing?.category) category.setValue(existing.category);
  modal.addComponents(...[primary, primaryFollowers, secondary, secondaryFollowers, category].map((x) => new ActionRowBuilder().addComponents(x)));
  return interaction.showModal(modal);
}
function profileActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('linko_profile_socials').setLabel('Socials').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('linko_profile_interests').setLabel('Interests').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('linko_profile_languages').setLabel('Communities').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('linko_profile_wallets').setLabel('Wallets').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('linko_profile_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
}
function profileKreatorActionRow(member) {
  if (!moduleEnabled('kreator')) return null;
  const profile = kreatorProfile(member.id);
  const lane = participationLane(member);
  let label = 'Apply as KREATOR';
  let style = ButtonStyle.Success;
  if (profile?.status === 'pending' || lane === 'kreator_pending') {
    label = 'KREATOR Application Pending';
    style = ButtonStyle.Secondary;
  } else if (profile?.status === 'approved' || hasKreatorRole(member)) {
    label = 'KREATOR Profile';
    style = ButtonStyle.Secondary;
  } else if (profile?.status === 'declined') {
    const remaining = kreatorReapplyRemainingMs(profile);
    if (remaining > 0) {
      const hours = Math.max(1, Math.ceil(remaining / (60 * 60 * 1000)));
      label = `Re-apply in ${hours}h`;
      style = ButtonStyle.Secondary;
    } else label = 'Re-apply as KREATOR';
  }
  const cooldownActive = profile?.status === 'declined' && kreatorReapplyRemainingMs(profile) > 0;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('linko_profile_kreator_apply')
      .setLabel(label)
      .setStyle(style)
      .setDisabled(profile?.status === 'pending' || lane === 'kreator_pending' || cooldownActive),
  );
}
function profileActionRows(member) {
  const rows = [profileActionRow()];
  const kreatorRow = profileKreatorActionRow(member);
  if (kreatorRow) rows.push(kreatorRow);
  return rows;
}
function profileLauncherRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('linko_profile_open').setLabel('MY LINKO PROFILE').setStyle(ButtonStyle.Primary),
  );
}
function memberProfileCompletion(userId) {
  const profile = walletProfile(userId);
  const socialDone = !!(profile?.x_account || profile?.telegram_account || profile?.linkedin_account);
  const interests = db.prepare('SELECT interest FROM user_interests WHERE user_id=? ORDER BY interest').all(userId);
  const languages = db.prepare('SELECT language_key FROM language_preferences WHERE user_id=? ORDER BY language_key').all(userId);
  const wallets = walletRows(userId);
  return { profile, socialDone, interests, languages, wallets, completed: [socialDone, interests.length > 0, languages.length > 0, wallets.length > 0].filter(Boolean).length, total: 4 };
}
function buildMemberProfileEmbed(guild, member) {
  const userId = member.id;
  const attribution = getJoinAttribution(userId);
  const data = memberProfileCompletion(userId);
  const xp = getXp(userId);
  const rank = rankForXp(xp);
  const interestLabels = data.interests.map((r) => interestByKey(r.interest)?.[1] ?? r.interest);
  const languageLabels = data.languages.map((r) => languageCatalogEntry(r.language_key)).filter(Boolean).map((r) => `${r.emoji || '🌐'} ${r.name}`);
  const walletLabels = data.wallets.map((r) => `${walletNetworkLabel(r.network)} · ${maskWallet(r.address)}`);
  let referral = 'Not applicable';
  if (attribution?.source === 'member' && attribution.inviter_id) {
    const inviter = guild.members.cache.get(attribution.inviter_id);
    const eligible = inviter && (hasVerifiedRole(inviter) || hasStaffRole(inviter));
    referral = `Invited by <@${attribution.inviter_id}> · ${eligible ? (Number(attribution.inviter_confirmed) ? 'confirmed / qualifying' : 'awaiting confirmation') : 'pending inviter verification'}`;
  }
  const pct = Math.round((data.completed / data.total) * 100);
  return new EmbedBuilder().setColor(BRAND.cyan).setTitle(`👤 ${communityName()} · My LINKO Profile`)
    .setDescription(`Your optional member profile never expires. Come back anytime to add or update details. **${data.completed}/${data.total} optional sections complete (${pct}%)**. Community Members can apply to become a KREATOR anytime from this profile.`)
    .addFields(
      { name: 'Membership', value: `${hasVerifiedRole(member) ? '✅ Verified' : '⬜ Not verified'} · **${rank.name}** · **${xp} ${xpLabel()}**`, inline: false },
      { name: 'Join source', value: attribution?.source ? `**${joinSourceLabel(attribution.source)}**` : 'Not selected', inline: true },
      { name: 'Participation', value: hasKreatorRole(member) ? (kreatorProfileApproved(member.id) ? '**KREATOR · Approved**' : '**KREATOR · Profile required**') : participationLane(member) === 'kreator_pending' ? '**KREATOR · Pending review**' : '**Community Member**', inline: true },
      { name: 'Referral', value: referral, inline: true },
      { name: 'Socials', value: data.socialDone ? [data.profile?.x_account && `X ${data.profile.x_account}`, data.profile?.telegram_account && `TG ${data.profile.telegram_account}`, data.profile?.linkedin_account && `LinkedIn saved`].filter(Boolean).join('\n') : '⬜ Not added', inline: true },
      { name: 'Interests', value: interestLabels.length ? interestLabels.join(', ') : '⬜ Not selected', inline: true },
      { name: 'Communities', value: languageLabels.length ? languageLabels.join(', ') : '⬜ Not selected', inline: true },
      { name: 'Wallets', value: walletLabels.length ? walletLabels.join('\n') : '⬜ Not submitted', inline: true },
    )
    .setFooter({ text: 'Socials, interests, communities and wallets are optional. Community Members can apply to become a KREATOR anytime.' });
}
async function showMemberProfile(interaction, mode = 'reply') {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction, mode);
  const payload = { embeds: [buildMemberProfileEmbed(interaction.guild, member)], components: profileActionRows(member), ephemeral: true };
  if (mode === 'update' && interaction.isMessageComponent()) return interaction.update({ embeds: payload.embeds, components: payload.components, content: null });
  if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds: payload.embeds, components: payload.components, content: null });
  return interaction.reply(payload);
}
async function ensureMemberProfileLauncher(guild) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-commands' && c.isTextBased());
  if (!channel) return false;
  await seedMessage(channel, '[LINKO-MY-PROFILE]', {
    content: `**MY LINKO PROFILE**\nUse this anytime to add or update socials, interests, languages and public payout wallet addresses. These details are optional and never expire.\n\n[LINKO-MY-PROFILE]`,
    components: [profileLauncherRow()],
  });
  return true;
}
async function recordMemberJoinSource(guild, member, inviterUser) {
  const name = communityName();
  const existingAttribution = getJoinAttribution(member.id);
  const joinedAt = member.joinedTimestamp ?? db.prepare('SELECT joined_at FROM users WHERE user_id=?').get(member.id)?.joined_at ?? now();
  if (!inviterUser) return { ok: false, message: 'Select the community member who invited you.' };
  if (inviterUser.id === member.id) return { ok: false, message: 'You cannot select yourself as your inviter.' };
  if (inviterUser.bot) return { ok: false, message: 'Bots cannot receive referral credit.' };
  if (existingAttribution?.detected_inviter_id && inviterUser.id !== existingAttribution.detected_inviter_id) {
    return { ok: false, message: `LINKO detected <@${existingAttribution.detected_inviter_id}> as the invite creator. Ask a moderator if that attribution is wrong.` };
  }
  const inviter = await guild.members.fetch(inviterUser.id).catch(() => null);
  if (!inviter) return { ok: false, message: `That user is not currently a member of ${name}.` };
  if (inviter.joinedTimestamp && Number(inviter.joinedTimestamp) >= Number(joinedAt)) return { ok: false, message: `The selected inviter must have joined ${name} before you.` };
  const existingReferral = db.prepare('SELECT * FROM referrals WHERE member_id = ?').get(member.id);
  if (existingReferral && existingReferral.inviter_id !== inviter.id) return { ok: false, message: `LINKO already has a different pending inviter: <@${existingReferral.inviter_id}>. Ask staff to resolve the attribution.` };
  if (!existingReferral) db.prepare('INSERT INTO referrals (member_id, inviter_id, invite_code, joined_at, valid_awarded) VALUES (?, ?, ?, ?, 0)').run(member.id, inviter.id, `self:${member.id}`, joinedAt);
  const detectedMatch = existingAttribution?.detected_inviter_id === inviter.id;
  upsertJoinAttribution(member.id, { source: 'member', inviterId: inviter.id, detectedInviterId: existingAttribution?.detected_inviter_id ?? null, sourceConfirmed: 1, inviterConfirmed: detectedMatch ? 1 : 0 });
  db.prepare('UPDATE unattributed_joins SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE user_id = ?').run(member.id, now(), member.id);
  const eligible = hasVerifiedRole(inviter) || hasStaffRole(inviter);
  const log = guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
  if (log) await log.send(`🧭 **Join source selected** — ${member} selected ${inviterUser} as inviter. ${eligible ? 'Inviter is verified/eligible.' : 'Inviter is not verified yet; referral reward remains pending.'} ${detectedMatch ? 'Discord invite detection confirms the attribution.' : 'Awaiting inviter confirmation after they are eligible.'}`).catch(() => {});
  if (!detectedMatch) {
    const dm = eligible
      ? `🤝 **${name} referral confirmation**\n${member.user.username} says you invited them. If correct, run **/confirm-invited member:${member.user.username}** in ${name}. Referral rewards remain subject to verification + 7 days + activity checks.`
      : `🤝 **${name} referral pending**\n${member.user.username} says you invited them. They can verify normally. Your referral credit is safely pending; verify your own ${name} membership first, then run **/confirm-invited member:${member.user.username}**.`;
    await inviter.send(dm).catch(() => {});
  }
  scheduleModInboxUpdate(guild);
  return { ok: true, inviter, inviterUser, detectedMatch, eligible };
}
async function showOnboardingEntry(interaction, mode = 'reply') {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (hasVerifiedRole(member)) return showMemberProfile(interaction, mode === 'update' ? 'update' : 'reply');
  const attribution = getJoinAttribution(member.id);
  if (attribution?.source && Number(attribution.source_confirmed)) {
    const lane = participationLane(member);
    if (!lane) {
      const payload = participationStepPayload(`✅ Join source saved as **${joinSourceLabel(attribution.source)}**${attribution.inviter_id ? ` with <@${attribution.inviter_id}>` : ''}.`);
      if (mode === 'update' && interaction.isMessageComponent()) return interaction.update(payload);
      return interaction.reply({ ...payload, ephemeral: true });
    }
    const content = `✅ Join source saved as **${joinSourceLabel(attribution.source)}**. Participation: **${lane.startsWith('kreator') ? 'KREATOR' : 'Community Member'}**.\n\n**Step 3 of 3 · Verify & enter ${communityName()}**`;
    if (mode === 'update' && interaction.isMessageComponent()) return interaction.update({ content, embeds: [], components: [verificationButtonRow()] });
    return interaction.reply({ content, components: [verificationButtonRow()], ephemeral: true });
  }
  const menu = new StringSelectMenuBuilder().setCustomId('linko_onboarding_source').setPlaceholder('How did you find or join this community?').addOptions(
    new StringSelectMenuOptionBuilder().setLabel('Invited by a community member').setValue('member').setDescription('Select the person who invited you'),
    new StringSelectMenuOptionBuilder().setLabel('Found community myself').setValue('organic'),
    new StringSelectMenuOptionBuilder().setLabel('X / social media').setValue('x'),
    new StringSelectMenuOptionBuilder().setLabel('Telegram').setValue('telegram'),
    new StringSelectMenuOptionBuilder().setLabel('Event / AMA').setValue('event'),
    new StringSelectMenuOptionBuilder().setLabel('Partner / creator').setValue('partner'),
  );
  const payload = { content: `**Step 1 of 3 · How did you join ${communityName()}?**\nChoose one option below. This is used for community analytics and accurate referral attribution.`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true };
  if (mode === 'update' && interaction.isMessageComponent()) return interaction.update({ content: payload.content, components: payload.components, embeds: [] });
  return interaction.reply(payload);
}
function inviterSelectRow() {
  const menu = new UserSelectMenuBuilder().setCustomId('linko_onboarding_inviter').setPlaceholder('Select the member who invited you').setMinValues(1).setMaxValues(1);
  return new ActionRowBuilder().addComponents(menu);
}
async function showProfileSocialsModal(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction);
  const profile = walletProfile(member.id);
  const modal = new ModalBuilder().setCustomId('linko_member_socials_modal').setTitle('My LINKO Socials');
  const x = new TextInputBuilder().setCustomId('x').setLabel('X username or profile URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setPlaceholder('@username');
  const telegram = new TextInputBuilder().setCustomId('telegram').setLabel('Telegram username or profile URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setPlaceholder('@username');
  const linkedin = new TextInputBuilder().setCustomId('linkedin').setLabel('LinkedIn profile URL').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(220).setPlaceholder('linkedin.com/in/username');
  if (profile?.x_account) x.setValue(profile.x_account);
  if (profile?.telegram_account) telegram.setValue(profile.telegram_account);
  if (profile?.linkedin_account) linkedin.setValue(profile.linkedin_account);
  modal.addComponents(new ActionRowBuilder().addComponents(x), new ActionRowBuilder().addComponents(telegram), new ActionRowBuilder().addComponents(linkedin));
  return interaction.showModal(modal);
}
async function showProfileWalletsModal(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction);
  const current = Object.fromEntries(walletRows(member.id).map((row) => [row.network, row.address]));
  const modal = new ModalBuilder().setCustomId('linko_member_wallets_modal').setTitle('My LINKO Wallets');
  const evm = new TextInputBuilder().setCustomId('evm').setLabel('EVM wallet (blank = remove)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('0x...');
  const sol = new TextInputBuilder().setCustomId('solana').setLabel('Solana wallet (blank = remove)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('Public Solana address');
  if (current.evm) evm.setValue(current.evm);
  if (current.solana) sol.setValue(current.solana);
  modal.addComponents(new ActionRowBuilder().addComponents(evm), new ActionRowBuilder().addComponents(sol));
  return interaction.showModal(modal);
}
async function showProfileInterestsSelect(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction);
  const selected = new Set(db.prepare('SELECT interest FROM user_interests WHERE user_id=?').all(member.id).map((r) => r.interest));
  const menu = new StringSelectMenuBuilder().setCustomId('linko_profile_interests_select').setPlaceholder('Choose your interests').setMinValues(0).setMaxValues(INTERESTS.length);
  menu.addOptions(INTERESTS.map(([key, label]) => new StringSelectMenuOptionBuilder().setLabel(label).setValue(key).setDefault(selected.has(key))));
  return interaction.reply({ content: '**Your interests**\nSelect any that apply. You can change these anytime.', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
}
async function showProfileLanguagesSelect(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction);
  ensureCatalogFromExistingLanguageRoles();
  const selected = new Set(languagePreferenceKeys(member.id));
  const baseMenu = new StringSelectMenuBuilder()
    .setCustomId('linko_profile_languages_base')
    .setPlaceholder('Choose preferred languages')
    .setMinValues(0)
    .setMaxValues(VISIBLE_COMMUNITY_CATALOG.length);
  baseMenu.addOptions(VISIBLE_COMMUNITY_CATALOG.map((entry) => {
    const active = activeLanguageRowForEntry(entry);
    const demand = languageDemandCount(entry.key);
    const description = entry.global ? 'Main global community' : active ? 'Language community active' : `${demand}/${LANGUAGE_DEMAND_THRESHOLD} interested before staff review`;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${entry.emoji} ${entry.name}`.slice(0, 100))
      .setValue(entry.key)
      .setDescription(description.slice(0, 100))
      .setDefault(selected.has(entry.key));
  }));
  const components = [new ActionRowBuilder().addComponents(baseMenu)];
  const custom = customLanguageCatalogRows().slice(0, 25);
  if (custom.length) {
    const customMenu = new StringSelectMenuBuilder()
      .setCustomId('linko_profile_languages_custom')
      .setPlaceholder('More approved communities')
      .setMinValues(0)
      .setMaxValues(custom.length);
    customMenu.addOptions(custom.map((row) => {
      const entry = languageCatalogEntry(row.language_key);
      const active = activeLanguageRowForEntry(entry);
      const demand = languageDemandCount(row.language_key);
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${row.emoji || '🌐'} ${row.name}`.slice(0, 100))
        .setValue(row.language_key)
        .setDescription((active ? 'Language community active' : `${demand}/${LANGUAGE_DEMAND_THRESHOLD} interested before staff review`).slice(0, 100))
        .setDefault(selected.has(row.language_key));
    }));
    components.push(new ActionRowBuilder().addComponents(customMenu));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('linko_language_request').setLabel('REQUEST ANOTHER COMMUNITY').setStyle(ButtonStyle.Secondary),
  ));
  return interaction.reply({
    content: `**Communities**\nSelect the country, region, or language-led communities you want to join. Choose multiple if relevant. **🌐 Global** stays in the main community and never creates a separate channel. Other communities are demand-tracked first; at **${LANGUAGE_DEMAND_THRESHOLD} members**, staff can activate a dedicated community space.`,
    components,
    ephemeral: true,
  });
}
async function updateLanguagePreferencesForScope(guild, member, scopeEntries, selectedKeys) {
  const selected = new Set(selectedKeys);
  for (const entry of scopeEntries) {
    if (selected.has(entry.key)) {
      db.prepare('INSERT OR IGNORE INTO language_preferences (user_id,language_key,selected_at) VALUES (?,?,?)').run(member.id, entry.key, now());
      await syncPreferredLanguageRole(guild, member, entry, true);
    } else {
      db.prepare('DELETE FROM language_preferences WHERE user_id=? AND language_key=?').run(member.id, entry.key);
      await syncPreferredLanguageRole(guild, member, entry, false);
    }
    await ensureLanguageDemandReview(guild, entry.key);
  }
  db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(member.id);
  const total = Number(db.prepare('SELECT COUNT(*) AS c FROM language_preferences WHERE user_id=?').get(member.id)?.c ?? 0);
  db.prepare('UPDATE member_activation SET language_set=? WHERE user_id=?').run(total > 0 ? 1 : 0, member.id);
  scheduleHealthUpdate(guild);
  return total;
}
async function awardFirstSubmissionKxp(guild, userId, item, label, actorId = null) {
  const exists = db.prepare('SELECT 1 FROM profile_submission_rewards WHERE user_id = ? AND item = ?').get(userId, item);
  if (exists) return 0;
  db.prepare('INSERT INTO profile_submission_rewards (user_id, item, awarded_at) VALUES (?, ?, ?)').run(userId, item, now());
  const award = Math.max(0, getSettingInt('kxp_profile_submission'));
  if (award > 0) await addXp(guild, userId, award, `Profile submission:${label}`, actorId);
  return award;
}

function joinSourceLabel(source) {
  const name = communityName();
  return ({
    member: `Invited by a ${name} member`,
    organic: `Found ${name} myself`,
    x: 'X / social media',
    telegram: 'Telegram',
    event: 'Event / AMA',
    partner: 'Partner / creator',
  })[source] ?? 'Not selected';
}

function getJoinAttribution(userId) {
  return db.prepare('SELECT * FROM join_attribution WHERE user_id = ?').get(userId) ?? null;
}

function upsertJoinAttribution(userId, { source = null, inviterId = null, detectedInviterId = null, sourceConfirmed = 0, inviterConfirmed = 0 } = {}) {
  const existing = getJoinAttribution(userId);
  const createdAt = Number(existing?.created_at ?? now());
  db.prepare(`INSERT INTO join_attribution
    (user_id, source, inviter_id, detected_inviter_id, source_confirmed, inviter_confirmed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      source = excluded.source,
      inviter_id = excluded.inviter_id,
      detected_inviter_id = COALESCE(excluded.detected_inviter_id, join_attribution.detected_inviter_id),
      source_confirmed = excluded.source_confirmed,
      inviter_confirmed = excluded.inviter_confirmed,
      updated_at = excluded.updated_at`)
    .run(userId, source, inviterId, detectedInviterId, Number(sourceConfirmed), Number(inviterConfirmed), createdAt, now());
  return getJoinAttribution(userId);
}

function referralActivityDays(userId, joinedAt) {
  const since = Number(joinedAt ?? 0);
  const timestamps = [];
  for (const row of db.prepare('SELECT created_at AS ts FROM xp_log WHERE user_id = ? AND amount > 0 AND created_at >= ?').all(userId, since)) timestamps.push(Number(row.ts));
  for (const row of db.prepare('SELECT created_at AS ts FROM message_candidates WHERE user_id = ? AND created_at >= ?').all(userId, since)) timestamps.push(Number(row.ts));
  for (const row of db.prepare('SELECT submitted_at AS ts FROM social_submissions WHERE user_id = ? AND submitted_at >= ?').all(userId, since)) timestamps.push(Number(row.ts));
  for (const row of db.prepare('SELECT created_at AS ts FROM product_suggestions WHERE user_id = ? AND created_at >= ?').all(userId, since)) timestamps.push(Number(row.ts));
  for (const row of db.prepare('SELECT first_seen_at AS ts FROM event_attendance WHERE user_id = ? AND first_seen_at >= ?').all(userId, since)) timestamps.push(Number(row.ts));
  return new Set(timestamps.filter(Number.isFinite).map((ts) => dayKey(ts))).size;
}

function referralActivityCount(userId, joinedAt) {
  const since = Number(joinedAt ?? 0);
  let count = 0;
  count += Number(db.prepare('SELECT COUNT(*) AS c FROM xp_log WHERE user_id = ? AND amount > 0 AND created_at >= ?').get(userId, since)?.c ?? 0);
  count += Number(db.prepare('SELECT COUNT(*) AS c FROM message_candidates WHERE user_id = ? AND created_at >= ?').get(userId, since)?.c ?? 0);
  count += Number(db.prepare('SELECT COUNT(*) AS c FROM social_submissions WHERE user_id = ? AND submitted_at >= ?').get(userId, since)?.c ?? 0);
  count += Number(db.prepare('SELECT COUNT(*) AS c FROM product_suggestions WHERE user_id = ? AND created_at >= ?').get(userId, since)?.c ?? 0);
  count += Number(db.prepare('SELECT COUNT(*) AS c FROM event_attendance WHERE user_id = ? AND first_seen_at >= ?').get(userId, since)?.c ?? 0);
  return count;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toIso(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function leaderboardCsv(guild, type) {
  const label = xpLabel();
  const lines = [];
  if (type === 'kxp') {
    lines.push(['Position','Discord Username','Display Name','Discord User ID','Rank',`Total ${label}`,`Message ${label}`,`Voice ${label}`,`Referral ${label}`,`Social ${label}`,`Bug ${label}`,`Profile/Wallet ${label}`,`Manual/Other ${label}`,'Valid Referrals','Tracked Referrals','Member Declared Referrals','Moderator Confirmed Referrals','Approved Social Posts','Validated Bugs','Joined Server','Verified At','Last Activity'].map(csvEscape).join(','));
    const rows = leaderboardRows(guild, 100000);
    rows.forEach((row, index) => {
      const member = guild.members.cache.get(row.user_id);
      const userRow = db.prepare('SELECT verified_at, joined_at, last_seen_at FROM users WHERE user_id = ?').get(row.user_id) ?? {};
      const b = getKxpBreakdown(row.user_id);
      const refs = getReferralStats(row.user_id);
      lines.push([
        index + 1, member?.user?.username ?? '', member?.displayName ?? '', row.user_id, rankForXp(Number(row.xp)).name,
        b.total, b.messages, b.voice, b.referrals, b.social, b.bugs, b.profile, b.manual,
        refs.valid, refs.tracked, refs.claimed, refs.manual, approvedSocialCount(row.user_id), validBugCount(row.user_id),
        toIso(member?.joinedTimestamp ?? userRow.joined_at), toIso(userRow.verified_at), toIso(userRow.last_seen_at),
      ].map(csvEscape).join(','));
    });
  } else if (type === 'community' || type === 'creators') {
    lines.push(['Position','Discord Username','Display Name','Discord User ID','Lane','Rank',`Total ${label}`,'Approved KREATOR Posts','Primary Social','Primary Followers','Secondary Social','Secondary Followers'].map(csvEscape).join(','));
    const rows = type === 'community' ? communityLeaderboardRows(guild, 100000) : creatorLeaderboardRows(guild, 100000);
    rows.forEach((row, index) => {
      const member = guild.members.cache.get(row.user_id);
      const kp = kreatorProfile(row.user_id);
      lines.push([
        index + 1, member?.user?.username ?? '', member?.displayName ?? '', row.user_id,
        type === 'community' ? 'COMMUNITY' : 'KREATOR', rankForXp(Number(row.xp)).name, Number(row.xp),
        type === 'creators' ? Number(row.approved_posts ?? 0) : 0,
        kp?.primary_url ?? '', kp?.primary_followers ?? '', kp?.secondary_url ?? '', kp?.secondary_followers ?? '',
      ].map(csvEscape).join(','));
    });
  } else if (type === 'referrals') {
    lines.push(['Position','Discord Username','Display Name','Discord User ID','Valid Referrals','Tracked Referrals','Member Declared Referrals','Moderator Confirmed Referrals','Pending Referrals','Total Invited',`Referral ${label}`,`Current ${label}`,'Rank'].map(csvEscape).join(','));
    const rows = referralLeaderboardRows(guild, 100000);
    rows.forEach((row, index) => {
      const member = guild.members.cache.get(row.user_id);
      const refs = getReferralStats(row.user_id);
      const xp = getXp(row.user_id);
      lines.push([index + 1, member?.user?.username ?? '', member?.displayName ?? '', row.user_id, refs.valid, refs.tracked, refs.claimed, refs.manual, refs.pending, refs.total, refs.earned, xp, rankForXp(xp).name].map(csvEscape).join(','));
    });
  } else {
    lines.push(['Discord Username','Display Name','Discord User ID','Rank',`Total ${label}`,`Message ${label}`,`Voice ${label}`,`Referral ${label}`,`Social ${label}`,`Bug ${label}`,`Profile/Wallet ${label}`,`Manual/Other ${label}`,'Valid Referrals','Tracked Referrals','Member Declared Referrals','Moderator Confirmed Referrals','Approved Social Posts','Validated Bugs','Joined Server','Verified At','Last Activity'].map(csvEscape).join(','));
    const members = [...guild.members.cache.values()].filter((m) => !m.user.bot && hasVerifiedRole(m));
    members.sort((a, b) => getXp(b.id) - getXp(a.id) || a.id.localeCompare(b.id));
    for (const member of members) {
      const userRow = db.prepare('SELECT verified_at, joined_at, last_seen_at FROM users WHERE user_id = ?').get(member.id) ?? {};
      const b = getKxpBreakdown(member.id);
      const refs = getReferralStats(member.id);
      lines.push([member.user.username, member.displayName, member.id, rankForXp(b.total).name, b.total, b.messages, b.voice, b.referrals, b.social, b.bugs, b.profile, b.manual, refs.valid, refs.tracked, refs.claimed, refs.manual, approvedSocialCount(member.id), validBugCount(member.id), toIso(member.joinedTimestamp ?? userRow.joined_at), toIso(userRow.verified_at), toIso(userRow.last_seen_at)].map(csvEscape).join(','));
    }
  }
  return lines.join('\r\n');
}

function walletsCsv(guild, network = 'all') {
  const lines = [['Discord Username','Display Name','Discord User ID','Rank','X Account','Telegram','Network','Wallet Address','Primary','Submitted At','Updated At','Reward Eligible At'].map(csvEscape).join(',')];
  const rows = network === 'all'
    ? db.prepare('SELECT * FROM wallets ORDER BY user_id, network').all()
    : db.prepare('SELECT * FROM wallets WHERE network = ? ORDER BY user_id').all(network);
  for (const row of rows) {
    const member = guild.members.cache.get(row.user_id);
    if (!member || member.user.bot) continue;
    const primary = walletPrimary(row.user_id);
    const profile = walletProfile(row.user_id);
    lines.push([member.user.username, member.displayName, row.user_id, rankForXp(getXp(row.user_id)).name, profile?.x_account ?? '', profile?.telegram_account ?? '', walletNetworkLabel(row.network), row.address, primary === row.network ? 'YES' : 'NO', toIso(row.submitted_at), toIso(row.updated_at), toIso(row.reward_eligible_at)].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

async function ensureRole(guild, spec) {
  try {
    let role = guild.roles.cache.find((r) => r.name === spec.name && !r.managed);
    const data = { name: spec.name, color: spec.color, hoist: spec.hoist, mentionable: false, permissions: spec.permissions ?? [] };
    if (!role) role = await guild.roles.create({ ...data, reason: 'LINKO KlineO setup' });
    else await role.edit({ ...data, reason: 'LINKO KlineO setup sync' });
    return role;
  } catch (error) { throw contextualError(`Role ${spec.name}`, error); }
}
async function ensureKreatorHubCategory(guild, permissionOverwrites = []) {
  const targetName = '🎨・KREATOR HUB';
  const legacyNames = new Set([
    targetName,
    '🎨・CREATOR HUB',
    '📣・KLINEO SOCIAL',
    `📣・${communityNameUpper()} SOCIAL`,
    '04・KLINEO SOCIAL',
    '05・CREATOR HUB',
  ]);
  let hub = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && x.name === targetName);
  if (!hub) {
    hub = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && legacyNames.has(x.name));
    if (hub) await hub.edit({ name: targetName, reason: 'LINKO v10.19 merge creator sections into KREATOR HUB' });
  }
  if (!hub) hub = await guild.channels.create({ name: targetName, type: ChannelType.GuildCategory, permissionOverwrites, reason: 'LINKO v10.19 KREATOR HUB' });
  await hub.permissionOverwrites.set(permissionOverwrites, 'LINKO v10.19 KREATOR HUB sync');

  const legacyCategories = guild.channels.cache.filter((x) =>
    x.type === ChannelType.GuildCategory && x.id !== hub.id && legacyNames.has(x.name)
  );
  const kreatorBases = new Set([
    'share-your-post','submit-your-post','published-kontents','content-missions','kreator-leaderboard','creator-leaderboard',
    'campaign-leaderboard','creator-lounge','kreator-lounge','content-and-collabs','creator-opportunities',
  ]);
  for (const oldCategory of legacyCategories.values()) {
    const children = guild.channels.cache.filter((x) => x.parentId === oldCategory.id);
    for (const child of children.values()) {
      if (!kreatorBases.has(baseChannelName(child.name))) continue;
      await child.setParent(hub.id, { lockPermissions: false, reason: 'LINKO v10.19 merge into KREATOR HUB' }).catch((error) => logLinkoError(`kreator-hub:move:${child.id}`, error));
    }
    const remaining = guild.channels.cache.filter((x) => x.parentId === oldCategory.id);
    if (remaining.size === 0) await oldCategory.delete('LINKO v10.19 remove empty legacy creator category').catch((error) => logLinkoError(`kreator-hub:delete:${oldCategory.id}`, error));
  }

  const oldSubmit = guild.channels.cache.find((x) => x.type === ChannelType.GuildText && x.parentId === hub.id && ['share-your-post','submit-your-post'].includes(baseChannelName(x.name)));
  if (oldSubmit) await oldSubmit.edit({ name: CHANNEL_NAMES.sharePost, reason: 'LINKO v10.20 rename approved social feed to Published Kontents' }).catch((error) => logLinkoError('kreator-hub:rename-published', error));
  const oldLounge = guild.channels.cache.find((x) => x.type === ChannelType.GuildText && x.parentId === hub.id && baseChannelName(x.name) === 'creator-lounge');
  if (oldLounge) await oldLounge.edit({ name: CHANNEL_NAMES.creatorLounge, reason: 'LINKO v10.19 rename creator lounge' }).catch((error) => logLinkoError('kreator-hub:rename-lounge', error));
  return hub;
}

async function ensureCategory(guild, name, permissionOverwrites = []) {
  try {
    let c = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && x.name === name);
    if (!c) c = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites, reason: 'LINKO KlineO setup' });
    else await c.permissionOverwrites.set(permissionOverwrites, 'LINKO setup sync');
    return c;
  } catch (error) { throw contextualError(`Category ${name}`, error); }
}
async function hideDisabledCategory(guild, name, staffRoles) {
  const category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (!category) return;
  const overwrites = [
    overwrite(guild.roles.everyone.id, [], [PermissionFlagsBits.ViewChannel]),
    ...staffRoles.filter(Boolean).map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])),
  ];
  await category.permissionOverwrites.set(overwrites, 'LINKO module disabled').catch(() => {});
}

async function ensureTextChannel(guild, category, spec, permissionOverwrites = []) {
  try {
    let c = guild.channels.cache.find((x) => x.type === ChannelType.GuildText && x.parentId === category.id && x.name === spec.name);
    if (!c && spec.reuseDefaultGeneral) c = guild.channels.cache.find((x) => x.type === ChannelType.GuildText && !x.parentId && x.name === 'general');
    if (!c) c = await guild.channels.create({ name: spec.name, type: ChannelType.GuildText, parent: category.id, topic: spec.topic, rateLimitPerUser: spec.slowmode ?? 0, permissionOverwrites, reason: 'LINKO KlineO setup' });
    else {
      await c.edit({ name: spec.name, parent: category.id, topic: spec.topic, rateLimitPerUser: spec.slowmode ?? 0, reason: 'LINKO setup sync' });
      await c.permissionOverwrites.set(permissionOverwrites, 'LINKO setup sync');
    }
    return c;
  } catch (error) { throw contextualError(`Text channel ${spec.name}`, error); }
}
async function syncV1019DiscordStructure(guild) {
  if (getSetting('v10_19_structure_synced') === '1') return;
  const everyone = guild.roles.everyone;
  const verified = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const kreator = guild.roles.cache.find((r) => r.name === 'KREATOR' || r.name === 'CREATOR');
  const staff = staffRoleNames().map((name) => guild.roles.cache.find((r) => r.name === name)).filter(Boolean);
  if (!verified) throw new Error('VERIFIED MEMBER role is missing; run /setup-linko confirm:true.');

  const staffPrivate = [
    overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
    ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
  ];
  const verifiedReadOnly = [
    overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
    overwrite(verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]),
    ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
  ];

  const kxpCategory = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && x.name === categoryName('kxp'));
  if (!kxpCategory) throw new Error(`${categoryName('kxp')} category is missing; run /setup-linko confirm:true.`);
  await ensureTextChannel(guild, kxpCategory, {
    name: CHANNEL_NAMES.communityLeaderboard,
    topic: `${communityName()} Community Member leaderboard. KREATORS are excluded from this competitive lane.`,
  }, staffPrivate);
  await setLeaderboardChannelVisibility(guild, 'community', getSetting('community_leaderboard_visibility'));

  if (moduleEnabled('kreator') && kreator) {
    const creatorsPrivate = [
      overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
      overwrite(kreator.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages]),
      ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
    ];
    const hub = await ensureKreatorHubCategory(guild, creatorsPrivate);
    await ensureTextChannel(guild, hub, { name: CHANNEL_NAMES.sharePost, topic: 'Approved social posts from Community Members and KREATORS. Submit privately with /submit-content social.' }, verifiedReadOnly);
    await ensureTextChannel(guild, hub, { name: CHANNEL_NAMES.contentMissions, topic: 'KREATOR content missions and campaign briefs.' }, verifiedReadOnly);
    await ensureTextChannel(guild, hub, { name: CHANNEL_NAMES.creatorLeaderboard, topic: `Live KREATOR leaderboard. Total ${xpLabel()}, including referral ${xpLabel()}, determines position among approved KREATORS.` }, staffPrivate);
    await ensureTextChannel(guild, hub, { name: CHANNEL_NAMES.campaignLeaderboard, topic: `KREATOR campaign leaderboards. Campaign ${xpLabel()} also counts toward KREATOR + overall ${xpLabel()}.` }, staffPrivate);
    for (const [name, topic] of [
      [CHANNEL_NAMES.creatorLounge, 'Private lounge for approved KREATORS.'],
      [CHANNEL_NAMES.contentCollabs, `${communityName()} KREATOR collaborations.`],
      [CHANNEL_NAMES.creatorOpportunities, 'Approved KREATOR opportunities and briefs.'],
    ]) await ensureTextChannel(guild, hub, { name, topic }, creatorsPrivate);
    await setLeaderboardChannelVisibility(guild, 'creators', getSetting('creator_leaderboard_visibility'));
    await setLeaderboardChannelVisibility(guild, 'campaign', getSetting('campaign_leaderboard_visibility'));
  }

  await updateLeaderboardMessage(guild, 'community');
  if (moduleEnabled('kreator')) {
    await updateLeaderboardMessage(guild, 'creators');
    await updateCampaignLeaderboardMessages(guild);
  }
  await updateLeaderboardMessage(guild, 'referrals');
  setSetting('v10_19_structure_synced', 1);
}

async function syncV1020ContentStructure(guild) {
  if (getSetting('v10_20_content_structure_synced') === '1') return;
  await guild.channels.fetch();

  const everyone = guild.roles.everyone;
  const verified = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const kreator = guild.roles.cache.find((r) => r.name === 'KREATOR' || r.name === 'CREATOR');
  const staff = staffRoleNames().map((name) => guild.roles.cache.find((r) => r.name === name)).filter(Boolean);
  const staffCategory = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name === CATEGORY_NAMES.staff);

  if (staffCategory) {
    const reviewCandidates = [...guild.channels.cache.filter((ch) =>
      ch.type === ChannelType.GuildText && ['social-submissions','content-submissions'].includes(baseChannelName(ch.name))
    ).values()];
    if (reviewCandidates.length) {
      const current = reviewCandidates.find((ch) => ch.name === CHANNEL_NAMES.socialSubmissions);
      const keep = current ?? await chooseHistoryPreservingChannel(reviewCandidates);
      await keep.edit({
        name: CHANNEL_NAMES.socialSubmissions,
        parent: staffCategory.id,
        topic: 'Unified review queue for social posts and Signal Room content submissions.',
        reason: 'LINKO v10.20 unified content review queue',
      }).catch((error) => logLinkoError('v10.20:content-review-channel', error));
      for (const duplicate of reviewCandidates) {
        if (duplicate.id === keep.id) continue;
        await archiveDuplicateChannel(guild, duplicate, staffCategory, 'content-submissions');
      }
    }
  }

  if (moduleEnabled('kreator') && verified && kreator) {
    const creatorsPrivate = [
      overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
      overwrite(kreator.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages]),
      ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
    ];
    const hub = await ensureKreatorHubCategory(guild, creatorsPrivate);

    const feedCandidates = [...guild.channels.cache.filter((ch) =>
      ch.type === ChannelType.GuildText &&
      ch.parentId === hub.id &&
      ['share-your-post','submit-your-post','published-kontents'].includes(baseChannelName(ch.name))
    ).values()];
    let feed = feedCandidates.find((ch) => ch.name === CHANNEL_NAMES.sharePost) ?? null;
    if (!feed && feedCandidates.length) feed = await chooseHistoryPreservingChannel(feedCandidates);
    if (feed) {
      await feed.edit({
        name: CHANNEL_NAMES.sharePost,
        parent: hub.id,
        topic: 'Approved social posts from Community Members and KREATORS. Submit privately with /submit-content social.',
        reason: 'LINKO v10.20 Published Kontents feed',
      }).catch((error) => logLinkoError('v10.20:published-kontents', error));
      const feedPerms = [
        overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
        overwrite(verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]),
        ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
      ];
      await feed.permissionOverwrites.set(feedPerms, 'LINKO v10.20 Published Kontents permissions').catch((error) => logLinkoError('v10.20:published-kontents-perms', error));
      for (const duplicate of feedCandidates) {
        if (duplicate.id === feed.id) continue;
        await archiveDuplicateChannel(guild, duplicate, staffCategory, 'published-kontents');
      }
    } else {
      feed = await ensureTextChannel(guild, hub, {
        name: CHANNEL_NAMES.sharePost,
        topic: 'Approved social posts from Community Members and KREATORS. Submit privately with /submit-content social.',
      }, [
        overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
        overwrite(verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]),
        ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
      ]);
    }
    await seedMessage(feed, '[KLINEO-SOCIAL]', { embeds: [buildSocialEmbed()] });
  }

  setSetting('v10_20_content_structure_synced', 1);
}

async function ensureVoiceChannel(guild, category, spec, permissionOverwrites = []) {
  try {
    let c = guild.channels.cache.find((x) => x.type === ChannelType.GuildVoice && x.parentId === category.id && x.name === spec.name);
    if (!c && spec.reuseDefaultVoice) c = guild.channels.cache.find((x) => x.type === ChannelType.GuildVoice && !x.parentId && x.name === 'General');
    if (!c) c = await guild.channels.create({ name: spec.name, type: ChannelType.GuildVoice, parent: category.id, userLimit: spec.userLimit ?? 0, permissionOverwrites, reason: 'LINKO KlineO setup' });
    else {
      const liveEvent = liveCommunityEventForChannel(c.id);
      if (liveEvent) {
        await c.edit({ name: spec.name, userLimit: spec.userLimit ?? 0, reason: `LINKO setup sync · preserving live event #${liveEvent.id} access` });
      } else {
        await c.edit({ name: spec.name, parent: category.id, userLimit: spec.userLimit ?? 0, reason: 'LINKO setup sync' });
        await c.permissionOverwrites.set(permissionOverwrites, 'LINKO setup sync');
      }
    }
    return c;
  } catch (error) { throw contextualError(`Voice channel ${spec.name}`, error); }
}
async function seedMessage(channel, marker, payload) {
  try {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = recent?.find((m) => m.author.id === client.user.id && (m.content.includes(marker) || m.embeds.some((e) => e.footer?.text === marker)));
    if (existing) {
      const editPayload = { ...payload };
      if ('embeds' in payload && !('content' in payload)) editPayload.content = null;
      if ('content' in payload && !('embeds' in payload)) editPayload.embeds = [];
      if (!('components' in payload)) editPayload.components = [];
      try { return await existing.edit(editPayload); } catch (error) { throw contextualError(`Edit seed ${marker} in #${channel.name}`, error); }
    }
    return await channel.send(payload);
  } catch (error) {
    if (String(error?.message ?? '').startsWith('Edit seed ')) throw error;
    throw contextualError(`Seed ${marker} in #${channel?.name ?? 'unknown'}`, error);
  }
}

function kxpRulesContent() {
  const label = xpLabel();
  return `**${label} — Experience Points**

**Ranks**
OBSERVER 0 · SCOUT 300 · ANALYST 1,000 · OPERATOR 2,000 · STRATEGIST 10,000 · VANGUARD 25,000 · PRIME 50,000+

**Earn ${label}**
• Qualified message: **+${getSettingInt('kxp_message')}**
• Official voice listening: **+${getSettingInt('kxp_voice_interval')} / ${getSettingInt('voice_interval_minutes')} qualifying min**
• Official Stage speaker: **+${getSettingInt('kxp_voice_speaker_bonus')} once/event** after hand raise + promotion + at least 1 minute as speaker
• Normal Discord voice: **attendance tracked, 0 ${label}**
• Active Server Boost: **+${getSettingInt('kxp_boost_daily')} / active boost/day**
• Valid referral: **+${getSettingInt('kxp_valid_referral')}**
• Approved social post: **+${getSettingInt('kxp_social_post')}**
• KREATOR milestone: **+${getSettingInt('creator_reaction_kxp')} / ${getSettingInt('creator_reaction_threshold')} verified reactions**
• Valid bug report: **+${getSettingInt('kxp_bug_report')}**
• First-time X / Telegram / EVM / Solana submission: **+${getSettingInt('kxp_profile_submission')} each**

Referrals require verification, 7 days retained and activity across at least **${getSettingInt('referral_activity_min_days')} days**. Message rewards are impact-scored; spam, duplicates and trivial messages do not qualify.

Use \`/rank\`, \`/points\`, \`/invite\`, \`/invites\`, \`/leaderboard\`.

[KLINEO-KXP]`;
}
function socialRulesContent() {
  const label = xpLabel();
  return `**Share ${communityName()}. Earn ${label} for genuine contributions.**

Use \`/submit-content social\` and submit your direct X, LinkedIn, YouTube, TikTok or Instagram post.

Moderators review submissions. Each approved post earns **+${getSettingInt('kxp_social_post')} ${label}**. Maximum **2 rewarded posts per day**. Duplicate, deleted or low-effort spam does not qualify.

Approved posts from Community Members and KREATORS are published in **Published Kontents**. KREATOR posts can also earn reaction-based ${label}, and KREATOR campaign-tagged posts count toward a campaign leaderboard.

[KLINEO-SOCIAL]`;
}
async function updatePublicKxpDocs(guild) {
  const how = guild.channels.cache.find((c) => baseChannelName(c.name) === xpChannelBase('how') && c.isTextBased());
  const social = guild.channels.cache.find((c) => baseChannelName(c.name) === baseChannelName(CHANNEL_NAMES.sharePost) && c.isTextBased());
  const links = guild.channels.cache.find((c) => baseChannelName(c.name) === 'official-links' && c.isTextBased());
  if (how) await seedMessage(how, '[KLINEO-KXP]', { content: kxpRulesContent() });
  if (links) await seedMessage(links, '[KLINEO-OFFICIAL-LINKS]', { embeds: [buildOfficialLinksEmbed()] });
  if (social) await seedMessage(social, '[KLINEO-SOCIAL]', { embeds: [buildSocialEmbed()] });
}
function readOnlyOverwrites(everyone, roles = []) {
  const validRoles = roles.filter(Boolean);
  return [
    overwrite(everyone.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads]),
    ...validRoles.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])),
  ];
}
function privateFor(everyone, allowedRoles) {
  const validRoles = allowedRoles.filter(Boolean);
  return [
    overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
    ...validRoles.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])),
  ];
}
function privateVoiceFor(everyone, allowedRoles) {
  const validRoles = allowedRoles.filter(Boolean);
  return [
    overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]),
    ...validRoles.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])),
  ];
}

async function syncRankRole(guild, userId, announce = true) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot || !hasVerifiedRole(member)) return null;
  const xp = getXp(userId);
  const label = xpLabel();
  const target = rankForXp(xp);
  const rankRoles = RANKS.map((r) => guild.roles.cache.find((role) => role.name === r.name)).filter(Boolean);
  const targetRole = rankRoles.find((r) => r.name === target.name);
  if (!targetRole) return null;
  const current = rankRoles.find((r) => member.roles.cache.has(r.id));
  if (current?.id === targetRole.id) return target;
  const toRemove = rankRoles.filter((r) => member.roles.cache.has(r.id) && r.id !== targetRole.id);
  if (toRemove.length) await member.roles.remove(toRemove, 'LINKO rank sync');
  if (!member.roles.cache.has(targetRole.id)) await member.roles.add(targetRole, `LINKO rank: ${target.name}`);

  if (announce && (!current || RANKS.findIndex((r) => r.name === target.name) > RANKS.findIndex((r) => r.name === current.name))) {
    const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'rank-ups' && c.isTextBased());
    if (channel) {
      const tail = nextRankForXp(xp) ? ` Next: **${nextRankForXp(xp).name}**.` : ` PRIME reached. Lifetime ${label} continues with no cap.`;
      const content = `**${member} reached ${target.name}**\n${xp.toLocaleString()} ${label} earned.${tail}\nUse \`/social-card\` to generate your own shareable card.`;
      try {
        const card = await generateSocialCard(guild, member, 'progress');
        const file = new AttachmentBuilder(card.buffer, { name: `klineo-rank-${member.id}.png` });
        await channel.send({ content, files: [file] });
      } catch {
        await channel.send(content);
      }
    }
    await awardReferralMilestones(guild, userId, target.name);
  }
  return target;
}
async function addXp(guild, userId, amount, reason, actorId = null) {
  if (!Number.isInteger(amount) || amount === 0) return getXp(userId);
  ensureUserRow(userId);
  const current = getXp(userId);
  const next = Math.max(0, current + amount);
  const applied = next - current;
  if (applied === 0) return current;
  db.prepare('UPDATE users SET xp = ?, last_seen_at = ? WHERE user_id = ?').run(next, now(), userId);
  db.prepare('INSERT INTO xp_log (user_id, amount, reason, created_at, actor_id) VALUES (?, ?, ?, ?, ?)').run(userId, applied, reason, now(), actorId);
  await syncRankRole(guild, userId, true);
  const log = guild.channels.cache.find((c) => baseChannelName(c.name) === xpChannelBase('log') && c.isTextBased());
  if (log) log.send(`<@${userId}> ${applied >= 0 ? '+' : ''}${applied} ${xpLabel()} — ${reason}${actorId ? ` — by <@${actorId}>` : ''}`).catch(() => {});
  scheduleLeaderboardUpdate(guild);
  scheduleHealthUpdate(guild);
  return next;
}
async function channelHistorySample(channel, limit = 100) {
  if (!channel?.isTextBased?.()) return { total: 0, human: 0 };
  const messages = await channel.messages.fetch({ limit }).catch(() => null);
  if (!messages) return { total: 0, human: 0 };
  return {
    total: messages.size,
    human: messages.filter((m) => !m.author?.bot).size,
  };
}

async function archiveDuplicateChannel(guild, channel, staffCategory, label) {
  const sample = await channelHistorySample(channel);
  if (sample.total === 0) {
    await channel.delete(`LINKO v10.19.1 remove empty duplicate ${label}`).catch((error) => logLinkoError(`dedupe:delete:${channel.id}`, error));
    return 'deleted-empty';
  }
  if (!staffCategory) {
    await channel.edit({ name: `archive-${baseChannelName(channel.name)}-${channel.id.slice(-4)}`, reason: 'LINKO v10.19.1 preserve duplicate channel history' }).catch((error) => logLinkoError(`dedupe:rename:${channel.id}`, error));
    return 'renamed-archive';
  }
  const everyone = guild.roles.everyone;
  const staff = staffRoleNames().map((name) => guild.roles.cache.find((r) => r.name === name)).filter(Boolean);
  await channel.edit({
    name: `archive-${baseChannelName(channel.name)}-${channel.id.slice(-4)}`,
    parent: staffCategory.id,
    reason: 'LINKO v10.19.1 preserve duplicate channel history',
  }).catch((error) => logLinkoError(`dedupe:archive:${channel.id}`, error));
  const overwrites = [
    overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
    ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages])),
  ];
  await channel.permissionOverwrites.set(overwrites, 'LINKO v10.19.1 history archive').catch((error) => logLinkoError(`dedupe:archive-perms:${channel.id}`, error));
  return 'archived-history';
}

async function chooseHistoryPreservingChannel(channels) {
  const scored = [];
  for (const channel of channels) {
    const sample = await channelHistorySample(channel);
    scored.push({ channel, ...sample });
  }
  scored.sort((a, b) =>
    b.human - a.human ||
    b.total - a.total ||
    a.channel.createdTimestamp - b.channel.createdTimestamp
  );
  return scored[0]?.channel ?? channels[0] ?? null;
}

async function syncCanonicalGeneralAndAuditDuplicates(guild) {
  if (getSetting('v10_19_1_channel_dedup_synced') === '1') return;
  await guild.channels.fetch();

  const communityCategory = guild.channels.cache.find((x) =>
    x.type === ChannelType.GuildCategory && x.name === categoryName('community')
  );
  const staffCategory = guild.channels.cache.find((x) =>
    x.type === ChannelType.GuildCategory && x.name === CATEGORY_NAMES.staff
  );
  const verified = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const staff = staffRoleNames().map((name) => guild.roles.cache.find((r) => r.name === name)).filter(Boolean);

  if (communityCategory && verified) {
    const generalCandidates = guild.channels.cache.filter((x) =>
      x.type === ChannelType.GuildText &&
      (x.name === 'general' || x.name === CHANNEL_NAMES.general || baseChannelName(x.name) === 'general')
    );
    if (generalCandidates.size) {
      const keep = await chooseHistoryPreservingChannel([...generalCandidates.values()]);
      const verifiedBase = [
        overwrite(guild.roles.everyone.id, [], [PermissionFlagsBits.ViewChannel]),
        overwrite(verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages]),
        ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])),
      ];
      await keep.edit({
        name: CHANNEL_NAMES.general,
        parent: communityCategory.id,
        topic: `General ${communityName()} discussion. Public links are blocked.`,
        rateLimitPerUser: 2,
        reason: 'LINKO v10.19.1 preserve canonical general channel history',
      }).catch((error) => logLinkoError(`dedupe:general-keep:${keep.id}`, error));
      await keep.permissionOverwrites.set(verifiedBase, 'LINKO v10.19.1 canonical general permissions').catch((error) => logLinkoError(`dedupe:general-perms:${keep.id}`, error));

      for (const duplicate of generalCandidates.values()) {
        if (duplicate.id === keep.id) continue;
        await archiveDuplicateChannel(guild, duplicate, staffCategory, 'general');
      }
    }
  }

  // Audit known LINKO legacy aliases for duplicate visible channels. We never delete
  // a duplicate with message history; it is moved to STAFF as an archive instead.
  const canonicalGroups = new Map();
  for (const [legacyName, canonicalName] of LEGACY_CHANNEL_NAMES) {
    const canonicalBase = baseChannelName(canonicalName);
    if (!canonicalGroups.has(canonicalBase)) canonicalGroups.set(canonicalBase, { canonicalName, aliases: new Set() });
    const group = canonicalGroups.get(canonicalBase);
    group.canonicalName = canonicalName;
    group.aliases.add(legacyName);
    group.aliases.add(canonicalName);
  }

  for (const [canonicalBase, group] of canonicalGroups) {
    if (canonicalBase === 'general') continue;
    const candidates = guild.channels.cache.filter((x) =>
      x.type === ChannelType.GuildText &&
      (group.aliases.has(x.name) || baseChannelName(x.name) === canonicalBase)
    );
    if (candidates.size <= 1) continue;

    // Prefer the exact current canonical channel. If none exists, preserve the
    // channel with the strongest sampled human history.
    const exact = [...candidates.values()].find((x) => x.name === group.canonicalName);
    const keep = exact ?? await chooseHistoryPreservingChannel([...candidates.values()]);
    for (const duplicate of candidates.values()) {
      if (duplicate.id === keep.id) continue;
      await archiveDuplicateChannel(guild, duplicate, staffCategory, canonicalBase);
    }
  }

  setSetting('v10_19_1_channel_dedup_synced', 1);
}

function verifiedBoostCount(userId) {
  return Math.max(0, Number(db.prepare('SELECT boost_count FROM booster_overrides WHERE user_id = ?').get(userId)?.boost_count ?? 0));
}

async function awardDailyBoosterXp(guild) {
  await guild.members.fetch().catch(() => null);
  const day = dayKey();
  const perBoost = Math.max(0, getSettingInt('kxp_boost_daily'));
  if (!perBoost) return;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot || !member.premiumSinceTimestamp) continue;
    const override = verifiedBoostCount(member.id);
    const boostCount = Math.max(1, override || 1);
    const amount = perBoost * boostCount;
    const existing = db.prepare('SELECT xp_awarded FROM booster_daily WHERE user_id = ? AND day = ?').get(member.id, day);
    if (Number(existing?.xp_awarded ?? 0) > 0) continue;

    const reason = `Server boost daily reward:${day}:${boostCount} boost${boostCount === 1 ? '' : 's'}`;
    const alreadyLogged = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM xp_log WHERE user_id = ? AND reason = ?').get(member.id, reason)?.s ?? 0);
    if (alreadyLogged > 0) {
      db.prepare('INSERT OR REPLACE INTO booster_daily (user_id, day, boost_count, xp_awarded, awarded_at) VALUES (?, ?, ?, ?, ?)').run(member.id, day, boostCount, alreadyLogged, now());
      continue;
    }

    await addXp(guild, member.id, amount, reason, null);
    db.prepare('INSERT OR REPLACE INTO booster_daily (user_id, day, boost_count, xp_awarded, awarded_at) VALUES (?, ?, ?, ?, ?)').run(member.id, day, boostCount, amount, now());
  }
}

async function syncAllRankRoles(guild) {
  await guild.members.fetch().catch(() => null);
  for (const member of guild.members.cache.values()) {
    if (member.user.bot || !hasVerifiedRole(member)) continue;
    await syncRankRole(guild, member.id, false).catch(() => null);
  }
}

async function awardReferralMilestones(_guild, _referredUserId, _rankName) {
  // LINKO v5 keeps referral rewards deliberately conservative.
  // A referral earns KXP only after the referred member verifies and remains for 7 days.
}

async function maybeAwardReferralRoleBonus(_guild, _memberId, _roleName) {
  // No automatic Creator/Founder referral bonus in v5.
}

async function syncAnnouncementChannelPermissions(guild) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'announcements' && c.isTextBased());
  if (!channel) return;
  const core = guild.roles.cache.find((r) => r.name === coreRoleName());
  const team = guild.roles.cache.find((r) => r.name === teamRoleName());
  const overwrites = readOnlyOverwrites(guild.roles.everyone, [core, team]);
  await channel.permissionOverwrites.set(overwrites, 'LINKO announcement publishing restricted to Core/Team');
  await channel.edit({ topic: `${communityName()} official announcements. Published through /announce by Core/Team.` }).catch(() => {});
}

async function buildKlineO(guild) {
  setSetupPhase('01/11 · Fetch server state + migrate legacy structure');
  await guild.roles.fetch();
  await guild.channels.fetch();
  await migrateLegacyStructure(guild);
  // Remove deprecated member profile-directory channels from v6. Member socials are no longer collected.
  for (const legacyBase of ['community-directory', 'profile-submissions']) {
    const legacy = guild.channels.cache.find((c) => baseChannelName(c.name) === legacyBase && c.type !== ChannelType.GuildCategory);
    if (legacy) await legacy.delete('LINKO v8 removes member social directory').catch(() => {});
  }
  await guild.channels.fetch();
  await guild.roles.fetch();
  await guild.channels.fetch();

  setSetupPhase('02/11 · Create/sync roles');
  const roles = {};
  for (const spec of roleSpecsForServer()) roles[spec.key] = await ensureRole(guild, spec);
  for (const rank of RANKS) roles[rank.key] = guild.roles.cache.find((r) => r.name === rank.name);
  for (const [key, label, color] of INTERESTS) {
    roles[`interest_${key}`] = await ensureRole(guild, { name: `${INTEREST_ROLE_PREFIX}${label}`, color, hoist: false, permissions: [] });
  }

  const me = await guild.members.fetchMe();
  const ceiling = me.roles.highest.position;
  const orderedNames = [coreRoleName(), teamRoleName(), 'MODERATOR', ...(moduleEnabled('liquidity_studio') ? ['STUDIO CLIENT'] : []), ...(moduleEnabled('founder_hub') ? ['VERIFIED FOUNDER'] : []), 'PARTNER', ...(moduleEnabled('kreator') ? ['KREATOR'] : []), 'AMBASSADOR', 'VERIFIED MEMBER', 'PRIME', 'VANGUARD', 'STRATEGIST', 'OPERATOR', 'ANALYST', 'SCOUT', 'OBSERVER', ...INTERESTS.map((x) => `${INTEREST_ROLE_PREFIX}${x[1]}`)];
  const movable = orderedNames.map((n) => guild.roles.cache.find((r) => r.name === n)).filter((r) => r && r.position < ceiling);
  const positions = movable.map((r, i) => ({ role: r.id, position: Math.max(1, ceiling - 1 - i) }));
  if (positions.length) await guild.roles.setPositions(positions).catch((e) => console.warn('Role order warning:', e.message));

  setSetupPhase('03/11 · Build permission model + categories');
  const everyone = guild.roles.everyone;
  const staff = [roles.core, roles.team, roles.moderator];
  const verifiedBase = privateFor(everyone, [roles.verified, ...staff]);
  const startReadOnly = readOnlyOverwrites(everyone, staff);
  const announcementReadOnly = readOnlyOverwrites(everyone, [roles.core, roles.team]);
  const staffPrivate = privateFor(everyone, staff);
  const creatorsPrivate = privateFor(everyone, [roles.creator, ...staff]);
  const foundersPrivate = privateFor(everyone, [roles.founder, roles.studio, ...staff]);
  const studioPrivate = privateFor(everyone, [roles.studio, ...staff]);
  const signalRoles = [roles.l3, roles.l4, roles.l5, roles.l6, roles.l7, ...staff];
  const signalPrivate = privateFor(everyone, signalRoles);
  const l5plus = [roles.l5, roles.l6, roles.l7, ...staff];
  const l6plus = [roles.l6, roles.l7, ...staff];
  const l7plus = [roles.l7, ...staff];

  const categories = {};
  if (!moduleEnabled('signal_room')) await hideDisabledCategory(guild, CATEGORY_NAMES.signal, staff);
  if (!moduleEnabled('kreator')) {
    for (const name of ['🎨・KREATOR HUB','🎨・KREATOR HUB','📣・KREATOR HUB', `📣・${communityNameUpper()} SOCIAL`]) {
      await hideDisabledCategory(guild, name, staff);
    }
  }
  if (!moduleEnabled('founder_hub')) await hideDisabledCategory(guild, CATEGORY_NAMES.founders, staff);
  if (!moduleEnabled('liquidity_studio')) await hideDisabledCategory(guild, CATEGORY_NAMES.studio, staff);

  categories.stats = await ensureCategory(guild, CATEGORY_NAMES.stats, [overwrite(everyone.id, [PermissionFlagsBits.ViewChannel])]);
  categories.start = await ensureCategory(guild, CATEGORY_NAMES.start, [overwrite(everyone.id, [PermissionFlagsBits.ViewChannel])]);
  categories.community = await ensureCategory(guild, categoryName('community'), verifiedBase);
  categories.kxp = await ensureCategory(guild, categoryName('kxp'), verifiedBase);
  if (moduleEnabled('signal_room')) categories.signal = await ensureCategory(guild, CATEGORY_NAMES.signal, signalPrivate);
  if (moduleEnabled('kreator')) {
    categories.creators = await ensureKreatorHubCategory(guild, creatorsPrivate);
    categories.social = categories.creators;
  }
  if (moduleEnabled('founder_hub')) categories.founders = await ensureCategory(guild, CATEGORY_NAMES.founders, foundersPrivate);
  if (moduleEnabled('liquidity_studio')) categories.studio = await ensureCategory(guild, CATEGORY_NAMES.studio, studioPrivate);
  categories.high = await ensureCategory(guild, CATEGORY_NAMES.high, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel])]);
  categories.voice = await ensureCategory(guild, CATEGORY_NAMES.voice, verifiedBase);
  // Community-specific categories are created only when demand is approved.
  categories.staff = await ensureCategory(guild, CATEGORY_NAMES.staff, staffPrivate);
  await categories.stats.setPosition(0).catch(() => {});
  await categories.start.setPosition(1).catch(() => {});
  await updateServerStats(guild, false);

  setSetupPhase('04/11 · Create START HERE + community channels');
  const channels = {};
  channels.welcome = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.welcome, topic: `${communityName()} welcome and onboarding. Start here.` }, startReadOnly);
  channels.rules = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.rules, topic: `${communityName()} community and security rules.` }, startReadOnly);
  channels.verify = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.verify, topic: `${communityName()} verification and access.` }, startReadOnly);
  channels.links = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.links, topic: `${communityName()} official links only.` }, startReadOnly);
  channels.announcements = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.announcements, topic: `${communityName()} official announcements. Published through /announce by Core/Team.` }, announcementReadOnly);

  for (const [key, name, topic, slowmode] of [
    ['general', CHANNEL_NAMES.general, `General ${communityName()} discussion. Public links are blocked.`, 2],
    ['marketChat', CHANNEL_NAMES.marketChat, 'Market discussion. No guaranteed-return claims. Public links are blocked.', 3],
    ['tradeSetups', CHANNEL_NAMES.tradeSetups, 'Trading setups and risk context. Public links are blocked.', 5],
    ['aiAgentLab', CHANNEL_NAMES.aiAgentLab, `AI agents, execution workflows and ${communityName()} experiments. Public links are blocked.`, 3],
    ['productUpdates', CHANNEL_NAMES.productUpdates, `${communityName()} product releases and integrations.`, 0],
    ['productFeedback', CHANNEL_NAMES.productFeedback, `Constructive ${communityName()} product feedback. Public links are blocked.`, 5],
    ['bugReports', CHANNEL_NAMES.bugReports, `Report reproducible ${communityName()} bugs. Valid reports can be approved by staff for ${xpLabel()}. Public links are blocked.`, 10],
    ['help', CHANNEL_NAMES.help, 'Ask for community or product help. Public links are blocked.', 5],
    ['introductions', CHANNEL_NAMES.introductions, `Introduce yourself to ${communityName()}. Public links are blocked.`, 10],
    ['wins', CHANNEL_NAMES.wins, 'Share wins, mistakes and lessons. Public links are blocked.', 5],
  ]) {
    const perms = baseChannelName(name) === 'product-updates' ? [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))] : verifiedBase;
    channels[key] = await ensureTextChannel(guild, categories.community, { name, topic, slowmode }, perms);
  }

  channels.productRoadmap = await ensureTextChannel(guild, categories.community, { name: CHANNEL_NAMES.productRoadmap, topic: `Structured ${communityName()} product suggestions and status updates. Submit with /suggest.` }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);

  setSetupPhase('05/11 · Create KXP + persistent leaderboard channels');
  channels.howKxp = await ensureTextChannel(guild, categories.kxp, { name: xpChannelName('how'), topic: `How ${xpLabel()}, referrals and rank progression work.` }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.botCommands = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.botCommands, topic: 'Open MY LINKO PROFILE here, or use member commands such as /profile /rank /points /leaderboard /invite /wallet /submit-content.' }, verifiedBase);
  channels.leaderboard = await ensureTextChannel(guild, categories.kxp, { name: xpChannelName('leaderboard'), topic: `${communityName()} Overall Top 50 by total ${xpLabel()}, including Community Members and KREATORS.` }, staffPrivate);
  channels.communityLeaderboard = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.communityLeaderboard, topic: `${communityName()} Community Member leaderboard. KREATORS are excluded from this competitive lane.` }, staffPrivate);
  channels.referralLeaderboard = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.referralLeaderboard, topic: `${communityName()} Top 50 valid-referral leaderboard. Auto-refreshes; visibility is controlled by moderators.` }, staffPrivate);
  await setLeaderboardChannelVisibility(guild, 'kxp', getSetting('kxp_leaderboard_visibility'));
  await setLeaderboardChannelVisibility(guild, 'community', getSetting('community_leaderboard_visibility'));
  await setLeaderboardChannelVisibility(guild, 'referrals', getSetting('referral_leaderboard_visibility'));
  channels.rankUps = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.rankUps, topic: `${communityName()} community rank progression.` }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.referrals = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.referrals, topic: `Use /invite and /invites. Valid referrals earn ${xpLabel()}.` }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.events = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.events, topic: 'Official community events, AMAs and campaigns.' }, [overwrite(everyone.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages]))]);

  setSetupPhase('06/11 · Create optional modules + higher-level + voice spaces');
  if (moduleEnabled('signal_room')) {
    for (const [key, name, topic] of [
      ['analystChat', CHANNEL_NAMES.analystChat, 'ANALYST+ discussion. Links unlock at STRATEGIST.'],
      ['tradeAnalysis', CHANNEL_NAMES.tradeAnalysis, 'ANALYST+ trade analysis. Links unlock at STRATEGIST.'],
      ['marketThesis', CHANNEL_NAMES.marketThesis, 'ANALYST+ market theses. Links unlock at STRATEGIST.'],
      ['aiStrategies', CHANNEL_NAMES.aiStrategies, 'ANALYST+ AI strategy discussion. Links unlock at STRATEGIST.'],
    ]) channels[key] = await ensureTextChannel(guild, categories.signal, { name, topic, slowmode: 5 }, signalPrivate);
    channels.analystVoice = await ensureVoiceChannel(guild, categories.signal, { name: '🔊 Analyst Room', userLimit: 30 }, privateVoiceFor(everyone, signalRoles));
  }

  if (moduleEnabled('kreator')) {
    channels.sharePost = await ensureTextChannel(guild, categories.creators, { name: CHANNEL_NAMES.sharePost, topic: `Approved social posts from Community Members and KREATORS. Submit privately with /submit-content social.` }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
    channels.contentMissions = await ensureTextChannel(guild, categories.creators, { name: CHANNEL_NAMES.contentMissions, topic: `KREATOR content missions and campaign briefs.` }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
    channels.creatorLeaderboard = await ensureTextChannel(guild, categories.creators, { name: CHANNEL_NAMES.creatorLeaderboard, topic: `Live KREATOR leaderboard. Creator ${xpLabel()} also counts toward the overall ${xpLabel()} leaderboard.` }, staffPrivate);
    channels.campaignLeaderboard = await ensureTextChannel(guild, categories.creators, { name: CHANNEL_NAMES.campaignLeaderboard, topic: `Public KREATOR campaign leaderboards. Campaign ${xpLabel()} also counts toward KREATOR + overall ${xpLabel()}.` }, staffPrivate);
    await setLeaderboardChannelVisibility(guild, 'creators', getSetting('creator_leaderboard_visibility'));
    await setLeaderboardChannelVisibility(guild, 'campaign', getSetting('campaign_leaderboard_visibility'));

    for (const [name, topic] of [[CHANNEL_NAMES.creatorLounge, 'Private lounge for approved creators.'], [CHANNEL_NAMES.contentCollabs, `${communityName()} creator collaborations.`], [CHANNEL_NAMES.creatorOpportunities, 'Approved creator opportunities and briefs.']]) {
      await ensureTextChannel(guild, categories.creators, { name, topic }, creatorsPrivate);
    }
  }

  if (moduleEnabled('founder_hub')) {
    channels.founderLobby = await ensureTextChannel(guild, categories.founders, { name: CHANNEL_NAMES.founderLobby, topic: 'Private discussion for verified founders and enabled Studio clients.' }, foundersPrivate);
    channels.founderDirectory = await ensureTextChannel(guild, categories.founders, { name: CHANNEL_NAMES.founderDirectory, topic: 'Approved founder/project websites and social profiles.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), ...[roles.founder, roles.studio].filter(Boolean).map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages])), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
    if (moduleEnabled('liquidity_studio')) {
      channels.liquidityStudio = await ensureTextChannel(guild, categories.founders, { name: CHANNEL_NAMES.liquidityStudio, topic: `${communityName()} Liquidity Studio capabilities, process and onboarding.` }, foundersPrivate);
      channels.studioRequests = await ensureTextChannel(guild, categories.founders, { name: CHANNEL_NAMES.studioRequests, topic: 'Discuss Liquidity Studio onboarding and next steps.' }, foundersPrivate);
    }
    for (const [name, topic] of [[CHANNEL_NAMES.marketStructure, 'Founder-level market structure discussion.'], [CHANNEL_NAMES.founderResources, 'Founder resources and operating references.']]) {
      await ensureTextChannel(guild, categories.founders, { name, topic }, foundersPrivate);
    }
    await ensureVoiceChannel(guild, categories.founders, { name: '🎙️ Founder Roundtable', userLimit: 25 }, privateVoiceFor(everyone, [roles.founder, roles.studio, ...staff]));
  }

  if (moduleEnabled('liquidity_studio')) {
    channels.studioAnnouncements = await ensureTextChannel(guild, categories.studio, { name: CHANNEL_NAMES.studioAnnouncements, topic: 'Private Liquidity Studio notices.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.studio.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
    channels.clientSupport = await ensureTextChannel(guild, categories.studio, { name: CHANNEL_NAMES.clientSupport, topic: 'General support for active Liquidity Studio clients.' }, studioPrivate);
  }

  channels.strategist = await ensureTextChannel(guild, categories.high, { name: CHANNEL_NAMES.strategist, topic: 'STRATEGIST+ room. Links are permitted here.' }, privateFor(everyone, l5plus));
  channels.vanguard = await ensureTextChannel(guild, categories.high, { name: CHANNEL_NAMES.vanguard, topic: 'VANGUARD+ community lounge.' }, privateFor(everyone, l6plus));
  channels.prime = await ensureTextChannel(guild, categories.high, { name: CHANNEL_NAMES.prime, topic: 'PRIME community room.' }, privateFor(everyone, l7plus));
  await ensureVoiceChannel(guild, categories.high, { name: '🎙️ Strategy Room', userLimit: 25 }, privateVoiceFor(everyone, l5plus));
  await ensureVoiceChannel(guild, categories.high, { name: '🎙️ Vanguard Room', userLimit: 20 }, privateVoiceFor(everyone, l6plus));

  const publicVoices = [['📈 Trading Floor', 50], ['🌐 Market Room', 50], ['🤖 AI Lab', 30], ['💻 Co-Working', 30], ['💬 Community Lounge', 50], [`🎙️ ${communityName()} AMA`, 99], ['💤 AFK', 99]];
  for (const [name, limit] of publicVoices) {
    const c = await ensureVoiceChannel(guild, categories.voice, { name, userLimit: limit, reuseDefaultVoice: name === '💬 Community Lounge' }, privateVoiceFor(everyone, [roles.verified, ...staff]));
    if (name === '💤 AFK') await guild.setAFKChannel(c, 'LINKO setup').catch(() => {});
  }

  setSetupPhase('07/11 · Community demand system');
  // No permanent access channel is created. Members select Communities from MY LINKO PROFILE.
  // The Communities category itself is created lazily only after staff approves demand.

  setSetupPhase('08/11 · Create staff operations channels');
  const staffChannels = [
    ['teamChat', CHANNEL_NAMES.teamChat, `Private ${communityName()} team coordination.`],
    ['modCommands', CHANNEL_NAMES.modCommands, 'LINKO moderator command center. Staff-only slash commands and diagnostics.'],
    ['communityHealth', CHANNEL_NAMES.communityHealth, `${communityName()} activation, engagement, growth and rank health dashboard.`],
    ['modInbox', CHANNEL_NAMES.modInbox, 'Consolidated pending reviews and moderator workload.'],
    ['suggestionReview', CHANNEL_NAMES.suggestionReview, 'Product suggestion review and status controls.'],
    ['verificationLog', CHANNEL_NAMES.verificationLog, 'Member verification activity.'],
    ['founderVerification', CHANNEL_NAMES.founderVerification, 'Founder access applications with project and founder socials.'],
    ['kreatorApplications', CHANNEL_NAMES.kreatorApplications, 'Dedicated KREATOR application review queue.'],
    ['socialSubmissions', CHANNEL_NAMES.socialSubmissions, `Unified review queue for ${communityName()} social posts and Signal Room content.`],
    ['moderation', CHANNEL_NAMES.moderation, 'Moderation notes and actions.'],
    ['securityAlerts', CHANNEL_NAMES.securityAlerts, 'Scams, impersonation and security incidents.'],
    ['kxpLog', xpChannelName('log'), `${xpLabel()} awards and deductions.`],
    ['walletLog', CHANNEL_NAMES.walletLog, 'Masked wallet submissions and changes. Full addresses are never posted here.'],
    ['botLog', CHANNEL_NAMES.botLog, 'LINKO operations and bot logs.'],
  ];
  for (const [key, name, topic] of staffChannels) channels[key] = await ensureTextChannel(guild, categories.staff, { name, topic }, staffPrivate);

  setSetupPhase('09/11 · Seed verification, rules, docs + command guides');
  const verifyButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('linko_onboarding_start').setLabel('START ONBOARDING').setStyle(ButtonStyle.Success));
  await seedMessage(channels.verify, '[KLINEO-VERIFY]', { embeds: [buildVerifyEmbed()], components: [verifyButton] });
  await seedMessage(channels.welcome, '[KLINEO-WELCOME]', { embeds: [buildWelcomeEmbed(channels)] });
  const rulesLines = [
    `**${communityName()} Community Rules**`,
    '',
    '1. Never share seed phrases, private keys or recovery information.',
    '2. Never send funds because of an unsolicited Discord DM.',
    `3. Only trust official links in <#${channels.links.id}>.`,
    '4. No phishing, wallet-drainers, impersonation or malicious files.',
    '5. **No user-posted links in public community channels.**',
    ...(moduleEnabled('signal_room') ? ['6. In the ANALYST+ Signal Room, links unlock at **STRATEGIST**.'] : []),
    ...(moduleEnabled('kreator') ? [`7. Social posts about ${communityName()} should use \`/submit-content social\`; approved posts can earn ${xpLabel()}.`] : []),
    '8. No spam, unsolicited promotion or guaranteed-return claims.',
    ...(moduleEnabled('founder_hub') ? ['9. Do not redistribute private Founder Hub discussions.'] : []),
    '10. Respect other members and moderators.',
    '',
    '[KLINEO-RULES]',
  ];
  await seedMessage(channels.rules, '[KLINEO-RULES]', { content: rulesLines.join('\n') });
  await seedMessage(channels.links, '[KLINEO-OFFICIAL-LINKS]', { embeds: [buildOfficialLinksEmbed()] });
  await seedMessage(channels.howKxp, '[KLINEO-KXP]', { content: kxpRulesContent() });
  await seedMessage(channels.productRoadmap, '[KLINEO-PRODUCT-ROADMAP]', { content: `**${communityName()} Product Suggestions**\n\nSubmit a structured idea with \`/suggest\`. LINKO keeps the status updated through **Submitted → Reviewing → Planned → Building → Shipped / Declined**.\n\n[KLINEO-PRODUCT-ROADMAP]` });

  const memberCommands = [
    '**LINKO Member Commands**',
    '',
    `Use this channel for ${communityName()} slash commands:`,
    `• \`/rank\` / \`/points\` — rank and ${xpLabel()} balance`,
    '• `/leaderboard` — XP/referral leaderboards',
    '• `/invite` / `/invites` — tracked invites and referral stats',
    `• **MY LINKO PROFILE** button / \`/profile\` — permanent private profile dashboard`,
    `• \`/join-source\` — legacy/manual join-source option; START ONBOARDING is easier`,
    '• `/confirm-invited @member` — confirm a pending referral after you are verified',
    '• `/wallet view/set/remove/primary` — legacy/manual wallet controls; profile buttons are easier',
    ...(moduleEnabled('kreator') ? [
      `• \`/submit-content social\` — submit ${communityName()} social content for ${xpLabel()} review`,
      '• `/submit-content signal` — submit Analyst / Trade / Market Thesis / AI content for staff review and publishing',
      '• `/leaderboard type:Kreators` — lifetime KREATOR leaderboard',
      '• `/leaderboard type:Creator Campaign campaign:<ID>` — campaign leaderboard',
    ] : []),
    '• `/social-card` — shareable progress/referral/impact card',
    ...(moduleEnabled('founder_hub') ? ['• `/apply-founder` — request Founder Hub access'] : []),
    '• `/onboarding` — activation checklist',
    '• `/interest add/remove/list` — choose interests',
    '• `/language add/remove/list` — join language rooms',
    '• `/suggest` — submit a structured product idea',
    '• `/events` — upcoming community events',
    '• `/commands` — show the guide privately',
    '',
    'Plain chat in this channel is automatically removed.',
    '',
    '[KLINEO-MEMBER-COMMANDS]',
  ];
  await seedMessage(channels.botCommands, '[KLINEO-MEMBER-COMMANDS]', { content: memberCommands.join('\n') });
  await ensureMemberProfileLauncher(guild);

  if (channels.modCommands) {
    const modCommands1 = [
      '**LINKO Moderator Command Center · 1/2**',
      '',
      `**${xpLabel()} + referrals**`,
      '• `/user-kxp @member` — detailed XP breakdown',
      '• `/give-xp` / `/remove-xp` — manual XP adjustment',
      '• `/approve-bug @member` — approve a valid bug report',
      '• `/referral-stats` / `/confirm-referral` — referral operations',
      '• `/impact-status` / `/mark-impactful` / `/remove-message-xp` — impact review',
      '• `/impact-settings` / `/set-impact` — impact rules',
      '• `/xp-settings` / `/set-xp` — XP economy',
      '• `/voice-event start/stop/status/speaker` — official voice XP + speaker bonus',
      '• `/event create/access/start/end/cancel` — events with Everyone/Verified room access + automatic permission restore',
      '',
      '**Leaderboards + wallets**',
      '• `/leaderboard-settings` — visibility controls',
      ...(moduleEnabled('kreator') ? ['• `/creator-campaign create/list/close` — KREATOR campaigns'] : []),
      '• `/refresh-leaderboard` — refresh persistent boards',
      '• `/export-leaderboard` — export leaderboard/community CSV',
      '• `/wallet-admin` / `/export-wallets` — wallet operations',
      '',
      '[KLINEO-MOD-COMMANDS]',
    ];
    await seedMessage(channels.modCommands, '[KLINEO-MOD-COMMANDS]', { content: modCommands1.join('\n') });

    const modCommands2 = [
      '**LINKO Moderator Command Center · 2/2**',
      '',
      '**Server + spaces**',
      '• `/server-settings` — community name, XP name, preset and modules',
      '• `/channel-manager` — create/batch-create/rename/archive managed channels',
      '• `/refresh-stats` — refresh Members / Online counters',
      '• `/server-image` — manage section images',
      '• `/official-links` / `/team-profile` — verified public identity',
      ...(moduleEnabled('founder_hub') ? ['• `/grant-klineo-role` — grant enabled functional roles'] : []),
      ...(moduleEnabled('liquidity_studio') ? ['• `/create-client-space` — private Studio workspace'] : []),
      '',
      '**Community operations**',
      '• `/community-health` / `/refresh-health` — health dashboard',
      '• `/mod-inbox` — consolidated review queue',
      '• `/event` — community event operations',
      '• `/suggestion` — product-roadmap suggestions',
      '• `/language-manager` — language communities',
      '• `/mod-help` — private staff guide',
      '',
      '[KLINEO-MOD-COMMANDS-2]',
    ];
    await seedMessage(channels.modCommands, '[KLINEO-MOD-COMMANDS-2]', { content: modCommands2.join('\n') });
  }

  setSetupPhase('10/11 · Refresh leaderboards + staff dashboards');
  await updateAllLeaderboards(guild);
  await updateCommunityHealthDashboard(guild);
  await updateModInbox(guild);

  setSetupPhase('11/11 · Refresh optional module content');
  if (channels.sharePost) await seedMessage(channels.sharePost, '[KLINEO-SOCIAL]', { embeds: [buildSocialEmbed()] });
  if (channels.founderLobby) await seedMessage(channels.founderLobby, '[KLINEO-FOUNDERS]', { embeds: [buildFounderHubEmbed()] });
  if (channels.founderDirectory) await seedMessage(channels.founderDirectory, '[KLINEO-FOUNDER-DIRECTORY]', { content: `**${communityName()} Founder Directory**\n\nApproved Founder Hub members and their project/founder social links appear here.\n\n[KLINEO-FOUNDER-DIRECTORY]` });

  setSetupPhase(`COMPLETE · ${communityName()} structure synced successfully`);
  return { roles, categories, channels };
}



function kxpLeaderboardPosition(guild, userId) {
  const rows = leaderboardRows(guild, 100000);
  const index = rows.findIndex((r) => r.user_id === userId);
  return index >= 0 ? index + 1 : null;
}
function referralLeaderboardPosition(guild, userId) {
  const rows = referralLeaderboardRows(guild, 100000);
  const index = rows.findIndex((r) => r.user_id === userId);
  return index >= 0 ? index + 1 : null;
}
function approvedSocialCount(userId) {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM social_submissions WHERE user_id = ? AND status = 'approved'").get(userId)?.c ?? 0);
}
function validBugCount(userId) {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM xp_log WHERE user_id = ? AND reason LIKE 'Valid bug report:%'").get(userId)?.c ?? 0);
}
function drawRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function fitText(ctx, text, maxWidth, startSize = 72, minSize = 34, family = 'sans-serif') {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `700 ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}
function compactMetric(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

async function drawGuildIdentity(ctx, guild, x, y, size, accent) {
  ctx.save();
  drawRoundRect(ctx, x, y, size, size, Math.round(size * 0.28));
  ctx.clip();

  let drawn = false;
  const iconUrl = guild.iconURL({ extension: 'png', size: 256 });
  if (iconUrl) {
    try {
      const response = await fetch(iconUrl);
      if (response.ok) {
        const image = await loadImage(Buffer.from(await response.arrayBuffer()));
        ctx.drawImage(image, x, y, size, size);
        drawn = true;
      }
    } catch {}
  }

  if (!drawn) {
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, size, size);
    const initial = communityName().trim().slice(0, 1).toUpperCase() || 'L';
    ctx.fillStyle = '#071008';
    ctx.font = `900 ${Math.round(size * 0.52)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, x + size / 2, y + size / 2 + 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  ctx.strokeStyle = accentRgba(accent, 0.7);
  ctx.lineWidth = 3;
  drawRoundRect(ctx, x, y, size, size, Math.round(size * 0.28));
  ctx.stroke();
}

function healthPeriodMetrics(days, offsetPeriods = 0) {
  const duration = days * 86400000;
  const end = now() - (offsetPeriods * duration);
  const start = end - duration;
  const between = (column) => `${column} >= ? AND ${column} < ?`;

  const joins = Number(db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${between('joined_at')}`).get(start, end)?.c ?? 0);
  const verifications = Number(db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${between('verified_at')}`).get(start, end)?.c ?? 0);
  const activeMembers = Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM activity_daily WHERE last_activity_at >= ? AND first_activity_at < ?').get(start, end)?.c ?? 0);
  const contributors = Number(db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM xp_log WHERE ${between('created_at')} AND amount > 0`).get(start, end)?.c ?? 0);
  const qualifiedMessages = qualifiedMessageCountBetween(start, end);
  const validReferrals = Number(db.prepare(`SELECT COUNT(*) AS c FROM xp_log WHERE ${between('created_at')} AND (reason LIKE 'Valid 7-day referral:%' OR reason LIKE 'Moderator-confirmed 7-day referral:%') AND amount > 0`).get(start, end)?.c ?? 0);
  const social = Number(db.prepare(`SELECT COUNT(*) AS c FROM social_submissions WHERE status='approved' AND ${between('reviewed_at')}`).get(start, end)?.c ?? 0);
  const suggestions = Number(db.prepare(`SELECT COUNT(*) AS c FROM product_suggestions WHERE ${between('created_at')}`).get(start, end)?.c ?? 0);
  const voice = voiceMetricsBetween(start, end);
  const eventAttendees = Number(db.prepare(`SELECT COUNT(DISTINCT ea.user_id) AS c FROM event_attendance ea JOIN community_events ce ON ce.id=ea.event_id WHERE ${between('COALESCE(ce.ended_at, ce.start_at)')}`).get(start, end)?.c ?? 0);

  return { start, end, joins, verifications, activeMembers, contributors, qualifiedMessages, validReferrals, social, suggestions, voiceParticipants: voice.participants, voiceSeconds: voice.seconds, eventAttendees };
}

function metricTrend(current, previous) {
  const c = Number(current ?? 0);
  const p = Number(previous ?? 0);
  if (c === 0 && p === 0) return { label: 'No change', direction: 'flat' };
  if (p === 0) return { label: c > 0 ? 'New vs prior' : 'No change', direction: c > 0 ? 'up' : 'flat' };
  const pct = Math.round(((c - p) / p) * 100);
  if (pct === 0) return { label: '0% vs prior', direction: 'flat' };
  return { label: `${pct > 0 ? '+' : ''}${pct}% vs prior`, direction: pct > 0 ? 'up' : 'down' };
}

function healthCardStatus(metrics, previous) {
  if (metrics.joins > 0 && metrics.verifications === 0) return { label: 'NEEDS ACTIVATION', tone: 'warn' };
  if (metrics.activeMembers === 0) return { label: 'LOW ACTIVITY', tone: 'muted' };
  const momentum =
    metrics.activeMembers > previous.activeMembers ||
    metrics.qualifiedMessages > previous.qualifiedMessages ||
    metrics.joins > previous.joins;
  if (metrics.activationRate != null && metrics.activationRate >= 60 && metrics.activeMembers > 0) return { label: 'HEALTHY CORE', tone: 'good' };
  if (momentum) return { label: 'MOMENTUM UP', tone: 'good' };
  return { label: 'STABLE CORE', tone: 'neutral' };
}

function healthCardInsight(metrics, previous, days) {
  if (metrics.joins > 0 && metrics.verifications === 0) {
    return `${metrics.joins} new ${metrics.joins === 1 ? 'member joined' : 'members joined'}, but none verified yet. The clearest opportunity is improving onboarding and verification.`;
  }
  if (metrics.activeMembers > 0 && metrics.qualifiedMessages === 0) {
    return `${metrics.activeMembers} active ${metrics.activeMembers === 1 ? 'member participated' : 'members participated'}, but no messages met the qualified-impact threshold in this ${days}-day window.`;
  }
  if (metrics.activeMembers > previous.activeMembers) {
    return `Active members increased from ${previous.activeMembers} to ${metrics.activeMembers} versus the previous ${days} days, with ${metrics.qualifiedMessages} qualified messages recorded.`;
  }
  if (metrics.activationRate != null && metrics.activationRate >= 60) {
    return `${metrics.activationRate}% of newly verified members completed at least one activation step. Participation is converting into deeper community activity.`;
  }
  if (metrics.joins === 0 && metrics.activeMembers > 0) {
    return `The current community core remains active, with ${metrics.activeMembers} active ${metrics.activeMembers === 1 ? 'member' : 'members'}, but no new joins were recorded in this window.`;
  }
  return `Community activity is steady: ${metrics.activeMembers} active ${metrics.activeMembers === 1 ? 'member' : 'members'}, ${metrics.qualifiedMessages} qualified messages and ${metrics.joins} new ${metrics.joins === 1 ? 'join' : 'joins'} in the last ${days} days.`;
}
async function generateHealthCard(guild, days = 7) {
  const W = 1600, H = 900;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const accent = brandAccent();
  const m = healthMetrics(guild, days);
  const current = healthPeriodMetrics(days, 0);
  const previous = healthPeriodMetrics(days, 1);
  const insight = healthCardInsight(m, previous, days);
  const verifiedRate = m.total ? Math.round((m.verified / m.total) * 100) : 0;
  const startDate = new Date(current.start);
  const endDate = new Date(current.end);
  const dateLabel = `${startDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).toUpperCase()} - ${endDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}`;

  const generatedAt = new Date();
  const generatedDate = generatedAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
  const generatedTime = `${String(generatedAt.getUTCHours()).padStart(2, '0')}:${String(generatedAt.getUTCMinutes()).padStart(2, '0')} UTC`;

  const previousActivated = Number(db.prepare(`SELECT COUNT(*) AS c
    FROM users u
    LEFT JOIN member_activation a ON a.user_id=u.user_id
    WHERE u.verified_at >= ? AND u.verified_at < ?
      AND (
        a.interests_set=1 OR a.language_set=1 OR a.introduced_at IS NOT NULL OR a.first_impact_at IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM activity_daily ad
          WHERE ad.user_id = u.user_id AND ad.last_activity_at >= u.verified_at
        )
      )`).get(previous.start, previous.end)?.c ?? 0);
  const previousActivationRate = previous.verifications
    ? Math.min(100, Math.round((previousActivated / previous.verifications) * 100))
    : null;

  const hex = normalizeBrandAccent(accent) ?? '#FF5A1F';
  const rgb = Number.parseInt(hex.slice(1), 16);
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const useDarkInk = luminance > 0.34;
  const ink = useDarkInk ? '#070707' : '#FFFFFF';
  const softInk = useDarkInk ? 'rgba(7,7,7,0.72)' : 'rgba(255,255,255,0.75)';
  const divider = useDarkInk ? 'rgba(7,7,7,0.82)' : 'rgba(255,255,255,0.72)';
  const tileFill = useDarkInk ? 'rgba(255,246,238,0.82)' : 'rgba(255,255,255,0.16)';
  const tileInk = useDarkInk ? '#090909' : '#FFFFFF';
  const pillFill = useDarkInk ? 'rgba(255,246,238,0.54)' : 'rgba(255,255,255,0.12)';

  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, H);

  // Server banner becomes a subtle branded texture. If absent, LINKO's chain motif is used.
  const bannerUrl = guild.bannerURL({ extension: 'png', size: 2048 });
  let bannerDrawn = false;
  if (bannerUrl) {
    try {
      const response = await fetch(bannerUrl);
      if (response.ok) {
        const image = await loadImage(Buffer.from(await response.arrayBuffer()));
        const boxX = 1100, boxY = 0, boxW = 500, boxH = 390;
        const sourceRatio = image.width / image.height;
        const boxRatio = boxW / boxH;
        let sx = 0, sy = 0, sw = image.width, sh = image.height;
        if (sourceRatio > boxRatio) {
          sw = image.height * boxRatio;
          sx = (image.width - sw) / 2;
        } else {
          sh = image.width / boxRatio;
          sy = (image.height - sh) / 2;
        }
        ctx.save();
        ctx.globalAlpha = 0.17;
        ctx.drawImage(image, sx, sy, sw, sh, boxX, boxY, boxW, boxH);
        ctx.restore();
        const wash = ctx.createLinearGradient(1040, 0, 1600, 0);
        wash.addColorStop(0, accentRgba(accent, 0.98));
        wash.addColorStop(0.5, accentRgba(accent, 0.58));
        wash.addColorStop(1, accentRgba(accent, 0.18));
        ctx.fillStyle = wash;
        ctx.fillRect(1010, 0, 590, 410);
        bannerDrawn = true;
      }
    } catch {}
  }

  if (!bannerDrawn) {
    ctx.save();
    ctx.translate(1400, 212);
    ctx.rotate(-0.62);
    ctx.strokeStyle = useDarkInk ? 'rgba(7,7,7,0.23)' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 35;
    drawRoundRect(ctx, -175, -62, 230, 124, 62);
    ctx.stroke();
    drawRoundRect(ctx, -20, -62, 230, 124, 62);
    ctx.stroke();
    ctx.restore();
    for (let y = 42; y < 348; y += 15) {
      for (let x = 1210; x < 1570; x += 15) {
        const dx = x - 1400, dy = y - 195;
        if ((dx * dx) / 51000 + (dy * dy) / 22000 < 1) {
          ctx.fillStyle = useDarkInk ? 'rgba(7,7,7,0.18)' : 'rgba(255,255,255,0.15)';
          ctx.fillRect(x, y, 5, 5);
        }
      }
    }
  }

  const drawIconTile = (x, y, kind, size = 70) => {
    drawRoundRect(ctx, x, y, size, size, Math.round(size * 0.19));
    ctx.fillStyle = tileFill;
    ctx.fill();
    ctx.strokeStyle = useDarkInk ? 'rgba(7,7,7,0.05)' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = tileInk;
    ctx.fillStyle = tileInk;
    ctx.lineWidth = Math.max(3, Math.round(size * 0.055));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (kind === 'people') {
      ctx.beginPath(); ctx.arc(size * 0.42, size * 0.34, size * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(size * 0.61, size * 0.38, size * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(size * 0.42, size * 0.72, size * 0.23, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.arc(size * 0.64, size * 0.71, size * 0.17, Math.PI, 0); ctx.stroke();
    } else if (kind === 'message') {
      drawRoundRect(ctx, size * 0.24, size * 0.25, size * 0.52, size * 0.40, size * 0.08);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size * 0.38, size * 0.64); ctx.lineTo(size * 0.29, size * 0.76); ctx.lineTo(size * 0.48, size * 0.65); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size * 0.34, size * 0.39); ctx.lineTo(size * 0.66, size * 0.39); ctx.moveTo(size * 0.34, size * 0.50); ctx.lineTo(size * 0.57, size * 0.50); ctx.stroke();
    } else if (kind === 'join') {
      ctx.beginPath(); ctx.arc(size * 0.38, size * 0.34, size * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(size * 0.38, size * 0.73, size * 0.23, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size * 0.69, size * 0.34); ctx.lineTo(size * 0.69, size * 0.58); ctx.moveTo(size * 0.57, size * 0.46); ctx.lineTo(size * 0.81, size * 0.46); ctx.stroke();
    } else if (kind === 'bars') {
      const bars = [[0.27,0.58,0.10,0.20],[0.45,0.43,0.10,0.35],[0.63,0.28,0.10,0.50]];
      for (const [bx,by,bw,bh] of bars) { drawRoundRect(ctx, size*bx, size*by, size*bw, size*bh, 3); ctx.fill(); }
    } else if (kind === 'shield') {
      ctx.beginPath();
      ctx.moveTo(size*0.50,size*0.20); ctx.lineTo(size*0.72,size*0.29); ctx.lineTo(size*0.69,size*0.58);
      ctx.quadraticCurveTo(size*0.64,size*0.75,size*0.50,size*0.82);
      ctx.quadraticCurveTo(size*0.36,size*0.75,size*0.31,size*0.58); ctx.lineTo(size*0.28,size*0.29); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size*0.39,size*0.50); ctx.lineTo(size*0.47,size*0.58); ctx.lineTo(size*0.63,size*0.40); ctx.stroke();
    } else if (kind === 'social') {
      ctx.beginPath(); ctx.moveTo(size*0.25,size*0.47); ctx.lineTo(size*0.58,size*0.33); ctx.lineTo(size*0.58,size*0.67); ctx.closePath(); ctx.stroke();
      ctx.strokeRect(size*0.20,size*0.43,size*0.08,size*0.16);
      ctx.beginPath(); ctx.moveTo(size*0.31,size*0.60); ctx.lineTo(size*0.36,size*0.76); ctx.stroke();
      ctx.beginPath(); ctx.arc(size*0.63,size*0.50,size*0.18,-0.8,0.8); ctx.stroke();
    } else if (kind === 'voice') {
      ctx.beginPath(); ctx.arc(size*0.39,size*0.46,size*0.12,0,Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.arc(size*0.39,size*0.46,size*0.22,-0.9,0.9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size*0.66,size*0.34); ctx.lineTo(size*0.66,size*0.66); ctx.moveTo(size*0.58,size*0.42); ctx.quadraticCurveTo(size*0.53,size*0.50,size*0.58,size*0.58); ctx.stroke();
    } else if (kind === 'calendar') {
      drawRoundRect(ctx,size*0.24,size*0.28,size*0.52,size*0.48,size*0.05); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size*0.24,size*0.41); ctx.lineTo(size*0.76,size*0.41); ctx.moveTo(size*0.37,size*0.22); ctx.lineTo(size*0.37,size*0.34); ctx.moveTo(size*0.63,size*0.22); ctx.lineTo(size*0.63,size*0.34); ctx.stroke();
      ctx.fillRect(size*0.34,size*0.50,size*0.07,size*0.07); ctx.fillRect(size*0.47,size*0.50,size*0.07,size*0.07); ctx.fillRect(size*0.60,size*0.50,size*0.07,size*0.07);
    } else if (kind === 'link') {
      ctx.save(); ctx.translate(size*0.50,size*0.50); ctx.rotate(-0.65);
      drawRoundRect(ctx,-size*0.29,-size*0.11,size*0.34,size*0.22,size*0.11); ctx.stroke();
      drawRoundRect(ctx,-size*0.05,-size*0.11,size*0.34,size*0.22,size*0.11); ctx.stroke();
      ctx.restore();
    } else if (kind === 'bulb') {
      ctx.beginPath(); ctx.arc(size*0.50,size*0.42,size*0.18,Math.PI*0.82,Math.PI*2.18); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size*0.41,size*0.57); ctx.lineTo(size*0.44,size*0.67); ctx.lineTo(size*0.56,size*0.67); ctx.lineTo(size*0.59,size*0.57); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(size*0.44,size*0.73); ctx.lineTo(size*0.56,size*0.73); ctx.stroke();
    }
    ctx.restore();
  };

  // Community-first identity, LINKO as the infrastructure brand.
  await drawGuildIdentity(ctx, guild, 58, 44, 92, ink);
  ctx.fillStyle = ink;
  const serverName = communityNameUpper();
  const serverNameSize = fitText(ctx, serverName, 430, 46, 28);
  ctx.font = `900 ${serverNameSize}px sans-serif`;
  ctx.fillText(serverName, 176, 91);
  ctx.font = '800 17px monospace';
  ctx.fillText('POWERED BY LINKO', 178, 120);

  ctx.textAlign = 'center';
  ctx.font = '800 18px monospace';
  ctx.fillText(`LAST ${days} DAYS`, 800, 78);
  ctx.fillStyle = softInk;
  ctx.font = '700 14px monospace';
  ctx.fillText(dateLabel, 800, 106);
  ctx.textAlign = 'left';

  // Main editorial headline.
  ctx.fillStyle = ink;
  const headlineSize = fitText(ctx, 'COMMUNITY HEALTH.', 1100, 86, 68);
  ctx.font = `900 ${headlineSize}px sans-serif`;
  ctx.fillText('COMMUNITY HEALTH.', 58, 270);

  // Insight always fits in two lines. Reduce type before truncating.
  let insightSize = 22;
  let insightLines = [];
  const wrapFull = (text, maxWidth) => {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(test).width <= maxWidth) line = test;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  };
  while (insightSize >= 16) {
    ctx.font = `700 ${insightSize}px sans-serif`;
    insightLines = wrapFull(insight, 1080);
    if (insightLines.length <= 2) break;
    insightSize -= 1;
  }
  ctx.fillStyle = softInk;
  insightLines.slice(0,2).forEach((line, index) => ctx.fillText(line, 60, 326 + index * (insightSize + 8)));

  ctx.fillStyle = divider;
  ctx.fillRect(58, 418, 1484, 3);

  const trendLabel = (trend) => {
    if (!trend) return 'NO CHANGE';
    if (trend.label === 'New vs prior') return 'NEW';
    if (trend.direction === 'flat') return 'NO CHANGE';
    return trend.label.toUpperCase();
  };
  const primary = [
    { label: ['Active','Members'], value: compactMetric(m.activeMembers), icon: 'people', trend: metricTrend(current.activeMembers, previous.activeMembers), note: `${m.activeMembers} of ${m.total} · ${m.activeRate}% active` },
    { label: ['Qualified','Messages'], value: compactMetric(m.qualifiedMessages), icon: 'message', trend: metricTrend(current.qualifiedMessages, previous.qualifiedMessages) },
    { label: ['New','Joins'], value: compactMetric(m.joins), icon: 'join', trend: metricTrend(current.joins, previous.joins) },
    { label: ['Activation'], value: m.activationRate == null ? 'N/A' : `${m.activationRate}%`, icon: 'bars', trend: m.activationRate == null || previousActivationRate == null ? null : metricTrend(m.activationRate, previousActivationRate), note: m.activationRate == null ? 'No verified joins yet' : `${m.activated} of ${m.verifications} activated` },
  ];

  const columnX = [58, 428, 798, 1168];
  const columnW = 340;
  const drawPill = (x, y, label, direction) => {
    ctx.font = '800 13px monospace';
    const w = Math.max(128, ctx.measureText(label).width + 48);
    drawRoundRect(ctx, x, y, w, 34, 17);
    ctx.fillStyle = pillFill; ctx.fill();
    ctx.fillStyle = direction === 'down' ? (useDarkInk ? '#7A1D16' : '#FFD0CA') : softInk;
    ctx.beginPath(); ctx.arc(x + 18, y + 17, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ink;
    ctx.fillText(label, x + 36, y + 22);
  };

  primary.forEach((item, index) => {
    const x = columnX[index];
    if (index > 0) {
      ctx.fillStyle = divider;
      ctx.globalAlpha = 0.72;
      ctx.fillRect(x - 28, 450, 2, 168);
      ctx.globalAlpha = 1;
    }
    drawIconTile(x, 448, item.icon, 70);
    ctx.fillStyle = ink;
    ctx.font = '800 20px sans-serif';
    item.label.forEach((line, li) => ctx.fillText(line, x + 94, 474 + li * 24));
    ctx.font = `900 ${item.value === 'N/A' ? 58 : 72}px monospace`;
    ctx.fillText(item.value, x, 588);
    if (item.note) {
      ctx.font = '700 14px sans-serif';
      ctx.fillText(item.note, x + 3, 616);
    }
    const tLabel = trendLabel(item.trend);
    drawPill(x, 622, tLabel, item.trend?.direction ?? 'flat');
  });

  ctx.fillStyle = divider;
  ctx.fillRect(58, 660, 1484, 3);

  const secondary = [
    { label:['Verified','Members'], value:compactMetric(m.verified), note:`${verifiedRate}% verified`, icon:'shield' },
    { label:['Social','Posts'], value:compactMetric(m.social), note:'approved', icon:'social' },
    { label:['Voice','Participants'], value:compactMetric(m.voiceParticipants), note:`${formatVoiceDuration(m.voiceSeconds)} total`, icon:'voice' },
    { label:['Event','Attendees'], value:compactMetric(m.eventAttendees), note:m.eventAttendees ? `last ${days}d` : 'no official events', icon:'calendar' },
    { label:['Referrals'], value:compactMetric(m.validReferrals), note:'valid', icon:'link' },
    { label:['Suggestions'], value:compactMetric(m.suggestions), note:'submitted', icon:'bulb' },
  ];
  const secX = [58, 305, 552, 799, 1046, 1293];

  secondary.forEach((item, index) => {
    const x = secX[index];
    if (index > 0) {
      ctx.fillStyle = divider;
      ctx.globalAlpha = 0.62;
      ctx.fillRect(x - 18, 689, 2, 125);
      ctx.globalAlpha = 1;
    }
    drawIconTile(x, 688, item.icon, 54);
    ctx.fillStyle = ink;
    ctx.font = '800 15px sans-serif';
    item.label.forEach((line, li) => ctx.fillText(line, x + 68, 709 + li * 19));
    ctx.font = '900 37px monospace';
    ctx.fillText(item.value, x + 68, 782);
    ctx.fillStyle = softInk;
    ctx.font = '700 11px sans-serif';
    ctx.fillText(item.note, x + 68, 807);
  });
  ctx.fillStyle = divider;
  ctx.fillRect(58, 835, 1484, 2);

  ctx.fillStyle = ink;
  ctx.font = '700 15px sans-serif';
  ctx.fillText('Generated by LINKO', 58, 875);

  ctx.textAlign = 'center';
  ctx.font = '700 13px monospace';
  ctx.fillText(`UPDATED ${generatedDate} · ${generatedTime}`, 800, 875);

  ctx.textAlign = 'right';
  ctx.font = '800 13px monospace';
  ctx.fillText('PEOPLE CONNECT. PROGRESS.', 1542, 875);
  ctx.textAlign = 'left';

  const activationCaption = m.activationRate == null ? 'no new verifications yet' : `${m.activationRate}% activation among new verifications`;
  const caption = `${communityName()} Community Health, last ${days} days: ${m.activeMembers} active members (${m.activeRate}% of the community), ${m.qualifiedMessages} qualified messages, ${m.voiceParticipants} voice participants (${formatVoiceDuration(m.voiceSeconds)}), ${m.joins} new joins and ${activationCaption}. ${insight}`;
  return { buffer: canvas.toBuffer('image/png'), caption, status: healthCardStatus(m, previous).label };
}

async function generateSocialCard(guild, member, type) {
  const W = 1600, H = 900;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(1300, 100, 0, 1300, 100, 650);
  glow.addColorStop(0, 'rgba(184,240,58,0.18)'); glow.addColorStop(1, 'rgba(184,240,58,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#B8F03A'; ctx.fillRect(85, 75, 8, 100);
  ctx.fillStyle = '#FFFFFF'; ctx.font = '800 42px sans-serif'; ctx.fillText(communityNameUpper(), 125, 125);
  ctx.fillStyle = '#9CA3AF'; ctx.font = '500 24px monospace'; ctx.fillText('COMMUNITY IDENTITY // LINKO', 125, 162);

  const xp = getXp(member.id);
  const label = xpLabel();
  const rank = rankForXp(xp);
  const next = nextRankForXp(xp);
  const referrals = getReferralStats(member.id);
  const kpos = kxpLeaderboardPosition(guild, member.id);
  const rpos = referralLeaderboardPosition(guild, member.id);
  const socialCount = approvedSocialCount(member.id);
  const bugs = validBugCount(member.id);
  const display = member.displayName || member.user.username;
  const nameSize = fitText(ctx, display, 1250, 76, 40);
  ctx.fillStyle = '#FFFFFF'; ctx.font = `800 ${nameSize}px sans-serif`; ctx.fillText(display, 90, 285);
  ctx.fillStyle = '#B8F03A'; ctx.font = '700 34px monospace'; ctx.fillText(rank.name, 92, 340);

  drawRoundRect(ctx, 90, 390, 1420, 350, 32); ctx.fillStyle = 'rgba(255,255,255,0.055)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2; ctx.stroke();

  const metric = (label, value, x, y) => {
    ctx.fillStyle = '#9CA3AF'; ctx.font = '600 22px sans-serif'; ctx.fillText(label.toUpperCase(), x, y);
    ctx.fillStyle = '#FFFFFF'; ctx.font = '800 46px monospace'; ctx.fillText(value, x, y + 58);
  };
  let title = 'PROGRESS CARD';
  let caption = `I’m ${rank.name} in the ${communityName()} community with ${xp.toLocaleString()} ${label}.`;
  if (type === 'progress') {
    metric(label, xp.toLocaleString(), 145, 475);
    metric(`${label} leaderboard`, kpos ? `#${kpos}` : '—', 560, 475);
    metric('Next rank', next ? next.name : 'MAX', 1000, 475);
    const start = rank.threshold, end = next?.threshold ?? Math.max(start + 1, xp);
    const pct = next ? Math.max(0, Math.min(1, (xp - start) / (end - start))) : 1;
    ctx.fillStyle = '#6B7280'; drawRoundRect(ctx, 145, 630, 1180, 24, 12); ctx.fill();
    ctx.fillStyle = '#B8F03A'; drawRoundRect(ctx, 145, 630, Math.max(24, 1180 * pct), 24, 12); ctx.fill();
    ctx.fillStyle = '#9CA3AF'; ctx.font = '500 22px monospace'; ctx.fillText(next ? `${(next.threshold - xp).toLocaleString()} ${label} to ${next.name}` : `PRIME reached · ${label} keeps growing`, 145, 700);
  } else if (type === 'referral') {
    title = 'REFERRAL CARD';
    metric('Valid referrals', referrals.valid.toLocaleString(), 145, 475);
    metric('Total invited', referrals.total.toLocaleString(), 560, 475);
    metric('Referral leaderboard', rpos ? `#${rpos}` : '—', 1000, 475);
    caption = `I’ve brought ${referrals.valid} verified members into the ${communityName()} community. My referral rank: ${rpos ? `#${rpos}` : 'building'}.`;
  } else if (type === 'impact') {
    title = 'COMMUNITY IMPACT';
    metric(label, xp.toLocaleString(), 145, 475);
    metric('Valid referrals', referrals.valid.toLocaleString(), 500, 475);
    metric('Approved posts', socialCount.toLocaleString(), 870, 475);
    metric('Valid bugs', bugs.toLocaleString(), 1230, 475);
    caption = `My ${communityName()} community impact: ${xp.toLocaleString()} ${label}, ${referrals.valid} valid referrals and ${socialCount} approved social posts.`;
  } else if (type === 'founder') {
    const isFounder = member.roles.cache.some((r) => ['VERIFIED FOUNDER', 'STUDIO CLIENT'].includes(r.name));
    if (!isFounder) throw new Error('Founder cards are available only to VERIFIED FOUNDER or STUDIO CLIENT roles.');
    const app = db.prepare("SELECT * FROM founder_applications WHERE user_id = ? AND status = 'approved' ORDER BY reviewed_at DESC LIMIT 1").get(member.id);
    title = 'VERIFIED FOUNDER';
    metric('Community rank', rank.name, 145, 475);
    metric(label, xp.toLocaleString(), 620, 475);
    metric('Project', app?.project_name ? app.project_name.slice(0, 18) : 'VERIFIED', 1000, 475);
    caption = `Verified Founder in the ${communityName()} community${app?.project_name ? `, building ${app.project_name}` : ''}.`;
  }

  ctx.fillStyle = '#9CA3AF'; ctx.font = '600 22px monospace'; ctx.fillText(title, 90, 815);
  const footerUrl = getSetting('official_website') || 'LINKO';
  ctx.fillStyle = '#FFFFFF'; ctx.font = '600 22px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(String(footerUrl).replace(/^https?:\/\//, '').slice(0, 42), 1510, 815); ctx.textAlign = 'left';
  return { buffer: canvas.toBuffer('image/png'), caption, title };
}
async function publishOfficialLinks(guild) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'official-links' && c.isTextBased());
  if (!channel) return false;
  await seedMessage(channel, '[KLINEO-OFFICIAL-LINKS]', { embeds: [buildOfficialLinksEmbed()] });
  return true;
}
async function createClientSpace(guild, projectName, member) {
  const core = guild.roles.cache.find((r) => r.name === coreRoleName());
  const team = guild.roles.cache.find((r) => r.name === teamRoleName());
  const moderator = guild.roles.cache.find((r) => r.name === 'MODERATOR');
  const studio = guild.roles.cache.find((r) => r.name === 'STUDIO CLIENT');
  if (!moduleEnabled('liquidity_studio')) throw new Error('Liquidity Studio module is disabled for this server.');
  if (!core || !team || !moderator || !studio) throw new Error('Run /setup-linko first.');
  await member.roles.add(studio, `${communityName()} Studio client for ${projectName}`);
  const everyone = guild.roles.everyone;
  const allowed = [core, team, moderator];
  const perms = [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(member.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]), ...allowed.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))];
  const category = await ensureCategory(guild, `CLIENT・${projectName.toUpperCase()}`, perms);
  const created = {};
  for (const [key, name, topic] of [['overview', '📋・overview', `${projectName} private ${communityName()} Studio overview.`], ['liquidityOps', '💧・liquidity-ops', `${projectName} liquidity operations.`], ['reports', '📊・reports', `${projectName} reports and deliverables.`], ['support', '🆘・support', `${projectName} private support.`]]) created[key] = await ensureTextChannel(guild, category, { name, topic }, perms);
  created.voice = await ensureVoiceChannel(guild, category, { name: `🎙️ ${projectName} Project Room`, userLimit: 20 }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]), overwrite(member.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]), ...allowed.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]))]);
  await seedMessage(created.overview, '[KLINEO-CLIENT-SPACE]', { content: `**${projectName} × ${communityName()} Liquidity Studio**\n\nPrivate workspace for the client and ${communityName()} team. Keep sensitive market, treasury, listing and operational information inside this category.\n\n[KLINEO-CLIENT-SPACE]` });
  return category;
}

async function cacheInvites(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  inviteUseCaches.set(String(guild.id), new Map(invites.map((i) => [i.code, i.uses ?? 0])));
}
async function detectUsedInvite(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
  const cache = inviteCacheForGuild(guild.id);
  let used = null;
  for (const invite of invites.values()) {
    const previous = cache.get(invite.code) ?? 0;
    if ((invite.uses ?? 0) > previous) { used = invite; break; }
  }
  inviteUseCaches.set(String(guild.id), new Map(invites.map((i) => [i.code, i.uses ?? 0])));
  return used;
}

async function checkPendingReferrals(guild) {
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
  const refs = db.prepare('SELECT * FROM referrals WHERE valid_awarded = 0 AND joined_at <= ?').all(cutoff);
  for (const ref of refs) {
    const member = await guild.members.fetch(ref.member_id).catch(() => null);
    if (!member || member.user.bot || !hasVerifiedRole(member)) continue;
    const attribution = getJoinAttribution(ref.member_id);
    if (!attribution || attribution.source !== 'member' || !Number(attribution.source_confirmed) || !Number(attribution.inviter_confirmed) || attribution.inviter_id !== ref.inviter_id) continue;
    const eligibleInviter = await guild.members.fetch(ref.inviter_id).catch(() => null);
    if (!eligibleInviter || eligibleInviter.user.bot || (!hasVerifiedRole(eligibleInviter) && !hasStaffRole(eligibleInviter))) continue;
    const activity = referralActivityCount(ref.member_id, ref.joined_at);
    const activeDays = referralActivityDays(ref.member_id, ref.joined_at);
    if (activity < Math.max(1, getSettingInt('referral_activity_min_events'))) continue;
    if (activeDays < Math.max(1, getSettingInt('referral_activity_min_days'))) continue;
    db.prepare('UPDATE referrals SET valid_awarded = 1 WHERE member_id = ?').run(ref.member_id);
    db.prepare('UPDATE unattributed_joins SET resolved = 1, resolved_at = ? WHERE user_id = ?').run(now(), ref.member_id);
    const award = getSettingInt('kxp_valid_referral');
    if (award > 0) await addXp(guild, ref.inviter_id, award, `Valid 7-day referral: <@${ref.member_id}>`);
    const log = guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
    if (log) await log.send(`🤝 **Referral validated** — <@${ref.inviter_id}> → <@${ref.member_id}> · source selected + inviter confirmed + verified + 7 days + active on **${activeDays} day(s)** (${activity} tracked activity event${activity === 1 ? '' : 's'}).`).catch(() => {});
    const inviterMember = await guild.members.fetch(ref.inviter_id).catch(() => null);
    if (inviterMember) await inviterMember.send(`✅ Your ${communityName()} referral <@${ref.member_id}> is now valid. **+${award} ${xpLabel()}** has been added to your account.`).catch(() => {});
  }
  scheduleLeaderboardUpdate(guild);
}

function activeVoiceEventForChannel(channelId) {
  const event = getActiveVoiceEvent();
  return event && String(event.channel_id) === String(channelId) ? event : null;
}

function closeOpenVoiceSession(userId, channelId = null, leftAt = now()) {
  const row = channelId
    ? db.prepare('SELECT * FROM voice_sessions WHERE user_id = ? AND channel_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1').get(userId, channelId)
    : db.prepare('SELECT * FROM voice_sessions WHERE user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1').get(userId);
  if (!row) return null;
  const end = Math.max(Number(row.joined_at), Number(leftAt));
  const seconds = Math.max(0, Math.floor((end - Number(row.joined_at)) / 1000));
  db.prepare('UPDATE voice_sessions SET left_at = ?, duration_seconds = ? WHERE id = ?').run(end, seconds, row.id);
  return { ...row, left_at: end, duration_seconds: seconds };
}

function openVoiceSession(userId, channelId, joinedAt = now()) {
  closeOpenVoiceSession(userId, null, joinedAt);
  const active = activeVoiceEventForChannel(channelId);
  const result = db.prepare('INSERT INTO voice_sessions (user_id, channel_id, joined_at, official_event_id) VALUES (?, ?, ?, ?)')
    .run(userId, channelId, joinedAt, active?.id ?? null);
  return Number(result.lastInsertRowid);
}

function noteStageHandRaise(eventId, userId, raisedAt = now()) {
  db.prepare(`INSERT INTO voice_event_speakers (event_id, user_id, hand_raised_at) VALUES (?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET hand_raised_at = COALESCE(voice_event_speakers.hand_raised_at, excluded.hand_raised_at)`).run(eventId, userId, raisedAt);
}
function noteStageSpeakerStarted(eventId, userId, startedAt = now()) {
  db.prepare(`INSERT INTO voice_event_speakers (event_id, user_id, speaker_started_at) VALUES (?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET speaker_started_at = COALESCE(voice_event_speakers.speaker_started_at, excluded.speaker_started_at)`).run(eventId, userId, startedAt);
}

async function awardOfficialSpeakerBonus(guild, event, member, actorId = null, requireHandRaise = false) {
  if (!event || !member || member.user?.bot || !hasVerifiedRole(member)) return { awarded: false, reason: 'Member must be verified.' };
  if (String(member.voice?.channelId ?? '') !== String(event.channel_id)) return { awarded: false, reason: 'Member must currently be in the active official event channel.' };
  const existing = db.prepare('SELECT * FROM voice_event_speakers WHERE event_id = ? AND user_id = ?').get(event.id, member.id);
  if (existing?.awarded_at) return { awarded: false, reason: 'Speaker bonus already awarded for this event.' };
  if (requireHandRaise && !existing?.hand_raised_at) return { awarded: false, reason: 'No Stage hand raise was recorded.' };
  const award = Math.max(0, getSettingInt('kxp_voice_speaker_bonus'));
  if (!award) return { awarded: false, reason: 'Speaker bonus is disabled.' };
  const ts = now();
  db.prepare(`INSERT INTO voice_event_speakers (event_id, user_id, speaker_started_at, awarded_at, awarded_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET speaker_started_at = COALESCE(voice_event_speakers.speaker_started_at, excluded.speaker_started_at), awarded_at = excluded.awarded_at, awarded_by = excluded.awarded_by`)
    .run(event.id, member.id, ts, ts, actorId);
  await addXp(guild, member.id, award, `Official voice speaker: ${event.name}`, actorId);
  return { awarded: true, amount: award };
}

async function reconcileVoiceSessions(guild) {
  const activeHumans = new Map();
  for (const channel of guild.channels.cache.values()) {
    if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) continue;
    for (const member of channel.members.values()) if (!member.user.bot) activeHumans.set(member.id, channel.id);
  }
  const openRows = db.prepare('SELECT * FROM voice_sessions WHERE left_at IS NULL').all();
  for (const row of openRows) {
    const actualChannel = activeHumans.get(row.user_id);
    if (actualChannel === row.channel_id) { activeHumans.delete(row.user_id); continue; }
    closeOpenVoiceSession(row.user_id, row.channel_id, now());
  }
  for (const [userId, channelId] of activeHumans) openVoiceSession(userId, channelId, now());
}
function getActiveVoiceEvent() {
  return db.prepare('SELECT * FROM voice_events WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
}

async function startVoiceEvent(guild, channel, name, actorId) {
  const active = getActiveVoiceEvent();
  if (active) throw new Error(`An event is already active: ${active.name}`);
  const result = db.prepare('INSERT INTO voice_events (name, channel_id, started_by, started_at, active) VALUES (?, ?, ?, ?, 1)').run(name, channel.id, actorId, now());
  return Number(result.lastInsertRowid);
}

async function stopVoiceEvent() {
  const active = getActiveVoiceEvent();
  if (!active) return null;
  db.prepare('UPDATE voice_events SET active = 0, ended_at = ? WHERE id = ?').run(now(), active.id);
  return active;
}

async function processVoiceEventMinute(guild) {
  const event = getActiveVoiceEvent();
  if (!event) return;
  const channel = guild.channels.cache.get(event.channel_id);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) return;
  const humans = [...channel.members.values()].filter((m) => !m.user.bot);
  if (humans.length < 2) return;
  const intervalMinutes = Math.max(1, getSettingInt('voice_interval_minutes'));
  const award = Math.max(0, getSettingInt('kxp_voice_interval'));
  for (const member of humans) {
    if (!hasVerifiedRole(member)) continue;
    const state = member.voice;
    if (!state.channelId || state.selfDeaf || state.serverDeaf) continue;

    if (award > 0) {
      db.prepare(`INSERT INTO voice_event_progress (event_id, user_id, qualified_minutes) VALUES (?, ?, 1)
        ON CONFLICT(event_id, user_id) DO UPDATE SET qualified_minutes = qualified_minutes + 1`).run(event.id, member.id);
      const progress = Number(db.prepare('SELECT qualified_minutes FROM voice_event_progress WHERE event_id = ? AND user_id = ?').get(event.id, member.id)?.qualified_minutes ?? 0);
      if (progress >= intervalMinutes) {
        const intervals = Math.floor(progress / intervalMinutes);
        const remainder = progress % intervalMinutes;
        db.prepare('UPDATE voice_event_progress SET qualified_minutes = ? WHERE event_id = ? AND user_id = ?').run(remainder, event.id, member.id);
        await addXp(guild, member.id, intervals * award, `Official voice event: ${event.name}`);
      }
    }

    if (channel.type === ChannelType.GuildStageVoice && state.suppress === false) {
      const speaker = db.prepare('SELECT * FROM voice_event_speakers WHERE event_id = ? AND user_id = ?').get(event.id, member.id);
      if (speaker?.hand_raised_at && speaker?.speaker_started_at && !speaker?.awarded_at && now() - Number(speaker.speaker_started_at) >= 60000) {
        const result = await awardOfficialSpeakerBonus(guild, event, member, null, true);
        if (result.awarded) {
          const log = guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
          if (log) await log.send(`🎤 **Official speaker bonus** — ${member} raised their hand and remained a Stage speaker for at least 1 minute during **${event.name}**. **+${result.amount} ${xpLabel()}**.`).catch(() => {});
        }
      }
    }
  }
}

async function sendWelcomeDm(member) {
  const name = communityName();
  const verify = member.guild.channels.cache.find((c) => baseChannelName(c.name) === 'verify');
  const rules = member.guild.channels.cache.find((c) => baseChannelName(c.name) === 'rules');
  const attribution = getJoinAttribution(member.id);
  const detected = attribution?.detected_inviter_id ? `\n\nLINKO detected <@${attribution.detected_inviter_id}> as the invite creator. Confirm that by running \`/join-source source:Invited by a member\` (you can leave the member option empty), or choose the correct non-member source.` : '';
  await member.send(`**Welcome to ${name}.**\n\n1. Read ${rules ? `<#${rules.id}>` : '#rules'}.\n2. Before verification, run **/join-source** and tell LINKO how you joined ${name}.${detected}\n3. Verify in ${verify ? `<#${verify.id}>` : '#verify'} to unlock the community.\n\nIf a member invited you manually, select them in /join-source. They will need to confirm the referral, but you do **not** have to wait for that confirmation to enter.\n\n${name} staff will never ask for your seed phrase, private key or funds via unsolicited DM.`).catch(() => {});
}

async function verifyMember(interaction) {
  const name = communityName();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (hasVerifiedRole(member)) return interaction.reply({ embeds: [buildMemberProfileEmbed(interaction.guild, member)], components: profileActionRows(member), ephemeral: true });
  const attribution = getJoinAttribution(member.id);
  if (!attribution || !Number(attribution.source_confirmed) || !attribution.source) {
    return interaction.reply({ content: `Before you can enter ${name}, click **START ONBOARDING** in #verify and select how you joined. You can also use /join-source as a manual fallback.`, ephemeral: true });
  }
  const lane = participationLane(member);
  if (!lane) return interaction.reply({ content: 'Before verification, choose **Community Member** or **KREATOR** in START ONBOARDING.', components: [participationSelectRow()], ephemeral: true });
  const ageHours = (now() - interaction.user.createdTimestamp) / 3600000;
  if (ageHours < MIN_ACCOUNT_AGE_HOURS) return interaction.reply({ content: `This Discord account is too new to verify yet. Please try again after it is ${MIN_ACCOUNT_AGE_HOURS} hours old.`, ephemeral: true });
  const verifiedRole = interaction.guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const l1 = interaction.guild.roles.cache.find((r) => r.name === 'OBSERVER');
  if (!verifiedRole || !l1) return interaction.reply({ content: 'Verification roles are missing. Ask staff to run /setup-linko.', ephemeral: true });
  await member.roles.add([verifiedRole, l1], 'LINKO self-verification');
  if (lane === 'kreator' && kreatorProfileApproved(member.id)) {
    const kreatorRole = interaction.guild.roles.cache.find((r) => r.name === 'KREATOR');
    if (kreatorRole) {
      await member.roles.add(kreatorRole, 'LINKO approved KREATOR activation');
      await maybeAwardReferralRoleBonus(interaction.guild, member.id, 'KREATOR');
    }
  }
  ensureUserRow(member.id, member.joinedTimestamp ?? now());
  db.prepare('UPDATE users SET verified_at = ? WHERE user_id = ?').run(now(), member.id);
  const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'verification-log' && c.isTextBased());
  if (log) log.send(`✅ ${member} verified and entered ${name} as **OBSERVER**. Join source: **${joinSourceLabel(attribution.source)}**${attribution.inviter_id ? ` · inviter <@${attribution.inviter_id}>` : ''}.`).catch(() => {});
  db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(member.id);
  scheduleHealthUpdate(interaction.guild); scheduleModInboxUpdate(interaction.guild);
  return interaction.reply({
    content: `✅ Verified. Welcome to ${name}. You now have **OBSERVER** access. Participation: **${lane.startsWith('kreator') ? 'KREATOR' : 'Community Member'}**. Join source: **${joinSourceLabel(attribution.source)}**.${lane === 'kreator_pending' ? ' Your KREATOR profile is pending staff approval; you are already excluded from the Community Leaderboard.' : ''}\n\nYour socials, interests, communities and payout wallets can be updated anytime using **MY LINKO PROFILE** in #bot-commands or /profile.`,
    embeds: [buildMemberProfileEmbed(interaction.guild, member)],
    components: profileActionRows(member),
    ephemeral: true,
  });
}

async function createFounderApplicationModal(interaction) {
  const modal = new ModalBuilder().setCustomId('founder_application_modal').setTitle(`${communityName().slice(0, 20)} Founder Verification`);
  const project = new TextInputBuilder().setCustomId('project').setLabel('Project name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  const website = new TextInputBuilder().setCustomId('website').setLabel('Website').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(180);
  const social = new TextInputBuilder().setCustomId('social').setLabel('Project socials (X / TG / LinkedIn)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(180);
  const role = new TextInputBuilder().setCustomId('role').setLabel('Your socials + role/title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(180);
  const interest = new TextInputBuilder().setCustomId('interest').setLabel('Interested in Liquidity Studio? Why?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
  modal.addComponents(...[project, website, social, role, interest].map((x) => new ActionRowBuilder().addComponents(x)));
  await interaction.showModal(modal);
}

async function handleFounderModal(interaction) {
  if (!moduleEnabled('founder_hub')) return interaction.reply({ content: 'The Founder Hub module is disabled in this server.', ephemeral: true });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first in #verify.', ephemeral: true });
  const values = {
    project: interaction.fields.getTextInputValue('project').trim(),
    website: interaction.fields.getTextInputValue('website').trim(),
    social: interaction.fields.getTextInputValue('social').trim(),
    role: interaction.fields.getTextInputValue('role').trim(),
    interest: interaction.fields.getTextInputValue('interest').trim(),
  };
  const result = db.prepare('INSERT INTO founder_applications (user_id, project_name, website, social, role_title, studio_interest, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(member.id, values.project, values.website, values.social, values.role, values.interest, now());
  const id = Number(result.lastInsertRowid);
  const channel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'founder-verification' && c.isTextBased());
  if (!channel) return interaction.reply({ content: 'Founder review channel is missing. Ask staff to run /setup-klineo.', ephemeral: true });
  const embed = new EmbedBuilder().setColor(BRAND.lime).setTitle(`Founder application #${id}`).setDescription(`${member}`).addFields(
    { name: 'Project', value: values.project }, { name: 'Website', value: values.website }, { name: 'Project socials', value: values.social }, { name: 'Founder socials + role', value: values.role }, { name: 'Liquidity Studio interest', value: values.interest },
  ).setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`founder_approve:${id}`).setLabel('Approve Founder').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`founder_reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
  const msg = await channel.send({ embeds: [embed], components: [row] });
  db.prepare('UPDATE founder_applications SET review_message_id = ? WHERE id = ?').run(msg.id, id);
  scheduleModInboxUpdate(interaction.guild);
  await interaction.reply({ content: `Founder application submitted. ${communityName()} staff will review it.`, ephemeral: true });
}

async function handleFounderReview(interaction, action, id) {
  if (!moduleEnabled('founder_hub')) return interaction.reply({ content: 'The Founder Hub module is disabled in this server.', ephemeral: true });
  if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const app = db.prepare('SELECT * FROM founder_applications WHERE id = ?').get(id);
  if (!app || app.status !== 'pending') return interaction.reply({ content: 'This application has already been reviewed or does not exist.', ephemeral: true });
  const member = await interaction.guild.members.fetch(app.user_id).catch(() => null);
  if (action === 'approve' && member) {
    const role = interaction.guild.roles.cache.find((r) => r.name === 'VERIFIED FOUNDER');
    if (role) await member.roles.add(role, `Founder approved by ${interaction.user.tag}`);
    await maybeAwardReferralRoleBonus(interaction.guild, member.id, 'VERIFIED FOUNDER');
    await publishFounderProfile(interaction.guild, app);
  }
  db.prepare('UPDATE founder_applications SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(action === 'approve' ? 'approved' : 'rejected', interaction.user.id, now(), id);
  const embed = EmbedBuilder.from(interaction.message.embeds[0]).setColor(action === 'approve' ? BRAND.emerald : BRAND.rose).setFooter({ text: `${action === 'approve' ? 'Approved' : 'Rejected'} by ${interaction.user.tag}` });
  await interaction.update({ embeds: [embed], components: [] });
  scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild);
  if (member) member.send(action === 'approve' ? `✅ Your ${communityName()} Founder Hub application was approved.` : `Your ${communityName()} Founder Hub application was not approved at this time.`).catch(() => {});
}

async function publishFounderProfile(guild, app) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'founder-directory' && c.isTextBased());
  if (!channel) return null;
  const embed = new EmbedBuilder().setColor(BRAND.emerald).setTitle(app.project_name).setDescription(`<@${app.user_id}>`).addFields(
    { name: 'Website', value: app.website || 'Not provided' },
    { name: 'Project socials', value: app.social || 'Not provided' },
    { name: 'Founder socials + role', value: app.role_title || 'Not provided' },
    { name: 'Liquidity Studio interest', value: app.studio_interest || 'Not provided' },
  ).setFooter({ text: `Verified ${communityName()} Founder` });
  return channel.send({ embeds: [embed] });
}

function kreatorProfileReviewButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`kreator_profile_approve:${userId}`).setLabel('Approve KREATOR').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`kreator_profile_decline:${userId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  );
}
function kreatorProfileEmbed(userId, row) {
  return new EmbedBuilder().setColor(0xA855F7).setTitle('🎨 KREATOR Profile Review')
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: 'Primary', value: `${creatorProfilePlatform(row.primary_url) || 'Social'} · ${row.primary_url}\n**${Number(row.primary_followers).toLocaleString()}** followers/subscribers` },
      { name: 'Secondary', value: row.secondary_url ? `${creatorProfilePlatform(row.secondary_url) || 'Social'} · ${row.secondary_url}\n**${Number(row.secondary_followers).toLocaleString()}** followers/subscribers` : 'Not provided' },
      { name: 'Category', value: row.category || 'Not provided', inline: true },
      { name: 'Status', value: String(row.status).toUpperCase(), inline: true },
      { name: 'Leaderboard lane', value: 'KREATOR · excluded from Community Leaderboard', inline: false },
    ).setFooter({ text: '[LINKO-KREATOR-PROFILE]' }).setTimestamp(new Date(row.submitted_at));
}
async function saveKreatorProfileFromModal(interaction) {
  const primaryUrl = interaction.fields.getTextInputValue('primary_url').trim();
  const primaryFollowersRaw = interaction.fields.getTextInputValue('primary_followers').replace(/[,\s]/g, '');
  const secondaryUrl = interaction.fields.getTextInputValue('secondary_url').trim();
  const secondaryFollowersRaw = interaction.fields.getTextInputValue('secondary_followers').replace(/[,\s]/g, '');
  const category = interaction.fields.getTextInputValue('category').trim();
  const primaryFollowers = Number(primaryFollowersRaw);
  const secondaryFollowers = secondaryFollowersRaw ? Number(secondaryFollowersRaw) : 0;
  if (!creatorProfileUrlValid(primaryUrl)) return interaction.reply({ content: 'Primary social must be a valid X, YouTube, TikTok, Instagram, LinkedIn, or Telegram profile URL.', ephemeral: true });
  if (!Number.isSafeInteger(primaryFollowers) || primaryFollowers < 0) return interaction.reply({ content: 'Primary follower/subscriber count must be a whole number, for example **12500**.', ephemeral: true });
  if (secondaryUrl && !creatorProfileUrlValid(secondaryUrl)) return interaction.reply({ content: 'Secondary social must be a valid supported profile URL.', ephemeral: true });
  if (secondaryUrl && (!Number.isSafeInteger(secondaryFollowers) || secondaryFollowers < 0)) return interaction.reply({ content: 'Secondary follower/subscriber count must be a whole number.', ephemeral: true });

  const existing = kreatorProfile(interaction.user.id);
  const cooldownText = kreatorReapplyText(existing);
  if (cooldownText) return interaction.reply({ content: cooldownText, ephemeral: true });
  const keepApproved = existing?.status === 'approved' && hasKreatorRole(await interaction.guild.members.fetch(interaction.user.id));
  const status = keepApproved ? 'approved' : 'pending';
  db.prepare(`INSERT INTO kreator_profiles (user_id,primary_url,primary_followers,secondary_url,secondary_followers,category,status,submitted_at,reviewed_by,reviewed_at,review_message_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET primary_url=excluded.primary_url,primary_followers=excluded.primary_followers,secondary_url=excluded.secondary_url,secondary_followers=excluded.secondary_followers,category=excluded.category,status=excluded.status,submitted_at=excluded.submitted_at,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,review_message_id=excluded.review_message_id`)
    .run(interaction.user.id, primaryUrl, primaryFollowers, secondaryUrl || null, secondaryFollowers, category || null, status, now(), keepApproved ? existing.reviewed_by : null, keepApproved ? existing.reviewed_at : null, null);
  setParticipationLane(interaction.user.id, keepApproved ? 'kreator' : 'kreator_pending');
  const row = kreatorProfile(interaction.user.id);
  if (!keepApproved) {
    const review = interaction.guild.channels.cache.find((ch) => baseChannelName(ch.name) === baseChannelName(CHANNEL_NAMES.kreatorApplications) && ch.isTextBased());
    if (!review) return interaction.reply({ content: 'KREATOR profile saved, but the moderator review channel is missing. Please alert staff.', ephemeral: true });
    const msg = await review.send({ embeds: [kreatorProfileEmbed(interaction.user.id, row)], components: [kreatorProfileReviewButtons(interaction.user.id)] });
    db.prepare('UPDATE kreator_profiles SET review_message_id=? WHERE user_id=?').run(msg.id, interaction.user.id);
    scheduleModInboxUpdate(interaction.guild);
  }
  if (hasVerifiedRole(await interaction.guild.members.fetch(interaction.user.id))) {
    return interaction.reply({ content: keepApproved ? '✅ Your approved KREATOR profile was updated.' : '✅ KREATOR application submitted for staff review. While it is pending, your participation lane is KREATOR pending and you are excluded from the Community Leaderboard.', embeds: [kreatorProfileEmbed(interaction.user.id, kreatorProfile(interaction.user.id))], components: profileActionRows(await interaction.guild.members.fetch(interaction.user.id)), ephemeral: true });
  }
  return interaction.reply({ content: '✅ KREATOR profile submitted for staff review. You are now in the KREATOR lane and excluded from the Community Leaderboard.\n\n**Step 3 of 3 · Verify & enter the server**', components: [verificationButtonRow()], ephemeral: true });
}

async function handleSocialSubmission(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first in #verify.', ephemeral: true });

  const approvedKreator = hasKreatorRole(member) && kreatorProfileApproved(member.id);
  const platform = interaction.options.getString('platform', true);
  const url = interaction.options.getString('url', true).trim();
  const campaignId = interaction.options.getInteger('campaign');
  if (!platformUrlValid(platform, url)) return interaction.reply({ content: 'That URL does not match the selected platform or is not a valid HTTPS post URL.', ephemeral: true });

  let campaign = null;
  if (campaignId) {
    if (!approvedKreator) return interaction.reply({ content: 'Creator Campaigns are available only to approved **KREATORS**. Submit without a campaign to earn normal Community KXP.', ephemeral: true });
    campaign = creatorCampaignById(campaignId);
    if (!campaign || campaign.status !== 'active') return interaction.reply({ content: `Creator campaign #${campaignId} is not active or does not exist.`, ephemeral: true });
  }

  const lane = approvedKreator ? 'kreator' : 'community';
  try {
    const result = db.prepare('INSERT INTO social_submissions (user_id, url, platform, submitted_at, campaign_id, creator_eligible, submitter_lane) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(member.id, url, platform, now(), campaignId ?? null, approvedKreator ? 1 : 0, lane);
    const id = Number(result.lastInsertRowid);
    touchActivity(member.id, 'submission');

    const review = interaction.guild.channels.cache.find((ch) => baseChannelName(ch.name) === baseChannelName(CHANNEL_NAMES.socialSubmissions) && ch.isTextBased());
    if (!review) return interaction.reply({ content: 'Content review channel is missing. Ask staff to run /setup-linko.', ephemeral: true });

    const embed = new EmbedBuilder().setColor(BRAND.blue).setTitle(`${communityName()} social submission #${id}`).setDescription(`${member}\n${url}`).addFields(
      { name: 'Type', value: '📣 Social Post', inline: true },
      { name: 'Platform', value: platform.toUpperCase(), inline: true },
      { name: 'Lane', value: approvedKreator ? 'KREATOR' : 'COMMUNITY', inline: true },
      { name: 'Destination', value: '#published-kontents', inline: true },
      { name: 'Status', value: 'Pending', inline: true },
      ...(campaign ? [{ name: 'Campaign', value: `#${campaign.id} · ${campaign.name}`, inline: false }] : []),
    ).setTimestamp();

    const configuredAward = getSettingInt('kxp_social_post');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`social_approve:${id}`).setLabel(`Approve +${configuredAward} ${xpLabel()} & Publish`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`social_reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    );
    const msg = await review.send({ embeds: [embed], components: [row] });
    db.prepare('UPDATE social_submissions SET review_message_id = ? WHERE id = ?').run(msg.id, id);
    scheduleModInboxUpdate(interaction.guild);
    return interaction.reply({ content: `✅ Social post submitted for review as **${approvedKreator ? 'KREATOR' : 'Community Member'}**.${campaign ? ` Campaign: **#${campaign.id} · ${campaign.name}**.` : ''} If approved, LINKO publishes it in **#published-kontents**.`, ephemeral: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return interaction.reply({ content: 'That post URL has already been submitted.', ephemeral: true });
    throw err;
  }
}

function signalSectionLabel(section) {
  return ({
    'analyst-chat': '🧠 Analyst Chat',
    'trade-analysis': '📉 Trade Analysis',
    'market-thesis': '🌐 Market Thesis',
    'ai-strategies': '🤖 AI Strategies',
  })[section] ?? section;
}
function validHttpsUrl(raw) {
  if (!raw) return true;
  try { return new URL(raw).protocol === 'https:'; } catch { return false; }
}
async function handleSignalSubmission(interaction) {
  if (!moduleEnabled('signal_room')) return interaction.reply({ content: 'Signal Room is disabled in this server.', ephemeral: true });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first in #verify.', ephemeral: true });

  const section = interaction.options.getString('section', true);
  if (!SIGNAL_CHANNELS.has(section)) return interaction.reply({ content: 'Choose a valid Signal Room section.', ephemeral: true });
  const title = interaction.options.getString('title', true).trim();
  const body = interaction.options.getString('content', true).trim();
  const sourceUrl = interaction.options.getString('source')?.trim() || null;
  if (title.length < 3 || body.length < 20) return interaction.reply({ content: 'Signal submissions need a clear title and at least 20 characters of original content.', ephemeral: true });
  if (sourceUrl && !validHttpsUrl(sourceUrl)) return interaction.reply({ content: 'The optional source must be a valid **https://** URL.', ephemeral: true });

  const result = db.prepare('INSERT INTO signal_submissions (user_id, section, title, body, source_url, submitted_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(member.id, section, title, body, sourceUrl, now());
  const id = Number(result.lastInsertRowid);
  touchActivity(member.id, 'submission');

  const review = interaction.guild.channels.cache.find((ch) => baseChannelName(ch.name) === baseChannelName(CHANNEL_NAMES.socialSubmissions) && ch.isTextBased());
  if (!review) return interaction.reply({ content: 'Content review channel is missing. Ask staff to run /setup-linko.', ephemeral: true });

  const lane = hasKreatorRole(member) && kreatorProfileApproved(member.id) ? 'KREATOR' : participationLane(member) === 'kreator_pending' ? 'KREATOR · PENDING' : 'COMMUNITY';
  const embed = new EmbedBuilder().setColor(BRAND.cyan).setTitle(`${communityName()} Signal submission #${id}`)
    .setDescription(`**${title}**\n\n${body.slice(0, 3800)}`)
    .addFields(
      { name: 'Type', value: '📈 Signal Room', inline: true },
      { name: 'Destination', value: signalSectionLabel(section), inline: true },
      { name: 'Submitted by', value: `${member} · ${lane}`, inline: false },
      ...(sourceUrl ? [{ name: 'Source', value: sourceUrl, inline: false }] : []),
      { name: 'Status', value: 'Pending', inline: true },
    ).setTimestamp();
  const award = Math.max(0, getSettingInt('kxp_message'));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`signal_approve:${id}`).setLabel(`Approve & Publish${award ? ` +${award} ${xpLabel()}` : ''}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`signal_reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
  const msg = await review.send({ embeds: [embed], components: [row] });
  db.prepare('UPDATE signal_submissions SET review_message_id=? WHERE id=?').run(msg.id, id);
  scheduleModInboxUpdate(interaction.guild);
  return interaction.reply({ content: `✅ Signal content submitted for review. Destination: **${signalSectionLabel(section)}**. If approved, LINKO publishes it there and credits you.`, ephemeral: true });
}

async function publishApprovedSocialSubmission(guild, sub, { backfill = false } = {}) {
  const feed = guild.channels.cache.find((ch) =>
    ch.isTextBased() && baseChannelName(ch.name) === baseChannelName(CHANNEL_NAMES.sharePost)
  );
  if (!feed) return null;

  if (sub.share_message_id) {
    const existing = await feed.messages.fetch(sub.share_message_id).catch(() => null);
    if (existing) return existing;
  }

  const creatorSubmission = Number(sub.creator_eligible) === 1;
  const campaign = creatorSubmission && sub.campaign_id ? creatorCampaignById(Number(sub.campaign_id)) : null;
  const label = xpLabel();
  const reactionLine = creatorSubmission
    ? `\n🏅 **KREATOR:** every **${getSettingInt('creator_reaction_threshold')} unique verified reactions** adds **+${getSettingInt('creator_reaction_kxp')} ${label}**, up to ${getSettingInt('creator_reaction_cap')} milestones.`
    : '';
  const campaignLine = campaign ? `\n🏁 **Campaign #${campaign.id}: ${campaign.name}**` : '';
  const laneLine = creatorSubmission ? '🎨 **Lane:** KREATOR' : '👥 **Lane:** Community Member';
  const restoredLine = backfill ? '\n🗂️ **Restored from an earlier approved submission.**' : '';
  const awarded = Number(sub.xp_awarded ?? 0);

  const posted = await feed.send({
    content: `**📣 ${communityName()} Kontent Published**\n<@${sub.user_id}> · **+${awarded} ${label}**\n${laneLine}${campaignLine}${reactionLine}${restoredLine}\n${sub.url}`,
    allowedMentions: { parse: [], users: [sub.user_id] },
  });
  db.prepare('UPDATE social_submissions SET share_message_id = ? WHERE id = ?').run(posted.id, sub.id);
  return posted;
}

async function backfillApprovedSocialPosts(guild) {
  if (getSetting('v10_20_1_published_backfill_done') === '1') return;
  const feed = guild.channels.cache.find((ch) =>
    ch.isTextBased() && baseChannelName(ch.name) === baseChannelName(CHANNEL_NAMES.sharePost)
  );
  if (!feed) return;

  const rows = db.prepare("SELECT * FROM social_submissions WHERE status='approved' ORDER BY reviewed_at ASC, id ASC").all();
  let restored = 0;
  for (const sub of rows) {
    let visible = false;
    if (sub.share_message_id) {
      visible = !!(await feed.messages.fetch(sub.share_message_id).catch(() => null));
    }
    if (visible) continue;
    const posted = await publishApprovedSocialSubmission(guild, sub, { backfill: true }).catch((error) => {
      logLinkoError(`v10.20.1:backfill-social:${sub.id}`, error);
      return null;
    });
    if (posted) restored++;
  }
  setSetting('v10_20_1_published_backfill_done', '1');
  console.log(`LINKO v10.20.1 Published Kontents backfill complete · restored ${restored} approved post(s).`);
}

async function handleSocialReview(interaction, id, approved) {
  const xp = approved ? getSettingInt('kxp_social_post') : 0;
  const label = xpLabel();
  if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const sub = db.prepare('SELECT * FROM social_submissions WHERE id = ?').get(id);
  if (!sub || sub.status !== 'pending') return interaction.reply({ content: 'This submission has already been reviewed or does not exist.', ephemeral: true });

  const member = await interaction.guild.members.fetch(sub.user_id).catch(() => null);
  if (!member || !hasVerifiedRole(member)) return interaction.reply({ content: 'Cannot approve because the submitter is no longer a verified member.', ephemeral: true });

  const creatorSubmission = Number(sub.creator_eligible) === 1;
  if (creatorSubmission && !(hasKreatorRole(member) && kreatorProfileApproved(member.id))) {
    return interaction.reply({ content: 'Cannot approve this as a KREATOR post because the submitter is no longer an approved KREATOR.', ephemeral: true });
  }

  if (xp > 0) {
    const daily = getDaily(sub.user_id);
    if (Number(daily.social_count) >= 2) return interaction.reply({ content: 'This member already has 2 rewarded social posts today. Reject or review tomorrow.', ephemeral: true });
    db.prepare('UPDATE daily_xp SET social_count = social_count + 1 WHERE user_id = ? AND day = ?').run(sub.user_id, dayKey());
    await addXp(interaction.guild, sub.user_id, xp, `Approved ${communityName()} social contribution #${id}`, interaction.user.id);
    db.prepare('UPDATE social_submissions SET status = ?, reviewed_by = ?, reviewed_at = ?, xp_awarded = ? WHERE id = ?').run('approved', interaction.user.id, now(), xp, id);

    await publishApprovedSocialSubmission(interaction.guild, { ...sub, xp_awarded: xp }).catch((error) => logLinkoError(`social-publish:${id}`, error));
  } else {
    db.prepare('UPDATE social_submissions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run('rejected', interaction.user.id, now(), id);
  }

  const embed = EmbedBuilder.from(interaction.message.embeds[0]).setColor(xp > 0 ? BRAND.emerald : BRAND.rose).setFields(
    { name: 'Platform', value: sub.platform.toUpperCase(), inline: true },
    { name: 'Lane', value: Number(sub.creator_eligible) ? 'KREATOR' : 'COMMUNITY', inline: true },
    { name: 'Status', value: xp > 0 ? `Approved · +${xp} ${label} · Published` : 'Rejected', inline: true },
    ...(sub.campaign_id ? [{ name: 'Campaign', value: `#${sub.campaign_id}`, inline: true }] : []),
  ).setFooter({ text: `${xp > 0 ? 'Approved' : 'Rejected'} by ${interaction.user.tag}` });
  await interaction.update({ embeds: [embed], components: [] });
  scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild); scheduleLeaderboardUpdate(interaction.guild);
}

async function handleSignalReview(interaction, id, approved) {
  if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const sub = db.prepare('SELECT * FROM signal_submissions WHERE id=?').get(id);
  if (!sub || sub.status !== 'pending') return interaction.reply({ content: 'This Signal submission has already been reviewed or does not exist.', ephemeral: true });

  let xp = 0;
  if (approved) {
    const target = interaction.guild.channels.cache.find((ch) => ch.isTextBased() && baseChannelName(ch.name) === sub.section);
    if (!target) return interaction.reply({ content: `Cannot publish because **${signalSectionLabel(sub.section)}** is missing. Run /setup-linko or enable Signal Room first.`, ephemeral: true });

    const member = await interaction.guild.members.fetch(sub.user_id).catch(() => null);
    if (!member || !hasVerifiedRole(member)) return interaction.reply({ content: 'Cannot approve because the submitter is no longer a verified member.', ephemeral: true });

    const configured = Math.max(0, getSettingInt('kxp_message'));
    const daily = getDaily(sub.user_id);
    const remaining = Math.max(0, getSettingInt('message_daily_cap') - Number(daily.message_xp));
    xp = Math.min(configured, remaining);
    if (xp > 0) {
      db.prepare('UPDATE daily_xp SET message_xp = message_xp + ? WHERE user_id = ? AND day = ?').run(xp, sub.user_id, dayKey());
      await addXp(interaction.guild, sub.user_id, xp, `Approved Signal Room content #${id} → ${sub.section}`, interaction.user.id);
    }

    const embed = new EmbedBuilder().setColor(BRAND.cyan).setTitle(sub.title)
      .setDescription(sub.body.slice(0, 4000))
      .addFields(
        { name: 'Contributor', value: `<@${sub.user_id}>`, inline: true },
        { name: 'Reviewed by', value: `<@${interaction.user.id}>`, inline: true },
        ...(sub.source_url ? [{ name: 'Source / context', value: sub.source_url.slice(0, 1024), inline: false }] : []),
      ).setFooter({ text: `LINKO approved Signal submission #${id}` }).setTimestamp();
    const posted = await target.send({ embeds: [embed], allowedMentions: { parse: [], users: [sub.user_id, interaction.user.id] } });
    db.prepare('UPDATE signal_submissions SET status=?,reviewed_by=?,reviewed_at=?,xp_awarded=?,published_message_id=? WHERE id=?')
      .run('approved', interaction.user.id, now(), xp, posted.id, id);
  } else {
    db.prepare('UPDATE signal_submissions SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?').run('rejected', interaction.user.id, now(), id);
  }

  const updated = EmbedBuilder.from(interaction.message.embeds[0]).setColor(approved ? BRAND.emerald : BRAND.rose).setFields(
    { name: 'Type', value: '📈 Signal Room', inline: true },
    { name: 'Destination', value: signalSectionLabel(sub.section), inline: true },
    { name: 'Status', value: approved ? `Approved · Published${xp ? ` · +${xp} ${xpLabel()}` : ''}` : 'Rejected', inline: true },
  ).setFooter({ text: `${approved ? 'Approved' : 'Rejected'} by ${interaction.user.tag}` });
  await interaction.update({ embeds: [updated], components: [] });
  scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild); scheduleLeaderboardUpdate(interaction.guild);
}

function creatorEmojiKey(reaction) {
  return reaction.emoji.id ? `${reaction.emoji.name ?? 'emoji'}:${reaction.emoji.id}` : String(reaction.emoji.name ?? 'emoji');
}

async function reconcileCreatorReactionRewards(guild, submissionId) {
  if (!moduleEnabled('kreator')) return;
  const sub = db.prepare('SELECT * FROM social_submissions WHERE id = ?').get(submissionId);
  if (!sub || sub.status !== 'approved' || !Number(sub.creator_eligible)) return;
  const creator = await guild.members.fetch(sub.user_id).catch(() => null);
  if (!creator || !hasKreatorRole(creator)) return;
  if (sub.campaign_id) {
    const campaign = creatorCampaignById(Number(sub.campaign_id));
    if (!campaign || campaign.status !== 'active') return;
  }
  const threshold = Math.max(1, getSettingInt('creator_reaction_threshold'));
  const cap = Math.max(0, getSettingInt('creator_reaction_cap'));
  const perMilestone = Math.max(0, getSettingInt('creator_reaction_kxp'));
  const count = creatorReactionCount(submissionId);
  const targetMilestones = Math.min(cap, Math.floor(count / threshold));
  const currentMilestones = Number(sub.reaction_milestones_awarded ?? 0);
  if (targetMilestones <= currentMilestones || !perMilestone) return;
  const deltaMilestones = targetMilestones - currentMilestones;
  const deltaXp = deltaMilestones * perMilestone;
  await addXp(guild, sub.user_id, deltaXp, `Creator reaction reward #${submissionId}: ${count} unique verified reactions`);
  db.prepare('UPDATE social_submissions SET reaction_milestones_awarded = ?, reaction_xp_awarded = COALESCE(reaction_xp_awarded, 0) + ? WHERE id = ?').run(targetMilestones, deltaXp, submissionId);
  scheduleLeaderboardUpdate(guild);
}

async function handleCreatorPostReaction(reaction, user, added) {
  if (user.bot) return;
  const guild = reaction.message.guild;
  if (!guild || !isAllowedGuild(guild.id)) return;
  const sub = db.prepare('SELECT * FROM social_submissions WHERE share_message_id = ? AND status = ?').get(reaction.message.id, 'approved');
  if (!sub) return;
  if (user.id === sub.user_id) return;
  const emojiKey = creatorEmojiKey(reaction);
  if (added) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member || member.user.bot || !hasVerifiedRole(member)) return;
    db.prepare('INSERT OR IGNORE INTO creator_post_reactions (submission_id, user_id, emoji_key, created_at) VALUES (?, ?, ?, ?)').run(sub.id, user.id, emojiKey, now());
  } else {
    db.prepare('DELETE FROM creator_post_reactions WHERE submission_id = ? AND user_id = ? AND emoji_key = ?').run(sub.id, user.id, emojiKey);
  }
  await reconcileCreatorReactionRewards(guild, sub.id);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guildId of GUILD_IDS) {
    try {
      await runWithGuild(guildId, async () => {
        const guild = await client.guilds.fetch(guildId);
        const fullGuild = await guild.fetch();
        getGuildDb(fullGuild.id);
        if (!String(getSetting('community_name') ?? '').trim()) {
          setSetting('community_name', fullGuild.name);
          if (fullGuild.name.trim().toLowerCase() === 'klineo') {
            applyServerPreset('klineo');
            setSetting('xp_label', 'KXP');
          } else {
            applyServerPreset('community');
            setSetting('xp_label', 'XP');
          }
        }
        migrateLegacyKlineoDatabase(fullGuild.id, fullGuild.name);
        seedKlineOProjectProfile(fullGuild);
        await fullGuild.commands.set(commands);
        await fullGuild.members.fetch({ withPresences: true }).catch(() => fullGuild.members.fetch());
        for (const m of fullGuild.members.cache.values()) {
          if (m.user.bot) continue;
          ensureUserRow(m.id, m.joinedTimestamp ?? null);
          if (hasKreatorRole(m)) setParticipationLane(m.id, 'kreator');
        }
        await reconcileVoiceSessions(fullGuild);
        await cacheInvites(fullGuild);
        await syncAnnouncementChannelPermissions(fullGuild).catch((error) => logLinkoError('announcement-permissions', error));
        await syncEventsChannelVisibility(fullGuild).catch((error) => logLinkoError('events-channel-visibility', error));
        await backfillNativeScheduledEvents(fullGuild).catch((error) => logLinkoError('native-events-backfill', error));
        await backfillRecentActivity(fullGuild, getSettingInt('health_window_days') || 7).catch((error) => logLinkoError('activity-backfill', error));
        await syncAllRankRoles(fullGuild).catch((error) => logLinkoError('rank-resync', error));
        await awardDailyBoosterXp(fullGuild).catch((error) => logLinkoError('booster-kxp', error));
        await updatePublicKxpDocs(fullGuild).catch((error) => logLinkoError('kxp-docs', error));
        await migrateLegacyLanguageSpacesToCommunityDemand(fullGuild);
        ensureCatalogFromExistingLanguageRoles();
        for (const entry of languageCatalog()) await ensureLanguageDemandReview(fullGuild, entry.key).catch((error) => logLinkoError(`community-demand:${entry.key}`, error));
        await ensureMemberProfileLauncher(fullGuild).catch((error) => logLinkoError('member-profile-launcher', error));
        await syncV1019DiscordStructure(fullGuild).catch((error) => logLinkoError('v10.19-structure-sync', error));
        await syncCanonicalGeneralAndAuditDuplicates(fullGuild).catch((error) => logLinkoError('v10.19.1-channel-dedup', error));
        await syncV1020ContentStructure(fullGuild).catch((error) => logLinkoError('v10.20-content-structure', error));
        await backfillApprovedSocialPosts(fullGuild).catch((error) => logLinkoError('v10.20.1-published-backfill', error));
        if (projectProfileComplete()) await refreshBrandMessages(fullGuild).catch((error) => logLinkoError('project-profile-brand-refresh', error));
        console.log(`Registered LINKO commands in ${fullGuild.name} (${fullGuild.id}) · XP label: ${xpLabel()}`);
        console.log('LINKO v10.20.1 active: one /submit-content command, approved social backfill, Published Kontents delivery verified.');

        const recurring = (fn) => () => runWithGuild(fullGuild.id, () => fn(fullGuild).catch(console.error));
        setInterval(recurring(checkPendingReferrals), 60 * 60 * 1000);
        setInterval(recurring(awardDailyBoosterXp), 60 * 60 * 1000);
        setInterval(recurring(processVoiceEventMinute), 60 * 1000);
        setInterval(() => runWithGuild(fullGuild.id, () => updateServerStats(fullGuild, false).catch(console.error)), 5 * 60 * 1000);
        setInterval(() => runWithGuild(fullGuild.id, () => updateAllLeaderboards(fullGuild).catch(console.error)), 5 * 60 * 1000);
        setInterval(recurring(evaluateImpactCandidates), 60 * 1000);
        setInterval(recurring(processCommunityEvents), 60 * 1000);
        setInterval(
          () => runWithGuild(fullGuild.id, () => updateCommunityHealthDashboard(fullGuild).catch(console.error)),
          Math.max(1, getSettingInt('health_auto_refresh_hours') || 12) * 60 * 60 * 1000
        );
        setInterval(() => runWithGuild(fullGuild.id, () => updateModInbox(fullGuild).catch(console.error)), 5 * 60 * 1000);

        setTimeout(recurring(checkPendingReferrals), 15000);
        setTimeout(() => runWithGuild(fullGuild.id, () => updateAllLeaderboards(fullGuild).catch(console.error)), 20000);
        setTimeout(() => runWithGuild(fullGuild.id, () => updateCommunityHealthDashboard(fullGuild).catch(console.error)), 25000);
        setTimeout(() => runWithGuild(fullGuild.id, () => updateModInbox(fullGuild).catch(console.error)), 30000);
        setTimeout(recurring(processCommunityEvents), 35000);
      });
    } catch (error) {
      console.error(`Startup failed for guild ${guildId}:`, error);
    }
  }
});

client.on('guildScheduledEventUpdate', async (_oldEvent, nativeEvent) => {
  if (!nativeEvent?.guild || !isAllowedGuild(nativeEvent.guild.id)) return;
  return runWithGuild(nativeEvent.guild.id, async () => {
    const row = db.prepare('SELECT * FROM community_events WHERE native_scheduled_event_id=?').get(nativeEvent.id);
    if (!row) return;
    if (nativeEvent.status === GuildScheduledEventStatus.Active && row.status === 'planned') {
      if (row.voice_channel_id) {
        const channel = nativeEvent.guild.channels.cache.get(row.voice_channel_id);
        if (channel) {
          await applyCommunityEventAccess(nativeEvent.guild, row).catch((error) => logLinkoError('native-event-access', error));
          const active = getActiveVoiceEvent();
          if (!active) await startVoiceEvent(nativeEvent.guild, channel, row.title, nativeEvent.creatorId || client.user.id).catch((error) => logLinkoError('native-event-voice-start', error));
        }
      }
      db.prepare('UPDATE community_events SET status=?, started_at=? WHERE id=?').run('live', now(), row.id);
      await updateEventMessage(nativeEvent.guild, row.id);
      scheduleModInboxUpdate(nativeEvent.guild); scheduleHealthUpdate(nativeEvent.guild);
      return;
    }
    if (nativeEvent.status === GuildScheduledEventStatus.Completed && ['planned','live'].includes(row.status)) {
      await endCommunityEvent(nativeEvent.guild, row.id, null, false);
      return;
    }
    if (nativeEvent.status === GuildScheduledEventStatus.Canceled && ['planned','live'].includes(row.status)) {
      const active = getActiveVoiceEvent();
      if (active && row.voice_channel_id && active.channel_id === row.voice_channel_id) await stopVoiceEvent().catch(() => {});
      await restoreCommunityEventAccess(nativeEvent.guild, row).catch((error) => logLinkoError('native-event-permission-restore', error));
      db.prepare('UPDATE community_events SET status=?, ended_at=? WHERE id=?').run('cancelled', now(), row.id);
      await updateEventMessage(nativeEvent.guild, row.id);
      scheduleModInboxUpdate(nativeEvent.guild); scheduleHealthUpdate(nativeEvent.guild);
    }
  });
});
client.on('guildMemberAdd', async (member) => {
  if (!isAllowedGuild(member.guild.id) || member.user.bot) return;
  return runWithGuild(member.guild.id, async () => {
  ensureUserRow(member.id, member.joinedTimestamp ?? now());
  const used = await detectUsedInvite(member.guild);
  let attributed = false;
  if (used) {
    const mapped = db.prepare('SELECT inviter_id FROM invite_codes WHERE code = ?').get(used.code);
    const inviterId = mapped?.inviter_id ?? used.inviterId;
    if (inviterId && inviterId !== member.id) {
      db.prepare('INSERT OR REPLACE INTO referrals (member_id, inviter_id, invite_code, joined_at) VALUES (?, ?, ?, ?)').run(member.id, inviterId, used.code, now());
      upsertJoinAttribution(member.id, { source: null, inviterId, detectedInviterId: inviterId, sourceConfirmed: 0, inviterConfirmed: 1 });
      attributed = true;
      const log = member.guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
      if (log) await log.send(`🧭 **Pending referral detected** — <@${inviterId}> → ${member}. Source: ${mapped ? 'LINKO tracked invite' : 'standard Discord invite'}. It becomes valid only after verification + 7 days + community activity.`).catch(() => {});
      const inviterMember = await member.guild.members.fetch(inviterId).catch(() => null);
      if (inviterMember) await inviterMember.send(`🤝 LINKO detected a **pending ${communityName()} referral** for ${member.user.username}. No referral ${xpLabel()} is awarded yet. It becomes valid after they verify, remain in the server for 7 days, and show community activity.`).catch(() => {});
    }
  }
  if (!attributed) {
    db.prepare('INSERT OR REPLACE INTO unattributed_joins (user_id, joined_at, resolved) VALUES (?, ?, 0)').run(member.id, member.joinedTimestamp ?? now());
    upsertJoinAttribution(member.id, { source: null, inviterId: null, detectedInviterId: null, sourceConfirmed: 0, inviterConfirmed: 0 });
    const inbox = member.guild.channels.cache.find((c) => baseChannelName(c.name) === 'mod-inbox' && c.isTextBased());
    const log = member.guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
    const note = `🧭 **Unattributed join** — ${member}. Discord did not expose a unique inviter. LINKO cannot safely guess who invited them. The member must run \`/join-source\` before verification. If a member invited them, they select that member; staff can still use \`/confirm-referral\` for genuine exceptions.`;
    if (inbox) await inbox.send(note).catch(() => {});
    else if (log) await log.send(note).catch(() => {});
    await member.send(`LINKO could not automatically identify your join source. Before you can verify, run **/join-source** in the ${communityName()} server. If a community member invited you, select them there. Referral credit becomes valid only after the inviter confirms, you verify, remain in the server for 7 days, and stay active across the qualification period.`).catch(() => {});
  }
  await sendWelcomeDm(member);
  scheduleStatsUpdate(member.guild); scheduleHealthUpdate(member.guild); scheduleModInboxUpdate(member.guild);
  });
});
client.on('guildMemberUpdate', (oldMember, newMember) => {
  if (!isAllowedGuild(newMember.guild.id) || newMember.user.bot) return;
  const wasBoosting = !!oldMember.premiumSinceTimestamp;
  const isBoosting = !!newMember.premiumSinceTimestamp;
  if (wasBoosting === isBoosting) return;
  return runWithGuild(newMember.guild.id, async () => {
    if (!isBoosting) db.prepare('DELETE FROM booster_overrides WHERE user_id = ?').run(newMember.id);
    await awardDailyBoosterXp(newMember.guild).catch(console.error);
  });
});

client.on('guildMemberRemove', (member) => {
  if (!isAllowedGuild(member.guild.id)) return;
  return runWithGuild(member.guild.id, () => {
    scheduleStatsUpdate(member.guild); scheduleHealthUpdate(member.guild); scheduleModInboxUpdate(member.guild);
  });
});
client.on('presenceUpdate', (_oldPresence, newPresence) => {
  if (!isAllowedGuild(newPresence?.guild?.id)) return;
  return runWithGuild(newPresence.guild.id, () => scheduleStatsUpdate(newPresence.guild));
});
client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = newState?.guild ?? oldState?.guild;
  const member = newState?.member ?? oldState?.member;
  if (!guild || !isAllowedGuild(guild.id) || !member || member.user?.bot) return;
  return runWithGuild(guild.id, async () => {
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId !== newChannelId) {
      if (oldChannelId) closeOpenVoiceSession(member.id, oldChannelId, now());
      if (newChannelId) {
        openVoiceSession(member.id, newChannelId, now());
        touchActivity(member.id, 'voice');
      }
      scheduleHealthUpdate(guild);
    }

    const active = getActiveVoiceEvent();
    if (!active || String(active.channel_id) !== String(newChannelId ?? oldChannelId ?? '')) return;
    const channel = guild.channels.cache.get(active.channel_id);
    if (!channel || channel.type !== ChannelType.GuildStageVoice) return;

    const oldRaised = Number(oldState.requestToSpeakTimestamp ?? 0);
    const newRaised = Number(newState.requestToSpeakTimestamp ?? 0);
    if (newRaised > 0 && newRaised !== oldRaised) noteStageHandRaise(active.id, member.id, newRaised);

    const promotedToSpeaker = oldState.suppress === true && newState.suppress === false && newChannelId === active.channel_id;
    if (promotedToSpeaker) noteStageSpeakerStarted(active.id, member.id, now());
  });
});
client.on('inviteCreate', (invite) => {
  if (!isAllowedGuild(invite.guild?.id)) return;
  inviteCacheForGuild(invite.guild.id).set(invite.code, invite.uses ?? 0);
});
client.on('inviteDelete', (invite) => {
  if (!isAllowedGuild(invite.guild?.id)) return;
  inviteCacheForGuild(invite.guild.id).delete(invite.code);
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (!reaction.message.guild || !isAllowedGuild(reaction.message.guild.id)) return;
    await runWithGuild(reaction.message.guild.id, async () => {
      touchActivity(user.id, 'reaction');
      await recordImpactEngagement(reaction.message.id, user.id, 'reaction');
      await handleCreatorPostReaction(reaction, user, true);
    });
  } catch (error) { logLinkoError('messageReactionAdd', error); }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (!reaction.message.guild || !isAllowedGuild(reaction.message.guild.id)) return;
    await runWithGuild(reaction.message.guild.id, () => handleCreatorPostReaction(reaction, user, false));
  } catch (error) { logLinkoError('messageReactionRemove', error); }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || !isAllowedGuild(message.guild.id) || message.author.bot || !message.member) return;
  return runWithGuild(message.guild.id, async () => {
  const channelName = message.channel.name;
  const channelBase = baseChannelName(channelName);
  if (channelBase === 'bot-commands' && !hasStaffRole(message.member)) {
    await message.delete().catch(() => {});
    await message.author.send('Use slash commands in **#bot-commands** (for example `/rank`, `/points`, `/leaderboard`, `/invite`, `/invites`, `/wallet`). Plain chat is removed to keep the command channel clean.').catch(() => {});
    return;
  }
  const isPublicBlocked = PUBLIC_NO_LINK_CHANNELS.has(channelBase);
  const isSignal = SIGNAL_CHANNELS.has(channelBase);
  const managed = managedChannelRow(message.channel.id);
  if (channelBase === 'introductions' && hasVerifiedRole(message.member)) {
    ensureUserRow(message.author.id, message.member.joinedTimestamp ?? null);
    db.prepare('UPDATE member_activation SET introduced_at = COALESCE(introduced_at, ?) WHERE user_id = ?').run(now(), message.author.id);
    scheduleHealthUpdate(message.guild);
  }
  if (containsLink(message.content)) {
    const managedBlocked = managed && !Number(managed.links_allowed);
    const shouldDelete = (isPublicBlocked && !hasStaffRole(message.member)) || (isSignal && !canShareSignalLinks(message.member)) || (managedBlocked && !hasStaffRole(message.member));
    if (shouldDelete) {
      await message.delete().catch(() => {});
      const note = isSignal ? 'Links in Signal Room unlock at **STRATEGIST**.' : `Links are not permitted in public ${communityName()} community channels.`;
      const socialHint = moduleEnabled('kreator') ? `\nUse **/submit-content social** for ${communityName()} social content.` : '';
      await message.author.send(`Your message in **#${channelName}** was removed. ${note}${socialHint}`).catch(() => {});
      return;
    }
  }
  touchActivity(message.author.id, 'message', message.createdTimestamp ?? now());
  const customKxp = managed && Number(managed.kxp_enabled) === 1;
  if ((!MESSAGE_XP_CHANNELS.has(channelBase) && !customKxp) || !hasVerifiedRole(message.member)) return;
  ensureUserRow(message.author.id, message.member.joinedTimestamp ?? null);

  // Replies can strengthen the impact score of the message they answer.
  if (message.reference?.messageId && message.reference?.guildId === message.guild.id) {
    const replyAnalysis = analyzeImpactMessage(message.content);
    if (replyAnalysis.qualifiesAsCandidate) await recordImpactEngagement(message.reference.messageId, message.author.id, 'reply');
  }

  // Candidate text is evaluated transiently. The database stores only scores/metadata/fingerprint, never the message body.
  await ensureCandidateFromMessage(message);
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.inGuild() || !isAllowedGuild(interaction.guildId)) return;
  return runWithGuild(interaction.guildId, async () => {
  try {
    if (!interaction.user?.bot) touchActivity(interaction.user.id, interaction.isChatInputCommand() ? 'command' : 'onboarding');
    if (interaction.isButton()) {
      if (interaction.customId === 'klineo_verify' || interaction.customId === 'linko_onboarding_start') return showOnboardingEntry(interaction);
      if (interaction.customId === 'linko_onboarding_verify') return verifyMember(interaction);
      if (interaction.customId === 'linko_profile_open') return showMemberProfile(interaction);
      if (interaction.customId === 'linko_profile_refresh') return showMemberProfile(interaction, 'update');
      if (interaction.customId === 'linko_profile_kreator_apply') {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction);
        const profile = kreatorProfile(member.id);
        if (profile?.status === 'pending' || participationLane(member) === 'kreator_pending') {
          return interaction.reply({ content: 'Your KREATOR application is already pending staff review.', ephemeral: true });
        }
        return showKreatorProfileModal(interaction);
      }
      if (interaction.customId === 'linko_profile_socials') return showProfileSocialsModal(interaction);
      if (interaction.customId === 'linko_profile_interests') return showProfileInterestsSelect(interaction);
      if (interaction.customId === 'linko_profile_languages') return showProfileLanguagesSelect(interaction);
      if (interaction.customId === 'linko_language_request') return showLanguageRequestModal(interaction);
      if (interaction.customId.startsWith('kreator_profile_approve:') || interaction.customId.startsWith('kreator_profile_decline:')) {
        if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const [action, userId] = interaction.customId.split(':');
        const profile = kreatorProfile(userId);
        if (!profile || profile.status !== 'pending') return interaction.reply({ content: 'This KREATOR profile has already been reviewed or no longer exists.', ephemeral: true });
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) return interaction.reply({ content: 'That member is no longer in this server.', ephemeral: true });
        if (action === 'kreator_profile_decline') {
          db.prepare("UPDATE kreator_profiles SET status='declined',reviewed_by=?,reviewed_at=? WHERE user_id=?").run(interaction.user.id, now(), userId);
          setParticipationLane(userId, 'community');
          const kreatorRole = interaction.guild.roles.cache.find((r) => r.name === 'KREATOR');
          if (kreatorRole && member.roles.cache.has(kreatorRole.id)) await member.roles.remove(kreatorRole, 'KREATOR profile declined').catch(() => {});
          await member.send(`Your ${communityName()} KREATOR profile was not approved at this time. You are now in the Community Member leaderboard lane.`).catch(() => {});
          scheduleLeaderboardUpdate(interaction.guild); scheduleModInboxUpdate(interaction.guild);
          return interaction.update({ embeds: [kreatorProfileEmbed(userId, kreatorProfile(userId))], components: [] });
        }
        const kreatorRole = interaction.guild.roles.cache.find((r) => r.name === 'KREATOR');
        if (!kreatorRole) return interaction.reply({ content: 'KREATOR role is missing. Run /setup-linko first.', ephemeral: true });
        db.prepare("UPDATE kreator_profiles SET status='approved',reviewed_by=?,reviewed_at=? WHERE user_id=?").run(interaction.user.id, now(), userId);
        setParticipationLane(userId, 'kreator');
        if (hasVerifiedRole(member)) {
          await member.roles.add(kreatorRole, `KREATOR profile approved by ${interaction.user.tag}`);
          await maybeAwardReferralRoleBonus(interaction.guild, userId, 'KREATOR');
        }
        await member.send(hasVerifiedRole(member)
          ? `✅ Your ${communityName()} KREATOR profile was approved. You are now eligible for the KREATOR Leaderboard and creator post submissions. You will not appear on the Community Leaderboard.`
          : `✅ Your ${communityName()} KREATOR profile was approved. Complete verification to activate the KREATOR role and creator access.`).catch(() => {});
        scheduleLeaderboardUpdate(interaction.guild); scheduleModInboxUpdate(interaction.guild);
        return interaction.update({ embeds: [kreatorProfileEmbed(userId, kreatorProfile(userId))], components: [] });
      }
      if (interaction.customId.startsWith('language_request_approve:') || interaction.customId.startsWith('language_request_decline:')) {
        if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const [action, rawId] = interaction.customId.split(':');
        const id = Number(rawId);
        const request = db.prepare('SELECT * FROM language_requests WHERE id=?').get(id);
        if (!request || request.status !== 'pending') return interaction.reply({ content: 'This catalog request has already been reviewed or no longer exists.', ephemeral: true });
        const supporters = db.prepare('SELECT user_id FROM language_request_supporters WHERE request_id=?').all(id);
        const supporterIds = supporters.length ? supporters.map((r) => r.user_id) : [request.user_id];
        if (action === 'language_request_decline') {
          db.prepare("UPDATE language_requests SET status='declined', reviewed_at=?, reviewed_by=? WHERE id=?").run(now(), interaction.user.id, id);
          const updated = db.prepare('SELECT * FROM language_requests WHERE id=?').get(id);
          for (const userId of supporterIds) {
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            if (member) await member.send(`🌍 The request to add **${request.language_name}** to the ${communityName()} language catalog was not approved at this time.`).catch(() => {});
          }
          scheduleModInboxUpdate(interaction.guild);
          return interaction.update({ embeds: [languageRequestEmbed(updated)], components: [] });
        }
        await interaction.deferUpdate();
        let entry = languageCatalogFindByInput(request.language_name);
        if (!entry) {
          let key = `custom-${slugifyChannelName(request.language_name)}`;
          let suffix = 2;
          while (languageCatalogEntry(key)) key = `custom-${slugifyChannelName(request.language_name)}-${suffix++}`;
          db.prepare('INSERT INTO language_catalog_custom (language_key,name,emoji,created_at,approved_by,active) VALUES (?,?,?,?,?,1)')
            .run(key, request.language_name.trim(), request.emoji || '🌐', now(), interaction.user.id);
          entry = languageCatalogEntry(key);
        }
        if (!entry) throw new Error('Approved language could not be added to the catalog.');
        for (const userId of supporterIds) {
          db.prepare('INSERT OR IGNORE INTO language_preferences (user_id,language_key,selected_at) VALUES (?,?,?)').run(userId, entry.key, now());
          db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(userId);
          db.prepare('UPDATE member_activation SET language_set=1 WHERE user_id=?').run(userId);
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await syncPreferredLanguageRole(interaction.guild, member, entry, true);
            await member.send(`✅ **${entry.emoji} ${entry.name}** was approved for the ${communityName()} language catalog and added to your preferences. A dedicated channel will only be created if demand reaches the community threshold and staff approves it.`).catch(() => {});
          }
        }
        db.prepare("UPDATE language_requests SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?").run(now(), interaction.user.id, id);
        const updated = db.prepare('SELECT * FROM language_requests WHERE id=?').get(id);
        await ensureLanguageDemandReview(interaction.guild, entry.key);
        scheduleModInboxUpdate(interaction.guild);
        return interaction.editReply({ embeds: [languageRequestEmbed(updated)], components: [] });
      }
      if (interaction.customId.startsWith('language_demand_create:') || interaction.customId.startsWith('language_demand_notnow:')) {
        if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const [action, languageKey] = interaction.customId.split(':');
        const entry = languageCatalogEntry(languageKey);
        if (!entry || entry.global) return interaction.reply({ content: 'That language is not available for a dedicated community.', ephemeral: true });
        const count = languageDemandCount(languageKey);
        if (action === 'language_demand_notnow') {
          db.prepare(`INSERT INTO language_demand_reviews (language_key,status,review_message_id,last_notified_count,updated_at,updated_by) VALUES (?,?,?,?,?,?)
            ON CONFLICT(language_key) DO UPDATE SET status='not_now',last_notified_count=excluded.last_notified_count,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
            .run(languageKey, 'not_now', interaction.message.id, count, now(), interaction.user.id);
          scheduleModInboxUpdate(interaction.guild);
          return interaction.update({ embeds: [languageDemandEmbed(entry, count, 'not_now')], components: [] });
        }
        await interaction.deferUpdate();
        const created = await createLanguageCommunity(interaction.guild, { languageKey, actorId: interaction.user.id, actorTag: interaction.user.tag });
        const preferred = db.prepare('SELECT user_id FROM language_preferences WHERE language_key=?').all(languageKey);
        for (const pref of preferred) {
          const member = await interaction.guild.members.fetch(pref.user_id).catch(() => null);
          if (member && created.channel) await member.send(`🌍 **${entry.emoji} ${entry.name}** is now active in ${communityName()} → <#${created.channel.id}>.`).catch(() => {});
        }
        scheduleModInboxUpdate(interaction.guild);
        scheduleHealthUpdate(interaction.guild);
        return interaction.editReply({ embeds: [languageDemandEmbed(entry, languageDemandCount(languageKey), 'created')], components: [] });
      }
      if (interaction.customId === 'linko_profile_wallets') return showProfileWalletsModal(interaction);
      if (interaction.customId === 'project_profile_details_setup' || interaction.customId === 'project_profile_details_edit') {
        if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: `Only **${coreRoleName()}** or a server Administrator can manage the Project Profile.`, ephemeral: true });
        return showProjectProfileDetailsModal(interaction, interaction.customId.endsWith('_setup') ? 'setup' : 'edit');
      }
      if (interaction.customId.startsWith('announcement_publish:') || interaction.customId.startsWith('announcement_cancel:')) {
        if (!canPublishAnnouncement(interaction.member)) return interaction.reply({ content: `Only **${coreRoleName()}** or **${teamRoleName()}** can publish announcements.`, ephemeral: true });
        const [action, draftId] = interaction.customId.split(':');
        const draft = announcementDrafts.get(draftId);
        if (!draft || draft.guildId !== interaction.guildId || draft.createdBy !== interaction.user.id) {
          return interaction.reply({ content: 'This announcement preview expired or belongs to another team member. Run /announce again.', ephemeral: true });
        }
        if (now() - draft.createdAt > 30 * 60 * 1000) {
          announcementDrafts.delete(draftId);
          return interaction.update({ content: '⌛ This announcement preview expired. Run /announce again.', embeds: [], components: [] });
        }
        if (action === 'announcement_cancel') {
          announcementDrafts.delete(draftId);
          return interaction.update({ content: 'Cancelled. Nothing was published.', embeds: [], components: [] });
        }

        const channel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'announcements' && c.isTextBased());
        if (!channel) return interaction.reply({ content: '#announcements could not be found. Run /setup-linko first.', ephemeral: true });
        const payload = buildAnnouncementPayload(draft);
        const sent = await channel.send(payload);
        db.prepare(`INSERT INTO announcements
          (created_by, title, body, image_url, cta_json, x_only, discord_message_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(draft.createdBy, draft.title || null, draft.body || null, draft.imageUrl || null, JSON.stringify(draft.links ?? []), draft.xOnly ? 1 : 0, sent.id, now());
        announcementDrafts.delete(draftId);
        return interaction.update({ content: `✅ Published in ${channel}.`, embeds: [], components: [] });
      }
      if (interaction.customId.startsWith('social_approve:')) {
        const [, id] = interaction.customId.split(':');
        return handleSocialReview(interaction, Number(id), true);
      }
      if (interaction.customId.startsWith('social_reject:')) {
        const [, id] = interaction.customId.split(':');
        return handleSocialReview(interaction, Number(id), false);
      }
      if (interaction.customId.startsWith('signal_approve:')) {
        const [, id] = interaction.customId.split(':');
        return handleSignalReview(interaction, Number(id), true);
      }
      if (interaction.customId.startsWith('signal_reject:')) {
        const [, id] = interaction.customId.split(':');
        return handleSignalReview(interaction, Number(id), false);
      }
      if (interaction.customId.startsWith('founder_approve:')) {
        const [, id] = interaction.customId.split(':');
        return handleFounderReview(interaction, 'approve', Number(id));
      }
      if (interaction.customId.startsWith('founder_reject:')) {
        const [, id] = interaction.customId.split(':');
        return handleFounderReview(interaction, 'reject', Number(id));
      }
      if (interaction.customId.startsWith('suggestion_status:')) {
        if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const [, id, status] = interaction.customId.split(':');
        await interaction.deferReply({ ephemeral: true });
        await setSuggestionStatus(interaction.guild, Number(id), status, interaction.user.id, '');
        return interaction.editReply(`✅ Suggestion #${id} → **${suggestionStatusLabel(status)}**.`);
      }
      if (interaction.customId.startsWith('event_rsvp:')) {
        const [, id, status] = interaction.customId.split(':');
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
        if (status === 'cancel') db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(Number(id), interaction.user.id);
        else db.prepare(`INSERT INTO event_rsvps (event_id, user_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`).run(Number(id), interaction.user.id, status, now());
        await updateEventMessage(interaction.guild, Number(id));
        return interaction.reply({ content: status === 'cancel' ? 'RSVP cleared.' : `RSVP saved: **${status === 'going' ? 'Going' : 'Interested'}**.`, ephemeral: true });
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'linko_onboarding_source') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (hasVerifiedRole(member)) return showMemberProfile(interaction, 'update');
      const source = interaction.values[0];
      if (source === 'member') {
        const existing = getJoinAttribution(member.id);
        if (existing?.detected_inviter_id) {
          const inviterUser = await client.users.fetch(existing.detected_inviter_id).catch(() => null);
          const recorded = await recordMemberJoinSource(interaction.guild, member, inviterUser);
          if (!recorded.ok) return interaction.update({ content: recorded.message, components: [inviterSelectRow()], embeds: [] });
          return interaction.update(participationStepPayload(`✅ LINKO matched your invite to **${recorded.inviterUser.username}**. ${recorded.eligible ? 'Referral attribution is recorded.' : 'Their referral reward remains pending.'}`));
        }
        return interaction.update({ content: `**Who invited you to ${communityName()}?**\nSelect that member below. They do **not** need to be verified for you to continue; their referral reward will simply remain pending until they become eligible.`, components: [inviterSelectRow()], embeds: [] });
      }
      upsertJoinAttribution(member.id, { source, inviterId: null, detectedInviterId: getJoinAttribution(member.id)?.detected_inviter_id ?? null, sourceConfirmed: 1, inviterConfirmed: 1 });
      db.prepare('UPDATE unattributed_joins SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE user_id = ?').run(member.id, now(), member.id);
      scheduleModInboxUpdate(interaction.guild);
      return interaction.update(participationStepPayload(`✅ Join source saved as **${joinSourceLabel(source)}**.`));
    }

    if (interaction.isUserSelectMenu() && interaction.customId === 'linko_onboarding_inviter') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (hasVerifiedRole(member)) return showMemberProfile(interaction, 'update');
      const inviterUser = interaction.users.first();
      const recorded = await recordMemberJoinSource(interaction.guild, member, inviterUser);
      if (!recorded.ok) return interaction.update({ content: `❌ ${recorded.message}\nChoose the correct inviter below.`, components: [inviterSelectRow()], embeds: [] });
      return interaction.update(participationStepPayload(`✅ Join source recorded: **Invited by ${recorded.inviterUser.username}**. ${recorded.eligible ? (recorded.detectedMatch ? 'Attribution confirmed.' : 'Referral awaits their confirmation.') : 'Their referral reward stays pending.'}`));
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'linko_onboarding_participation') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (hasVerifiedRole(member)) return showMemberProfile(interaction, 'update');
      const lane = interaction.values[0];
      if (lane === 'community') {
        setParticipationLane(member.id, 'community');
        return interaction.update({ content: `✅ Participation saved as **Community Member**.\n\n**Step 3 of 3 · Verify & enter ${communityName()}**`, components: [verificationButtonRow()], embeds: [] });
      }
      if (!moduleEnabled('kreator')) return interaction.update({ content: 'The KREATOR module is disabled in this server. Choose Community Member to continue.', components: [participationSelectRow()], embeds: [] });
      return showKreatorProfileModal(interaction);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'linko_profile_interests_select') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction, 'update');
      const selected = new Set(interaction.values);
      for (const [key, label] of INTERESTS) {
        const role = interaction.guild.roles.cache.find((r) => r.name === `${INTEREST_ROLE_PREFIX}${label}`);
        if (!role) continue;
        if (selected.has(key)) {
          if (!member.roles.cache.has(role.id)) await member.roles.add(role, `${communityName()} profile interest`);
          db.prepare('INSERT OR IGNORE INTO user_interests (user_id, interest, created_at) VALUES (?, ?, ?)').run(member.id, key, now());
        } else {
          if (member.roles.cache.has(role.id)) await member.roles.remove(role, `${communityName()} profile interest removed`);
          db.prepare('DELETE FROM user_interests WHERE user_id=? AND interest=?').run(member.id, key);
        }
      }
      db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(member.id);
      db.prepare('UPDATE member_activation SET interests_set=? WHERE user_id=?').run(selected.size > 0 ? 1 : 0, member.id);
      scheduleHealthUpdate(interaction.guild);
      return interaction.update({ content: '✅ Interests updated.', embeds: [buildMemberProfileEmbed(interaction.guild, member)], components: profileActionRows(member) });
    }

    if (interaction.isStringSelectMenu() && ['linko_profile_languages_base','linko_profile_languages_custom'].includes(interaction.customId)) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return showOnboardingEntry(interaction, 'update');
      ensureCatalogFromExistingLanguageRoles();
      const scopeEntries = interaction.customId === 'linko_profile_languages_base'
        ? VISIBLE_COMMUNITY_CATALOG
        : customLanguageCatalogRows().slice(0, 25).map((r) => languageCatalogEntry(r.language_key)).filter(Boolean);
      await updateLanguagePreferencesForScope(interaction.guild, member, scopeEntries, interaction.values);
      const selectedLabels = languagePreferenceKeys(member.id).map((key) => languageCatalogEntry(key)).filter(Boolean).map((entry) => `${entry.emoji} ${entry.name}`);
      return interaction.update({
        content: `✅ Communities saved.\n${selectedLabels.length ? selectedLabels.join(' · ') : 'No communities selected.'}`,
        embeds: [buildMemberProfileEmbed(interaction.guild, member)],
        components: profileActionRows(member),
      });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'linko_kreator_profile_modal') {
      return saveKreatorProfileFromModal(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'linko_language_request_modal') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      ensureCatalogFromExistingLanguageRoles();
      const languageName = interaction.fields.getTextInputValue('language').trim();
      const emoji = interaction.fields.getTextInputValue('emoji').trim() || '🌐';
      const note = interaction.fields.getTextInputValue('note').trim();
      if (!languageName || languageName.length < 2) return interaction.reply({ content: 'Enter a valid country, region, or language.', ephemeral: true });
      const existingEntry = languageCatalogFindByInput(languageName);
      if (existingEntry) {
        db.prepare('INSERT OR IGNORE INTO language_preferences (user_id,language_key,selected_at) VALUES (?,?,?)').run(member.id, existingEntry.key, now());
        await syncPreferredLanguageRole(interaction.guild, member, existingEntry, true);
        await ensureLanguageDemandReview(interaction.guild, existingEntry.key);
        db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(member.id);
        db.prepare('UPDATE member_activation SET language_set=1 WHERE user_id=?').run(member.id);
        const active = activeLanguageRowForEntry(existingEntry);
        return interaction.reply({
          content: `ℹ️ **${existingEntry.emoji} ${existingEntry.name}** is already in the approved community catalog. I added it to your communities.${existingEntry.global ? ' Global stays in the main community.' : active?.channel_id ? ` You now have access to <#${active.channel_id}>.` : ` Current demand: **${languageDemandCount(existingEntry.key)}/${LANGUAGE_DEMAND_THRESHOLD}** before staff review.`}`,
          embeds: [buildMemberProfileEmbed(interaction.guild, member)],
          components: profileActionRows(member),
          ephemeral: true,
        });
      }
      const normalized = normalizeLanguageInput(languageName);
      const pendingRows = db.prepare("SELECT * FROM language_requests WHERE status='pending' ORDER BY id DESC").all();
      const duplicate = pendingRows.find((row) => normalizeLanguageInput(row.language_name) === normalized);
      if (duplicate) {
        db.prepare('INSERT OR IGNORE INTO language_request_supporters (request_id,user_id,created_at) VALUES (?,?,?)').run(duplicate.id, member.id, now());
        return interaction.reply({ content: `ℹ️ **${duplicate.language_name}** is already pending staff review as request **#${duplicate.id}**. I recorded your interest too, so no duplicate request was created.`, ephemeral: true });
      }
      const result = db.prepare('INSERT INTO language_requests (user_id,language_name,emoji,note,created_at) VALUES (?,?,?,?,?)').run(member.id, languageName, emoji, note || null, now());
      const id = Number(result.lastInsertRowid);
      db.prepare('INSERT OR IGNORE INTO language_request_supporters (request_id,user_id,created_at) VALUES (?,?,?)').run(id, member.id, now());
      let row = db.prepare('SELECT * FROM language_requests WHERE id=?').get(id);
      const reviewChannel = staffLanguageReviewChannel(interaction.guild);
      if (!reviewChannel) return interaction.reply({ content: 'Language request saved, but the staff review channel is missing. Please alert a moderator.', ephemeral: true });
      const msg = await reviewChannel.send({ embeds: [languageRequestEmbed(row)], components: [languageRequestReviewButtons(id)] });
      db.prepare('UPDATE language_requests SET review_message_id=? WHERE id=?').run(msg.id, id);
      row = db.prepare('SELECT * FROM language_requests WHERE id=?').get(id);
      scheduleModInboxUpdate(interaction.guild);
      return interaction.reply({ content: `✅ Request **#${id} · ${languageName}** was sent to staff to consider adding it to the official language catalog. It will **not** create a channel automatically.`, ephemeral: true });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'linko_member_socials_modal') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      const xRaw = interaction.fields.getTextInputValue('x').trim();
      const tgRaw = interaction.fields.getTextInputValue('telegram').trim();
      const liRaw = interaction.fields.getTextInputValue('linkedin').trim();
      const xAccount = xRaw ? normalizeXAccount(xRaw) : null;
      const telegramAccount = tgRaw ? normalizeTelegramAccount(tgRaw) : null;
      const linkedinAccount = liRaw ? normalizeLinkedInAccount(liRaw) : null;
      if (xRaw && !xAccount) return interaction.reply({ content: 'Enter a valid X username or x.com profile URL.', ephemeral: true });
      if (tgRaw && !telegramAccount) return interaction.reply({ content: 'Enter a valid Telegram username or t.me profile URL.', ephemeral: true });
      if (liRaw && !linkedinAccount) return interaction.reply({ content: 'Enter a valid LinkedIn profile URL.', ephemeral: true });
      const current = walletProfile(member.id);
      db.prepare(`INSERT INTO wallet_profiles (user_id, primary_network, updated_at, x_account, telegram_account, linkedin_account) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at, x_account=excluded.x_account, telegram_account=excluded.telegram_account, linkedin_account=excluded.linkedin_account`)
        .run(member.id, current?.primary_network ?? null, now(), xAccount, telegramAccount, linkedinAccount);
      let earned = 0;
      if (xAccount) earned += await awardFirstSubmissionKxp(interaction.guild, member.id, 'x', 'X account');
      if (telegramAccount) earned += await awardFirstSubmissionKxp(interaction.guild, member.id, 'telegram', 'Telegram account');
      const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'wallet-log' && c.isTextBased());
      if (log) await log.send(`👤 **Member socials updated** — ${member} · X ${xAccount ?? '—'} · Telegram ${telegramAccount ?? '—'} · LinkedIn ${linkedinAccount ? 'saved' : '—'}${earned ? ` · +${earned} ${xpLabel()} first-time reward` : ''}`).catch(() => {});
      return interaction.reply({ content: `✅ Social profile updated.${earned ? ` First-time submissions earned **+${earned} ${xpLabel()}**.` : ''}`, embeds: [buildMemberProfileEmbed(interaction.guild, member)], components: profileActionRows(member), ephemeral: true });
    }

    if (interaction.isModalSubmit() && interaction.customId === 'linko_member_wallets_modal') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      const desired = { evm: interaction.fields.getTextInputValue('evm').trim(), solana: interaction.fields.getTextInputValue('solana').trim() };
      for (const [network, address] of Object.entries(desired)) {
        if (address && !walletAddressValid(network, address)) return interaction.reply({ content: `That does not look like a valid **${walletNetworkLabel(network)}** public address.`, ephemeral: true });
        if (!address) continue;
        const duplicate = network === 'evm'
          ? db.prepare('SELECT user_id FROM wallets WHERE network=? AND LOWER(address)=LOWER(?) LIMIT 1').get(network, address)
          : db.prepare('SELECT user_id FROM wallets WHERE network=? AND address=? LIMIT 1').get(network, address);
        if (duplicate && duplicate.user_id !== member.id) return interaction.reply({ content: `That ${walletNetworkLabel(network)} address is already submitted by another member. Ask staff if it is a legitimate shared address.`, ephemeral: true });
      }
      const lockHours = Math.max(0, getSettingInt('wallet_change_lock_hours'));
      let earned = 0;
      const changes = [];
      for (const [network, address] of Object.entries(desired)) {
        const old = db.prepare('SELECT * FROM wallets WHERE user_id=? AND network=?').get(member.id, network);
        if (!address) {
          if (old) {
            db.prepare('DELETE FROM wallets WHERE user_id=? AND network=?').run(member.id, network);
            db.prepare('INSERT INTO wallet_history (user_id,network,old_address,new_address,changed_at,actor_id) VALUES (?,?,?,?,?,?)').run(member.id, network, old.address, null, now(), member.id);
            changes.push(`${walletNetworkLabel(network)} removed`);
          }
          continue;
        }
        const changedAt = now();
        const walletChanged = !old || old.address !== address;
        const priorHistory = db.prepare('SELECT id FROM wallet_history WHERE user_id=? AND network=? LIMIT 1').get(member.id, network);
        const eligibleAt = old && !walletChanged ? Number(old.reward_eligible_at) : (old || priorHistory) ? changedAt + lockHours * 60 * 60 * 1000 : changedAt;
        db.prepare(`INSERT INTO wallets (user_id,network,address,submitted_at,updated_at,reward_eligible_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id,network) DO UPDATE SET address=excluded.address, updated_at=excluded.updated_at, reward_eligible_at=excluded.reward_eligible_at`)
          .run(member.id, network, address, old?.submitted_at ?? changedAt, changedAt, eligibleAt);
        if (walletChanged) db.prepare('INSERT INTO wallet_history (user_id,network,old_address,new_address,changed_at,actor_id) VALUES (?,?,?,?,?,?)').run(member.id, network, old?.address ?? null, address, changedAt, member.id);
        earned += await awardFirstSubmissionKxp(interaction.guild, member.id, `wallet_${network}`, `${walletNetworkLabel(network)} wallet`);
        changes.push(`${walletNetworkLabel(network)} ${old ? (walletChanged ? 'updated' : 'unchanged') : 'added'}`);
      }
      const remaining = walletRows(member.id);
      const currentProfile = walletProfile(member.id);
      const currentPrimary = currentProfile?.primary_network;
      const primaryStillExists = remaining.some((r) => r.network === currentPrimary);
      const primary = primaryStillExists ? currentPrimary : (remaining[0]?.network ?? null);
      db.prepare(`INSERT INTO wallet_profiles (user_id,primary_network,updated_at) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET primary_network=excluded.primary_network, updated_at=excluded.updated_at`).run(member.id, primary, now());
      const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'wallet-log' && c.isTextBased());
      if (log) await log.send(`🔐 **Wallet profile updated** — ${member} · ${remaining.map((r) => `${walletNetworkLabel(r.network)} ${maskWallet(r.address)}`).join(' · ') || 'no wallets'}${earned ? ` · +${earned} ${xpLabel()} first-time reward` : ''}`).catch(() => {});
      return interaction.reply({ content: `✅ Wallet profile updated. ${changes.join(' · ') || 'No wallet changes.'}${earned ? ` First-time submissions earned **+${earned} ${xpLabel()}**.` : ''}\nLINKO stores public addresses only and never requests signatures, approvals, seed phrases or private keys.`, embeds: [buildMemberProfileEmbed(interaction.guild, member)], components: profileActionRows(member), ephemeral: true });
    }
    if (interaction.isModalSubmit() && ['project_profile_modal', 'project_profile_setup_modal'].includes(interaction.customId)) {
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) {
        return interaction.reply({ content: `Only **${coreRoleName()}** or a server Administrator can manage the Project Profile.`, ephemeral: true });
      }
      saveProjectProfileFromModal(interaction);
      const setupMode = interaction.customId === 'project_profile_setup_modal';

      if (setupMode && projectProfileComplete()) {
        await interaction.deferReply({ ephemeral: true });
        setSetupPhase('starting');
        try {
          await buildKlineO(interaction.guild);
          setSetupPhase('idle');
          return interaction.editReply(`✅ Project Profile saved and LINKO setup completed for **${communityName()}**. The welcome experience now uses this project context.`);
        } catch (error) {
          const phase = getSetupPhase();
          logLinkoError(`project profile setup failed during ${phase}`, error);
          setSetupPhase('idle');
          return interaction.editReply(`❌ Project Profile was saved, but LINKO setup stopped during **${phase}**: ${String(error?.message ?? error).slice(0, 900)}`);
        }
      }

      if (setupMode) {
        return interaction.reply({
          content: '✅ Step 1 of 2 saved. LINKO now knows what the project is and who it serves. Continue with products, current status and the first action new members should take.',
          components: [projectProfileDetailsActionRow('setup')],
          ephemeral: true,
        });
      }

      await refreshBrandMessages(interaction.guild).catch((error) => logLinkoError('project-profile-refresh', error));
      return interaction.reply({
        embeds: [projectProfileSummaryEmbed()],
        content: '✅ Core Project Profile updated. Use the button below to update products, status, first-member action, primary URL and LINKO wording guidance.',
        components: [projectProfileDetailsActionRow('edit')],
        ephemeral: true,
      });
    }

    if (interaction.isModalSubmit() && ['project_profile_details_modal', 'project_profile_details_setup_modal'].includes(interaction.customId)) {
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) {
        return interaction.reply({ content: `Only **${coreRoleName()}** or a server Administrator can manage the Project Profile.`, ephemeral: true });
      }
      const saved = saveProjectProfileDetailsFromModal(interaction);
      if (!saved.ok) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
      const setupMode = interaction.customId === 'project_profile_details_setup_modal';
      await interaction.deferReply({ ephemeral: true });

      if (setupMode) {
        setSetupPhase('starting');
        try {
          await buildKlineO(interaction.guild);
          setSetupPhase('idle');
          return interaction.editReply(`✅ Project Profile completed and LINKO setup finished for **${communityName()}**. The welcome message now includes this project context.`);
        } catch (error) {
          const phase = getSetupPhase();
          logLinkoError(`project profile details setup failed during ${phase}`, error);
          setSetupPhase('idle');
          return interaction.editReply(`❌ Project Profile was saved, but LINKO setup stopped during **${phase}**: ${String(error?.message ?? error).slice(0, 900)}`);
        }
      }

      await refreshBrandMessages(interaction.guild).catch((error) => logLinkoError('project-profile-details-refresh', error));
      return interaction.editReply({ embeds: [projectProfileSummaryEmbed()], content: '✅ Project details updated. The live welcome message was refreshed where available.' });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'project_profile_links_modal') {
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) {
        return interaction.reply({ content: `Only **${coreRoleName()}** or a server Administrator can manage the Project Profile.`, ephemeral: true });
      }
      const saved = saveProjectProfileLinksFromModal(interaction);
      if (!saved.ok) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await refreshBrandMessages(interaction.guild).catch((error) => logLinkoError('project-profile-links-refresh', error));
      return interaction.editReply({ embeds: [projectProfileSummaryEmbed()], content: '✅ Project link labels updated. The live welcome message was refreshed where available.' });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'founder_application_modal') return handleFounderModal(interaction);
    if (!interaction.isChatInputCommand()) return;

    if (!moduleEnabled('kreator') && interaction.commandName === 'creator-campaign') {
      return interaction.reply({ content: 'The **KREATOR** module is disabled in this server.', ephemeral: true });
    }
    if (!moduleEnabled('founder_hub') && interaction.commandName === 'apply-founder') {
      return interaction.reply({ content: 'The **Founder Hub** module is disabled in this server.', ephemeral: true });
    }
    if (!moduleEnabled('liquidity_studio') && interaction.commandName === 'create-client-space') {
      return interaction.reply({ content: 'The **Liquidity Studio** module is disabled in this server.', ephemeral: true });
    }

    // Acknowledge long-running setup immediately. Discord requires an initial
    // interaction response within ~3 seconds; command logging must never block it.
    if (interaction.commandName === 'setup-klineo' || interaction.commandName === 'setup-linko') {
      if (!isAdmin(interaction)) return interaction.reply({ content: 'Server owner / Administrator only.', ephemeral: true });
      seedKlineOProjectProfile(interaction.guild);
      if (interaction.options.getBoolean('confirm', true) && !projectProfileCoreComplete()) {
        return showProjectProfileModal(interaction, 'setup');
      }
      if (interaction.options.getBoolean('confirm', true) && !projectProfileComplete()) {
        return showProjectProfileDetailsModal(interaction, 'setup');
      }
      if (!interaction.options.getBoolean('confirm', true)) {
        return interaction.reply({ content: `Preview only. Use \`/${interaction.commandName} confirm:true\` to build/sync LINKO in this server.`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      logCommandUse(interaction).catch(() => {});
      setSetupPhase('starting');
      try {
        await buildKlineO(interaction.guild);
        setSetupPhase('idle');
        return interaction.editReply(`✅ LINKO v10.16 synced for **${interaction.guild.name}**. XP label: **${xpLabel()}**. Button-based onboarding, standardized preferred languages, demand-based language communities, referrals, native events, moderation, and managed channels are active.`);
      } catch (error) {
        const phase = getSetupPhase();
        logLinkoError(`${interaction.commandName} failed during ${phase}`, error);
        setSetupPhase('idle');
        const short = String(error?.message ?? error).slice(0, 900);
        return interaction.editReply(`❌ LINKO setup stopped during **${phase}**.\n\n**Error:** ${short}\n\nThis server's database is isolated at **${guildDatabasePath(interaction.guildId)}**. Check \`data/linko-errors.log\` for the full stack.`);
      }
    }

    logCommandUse(interaction).catch(() => {});

    if (interaction.commandName === 'profile') return showMemberProfile(interaction);

    if (interaction.commandName === 'rank' || interaction.commandName === 'points') {
      const user = interaction.options.getUser('member') ?? interaction.user;
      const xp = getXp(user.id);
      const rank = rankForXp(xp);
      const next = nextRankForXp(xp);
      return interaction.reply({ content: `**${user.username}** — **${rank.name}** — **${xp.toLocaleString()} ${xpLabel()}**${next ? `\nNext: ${next.name} at ${next.threshold.toLocaleString()} ${xpLabel()} (${(next.threshold - xp).toLocaleString()} to go).` : `\nPRIME reached. Lifetime ${xpLabel()} continues with no cap.`}`, ephemeral: true });
    }

    if (interaction.commandName === 'leaderboard') {
      const type = interaction.options.getString('type') ?? 'kxp';
      if (!canViewLeaderboard(interaction.member, type)) return interaction.reply({ content: `This leaderboard is currently private to ${communityName()} staff.`, ephemeral: true });
      const limit = Math.max(1, Math.min(50, getSettingInt('leaderboard_limit') || 50));
      if (type === 'community') return interaction.reply({ embeds: buildCommunityLeaderboardEmbeds(interaction.guild, limit), ephemeral: !leaderboardIsPublic(type) });
      if (type === 'referrals') return interaction.reply({ embeds: buildReferralLeaderboardEmbeds(interaction.guild, limit), ephemeral: !leaderboardIsPublic(type) });
      if (type === 'creators') {
        if (!moduleEnabled('kreator')) return interaction.reply({ content: 'The KREATOR module is disabled in this server.', ephemeral: true });
        return interaction.reply({ embeds: buildCreatorLeaderboardEmbeds(interaction.guild, limit), ephemeral: !leaderboardIsPublic(type) });
      }
      if (type === 'campaign') {
        if (!moduleEnabled('kreator')) return interaction.reply({ content: 'The KREATOR module is disabled in this server.', ephemeral: true });
        const campaignId = interaction.options.getInteger('campaign');
        if (!campaignId) {
          const active = creatorCampaigns('active');
          const text = active.length ? active.map((c) => `**#${c.id}** · ${c.name}`).join('\n') : 'No active creator campaigns.';
          return interaction.reply({ content: `**Active ${communityName()} Creator Campaigns**\n${text}\n\nUse \`/leaderboard type:Creator Campaign campaign:<ID>\`.`, ephemeral: !leaderboardIsPublic(type) });
        }
        return interaction.reply({ embeds: buildCampaignLeaderboardEmbeds(interaction.guild, campaignId, limit), ephemeral: !leaderboardIsPublic(type) });
      }
      return interaction.reply({ embeds: buildLeaderboardEmbeds(interaction.guild, limit), ephemeral: !leaderboardIsPublic(type) });
    }

    if (interaction.commandName === 'commands') {
      return interaction.reply({ content: '**LINKO Member Commands**\n**Primary:** `/profile` opens your permanent private profile dashboard.\n\n**Other commands:** `/rank` · `/points` · `/leaderboard` · `/invite` · `/invites` · `/join-source` · `/confirm-invited` · `/wallet` · `/kreator-profile` · `/submit-content` · `/social-card` · `/apply-founder` · `/onboarding` · `/interest` · `/language` · `/suggest` · `/events`', components: [profileLauncherRow()], ephemeral: true });
    }

    if (interaction.commandName === 'invite') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      const channel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'welcome' && c.type === ChannelType.GuildText) ?? interaction.channel;
      const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Tracked ${communityName()} invite for ${interaction.user.tag}` });
      db.prepare('INSERT OR REPLACE INTO invite_codes (code, inviter_id, created_at) VALUES (?, ?, ?)').run(invite.code, interaction.user.id, now());
      inviteCacheForGuild(interaction.guildId).set(invite.code, invite.uses ?? 0);
      return interaction.reply({ content: `Your tracked ${communityName()} invite:\n${invite.url}\n\nA referral becomes valid after **7 days** if the member remains in the server and verifies.`, ephemeral: true });
    }

    if (interaction.commandName === 'invites') {
      const stats = getReferralStats(interaction.user.id);
      return interaction.reply({ content: `**Your ${communityName()} referrals**\nInvited: **${stats.total}**\nValid: **${stats.valid}**\nTracked invite: **${stats.tracked}**\nMember-declared valid: **${stats.claimed}**\nModerator-confirmed: **${stats.manual}**\nAwaiting inviter confirmation: **${stats.awaitingConfirmation}**\nPending total: **${stats.pending}**\nReferral ${xpLabel()} logged: **${stats.earned}**`, ephemeral: true });
    }

    if (interaction.commandName === 'join-source') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const name = communityName();
      if (hasVerifiedRole(member)) return interaction.reply({ content: `Your ${name} join source is locked after verification. Ask staff if a correction is required.`, ephemeral: true });
      const source = interaction.options.getString('source', true);
      const selectedUser = interaction.options.getUser('member');
      const existingAttribution = getJoinAttribution(member.id);
      const joinedAt = member.joinedTimestamp ?? db.prepare('SELECT joined_at FROM users WHERE user_id=?').get(member.id)?.joined_at ?? now();

      if (source !== 'member') {
        if (selectedUser) return interaction.reply({ content: 'Only select a member when your source is **Invited by a community member**.', ephemeral: true });
        if (existingAttribution?.detected_inviter_id) {
          return interaction.reply({ content: `LINKO detected <@${existingAttribution.detected_inviter_id}> as the invite creator. If that is correct, choose **Invited by a community member**. If it is genuinely incorrect, ask a moderator to resolve the attribution.`, ephemeral: true });
        }
        upsertJoinAttribution(member.id, { source, inviterId: null, detectedInviterId: existingAttribution?.detected_inviter_id ?? null, sourceConfirmed: 1, inviterConfirmed: 1 });
        db.prepare('UPDATE unattributed_joins SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE user_id = ?').run(member.id, now(), member.id);
        scheduleModInboxUpdate(interaction.guild);
        return interaction.reply({ ...participationStepPayload(`✅ Join source saved as **${joinSourceLabel(source)}**.`), ephemeral: true });
      }

      let inviterUser = selectedUser;
      if (!inviterUser && existingAttribution?.detected_inviter_id) inviterUser = await client.users.fetch(existingAttribution.detected_inviter_id).catch(() => null);
      if (!inviterUser) return interaction.reply({ content: 'Select the community member who invited you. If LINKO detected an invite creator, you may leave the member option empty and LINKO will use that detected inviter.', ephemeral: true });
      if (inviterUser.id === interaction.user.id) return interaction.reply({ content: 'You cannot select yourself as your inviter.', ephemeral: true });
      if (inviterUser.bot) return interaction.reply({ content: 'Bots cannot receive referral credit.', ephemeral: true });
      if (existingAttribution?.detected_inviter_id && inviterUser.id !== existingAttribution.detected_inviter_id) {
        return interaction.reply({ content: `LINKO detected <@${existingAttribution.detected_inviter_id}> as the invite creator. Staff must resolve that attribution before a different inviter can be selected.`, ephemeral: true });
      }
      const recorded = await recordMemberJoinSource(interaction.guild, member, inviterUser);
      if (!recorded.ok) return interaction.reply({ content: recorded.message, ephemeral: true });
      return interaction.reply({ content: `✅ Join source recorded: **Invited by ${inviterUser.username}**. You can now verify and enter ${name}. ${recorded.eligible ? (recorded.detectedMatch ? 'Referral attribution is already confirmed.' : 'Referral attribution is pending inviter confirmation.') : 'Your inviter is not verified yet, but that does **not** block your verification. Their referral credit remains pending until they become eligible.'}`, components: [verificationButtonRow()], ephemeral: true });
    }

    if (interaction.commandName === 'confirm-invited') {
      const inviter = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(inviter) && !hasStaffRole(inviter)) return interaction.reply({ content: `Only verified ${communityName()} members can confirm referrals.`, ephemeral: true });
      const referredUser = interaction.options.getUser('member', true);
      if (referredUser.id === interaction.user.id) return interaction.reply({ content: 'You cannot confirm yourself as a referral.', ephemeral: true });
      const attribution = getJoinAttribution(referredUser.id);
      const referral = db.prepare('SELECT * FROM referrals WHERE member_id = ?').get(referredUser.id);
      if (!attribution || attribution.source !== 'member' || !referral) return interaction.reply({ content: 'LINKO has no pending member referral for that user.', ephemeral: true });
      if (attribution.inviter_id !== interaction.user.id || referral.inviter_id !== interaction.user.id) return interaction.reply({ content: 'That member did not select you as their inviter.', ephemeral: true });
      if (Number(attribution.inviter_confirmed)) return interaction.reply({ content: 'You already confirmed this referral.', ephemeral: true });
      db.prepare('UPDATE join_attribution SET inviter_confirmed = 1, updated_at = ? WHERE user_id = ?').run(now(), referredUser.id);
      const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
      if (log) await log.send(`🤝 **Inviter confirmed** — ${interaction.user} confirmed they invited ${referredUser}. Referral remains pending until verification + 7 days + activity requirements are met.`).catch(() => {});
      const referred = await interaction.guild.members.fetch(referredUser.id).catch(() => null);
      if (referred) await referred.send(`✅ ${interaction.user.username} confirmed that they invited you to ${communityName()}. Referral credit is still pending until you are verified, remain for 7 days, and meet activity requirements.`).catch(() => {});
      scheduleModInboxUpdate(interaction.guild);
      return interaction.reply({ content: `✅ Confirmed. ${referredUser}'s referral is now attributed to you and will validate automatically after the remaining qualification rules are met.`, ephemeral: true });
    }

    if (interaction.commandName === 'referred-by') {
      const member = interaction.options.getUser('member', true);
      return interaction.reply({ content: `Please use the required onboarding command: **/join-source source:Invited by a community member member:${member.username}**. LINKO requires every new member to select a join source before verification.`, ephemeral: true });
    }

    if (interaction.commandName === 'wallet') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'view') {
        const rows = walletRows(interaction.user.id);
        const primary = walletPrimary(interaction.user.id);
        const lines = rows.length ? rows.map((r) => {
          const eligible = Number(r.reward_eligible_at) <= now() ? 'Eligible' : `activates <t:${Math.floor(Number(r.reward_eligible_at)/1000)}:R>`;
          return `**${walletNetworkLabel(r.network)}${primary === r.network ? ' · PRIMARY' : ''}**\n\`${r.address}\`\nStatus: Submitted · Reward use: ${eligible}`;
        }).join('\n\n') : 'No wallet addresses submitted yet.';
        const profile = walletProfile(interaction.user.id);
        const socials = `**X:** ${profile?.x_account ?? 'Not submitted'}\n**Telegram:** ${profile?.telegram_account ?? 'Not submitted'}\n**LinkedIn:** ${profile?.linkedin_account ?? 'Not submitted'}`;
        return interaction.reply({ content: `**KLINEO WALLET + SOCIAL PROFILE**\n\n${socials}\n\n${lines}\n\nLINKO only stores public profile identifiers and public wallet addresses. It never connects to wallets, requests signatures, approvals, seed phrases, private keys or transactions.`, ephemeral: true });
      }
      const network = interaction.options.getString('network', true);
      if (action === 'set') {
        const address = interaction.options.getString('address', true).trim();
        const xAccount = normalizeXAccount(interaction.options.getString('x', true));
        const telegramAccount = normalizeTelegramAccount(interaction.options.getString('telegram', true));
        if (!xAccount) return interaction.reply({ content: 'Enter a valid X username or profile URL, e.g. `@username` or `https://x.com/username`.', ephemeral: true });
        if (!telegramAccount) return interaction.reply({ content: 'Enter a valid Telegram username or profile URL, e.g. `@username` or `https://t.me/username`.', ephemeral: true });
        if (!walletAddressValid(network, address)) return interaction.reply({ content: `That does not look like a valid **${walletNetworkLabel(network)}** public address. LINKO only validates format; it does not verify ownership.`, ephemeral: true });
        const old = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND network = ?').get(interaction.user.id, network);
        const walletChanged = !old || old.address !== address;
        const duplicate = network === 'evm'
          ? db.prepare('SELECT user_id FROM wallets WHERE network = ? AND LOWER(address) = LOWER(?) LIMIT 1').get(network, address)
          : db.prepare('SELECT user_id FROM wallets WHERE network = ? AND address = ? LIMIT 1').get(network, address);
        if (duplicate && duplicate.user_id !== interaction.user.id) return interaction.reply({ content: `That public address is already submitted by another ${communityName()} member. Ask **${coreRoleName()}** if this is a legitimate shared address.`, ephemeral: true });
        const priorHistory = db.prepare('SELECT id FROM wallet_history WHERE user_id = ? AND network = ? LIMIT 1').get(interaction.user.id, network);
        const changedAt = now();
        const lockHours = Math.max(0, getSettingInt('wallet_change_lock_hours'));
        const eligibleAt = old && !walletChanged ? Number(old.reward_eligible_at) : (old || priorHistory) ? changedAt + lockHours * 60 * 60 * 1000 : changedAt;
        db.prepare(`INSERT INTO wallets (user_id, network, address, submitted_at, updated_at, reward_eligible_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id,network) DO UPDATE SET address=excluded.address, updated_at=excluded.updated_at, reward_eligible_at=excluded.reward_eligible_at`)
          .run(interaction.user.id, network, address, old?.submitted_at ?? changedAt, changedAt, eligibleAt);
        if (walletChanged) db.prepare('INSERT INTO wallet_history (user_id,network,old_address,new_address,changed_at,actor_id) VALUES (?,?,?,?,?,?)')
          .run(interaction.user.id, network, old?.address ?? null, address, changedAt, interaction.user.id);
        const profile = walletProfile(interaction.user.id);
        db.prepare(`INSERT INTO wallet_profiles (user_id, primary_network, updated_at, x_account, telegram_account) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            primary_network = COALESCE(wallet_profiles.primary_network, excluded.primary_network),
            updated_at = excluded.updated_at, x_account = excluded.x_account, telegram_account = excluded.telegram_account`)
          .run(interaction.user.id, profile?.primary_network ?? network, changedAt, xAccount, telegramAccount);
        let earned = 0;
        earned += await awardFirstSubmissionKxp(interaction.guild, interaction.user.id, 'x', 'X account');
        earned += await awardFirstSubmissionKxp(interaction.guild, interaction.user.id, 'telegram', 'Telegram account');
        earned += await awardFirstSubmissionKxp(interaction.guild, interaction.user.id, `wallet_${network}`, `${walletNetworkLabel(network)} wallet`);
        const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'wallet-log' && c.isTextBased());
        if (log) await log.send(`🔐 **Wallet/profile ${old ? 'updated' : 'submitted'}** — ${interaction.user} · X **${xAccount}** · Telegram **${telegramAccount}** · **${walletNetworkLabel(network)}** ${old && walletChanged ? `${maskWallet(old.address)} → ` : ''}${maskWallet(address)}${old && walletChanged && lockHours ? ` · reward lock ${lockHours}h` : ''}${earned ? ` · +${earned} ${xpLabel()} first-time submission reward` : ''}`).catch(() => {});
        const rewardLine = earned ? `\n\n🎯 First-time profile submission rewards: **+${earned} ${xpLabel()}**.` : '\n\nNo new submission ${xpLabel()} was awarded because these profile items were already rewarded previously.';
        const walletStatus = !old ? 'submitted' : walletChanged ? `updated; the new wallet address is locked for reward payouts for **${lockHours} hours**` : 'kept unchanged';
        return interaction.reply({ content: `✅ X and Telegram saved. ${walletNetworkLabel(network)} wallet ${walletStatus}.${rewardLine}\n\nLINKO stores public identifiers/addresses only. It never connects, signs or requests approvals, and it does not verify wallet ownership.`, ephemeral: true });
      }
      if (action === 'remove') {
        const old = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND network = ?').get(interaction.user.id, network);
        if (!old) return interaction.reply({ content: `You do not have a submitted ${walletNetworkLabel(network)} wallet.`, ephemeral: true });
        db.prepare('DELETE FROM wallets WHERE user_id = ? AND network = ?').run(interaction.user.id, network);
        db.prepare('INSERT INTO wallet_history (user_id,network,old_address,new_address,changed_at,actor_id) VALUES (?,?,?,?,?,?)').run(interaction.user.id, network, old.address, null, now(), interaction.user.id);
        const remaining = walletRows(interaction.user.id);
        if (walletPrimary(interaction.user.id) === network) db.prepare('INSERT INTO wallet_profiles (user_id,primary_network,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET primary_network=excluded.primary_network, updated_at=excluded.updated_at').run(interaction.user.id, remaining[0]?.network ?? null, now());
        const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'wallet-log' && c.isTextBased());
        if (log) await log.send(`🔐 **Wallet removed** — ${interaction.user} · **${walletNetworkLabel(network)}** · ${maskWallet(old.address)}`).catch(() => {});
        return interaction.reply({ content: `Removed your submitted ${walletNetworkLabel(network)} wallet.`, ephemeral: true });
      }
      if (action === 'primary') {
        const row = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND network = ?').get(interaction.user.id, network);
        if (!row) return interaction.reply({ content: `Submit a ${walletNetworkLabel(network)} wallet first with \`/wallet set\`.`, ephemeral: true });
        db.prepare('INSERT INTO wallet_profiles (user_id,primary_network,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET primary_network=excluded.primary_network, updated_at=excluded.updated_at').run(interaction.user.id, network, now());
        return interaction.reply({ content: `✅ **${walletNetworkLabel(network)}** is now your primary submitted payout wallet.`, ephemeral: true });
      }
    }

    if (interaction.commandName === 'kreator-profile') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify first, or choose KREATOR during START ONBOARDING.', ephemeral: true });
      const profile = kreatorProfile(member.id);
      if (profile?.status === 'pending') return interaction.reply({ content: 'Your KREATOR profile is already pending staff review.', embeds: [kreatorProfileEmbed(member.id, profile)], ephemeral: true });
      return showKreatorProfileModal(interaction);
    }
    if (interaction.commandName === 'submit-content') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'social') return handleSocialSubmission(interaction);
      if (subcommand === 'signal') return handleSignalSubmission(interaction);
    }
    if (interaction.commandName === 'apply-founder') return createFounderApplicationModal(interaction);

    if (interaction.commandName === 'onboarding') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const a = activationRow(member.id);
      const interests = db.prepare('SELECT interest FROM user_interests WHERE user_id = ? ORDER BY interest').all(member.id).map((r) => interestByKey(r.interest)?.[1] ?? r.interest);
      const langs = languagePreferenceKeys(member.id).map((key) => languageCatalogEntry(key)).filter(Boolean).map((entry) => `${entry.emoji} ${entry.name}`);
      const languageAvailable = languageRows().length > 0;
      const lane = participationLane(member) || (hasKreatorRole(member) ? 'kreator' : 'community');
      const steps = [
        ['Verified', hasVerifiedRole(member)], ['Participation lane', !!lane], ['Choose an interest', interests.length > 0],
        ...(languageAvailable ? [['Choose a language', langs.length > 0]] : []),
        ['Introduce yourself', !!a.introduced_at], ['First qualified contribution', !!a.first_impact_at],
      ];
      const done = steps.filter((x) => x[1]).length;
      return interaction.reply({
        content: `**${communityName()} Activation · ${done}/${steps.length}**\n${steps.map(([n,v]) => `${v ? '✅' : '⬜'} ${n}`).join('\n')}\n\nParticipation: **${hasKreatorRole(member) ? 'KREATOR' : lane === 'kreator_pending' ? 'KREATOR · pending' : 'Community Member'}**\nInterests: ${interests.length ? interests.join(', ') : 'None yet'}\nCommunities: ${langs.length ? langs.join(', ') : 'None yet'}\n\nUse the buttons below for profile details, then introduce yourself and make your first genuine contribution.`,
        embeds: hasVerifiedRole(member) ? [buildMemberProfileEmbed(interaction.guild, member)] : [],
        components: hasVerifiedRole(member) ? [profileActionRow()] : [],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'interest') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rows = db.prepare('SELECT interest FROM user_interests WHERE user_id=? ORDER BY interest').all(member.id);
        const labels = rows.map((r) => interestByKey(r.interest)?.[1] ?? r.interest);
        return interaction.reply({ content: `Your interests: **${labels.length ? labels.join(', ') : 'None selected'}**`, ephemeral: true });
      }
      const key = interaction.options.getString('interest', true);
      const def = interestByKey(key);
      const role = interaction.guild.roles.cache.find((r) => r.name === `${INTEREST_ROLE_PREFIX}${def?.[1]}`);
      if (!def || !role) return interaction.reply({ content: 'Interest role missing. Ask staff to run /setup-klineo.', ephemeral: true });
      if (action === 'add') {
        await member.roles.add(role, `${communityName()} self-selected interest`);
        db.prepare('INSERT OR IGNORE INTO user_interests (user_id, interest, created_at) VALUES (?, ?, ?)').run(member.id, key, now());
      } else {
        await member.roles.remove(role, `${communityName()} interest removed`);
        db.prepare('DELETE FROM user_interests WHERE user_id=? AND interest=?').run(member.id, key);
      }
      const count = Number(db.prepare('SELECT COUNT(*) AS c FROM user_interests WHERE user_id=?').get(member.id)?.c ?? 0);
      db.prepare('UPDATE member_activation SET interests_set=? WHERE user_id=?').run(count > 0 ? 1 : 0, member.id);
      scheduleHealthUpdate(interaction.guild);
      return interaction.reply({ content: `${action === 'add' ? '✅ Added' : 'Removed'} **${def[1]}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'language') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rows = languageRows();
        return interaction.reply({ content: rows.length ? `**Available ${communityName()} languages**\n${rows.map((r) => `${r.emoji || '🌐'} <@&${r.role_id}>${r.channel_id ? ` → <#${r.channel_id}>` : ''}`).join('\n')}\n\nUse \`/language add role:@LANG...\`.` : 'No language communities have been created yet.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const role = interaction.options.getRole('role', true);
      const row = db.prepare('SELECT * FROM language_roles WHERE role_id=? AND archived=0').get(role.id);
      if (!row) return interaction.editReply('That is not an active LINKO language role.');
      ensureCatalogFromExistingLanguageRoles();
      const entry = languageCatalogFindByInput(row.name);
      if (action === 'add') {
        await member.roles.add(role, `${communityName()} language self-selection`);
        db.prepare('INSERT OR IGNORE INTO member_languages (user_id, role_id, created_at) VALUES (?, ?, ?)').run(member.id, role.id, now());
        if (entry) db.prepare('INSERT OR IGNORE INTO language_preferences (user_id,language_key,selected_at) VALUES (?,?,?)').run(member.id, entry.key, now());
      } else {
        await member.roles.remove(role, `${communityName()} language removed`);
        db.prepare('DELETE FROM member_languages WHERE user_id=? AND role_id=?').run(member.id, role.id);
        if (entry) db.prepare('DELETE FROM language_preferences WHERE user_id=? AND language_key=?').run(member.id, entry.key);
      }
      const count = Number(db.prepare('SELECT COUNT(*) AS c FROM language_preferences WHERE user_id=?').get(member.id)?.c ?? 0);
      db.prepare('UPDATE member_activation SET language_set=? WHERE user_id=?').run(count > 0 ? 1 : 0, member.id);
      scheduleHealthUpdate(interaction.guild);
      return interaction.editReply(`${action === 'add' ? '✅ Joined' : 'Left'} **${row.name}**${row.channel_id && action === 'add' ? ` → <#${row.channel_id}>` : ''}.`);
    }

    if (interaction.commandName === 'suggest') {
      await interaction.deferReply({ ephemeral: true });
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.editReply('Verify yourself first.');
      const title = interaction.options.getString('title', true).trim();
      const details = interaction.options.getString('details', true).trim();
      const result = db.prepare('INSERT INTO product_suggestions (user_id,title,details,created_at) VALUES (?,?,?,?)').run(member.id, title, details, now());
      const id = Number(result.lastInsertRowid);
      const row = db.prepare('SELECT * FROM product_suggestions WHERE id=?').get(id);
      const roadmap = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'product-roadmap' && c.isTextBased());
      const review = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'suggestion-review' && c.isTextBased());
      if (roadmap) {
        const msg = await roadmap.send({ embeds: [buildSuggestionEmbed(row)] });
        db.prepare('UPDATE product_suggestions SET public_message_id=? WHERE id=?').run(msg.id, id);
      }
      if (review) {
        const msg = await review.send({ embeds: [buildSuggestionEmbed(row)], components: [suggestionReviewButtons(id)] });
        db.prepare('UPDATE product_suggestions SET review_message_id=? WHERE id=?').run(msg.id, id);
      }
      scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild);
      return interaction.editReply(`✅ Suggestion **#${id}** submitted. LINKO will keep its public status updated.`);
    }

    if (interaction.commandName === 'events') {
      const rows = db.prepare("SELECT * FROM community_events WHERE status IN ('planned','live') ORDER BY start_at ASC LIMIT 10").all();
      return interaction.reply({ content: rows.length ? `**Upcoming ${communityName()} Events**\n${rows.map((r) => `**#${r.id} ${r.title}** — ${eventStatusLabel(r.status)} — <t:${Math.floor(Number(r.start_at)/1000)}:F>${r.voice_channel_id ? ` — <#${r.voice_channel_id}>` : ''}`).join('\n')}` : `No upcoming ${communityName()} events are scheduled.`, ephemeral: true });
    }

    if (interaction.commandName === 'announce') {
      if (!canPublishAnnouncement(interaction.member)) {
        return interaction.reply({ content: `Only **${coreRoleName()}** or **${teamRoleName()}** can publish official announcements.`, ephemeral: true });
      }

      const title = interaction.options.getString('title')?.trim() || '';
      const body = interaction.options.getString('message')?.trim() || '';
      const image = interaction.options.getAttachment('image');
      if (image && !(image.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(image.name ?? ''))) {
        return interaction.reply({ content: 'The announcement attachment must be an image.', ephemeral: true });
      }

      const links = [];
      for (let n = 1; n <= 3; n++) {
        const raw = interaction.options.getString(`link${n}`);
        const label = interaction.options.getString(`label${n}`)?.trim() || '';
        if (label && !raw) return interaction.reply({ content: `label${n} needs a matching link${n}.`, ephemeral: true });
        if (!raw) continue;
        links.push({ url: announcementUrl(raw), label });
      }
      if (!title && !body && !image && !links.length) {
        return interaction.reply({ content: 'Add at least a title, message, image, or CTA/X link.', ephemeral: true });
      }

      const xOnly = !title && !body && !image && links.length === 1 && isXPostUrl(links[0].url);
      const draftId = interaction.id;
      const draft = {
        guildId: interaction.guildId,
        createdBy: interaction.user.id,
        createdAt: now(),
        title,
        body,
        imageUrl: image?.url || '',
        links,
        xOnly,
      };
      announcementDrafts.set(draftId, draft);

      const preview = buildAnnouncementPayload(draft);
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`announcement_publish:${draftId}`).setLabel('PUBLISH').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`announcement_cancel:${draftId}`).setLabel('CANCEL').setStyle(ButtonStyle.Danger),
      );
      return interaction.reply({
        content: xOnly ? `**Preview · X-only announcement**\n${links[0].url}` : '**Announcement preview**',
        embeds: preview.embeds,
        components: [...preview.components, confirmRow],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'health-card') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const days = interaction.options.getInteger('days') ?? (getSettingInt('health_window_days') || 7);
      await interaction.deferReply({ ephemeral: true });
      const card = await generateHealthCard(interaction.guild, days);
      const file = new AttachmentBuilder(card.buffer, { name: `linko-community-health-${interaction.guildId}-${days}d.png` });
      return interaction.editReply({
        content: `**${communityName()} Community Health card is ready.**\nSuggested caption:\n${card.caption}\n\nThe image contains public-safe community metrics only.`,
        files: [file],
      });
    }

    if (interaction.commandName === 'community-health' || interaction.commandName === 'refresh-health') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const days = interaction.commandName === 'community-health' ? (interaction.options.getInteger('days') ?? (getSettingInt('health_window_days') || 7)) : (getSettingInt('health_window_days') || 7);
      if (interaction.commandName === 'refresh-health') {
        await interaction.deferReply({ ephemeral: true });
        await updateCommunityHealthDashboard(interaction.guild, days);
        return interaction.editReply('✅ Community-health dashboard refreshed.');
      }
      return interaction.reply({ embeds: [buildHealthEmbed(interaction.guild, days)], ephemeral: true });
    }

    if (interaction.commandName === 'mod-inbox') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      return interaction.reply({ embeds: [buildModInboxEmbed()], ephemeral: true });
    }

    if (interaction.commandName === 'event') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      const eventLong = ['create','access','start','end','cancel'].includes(action);
      if (eventLong) await interaction.deferReply({ ephemeral: true });
      if (action === 'create') {
        const title = interaction.options.getString('title', true).trim();
        const startAt = parseEventStartUtc(
          interaction.options.getString('date', true),
          interaction.options.getString('time', true),
        );
        if (startAt < now() - 60000) return interaction.editReply('Event start time must be in the future. Date and time are interpreted as UTC.');
        const duration = interaction.options.getInteger('duration', true);
        const description = interaction.options.getString('description')?.trim() || '';
        const voice = interaction.options.getChannel('voice');
        const access = voice ? (interaction.options.getString('access') || 'everyone') : 'existing';
        const result = db.prepare('INSERT INTO community_events (title,description,start_at,duration_minutes,voice_channel_id,event_access,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(title, description, startAt, duration, voice?.id || null, access, interaction.user.id, now());
        const id = Number(result.lastInsertRowid);
        let row = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
        try {
          await preparePlannedCommunityEventVisibility(interaction.guild, row);
          row = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
          await createNativeScheduledEvent(interaction.guild, row);
          row = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
        } catch (error) {
          const latest = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
          await restoreCommunityEventAccess(interaction.guild, latest).catch(() => {});
          db.prepare('DELETE FROM community_events WHERE id=?').run(id);
          return interaction.editReply(`Could not publish the Discord Scheduled Event. Make sure LINKO has **Manage Events** permission and access to the selected Voice/Stage room. ${String(error?.message ?? error).slice(0, 180)}`);
        }
        const eventsChannel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
        if (eventsChannel) {
          const msg = await eventsChannel.send({ embeds: [buildEventEmbed(row)], components: eventButtons(id, row.status) });
          db.prepare('UPDATE community_events SET public_message_id=? WHERE id=?').run(msg.id, id);
        }
        scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild);
        return interaction.editReply(`✅ Event **#${id} ${title}** published in **Discord Events** and #events.${voice ? ` Room access: **${eventAccessLabel(access)}**.` : ''}`);
      }
      if (action === 'list') {
        const rows = db.prepare("SELECT * FROM community_events WHERE status IN ('planned','live') ORDER BY start_at ASC LIMIT 20").all();
        return interaction.reply({ content: rows.length ? rows.map((r) => `#${r.id} **${r.title}** — ${eventStatusLabel(r.status)} — <t:${Math.floor(Number(r.start_at)/1000)}:F>${r.voice_channel_id ? ` — ${eventAccessLabel(r.event_access)}` : ''}`).join('\n') : 'No upcoming/live events.', ephemeral: true });
      }
      const id = interaction.options.getInteger('id', true);
      const row = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);      if (!row) return eventLong ? interaction.editReply('Event not found.') : interaction.reply({ content: 'Event not found.', ephemeral: true });
      if (action === 'access') {
        if (!row.voice_channel_id) return interaction.editReply('This event has no Voice/Stage room.');
        if (!['planned','live'].includes(row.status)) return interaction.editReply(`Event is already **${eventStatusLabel(row.status)}**.`);
        const access = interaction.options.getString('type', true);
        if (row.status === 'planned') {
          if (row.permission_snapshot_json && row.event_access === 'everyone') await restoreCommunityEventAccess(interaction.guild, row);
          db.prepare('UPDATE community_events SET event_access=?, permissions_restored_at=NULL WHERE id=?').run(access, id);
          const updated = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
          if (access === 'everyone') await preparePlannedCommunityEventVisibility(interaction.guild, updated);
        } else if (access === 'existing') {
          await restoreCommunityEventAccess(interaction.guild, row);
          db.prepare('UPDATE community_events SET event_access=? WHERE id=?').run(access, id);
        } else {
          db.prepare('UPDATE community_events SET event_access=? WHERE id=?').run(access, id);
          const updated = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
          await applyCommunityEventAccess(interaction.guild, updated);
        }
        await updateEventMessage(interaction.guild, id);
        return interaction.editReply(`✅ Event **#${id} ${row.title}** room access → **${eventAccessLabel(access)}**.${row.status === 'live' ? ' Applied immediately.' : ' It will apply when the event starts.'}`);
      }
      if (action === 'start') {
        if (!['planned'].includes(row.status)) return interaction.editReply(`Event is already **${eventStatusLabel(row.status)}**.`);
        if (row.voice_channel_id) {
          const channel = interaction.guild.channels.cache.get(row.voice_channel_id);
          if (!channel) return interaction.editReply('Event Voice/Stage room is missing.');
          const activeVoice = getActiveVoiceEvent();
          if (activeVoice) return interaction.editReply(`Another official voice event is already active: **${activeVoice.name}**.`);
          try {
            await applyCommunityEventAccess(interaction.guild, row);
            await startVoiceEvent(interaction.guild, channel, row.title, interaction.user.id);
          } catch (error) {
            const latest = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
            await restoreCommunityEventAccess(interaction.guild, latest).catch(() => {});
            throw error;
          }
        }
        db.prepare('UPDATE community_events SET status=?, started_at=? WHERE id=?').run('live', now(), id);
        const liveRow = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
        await syncNativeScheduledEventStatus(interaction.guild, liveRow, GuildScheduledEventStatus.Active).catch((error) => logLinkoError('native-event-start', error));
        await updateEventMessage(interaction.guild, id); scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild);
        return interaction.editReply(`🔴 Event **#${id} ${row.title}** is now LIVE.${row.voice_channel_id ? ` Official voice ${xpLabel()} is active.` : ''}`);
      }
      if (action === 'end') {
        await endCommunityEvent(interaction.guild, id, interaction.user.id, false);
        return interaction.editReply(`✅ Event **#${id} ${row.title}** ended.`);
      }
      if (action === 'cancel') {
        if (!['planned','live'].includes(row.status)) return interaction.editReply(`Event is already **${eventStatusLabel(row.status)}**.`);
        if (row.status === 'live') {
          const active = getActiveVoiceEvent();
          if (active && row.voice_channel_id && active.channel_id === row.voice_channel_id) await stopVoiceEvent().catch(() => {});
        }
        await restoreCommunityEventAccess(interaction.guild, row).catch((error) => logLinkoError('event-permission-restore', error));
        db.prepare('UPDATE community_events SET status=?, ended_at=? WHERE id=?').run('cancelled', now(), id);
        const cancelledRow = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
        await syncNativeScheduledEventStatus(interaction.guild, cancelledRow, GuildScheduledEventStatus.Canceled).catch((error) => logLinkoError('native-event-cancel', error));
        await updateEventMessage(interaction.guild, id); scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild);
        return interaction.editReply(`Cancelled event **#${id} ${row.title}**.`);
      }
      if (action === 'attendance') {
        const attendees = db.prepare('SELECT * FROM event_attendance WHERE event_id=? ORDER BY minutes DESC, user_id LIMIT 50').all(id);
        return interaction.reply({ content: attendees.length ? `**Attendance · #${id} ${row.title}**\n${attendees.map((a) => `<@${a.user_id}> — **${a.minutes} min**`).join('\n')}` : 'No recorded voice attendance for this event.', ephemeral: true });
      }
    }

    if (interaction.commandName === 'suggestion') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rows = db.prepare("SELECT * FROM product_suggestions WHERE status NOT IN ('shipped','declined') ORDER BY id DESC LIMIT 20").all();
        return interaction.reply({ content: rows.length ? rows.map((r) => `#${r.id} **${r.title}** — ${suggestionStatusLabel(r.status)} — <@${r.user_id}>`).join('\n') : 'No open suggestions.', ephemeral: true });
      }
      const id = interaction.options.getInteger('id', true);
      const status = interaction.options.getString('status', true);
      const note = interaction.options.getString('note')?.trim() || '';
      await interaction.deferReply({ ephemeral: true });
      await setSuggestionStatus(interaction.guild, id, status, interaction.user.id, note);
      return interaction.editReply(`✅ Suggestion #${id} → **${suggestionStatusLabel(status)}**.`);
    }

    if (interaction.commandName === 'language-manager') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rows = languageRows();
        return interaction.reply({ content: rows.length ? rows.map((r) => `${r.emoji || '🌐'} <@&${r.role_id}>${r.channel_id ? ` → <#${r.channel_id}>` : ''}`).join('\n') : 'No language communities configured.', ephemeral: true });
      }
      if (action === 'create') {
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.options.getString('name', true).trim();
        const emoji = interaction.options.getString('emoji', true).trim();
        const slug = interaction.options.getString('slug', true);
        const created = await createLanguageCommunity(interaction.guild, { name, emoji, slug, actorId: interaction.user.id, actorTag: interaction.user.tag });
        return interaction.editReply(created.existed
          ? `ℹ️ ${created.row.emoji || '🌐'} **${created.row.name}** already exists${created.channel ? ` → ${created.channel}` : ''}.`
          : `✅ Created ${created.entry.emoji} **${created.entry.name}** → ${created.channel}. Preferred-language members were enrolled automatically.`);
      }
      await interaction.deferReply({ ephemeral: true });
      const role = interaction.options.getRole('role', true);
      const row = db.prepare('SELECT * FROM language_roles WHERE role_id=? AND archived=0').get(role.id);
      if (!row) return interaction.editReply('That is not an active LINKO language role.');
      const channel = row.channel_id ? interaction.guild.channels.cache.get(row.channel_id) : null;
      if (channel) {
        const archive = await ensureManagedCategory(interaction.guild, 'LANGUAGE ARCHIVE', 'staff');
        await channel.setParent(archive.id, { lockPermissions: false }).catch(() => {});
        await channel.permissionOverwrites.set(accessOverwrites(interaction.guild, 'staff')).catch(() => {});
      }
      db.prepare('UPDATE language_roles SET archived=1 WHERE role_id=?').run(role.id);
      if (row.channel_id) db.prepare('UPDATE managed_channels SET archived=1 WHERE channel_id=?').run(row.channel_id);
      const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name)==='bot-log' && c.isTextBased());
      if (log) await log.send(`📦 ${interaction.user} archived language community **${row.name}**.`).catch(()=>{});
      return interaction.editReply(`Archived language community **${row.name}**. Role kept for audit/history.`);
    }

    if (interaction.commandName === 'channel-manager') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rows = db.prepare('SELECT * FROM managed_channels ORDER BY archived, created_at DESC LIMIT 50').all();
        return interaction.reply({ content: rows.length ? rows.map((r) => `${Number(r.archived) ? '📦' : '✅'} <#${r.channel_id}> — access:${r.access} · links:${Number(r.links_allowed)?'yes':'no'} · ${xpLabel()}:${Number(r.kxp_enabled)?'yes':'no'}`).join('\n') : 'No LINKO-managed extra channels yet.', ephemeral: true });
      }
      if (action === 'batch-create') {
        await interaction.deferReply({ ephemeral: true });
        const rawNames = interaction.options.getString('names', true);
        const names = rawNames.split(',').map((name) => name.trim()).filter(Boolean);
        if (!names.length) return interaction.editReply('Provide at least one channel name.');
        if (names.length > 10) return interaction.editReply('Batch creation is capped at **10 channels** per command.');
        const normalized = names.map((name) => name.toLowerCase());
        if (new Set(normalized).size !== normalized.length) return interaction.editReply('Remove duplicate channel names from the batch.');

        const categoryName = interaction.options.getString('category', true);
        const type = interaction.options.getString('type', true);
        const access = interaction.options.getString('access', true);
        const emoji = interaction.options.getString('emoji')?.trim() || (type === 'voice' ? '🔊' : '💬');
        const topic = interaction.options.getString('topic')?.trim() || '';
        const links = interaction.options.getBoolean('links') ?? false;
        const kxp = interaction.options.getBoolean('kxp') ?? false;
        const slowmode = interaction.options.getInteger('slowmode') ?? 0;
        const category = await ensureManagedCategory(interaction.guild, categoryName, access);
        const perms = type === 'voice' ? accessVoiceOverwrites(interaction.guild, access) : accessOverwrites(interaction.guild, access);
        const created = [];
        const failed = [];

        for (const name of names) {
          try {
            const displayName = type === 'voice' ? `${emoji} ${name.trim().slice(0,45)}` : `${emoji}・${slugifyChannelName(name)}`;
            const channel = await interaction.guild.channels.create({
              name: displayName,
              type: type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
              parent: category.id,
              topic: type === 'text' ? topic : undefined,
              rateLimitPerUser: type === 'text' ? slowmode : undefined,
              permissionOverwrites: perms,
              reason: `LINKO batch channel manager by ${interaction.user.tag}`,
            });
            db.prepare('INSERT INTO managed_channels (channel_id,category_name,access,links_allowed,kxp_enabled,created_by,created_at,archived) VALUES (?,?,?,?,?,?,?,0)')
              .run(channel.id, category.name, access, links ? 1 : 0, kxp ? 1 : 0, interaction.user.id, now());
            created.push(channel);
          } catch (error) {
            failed.push(`${name}: ${String(error?.message ?? error).slice(0, 120)}`);
          }
        }

        const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
        if (log && created.length) {
          await log.send(`🧩 ${interaction.user} batch-created **${created.length}** managed channel(s) · access **${access}** · links **${links ? 'allowed' : 'blocked'}** · ${xpLabel()} **${kxp ? 'on' : 'off'}**.`).catch(() => {});
        }
        const createdText = created.length ? created.map((channel) => channel.toString()).join(', ') : 'none';
        const failedText = failed.length ? `\nFailed: ${failed.join(' | ')}` : '';
        return interaction.editReply(`✅ Created **${created.length}/${names.length}** channel(s): ${createdText}${failedText}`);
      }
      if (action === 'create') {
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.options.getString('name', true);
        const categoryName = interaction.options.getString('category', true);
        const type = interaction.options.getString('type', true);
        const access = interaction.options.getString('access', true);
        const emoji = interaction.options.getString('emoji')?.trim() || (type === 'voice' ? '🔊' : '💬');
        const topic = interaction.options.getString('topic')?.trim() || '';
        const links = interaction.options.getBoolean('links') ?? false;
        const kxp = interaction.options.getBoolean('kxp') ?? false;
        const slowmode = interaction.options.getInteger('slowmode') ?? 0;
        const category = await ensureManagedCategory(interaction.guild, categoryName, access);
        const perms = type === 'voice' ? accessVoiceOverwrites(interaction.guild, access) : accessOverwrites(interaction.guild, access);
        const displayName = type === 'voice' ? `${emoji} ${name.trim().slice(0,45)}` : `${emoji}・${slugifyChannelName(name)}`;
        const channel = await interaction.guild.channels.create({ name: displayName, type: type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText, parent: category.id, topic: type === 'text' ? topic : undefined, rateLimitPerUser: type === 'text' ? slowmode : undefined, permissionOverwrites: perms, reason: `LINKO channel manager by ${interaction.user.tag}` });
        db.prepare('INSERT INTO managed_channels (channel_id,category_name,access,links_allowed,kxp_enabled,created_by,created_at,archived) VALUES (?,?,?,?,?,?,?,0)').run(channel.id, category.name, access, links?1:0, kxp?1:0, interaction.user.id, now());
        const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name)==='bot-log' && c.isTextBased());
        if (log) await log.send(`🧩 ${interaction.user} created managed channel ${channel} · access **${access}** · links **${links?'allowed':'blocked'}** · ${xpLabel()} **${kxp?'on':'off'}**.`).catch(()=>{});
        return interaction.editReply(`✅ Created ${channel}.`);
      }
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.options.getChannel('channel', true);
      const row = db.prepare('SELECT * FROM managed_channels WHERE channel_id=?').get(channel.id);
      if (!row) return interaction.editReply('That channel is not managed by LINKO channel-manager.');
      if (action === 'rename') {
        const name = interaction.options.getString('name', true);
        const prefix = channel.type === ChannelType.GuildVoice ? '🔊 ' : '💬・';
        await channel.setName(channel.type === ChannelType.GuildVoice ? `${prefix}${name.trim().slice(0,45)}` : `${prefix}${slugifyChannelName(name)}`, `LINKO rename by ${interaction.user.tag}`);
        const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name)==='bot-log' && c.isTextBased());
        if (log) await log.send(`✏️ ${interaction.user} renamed managed channel to ${channel}.`).catch(()=>{});
        return interaction.editReply(`✅ Renamed ${channel}.`);
      }
      if (action === 'archive') {
        const archive = await ensureManagedCategory(interaction.guild, 'ARCHIVED', 'staff');
        await channel.setParent(archive.id, { lockPermissions: false });
        await channel.permissionOverwrites.set(accessOverwrites(interaction.guild, 'staff'));
        db.prepare('UPDATE managed_channels SET archived=1 WHERE channel_id=?').run(channel.id);
        const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name)==='bot-log' && c.isTextBased());
        if (log) await log.send(`📦 ${interaction.user} archived managed channel **${channel.name}**.`).catch(()=>{});
        return interaction.editReply(`📦 Archived **${channel.name}**. It is now staff-only.`);
      }
      if (action === 'delete') {
        if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.editReply('Only KLINEO CORE / administrators can permanently delete managed channels.');
        db.prepare('DELETE FROM managed_channels WHERE channel_id=?').run(channel.id);
        await channel.delete(`LINKO permanent delete by ${interaction.user.tag}`);
        return interaction.editReply('🗑️ Managed channel permanently deleted.');
      }
    }

    if (interaction.commandName === 'creator-campaign') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rows = creatorCampaigns();
        const text = rows.length ? rows.slice(0, 25).map((c) => `**#${c.id}** · ${c.name} · ${String(c.status).toUpperCase()}${c.description ? `\n${c.description}` : ''}`).join('\n\n') : 'No creator campaigns yet.';
        return interaction.reply({ content: text, ephemeral: true });
      }
      if (action === 'create') {
        const name = interaction.options.getString('name', true).trim();
        const description = interaction.options.getString('description')?.trim() || '';
        const result = db.prepare('INSERT INTO creator_campaigns (name, description, status, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(name, description, 'active', interaction.user.id, now());
        const id = Number(result.lastInsertRowid);
        await updateCampaignLeaderboardMessages(interaction.guild);
        return interaction.reply({ content: `✅ Created creator campaign **#${id} · ${name}**. KREATORs can tag approved posts with \`/submit-content social campaign:${id}\`.`, ephemeral: true });
      }
      if (action === 'close') {
        const id = interaction.options.getInteger('campaign', true);
        const campaign = creatorCampaignById(id);
        if (!campaign) return interaction.reply({ content: `Campaign #${id} does not exist.`, ephemeral: true });
        if (campaign.status === 'closed') return interaction.reply({ content: `Campaign #${id} is already closed.`, ephemeral: true });
        db.prepare("UPDATE creator_campaigns SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), id);
        await updateCampaignLeaderboardMessages(interaction.guild);
        return interaction.reply({ content: `✅ Closed creator campaign **#${id} · ${campaign.name}**. Its leaderboard is frozen and will remain visible for **${getSettingInt('campaign_leaderboard_retention_days')} days**. KREATOR lifetime + overall ${xpLabel()} remain permanent.`, ephemeral: true });
      }
    }

    if (interaction.commandName === 'give-xp') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason', true);
      const total = await addXp(interaction.guild, user.id, amount, reason, interaction.user.id);
      return interaction.reply({ content: `${amount >= 0 ? 'Awarded' : 'Adjusted'} ${user}: ${amount >= 0 ? '+' : ''}${amount} ${xpLabel()}. New total: **${total} ${xpLabel()}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'remove-xp') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason', true);
      const total = await addXp(interaction.guild, user.id, -amount, `Removed by staff: ${reason}`, interaction.user.id);
      return interaction.reply({ content: `Removed **${amount} ${xpLabel()}** from ${user}. New total: **${total} ${xpLabel()}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'user-kxp') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const b = getKxpBreakdown(user.id);
      const rank = rankForXp(b.total);
      return interaction.reply({ content: `**USER ${xpLabel()} REPORT**\nUser: ${user}\nRole: **${rank.name}**\nTotal ${xpLabel()}: **${b.total.toLocaleString()}**\n\nMessages: **${b.messages.toLocaleString()}**\nVoice: **${b.voice.toLocaleString()}**\nServer Boosts: **${b.boosts.toLocaleString()}**\nReferrals: **${b.referrals.toLocaleString()}**\nSocial Posts: **${b.social.toLocaleString()}**\nBug Reports: **${b.bugs.toLocaleString()}**\nProfile / Wallet: **${b.profile.toLocaleString()}**\nManual / Other: **${b.manual.toLocaleString()}**`, ephemeral: true });
    }

    if (interaction.commandName === 'set-boost-count') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const count = interaction.options.getInteger('count', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member || member.user.bot) return interaction.reply({ content: 'Member not found.', ephemeral: true });
      if (count === 0) {
        db.prepare('DELETE FROM booster_overrides WHERE user_id = ?').run(user.id);
        return interaction.reply({ content: `✅ Cleared the multi-boost override for ${user}. LINKO will use Discord's normal active-booster signal.`, ephemeral: true });
      }
      if (!member.premiumSinceTimestamp) return interaction.reply({ content: `${user} is not currently detected by Discord as an active server booster. No override was saved.`, ephemeral: true });
      db.prepare(`INSERT INTO booster_overrides (user_id, boost_count, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET boost_count=excluded.boost_count, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run(user.id, count, now(), interaction.user.id);
      return interaction.reply({ content: `✅ Verified ${user} at **${count} active boost${count === 1 ? '' : 's'}**. Daily reward: **+${count * getSettingInt('kxp_boost_daily')} ${xpLabel()}** while Discord still reports them as actively boosting.`, ephemeral: true });
    }

    if (interaction.commandName === 'referral-stats') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const s = getReferralStats(user.id);
      return interaction.reply({ content: `**REFERRAL REPORT**\nUser: ${user}\nInvited: **${s.total}**\nValid: **${s.valid}**\nTracked invite: **${s.tracked}**\nMember-declared valid: **${s.claimed}**\nModerator-confirmed: **${s.manual}**\nAwaiting inviter confirmation: **${s.awaitingConfirmation}**\nPending total: **${s.pending}**\nReferral ${xpLabel()}: **${s.earned.toLocaleString()}**`, ephemeral: true });
    }

    if (interaction.commandName === 'confirm-referral') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const referredUser = interaction.options.getUser('member', true);
      const inviterUser = interaction.options.getUser('inviter', true);
      if (referredUser.id === inviterUser.id) return interaction.reply({ content: 'A member cannot refer themselves.', ephemeral: true });
      if (referredUser.bot || inviterUser.bot) return interaction.reply({ content: 'Bot accounts cannot be used for referral credit.', ephemeral: true });
      const referred = await interaction.guild.members.fetch(referredUser.id).catch(() => null);
      const inviter = await interaction.guild.members.fetch(inviterUser.id).catch(() => null);
      if (!referred || !inviter) return interaction.reply({ content: `Both members must still be in the ${communityName()} server.`, ephemeral: true });
      if (!hasVerifiedRole(referred)) return interaction.reply({ content: `${referredUser} must be verified before a manual referral can be confirmed.`, ephemeral: true });
      if (!hasVerifiedRole(inviter) && !hasStaffRole(inviter)) return interaction.reply({ content: `${inviterUser} must be a verified ${communityName()} member.`, ephemeral: true });
      const joinedAt = referred.joinedTimestamp ?? db.prepare('SELECT joined_at FROM users WHERE user_id = ?').get(referred.id)?.joined_at ?? now();
      const ageMs = now() - Number(joinedAt);
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (ageMs < sevenDays) {
        const remainingDays = Math.ceil((sevenDays - ageMs) / (24 * 60 * 60 * 1000));
        return interaction.reply({ content: `${referredUser} has not been in ${communityName()} for 7 days yet. About **${remainingDays} day(s)** remain.`, ephemeral: true });
      }
      const activity = referralActivityCount(referred.id, joinedAt);
      const activeDays = referralActivityDays(referred.id, joinedAt);
      if (activity < Math.max(1, getSettingInt('referral_activity_min_events')) || activeDays < Math.max(1, getSettingInt('referral_activity_min_days'))) {
        return interaction.reply({ content: `${referredUser} has been in ${communityName()} for 7 days and is verified, but LINKO still requires activity on at least **${Math.max(1, getSettingInt('referral_activity_min_days'))} different day(s)** before referral validation. Current active days: **${activeDays}**.`, ephemeral: true });
      }
      const existing = db.prepare('SELECT * FROM referrals WHERE member_id = ?').get(referred.id);
      if (existing?.valid_awarded) return interaction.reply({ content: `${referredUser} already has valid referral credit assigned to <@${existing.inviter_id}>. LINKO will not double-credit referrals.`, ephemeral: true });
      if (existing && existing.inviter_id !== inviter.id) return interaction.reply({ content: `${referredUser} is already pending under <@${existing.inviter_id}>. Resolve that attribution before assigning a different inviter.`, ephemeral: true });
      if (existing) {
        db.prepare("UPDATE referrals SET valid_awarded = 1, invite_code = ? WHERE member_id = ?").run(`manual:${interaction.user.id}`, referred.id);
      } else {
        db.prepare('INSERT INTO referrals (member_id, inviter_id, invite_code, joined_at, valid_awarded) VALUES (?, ?, ?, ?, 1)').run(referred.id, inviter.id, `manual:${interaction.user.id}`, joinedAt);
      }
      upsertJoinAttribution(referred.id, { source: 'member', inviterId: inviter.id, detectedInviterId: getJoinAttribution(referred.id)?.detected_inviter_id ?? null, sourceConfirmed: 1, inviterConfirmed: 1 });
      const award = Math.max(0, getSettingInt('kxp_valid_referral'));
      const total = award > 0 ? await addXp(interaction.guild, inviter.id, award, `Moderator-confirmed 7-day referral: <@${referred.id}>`, interaction.user.id) : getXp(inviter.id);
      const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
      if (log) await log.send(`🤝 **Manual referral confirmed** — ${inviterUser} referred ${referredUser}. Confirmed by ${interaction.user}. Joined <t:${Math.floor(Number(joinedAt)/1000)}:R>.`).catch(() => {});
      await updateLeaderboardMessage(interaction.guild, 'referrals');
      return interaction.reply({ content: `✅ Confirmed ${inviterUser} as the inviter of ${referredUser}. **+${award} ${xpLabel()}** awarded. New inviter total: **${total} ${xpLabel()}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'impact-settings') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      return interaction.reply({ content: `**LINKO MESSAGE IMPACT SETTINGS**\nMinimum impact score: **${getSettingInt('impact_min_score')}**\nEvaluation delay: **${getSettingInt('impact_delay_seconds')} sec**\nCandidate window: **${getSettingInt('impact_candidate_window_minutes')} min**\nMinimum words: **${getSettingInt('impact_min_words')}**\nMinimum alphabetic characters: **${getSettingInt('impact_min_alpha_chars')}**\nMessage ${xpLabel()}: **+${getSettingInt('kxp_message')}**\nDaily message-${xpLabel()} cap: **${getSettingInt('message_daily_cap')}**\nAward cooldown: **${getSettingInt('message_cooldown_seconds')} sec**\n\nImpact score = content quality/relevance + distinct meaningful reply + distinct reaction + moderator confirmation. Message bodies are **not stored** in LINKO's database.`, ephemeral: true });
    }

    if (interaction.commandName === 'set-impact') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const key = interaction.options.getString('setting', true);
      const value = interaction.options.getInteger('value', true);
      const allowed = new Set(['impact_min_score','impact_delay_seconds','impact_candidate_window_minutes','impact_min_words','impact_min_alpha_chars']);
      if (!allowed.has(key)) return interaction.reply({ content: 'Unknown impact setting.', ephemeral: true });
      setSetting(key, value);
      return interaction.reply({ content: `✅ Updated **${key}** to **${value}**.`, ephemeral: true });
    }

    if (['impact-status', 'mark-impactful', 'remove-message-xp'].includes(interaction.commandName)) {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const raw = interaction.options.getString('message', true);
      const message = await resolveMessageForStaff(interaction.guild, raw);
      let row = db.prepare('SELECT * FROM message_candidates WHERE message_id = ?').get(message.id);
      if (!row) {
        await ensureCandidateFromMessage(message);
        row = db.prepare('SELECT * FROM message_candidates WHERE message_id = ?').get(message.id);
      }
      if (interaction.commandName === 'impact-status') {
        if (!row) {
          const a = analyzeImpactMessage(message.content);
          return interaction.reply({ content: `**IMPACT STATUS**\nAuthor: ${message.author}\nChannel: ${message.channel}\nCandidate: **NO**\nWords: **${a.words}**\nAlphabetic chars: **${a.alphaChars}**\nHard filter rejected this message, so no automatic message ${xpLabel()} can be earned.`, ephemeral: true });
        }
        return interaction.reply({ content: `**IMPACT STATUS**\nAuthor: ${message.author}\nChannel: ${message.channel}\nBase content score: **${row.base_score}**\nMeaningful replies: **${row.reply_count}**\nDistinct reactions: **${row.reaction_count}**\nModerator bonus: **${row.moderator_bonus}**\nCurrent impact score: **${candidateScore(row)} / ${getSettingInt('impact_min_score')} required**\nAwarded: **${Number(row.awarded) ? 'YES' : 'NO'}**\nRevoked: **${Number(row.revoked) ? 'YES' : 'NO'}**`, ephemeral: true });
      }
      if (interaction.commandName === 'mark-impactful') {
        if (!row) return interaction.reply({ content: 'This message fails the hard anti-spam filter. Use `/give-xp` only if staff intentionally wants to recognize it outside normal message ${xpLabel()}.', ephemeral: true });
        if (Number(row.revoked)) return interaction.reply({ content: 'This message was previously revoked from message ${xpLabel()}.', ephemeral: true });
        if (Number(row.awarded)) return interaction.reply({ content: 'This message already received its message ${xpLabel()}.', ephemeral: true });
        db.prepare('UPDATE message_candidates SET moderator_bonus = MAX(moderator_bonus, 2) WHERE message_id = ?').run(row.message_id);
        row = db.prepare('SELECT * FROM message_candidates WHERE message_id = ?').get(row.message_id);
        const awarded = await awardImpactCandidate(interaction.guild, row, interaction.user.id, true);
        return interaction.reply({ content: awarded ? `✅ Marked ${message.author}'s message as impactful and awarded **+${getSettingInt('kxp_message')} ${xpLabel()}**.` : 'The message was confirmed as impactful, but no ${xpLabel()} could be awarded because the member has reached the daily message cap or is not eligible.', ephemeral: true });
      }
      if (interaction.commandName === 'remove-message-xp') {
        if (!row || !Number(row.awarded) || Number(row.revoked)) return interaction.reply({ content: 'This message does not currently have reversible message ${xpLabel()}.', ephemeral: true });
        const logRow = db.prepare("SELECT amount, created_at FROM xp_log WHERE user_id = ? AND reason LIKE ? AND amount > 0 ORDER BY id DESC LIMIT 1").get(row.user_id, `%:${row.message_id} (%`);
        const amount = Number(logRow?.amount ?? getSettingInt('kxp_message'));
        db.prepare('UPDATE message_candidates SET revoked = 1 WHERE message_id = ?').run(row.message_id);
        if (row.awarded_at) {
          const d = dayKey(Number(row.awarded_at));
          db.prepare('UPDATE daily_xp SET message_xp = MAX(0, message_xp - ?) WHERE user_id = ? AND day = ?').run(amount, row.user_id, d);
        }
        const total = await addXp(interaction.guild, row.user_id, -amount, `Reversed qualified community message:#${message.channel.name}:${message.id}`, interaction.user.id);
        return interaction.reply({ content: `✅ Reversed **${amount} message ${xpLabel()}** from ${message.author}. New total: **${total} ${xpLabel()}**.`, ephemeral: true });
      }
    }

    if (interaction.commandName === 'refresh-leaderboard') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      await updateAllLeaderboards(interaction.guild);
      return interaction.reply({ content: `✅ Overall, Community, referral, KREATOR and campaign leaderboards refreshed.`, ephemeral: true });
    }

    if (interaction.commandName === 'export-leaderboard') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await interaction.guild.members.fetch().catch(() => null);
      const type = interaction.options.getString('type', true);
      const csv = leaderboardCsv(interaction.guild, type);
      const label = type === 'kxp' ? 'overall-leaderboard' : type === 'community' ? 'community-leaderboard' : type === 'creators' ? 'kreator-leaderboard' : type === 'referrals' ? 'referral-leaderboard' : 'full-community';
      const filename = `klineo-${label}-${dayKey()}.csv`;

      // Add a UTF-8 BOM so Excel/Google Sheets open Discord-downloaded CSVs cleanly.
      const csvBuffer = Buffer.from(`\uFEFF${csv}`, 'utf8');
      const previewLines = csv.split(/\r?\n/).slice(0, 11).join('\n');
      const preview = previewLines.length > 1500 ? `${previewLines.slice(0, 1497)}...` : previewLines;

      // Post the actual CSV into the staff-only mod-commands channel instead of
      // attaching it only to an ephemeral reply. This makes the file visible,
      // persistent, and downloadable by staff.
      const exportChannel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'mod-commands' && c.isTextBased());
      if (!exportChannel) {
        return interaction.editReply({ content: '❌ `mod-commands` channel is missing. Run `/setup-klineo confirm:true` after the setup hotfix is installed.' });
      }

      const sent = await exportChannel.send({
        content: `📤 **LINKO Leaderboard Export**\nType: **${label.replaceAll('-', ' ')}**\nRequested by: ${interaction.user}\nGenerated: <t:${Math.floor(Date.now()/1000)}:F>\n\n**Preview (first 10 rows):**\n\`\`\`csv\n${preview}\n\`\`\``,
        files: [{ attachment: csvBuffer, name: filename }],
      });

      return interaction.editReply({ content: `✅ CSV posted in ${exportChannel}. Open the message attachment to download **${filename}**.\n${sent.url}` });
    }

    if (interaction.commandName === 'wallet-admin') {
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'KLINEO CORE / Administrator only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const rows = walletRows(user.id);
      const primary = walletPrimary(user.id);
      const profile = walletProfile(user.id);
      if (!rows.length) return interaction.reply({ content: `${user} has no submitted wallet addresses.`, ephemeral: true });
      const lines = rows.map((r) => {
        const eligible = Number(r.reward_eligible_at) <= now() ? 'Eligible now' : `Eligible <t:${Math.floor(Number(r.reward_eligible_at)/1000)}:R>`;
        return `**${walletNetworkLabel(r.network)}${primary === r.network ? ' · PRIMARY' : ''}**
\`${r.address}\`
Submitted: <t:${Math.floor(Number(r.submitted_at)/1000)}:R> · Updated: <t:${Math.floor(Number(r.updated_at)/1000)}:R> · ${eligible}`;
      }).join('\n\n');
      return interaction.reply({ content: `**SUBMITTED WALLET + SOCIAL REPORT**
Member: ${user}
X: **${profile?.x_account ?? 'Not submitted'}**
Telegram: **${profile?.telegram_account ?? 'Not submitted'}**

${lines}

These are user-submitted public identifiers/addresses. LINKO does not verify wallet ownership and never connects/signs.`, ephemeral: true });
    }

    if (interaction.commandName === 'export-wallets') {
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'KLINEO CORE / Administrator only.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await interaction.guild.members.fetch().catch(() => null);
      const network = interaction.options.getString('network', true);
      const csv = walletsCsv(interaction.guild, network);
      const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `klineo-wallets-${network}-${dayKey()}.csv` });
      const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'wallet-log' && c.isTextBased());
      if (log) await log.send(`📤 **Wallet CSV exported** by ${interaction.user} · scope **${network.toUpperCase()}**`).catch(() => {});
      return interaction.editReply({ content: `✅ Exported submitted wallet addresses (${network.toUpperCase()}). Handle this file as sensitive community data.`, files: [file] });
    }

    if (interaction.commandName === 'refresh-stats') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      await updateServerStats(interaction.guild, true);
      return interaction.reply({ content: '✅ Member and Online counters refreshed.', ephemeral: true });
    }

    if (interaction.commandName === 'project-profile') {
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) {
        return interaction.reply({ content: `Only **${coreRoleName()}** or a server Administrator can manage the Project Profile.`, ephemeral: true });
      }
      const action = interaction.options.getSubcommand();
      if (action === 'view') {
        return interaction.reply({ embeds: [projectProfileSummaryEmbed()], ephemeral: true });
      }
      if (action === 'configure') return showProjectProfileModal(interaction, 'edit');
      if (action === 'details') return showProjectProfileDetailsModal(interaction, 'edit');
      if (action === 'links') return showProjectProfileLinksModal(interaction);
    }

    if (interaction.commandName === 'server-settings') {
      if (!isAdmin(interaction)) return interaction.reply({ content: 'Server owner / Administrator only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'view') {
        const modules = [
          ['Signal Room', 'signal_room'],
          ['KREATOR', 'kreator'],
          ['Founder Hub', 'founder_hub'],
          ['Liquidity Studio', 'liquidity_studio'],
        ].map(([label, key]) => `${moduleEnabled(key) ? '✅' : '⛔'} ${label}`).join('\n');
        return interaction.reply({
          content: `**LINKO SERVER PROFILE**\nCommunity: **${communityName()}**\nDiscord server: **${interaction.guild.name}**\nGuild ID: \`${interaction.guildId}\`\nPreset: **${getSetting('profile_preset') || 'custom'}**\nXP name: **${xpLabel()}**\nCard accent: **${brandAccent()}**\nProject Profile: **${projectProfileComplete() ? 'COMPLETE' : 'NEEDS SETUP'}**\nDatabase: \`${guildDatabasePath(interaction.guildId)}\`\nCampaign board retention: **${getSettingInt('campaign_leaderboard_retention_days')} days**\n\n**Optional modules**\n${modules}\n\nChanges to community name/preset/modules take effect fully after \`/setup-linko confirm:true\`.`,
          ephemeral: true,
        });
      }
      if (action === 'community-name') {
        const name = interaction.options.getString('name', true).trim().replace(/\s+/g, ' ');
        if (name.length < 2 || name.length > 40) return interaction.reply({ content: 'Community name must be 2–40 characters.', ephemeral: true });
        const oldName = communityName();
        const oldUpper = oldName.toUpperCase().slice(0, 40);
        const oldCore = oldName.toLowerCase() === 'klineo' ? 'KLINEO CORE' : 'COMMUNITY CORE';
        const oldTeam = oldName.toLowerCase() === 'klineo' ? 'KLINEO TEAM' : 'COMMUNITY TEAM';
        setSetting('community_name', name);
        setSetting('profile_preset', 'custom');
        const newCore = coreRoleName(), newTeam = teamRoleName();
        const coreRole = interaction.guild.roles.cache.find((r) => r.name === oldCore && !r.managed);
        const teamRole = interaction.guild.roles.cache.find((r) => r.name === oldTeam && !r.managed);
        if (coreRole && oldCore !== newCore) await coreRole.setName(newCore, 'LINKO community profile rename').catch(() => {});
        if (teamRole && oldTeam !== newTeam) await teamRole.setName(newTeam, 'LINKO community profile rename').catch(() => {});
        const oldCommunity = interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === `💬・${oldUpper} COMMUNITY`);
        const oldSocial = interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === `📣・${oldUpper} SOCIAL`);
        if (oldCommunity && oldCommunity.name !== categoryName('community')) await oldCommunity.setName(categoryName('community'), 'LINKO community profile rename').catch(() => {});
        if (oldSocial && oldSocial.name !== categoryName('social')) await oldSocial.setName(categoryName('social'), 'LINKO community profile rename').catch(() => {});
        return interaction.reply({ content: `✅ Community display name set to **${name}**. Existing core/team roles and branded categories were renamed where possible. Run \`/setup-linko confirm:true\` to sync the rest.`, ephemeral: true });
      }
      if (action === 'xp-name') {
        const requested = interaction.options.getString('name', true);
        const label = normalizeXpLabel(requested);
        if (!label) return interaction.reply({ content: 'XP name must contain **1 to 6 letters only**. Examples: `KXP`, `DOTXP`, `XP`.', ephemeral: true });
        const oldLabel = xpLabel();
        setSetting('xp_label', label);
        const xpCategory = interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === `⚡・${oldLabel}`);
        if (xpCategory && xpCategory.name !== categoryName('kxp')) await xpCategory.setName(categoryName('kxp'), 'LINKO XP label rename').catch(() => {});
        await updatePublicKxpDocs(interaction.guild).catch(() => {});
        await updateAllLeaderboards(interaction.guild).catch(() => {});
        return interaction.reply({ content: `✅ This server's XP is now called **${label}**. Existing point balances are unchanged, and the XP category was renamed where possible.`, ephemeral: true });
      }
      if (action === 'brand-color') {
        const accent = normalizeBrandAccent(interaction.options.getString('hex', true));
        if (!accent) return interaction.reply({ content: 'Brand color must be a valid 6-digit hex value, for example **#FF5A1F**.', ephemeral: true });
        setSetting('brand_accent', accent);
        return interaction.reply({ content: `✅ Shareable LINKO cards for this server will now use **${accent}** as the accent color. The Discord server icon is used automatically as the card logo.`, ephemeral: true });
      }
      if (action === 'preset') {
        const preset = interaction.options.getString('type', true);
        applyServerPreset(preset);
        if (!getSetting('community_name')) setSetting('community_name', interaction.guild.name);
        return interaction.reply({ content: preset === 'klineo'
          ? '✅ Applied **KlineO Full** preset: Signal Room, KREATOR, Founder Hub and Liquidity Studio enabled. Run `/setup-linko confirm:true` to sync.'
          : '✅ Applied **Core Community** preset: core XP/referrals/events + Signal Room enabled; KREATOR, Founder Hub and Liquidity Studio disabled by default. Use `/server-settings module` to add what you need, then run `/setup-linko confirm:true`.', ephemeral: true });
      }
      if (action === 'module') {
        const key = interaction.options.getString('name', true);
        const enabled = interaction.options.getBoolean('enabled', true);
        const allowed = new Set(['signal_room', 'kreator', 'founder_hub', 'liquidity_studio']);
        if (!allowed.has(key)) return interaction.reply({ content: 'Unknown module.', ephemeral: true });
        setSetting(`module_${key}`, enabled ? 1 : 0);
        if (key === 'liquidity_studio' && enabled) setSetting('module_founder_hub', 1);
        if (key === 'founder_hub' && !enabled) setSetting('module_liquidity_studio', 0);
        setSetting('profile_preset', 'custom');
        return interaction.reply({ content: `✅ Module **${key.replaceAll('_', ' ')}** is now **${enabled ? 'ENABLED' : 'DISABLED'}**.${key === 'liquidity_studio' && enabled ? ' Founder Hub was enabled automatically.' : ''}${key === 'founder_hub' && !enabled ? ' Liquidity Studio was disabled automatically.' : ''} Run \`/setup-linko confirm:true\` to sync the server structure.`, ephemeral: true });
      }
    }

    if (interaction.commandName === 'xp-settings' || interaction.commandName === 'kxp-settings') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const active = getActiveVoiceEvent();
      const label = xpLabel();
      return interaction.reply({ content: `**${interaction.guild.name} ${label} SETTINGS**
Message: **+${getSettingInt('kxp_message')} ${label}**
Official voice listening: **+${getSettingInt('kxp_voice_interval')} ${label} per ${getSettingInt('voice_interval_minutes')} qualifying event minutes**
Official voice speaker: **+${getSettingInt('kxp_voice_speaker_bonus')} ${label} once per event**
Normal voice calls: **attendance only, 0 ${label}**
Server boost: **+${getSettingInt('kxp_boost_daily')} ${label} per active boost per day**
Valid referral: **+${getSettingInt('kxp_valid_referral')} ${label}**
Approved social post: **+${getSettingInt('kxp_social_post')} ${label}**
KREATOR reaction milestone: **+${getSettingInt('creator_reaction_kxp')} ${label} per ${getSettingInt('creator_reaction_threshold')} unique verified reactions** (max ${getSettingInt('creator_reaction_cap')} milestones/post)
Valid bug report: **+${getSettingInt('kxp_bug_report')} ${label}**
First-time X / Telegram / wallet item: **+${getSettingInt('kxp_profile_submission')} ${label}**
Message daily cap: **${getSettingInt('message_daily_cap')} ${label}**
Message cooldown: **${getSettingInt('message_cooldown_seconds')} sec**
Message impact threshold: **${getSettingInt('impact_min_score')}** (evaluated after ${getSettingInt('impact_delay_seconds')} sec)

Voice event: ${active ? `**ACTIVE** — ${active.name} in <#${active.channel_id}>` : '**OFF**'}`, ephemeral: true });
    }

    if (interaction.commandName === 'set-xp' || interaction.commandName === 'set-kxp') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const key = interaction.options.getString('event', true);
      const amount = interaction.options.getInteger('amount', true);
      if (!(key in DEFAULT_SETTINGS) || key === 'xp_label') return interaction.reply({ content: 'Unknown XP reward setting.', ephemeral: true });
      setSetting(key, amount);
      await updatePublicKxpDocs(interaction.guild);
      return interaction.reply({ content: `✅ Updated **${key}** to **${amount} ${xpLabel()}**. Public XP information was refreshed. Run \`/kxp-settings\` to review the current economy.`, ephemeral: true });
    }

    if (interaction.commandName === 'leaderboard-settings') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const board = interaction.options.getString('board');
      const visibility = interaction.options.getString('visibility');
      if (!board && !visibility) {
        return interaction.reply({ content: `**LEADERBOARD SETTINGS**
Overall ${xpLabel()}: **${getSetting('kxp_leaderboard_visibility')}**
Community: **${getSetting('community_leaderboard_visibility')}**
Referrals: **${getSetting('referral_leaderboard_visibility')}**
KREATOR: **${getSetting('creator_leaderboard_visibility')}**
Creator Campaigns: **${getSetting('campaign_leaderboard_visibility')}**

Public = visible to verified members. Private = visible only to staff.`, ephemeral: true });
      }
      if (!board || !visibility) return interaction.reply({ content: 'Choose both **board** and **visibility**, or leave both blank to view current settings.', ephemeral: true });
      setSetting(leaderboardVisibilityKey(board), visibility);
      await setLeaderboardChannelVisibility(interaction.guild, board, visibility);
      if (board === 'campaign') await updateCampaignLeaderboardMessages(interaction.guild);
      else await updateLeaderboardMessage(interaction.guild, board);
      const boardLabel = board === 'kxp' ? `Overall ${xpLabel()}` : board === 'community' ? 'Community' : board === 'referrals' ? 'Referral' : board === 'creators' ? 'KREATOR' : 'Creator Campaign';
      return interaction.reply({ content: `✅ ${boardLabel} leaderboard is now **${visibility.toUpperCase()}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'voice-event') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      const label = xpLabel();
      if (action === 'status') {
        const active = getActiveVoiceEvent();
        return interaction.reply({ content: active ? `🎙️ **Voice ${label} event active**
Event: **${active.name}**
Channel: <#${active.channel_id}>
Started: <t:${Math.floor(active.started_at / 1000)}:R>
Listening reward: **+${getSettingInt('kxp_voice_interval')} ${label} / ${getSettingInt('voice_interval_minutes')} qualifying minutes**
Speaker bonus: **+${getSettingInt('kxp_voice_speaker_bonus')} ${label} once/event**` : `No voice ${label} event is active.`, ephemeral: true });
      }
      if (action === 'start') {
        const channel = interaction.options.getChannel('channel', true);
        const name = interaction.options.getString('name', true).trim();
        const id = await startVoiceEvent(interaction.guild, channel, name, interaction.user.id);
        const eventsChannel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
        if (eventsChannel) await eventsChannel.send(`🎙️ **Official voice event started:** ${name}\nJoin <#${channel.id}>. Verified members earn **+${getSettingInt('kxp_voice_interval')} ${label} per ${getSettingInt('voice_interval_minutes')} qualifying minutes** while this event is active. At least 2 real users must be present. Participating speakers can earn **+${getSettingInt('kxp_voice_speaker_bonus')} ${label} once per event**. Normal voice calls outside an official event earn **0 ${label}**.`).catch(() => {});
        return interaction.reply({ content: `✅ Voice ${label} event #${id} started in ${channel}.`, ephemeral: true });
      }
      if (action === 'speaker') {
        const active = getActiveVoiceEvent();
        if (!active) return interaction.reply({ content: `No voice ${label} event is active.`, ephemeral: true });
        const user = interaction.options.getUser('member', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Member is not available in this server.', ephemeral: true });
        const result = await awardOfficialSpeakerBonus(interaction.guild, active, member, interaction.user.id, false);
        return interaction.reply({ content: result.awarded ? `✅ Awarded **+${result.amount} ${label}** speaker participation bonus to ${member}.` : `No speaker bonus awarded: ${result.reason}`, ephemeral: true });
      }
      if (action === 'stop') {
        const ended = await stopVoiceEvent();
        if (!ended) return interaction.reply({ content: `No voice ${label} event is active.`, ephemeral: true });
        const eventsChannel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
        if (eventsChannel) await eventsChannel.send(`⏹️ **Official voice event ended:** ${ended.name}`).catch(() => {});
        return interaction.reply({ content: `✅ Voice ${label} event **${ended.name}** stopped. Voice time no longer earns ${label}.`, ephemeral: true });
      }
    }

    if (interaction.commandName === 'server-image') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'status') {
        const lines = Object.entries(IMAGE_SLOTS).map(([slot, key]) => `${slot}: **${getSetting(key) ? 'SET' : 'NOT SET'}**`);
        return interaction.reply({ content: `**KLINEO SECTION IMAGES**\n${lines.join('\n')}`, ephemeral: true });
      }
      const slot = interaction.options.getString('slot', true);
      if (!(slot in IMAGE_SLOTS)) return interaction.reply({ content: 'Unknown image slot.', ephemeral: true });
      if (action === 'clear') {
        setSetting(IMAGE_SLOTS[slot], '');
        await refreshBrandMessages(interaction.guild);
        return interaction.reply({ content: `✅ Cleared the **${slot}** image. The placeholder is visible again.`, ephemeral: true });
      }
      const attachment = interaction.options.getAttachment('image', true);
      if (attachment.contentType && !attachment.contentType.startsWith('image/')) return interaction.reply({ content: 'Please upload an image file (PNG/JPG/WEBP).', ephemeral: true });
      setSetting(IMAGE_SLOTS[slot], attachment.url);
      await refreshBrandMessages(interaction.guild);
      return interaction.reply({ content: `✅ Updated the **${slot}** image and refreshed the live ${communityName()} message.`, ephemeral: true });
    }

    if (interaction.commandName === 'social-card') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first in #verify.', ephemeral: true });
      const type = interaction.options.getString('type', true);
      if (type === 'founder' && !moduleEnabled('founder_hub')) return interaction.reply({ content: 'Founder cards are disabled because the Founder Hub module is off.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const card = await generateSocialCard(interaction.guild, member, type);
      const file = new AttachmentBuilder(card.buffer, { name: `linko-${type}-${interaction.user.id}.png` });
      const submitLine = moduleEnabled('kreator') ? `\n\nIf the post is about ${communityName()}, submit its URL with \`/submit-content social\` for review.` : '';
      return interaction.editReply({ content: `**Your ${card.title} is ready.**\nSuggested caption:\n${card.caption}\n\nShare the image on your socials.${submitLine}`, files: [file] });
    }

    if (interaction.commandName === 'official-links') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'view') {
        return interaction.reply({ embeds: [buildOfficialLinksEmbed()], ephemeral: true });
      }
      if (action === 'publish') {
        await publishOfficialLinks(interaction.guild);
        return interaction.reply({ content: '✅ Official Links card refreshed.', ephemeral: true });
      }
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: `Only **${coreRoleName()}** / server administrators can change official links.`, ephemeral: true });
      const type = interaction.options.getString('type', true);
      const key = officialLinkKey(type);
      if (!key) return interaction.reply({ content: 'Unknown official link type.', ephemeral: true });
      if (action === 'remove') {
        setSetting(key, '');
        await publishOfficialLinks(interaction.guild);
        return interaction.reply({ content: `✅ Removed the official **${OFFICIAL_LINKS[type][1]}** link.`, ephemeral: true });
      }
      const url = interaction.options.getString('url', true).trim();
      if (!officialLinkUrlValid(url)) return interaction.reply({ content: 'Official links must be valid HTTPS URLs.', ephemeral: true });
      setSetting(key, url);
      await publishOfficialLinks(interaction.guild);
      return interaction.reply({ content: `✅ Updated **${OFFICIAL_LINKS[type][1]}** and refreshed #official-links.`, ephemeral: true });
    }

    if (interaction.commandName === 'team-profile') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rows = teamProfiles();
        const text = rows.length ? rows.map((r) => `<@${r.user_id}> — **${r.role_title}**`).join('\n') : 'No official founder/team profiles configured yet.';
        return interaction.reply({ content: text, ephemeral: true });
      }
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: `Only **${coreRoleName()}** / server administrators can change official team profiles.`, ephemeral: true });
      const user = interaction.options.getUser('member', true);
      if (action === 'remove') {
        db.prepare('DELETE FROM team_profiles WHERE user_id = ?').run(user.id);
        await publishOfficialLinks(interaction.guild);
        return interaction.reply({ content: `✅ Removed ${user} from the official team profiles.`, ephemeral: true });
      }
      const roleTitle = interaction.options.getString('role', true).trim();
      const vals = ['website', 'x', 'linkedin', 'telegram'].map((k) => interaction.options.getString(k)?.trim() || '');
      for (const v of vals) if (v && !officialLinkUrlValid(v)) return interaction.reply({ content: 'Team profile links must be valid HTTPS URLs.', ephemeral: true });
      db.prepare(`INSERT INTO team_profiles (user_id, role_title, website, x, linkedin, telegram, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET role_title=excluded.role_title, website=excluded.website, x=excluded.x,
        linkedin=excluded.linkedin, telegram=excluded.telegram, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run(user.id, roleTitle, vals[0], vals[1], vals[2], vals[3], now(), interaction.user.id);
      await publishOfficialLinks(interaction.guild);
      return interaction.reply({ content: `✅ Updated official team profile for ${user} and refreshed #official-links.`, ephemeral: true });
    }

    if (interaction.commandName === 'approve-bug') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const reference = interaction.options.getString('reference') ?? 'staff validated report';
      const award = getSettingInt('kxp_bug_report');
      const total = award > 0 ? await addXp(interaction.guild, user.id, award, `Valid bug report: ${reference}`, interaction.user.id) : getXp(user.id);
      return interaction.reply({ content: `🐞 Approved bug report from ${user}. Awarded **+${award} ${xpLabel()}**. New total: **${total} ${xpLabel()}**.`, ephemeral: true });
    }

    if (interaction.commandName === 'mod-help') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      return interaction.reply({ content: '**LINKO Moderator Commands**\n`/user-kxp` · `/give-xp` · `/remove-xp` · `/set-boost-count` · `/approve-bug` · `/referral-stats` · `/confirm-referral` · `/impact-status` · `/mark-impactful` · `/remove-message-xp` · `/impact-settings` · `/set-impact` · `/kxp-settings` · `/set-kxp` · `/voice-event` · `/leaderboard-settings` · `/creator-campaign` · `/grant-klineo-role` · `/create-client-space` · `/refresh-leaderboard` · `/export-leaderboard` · `/wallet-admin` · `/export-wallets` · `/refresh-stats` · `/server-image` · `/project-profile` · `/official-links` · `/team-profile` · `/community-health` · `/health-card` · `/refresh-health` · `/mod-inbox` · `/event` · `/suggestion` · `/language-manager` · `/channel-manager`', ephemeral: true });
    }

    if (interaction.commandName === 'grant-klineo-role') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const roleName = interaction.options.getString('role', true);
      if (roleName === 'KREATOR' && !moduleEnabled('kreator')) return interaction.reply({ content: 'The KREATOR module is disabled in this server.', ephemeral: true });
      if (roleName === 'KREATOR' && !kreatorProfileApproved(user.id)) return interaction.reply({ content: `Cannot grant **KREATOR** yet. ${user} must submit **/kreator-profile** with primary/secondary socials and follower counts, then staff must approve it.`, ephemeral: true });
      if (roleName === 'VERIFIED FOUNDER' && !moduleEnabled('founder_hub')) return interaction.reply({ content: 'The Founder Hub module is disabled in this server.', ephemeral: true });
      if (roleName === 'STUDIO CLIENT' && !moduleEnabled('liquidity_studio')) return interaction.reply({ content: 'The Liquidity Studio module is disabled in this server.', ephemeral: true });
      const role = interaction.guild.roles.cache.find((r) => r.name === roleName);
      if (!role) return interaction.reply({ content: `Role ${roleName} is missing. Run /setup-linko.`, ephemeral: true });
      const member = await interaction.guild.members.fetch(user.id);
      await member.roles.add(role, `Granted by ${interaction.user.tag}`);
      if (roleName === 'KREATOR') setParticipationLane(member.id, 'kreator');
      await maybeAwardReferralRoleBonus(interaction.guild, member.id, roleName);
      return interaction.reply({ content: `Granted **${roleName}** to ${user}.`, ephemeral: true });
    }

    if (interaction.commandName === 'create-client-space') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const project = sanitizeProjectName(interaction.options.getString('project', true));
      const user = interaction.options.getUser('member', true);
      if (!project) return interaction.reply({ content: 'Invalid project name.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const member = await interaction.guild.members.fetch(user.id);
      const category = await createClientSpace(interaction.guild, project, member);
      return interaction.editReply(`Created **${category.name}** and granted Studio Client to ${user}.`);
    }
  } catch (error) {
    const context = interaction?.commandName ? `/${interaction.commandName}` : (interaction?.customId ? `interaction ${interaction.customId}` : 'interaction handler');
    logLinkoError(context, error);
    const msg = `LINKO error: ${String(error?.message ?? error).slice(0, 1200)}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg }).catch(() => {});
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
  });
});

client.login(TOKEN);