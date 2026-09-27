import 'dotenv/config';
import { mkdirSync, appendFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
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
  ModalBuilder,
  PermissionFlagsBits,
  Partials,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CONFIGURED_GUILD_IDS = String(process.env.GUILD_IDS ?? process.env.GUILD_ID ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const GUILD_IDS = new Set(CONFIGURED_GUILD_IDS);
const PRIMARY_GUILD_ID = String(process.env.PRIMARY_GUILD_ID ?? process.env.GUILD_ID ?? CONFIGURED_GUILD_IDS[0] ?? '').trim();
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


  CREATE TABLE IF NOT EXISTS member_activation (
    user_id TEXT PRIMARY KEY,
    interests_set INTEGER NOT NULL DEFAULT 0,
    language_set INTEGER NOT NULL DEFAULT 0,
    introduced_at INTEGER,
    first_impact_at INTEGER
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
  server_profile_initialized: '0',
  server_name: '',
  server_template: 'community',
  xp_label: 'KXP',
  module_referrals: '1',
  module_events: '1',
  module_kreator: '0',
  module_signals: '0',
  module_founders: '0',
  module_studio: '0',
  module_wallets: '0',
  module_languages: '0',
  module_product: '0',
  kxp_message: '1',
  kxp_voice_interval: '1',
  kxp_valid_referral: '1',
  kxp_social_post: '2',
  creator_reaction_threshold: '100',
  creator_reaction_kxp: '1',
  creator_reaction_cap: '3',
  campaign_leaderboard_retention_days: '7',
  kxp_bug_report: '3',
  kxp_profile_submission: '1',
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
  referral_leaderboard_visibility: 'public',
  creator_leaderboard_visibility: 'public',
  campaign_leaderboard_visibility: 'public',
  image_welcome: '',
  image_verify: '',
  image_social: '',
  image_founder: '',
  image_official: '',
  official_website: 'https://klineo.xyz',
  official_liquidity_studio: 'https://klineo.io',
  official_x: 'https://x.com/klineoxyz',
  official_telegram: '',
  official_linkedin: '',
  official_docs: '',
  official_support: '',
  health_window_days: '7',
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
  ensureSqliteColumn(database, 'social_submissions', 'campaign_id', 'INTEGER');
  ensureSqliteColumn(database, 'social_submissions', 'creator_eligible', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'social_submissions', 'share_message_id', 'TEXT');
  ensureSqliteColumn(database, 'social_submissions', 'reaction_xp_awarded', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn(database, 'social_submissions', 'reaction_milestones_awarded', 'INTEGER NOT NULL DEFAULT 0');

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
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

const PROFILE_MODULES = Object.freeze({
  referrals: 'module_referrals',
  events: 'module_events',
  kreator: 'module_kreator',
  signals: 'module_signals',
  founders: 'module_founders',
  studio: 'module_studio',
  wallets: 'module_wallets',
  languages: 'module_languages',
  product: 'module_product',
});

function xpSlug() {
  return xpLabel().toLowerCase();
}

function xpLeaderboardChannelName() {
  return `🏆・${xpSlug()}-leaderboard`;
}

function howToEarnXpChannelName() {
  return `⚡・how-to-earn-${xpSlug()}`;
}

function xpLeaderboardBase() {
  return baseChannelName(xpLeaderboardChannelName());
}

function howToEarnXpBase() {
  return baseChannelName(howToEarnXpChannelName());
}

function communityName() {
  return String(getSetting('server_name') || 'Community').trim() || 'Community';
}

function communityNameUpper() {
  return communityName().toUpperCase().slice(0, 28);
}

function serverTemplate() {
  return getSetting('server_template') === 'klineo' ? 'klineo' : 'community';
}

function isKlineoTemplate() {
  return serverTemplate() === 'klineo';
}

function moduleEnabled(moduleName) {
  const key = PROFILE_MODULES[moduleName];
  if (!key) return false;
  return getSetting(key) !== '0';
}

function setModuleEnabled(moduleName, enabled) {
  const key = PROFILE_MODULES[moduleName];
  if (!key) throw new Error('Unknown LINKO module');
  setSetting(key, enabled ? '1' : '0');
  if (moduleName === 'studio' && enabled) setSetting(PROFILE_MODULES.founders, '1');
  if (moduleName === 'founders' && !enabled) setSetting(PROFILE_MODULES.studio, '0');
}

function enabledModuleNames() {
  return Object.keys(PROFILE_MODULES).filter((name) => moduleEnabled(name));
}

function genericCoreRoleName() { return 'LINKO CORE'; }
function genericTeamRoleName() { return 'LINKO TEAM'; }
function coreRoleNames() { return ['KLINEO CORE', genericCoreRoleName()]; }
function teamRoleNames() { return ['KLINEO TEAM', genericTeamRoleName()]; }
function staffRoleNames() { return [...coreRoleNames(), ...teamRoleNames(), 'MODERATOR']; }

function ensureServerProfile(guild) {
  if (getSetting('server_profile_initialized') === '1') {
    if (!getSetting('server_name')) setSetting('server_name', guild.name);
    return;
  }
  const primary = String(guild.id) === PRIMARY_GUILD_ID;
  setSetting('server_name', primary ? 'KlineO' : guild.name);
  setSetting('server_template', primary ? 'klineo' : 'community');
  setSetting('xp_label', primary ? 'KXP' : 'XP');
  const allOn = primary;
  for (const name of Object.keys(PROFILE_MODULES)) {
    const enabled = allOn || name === 'referrals' || name === 'events';
    setModuleEnabled(name, enabled);
  }
  if (!primary) {
    for (const key of ['official_website','official_liquidity_studio','official_x','official_telegram','official_linkedin','official_docs','official_support']) setSetting(key, '');
  }
  setSetting('server_profile_initialized', '1');
}

function applyProfilePreset(preset, guild) {
  const normalized = preset === 'klineo' ? 'klineo' : 'community';
  setSetting('server_template', normalized);
  if (normalized === 'klineo') {
    setSetting('server_name', 'KlineO');
    setSetting('xp_label', 'KXP');
    for (const name of Object.keys(PROFILE_MODULES)) setModuleEnabled(name, true);
    if (!getSetting('official_website')) setSetting('official_website', 'https://klineo.xyz');
    if (!getSetting('official_liquidity_studio')) setSetting('official_liquidity_studio', 'https://klineo.io');
    if (!getSetting('official_x')) setSetting('official_x', 'https://x.com/klineoxyz');
  } else {
    if (!getSetting('server_name') || getSetting('server_name') === 'KlineO') setSetting('server_name', guild.name);
    if (xpLabel() === 'KXP') setSetting('xp_label', 'XP');
    for (const name of Object.keys(PROFILE_MODULES)) setModuleEnabled(name, ['referrals','events'].includes(name));
    for (const key of ['official_website','official_liquidity_studio','official_x','official_telegram','official_linkedin','official_docs','official_support']) setSetting(key, '');
  }
  setSetting('server_profile_initialized', '1');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
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
  { key: 'l2', name: 'SCOUT', threshold: 150, color: BRAND.blue },
  { key: 'l3', name: 'ANALYST', threshold: 500, color: BRAND.cyan },
  { key: 'l4', name: 'OPERATOR', threshold: 1200, color: BRAND.emerald },
  { key: 'l5', name: 'STRATEGIST', threshold: 2500, color: BRAND.lime },
  { key: 'l6', name: 'VANGUARD', threshold: 5000, color: BRAND.limeSoft },
  { key: 'l7', name: 'PRIME', threshold: 10000, color: BRAND.white },
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

function genericRoleSpecs() {
  const specs = [
    { key: 'core', name: genericCoreRoleName(), color: BRAND.white, hoist: true, permissions: [PermissionFlagsBits.Administrator] },
    { key: 'team', name: genericTeamRoleName(), color: BRAND.lime, hoist: true, permissions: [] },
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
    { key: 'partner', name: 'PARTNER', color: BRAND.blue, hoist: true, permissions: [] },
    { key: 'ambassador', name: 'AMBASSADOR', color: BRAND.limeSoft, hoist: true, permissions: [] },
  ];
  if (moduleEnabled('kreator')) specs.push({ key: 'creator', name: 'KREATOR', color: 0xA855F7, hoist: true, permissions: [] });
  if (moduleEnabled('founders')) specs.push({ key: 'founder', name: 'VERIFIED FOUNDER', color: BRAND.emerald, hoist: true, permissions: [] });
  if (moduleEnabled('studio')) specs.push({ key: 'studio', name: 'STUDIO CLIENT', color: 0xF59E0B, hoist: true, permissions: [] });
  specs.push(...[...RANKS].reverse().map((rank) => ({ ...rank, hoist: false, permissions: [] })));
  return specs;
}

function profileRoleSpecs() {
  return isKlineoTemplate() ? ROLE_SPECS : genericRoleSpecs();
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
  social: '📣・KLINEO SOCIAL',
  creators: '🎨・CREATOR HUB',
  founders: '🏛️・FOUNDERS HUB',
  studio: '💧・LIQUIDITY STUDIO',
  high: '◆・HIGHER LEVELS',
  voice: '🎙️・VOICE',
  languages: '🌍・LANGUAGES',
  staff: '🛡️・STAFF',
};

const CHANNEL_NAMES = {
  welcome: '👋・welcome', rules: '📜・rules', verify: '✅・verify', links: '🔗・official-links', announcements: '📢・announcements',
  general: '💬・general', marketChat: '📊・market-chat', tradeSetups: '🎯・trade-setups', aiAgentLab: '🤖・ai-agent-lab',
  productUpdates: '🚀・product-updates', productFeedback: '💡・product-feedback', bugReports: '🐞・bug-reports', help: '🆘・help', introductions: '👤・introductions', wins: '🏆・wins-and-learnings',
  howKxp: '⚡・how-to-earn-kxp', botCommands: '🤖・bot-commands', leaderboard: '🏆・kxp-leaderboard', referralLeaderboard: '🤝・referral-leaderboard', rankUps: '📈・rank-ups', referrals: '🤝・referrals', events: '📅・events',
  analystChat: '🧠・analyst-chat', tradeAnalysis: '📉・trade-analysis', marketThesis: '🌐・market-thesis', aiStrategies: '🤖・ai-strategies',
  sharePost: '📣・share-your-post', contentMissions: '🎯・content-missions', creatorLeaderboard: '🏅・kreator-leaderboard', campaignLeaderboard: '🏁・campaign-leaderboard',
  creatorLounge: '🎨・creator-lounge', contentCollabs: '🤝・content-and-collabs', creatorOpportunities: '💼・creator-opportunities',
  founderLobby: '🏛️・founder-lobby', founderDirectory: '📇・founder-directory', liquidityStudio: '💧・liquidity-studio', marketStructure: '📐・market-structure', founderResources: '📚・founder-resources', studioRequests: '📩・studio-requests',
  studioAnnouncements: '📢・studio-announcements', clientSupport: '🆘・client-support',
  strategist: '♟️・strategist-room', vanguard: '🛡️・vanguard-lounge', prime: '💎・prime-room',
  productRoadmap: '🧩・product-roadmap', languageAccess: '🌐・language-access',
  teamChat: '💬・team-chat', modCommands: '🛠️・mod-commands', communityHealth: '📊・community-health', modInbox: '📥・mod-inbox', suggestionReview: '💡・suggestion-review', verificationLog: '✅・verification-log', founderVerification: '🏛️・founder-verification', socialSubmissions: '📣・social-submissions', moderation: '🛡️・moderation', securityAlerts: '🚨・security-alerts', kxpLog: '⚡・kxp-log', walletLog: '🔐・wallet-log', botLog: '🤖・bot-log',
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
const LANGUAGE_ROLE_PREFIX = 'LANG · ';

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
  ['06・FOUNDERS HUB', CATEGORY_NAMES.founders], ['07・LIQUIDITY STUDIO', CATEGORY_NAMES.studio], ['08・HIGHER LEVELS', CATEGORY_NAMES.high],
  ['09・VOICE', CATEGORY_NAMES.voice], ['10・STAFF', CATEGORY_NAMES.staff],
]);
const LEGACY_CHANNEL_NAMES = new Map([
  ['welcome', CHANNEL_NAMES.welcome], ['rules', CHANNEL_NAMES.rules], ['verify', CHANNEL_NAMES.verify], ['official-links', CHANNEL_NAMES.links], ['announcements', CHANNEL_NAMES.announcements],
  ['general', CHANNEL_NAMES.general], ['market-chat', CHANNEL_NAMES.marketChat], ['trade-setups', CHANNEL_NAMES.tradeSetups], ['ai-agent-lab', CHANNEL_NAMES.aiAgentLab],
  ['product-updates', CHANNEL_NAMES.productUpdates], ['product-feedback', CHANNEL_NAMES.productFeedback], ['bug-reports', CHANNEL_NAMES.bugReports], ['help', CHANNEL_NAMES.help], ['introductions', CHANNEL_NAMES.introductions], ['wins-and-learnings', CHANNEL_NAMES.wins],
  ['how-to-earn-kxp', CHANNEL_NAMES.howKxp], ['bot-commands', CHANNEL_NAMES.botCommands], ['leaderboard', CHANNEL_NAMES.leaderboard], ['🏆・leaderboard', CHANNEL_NAMES.leaderboard], ['kxp-leaderboard', CHANNEL_NAMES.leaderboard], ['referral-leaderboard', CHANNEL_NAMES.referralLeaderboard], ['rank-ups', CHANNEL_NAMES.rankUps], ['referrals', CHANNEL_NAMES.referrals], ['events', CHANNEL_NAMES.events],
  ['analyst-chat', CHANNEL_NAMES.analystChat], ['trade-analysis', CHANNEL_NAMES.tradeAnalysis], ['market-thesis', CHANNEL_NAMES.marketThesis], ['ai-strategies', CHANNEL_NAMES.aiStrategies],
  ['share-your-post', CHANNEL_NAMES.sharePost], ['community-directory', '🌐・community-directory'], ['content-missions', CHANNEL_NAMES.contentMissions], ['creator-leaderboard', CHANNEL_NAMES.creatorLeaderboard], ['🏅・creator-leaderboard', CHANNEL_NAMES.creatorLeaderboard], ['kreator-leaderboard', CHANNEL_NAMES.creatorLeaderboard], ['campaign-leaderboard', CHANNEL_NAMES.campaignLeaderboard],
  ['creator-lounge', CHANNEL_NAMES.creatorLounge], ['content-and-collabs', CHANNEL_NAMES.contentCollabs], ['creator-opportunities', CHANNEL_NAMES.creatorOpportunities],
  ['founder-lobby', CHANNEL_NAMES.founderLobby], ['founder-directory', CHANNEL_NAMES.founderDirectory], ['liquidity-studio', CHANNEL_NAMES.liquidityStudio], ['market-structure', CHANNEL_NAMES.marketStructure], ['founder-resources', CHANNEL_NAMES.founderResources], ['studio-requests', CHANNEL_NAMES.studioRequests],
  ['studio-announcements', CHANNEL_NAMES.studioAnnouncements], ['client-support', CHANNEL_NAMES.clientSupport],
  ['strategist-room', CHANNEL_NAMES.strategist], ['vanguard-lounge', CHANNEL_NAMES.vanguard], ['prime-room', CHANNEL_NAMES.prime],
  ['team-chat', CHANNEL_NAMES.teamChat], ['mod-commands', CHANNEL_NAMES.modCommands], ['verification-log', CHANNEL_NAMES.verificationLog], ['profile-submissions', '📇・profile-submissions'], ['founder-verification', CHANNEL_NAMES.founderVerification], ['social-submissions', CHANNEL_NAMES.socialSubmissions], ['moderation', CHANNEL_NAMES.moderation], ['security-alerts', CHANNEL_NAMES.securityAlerts], ['kxp-log', CHANNEL_NAMES.kxpLog], ['wallet-log', CHANNEL_NAMES.walletLog], ['bot-log', CHANNEL_NAMES.botLog],
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

  new SlashCommandBuilder().setName('rank').setDescription('Show your KlineO rank and progress.')
    .addUserOption((o) => o.setName('member').setDescription('Optional member to view.')),
  new SlashCommandBuilder().setName('points').setDescription('Show your server XP balance.')
    .addUserOption((o) => o.setName('member').setDescription('Optional member to view.')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show a KlineO leaderboard.')
    .addStringOption((o) => o.setName('type').setDescription('Leaderboard type').addChoices(
      { name: 'XP Points', value: 'kxp' }, { name: 'Referrals', value: 'referrals' },
      { name: 'Kreators', value: 'creators' }, { name: 'Creator Campaign', value: 'campaign' },
    ))
    .addIntegerOption((o) => o.setName('campaign').setDescription('Campaign ID when viewing a campaign leaderboard').setMinValue(1)),
  new SlashCommandBuilder().setName('invite').setDescription('Create your tracked KlineO invite link.'),
  new SlashCommandBuilder().setName('invites').setDescription('Show your KlineO referral stats.'),
  new SlashCommandBuilder()
    .setName('join-source')
    .setDescription('Required before verification: tell LINKO how you joined KlineO.')
    .addStringOption((o) => o.setName('source').setDescription('How did you find/join KlineO?').setRequired(true).addChoices(
      { name: 'Invited by a KlineO member', value: 'member' },
      { name: 'Found KlineO myself', value: 'organic' },
      { name: 'X / social media', value: 'x' },
      { name: 'Telegram', value: 'telegram' },
      { name: 'Event / AMA', value: 'event' },
      { name: 'Partner / creator', value: 'partner' },
    ))
    .addUserOption((o) => o.setName('member').setDescription('Required only if a KlineO member invited you.')),
  new SlashCommandBuilder()
    .setName('confirm-invited')
    .setDescription('Confirm that you personally invited a pending KlineO member.')
    .addUserOption((o) => o.setName('member').setDescription('The member you invited').setRequired(true)),
  new SlashCommandBuilder()
    .setName('referred-by')
    .setDescription('Legacy shortcut: tell LINKO who invited you.')
    .addUserOption((o) => o.setName('member').setDescription('The KlineO member who invited you').setRequired(true)),
  new SlashCommandBuilder().setName('commands').setDescription('Show the KlineO member command guide.'),

  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your submitted KlineO payout wallet addresses. LINKO never connects or signs.')
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

  new SlashCommandBuilder()
    .setName('submit-post')
    .setDescription('Submit a social post for XP review.')
    .addStringOption((o) => o.setName('platform').setDescription('Platform').setRequired(true).addChoices(
      { name: 'X', value: 'x' }, { name: 'LinkedIn', value: 'linkedin' }, { name: 'YouTube', value: 'youtube' },
      { name: 'TikTok', value: 'tiktok' }, { name: 'Instagram', value: 'instagram' },
    ))
    .addStringOption((o) => o.setName('url').setDescription('Direct URL to your post').setRequired(true))
    .addIntegerOption((o) => o.setName('campaign').setDescription('Optional active Creator Campaign ID').setMinValue(1)),

  new SlashCommandBuilder()
    .setName('creator-campaign')
    .setDescription('Staff: manage KlineO creator campaigns.')
    .addSubcommand((sc) => sc.setName('create').setDescription('Create a creator campaign.')
      .addStringOption((o) => o.setName('name').setDescription('Campaign name').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('description').setDescription('Short campaign brief').setMaxLength(300)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List creator campaigns.'))
    .addSubcommand((sc) => sc.setName('close').setDescription('Close a creator campaign and freeze its board.')
      .addIntegerOption((o) => o.setName('campaign').setDescription('Campaign ID').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('social-card')
    .setDescription('Generate a shareable KlineO social card.')
    .addStringOption((o) => o.setName('type').setDescription('Card type').setRequired(true).addChoices(
      { name: 'Progress', value: 'progress' }, { name: 'Referral', value: 'referral' },
      { name: 'Community Impact', value: 'impact' }, { name: 'Founder', value: 'founder' },
    )),

  new SlashCommandBuilder()
    .setName('official-links')
    .setDescription('Staff: manage verified KlineO official links.')
    .addSubcommand((sc) => sc.setName('view').setDescription('View configured official links.'))
    .addSubcommand((sc) => sc.setName('publish').setDescription('Refresh the public Official Links card.'))
    .addSubcommand((sc) => sc.setName('set').setDescription('Core: set an official KlineO link.')
      .addStringOption((o) => o.setName('type').setDescription('Official link type').setRequired(true).addChoices(
        { name: 'Website', value: 'website' }, { name: 'Liquidity Studio', value: 'liquidity_studio' },
        { name: 'X', value: 'x' }, { name: 'Telegram', value: 'telegram' }, { name: 'LinkedIn', value: 'linkedin' },
        { name: 'Docs', value: 'docs' }, { name: 'Support', value: 'support' },
      ))
      .addStringOption((o) => o.setName('url').setDescription('Verified https:// URL').setRequired(true).setMaxLength(300)))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Core: remove an official KlineO link.')
      .addStringOption((o) => o.setName('type').setDescription('Official link type').setRequired(true).addChoices(
        { name: 'Website', value: 'website' }, { name: 'Liquidity Studio', value: 'liquidity_studio' },
        { name: 'X', value: 'x' }, { name: 'Telegram', value: 'telegram' }, { name: 'LinkedIn', value: 'linkedin' },
        { name: 'Docs', value: 'docs' }, { name: 'Support', value: 'support' },
      ))),

  new SlashCommandBuilder()
    .setName('team-profile')
    .setDescription('Staff: manage official KlineO founder/team profiles.')
    .addSubcommand((sc) => sc.setName('list').setDescription('List configured team profiles.'))
    .addSubcommand((sc) => sc.setName('set').setDescription('Core: add or update an official team profile.')
      .addUserOption((o) => o.setName('member').setDescription('Official KlineO team member').setRequired(true))
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
    .setDescription('Staff: award or deduct XP.')
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

  new SlashCommandBuilder().setName('refresh-leaderboard').setDescription('Staff: refresh both persistent leaderboards now.'),
  new SlashCommandBuilder()
    .setName('export-leaderboard')
    .setDescription('Staff: export the complete leaderboard/community ranking as CSV.')
    .addStringOption((o) => o.setName('type').setDescription('CSV export type').setRequired(true).addChoices(
      { name: 'XP Leaderboard', value: 'kxp' },
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
    .setName('server-settings')
    .setDescription('Administrator: view or change this server\'s LINKO profile.')
    .addSubcommand((sc) => sc.setName('view').setDescription('View server profile, XP name and enabled modules.'))
    .addSubcommand((sc) => sc.setName('name').setDescription('Set the community display name used by LINKO.')
      .addStringOption((o) => o.setName('name').setDescription('Community/server name').setRequired(true).setMinLength(2).setMaxLength(40)))
    .addSubcommand((sc) => sc.setName('xp-name').setDescription('Set the server XP label (1-6 letters).')
      .addStringOption((o) => o.setName('name').setDescription('Example: KXP, DOTXP, XP').setRequired(true).setMinLength(1).setMaxLength(6)))
    .addSubcommand((sc) => sc.setName('preset').setDescription('Apply a safe LINKO module preset.')
      .addStringOption((o) => o.setName('preset').setDescription('Preset').setRequired(true).addChoices(
        { name: 'KlineO full preset', value: 'klineo' },
        { name: 'Generic community preset', value: 'community' },
      )))
    .addSubcommand((sc) => sc.setName('module').setDescription('Enable or disable one optional LINKO module.')
      .addStringOption((o) => o.setName('module').setDescription('Module').setRequired(true).addChoices(
        { name: 'Referrals', value: 'referrals' },
        { name: 'Events', value: 'events' },
        { name: 'KREATOR', value: 'kreator' },
        { name: 'Signals', value: 'signals' },
        { name: 'Founders', value: 'founders' },
        { name: 'Studio', value: 'studio' },
        { name: 'Wallets', value: 'wallets' },
        { name: 'Languages', value: 'languages' },
        { name: 'Product / feedback', value: 'product' },
      ))
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable this module?').setRequired(true))),

  new SlashCommandBuilder().setName('kxp-settings').setDescription('Staff: view current XP earning settings.'),
  new SlashCommandBuilder()
    .setName('set-kxp')
    .setDescription('Staff: change an XP reward value from Discord.')
    .addStringOption((o) => o.setName('event').setDescription('XP event').setRequired(true).addChoices(
      { name: 'Qualifying message', value: 'kxp_message' },
      { name: 'Voice 15-minute interval', value: 'kxp_voice_interval' },
      { name: 'Valid referral', value: 'kxp_valid_referral' },
      { name: 'Approved social post', value: 'kxp_social_post' },
      { name: 'Creator reaction milestone', value: 'creator_reaction_kxp' },
      { name: 'Valid bug report', value: 'kxp_bug_report' },
      { name: 'Profile / wallet first-time submission', value: 'kxp_profile_submission' },
    ))
    .addIntegerOption((o) => o.setName('amount').setDescription('XP amount').setRequired(true).setMinValue(0).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName('leaderboard-settings')
    .setDescription('Staff: view or change leaderboard visibility.')    .addStringOption((o) => o.setName('board').setDescription('Leaderboard').addChoices(
      { name: 'XP Points', value: 'kxp' }, { name: 'Referrals', value: 'referrals' },
      { name: 'Kreators', value: 'creators' }, { name: 'Creator Campaigns', value: 'campaign' },
    ))
    .addStringOption((o) => o.setName('visibility').setDescription('Visibility').addChoices(
      { name: 'Public to verified members', value: 'public' }, { name: 'Private to staff', value: 'private' },
    )),

  new SlashCommandBuilder()
    .setName('voice-event')
    .setDescription('Staff: control official voice events that can earn XP.')
    .addSubcommand((s) => s.setName('start').setDescription('Start voice XP for an official event.')
      .addChannelOption((o) => o.setName('channel').setDescription('Event voice channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
      .addStringOption((o) => o.setName('name').setDescription('Event name').setRequired(true).setMaxLength(80)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the currently active voice XP event.'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the currently active voice XP event.')),

  new SlashCommandBuilder()
    .setName('approve-bug')
    .setDescription('Staff: award the configured XP for a valid bug report.')
    .addUserOption((o) => o.setName('member').setDescription('Member who reported the bug').setRequired(true))
    .addStringOption((o) => o.setName('reference').setDescription('Bug/message reference').setRequired(false).setMaxLength(180)),

  new SlashCommandBuilder()
    .setName('server-image')
    .setDescription('Staff: manage KlineO welcome and section images.')
    .addSubcommand((sc) => sc.setName('set').setDescription('Upload/set an image for a KlineO section.')
      .addStringOption((o) => o.setName('slot').setDescription('Image slot').setRequired(true).addChoices(
        { name: 'Welcome', value: 'welcome' }, { name: 'Verification', value: 'verify' }, { name: 'Official Links', value: 'official' }, { name: 'Social', value: 'social' }, { name: 'Founder Hub', value: 'founder' },
      ))
      .addAttachmentOption((o) => o.setName('image').setDescription('PNG/JPG/WEBP image').setRequired(true)))
    .addSubcommand((sc) => sc.setName('clear').setDescription('Remove a configured section image.')
      .addStringOption((o) => o.setName('slot').setDescription('Image slot').setRequired(true).addChoices(
        { name: 'Welcome', value: 'welcome' }, { name: 'Verification', value: 'verify' }, { name: 'Official Links', value: 'official' }, { name: 'Social', value: 'social' }, { name: 'Founder Hub', value: 'founder' },
      )))
    .addSubcommand((sc) => sc.setName('status').setDescription('Show which KlineO section images are configured.')),

  new SlashCommandBuilder()
    .setName('grant-klineo-role')
    .setDescription('Staff: grant a KlineO access role.')
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

  new SlashCommandBuilder().setName('onboarding').setDescription('Show your KlineO activation checklist.'),

  new SlashCommandBuilder()
    .setName('interest')
    .setDescription('Manage your KlineO interest roles.')
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
    .setDescription('Manage your KlineO language channels.')
    .addSubcommand((sc) => sc.setName('add').setDescription('Join a language community.')
      .addRoleOption((o) => o.setName('role').setDescription('A LANG · role created by LINKO').setRequired(true)))
    .addSubcommand((sc) => sc.setName('remove').setDescription('Leave a language community.')
      .addRoleOption((o) => o.setName('role').setDescription('A LANG · role created by LINKO').setRequired(true)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List available KlineO languages.')),

  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Submit a KlineO product suggestion.')
    .addStringOption((o) => o.setName('title').setDescription('Short suggestion title').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('details').setDescription('What should change and why?').setRequired(true).setMaxLength(1200)),

  new SlashCommandBuilder().setName('events').setDescription('Show upcoming KlineO community events.'),

  new SlashCommandBuilder()
    .setName('community-health')
    .setDescription('Staff: show KlineO community health metrics.')
    .addIntegerOption((o) => o.setName('days').setDescription('Reporting window in days').setMinValue(1).setMaxValue(90)),
  new SlashCommandBuilder().setName('refresh-health').setDescription('Staff: refresh the persistent community-health dashboard.'),
  new SlashCommandBuilder().setName('mod-inbox').setDescription('Staff: show the consolidated LINKO moderation inbox.'),

  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Staff: manage KlineO community events.')
    .addSubcommand((sc) => sc.setName('create').setDescription('Create and publish a KlineO event.')
      .addStringOption((o) => o.setName('title').setDescription('Event title').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('start').setDescription('ISO UTC time, e.g. 2026-09-27T18:00Z').setRequired(true).setMaxLength(40))
      .addIntegerOption((o) => o.setName('duration').setDescription('Duration in minutes').setRequired(true).setMinValue(15).setMaxValue(720))
      .addStringOption((o) => o.setName('description').setDescription('Event description').setMaxLength(1000))
      .addChannelOption((o) => o.setName('voice').setDescription('Optional voice room').addChannelTypes(ChannelType.GuildVoice)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List upcoming/live events.'))
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
    .setDescription('Staff: manage KlineO product suggestions.')
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
    .setDescription('Staff: create or manage KlineO language communities.')
    .addSubcommand((sc) => sc.setName('create').setDescription('Create a language role + private language channel.')
      .addStringOption((o) => o.setName('name').setDescription('Language name, e.g. Deutsch').setRequired(true).setMaxLength(30))
      .addStringOption((o) => o.setName('emoji').setDescription('Flag/emoji, e.g. 🇩🇪').setRequired(true).setMaxLength(12))
      .addStringOption((o) => o.setName('slug').setDescription('Channel slug, e.g. deutsch').setRequired(true).setMaxLength(30)))
    .addSubcommand((sc) => sc.setName('list').setDescription('List configured language communities.'))
    .addSubcommand((sc) => sc.setName('archive').setDescription('Archive a language community.')
      .addRoleOption((o) => o.setName('role').setDescription('LANG · role').setRequired(true))),

  new SlashCommandBuilder()
    .setName('channel-manager')
    .setDescription('Staff: safely create, edit or archive extra KlineO channels.')
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
        { name: 'Verified Founders', value: 'founders' }, { name: 'Studio Clients', value: 'studio' }, { name: 'Kreators', value: 'creators' }, { name: 'Staff Only', value: 'staff' },
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
  const names = coreRoleNames();
  return member?.roles?.cache?.some((r) => names.includes(r.name));
}
function hasStaffRole(member) {
  const names = staffRoleNames();
  return member?.roles?.cache?.some((r) => names.includes(r.name));
}
function hasVerifiedRole(member) { return member?.roles?.cache?.some((r) => r.name === 'VERIFIED MEMBER'); }
function hasKreatorRole(member) { return member?.roles?.cache?.some((r) => r.name === 'KREATOR' || r.name === 'CREATOR'); }
function rankForXp(xp) { return [...RANKS].reverse().find((r) => xp >= r.threshold) ?? RANKS[0]; }
function nextRankForXp(xp) { return RANKS.find((r) => r.threshold > xp) ?? null; }
function ensureUserRow(userId, joinedAt = null) {
  db.prepare(`INSERT INTO users (user_id, xp, joined_at, last_seen_at) VALUES (?, 0, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, joined_at = COALESCE(users.joined_at, excluded.joined_at)`).run(userId, joinedAt, now());
  db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(userId);
}
function getXp(userId) { ensureUserRow(userId); return Number(db.prepare('SELECT xp FROM users WHERE user_id = ?').get(userId)?.xp ?? 0); }
function getDaily(userId) {
  const day = dayKey();
  db.prepare('INSERT OR IGNORE INTO daily_xp (user_id, day) VALUES (?, ?)').run(userId, day);
  return db.prepare('SELECT * FROM daily_xp WHERE user_id = ? AND day = ?').get(userId, day);
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
  const staleCutoff = now() - 48 * 60 * 60 * 1000;
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
  if (!parsed) throw new Error('Use a full Discord message link from this KlineO server.');
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
    ).setFooter({ text: `KlineO Product Suggestion #${row.id}` }).setTimestamp(new Date(row.updated_at || row.created_at));
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
  if (member) await member.send(`💡 Your KlineO suggestion **#${id} — ${row.title}** is now **${suggestionStatusLabel(status)}**.${note ? `\nStaff note: ${note}` : ''}`).catch(() => {});
  scheduleModInboxUpdate(guild); scheduleHealthUpdate(guild);
}
function parseEventStart(raw) {
  const text = String(raw ?? '').trim();
  if (!/(Z|[+-]\d\d:\d\d)$/i.test(text)) throw new Error('Use an ISO time with timezone, e.g. 2026-09-27T18:00Z.');
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) throw new Error('Invalid event start time. Use e.g. 2026-09-27T18:00Z.');
  return ts;
}
function eventRsvpCounts(id) {
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM event_rsvps WHERE event_id = ? GROUP BY status').all(id);
  const out = { going: 0, interested: 0 };
  for (const r of rows) if (r.status in out) out[r.status] = Number(r.c);
  return out;
}
function eventStatusLabel(status) { return ({ planned: 'Scheduled', live: 'LIVE', ended: 'Ended', cancelled: 'Cancelled' })[status] ?? status; }
function buildEventEmbed(row) {
  const counts = eventRsvpCounts(row.id);
  const startSec = Math.floor(Number(row.start_at) / 1000);
  const endSec = Math.floor((Number(row.start_at) + Number(row.duration_minutes) * 60000) / 1000);
  const e = new EmbedBuilder().setColor(row.status === 'live' ? BRAND.lime : row.status === 'cancelled' ? BRAND.rose : row.status === 'ended' ? BRAND.gray : BRAND.cyan)
    .setTitle(`${row.status === 'live' ? '🔴 ' : '📅 '}#${row.id} · ${row.title}`)
    .setDescription(row.description || 'KlineO community event')
    .addFields(
      { name: 'Status', value: `**${eventStatusLabel(row.status)}**`, inline: true },
      { name: 'Starts', value: `<t:${startSec}:F>\n<t:${startSec}:R>`, inline: true },
      { name: 'Ends', value: `<t:${endSec}:t>`, inline: true },
      { name: 'RSVP', value: `✅ Going: **${counts.going}**\n⭐ Interested: **${counts.interested}**`, inline: true },
      ...(row.voice_channel_id ? [{ name: 'Voice room', value: `<#${row.voice_channel_id}>`, inline: true }] : []),
    ).setFooter({ text: `KlineO Event #${row.id}` });
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
  if (!channel || channel.type !== ChannelType.GuildVoice) return;
  for (const member of channel.members.values()) {
    if (member.user.bot || !hasVerifiedRole(member)) continue;
    db.prepare(`INSERT INTO event_attendance (event_id, user_id, first_seen_at, last_seen_at, minutes) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(event_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, minutes = minutes + 1`)
      .run(row.id, member.id, now(), now());
  }
}
async function endCommunityEvent(guild, id, actorId = null, automatic = false) {
  const row = db.prepare('SELECT * FROM community_events WHERE id = ?').get(id);
  if (!row || !['planned','live'].includes(row.status)) return null;
  db.prepare('UPDATE community_events SET status = ?, ended_at = ? WHERE id = ?').run('ended', now(), id);
  const active = getActiveVoiceEvent();
  if (active && row.voice_channel_id && active.channel_id === row.voice_channel_id) await stopVoiceEvent(guild).catch(() => {});
  await updateEventMessage(guild, id);
  const eventsChannel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
  if (eventsChannel) {
    const attendance = db.prepare('SELECT user_id, minutes FROM event_attendance WHERE event_id=? ORDER BY minutes DESC, user_id LIMIT 10').all(id);
    const totalAttendees = Number(db.prepare('SELECT COUNT(*) AS c FROM event_attendance WHERE event_id=?').get(id)?.c ?? 0);
    const rsvp = eventRsvpCounts(id);
    const recap = new EmbedBuilder().setColor(BRAND.emerald).setTitle(`✅ Event Recap · ${row.title}`)
      .setDescription(`${automatic ? 'LINKO closed this event automatically at the scheduled end time.' : 'This KlineO event has ended.'}`)
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
function healthMetrics(guild, days = 7) {
  const cutoff = now() - days * 86400000;
  const humans = guild.members.cache.filter((m) => !m.user.bot);
  const verifiedRole = guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const verified = verifiedRole ? humans.filter((m) => m.roles.cache.has(verifiedRole.id)).size : 0;
  const online = humans.filter((m) => m.presence && m.presence.status !== 'offline').size;
  const joins = Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE joined_at >= ?').get(cutoff)?.c ?? 0);
  const verifications = Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE verified_at >= ?').get(cutoff)?.c ?? 0);
  const contributors = Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM xp_log WHERE created_at >= ? AND amount > 0').get(cutoff)?.c ?? 0);
  const qualifiedMessages = Number(db.prepare("SELECT COUNT(*) AS c FROM xp_log WHERE created_at >= ? AND reason LIKE 'Qualified community message:%' AND amount > 0").get(cutoff)?.c ?? 0);
  const validReferrals = Number(db.prepare("SELECT COUNT(*) AS c FROM xp_log WHERE created_at >= ? AND (reason LIKE 'Valid 7-day referral:%' OR reason LIKE 'Moderator-confirmed 7-day referral:%') AND amount > 0").get(cutoff)?.c ?? 0);
  const social = Number(db.prepare("SELECT COUNT(*) AS c FROM social_submissions WHERE status = 'approved' AND reviewed_at >= ?").get(cutoff)?.c ?? 0);
  const suggestions = Number(db.prepare('SELECT COUNT(*) AS c FROM product_suggestions WHERE created_at >= ?').get(cutoff)?.c ?? 0);
  const eventAttendees = Number(db.prepare(`SELECT COUNT(DISTINCT ea.user_id) AS c FROM event_attendance ea JOIN community_events ce ON ce.id = ea.event_id WHERE COALESCE(ce.ended_at, ce.start_at) >= ?`).get(cutoff)?.c ?? 0);
  const activated = Number(db.prepare(`SELECT COUNT(*) AS c FROM users u LEFT JOIN member_activation a ON a.user_id=u.user_id WHERE u.joined_at >= ? AND u.verified_at IS NOT NULL AND (a.interests_set=1 OR a.language_set=1 OR a.introduced_at IS NOT NULL OR a.first_impact_at IS NOT NULL)`).get(cutoff)?.c ?? 0);
  const activationRate = verifications ? Math.round((activated / verifications) * 100) : 0;
  const rankCounts = Object.fromEntries(RANKS.map((r) => [r.name, 0]));
  for (const m of humans.values()) if (verifiedRole && m.roles.cache.has(verifiedRole.id)) rankCounts[rankForXp(getXp(m.id)).name]++;
  return { days, total: humans.size, verified, online, joins, verifications, contributors, qualifiedMessages, validReferrals, social, suggestions, eventAttendees, activated, activationRate, rankCounts };
}
function buildHealthEmbed(guild, days = 7) {
  const m = healthMetrics(guild, days);
  const ranks = RANKS.map((r) => `${r.name}: **${m.rankCounts[r.name]}**`).join(' · ');
  return new EmbedBuilder().setColor(BRAND.lime).setTitle(`📊 KlineO Community Health · ${days}d`)
    .addFields(
      { name: 'Community', value: `Members: **${m.total}**\nVerified: **${m.verified}**\nOnline now: **${m.online}**`, inline: true },
      { name: `${days}d growth`, value: `New joins: **${m.joins}**\nVerified: **${m.verifications}**\nActivation: **${m.activationRate}%**`, inline: true },
      { name: `${days}d engagement`, value: `Contributors: **${m.contributors}**\nQualified messages: **${m.qualifiedMessages}**\nEvent attendees: **${m.eventAttendees}**`, inline: true },
      { name: 'Growth loops', value: `Valid referrals: **${m.validReferrals}**\nApproved social posts: **${m.social}**\nProduct suggestions: **${m.suggestions}**`, inline: true },
      { name: 'Rank distribution', value: ranks || 'No data' },
    ).setFooter({ text: '[KLINEO-COMMUNITY-HEALTH] · Auto-updated by LINKO' }).setTimestamp();
}
async function updateCommunityHealthDashboard(guild, days = getSettingInt('health_window_days') || 7) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'community-health' && c.isTextBased());
  if (!channel) return;
  await seedMessage(channel, '[KLINEO-COMMUNITY-HEALTH]', { embeds: [buildHealthEmbed(guild, days)] });
}
function scheduleHealthUpdate(guild) {
  scheduleGuildTimeout(healthUpdateTimers, guild, 5000, () => updateCommunityHealthDashboard(guild).catch(console.error));
}
function modInboxCounts() {
  const cutoff = now() - 7 * 86400000;
  return {
    social: Number(db.prepare("SELECT COUNT(*) AS c FROM social_submissions WHERE status='pending'").get()?.c ?? 0),
    founders: Number(db.prepare("SELECT COUNT(*) AS c FROM founder_applications WHERE status='pending'").get()?.c ?? 0),
    suggestions: Number(db.prepare("SELECT COUNT(*) AS c FROM product_suggestions WHERE status IN ('submitted','reviewing')").get()?.c ?? 0),
    impact: Number(db.prepare('SELECT COUNT(*) AS c FROM message_candidates WHERE awarded=0 AND revoked=0 AND created_at >= ?').get(cutoff)?.c ?? 0),
    events: Number(db.prepare("SELECT COUNT(*) AS c FROM community_events WHERE status IN ('planned','live')").get()?.c ?? 0),
    unverified: Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE joined_at >= ? AND verified_at IS NULL').get(cutoff)?.c ?? 0),
    unattributed: Number(db.prepare('SELECT COUNT(*) AS c FROM unattributed_joins WHERE resolved = 0').get()?.c ?? 0),
    pendingInviterConfirmations: Number(db.prepare("SELECT COUNT(*) AS c FROM join_attribution WHERE source = 'member' AND source_confirmed = 1 AND inviter_confirmed = 0").get()?.c ?? 0),
  };
}
function buildModInboxEmbed() {
  const c = modInboxCounts();
  const total = c.social + c.founders + c.suggestions;
  return new EmbedBuilder().setColor(total ? BRAND.rose : BRAND.emerald).setTitle('📥 LINKO Moderator Inbox')
    .setDescription(total ? `**${total} review item${total === 1 ? '' : 's'} need attention.**` : '**No pending review items.**')
    .addFields(
      { name: 'Reviews', value: `Social posts: **${c.social}**\nFounder applications: **${c.founders}**\nProduct suggestions: **${c.suggestions}**`, inline: true },
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
function configuredImage(slot) { return getSetting(IMAGE_SLOTS[slot]) || ''; }
function withImageOrPlaceholder(embed, slot, label) {
  const url = configuredImage(slot);
  if (url) return embed.setImage(url);
  return embed.addFields({ name: '🖼️ Image', value: `**${label} image not uploaded yet.**\nStaff: use \`/server-image set\` and upload the image for this section.` });
}
function buildWelcomeEmbed(channels) {
  const name = communityName();
  const label = xpLabel();
  const referralStep = moduleEnabled('referrals') ? `2. Run \`/join-source\` and tell LINKO how you joined **${name}**\n3. Verify in <#${channels.verify.id}>\n4. Enter as **OBSERVER**` : `2. Verify in <#${channels.verify.id}>\n3. Enter as **OBSERVER**`;
  const optional = [
    moduleEnabled('founders') ? 'Founders can apply with `/apply-founder`.' : '',
    moduleEnabled('kreator') ? 'KREATORs can submit approved social content and compete on creator leaderboards.' : '',
    moduleEnabled('languages') ? 'Use `/language` after verification to join language rooms.' : '',
  ].filter(Boolean).join(' ');
  const e = new EmbedBuilder().setColor(BRAND.lime).setTitle(`Welcome to ${name}`)
    .setDescription(`LINKO powers community access, ranks and participation for **${name}**.\n\n**Start here**\n1. Read <#${channels.rules.id}>\n${referralStep}\n\nEarn **${label}** through the activities enabled by this community. ${optional}\n\n**Security:** ${name} staff will never DM you first asking for funds, seed phrases, private keys or wallet recovery information.`)
    .setFooter({ text: '[LINKO-WELCOME]' });
  return withImageOrPlaceholder(e, 'welcome', 'Welcome');
}

function buildVerifyEmbed() {
  const name = communityName();
  const referralText = moduleEnabled('referrals') ? 'Before verification, run **/join-source** and tell LINKO how you joined. Then ' : '';
  const e = new EmbedBuilder().setColor(BRAND.lime).setTitle(`Verify & enter ${name}`)
    .setDescription(`${referralText}complete verification to unlock the community and receive **OBSERVER**.\n\nBy verifying, you confirm that you have read the rules and understand that ${name} staff will never ask for your seed phrase, private key, or funds via unsolicited DM.`)
    .setFooter({ text: '[LINKO-VERIFY]' });
  return withImageOrPlaceholder(e, 'verify', 'Verification');
}
function buildSocialEmbed() {
  const label = xpLabel();
  const name = communityName();
  const e = new EmbedBuilder().setColor(BRAND.blue).setTitle(`${name} Social & KREATORs`)
    .setDescription(`**Share ${name}. Earn ${label} for genuine contributions.**\n\nUse \`/submit-post\` for a ${name} post. Approved posts earn **+${getSettingInt('kxp_social_post')} ${label}**, maximum 2 rewarded posts/day.\n\nApproved **KREATOR** posts can earn **+${getSettingInt('creator_reaction_kxp')} ${label} per ${getSettingInt('creator_reaction_threshold')} unique verified Discord reactions**, capped at ${getSettingInt('creator_reaction_cap')} reaction milestones per post. Campaign-tagged KREATOR posts also count toward the campaign leaderboard.\n\nCreator ${label} is not a separate currency: it also increases the member's overall ${label} and normal rank progression.\n\nUse \`/social-card\` to generate a shareable progress, referral, impact or Founder card. Public chat links remain blocked.`)
    .setFooter({ text: '[LINKO-SOCIAL]' });
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
  else e.addFields({ name: '🔗 Official links', value: `**Not configured yet.**\nServer administrators can use \`/official-links set\` to add verified links.` });
  const profiles = teamProfiles().slice(0, 10);
  if (profiles.length) {
    e.addFields({ name: '👥 Official Founders & Team', value: profiles.map((p) => {
      const links = [p.website && `[Website](${p.website})`, p.x && `[X](${p.x})`, p.linkedin && `[LinkedIn](${p.linkedin})`, p.telegram && `[Telegram](${p.telegram})`].filter(Boolean).join(' · ');
      return `<@${p.user_id}> — **${p.role_title}**${links ? `\n${links}` : ''}`;
    }).join('\n\n') });
  }
  e.setFooter({ text: '[LINKO-OFFICIAL-LINKS]' });
  return withImageOrPlaceholder(e, 'official', 'Official Links');
}
function buildFounderHubEmbed() {
  const name = communityName();
  const studioLine = moduleEnabled('studio') ? ` and active Studio clients` : '';
  const e = new EmbedBuilder().setColor(BRAND.emerald).setTitle(`${name} Founder Hub`)
    .setDescription(`Verified founders${studioLine} can discuss market structure, operations and community growth here.\n\nUse \`/apply-founder\` to submit your project website, project socials, founder socials and role/title. Approved profiles are added to the private Founder Directory.${moduleEnabled('studio') ? ' Sensitive client-specific Studio work belongs in a private client workspace.' : ''}`)
    .setFooter({ text: '[LINKO-FOUNDERS]' });
  return withImageOrPlaceholder(e, 'founder', 'Founder Hub');
}
async function refreshBrandMessages(guild) {
  const ch = (base) => guild.channels.cache.find((c) => baseChannelName(c.name) === base && c.isTextBased());
  const welcome = ch('welcome'), verify = ch('verify'), links = ch('official-links'), social = ch('share-your-post'), founder = ch('founder-lobby');
  if (welcome && verify) {
    const channels = { rules: ch('rules'), verify };
    if (channels.rules) await seedMessage(welcome, '[KLINEO-WELCOME]', { embeds: [buildWelcomeEmbed(channels)] });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('klineo_verify').setLabel('VERIFY & ENTER KLINEO').setStyle(ButtonStyle.Success));
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
  if (fetchPresences) await guild.members.fetch({ withPresences: true }).catch(() => guild.members.fetch().catch(() => null));
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

function creatorLeaderboardRows(guild, limit = 50) {
  const rows = db.prepare(`
    SELECT s.user_id,
           SUM(COALESCE(s.xp_awarded, 0) + COALESCE(s.reaction_xp_awarded, 0)) AS creator_kxp,
           SUM(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END) AS approved_posts,
           SUM(COALESCE(s.reaction_xp_awarded, 0)) AS reaction_kxp,
           COUNT(DISTINCT s.campaign_id) AS campaigns
    FROM social_submissions s
    WHERE s.status = 'approved' AND COALESCE(s.creator_eligible, 0) = 1
    GROUP BY s.user_id
    HAVING creator_kxp > 0
    ORDER BY creator_kxp DESC, approved_posts DESC, reaction_kxp DESC, s.user_id ASC
  `).all();
  return rows.filter((r) => {
    const member = guild.members.cache.get(r.user_id);
    return !!member && !member.user.bot && hasVerifiedRole(member) && hasKreatorRole(member);
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
    return !!member && !member.user.bot && hasVerifiedRole(member) && hasKreatorRole(member);
  }).slice(0, limit);
}

function creatorReactionCount(submissionId) {
  return Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM creator_post_reactions WHERE submission_id = ?').get(submissionId)?.c ?? 0);
}

function buildCreatorLeaderboardEmbeds(guild, limit = 50) {
  const label = xpLabel();
  const rows = creatorLeaderboardRows(guild, limit);
  const chunks = leaderboardChunks(rows, 25);
  return chunks.map((chunk, chunkIndex) => {
    const offset = chunkIndex * 25;
    const lines = chunk.length ? chunk.map((r, i) => {
      const medal = offset + i === 0 ? '🥇 ' : offset + i === 1 ? '🥈 ' : offset + i === 2 ? '🥉 ' : '';
      return `${medal}**${String(offset + i + 1).padStart(2, '0')}.** <@${r.user_id}> — **${Number(r.creator_kxp).toLocaleString()} Creator ${label}** · ${Number(r.approved_posts)} approved · ${Number(r.reaction_kxp)} reaction ${label}`;
    }).join('\n') : 'No KREATOR activity yet.';
    return new EmbedBuilder()
      .setColor(0xA855F7)
      .setTitle(chunkIndex === 0 ? `🏅 ${guild.name} KREATOR Leaderboard · Top 50` : `🏅 ${guild.name} KREATOR Leaderboard · 26–50`)
      .setDescription(lines)
      .setFooter({ text: `[KLINEO-KREATOR-LEADERBOARD] · Creator ${label} is included in total ${label} · Auto-updated by LINKO` })
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
      .setTitle(chunkIndex === 0 ? `🏆 ${guild.name} ${label} Leaderboard · Top 50` : `🏆 ${guild.name} ${label} Leaderboard · 26–50`)
      .setDescription(lines)
      .setFooter({ text: `[KLINEO-KXP-LEADERBOARD] · ${rows.length} ranked shown · Auto-updated by LINKO` })
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
  if (type === 'referrals') return 'referral-leaderboard';
  if (type === 'creators') return 'kreator-leaderboard';
  if (type === 'campaign') return 'campaign-leaderboard';
  return xpLeaderboardBase();
}

function leaderboardVisibilityKey(type) {
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
  const marker = type === 'referrals' ? '[KLINEO-REFERRAL-LEADERBOARD]' : type === 'creators' ? '[KLINEO-KREATOR-LEADERBOARD]' : '[KLINEO-KXP-LEADERBOARD]';
  const existing = recent?.find((m) => m.author.id === client.user.id && m.embeds.some((e) => e.footer?.text?.includes(marker) || (type === 'kxp' && e.footer?.text?.includes('[KLINEO-LEADERBOARD]'))));
  const limit = Math.max(1, Math.min(50, getSettingInt('leaderboard_limit') || 50));
  const embeds = type === 'referrals' ? buildReferralLeaderboardEmbeds(guild, limit) : type === 'creators' ? buildCreatorLeaderboardEmbeds(guild, limit) : buildLeaderboardEmbeds(guild, limit);
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
    const content = `**KlineO Creator Campaign Leaderboards**\n\nNo active or recently closed creator campaigns. Staff can use \`/creator-campaign create\`. Closed campaign boards remain visible for **${getSettingInt('campaign_leaderboard_retention_days')} days**.\n\n${marker}`;
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
  const out = { total, messages: 0, voice: 0, referrals: 0, social: 0, bugs: 0, profile: 0, manual: 0 };
  for (const row of rows) {
    const amount = Number(row.amount ?? 0);
    const reason = String(row.reason ?? '');
    if (reason.startsWith('Meaningful message') || reason.startsWith('Qualified community message') || reason.startsWith('Reversed qualified community message')) out.messages += amount;
    else if (reason.startsWith('Qualifying voice activity') || reason.startsWith('Official voice event:')) out.voice += amount;
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

async function awardFirstSubmissionKxp(guild, userId, item, label, actorId = null) {
  const exists = db.prepare('SELECT 1 FROM profile_submission_rewards WHERE user_id = ? AND item = ?').get(userId, item);
  if (exists) return 0;
  db.prepare('INSERT INTO profile_submission_rewards (user_id, item, awarded_at) VALUES (?, ?, ?)').run(userId, item, now());
  const award = Math.max(0, getSettingInt('kxp_profile_submission'));
  if (award > 0) await addXp(guild, userId, award, `Profile submission:${label}`, actorId);
  return award;
}

function joinSourceLabel(source) {
  return ({
    member: 'Invited by a KlineO member',
    organic: 'Found KlineO myself',
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
async function ensureCategory(guild, name, permissionOverwrites = []) {
  try {
    let c = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && x.name === name);
    if (!c) c = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites, reason: 'LINKO KlineO setup' });
    else await c.permissionOverwrites.set(permissionOverwrites, 'LINKO setup sync');
    return c;
  } catch (error) { throw contextualError(`Category ${name}`, error); }
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
async function ensureVoiceChannel(guild, category, spec, permissionOverwrites = []) {
  try {
    let c = guild.channels.cache.find((x) => x.type === ChannelType.GuildVoice && x.parentId === category.id && x.name === spec.name);
    if (!c && spec.reuseDefaultVoice) c = guild.channels.cache.find((x) => x.type === ChannelType.GuildVoice && !x.parentId && x.name === 'General');
    if (!c) c = await guild.channels.create({ name: spec.name, type: ChannelType.GuildVoice, parent: category.id, userLimit: spec.userLimit ?? 0, permissionOverwrites, reason: 'LINKO KlineO setup' });
    else {
      await c.edit({ name: spec.name, parent: category.id, userLimit: spec.userLimit ?? 0, reason: 'LINKO setup sync' });
      await c.permissionOverwrites.set(permissionOverwrites, 'LINKO setup sync');
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

Ranks:
• OBSERVER — 0 ${label}
• SCOUT — 150 ${label}
• ANALYST — 500 ${label}
• OPERATOR — 1,200 ${label}
• STRATEGIST — 2,500 ${label}
• VANGUARD — 5,000 ${label}
• PRIME — 10,000+ ${label} (highest rank; ${label} continues with no maximum)

**Current earning rules**
• Qualifying message: **+${getSettingInt('kxp_message')} ${label}**
• Official voice event: **+${getSettingInt('kxp_voice_interval')} ${label} per ${getSettingInt('voice_interval_minutes')} qualifying minutes**
• Valid referral: **+${getSettingInt('kxp_valid_referral')} ${label}** after source selection + inviter confirmation + verification + 7 days + activity on at least ${getSettingInt('referral_activity_min_days')} different days
• Approved social post: **+${getSettingInt('kxp_social_post')} ${label}**
• KREATOR reaction milestone: **+${getSettingInt('creator_reaction_kxp')} ${label} per ${getSettingInt('creator_reaction_threshold')} unique verified reactions**, capped at ${getSettingInt('creator_reaction_cap')} milestones/post
• Valid bug report: **+${getSettingInt('kxp_bug_report')} ${label}**
• First-time X submission: **+${getSettingInt('kxp_profile_submission')} ${label}**
• First-time Telegram submission: **+${getSettingInt('kxp_profile_submission')} ${label}**
• First-time EVM wallet submission: **+${getSettingInt('kxp_profile_submission')} ${label}**
• First-time Solana wallet submission: **+${getSettingInt('kxp_profile_submission')} ${label}**

**${label} never caps.** PRIME unlocks at 10,000 ${label}, but members can keep earning lifetime ${label} indefinitely. Editing an already rewarded X, Telegram or wallet entry does not award the point again.

Voice time only earns ${label} while staff have an **official voice event** active.

**Message ${label} is impact-scored.** LINKO first rejects short/trivial/repeated/duplicate/link-spam messages. Candidate messages are then scored using content quality/relevance plus real community response (meaningful replies or distinct reactions). A moderator can confirm or reverse edge cases. LINKO stores only message IDs + scores/metadata for this system, not the message body.

Use `/rank`, `/points`, `/invite`, `/invites`, and `/leaderboard`.

[KLINEO-KXP]`;
}

function socialRulesContent() {
  const label = xpLabel();
  return `**Share KlineO. Earn ${label} for genuine contributions.**

Use \`/submit-post\` and submit your direct X, LinkedIn, YouTube, TikTok or Instagram post.

Moderators review submissions. Each approved post earns **+${getSettingInt('kxp_social_post')} ${label}**. Maximum **2 rewarded posts per day**. Duplicate, deleted or low-effort spam does not qualify.

Approved posts are published here by LINKO. KREATOR posts can also earn reaction-based ${label}, and campaign-tagged posts count toward a campaign leaderboard.

[KLINEO-SOCIAL]`;
}
async function updatePublicKxpDocs(guild) {
  const how = guild.channels.cache.find((c) => baseChannelName(c.name) === howToEarnXpBase() && c.isTextBased());
  const social = guild.channels.cache.find((c) => baseChannelName(c.name) === 'share-your-post' && c.isTextBased());
  const links = guild.channels.cache.find((c) => baseChannelName(c.name) === 'official-links' && c.isTextBased());
  if (how) await seedMessage(how, '[KLINEO-KXP]', { content: kxpRulesContent() });
  if (links) await seedMessage(links, '[KLINEO-OFFICIAL-LINKS]', { embeds: [buildOfficialLinksEmbed()] });
  if (social) await seedMessage(social, '[KLINEO-SOCIAL]', { embeds: [buildSocialEmbed()] });
}
function readOnlyOverwrites(everyone, roles = []) {
  return [
    overwrite(everyone.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads]),
    ...roles.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])),
  ];
}
function privateFor(everyone, allowedRoles) {
  return [
    overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]),
    ...allowedRoles.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])),
  ];
}
function privateVoiceFor(everyone, allowedRoles) {
  return [
    overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]),
    ...allowedRoles.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])),
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
  const log = guild.channels.cache.find((c) => baseChannelName(c.name) === 'kxp-log' && c.isTextBased());
  if (log) log.send(`<@${userId}> ${applied >= 0 ? '+' : ''}${applied} ${xpLabel()} — ${reason}${actorId ? ` — by <@${actorId}>` : ''}`).catch(() => {});
  scheduleLeaderboardUpdate(guild);
  scheduleHealthUpdate(guild);
  return next;
}
async function awardReferralMilestones(_guild, _referredUserId, _rankName) {
  // LINKO v5 keeps referral rewards deliberately conservative.
  // A referral earns KXP only after the referred member verifies and remains for 7 days.
}

async function maybeAwardReferralRoleBonus(_guild, _memberId, _roleName) {
  // No automatic Creator/Founder referral bonus in v5.
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
  for (const spec of ROLE_SPECS) roles[spec.key] = await ensureRole(guild, spec);
  for (const rank of RANKS) roles[rank.key] = guild.roles.cache.find((r) => r.name === rank.name);
  for (const [key, label, color] of INTERESTS) {
    roles[`interest_${key}`] = await ensureRole(guild, { name: `${INTEREST_ROLE_PREFIX}${label}`, color, hoist: false, permissions: [] });
  }

  const me = await guild.members.fetchMe();
  const ceiling = me.roles.highest.position;
  const orderedNames = ['KLINEO CORE', 'KLINEO TEAM', 'MODERATOR', 'STUDIO CLIENT', 'VERIFIED FOUNDER', 'PARTNER', 'KREATOR', 'AMBASSADOR', 'VERIFIED MEMBER', 'PRIME', 'VANGUARD', 'STRATEGIST', 'OPERATOR', 'ANALYST', 'SCOUT', 'OBSERVER', ...INTERESTS.map((x) => `${INTEREST_ROLE_PREFIX}${x[1]}`)];
  const movable = orderedNames.map((n) => guild.roles.cache.find((r) => r.name === n)).filter((r) => r && r.position < ceiling);
  const positions = movable.map((r, i) => ({ role: r.id, position: Math.max(1, ceiling - 1 - i) }));
  if (positions.length) await guild.roles.setPositions(positions).catch((e) => console.warn('Role order warning:', e.message));

  const everyone = guild.roles.everyone;
  const staff = [roles.core, roles.team, roles.moderator];
  const verifiedBase = privateFor(everyone, [roles.verified, ...staff]);
  const startReadOnly = readOnlyOverwrites(everyone, staff);
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
  categories.stats = await ensureCategory(guild, CATEGORY_NAMES.stats, [overwrite(everyone.id, [PermissionFlagsBits.ViewChannel])]);
  categories.start = await ensureCategory(guild, CATEGORY_NAMES.start, [overwrite(everyone.id, [PermissionFlagsBits.ViewChannel])]);
  categories.community = await ensureCategory(guild, CATEGORY_NAMES.community, verifiedBase);
  categories.kxp = await ensureCategory(guild, CATEGORY_NAMES.kxp, verifiedBase);
  categories.signal = await ensureCategory(guild, CATEGORY_NAMES.signal, signalPrivate);
  categories.social = await ensureCategory(guild, CATEGORY_NAMES.social, verifiedBase);
  categories.creators = await ensureCategory(guild, CATEGORY_NAMES.creators, creatorsPrivate);
  categories.founders = await ensureCategory(guild, CATEGORY_NAMES.founders, foundersPrivate);
  categories.studio = await ensureCategory(guild, CATEGORY_NAMES.studio, studioPrivate);
  categories.high = await ensureCategory(guild, CATEGORY_NAMES.high, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel])]);
  categories.voice = await ensureCategory(guild, CATEGORY_NAMES.voice, verifiedBase);
  categories.languages = await ensureCategory(guild, CATEGORY_NAMES.languages, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  categories.staff = await ensureCategory(guild, CATEGORY_NAMES.staff, staffPrivate);
  await categories.stats.setPosition(0).catch(() => {});
  await categories.start.setPosition(1).catch(() => {});
  await updateServerStats(guild, true);

  setSetupPhase('04/11 · Create START HERE + community channels');
  const channels = {};
  channels.welcome = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.welcome, topic: 'Welcome to KlineO. Start here.' }, startReadOnly);
  channels.rules = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.rules, topic: 'KlineO community and security rules.' }, startReadOnly);
  channels.verify = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.verify, topic: 'Verify yourself to unlock KlineO.' }, startReadOnly);
  channels.links = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.links, topic: 'Only trust official KlineO links listed here.' }, startReadOnly);
  channels.announcements = await ensureTextChannel(guild, categories.start, { name: CHANNEL_NAMES.announcements, topic: 'Official KlineO announcements.' }, startReadOnly);

  for (const [key, name, topic, slowmode] of [
    ['general', CHANNEL_NAMES.general, 'General KlineO discussion. Public links are blocked.', 2],
    ['marketChat', CHANNEL_NAMES.marketChat, 'Market discussion. No guaranteed-return claims. Public links are blocked.', 3],
    ['tradeSetups', CHANNEL_NAMES.tradeSetups, 'Trading setups and risk context. Public links are blocked.', 5],
    ['aiAgentLab', CHANNEL_NAMES.aiAgentLab, 'AI agents, execution workflows and KlineO experiments. Public links are blocked.', 3],
    ['productUpdates', CHANNEL_NAMES.productUpdates, 'KlineO product releases and integrations.', 0],
    ['productFeedback', CHANNEL_NAMES.productFeedback, 'Constructive KlineO product feedback. Public links are blocked.', 5],
    ['bugReports', CHANNEL_NAMES.bugReports, 'Report reproducible KlineO bugs. Valid reports can be approved by staff for KXP. Public links are blocked.', 10],
    ['help', CHANNEL_NAMES.help, 'Ask for community or product help. Public links are blocked.', 5],
    ['introductions', CHANNEL_NAMES.introductions, 'Introduce yourself to KlineO. Public links are blocked.', 10],
    ['wins', CHANNEL_NAMES.wins, 'Share wins, mistakes and lessons. Public links are blocked.', 5],
  ]) {
    const perms = baseChannelName(name) === 'product-updates' ? [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))] : verifiedBase;
    channels[key] = await ensureTextChannel(guild, categories.community, { name, topic, slowmode, reuseDefaultGeneral: baseChannelName(name) === 'general' }, perms);
  }

  channels.productRoadmap = await ensureTextChannel(guild, categories.community, { name: CHANNEL_NAMES.productRoadmap, topic: 'Structured KlineO product suggestions and status updates. Submit with /suggest.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);

  setSetupPhase('05/11 · Create KXP + persistent leaderboard channels');
  channels.howKxp = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.howKxp, topic: 'How KXP, referrals and rank progression work.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.botCommands = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.botCommands, topic: 'Use LINKO member commands here: /rank /points /leaderboard /invite /invites /join-source /confirm-invited /wallet /submit-post /social-card /apply-founder.' }, verifiedBase);
  channels.leaderboard = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.leaderboard, topic: 'Live KlineO Top 50 KXP leaderboard. Auto-refreshes; visibility is controlled by moderators.' }, staffPrivate);
  channels.referralLeaderboard = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.referralLeaderboard, topic: 'Live KlineO Top 50 valid-referral leaderboard. Auto-refreshes; visibility is controlled by moderators.' }, staffPrivate);
  await setLeaderboardChannelVisibility(guild, 'kxp', getSetting('kxp_leaderboard_visibility'));
  await setLeaderboardChannelVisibility(guild, 'referrals', getSetting('referral_leaderboard_visibility'));
  channels.rankUps = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.rankUps, topic: 'KlineO community rank progression.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.referrals = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.referrals, topic: 'Use /invite and /invites. Valid referrals earn KXP.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.events = await ensureTextChannel(guild, categories.kxp, { name: CHANNEL_NAMES.events, topic: 'Official community events, AMAs and campaigns.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);

  setSetupPhase('06/11 · Create Signal, Social, Founder, Studio, higher-level + voice spaces');
  for (const [key, name, topic] of [
    ['analystChat', CHANNEL_NAMES.analystChat, 'ANALYST+ discussion. Links unlock at STRATEGIST.'],
    ['tradeAnalysis', CHANNEL_NAMES.tradeAnalysis, 'ANALYST+ trade analysis. Links unlock at STRATEGIST.'],
    ['marketThesis', CHANNEL_NAMES.marketThesis, 'ANALYST+ market theses. Links unlock at STRATEGIST.'],
    ['aiStrategies', CHANNEL_NAMES.aiStrategies, 'ANALYST+ AI strategy discussion. Links unlock at STRATEGIST.'],
  ]) channels[key] = await ensureTextChannel(guild, categories.signal, { name, topic, slowmode: 5 }, signalPrivate);
  channels.analystVoice = await ensureVoiceChannel(guild, categories.signal, { name: '🔊 Analyst Room', userLimit: 30 }, privateVoiceFor(everyone, signalRoles));

  channels.sharePost = await ensureTextChannel(guild, categories.social, { name: CHANNEL_NAMES.sharePost, topic: 'Approved KlineO community posts appear here. Submit via /submit-post.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.contentMissions = await ensureTextChannel(guild, categories.social, { name: CHANNEL_NAMES.contentMissions, topic: 'Optional KlineO content missions and community briefs.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.creatorLeaderboard = await ensureTextChannel(guild, categories.social, { name: CHANNEL_NAMES.creatorLeaderboard, topic: 'Live KREATOR leaderboard. Creator KXP also counts toward the overall KXP leaderboard.' }, staffPrivate);
  channels.campaignLeaderboard = await ensureTextChannel(guild, categories.social, { name: CHANNEL_NAMES.campaignLeaderboard, topic: 'Public KREATOR campaign leaderboards. Campaign KXP also counts toward KREATOR + overall KXP.' }, staffPrivate);
  await setLeaderboardChannelVisibility(guild, 'creators', getSetting('creator_leaderboard_visibility'));
  await setLeaderboardChannelVisibility(guild, 'campaign', getSetting('campaign_leaderboard_visibility'));

  for (const [name, topic] of [[CHANNEL_NAMES.creatorLounge, 'Private lounge for approved creators.'], [CHANNEL_NAMES.contentCollabs, 'KlineO creator collaborations.'], [CHANNEL_NAMES.creatorOpportunities, 'Approved creator opportunities and briefs.']]) await ensureTextChannel(guild, categories.creators, { name, topic }, creatorsPrivate);

  channels.founderLobby = await ensureTextChannel(guild, categories.founders, { name: CHANNEL_NAMES.founderLobby, topic: 'Private discussion for verified founders and Studio clients.' }, foundersPrivate);
  channels.founderDirectory = await ensureTextChannel(guild, categories.founders, { name: CHANNEL_NAMES.founderDirectory, topic: 'Approved founder/project websites and social profiles.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), ...[roles.founder, roles.studio].map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages])), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.liquidityStudio = await ensureTextChannel(guild, categories.founders, { name: CHANNEL_NAMES.liquidityStudio, topic: 'KlineO Liquidity Studio capabilities, process and onboarding.' }, foundersPrivate);
  for (const [name, topic] of [[CHANNEL_NAMES.marketStructure, 'Founder-level market structure discussion.'], [CHANNEL_NAMES.founderResources, 'Founder resources and operating references.'], [CHANNEL_NAMES.studioRequests, 'Discuss Liquidity Studio onboarding and next steps.']]) await ensureTextChannel(guild, categories.founders, { name, topic }, foundersPrivate);
  await ensureVoiceChannel(guild, categories.founders, { name: '🎙️ Founder Roundtable', userLimit: 25 }, privateVoiceFor(everyone, [roles.founder, roles.studio, ...staff]));

  channels.studioAnnouncements = await ensureTextChannel(guild, categories.studio, { name: CHANNEL_NAMES.studioAnnouncements, topic: 'Private Liquidity Studio notices.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.studio.id, [PermissionFlagsBits.ViewChannel], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  channels.clientSupport = await ensureTextChannel(guild, categories.studio, { name: CHANNEL_NAMES.clientSupport, topic: 'General support for active Liquidity Studio clients.' }, studioPrivate);

  channels.strategist = await ensureTextChannel(guild, categories.high, { name: CHANNEL_NAMES.strategist, topic: 'STRATEGIST+ room. Links are permitted here.' }, privateFor(everyone, l5plus));
  channels.vanguard = await ensureTextChannel(guild, categories.high, { name: CHANNEL_NAMES.vanguard, topic: 'VANGUARD+ community lounge.' }, privateFor(everyone, l6plus));
  channels.prime = await ensureTextChannel(guild, categories.high, { name: CHANNEL_NAMES.prime, topic: 'PRIME community room.' }, privateFor(everyone, l7plus));
  await ensureVoiceChannel(guild, categories.high, { name: '🎙️ Strategy Room', userLimit: 25 }, privateVoiceFor(everyone, l5plus));
  await ensureVoiceChannel(guild, categories.high, { name: '🎙️ Vanguard Room', userLimit: 20 }, privateVoiceFor(everyone, l6plus));

  const publicVoices = [['📈 Trading Floor', 50], ['🌐 Market Room', 50], ['🤖 AI Lab', 30], ['💻 Co-Working', 30], ['💬 Community Lounge', 50], ['🎙️ KlineO AMA', 99], ['💤 AFK', 99]];
  for (const [name, limit] of publicVoices) {
    const c = await ensureVoiceChannel(guild, categories.voice, { name, userLimit: limit, reuseDefaultVoice: name === '💬 Community Lounge' }, privateVoiceFor(everyone, [roles.verified, ...staff]));
    if (name === '💤 AFK') await guild.setAFKChannel(c, 'LINKO setup').catch(() => {});
  }

  setSetupPhase('07/11 · Create Languages access');
  channels.languageAccess = await ensureTextChannel(guild, categories.languages, { name: CHANNEL_NAMES.languageAccess, topic: 'Choose KlineO language communities with /language list and /language add.' }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(roles.verified.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], [PermissionFlagsBits.SendMessages]), ...staff.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))]);
  await seedMessage(channels.languageAccess, '[KLINEO-LANGUAGES]', { content: `**KlineO Language Communities**\n\nUse \`/language list\` to see available language rooms, then \`/language add role:@LANG...\` to join one. Staff can create new language communities with \`/language-manager create\`.\n\n[KLINEO-LANGUAGES]` });

  setSetupPhase('08/11 · Create staff operations channels');
  const staffChannels = [
    ['teamChat', CHANNEL_NAMES.teamChat, 'Private KlineO team coordination.'],
    ['modCommands', CHANNEL_NAMES.modCommands, 'LINKO moderator command center. Staff-only slash commands and diagnostics.'],
    ['communityHealth', CHANNEL_NAMES.communityHealth, 'KlineO activation, engagement, growth and rank health dashboard.'],
    ['modInbox', CHANNEL_NAMES.modInbox, 'Consolidated pending reviews and moderator workload.'],
    ['suggestionReview', CHANNEL_NAMES.suggestionReview, 'Product suggestion review and status controls.'],
    ['verificationLog', CHANNEL_NAMES.verificationLog, 'Member verification activity.'],
    ['founderVerification', CHANNEL_NAMES.founderVerification, 'Founder access applications with project and founder socials.'],
    ['socialSubmissions', CHANNEL_NAMES.socialSubmissions, 'KlineO social-post KXP review queue.'],
    ['moderation', CHANNEL_NAMES.moderation, 'Moderation notes and actions.'],
    ['securityAlerts', CHANNEL_NAMES.securityAlerts, 'Scams, impersonation and security incidents.'],
    ['kxpLog', CHANNEL_NAMES.kxpLog, 'KXP awards and deductions.'],
    ['walletLog', CHANNEL_NAMES.walletLog, 'Masked wallet submissions and changes. Full addresses are never posted here.'],
    ['botLog', CHANNEL_NAMES.botLog, 'LINKO operations and bot logs.'],
  ];
  for (const [key, name, topic] of staffChannels) channels[key] = await ensureTextChannel(guild, categories.staff, { name, topic }, staffPrivate);

  setSetupPhase('09/11 · Seed verification, rules, docs + command guides');
  const verifyButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('klineo_verify').setLabel('VERIFY & ENTER KLINEO').setStyle(ButtonStyle.Success));
  await seedMessage(channels.verify, '[KLINEO-VERIFY]', { embeds: [buildVerifyEmbed()], components: [verifyButton] });
  await seedMessage(channels.welcome, '[KLINEO-WELCOME]', { embeds: [buildWelcomeEmbed(channels)] });
  await seedMessage(channels.rules, '[KLINEO-RULES]', { content: `**KlineO Community Rules**\n\n1. Never share seed phrases, private keys or recovery information.\n2. Never send funds because of an unsolicited Discord DM.\n3. Only trust official links in <#${channels.links.id}>.\n4. No phishing, wallet-drainers, impersonation or malicious files.\n5. **No user-posted links in public community channels.**\n6. In the ANALYST+ Signal Room, links unlock at **STRATEGIST**.\n7. Social posts about KlineO must be submitted through \`/submit-post\`; approved posts can earn KXP.\n8. No spam, unsolicited promotion or guaranteed-return claims.\n9. Do not redistribute private Founder or Liquidity Studio discussions.\n10. Respect other members and moderators.\n\n[KLINEO-RULES]` });
  await seedMessage(channels.links, '[KLINEO-OFFICIAL-LINKS]', { embeds: [buildOfficialLinksEmbed()] });
  await seedMessage(channels.howKxp, '[KLINEO-KXP]', { content: kxpRulesContent() });
  await seedMessage(channels.productRoadmap, '[KLINEO-PRODUCT-ROADMAP]', { content: `**KlineO Product Suggestions**\n\nSubmit a structured idea with \`/suggest\`. LINKO publishes it here and keeps the status updated as staff move it through **Submitted → Reviewing → Planned → Building → Shipped / Declined**.\n\n[KLINEO-PRODUCT-ROADMAP]` });
  await seedMessage(channels.botCommands, '[KLINEO-MEMBER-COMMANDS]', { content: `**LINKO Member Commands**

Use this channel for KlineO slash commands:
• \`/rank\` — your rank and progress
• \`/points\` — your KXP balance
• \`/leaderboard type:KXP Points\` — KXP points leaderboard
• \`/leaderboard type:Referrals\` — referral leaderboard
• \`/invite\` — create your tracked invite
• \`/invites\` — your referral stats
• \`/join-source\` — **required before verification**; select how you joined KlineO and, if applicable, the member who invited you\n• \`/confirm-invited @member\` — confirm a pending referral when another member says you invited them
• \`/wallet view/set/remove/primary\` — submit X + Telegram + EVM/Solana wallet (no connect, no signing); first-time items earn KXP
• \`/submit-post\` — submit KlineO social content for KXP review; KREATORs can optionally tag an active creator campaign
• \`/leaderboard type:Kreators\` — lifetime KREATOR leaderboard
• \`/leaderboard type:Creator Campaign campaign:<ID>\` — campaign leaderboard
• \`/social-card\` — generate a shareable progress/referral/impact/Founder card
• \`/apply-founder\` — request Founder Hub access
• \`/onboarding\` — view your activation checklist
• \`/interest add/remove/list\` — choose KlineO interests
• \`/language add/remove/list\` — join language rooms
• \`/suggest\` — submit a structured KlineO product idea
• \`/events\` — view upcoming community events
• \`/commands\` — show this guide privately

Plain chat in this channel is automatically removed to keep it clean.

[KLINEO-MEMBER-COMMANDS]` });
  if (channels.modCommands) {
    await seedMessage(channels.modCommands, '[KLINEO-MOD-COMMANDS]', { content: `**LINKO Moderator Command Center · 1/2**

**KXP + referrals**
• \`/user-kxp @member\` — detailed KXP breakdown
• \`/give-xp @member amount reason\` — manually award KXP
• \`/remove-xp @member amount reason\` — remove KXP
• \`/approve-bug @member\` — approve a valid bug report
• \`/referral-stats @member\` — inspect referrals
• \`/confirm-referral @member @inviter\` — staff-confirm a genuine referral
• \`/impact-status <message link>\` — inspect impact signals
• \`/mark-impactful <message link>\` — confirm normal message KXP
• \`/remove-message-xp <message link>\` — reverse message KXP
• \`/impact-settings\` / \`/set-impact\` — inspect/tune impact rules
• \`/kxp-settings\` / \`/set-kxp\` — inspect/change KXP rewards
• \`/voice-event start/stop/status\` — official voice KXP

**Leaderboards + wallets**
• \`/leaderboard-settings\` — public/private leaderboard visibility
• \`/creator-campaign create/list/close\` — manage KREATOR campaigns
• \`/refresh-leaderboard\` — refresh persistent Top 50 boards
• \`/export-leaderboard\` — export KXP/referral/community CSV
• \`/wallet-admin @member\` — CORE: inspect submitted identity/wallet data
• \`/export-wallets\` — CORE: export wallet/identity CSV

[KLINEO-MOD-COMMANDS]` });

    await seedMessage(channels.modCommands, '[KLINEO-MOD-COMMANDS-2]', { content: `**LINKO Moderator Command Center · 2/2**

**Roles + spaces**
• \`/grant-klineo-role\` — grant Founder / Studio / KREATOR / Partner / Ambassador
• \`/create-client-space\` — create a private Liquidity Studio workspace
• \`/refresh-stats\` — refresh Members / Online counters
• \`/server-image set/clear/status\` — manage section images
• \`/official-links\` — manage verified KlineO links
• \`/team-profile\` — manage official founder/team profiles

**Community operations**
• \`/community-health\` / \`/refresh-health\` — health dashboard
• \`/mod-inbox\` — consolidated review queue
• \`/event\` — create/start/end/cancel/audit events
• \`/suggestion\` — manage product-roadmap suggestions
• \`/language-manager\` — create/archive language communities
• \`/channel-manager\` — create/rename/archive managed channels
• \`/mod-help\` — show the private staff guide

All staff commands enforce LINKO role/permission checks.

[KLINEO-MOD-COMMANDS-2]` });
  }
  setSetupPhase('10/11 · Refresh leaderboards + staff dashboards');
  await updateAllLeaderboards(guild);
  await updateCommunityHealthDashboard(guild);
  await updateModInbox(guild);

  setSetupPhase('11/11 · Refresh Social + Founder Hub content');
  await seedMessage(channels.sharePost, '[KLINEO-SOCIAL]', { embeds: [buildSocialEmbed()] });
  await seedMessage(channels.founderLobby, '[KLINEO-FOUNDERS]', { embeds: [buildFounderHubEmbed()] });
  await seedMessage(channels.founderDirectory, '[KLINEO-FOUNDER-DIRECTORY]', { content: '**KlineO Founder Directory**\n\nApproved Founder Hub members and their project/founder social links appear here.\n\n[KLINEO-FOUNDER-DIRECTORY]' });

  setSetupPhase('COMPLETE · KlineO structure synced successfully');
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
async function generateSocialCard(guild, member, type) {
  const W = 1600, H = 900;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(1300, 100, 0, 1300, 100, 650);
  glow.addColorStop(0, 'rgba(184,240,58,0.18)'); glow.addColorStop(1, 'rgba(184,240,58,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#B8F03A'; ctx.fillRect(85, 75, 8, 100);
  ctx.fillStyle = '#FFFFFF'; ctx.font = '800 42px sans-serif'; ctx.fillText('KLINEO', 125, 125);
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
  let caption = `I’m ${rank.name} in the KlineO community with ${xp.toLocaleString()} ${label}.`;
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
    caption = `I’ve brought ${referrals.valid} verified members into the KlineO community. My referral rank: ${rpos ? `#${rpos}` : 'building'}.`;
  } else if (type === 'impact') {
    title = 'COMMUNITY IMPACT';
    metric(label, xp.toLocaleString(), 145, 475);
    metric('Valid referrals', referrals.valid.toLocaleString(), 500, 475);
    metric('Approved posts', socialCount.toLocaleString(), 870, 475);
    metric('Valid bugs', bugs.toLocaleString(), 1230, 475);
    caption = `My KlineO community impact: ${xp.toLocaleString()} ${label}, ${referrals.valid} valid referrals and ${socialCount} approved social posts.`;
  } else if (type === 'founder') {
    const isFounder = member.roles.cache.some((r) => ['VERIFIED FOUNDER', 'STUDIO CLIENT'].includes(r.name));
    if (!isFounder) throw new Error('Founder cards are available only to VERIFIED FOUNDER or STUDIO CLIENT roles.');
    const app = db.prepare("SELECT * FROM founder_applications WHERE user_id = ? AND status = 'approved' ORDER BY reviewed_at DESC LIMIT 1").get(member.id);
    title = 'VERIFIED FOUNDER';
    metric('Community rank', rank.name, 145, 475);
    metric(label, xp.toLocaleString(), 620, 475);
    metric('Project', app?.project_name ? app.project_name.slice(0, 18) : 'VERIFIED', 1000, 475);
    caption = `Verified Founder in the KlineO community${app?.project_name ? `, building ${app.project_name}` : ''}.`;
  }

  ctx.fillStyle = '#9CA3AF'; ctx.font = '600 22px monospace'; ctx.fillText(title, 90, 815);
  ctx.fillStyle = '#FFFFFF'; ctx.font = '600 22px sans-serif'; ctx.textAlign = 'right'; ctx.fillText('klineo.xyz', 1510, 815); ctx.textAlign = 'left';
  return { buffer: canvas.toBuffer('image/png'), caption, title };
}
async function publishOfficialLinks(guild) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'official-links' && c.isTextBased());
  if (!channel) return false;
  await seedMessage(channel, '[KLINEO-OFFICIAL-LINKS]', { embeds: [buildOfficialLinksEmbed()] });
  return true;
}
async function createClientSpace(guild, projectName, member) {
  const core = guild.roles.cache.find((r) => r.name === 'KLINEO CORE');
  const team = guild.roles.cache.find((r) => r.name === 'KLINEO TEAM');
  const moderator = guild.roles.cache.find((r) => r.name === 'MODERATOR');
  const studio = guild.roles.cache.find((r) => r.name === 'STUDIO CLIENT');
  if (!core || !team || !moderator || !studio) throw new Error('Run /setup-klineo first.');
  await member.roles.add(studio, `KlineO Studio client for ${projectName}`);
  const everyone = guild.roles.everyone;
  const allowed = [core, team, moderator];
  const perms = [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel]), overwrite(member.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]), ...allowed.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))];
  const category = await ensureCategory(guild, `CLIENT・${projectName.toUpperCase()}`, perms);
  const created = {};
  for (const [key, name, topic] of [['overview', '📋・overview', `${projectName} private KlineO Studio overview.`], ['liquidityOps', '💧・liquidity-ops', `${projectName} liquidity operations.`], ['reports', '📊・reports', `${projectName} reports and deliverables.`], ['support', '🆘・support', `${projectName} private support.`]]) created[key] = await ensureTextChannel(guild, category, { name, topic }, perms);
  created.voice = await ensureVoiceChannel(guild, category, { name: `🎙️ ${projectName} Project Room`, userLimit: 20 }, [overwrite(everyone.id, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]), overwrite(member.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]), ...allowed.map((r) => overwrite(r.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]))]);
  await seedMessage(created.overview, '[KLINEO-CLIENT-SPACE]', { content: `**${projectName} × KlineO Liquidity Studio**\n\nPrivate workspace for the client and KlineO team. Keep sensitive market, treasury, listing and operational information inside this category.\n\n[KLINEO-CLIENT-SPACE]` });
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
    if (inviterMember) await inviterMember.send(`✅ Your KlineO referral <@${ref.member_id}> is now valid. **+${award} ${xpLabel()}** has been added to your account.`).catch(() => {});
  }
  scheduleLeaderboardUpdate(guild);
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
  if (!channel || channel.type !== ChannelType.GuildVoice) return;
  const humans = [...channel.members.values()].filter((m) => !m.user.bot);
  if (humans.length < 2) return;
  const intervalMinutes = Math.max(1, getSettingInt('voice_interval_minutes'));
  const award = Math.max(0, getSettingInt('kxp_voice_interval'));
  if (!award) return;
  for (const member of humans) {
    if (!hasVerifiedRole(member)) continue;
    const state = member.voice;
    if (!state.channelId || state.selfDeaf || state.serverDeaf) continue;
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
}

async function sendWelcomeDm(member) {
  const verify = member.guild.channels.cache.find((c) => baseChannelName(c.name) === 'verify');
  const rules = member.guild.channels.cache.find((c) => baseChannelName(c.name) === 'rules');
  const attribution = getJoinAttribution(member.id);
  const detected = attribution?.detected_inviter_id ? `\n\nLINKO detected <@${attribution.detected_inviter_id}> as the invite creator. Confirm that by running \`/join-source source:Invited by a KlineO member\` (you can leave the member option empty), or choose the correct non-member source.` : '';
  await member.send(`**Welcome to KlineO.**\n\n1. Read ${rules ? `<#${rules.id}>` : '#rules'}.\n2. Before verification, run **/join-source** and tell LINKO how you joined KlineO.${detected}\n3. Verify in ${verify ? `<#${verify.id}>` : '#verify'} to unlock the community.\n\nIf a member invited you manually, select them in /join-source. They will need to confirm the referral, but you do **not** have to wait for that confirmation to enter KlineO.\n\nKlineO staff will never ask for your seed phrase, private key or funds via unsolicited DM.`).catch(() => {});
}

async function verifyMember(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (hasVerifiedRole(member)) return interaction.reply({ content: 'You are already verified.', ephemeral: true });
  const attribution = getJoinAttribution(member.id);
  if (!attribution || !Number(attribution.source_confirmed) || !attribution.source) {
    return interaction.reply({ content: 'Before you can enter KlineO, run **/join-source** in this server and select how you joined. If a member invited you, select that member. This keeps referral attribution accurate.', ephemeral: true });
  }
  const ageHours = (now() - interaction.user.createdTimestamp) / 3600000;
  if (ageHours < MIN_ACCOUNT_AGE_HOURS) return interaction.reply({ content: `This Discord account is too new to verify yet. Please try again after it is ${MIN_ACCOUNT_AGE_HOURS} hours old.`, ephemeral: true });
  const verified = interaction.guild.roles.cache.find((r) => r.name === 'VERIFIED MEMBER');
  const l1 = interaction.guild.roles.cache.find((r) => r.name === 'OBSERVER');
  if (!verified || !l1) return interaction.reply({ content: 'Verification roles are missing. Ask staff to run /setup-klineo.', ephemeral: true });
  await member.roles.add([verified, l1], 'KlineO self-verification');
  ensureUserRow(member.id, member.joinedTimestamp ?? now());
  db.prepare('UPDATE users SET verified_at = ? WHERE user_id = ?').run(now(), member.id);
  const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'verification-log' && c.isTextBased());
  if (log) log.send(`✅ ${member} verified and entered KlineO as **OBSERVER**. Join source: **${joinSourceLabel(attribution.source)}**${attribution.inviter_id ? ` · inviter <@${attribution.inviter_id}>` : ''}.`).catch(() => {});
  db.prepare('INSERT OR IGNORE INTO member_activation (user_id) VALUES (?)').run(member.id);
  scheduleHealthUpdate(interaction.guild); scheduleModInboxUpdate(interaction.guild);
  return interaction.reply({ content: `✅ Verified. Welcome to KlineO. You now have **OBSERVER** access. Join source recorded as **${joinSourceLabel(attribution.source)}**.${attribution.source === 'member' && !Number(attribution.inviter_confirmed) ? ' Your referral remains pending until the inviter confirms it.' : ''} Run \`/onboarding\` to choose interests/languages and complete your activation checklist.`, ephemeral: true });
}

async function createFounderApplicationModal(interaction) {
  const modal = new ModalBuilder().setCustomId('founder_application_modal').setTitle('KlineO Founder Verification');
  const project = new TextInputBuilder().setCustomId('project').setLabel('Project name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  const website = new TextInputBuilder().setCustomId('website').setLabel('Website').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(180);
  const social = new TextInputBuilder().setCustomId('social').setLabel('Project socials (X / TG / LinkedIn)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(180);
  const role = new TextInputBuilder().setCustomId('role').setLabel('Your socials + role/title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(180);
  const interest = new TextInputBuilder().setCustomId('interest').setLabel('Interested in Liquidity Studio? Why?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
  modal.addComponents(...[project, website, social, role, interest].map((x) => new ActionRowBuilder().addComponents(x)));
  await interaction.showModal(modal);
}

async function handleFounderModal(interaction) {
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
  await interaction.reply({ content: 'Founder application submitted. KlineO staff will review it.', ephemeral: true });
}

async function handleFounderReview(interaction, action, id) {
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
  if (member) member.send(action === 'approve' ? '✅ Your KlineO Founder Hub application was approved.' : 'Your KlineO Founder Hub application was not approved at this time.').catch(() => {});
}

async function publishFounderProfile(guild, app) {
  const channel = guild.channels.cache.find((c) => baseChannelName(c.name) === 'founder-directory' && c.isTextBased());
  if (!channel) return null;
  const embed = new EmbedBuilder().setColor(BRAND.emerald).setTitle(app.project_name).setDescription(`<@${app.user_id}>`).addFields(
    { name: 'Website', value: app.website || 'Not provided' },
    { name: 'Project socials', value: app.social || 'Not provided' },
    { name: 'Founder socials + role', value: app.role_title || 'Not provided' },
    { name: 'Liquidity Studio interest', value: app.studio_interest || 'Not provided' },
  ).setFooter({ text: 'Verified KlineO Founder' });
  return channel.send({ embeds: [embed] });
}

async function handleSocialSubmission(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first in #verify.', ephemeral: true });
  const platform = interaction.options.getString('platform', true);
  const url = interaction.options.getString('url', true).trim();
  const campaignId = interaction.options.getInteger('campaign');
  if (!platformUrlValid(platform, url)) return interaction.reply({ content: 'That URL does not match the selected platform or is not a valid HTTPS post URL.', ephemeral: true });
  let campaign = null;
  if (campaignId) {
    if (!hasKreatorRole(member)) return interaction.reply({ content: 'Only members with the **KREATOR** role can submit posts to a creator campaign.', ephemeral: true });
    campaign = creatorCampaignById(campaignId);
    if (!campaign || campaign.status !== 'active') return interaction.reply({ content: `Creator campaign #${campaignId} is not active or does not exist.`, ephemeral: true });
  }
  try {
    const result = db.prepare('INSERT INTO social_submissions (user_id, url, platform, submitted_at, campaign_id) VALUES (?, ?, ?, ?, ?)').run(member.id, url, platform, now(), campaignId ?? null);
    const id = Number(result.lastInsertRowid);
    const review = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'social-submissions' && c.isTextBased());
    if (!review) return interaction.reply({ content: 'Social review channel is missing. Ask staff to run /setup-linko.', ephemeral: true });
    const embed = new EmbedBuilder().setColor(BRAND.blue).setTitle(`KlineO social submission #${id}`).setDescription(`${member}\n${url}`).addFields(
      { name: 'Platform', value: platform.toUpperCase(), inline: true },
      { name: 'Status', value: 'Pending', inline: true },
      { name: 'KREATOR', value: hasKreatorRole(member) ? 'Yes' : 'No', inline: true },
      ...(campaign ? [{ name: 'Campaign', value: `#${campaign.id} · ${campaign.name}`, inline: false }] : []),
    ).setTimestamp();
    const configuredAward = getSettingInt('kxp_social_post');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`social_approve:${id}`).setLabel(`Approve +${configuredAward} ${xpLabel()}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`social_reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    );
    const msg = await review.send({ embeds: [embed], components: [row] });
    db.prepare('UPDATE social_submissions SET review_message_id = ? WHERE id = ?').run(msg.id, id);
    scheduleModInboxUpdate(interaction.guild);
    return interaction.reply({ content: `Submitted for review.${campaign ? ` Campaign: **#${campaign.id} · ${campaign.name}**.` : ''} Approved posts can earn ${xpLabel()}.`, ephemeral: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return interaction.reply({ content: 'That post URL has already been submitted.', ephemeral: true });
    throw e;
  }
}
async function handleSocialReview(interaction, id, approved) {
  const xp = approved ? getSettingInt('kxp_social_post') : 0;
  const label = xpLabel();
  if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
  const sub = db.prepare('SELECT * FROM social_submissions WHERE id = ?').get(id);
  if (!sub || sub.status !== 'pending') return interaction.reply({ content: 'This submission has already been reviewed or does not exist.', ephemeral: true });
  if (xp > 0) {
    const daily = getDaily(sub.user_id);
    if (Number(daily.social_count) >= 2) return interaction.reply({ content: 'This member already has 2 rewarded social posts today. Reject or review tomorrow.', ephemeral: true });
    db.prepare('UPDATE daily_xp SET social_count = social_count + 1 WHERE user_id = ? AND day = ?').run(sub.user_id, dayKey());
    await addXp(interaction.guild, sub.user_id, xp, `Approved KlineO social contribution #${id}`, interaction.user.id);
    const creator = await interaction.guild.members.fetch(sub.user_id).catch(() => null);
    const isKreator = !!creator && hasKreatorRole(creator);
    db.prepare('UPDATE social_submissions SET status = ?, reviewed_by = ?, reviewed_at = ?, xp_awarded = ?, creator_eligible = ? WHERE id = ?').run('approved', interaction.user.id, now(), xp, isKreator ? 1 : 0, id);
    const share = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'share-your-post' && c.isTextBased());
    if (share) {
      const campaign = sub.campaign_id ? creatorCampaignById(Number(sub.campaign_id)) : null;
      const reactionLine = isKreator ? `\n🏅 **KREATOR:** every **${getSettingInt('creator_reaction_threshold')} unique verified reactions** adds **+${getSettingInt('creator_reaction_kxp')} ${label}**, up to ${getSettingInt('creator_reaction_cap')} milestones.` : '';
      const campaignLine = campaign ? `\n🏁 **Campaign #${campaign.id}: ${campaign.name}**` : '';
      const posted = await share.send(`**Approved KlineO community post** — <@${sub.user_id}> earned **${xp} ${label}**${campaignLine}${reactionLine}\n${sub.url}`);
      db.prepare('UPDATE social_submissions SET share_message_id = ? WHERE id = ?').run(posted.id, id);
    }
  } else {
    db.prepare('UPDATE social_submissions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run('rejected', interaction.user.id, now(), id);
  }
  const embed = EmbedBuilder.from(interaction.message.embeds[0]).setColor(xp > 0 ? BRAND.emerald : BRAND.rose).setFields(
    { name: 'Platform', value: sub.platform.toUpperCase(), inline: true },
    { name: 'Status', value: xp > 0 ? `Approved · +${xp} ${label}` : 'Rejected', inline: true },
    ...(sub.campaign_id ? [{ name: 'Campaign', value: `#${sub.campaign_id}`, inline: true }] : []),
  ).setFooter({ text: `${xp > 0 ? 'Approved' : 'Rejected'} by ${interaction.user.tag}` });
  await interaction.update({ embeds: [embed], components: [] });
  scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild); scheduleLeaderboardUpdate(interaction.guild);
}
function creatorEmojiKey(reaction) {
  return reaction.emoji.id ? `${reaction.emoji.name ?? 'emoji'}:${reaction.emoji.id}` : String(reaction.emoji.name ?? 'emoji');
}

async function reconcileCreatorReactionRewards(guild, submissionId) {
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
        await fullGuild.commands.set(commands);
        await fullGuild.members.fetch({ withPresences: true }).catch(() => fullGuild.members.fetch());
        for (const m of fullGuild.members.cache.values()) if (!m.user.bot) ensureUserRow(m.id, m.joinedTimestamp ?? null);
        await cacheInvites(fullGuild);
        console.log(`Registered LINKO commands in ${fullGuild.name} (${fullGuild.id}) · XP label: ${xpLabel()}`);
        console.log('Run /setup-linko confirm:true (or /setup-klineo) to sync LINKO v10.7 multi-server features.');

        const recurring = (fn) => () => runWithGuild(fullGuild.id, () => fn(fullGuild).catch(console.error));
        setInterval(recurring(checkPendingReferrals), 60 * 60 * 1000);
        setInterval(recurring(processVoiceEventMinute), 60 * 1000);
        setInterval(() => runWithGuild(fullGuild.id, () => updateServerStats(fullGuild, false).catch(console.error)), 5 * 60 * 1000);
        setInterval(() => runWithGuild(fullGuild.id, () => updateAllLeaderboards(fullGuild).catch(console.error)), 5 * 60 * 1000);
        setInterval(recurring(evaluateImpactCandidates), 60 * 1000);
        setInterval(recurring(processCommunityEvents), 60 * 1000);
        setInterval(() => runWithGuild(fullGuild.id, () => updateCommunityHealthDashboard(fullGuild).catch(console.error)), 10 * 60 * 1000);
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
      if (inviterMember) await inviterMember.send(`🤝 LINKO detected a **pending KlineO referral** for ${member.user.username}. No referral ${xpLabel()} is awarded yet. It becomes valid after they verify, remain in the server for 7 days, and show community activity.`).catch(() => {});
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
    await member.send(`LINKO could not automatically identify your join source. Before you can verify, run **/join-source** in the KlineO server. If a KlineO member invited you, select them there. Referral credit becomes valid only after the inviter confirms, you verify, remain in the server for 7 days, and stay active across the qualification period.`).catch(() => {});
  }
  await sendWelcomeDm(member);
  scheduleStatsUpdate(member.guild); scheduleHealthUpdate(member.guild); scheduleModInboxUpdate(member.guild);
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
      const note = isSignal ? 'Links in Signal Room unlock at **STRATEGIST**.' : 'Links are not permitted in public KlineO community channels.';
      await message.author.send(`Your message in **#${channelName}** was removed. ${note}\nUse **/submit-post** for KlineO social content.`).catch(() => {});
      return;
    }
  }
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
    if (interaction.isButton()) {
      if (interaction.customId === 'klineo_verify') return verifyMember(interaction);
      if (interaction.customId.startsWith('social_approve:')) {
        const [, id] = interaction.customId.split(':');
        return handleSocialReview(interaction, Number(id), true);
      }
      if (interaction.customId.startsWith('social_reject:')) {
        const [, id] = interaction.customId.split(':');
        return handleSocialReview(interaction, Number(id), false);
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

    if (interaction.isModalSubmit() && interaction.customId === 'founder_application_modal') return handleFounderModal(interaction);
    if (!interaction.isChatInputCommand()) return;

    // Acknowledge long-running setup immediately. Discord requires an initial
    // interaction response within ~3 seconds; command logging must never block it.
    if (interaction.commandName === 'setup-klineo' || interaction.commandName === 'setup-linko') {
      if (!isAdmin(interaction)) return interaction.reply({ content: 'Server owner / Administrator only.', ephemeral: true });
      if (!interaction.options.getBoolean('confirm', true)) {
        return interaction.reply({ content: `Preview only. Use \`/${interaction.commandName} confirm:true\` to build/sync LINKO in this server.`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      logCommandUse(interaction).catch(() => {});
      setSetupPhase('starting');
      try {
        await buildKlineO(interaction.guild);
        setSetupPhase('idle');
        return interaction.editReply(`✅ LINKO v10.7 synced for **${interaction.guild.name}**. XP label: **${xpLabel()}**. Multi-server storage, KREATOR/campaign leaderboards, referrals, events, moderation, and managed channels are active.`);
      } catch (error) {
        const phase = getSetupPhase();
        logLinkoError(`${interaction.commandName} failed during ${phase}`, error);
        setSetupPhase('idle');
        const short = String(error?.message ?? error).slice(0, 900);
        return interaction.editReply(`❌ LINKO setup stopped during **${phase}**.\n\n**Error:** ${short}\n\nThis server's database is isolated at **${guildDatabasePath(interaction.guildId)}**. Check \`data/linko-errors.log\` for the full stack.`);
      }
    }

    logCommandUse(interaction).catch(() => {});

    if (interaction.commandName === 'rank' || interaction.commandName === 'points') {
      const user = interaction.options.getUser('member') ?? interaction.user;
      const xp = getXp(user.id);
      const rank = rankForXp(xp);
      const next = nextRankForXp(xp);
      return interaction.reply({ content: `**${user.username}** — **${rank.name}** — **${xp.toLocaleString()} ${xpLabel()}**${next ? `\nNext: ${next.name} at ${next.threshold.toLocaleString()} ${xpLabel()} (${(next.threshold - xp).toLocaleString()} to go).` : `\nPRIME reached. Lifetime ${xpLabel()} continues with no cap.`}`, ephemeral: true });
    }

    if (interaction.commandName === 'leaderboard') {
      const type = interaction.options.getString('type') ?? 'kxp';
      if (!canViewLeaderboard(interaction.member, type)) return interaction.reply({ content: 'This leaderboard is currently private to KlineO staff.', ephemeral: true });
      const limit = Math.max(1, Math.min(50, getSettingInt('leaderboard_limit') || 50));
      if (type === 'referrals') return interaction.reply({ embeds: buildReferralLeaderboardEmbeds(interaction.guild, limit), ephemeral: !leaderboardIsPublic(type) });
      if (type === 'creators') return interaction.reply({ embeds: buildCreatorLeaderboardEmbeds(interaction.guild, limit), ephemeral: !leaderboardIsPublic(type) });
      if (type === 'campaign') {
        const campaignId = interaction.options.getInteger('campaign');
        if (!campaignId) {
          const active = creatorCampaigns('active');
          const text = active.length ? active.map((c) => `**#${c.id}** · ${c.name}`).join('\n') : 'No active creator campaigns.';
          return interaction.reply({ content: `**Active KlineO Creator Campaigns**\n${text}\n\nUse \`/leaderboard type:Creator Campaign campaign:<ID>\`.`, ephemeral: !leaderboardIsPublic(type) });
        }
        return interaction.reply({ embeds: buildCampaignLeaderboardEmbeds(interaction.guild, campaignId, limit), ephemeral: !leaderboardIsPublic(type) });
      }
      return interaction.reply({ embeds: buildLeaderboardEmbeds(interaction.guild, limit), ephemeral: !leaderboardIsPublic(type) });
    }

    if (interaction.commandName === 'commands') {
      return interaction.reply({ content: '**LINKO Member Commands**\n`/rank` · `/points` · `/leaderboard` · `/invite` · `/invites` · `/join-source` · `/confirm-invited` · `/wallet` · `/submit-post` · `/social-card` · `/apply-founder` · `/onboarding` · `/interest` · `/language` · `/suggest` · `/events`', ephemeral: true });
    }

    if (interaction.commandName === 'invite') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first.', ephemeral: true });
      const channel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'welcome' && c.type === ChannelType.GuildText) ?? interaction.channel;
      const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Tracked KlineO invite for ${interaction.user.tag}` });
      db.prepare('INSERT OR REPLACE INTO invite_codes (code, inviter_id, created_at) VALUES (?, ?, ?)').run(invite.code, interaction.user.id, now());
      inviteCacheForGuild(interaction.guildId).set(invite.code, invite.uses ?? 0);
      return interaction.reply({ content: `Your tracked KlineO invite:\n${invite.url}\n\nA referral becomes valid after **7 days** if the member remains in the server and verifies.`, ephemeral: true });
    }

    if (interaction.commandName === 'invites') {
      const stats = getReferralStats(interaction.user.id);
      return interaction.reply({ content: `**Your KlineO referrals**\nInvited: **${stats.total}**\nValid: **${stats.valid}**\nTracked invite: **${stats.tracked}**\nMember-declared valid: **${stats.claimed}**\nModerator-confirmed: **${stats.manual}**\nAwaiting inviter confirmation: **${stats.awaitingConfirmation}**\nPending total: **${stats.pending}**\nReferral ${xpLabel()} logged: **${stats.earned}**`, ephemeral: true });
    }

    if (interaction.commandName === 'join-source') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (hasVerifiedRole(member)) return interaction.reply({ content: 'Your KlineO join source is locked after verification. Ask staff if a correction is required.', ephemeral: true });
      const source = interaction.options.getString('source', true);
      const selectedUser = interaction.options.getUser('member');
      const existingAttribution = getJoinAttribution(member.id);
      const joinedAt = member.joinedTimestamp ?? db.prepare('SELECT joined_at FROM users WHERE user_id=?').get(member.id)?.joined_at ?? now();

      if (source !== 'member') {
        if (selectedUser) return interaction.reply({ content: 'Only select a member when your source is **Invited by a KlineO member**.', ephemeral: true });
        if (existingAttribution?.detected_inviter_id) {
          return interaction.reply({ content: `LINKO detected <@${existingAttribution.detected_inviter_id}> as the invite creator. If that is correct, choose **Invited by a KlineO member**. If it is genuinely incorrect, ask a moderator to resolve the attribution.`, ephemeral: true });
        }
        upsertJoinAttribution(member.id, { source, inviterId: null, detectedInviterId: existingAttribution?.detected_inviter_id ?? null, sourceConfirmed: 1, inviterConfirmed: 1 });
        db.prepare('UPDATE unattributed_joins SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE user_id = ?').run(member.id, now(), member.id);
        scheduleModInboxUpdate(interaction.guild);
        return interaction.reply({ content: `✅ Join source saved as **${joinSourceLabel(source)}**. You can now use the **VERIFY & ENTER KLINEO** button.`, ephemeral: true });
      }

      let inviterUser = selectedUser;
      if (!inviterUser && existingAttribution?.detected_inviter_id) inviterUser = await client.users.fetch(existingAttribution.detected_inviter_id).catch(() => null);
      if (!inviterUser) return interaction.reply({ content: 'Select the KlineO member who invited you. If LINKO detected an invite creator, you may leave the member option empty and LINKO will use that detected inviter.', ephemeral: true });
      if (inviterUser.id === interaction.user.id) return interaction.reply({ content: 'You cannot select yourself as your inviter.', ephemeral: true });
      if (inviterUser.bot) return interaction.reply({ content: 'Bots cannot receive referral credit.', ephemeral: true });
      if (existingAttribution?.detected_inviter_id && inviterUser.id !== existingAttribution.detected_inviter_id) {
        return interaction.reply({ content: `LINKO detected <@${existingAttribution.detected_inviter_id}> as the invite creator. Staff must resolve that attribution before a different inviter can be selected.`, ephemeral: true });
      }
      const inviter = await interaction.guild.members.fetch(inviterUser.id).catch(() => null);
      if (!inviter || (!hasVerifiedRole(inviter) && !hasStaffRole(inviter))) return interaction.reply({ content: 'The inviter must currently be a verified KlineO member.', ephemeral: true });
      if (inviter.joinedTimestamp && Number(inviter.joinedTimestamp) >= Number(joinedAt)) return interaction.reply({ content: 'The selected inviter must have been a KlineO member before you joined.', ephemeral: true });

      const existingReferral = db.prepare('SELECT * FROM referrals WHERE member_id = ?').get(member.id);
      if (existingReferral && existingReferral.inviter_id !== inviter.id) return interaction.reply({ content: `LINKO already has a different pending inviter: <@${existingReferral.inviter_id}>. Ask staff to resolve the attribution.`, ephemeral: true });
      if (!existingReferral) db.prepare('INSERT INTO referrals (member_id, inviter_id, invite_code, joined_at, valid_awarded) VALUES (?, ?, ?, ?, 0)').run(member.id, inviter.id, `self:${member.id}`, joinedAt);

      const detectedMatch = existingAttribution?.detected_inviter_id === inviter.id;
      upsertJoinAttribution(member.id, {
        source: 'member', inviterId: inviter.id, detectedInviterId: existingAttribution?.detected_inviter_id ?? null,
        sourceConfirmed: 1, inviterConfirmed: detectedMatch ? 1 : 0,
      });
      db.prepare('UPDATE unattributed_joins SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE user_id = ?').run(member.id, now(), member.id);
      const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'bot-log' && c.isTextBased());
      if (log) await log.send(`🧭 **Join source selected** — ${member} selected ${inviterUser} as inviter. ${detectedMatch ? 'LINKO invite detection already confirms the inviter.' : 'Awaiting inviter confirmation.'}`).catch(() => {});
      if (!detectedMatch) {
        await inviter.send(`🤝 **KlineO referral confirmation**\n${member.user.username} says you personally invited them to KlineO. If correct, go to the KlineO server and run **/confirm-invited member:${member.user.username}**. If this is not you, alert a moderator. No referral ${xpLabel()} is awarded until the referral later passes verification + 7 days + activity checks.`).catch(() => {});
      }
      scheduleModInboxUpdate(interaction.guild);
      return interaction.reply({ content: `✅ Join source recorded: **Invited by ${inviterUser.username}**. You can now verify and enter KlineO.${detectedMatch ? ' LINKO already confirmed the invite attribution from Discord invite data.' : ' The referral remains pending until the inviter confirms it.'}`, ephemeral: true });
    }

    if (interaction.commandName === 'confirm-invited') {
      const inviter = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(inviter) && !hasStaffRole(inviter)) return interaction.reply({ content: 'Only verified KlineO members can confirm referrals.', ephemeral: true });
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
      if (referred) await referred.send(`✅ ${interaction.user.username} confirmed that they invited you to KlineO. Referral credit is still pending until you are verified, remain for 7 days, and meet activity requirements.`).catch(() => {});
      scheduleModInboxUpdate(interaction.guild);
      return interaction.reply({ content: `✅ Confirmed. ${referredUser}'s referral is now attributed to you and will validate automatically after the remaining qualification rules are met.`, ephemeral: true });
    }

    if (interaction.commandName === 'referred-by') {
      const member = interaction.options.getUser('member', true);
      return interaction.reply({ content: `Please use the new required onboarding command: **/join-source source:Invited by a KlineO member member:${member.username}**. LINKO now requires every new member to select a join source before verification.`, ephemeral: true });
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
        const socials = `**X:** ${profile?.x_account ?? 'Not submitted'}\n**Telegram:** ${profile?.telegram_account ?? 'Not submitted'}`;
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
        if (duplicate && duplicate.user_id !== interaction.user.id) return interaction.reply({ content: 'That public address is already submitted by another KlineO member. Ask KLINEO CORE if this is a legitimate shared address.', ephemeral: true });
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

    if (interaction.commandName === 'submit-post') return handleSocialSubmission(interaction);
    if (interaction.commandName === 'apply-founder') return createFounderApplicationModal(interaction);

    if (interaction.commandName === 'onboarding') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const a = activationRow(member.id);
      const interests = db.prepare('SELECT interest FROM user_interests WHERE user_id = ? ORDER BY interest').all(member.id).map((r) => interestByKey(r.interest)?.[1] ?? r.interest);
      const langs = db.prepare('SELECT lr.name FROM member_languages ml JOIN language_roles lr ON lr.role_id=ml.role_id WHERE ml.user_id=? AND lr.archived=0 ORDER BY lr.name').all(member.id).map((r) => r.name);
      const languageAvailable = languageRows().length > 0;
      const steps = [
        ['Verified', hasVerifiedRole(member)], ['Choose an interest', interests.length > 0],
        ...(languageAvailable ? [['Choose a language', langs.length > 0]] : []),
        ['Introduce yourself', !!a.introduced_at], ['First qualified contribution', !!a.first_impact_at],
      ];
      const done = steps.filter((x) => x[1]).length;
      return interaction.reply({ content: `**KlineO Activation · ${done}/${steps.length}**\n${steps.map(([n,v]) => `${v ? '✅' : '⬜'} ${n}`).join('\n')}\n\nInterests: ${interests.length ? interests.join(', ') : 'None yet'}\nLanguages: ${langs.length ? langs.join(', ') : 'None yet'}\n\nUse \`/interest add\`, \`/language list\`, and introduce yourself in #introductions.`, ephemeral: true });
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
        await member.roles.add(role, 'KlineO self-selected interest');
        db.prepare('INSERT OR IGNORE INTO user_interests (user_id, interest, created_at) VALUES (?, ?, ?)').run(member.id, key, now());
      } else {
        await member.roles.remove(role, 'KlineO interest removed');
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
        return interaction.reply({ content: rows.length ? `**Available KlineO languages**\n${rows.map((r) => `${r.emoji || '🌐'} <@&${r.role_id}>${r.channel_id ? ` → <#${r.channel_id}>` : ''}`).join('\n')}\n\nUse \`/language add role:@LANG...\`.` : 'No language communities have been created yet.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const role = interaction.options.getRole('role', true);
      const row = db.prepare('SELECT * FROM language_roles WHERE role_id=? AND archived=0').get(role.id);
      if (!row) return interaction.editReply('That is not an active LINKO language role.');
      if (action === 'add') {
        await member.roles.add(role, 'KlineO language self-selection');
        db.prepare('INSERT OR IGNORE INTO member_languages (user_id, role_id, created_at) VALUES (?, ?, ?)').run(member.id, role.id, now());
      } else {
        await member.roles.remove(role, 'KlineO language removed');
        db.prepare('DELETE FROM member_languages WHERE user_id=? AND role_id=?').run(member.id, role.id);
      }
      const count = Number(db.prepare('SELECT COUNT(*) AS c FROM member_languages WHERE user_id=?').get(member.id)?.c ?? 0);
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
      return interaction.reply({ content: rows.length ? `**Upcoming KlineO Events**\n${rows.map((r) => `**#${r.id} ${r.title}** — ${eventStatusLabel(r.status)} — <t:${Math.floor(Number(r.start_at)/1000)}:F>${r.voice_channel_id ? ` — <#${r.voice_channel_id}>` : ''}`).join('\n')}` : 'No upcoming KlineO events are scheduled.', ephemeral: true });
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
      const eventLong = ['create','start','end','cancel'].includes(action);
      if (eventLong) await interaction.deferReply({ ephemeral: true });
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
        const title = interaction.options.getString('title', true).trim();
        const startAt = parseEventStart(interaction.options.getString('start', true));
        if (startAt < now() - 60000) return interaction.editReply('Event start time must be in the future.');
        const duration = interaction.options.getInteger('duration', true);
        const description = interaction.options.getString('description')?.trim() || '';
        const voice = interaction.options.getChannel('voice');
        const result = db.prepare('INSERT INTO community_events (title,description,start_at,duration_minutes,voice_channel_id,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(title, description, startAt, duration, voice?.id || null, interaction.user.id, now());
        const id = Number(result.lastInsertRowid);
        const row = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);
        const eventsChannel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
        if (eventsChannel) {
          const msg = await eventsChannel.send({ embeds: [buildEventEmbed(row)], components: eventButtons(id, row.status) });
          db.prepare('UPDATE community_events SET public_message_id=? WHERE id=?').run(msg.id, id);
        }
        scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild);
        return interaction.editReply(`✅ Event **#${id} ${title}** published.`);
      }
      if (action === 'list') {
        const rows = db.prepare("SELECT * FROM community_events WHERE status IN ('planned','live') ORDER BY start_at ASC LIMIT 20").all();
        return interaction.reply({ content: rows.length ? rows.map((r) => `#${r.id} **${r.title}** — ${eventStatusLabel(r.status)} — <t:${Math.floor(Number(r.start_at)/1000)}:F>`).join('\n') : 'No upcoming/live events.', ephemeral: true });
      }
      const id = interaction.options.getInteger('id', true);
      const row = db.prepare('SELECT * FROM community_events WHERE id=?').get(id);      if (!row) return eventLong ? interaction.editReply('Event not found.') : interaction.reply({ content: 'Event not found.', ephemeral: true });
      if (action === 'start') {
        if (!['planned'].includes(row.status)) return interaction.editReply(`Event is already **${eventStatusLabel(row.status)}**.`);
        if (row.voice_channel_id) {
          const channel = interaction.guild.channels.cache.get(row.voice_channel_id);
          if (channel) await startVoiceEvent(interaction.guild, channel, row.title, interaction.user.id);
        }
        db.prepare('UPDATE community_events SET status=?, started_at=? WHERE id=?').run('live', now(), id);
        await updateEventMessage(interaction.guild, id); scheduleModInboxUpdate(interaction.guild); scheduleHealthUpdate(interaction.guild);
        return interaction.editReply(`🔴 Event **#${id} ${row.title}** is now LIVE.${row.voice_channel_id ? ' Official voice ${xpLabel()} is active.' : ''}`);
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
        db.prepare('UPDATE community_events SET status=?, ended_at=? WHERE id=?').run('cancelled', now(), id);
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
        const slug = slugifyChannelName(interaction.options.getString('slug', true));
        const roleName = `${LANGUAGE_ROLE_PREFIX}${name}`;
        let role = interaction.guild.roles.cache.find((r) => r.name === roleName);
        if (!role) role = await interaction.guild.roles.create({ name: roleName, color: BRAND.blue, hoist: false, reason: `Language community created by ${interaction.user.tag}` });
        let category = interaction.guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAMES.languages);
        if (!category) category = await ensureCategory(interaction.guild, CATEGORY_NAMES.languages, [overwrite(interaction.guild.roles.everyone.id, [], [PermissionFlagsBits.ViewChannel])]);
        const staff = ['KLINEO CORE','KLINEO TEAM','MODERATOR'].map((n) => interaction.guild.roles.cache.find((r) => r.name===n)).filter(Boolean);
        const perms = privateFor(interaction.guild.roles.everyone, [role, ...staff]);
        const chName = `${emoji}・${slug}`;
        let channel = interaction.guild.channels.cache.find((c) => c.parentId===category.id && c.name===chName && c.type===ChannelType.GuildText);
        if (!channel) channel = await interaction.guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category.id, topic: `${name}-speaking KlineO community.`, permissionOverwrites: perms, reason: 'LINKO language manager' });
        db.prepare(`INSERT INTO language_roles (role_id,name,emoji,channel_id,created_by,created_at,archived) VALUES (?,?,?,?,?,?,0) ON CONFLICT(role_id) DO UPDATE SET name=excluded.name, emoji=excluded.emoji, channel_id=excluded.channel_id, archived=0`).run(role.id, name, emoji, channel.id, interaction.user.id, now());
        db.prepare(`INSERT INTO managed_channels (channel_id,category_name,access,links_allowed,kxp_enabled,created_by,created_at,archived) VALUES (?,?,?,?,?,?,?,0)
          ON CONFLICT(channel_id) DO UPDATE SET links_allowed=0, kxp_enabled=0, archived=0`).run(channel.id, CATEGORY_NAMES.languages, 'language', 0, 0, interaction.user.id, now());
        const log = interaction.guild.channels.cache.find((c) => baseChannelName(c.name)==='bot-log' && c.isTextBased());
        if (log) await log.send(`🌍 ${interaction.user} created language community **${name}** → ${channel}. Links blocked by default.`).catch(()=>{});
        return interaction.editReply(`✅ Created ${emoji} **${name}** → ${channel}. Members can join with \`/language add\`.`);
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
        return interaction.reply({ content: `✅ Created creator campaign **#${id} · ${name}**. KREATORs can tag approved posts with \`/submit-post campaign:${id}\`.`, ephemeral: true });
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
      return interaction.reply({ content: `**USER ${xpLabel()} REPORT**\nUser: ${user}\nRole: **${rank.name}**\nTotal ${xpLabel()}: **${b.total.toLocaleString()}**\n\nMessages: **${b.messages.toLocaleString()}**\nVoice: **${b.voice.toLocaleString()}**\nReferrals: **${b.referrals.toLocaleString()}**\nSocial Posts: **${b.social.toLocaleString()}**\nBug Reports: **${b.bugs.toLocaleString()}**\nProfile / Wallet: **${b.profile.toLocaleString()}**\nManual / Other: **${b.manual.toLocaleString()}**`, ephemeral: true });
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
      if (!referred || !inviter) return interaction.reply({ content: 'Both members must still be in the KlineO server.', ephemeral: true });
      if (!hasVerifiedRole(referred)) return interaction.reply({ content: `${referredUser} must be verified before a manual referral can be confirmed.`, ephemeral: true });
      if (!hasVerifiedRole(inviter) && !hasStaffRole(inviter)) return interaction.reply({ content: `${inviterUser} must be a verified KlineO member.`, ephemeral: true });
      const joinedAt = referred.joinedTimestamp ?? db.prepare('SELECT joined_at FROM users WHERE user_id = ?').get(referred.id)?.joined_at ?? now();
      const ageMs = now() - Number(joinedAt);
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (ageMs < sevenDays) {
        const remainingDays = Math.ceil((sevenDays - ageMs) / (24 * 60 * 60 * 1000));
        return interaction.reply({ content: `${referredUser} has not been in KlineO for 7 days yet. About **${remainingDays} day(s)** remain.`, ephemeral: true });
      }
      const activity = referralActivityCount(referred.id, joinedAt);
      const activeDays = referralActivityDays(referred.id, joinedAt);
      if (activity < Math.max(1, getSettingInt('referral_activity_min_events')) || activeDays < Math.max(1, getSettingInt('referral_activity_min_days'))) {
        return interaction.reply({ content: `${referredUser} has been in KlineO for 7 days and is verified, but LINKO still requires activity on at least **${Math.max(1, getSettingInt('referral_activity_min_days'))} different day(s)** before referral validation. Current active days: **${activeDays}**.`, ephemeral: true });
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
      return interaction.reply({ content: `✅ ${xpLabel()}, referral, KREATOR and campaign leaderboards refreshed.`, ephemeral: true });
    }

    if (interaction.commandName === 'export-leaderboard') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await interaction.guild.members.fetch().catch(() => null);
      const type = interaction.options.getString('type', true);
      const csv = leaderboardCsv(interaction.guild, type);
      const label = type === 'kxp' ? 'kxp-leaderboard' : type === 'referrals' ? 'referral-leaderboard' : 'full-community';
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

    if (interaction.commandName === 'server-settings') {
      if (!isAdmin(interaction)) return interaction.reply({ content: 'Server owner / Administrator only.', ephemeral: true });
      const action = interaction.options.getSubcommand();
      if (action === 'view') {
        return interaction.reply({
          content: `**LINKO SERVER SETTINGS**\nServer: **${interaction.guild.name}**\nGuild ID: \`${interaction.guildId}\`\nXP name: **${xpLabel()}**\nDatabase: \`${guildDatabasePath(interaction.guildId)}\`\nCampaign board retention: **${getSettingInt('campaign_leaderboard_retention_days')} days**\nAllowed-server mode: **ON**`,
          ephemeral: true,
        });
      }
      if (action === 'xp-name') {
        const requested = interaction.options.getString('name', true);
        const label = normalizeXpLabel(requested);
        if (!label) return interaction.reply({ content: 'XP name must contain **1 to 6 letters only**. Examples: `KXP`, `DOTXP`, `XP`.', ephemeral: true });
        setSetting('xp_label', label);
        await updatePublicKxpDocs(interaction.guild).catch(() => {});
        await updateAllLeaderboards(interaction.guild).catch(() => {});
        return interaction.reply({ content: `✅ This server's XP is now called **${label}**. Existing point balances are unchanged; only the display name changed.`, ephemeral: true });
      }
    }
    if (interaction.commandName === 'kxp-settings') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const active = getActiveVoiceEvent();
      const label = xpLabel();
      return interaction.reply({ content: `**${interaction.guild.name} ${label} SETTINGS**
Message: **+${getSettingInt('kxp_message')} ${label}**
Voice: **+${getSettingInt('kxp_voice_interval')} ${label} per ${getSettingInt('voice_interval_minutes')} qualifying event minutes**
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

    if (interaction.commandName === 'set-kxp') {
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
${xpLabel()} Points: **${getSetting('kxp_leaderboard_visibility')}**
Referrals: **${getSetting('referral_leaderboard_visibility')}**
KREATORs: **${getSetting('creator_leaderboard_visibility')}**
Creator Campaigns: **${getSetting('campaign_leaderboard_visibility')}**

Public = visible to verified members. Private = visible only to staff.`, ephemeral: true });
      }
      if (!board || !visibility) return interaction.reply({ content: 'Choose both **board** and **visibility**, or leave both blank to view current settings.', ephemeral: true });
      setSetting(leaderboardVisibilityKey(board), visibility);
      await setLeaderboardChannelVisibility(interaction.guild, board, visibility);
      if (board === 'campaign') await updateCampaignLeaderboardMessages(interaction.guild);
      else await updateLeaderboardMessage(interaction.guild, board);
      const boardLabel = board === 'kxp' ? `${xpLabel()} Points` : board === 'referrals' ? 'Referral' : board === 'creators' ? 'KREATOR' : 'Creator Campaign';
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
Reward: **+${getSettingInt('kxp_voice_interval')} ${label} / ${getSettingInt('voice_interval_minutes')} qualifying minutes**` : `No voice ${label} event is active.`, ephemeral: true });
      }
      if (action === 'start') {
        const channel = interaction.options.getChannel('channel', true);
        const name = interaction.options.getString('name', true).trim();
        const id = await startVoiceEvent(interaction.guild, channel, name, interaction.user.id);
        const eventsChannel = interaction.guild.channels.cache.find((c) => baseChannelName(c.name) === 'events' && c.isTextBased());
        if (eventsChannel) await eventsChannel.send(`🎙️ **Official voice event started:** ${name}\nJoin <#${channel.id}>. Verified members earn **+${getSettingInt('kxp_voice_interval')} ${label} per ${getSettingInt('voice_interval_minutes')} qualifying minutes** while this event is active. At least 2 real users must be present.`).catch(() => {});
        return interaction.reply({ content: `✅ Voice ${label} event #${id} started in ${channel}.`, ephemeral: true });
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
      return interaction.reply({ content: `✅ Updated the **${slot}** image and refreshed the live KlineO message.`, ephemeral: true });
    }

    if (interaction.commandName === 'social-card') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!hasVerifiedRole(member)) return interaction.reply({ content: 'Verify yourself first in #verify.', ephemeral: true });
      const type = interaction.options.getString('type', true);
      await interaction.deferReply({ ephemeral: true });
      const card = await generateSocialCard(interaction.guild, member, type);
      const file = new AttachmentBuilder(card.buffer, { name: `klineo-${type}-${interaction.user.id}.png` });
      return interaction.editReply({ content: `**Your ${card.title} is ready.**\nSuggested caption:\n${card.caption}\n\nShare the image on your socials. If the post is about KlineO, submit the post URL with \`/submit-post\` for review.`, files: [file] });
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
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Only KLINEO CORE / server administrators can change official links.', ephemeral: true });
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
      if (!hasCoreRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Only KLINEO CORE / server administrators can change official team profiles.', ephemeral: true });
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
      return interaction.reply({ content: '**LINKO Moderator Commands**\n`/user-kxp` · `/give-xp` · `/remove-xp` · `/approve-bug` · `/referral-stats` · `/confirm-referral` · `/impact-status` · `/mark-impactful` · `/remove-message-xp` · `/impact-settings` · `/set-impact` · `/kxp-settings` · `/set-kxp` · `/voice-event` · `/leaderboard-settings` · `/creator-campaign` · `/grant-klineo-role` · `/create-client-space` · `/refresh-leaderboard` · `/export-leaderboard` · `/wallet-admin` · `/export-wallets` · `/refresh-stats` · `/server-image` · `/official-links` · `/team-profile` · `/community-health` · `/refresh-health` · `/mod-inbox` · `/event` · `/suggestion` · `/language-manager` · `/channel-manager`', ephemeral: true });
    }

    if (interaction.commandName === 'grant-klineo-role') {
      if (!hasStaffRole(interaction.member) && !isAdmin(interaction)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
      const user = interaction.options.getUser('member', true);
      const roleName = interaction.options.getString('role', true);
      const role = interaction.guild.roles.cache.find((r) => r.name === roleName);
      if (!role) return interaction.reply({ content: `Role ${roleName} is missing. Run /setup-klineo.`, ephemeral: true });
      const member = await interaction.guild.members.fetch(user.id);
      await member.roles.add(role, `Granted by ${interaction.user.tag}`);
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