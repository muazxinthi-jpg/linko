# LINKO v10.14.0

LINKO v10.14 replaces command-first member onboarding with a permanent, button-driven member profile experience.

## Member onboarding

- `#verify` now uses **START ONBOARDING** instead of requiring `/join-source` first.
- New members choose their join source from a dropdown.
- If they were invited by a member, LINKO uses Discord invite detection when available or a native member selector when needed.
- An inviter does **not** need to be verified for the invited member to continue verification.
- Referral rewards stay pending until the inviter is verified/eligible and any required confirmation is complete.
- `/join-source` remains available as a manual fallback.

## MY LINKO PROFILE

- Every verified member has a permanent private profile dashboard available from the **MY LINKO PROFILE** button in `#bot-commands` or `/profile`.
- The dashboard can be reopened at any time, including months after verification.
- Optional editable sections: Socials, Interests, Languages, EVM wallet and Solana wallet.
- Socials use Discord modals; interests/languages use native selectors; wallets use a private modal.
- Optional profile details never expire and never block normal community access.
- Existing `/wallet`, `/interest`, `/language`, `/onboarding` and related commands remain for backwards compatibility.

## Referral safety

- The referred member's verification is now independent from inviter verification.
- LINKO checks inviter eligibility again before referral KXP is actually awarded.
- A pending unverified inviter can later verify and complete referral confirmation without forcing the referred member to redo onboarding.

---
# LINKO v10.13.0

LINKO v10.13 makes LINKO events first-class Discord Scheduled Events.

## Native Discord Events

- `/event create` now creates both the LINKO event record and a native Discord Scheduled Event, so it appears in the server's **Events** panel.
- Existing future LINKO events without a native Discord event are backfilled automatically on startup.
- The `#events` channel is public/read-only for `@everyone`, while staff retain posting access.
- For **Everyone in Server** Voice/Stage events, LINKO makes the event room visible while scheduled but keeps `Connect` blocked until the event goes live. This lets all server members see the native Discord event without entering early.
- At `/event start` (or when staff starts the native Discord event), LINKO opens the event room according to its selected access and starts official voice tracking.
- Native Discord event state and LINKO event state stay synchronized for start, completion, and cancellation.
- When the event ends/cancels, the exact pre-event Voice/Stage permission snapshot is restored.

Discord notes that scheduled events tied to restricted voice channels are only visible to members who can view that channel. LINKO therefore prepares planned visibility for whole-community events while preserving connect restrictions until the event starts.

---
# LINKO v10.12.0

LINKO v10.12 simplifies event scheduling for staff.

## Simple UTC event date + time

`/event create` now uses two straightforward required fields instead of an ISO timestamp:

- `date`: `DD-MM-YYYY`
- `time`: `HH:MM` in 24-hour **UTC**

Example:

```text
Date: 20-10-2026
Time: 16:00
```

LINKO validates real calendar dates and 24-hour times, then converts them internally to UTC timestamps for Discord.

---
# LINKO v10.11.0

LINKO v10.11 adds safe per-event Voice/Stage access control and prevents setup sync from relocking a live event room.

## Event room access

- `/event create` can set room access to **Everyone in Server**, **Verified Members**, or **Keep Current Channel Permissions**.
- Events with a Voice/Stage room default to **Everyone in Server** when no access option is supplied.
- `/event access` can change access before an event starts or while it is live.
- When an event starts, LINKO snapshots the channel's exact permission overwrites before applying event access.
- When the event ends or is cancelled, LINKO restores the exact pre-event permission snapshot.
- `/setup-linko` preserves permissions and parent placement for any Voice room currently attached to a live LINKO event, preventing the setup sync from relocking it.
- Event attendance counts all human attendees. Official voice-event XP remains limited to verified members and keeps the existing anti-farming rules.

Existing events created before v10.11 retain the previous **Verified Members** default unless staff explicitly changes their access.

---
# LINKO v10.10.0

LINKO v10.10 connects the v10.9 voice-session tracker to Community Health.

## Community Health voice metrics

- **Voice Participants** counts unique members who participated in any Discord Voice or Stage session during the selected health window.
- The note under Voice Participants shows cumulative tracked voice time for that window.
- Open/live sessions are included immediately; members do not need to leave voice before they count.
- **Event Attendees** remains separate and counts attendance recorded for LINKO-managed official community events.
- Normal voice attendance remains analytics-only and awards **0 XP/KXP** unless an official `/voice-event` is active.

The visual Community Health card now displays six lower-row metrics: Verified Members, Social Posts, Voice Participants, Event Attendees, Referrals and Suggestions.

---
# LINKO v10.9.0

LINKO v10.9 separates **voice analytics** from **voice rewards**.

## All voice attendance

LINKO now records human joins/leaves for every Discord Voice and Stage channel in each managed Guild. These sessions are analytics-only and do **not** award XP/KXP.

Stored session data includes member, channel, join time, leave time and duration. Open sessions are reconciled when the bot restarts.

## Official voice XP

Only a staff-started official `/voice-event` can award voice XP:

- Listening: **+2 XP/KXP per 15 qualifying minutes** by default.
- Normal Discord voice calls outside an official event: **0 XP/KXP**.
- At least 2 real users must be present for official listening time to qualify.
- Members must be verified and not self/server deafened.

## Speaker participation

Official events support both Voice and Stage channels.

- In a Stage event, LINKO records a hand raise.
- The member must then be promoted to speaker and remain a speaker for at least 1 minute.
- LINKO awards **+2 XP/KXP once per official event** by default.
- The once-per-event guard prevents repeated speaker farming.
- For normal Voice channels, staff can confirm genuine speaker participation with `/voice-event speaker`.

`/set-xp` / `/set-kxp` can change the listening reward and speaker-participation bonus independently.

Community events can also use Voice or Stage channels for attendance recording.

---
# LINKO v10.8.0

LINKO v10.8 makes every managed Guild project-aware before setup completes.

## Two-step Project Profile

When a new non-KlineO Guild runs `/setup-linko confirm:true`, LINKO now collects project context in two steps instead of building a generic community immediately.

Step 1 asks for:
- project/community name
- one-line positioning
- what the project is
- who the project/community is for
- what members should get from the community

Step 2 asks for:
- main products/services
- current status or milestone (optional)
- the first project-specific action a new member should take
- primary website/app URL (optional, HTTPS only)
- wording guidance for what LINKO should highlight or avoid (optional)

`/project-profile view`, `/project-profile configure`, and `/project-profile details` let Core/Admin review or change this context later.

## Project-aware welcome

The persistent welcome message now uses the saved Project Profile for positioning, audience, products/services, current status, product links, community value and the project-specific first action.

Generic Discord onboarding still remains intact: rules, join source, verification, OBSERVER access, onboarding, XP and security guidance.

## Branded project links

`/project-profile links` lets Core/Admin configure up to two branded links used in the Welcome `Explore` section:

- primary display label + HTTPS URL
- optional second display label + HTTPS URL

The labels are project-specific instead of generic `Primary product` / `Secondary product` wording. If a label is left blank but a URL exists, LINKO falls back to the URL hostname.

KlineO defaults to:

- `KlineO.xyz · Trading & Execution` → `https://klineo.xyz`
- `KlineO.io · Liquidity Intelligence` → `https://klineo.io`

KlineO is pre-seeded with its current `.xyz` / `.io` positioning so its setup does not need to ask for information LINKO already knows. Existing Guild databases upgrade additively through the settings table; no XP, referral, wallet or campaign history is reset.

Additional official/social links remain managed through `/official-links`, and section artwork remains managed through `/server-image`.

---
# LINKO v10.7.0

LINKO v10.7 adds a lightweight multi-server foundation on top of the v10.6 KREATOR economy.

## Multi-server isolation

- One LINKO process can serve multiple allowlisted Discord servers.
- Configure servers with `GUILD_IDS` as a comma-separated list. Legacy `GUILD_ID` remains supported for a single server.
- Each Discord server gets its own SQLite database:
  - `data/guilds/<guild-id>.sqlite`
- XP, referrals, wallets, creator campaigns, KREATOR scores, settings, events, managed channels and moderation state are isolated per server.
- The same Discord user can therefore have different XP balances, ranks and campaign history in different servers.
- Railway should keep the persistent volume mounted at `/app/data`, so per-server databases live under `/app/data/guilds/`.

## Per-server XP name

Each server can name its own points system with **1 to 6 letters**.

Use:

```text
/server-settings xp-name name:DOTXP
```

Examples: `KXP`, `DOTXP`, `XP`, `POINTS`.

- Input is normalized to uppercase.
- Changing the XP name changes presentation only. It does not reset balances, ranks or XP history.
- KlineO defaults to **KXP**.
- Leaderboards, reward messages, social cards, XP rules and core reports use the server's configured label.

## Batch channel creation

Staff can create up to **10 managed channels at once** with:

```text
/channel-manager batch-create
```

The batch shares category, text/voice type, access policy, optional emoji, topic, link policy, XP eligibility and slowmode. LINKO creates channels sequentially and reports any partial failures instead of silently rolling back successful channels.

## KREATOR and campaign retention

The v10.6 model remains:

- overall XP leaderboard: permanent
- lifetime KREATOR leaderboard: permanent
- campaign/weekly leaderboard: temporary
- closed campaign leaderboard remains visible for **7 days**
- expired detailed campaign-reaction rows are pruned
- already-awarded XP remains permanent in the member's lifetime KREATOR score and overall XP

## Current early-data upgrade plan

KlineO's current production data is intentionally small/early. For the v10.7 cutover, the existing single-server `data/linko.sqlite` can remain on the Railway volume as an archive while LINKO starts the new guild-isolated database at:

```text
/app/data/guilds/1552805183082471474.sqlite
```

No destructive deletion of the old database is required.

## Per-server community profile

LINKO now has a server profile layer, so a second Discord server does not need to behave like a copy of KlineO.

Administrators can configure:

```text
/server-settings community-name name:Polkadot
/server-settings xp-name name:DOTXP
/server-settings preset type:Core Community
/server-settings module name:KREATOR enabled:true
/server-settings view
```

Two presets are available:

- **KlineO Full**: Signal Room, KREATOR, Founder Hub and Liquidity Studio enabled.
- **Core Community**: core XP/referrals/events plus Signal Room enabled; KREATOR, Founder Hub and Liquidity Studio disabled until explicitly enabled.

For a brand-new guild, LINKO uses a safe default automatically:
- a server named **KlineO** starts with the KlineO Full preset and **KXP**;
- any other server starts with the Core Community preset and generic **XP**.

The profile controls the community display name, XP label, core/team role names, branded community/social/XP categories, onboarding copy, public cards and optional module spaces. Disabling a module hides its existing category from members instead of deleting history. Re-enabling it and running `/setup-linko confirm:true` restores/syncs the module.

Recommended setup for a new external community:

```text
/server-settings community-name name:<COMMUNITY>
/server-settings xp-name name:<1-6 LETTER XP NAME>
/server-settings preset type:Core Community
/server-settings module name:<OPTIONAL MODULE> enabled:true
/setup-linko confirm:true
```

KlineO can keep the full preset and KXP defaults.

Internal compatibility identifiers such as legacy `kxp_*` setting keys and `[KLINEO-*]` seed markers remain intentionally unchanged. They are implementation details, not cross-server branding.

---
# LINKO v10.6.0

LINKO v10.6 adds the **KREATOR economy** on top of the existing KXP system. KREATOR points are attribution, not a separate currency: approved creator-content KXP and reaction-milestone KXP also increase the member's normal overall KXP balance and rank progression.

## KREATOR leaderboard

- Approved creators receive the **KREATOR** functional role with a distinct violet color.
- KREATOR remains separate from OBSERVER → PRIME community ranks and carries no administrative permissions.
- `🏅・kreator-leaderboard` is public to verified members by default.
- Approved KREATOR social-post KXP contributes to both the KREATOR leaderboard and the overall KXP leaderboard.

## Reaction KXP

For LINKO-published approved KREATOR posts:

- Only **unique verified Discord members** count.
- Bots and the post creator's own reactions do not count.
- Multiple emoji from the same member still count as one unique reactor.
- Default milestone: **100 unique verified reactors = +1 KXP**.
- Default maximum: **3 reaction milestones per post**.
- Removing reactions lowers the live unique-reaction count, but already-earned milestones are not clawed back or awarded twice after re-adding reactions.

## Creator campaigns

- Staff can use `/creator-campaign create/list/close`.
- KREATORs can attach an active campaign with `/submit-post campaign:<ID>`.
- `🏁・campaign-leaderboard` is public to verified members by default.
- Campaign KXP also contributes to the lifetime KREATOR leaderboard and normal overall KXP.
- Closing a campaign blocks new tagged submissions and freezes new reaction-milestone awards for that campaign.
- Closed campaign leaderboard messages remain visible for **7 days**, then LINKO removes the temporary board automatically.
- The campaign record and already-awarded KXP remain intact, so lifetime KREATOR and overall KXP rankings are unaffected.
- Expired campaign reaction-detail rows are pruned after the retention window to keep SQLite lightweight.

## Upgrade safety

The v10.6 SQLite changes are additive. They do **not** reset existing KXP, referrals, wallet records, settings, or other community data. Keep the persistent Railway volume mounted at `/app/data`.

---

# LINKO v10.5.1 FINAL

Hotfix: split the moderator command-center seed into two Discord messages so `/setup-klineo` stays under Discord's 2,000-character message limit. No database schema or KXP/referral data reset is required.

# LINKO v10.5 FINAL — KlineO Community Operations Build

This is the final KlineO-only test build before any future public/multi-server refactor.

## Final onboarding + referral flow

Every new member must select a join source **before verification** using `/join-source`.

Available sources:

- Invited by a KlineO member
- Found KlineO myself
- X / social media
- Telegram
- Event / AMA
- Partner / creator

If a KlineO member invited the user, the user selects that Discord member. LINKO then creates a **pending referral**. If LINKO already detected the invite creator from Discord invite data, that inviter is considered confirmed. If the referral was declared manually, the inviter confirms it with `/confirm-invited @member`.

The new member does **not** need to wait for inviter confirmation to enter the server. They only need to select their join source, then they can use the Verify button.

A referral becomes valid only when all of these are true:

1. join source was selected,
2. inviter attribution is confirmed,
3. referred member is verified,
4. referred member remains in KlineO for at least 7 days,
5. LINKO records qualifying activity,
6. activity occurs on at least **2 different days** during the qualification period.

Only then does the inviter receive the configured referral KXP.

## Wallet + social submission

`/wallet set` requires:

- EVM or Solana
- public wallet address
- X account
- Telegram username

Default first-time KXP rewards:

- first X submission: +1 KXP
- first Telegram submission: +1 KXP
- first EVM wallet submission: +1 KXP
- first Solana wallet submission: +1 KXP

Editing/replacing an already rewarded item does not award KXP again.

LINKO never connects to wallets, requests signatures, sends transactions, requests approvals, or asks for private keys/seed phrases.

## KXP

KXP is uncapped. PRIME unlocks at 10,000 KXP, but members can continue earning indefinitely beyond 10,000.

## Existing systems retained

- persistent live Top 50 KXP leaderboard
- persistent live Top 50 referral leaderboard
- staff CSV leaderboard/community exports
- wallet CSV export for KLINEO CORE/Admin
- KXP breakdown and rank progression
- impact-scored message KXP
- official voice-event KXP
- social-post review + KXP
- social cards
- Community Health dashboard
- Moderator Inbox
- Founder Hub and Liquidity Studio workflows
- product suggestions / roadmap
- language communities
- interest roles
- safe Channel Manager
- setup diagnostics in `data/linko-errors.log`

## Important upgrade rule

The ZIP contains an empty `data` directory. **Do not overwrite your working database with an empty database.**

Copy your existing working `.env` and complete working `data` folder from v10.2 into this build before starting.

Then run:

```powershell
npm install
npm start
```

Before `/setup-klineo confirm:true`, verify:

- `/user-kxp` still shows existing KXP
- `/refresh-leaderboard` works
- `/export-leaderboard` posts the CSV in `mod-commands`

Then run `/setup-klineo confirm:true` once.
