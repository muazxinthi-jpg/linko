# LINKO v10.7 Test Checklist

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
