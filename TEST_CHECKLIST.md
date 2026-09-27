# LINKO v10.6 Test Checklist

Use this checklist before merging the KREATOR release into production.

1. Run `npm install` and `npm run check`.
2. Deploy to a non-production environment first when available.
3. Run `/setup-klineo confirm:true` and confirm an existing `CREATOR` role is migrated to `KREATOR`, not duplicated.
4. Confirm KREATOR has the distinct violet role color, is above normal KXP rank roles, and has no administrator/moderator permissions.
5. Confirm `🏅・kreator-leaderboard` and `🏁・campaign-leaderboard` are visible read-only to verified members.
6. Grant one test member KREATOR.
7. Create an active campaign with `/creator-campaign create`.
8. Submit a KlineO social post with `/submit-post campaign:<ID>`.
9. Approve the submission and confirm the base social KXP appears once in:
   - overall KXP,
   - lifetime KREATOR leaderboard,
   - campaign leaderboard.
10. Add reactions from verified members and confirm each member counts only once even when they use multiple emoji.
11. Confirm the default 100-unique-member threshold awards +1 KXP only once.
12. Remove and re-add reactions around an already-earned threshold and confirm the milestone is not awarded twice.
13. Confirm bot reactions, self-reactions, and reactions from unverified members do not count.
14. Close the campaign and confirm:
   - new submissions cannot tag it,
   - no new reaction milestone KXP is awarded to posts in that closed campaign,
   - the existing leaderboard remains viewable.
15. Verify `/leaderboard` for KXP, Referrals, Kreators, and Creator Campaign.
16. Verify `/leaderboard-settings` can control all four leaderboard surfaces.
17. Verify `/refresh-leaderboard` refreshes all leaderboard surfaces.
18. Check Railway runtime logs for startup errors and confirm `/app/data` remains mounted.
19. Confirm existing KXP, referrals, wallets, settings, and community data remain intact after the additive SQLite migration.
