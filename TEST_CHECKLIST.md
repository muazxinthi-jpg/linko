# LINKO v10.9 Test Checklist

Use this checklist before merging the multi-server release into production.

## Static and startup checks

1. Run `npm install` and `npm run check`.
2. Confirm Node is >=22.5 and `node:sqlite` loads.
3. Confirm `.env.example` contains placeholders only and no token.
4. Confirm both configurations work:
   - `GUILD_IDS=serverA,serverB`
   - legacy single-server `GUILD_ID=serverA` when `GUILD_IDS` is absent.
5. Confirm an unlisted guild is ignored by LINKO.

## Per-server storage isolation

6. Start with two test Discord servers and confirm LINKO creates two separate files under `data/guilds/`.
7. Use the same Discord account in both servers and award different XP amounts. Confirm balances and ranks remain different.
8. Confirm referrals, wallets, campaigns, KREATOR activity, settings, events and managed-channel records created in server A are absent from server B.
9. Confirm a leaderboard refresh in one server does not overwrite or cancel the other server's refresh.
10. Confirm invite tracking is independent per guild.

## Voice attendance + official XP tests

- Join and leave a normal Discord Voice channel with no official event active. Confirm a `voice_sessions` row is created/closed and **no XP/KXP is awarded**.
- Move between two Voice/Stage channels. Confirm LINKO closes the first session and opens a second session.
- Restart LINKO while a member is in voice. Confirm open-session reconciliation does not create duplicate open sessions.
- Run `/voice-event start` in a normal Voice channel. Confirm verified listeners receive the configured reward only after each 15 qualifying minutes and only when at least 2 real users are present.
- Confirm self-deafened/server-deafened members do not accrue official listening minutes.
- Run `/voice-event start` in a Stage channel. Confirm an audience member raising a hand is recorded.
- Promote that member to speaker. Confirm no immediate speaker XP is awarded.
- Keep the member as a Stage speaker for at least 1 minute. Confirm the configured speaker bonus is awarded exactly once.
- Demote/re-promote the same member. Confirm no second speaker bonus is awarded for the same event.
- In a normal Voice official event, run `/voice-event speaker member:<user>` and confirm staff can award the once-per-event speaker bonus manually.
- Confirm `/kxp-settings` shows listening reward, speaker bonus and `Normal voice calls: attendance only, 0 KXP`.
- Confirm `/set-kxp event:Official voice · 15-minute listening` and `Official voice · speaker participation bonus` can be changed independently.
- Create a managed community event using a Stage channel and confirm actual attendance is recorded.
## Project Profile + welcome tests

Before continuing to the server-profile tests:

- In a brand-new non-KlineO test Guild, run `/setup-linko confirm:true` and confirm LINKO opens Project Profile step 1 instead of immediately building the server.
- Submit step 1 and confirm LINKO responds with the **CONTINUE PROJECT SETUP** button.
- Open step 2 and confirm products/services and the first member action are required, while status, primary URL and wording guidance may be left empty.
- Enter a non-HTTPS primary URL and confirm LINKO rejects it without running server setup.
- Complete step 2 with a valid HTTPS URL and confirm LINKO finishes setup.
- Confirm `/server-settings view` changes Project Profile from **NEEDS SETUP** to **COMPLETE**.
- Confirm the persistent welcome embed shows project positioning, audience, products/services, optional current status, community value, product link(s), and the project-specific first action.
- Confirm the private Project Profile summary shows the wording guidance, but the public welcome message does not expose that internal guidance.
- Run `/project-profile configure`, change a core field, and confirm the live welcome message refreshes.
- Run `/project-profile details`, change products/status/first action, and confirm the live welcome message refreshes.
- Confirm KlineO is seeded automatically with KlineO.xyz, KlineO.io, its audience/products/status/first action, and does not require the setup wizard when those fields are already present.
- Run `/project-profile links` and confirm Core/Admin can set a primary label + URL and optional second label + URL.
- Confirm a label without its matching URL is rejected.
- Confirm non-HTTPS product URLs are rejected.
- Confirm the Welcome `Explore` section uses the configured labels as clickable links, with no generic `Primary product` / `secondary product` wording.
- Clear a custom label while keeping its URL and confirm LINKO falls back to the URL hostname.
- In KlineO, confirm the Welcome links render as **KlineO.xyz · Trading & Execution** and **KlineO.io · Liquidity Intelligence**.
- Confirm existing XP, referrals, wallets, campaigns and other Guild data remain unchanged after the additive settings upgrade.
## Server profile and module tests

11. In KlineO, confirm first-run defaults are KlineO / KXP / KlineO Full, with Signal Room, KREATOR, Founder Hub and Liquidity Studio enabled.
12. In a second non-KlineO test server, confirm first-run defaults are its Discord server name / XP / Core Community, with Signal Room enabled and KREATOR, Founder Hub and Liquidity Studio disabled.
13. Set the second server to `/server-settings community-name name:Polkadot` and `/server-settings xp-name name:DOTXP`.
14. Confirm KlineO retains `KLINEO CORE` / `KLINEO TEAM`, while the second server uses `COMMUNITY CORE` / `COMMUNITY TEAM`.
15. Confirm community/social/XP categories use the configured community and XP labels.
16. Confirm disabled optional-module categories are absent on first setup; if they existed previously, disabling hides them rather than deleting history.
17. Enable KREATOR, rerun `/setup-linko confirm:true`, and confirm its role/channels become available without affecting other guild data.
18. Enable Liquidity Studio and confirm Founder Hub is enabled automatically. Disable Founder Hub and confirm Liquidity Studio is disabled automatically.
19. Rename the community and XP label after setup. Confirm existing dynamic roles/categories are renamed where possible and balances remain unchanged.
20. Confirm welcome, verify, official links, social cards, events, health and referral messages use the current server branding.

## XP naming

11. Leave KlineO on `KXP`.
12. In the second server run `/server-settings xp-name name:DOTXP`.
13. Confirm `/server-settings view` reports each server's independent label and database path.
14. Confirm the same stored numeric balance renders as KXP in KlineO and DOTXP in the second server.
15. Confirm leaderboards, `/points`, XP settings, reward messages, social cards and CSV headers use the configured server label.
16. Reject invalid names containing spaces, punctuation, digits, or more than 6 letters.
17. Confirm changing DOTXP to another valid label changes presentation without changing balances.

## KREATOR economy

18. Run `/setup-linko confirm:true` and confirm the KREATOR role exists with the distinct violet color and no admin/mod permissions.
19. Confirm legacy `CREATOR` migrates to `KREATOR` rather than being duplicated.
20. Confirm `🏅・kreator-leaderboard` and `🏁・campaign-leaderboard` are read-only to verified members by default.
21. Create a creator campaign and approve a KREATOR post tagged to it.
22. Confirm awarded creator XP appears once in:
   - overall XP
   - lifetime KREATOR leaderboard
   - campaign leaderboard
23. Confirm each verified reactor counts only once even if they add multiple emoji.
24. Confirm bots, self-reactions and unverified members do not count.
25. Confirm the default 100-unique-reactor threshold awards one reaction milestone and cannot be double-awarded by remove/re-add.
26. Close the campaign. Confirm new submissions cannot tag it and new reaction milestone XP stops.
27. Confirm the closed campaign board remains for 7 days, then disappears while lifetime KREATOR and overall XP remain unchanged.
28. Confirm expired campaign reaction-detail rows are pruned.

## Managed channels

29. Use `/channel-manager batch-create` to create 3 text channels and confirm all inherit the selected category/access/link/XP/slowmode policy.
30. Test a 10-channel batch successfully.
31. Confirm an 11-channel request is rejected before creation.
32. Confirm duplicate names in one batch are rejected.
33. Confirm a partial Discord API failure is reported while already-created channels remain registered in `managed_channels`.
34. Confirm XP-enabled managed channels can create impact candidates and XP-disabled managed channels cannot.

## Railway cutover

35. Confirm Railway volume remains mounted at `/app/data`.
36. Preserve the existing `/app/data/linko.sqlite` as the early-data archive.
37. Confirm the new KlineO database is created at `/app/data/guilds/1552805183082471474.sqlite`.
38. Confirm startup logs register commands for every allowlisted guild and print each guild's XP label.
39. Confirm only one production LINKO instance is connected to Discord with the production token.
40. Run `/setup-linko confirm:true` in KlineO once after deployment, then verify `/points`, all leaderboards, referrals, creator campaign flow and managed channels.
