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
