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

## Server profile and module checks

6. Set `PRIMARY_GUILD_ID=serverA`. Confirm server A initializes as:
   - name `KlineO`
   - template `klineo`
   - XP `KXP`
   - all modules enabled.
7. Confirm server B initializes as the generic community preset:
   - community name = Discord guild name
   - XP = `XP`
   - staff roles = `LINKO CORE` / `LINKO TEAM`
   - referrals + events on
   - KREATOR, Signals, Founders, Studio, Wallets, Languages and Product off.
8. Confirm `/server-settings view` reports name, template, XP, database and module states independently per guild.
9. Change the generic server name and confirm its community category/brand presentation updates without creating a duplicate core community category.
10. Test `/server-settings preset` in both directions and confirm CORE/TEAM plus dynamic category names migrate rather than duplicate.
11. Enable KREATOR and run `/setup-linko confirm:true`; confirm only the KREATOR/Social spaces are added and existing core spaces remain intact.
12. Disable KREATOR and confirm its commands disappear, stale review buttons refuse to act, but existing creator history/channels are not deleted.
13. Enable Studio and confirm Founders becomes enabled automatically. Disable Founders and confirm Studio also disables.
14. Confirm generic command aliases register: `/user-xp`, `/xp-settings`, `/set-xp`, `/grant-linko-role`.
15. Confirm the KlineO primary guild retains existing KlineO command names and the `/setup-klineo` alias.

## Per-server storage isolation

16. Start with two test Discord servers and confirm LINKO creates two separate files under `data/guilds/`.
17. Use the same Discord account in both servers and award different XP amounts. Confirm balances and ranks remain different.
18. Confirm referrals, wallets, campaigns, KREATOR activity, settings, events and managed-channel records created in server A are absent from server B.
19. Confirm a leaderboard refresh in one server does not overwrite or cancel the other server's refresh.
20. Confirm invite tracking is independent per guild.

## XP naming

21. Leave KlineO on `KXP`.
22. In the second server run `/server-settings xp-name name:DOTXP`.
23. Confirm `/server-settings view` reports each server's independent label and database path.
24. Confirm the same stored numeric balance renders as KXP in KlineO and DOTXP in the second server.
25. Confirm leaderboards, `/points`, XP settings, reward messages, social cards and CSV headers use the configured server label.
26. Reject invalid names containing spaces, punctuation, digits, or more than 6 letters.
27. Confirm changing DOTXP to another valid label changes presentation without changing balances.

## KREATOR economy

28. Run `/setup-linko confirm:true` and confirm the KREATOR role exists with the distinct violet color and no admin/mod permissions.
29. Confirm legacy `CREATOR` migrates to `KREATOR` rather than being duplicated.
30. Confirm `🏅・kreator-leaderboard` and `🏁・campaign-leaderboard` are read-only to verified members by default.
31. Create a creator campaign and approve a KREATOR post tagged to it.
32. Confirm awarded creator XP appears once in:
   - overall XP
   - lifetime KREATOR leaderboard
   - campaign leaderboard
33. Confirm each verified reactor counts only once even if they add multiple emoji.
34. Confirm bots, self-reactions and unverified members do not count.
35. Confirm the default 100-unique-reactor threshold awards one reaction milestone and cannot be double-awarded by remove/re-add.
36. Close the campaign. Confirm new submissions cannot tag it and new reaction milestone XP stops.
37. Confirm the closed campaign board remains for 7 days, then disappears while lifetime KREATOR and overall XP remain unchanged.
38. Confirm expired campaign reaction-detail rows are pruned.

## Managed channels

39. Use `/channel-manager batch-create` to create 3 text channels and confirm all inherit the selected category/access/link/XP/slowmode policy.
40. Test a 10-channel batch successfully.
41. Confirm an 11-channel request is rejected before creation.
42. Confirm duplicate names in one batch are rejected.
43. Confirm a partial Discord API failure is reported while already-created channels remain registered in `managed_channels`.
44. Confirm XP-enabled managed channels can create impact candidates and XP-disabled managed channels cannot.

## Railway cutover

45. Confirm Railway volume remains mounted at `/app/data`.
46. Preserve the existing `/app/data/linko.sqlite` as the early-data archive.
47. Confirm the new KlineO database is created at `/app/data/guilds/1552805183082471474.sqlite`.
48. Confirm startup logs register commands for every allowlisted guild and print each guild's XP label.
49. Confirm only one production LINKO instance is connected to Discord with the production token.
50. Run `/setup-linko confirm:true` in KlineO once after deployment, then verify `/points`, all leaderboards, referrals, creator campaign flow and managed channels.
