# PF2e Exploration Manager

Review native exploration selections when an encounter begins. Clear unchanged selections after initiative and restore selections cleared by this module. Prepare PF2e Scouting effects before initiative with explicit recipients.

Version 0.1.0 targets Foundry VTT 14.361 or later in generation 14 and PF2e 8.6.1. The manifest limits PF2e compatibility to 8.6.1. The code was checked against locally installed sources. No live Foundry encounter has been tested. This is a local, manually installed package with no update manifest URL.

## Install locally

1. Run `npm test`, `npm run check`, and `npm run package` from this directory.
2. Close Foundry and extract `build/pf2e-exploration-manager-0.1.0.zip` into your Foundry user data `Data/modules` folder. The resulting folder must be `Data/modules/pf2e-exploration-manager/module.json`.
3. Open a PF2e world and enable **PF2e Exploration Manager** in Manage Modules.
4. Open Configure Settings, then the module's **Exploration handoff** menu. The combat tracker also has an **Exploration** button for the active GM.

Keep the native character-sheet exploration activity picker. This module does not replace it.

## Run an encounter

1. Add participating character tokens to the combat tracker and select their activities on their native sheets.
2. Before anyone rolls initiative, open **Exploration** and click **Prepare scouting** if wanted. Choose a character with Scout selected. Check each intended recipient, including the scout if appropriate. No recipient is selected by default. Characters outside this encounter cannot receive the effect through this menu.
3. Roll initiative and begin the encounter. Review the current and saved activities in the handoff.
4. Resolve exploration benefits and wait for other encounter automation to finish. Click **Clear eligible selections** and confirm. Characters without initiative or with edited selections remain untouched.
5. To undo this module's cleanup, click **Restore cleared selections** and confirm. Restore before deleting the encounter. Removed combatants can still restore when their actor UUID resolves.

Scouting uses canonical PF2e effects. A participating source with Incredible Scout uses its canonical +2 effect. Otherwise it uses Scouting's +1 effect. PF2e owns stacking, initiative calculation, and effect removal after the roll. Already rolled initiative is never changed. Existing canonical scouting effects, recognized scouting slugs, or any effect with a circumstance FlatModifier on initiative or all statistics cause that recipient to be skipped conservatively. Unknown custom modifier rules may require manual review.

Defend remains a manual handoff. Use native PF2e Raise a Shield when appropriate, or let your existing integration handle it. This module never toggles a shield, adds AC, or deletes effects. Automated opening-round Defend is deferred until its full live encounter behavior can be verified.

## Settings

**Encounter cleanup** defaults to **Review**. Review opens the handoff at encounter start. **Off** disables start prompts and automatic cleanup, while manual controls remain available. **Guarded automatic** clears unchanged character selections only once every combatant has finite initiative and Avoid Notice is inactive. It retries when initiative changes. An initiative result of zero counts as rolled.

**Enable pre-roll scouting preparation** defaults to enabled. Disable it to keep scouting entirely manual.

When `pf2e-avoid-notice` is active, guarded automatic cleanup is suppressed and the handoff requests review. Its async encounter processing can read Defend after the combat-start hook has returned. No timer or round change proves that processing finished. Default Review also protects unknown integrations by requiring your confirmation.

## Recovery and limits

- Only the active GM writes documents. Actions are serialized per encounter on that client. Linked combatants share one actor entry; synthetic token actors keep their own UUID. Every linked combatant must roll before that actor can be cleared.
- The encounter keeps an immutable snapshot of selections and labels. Late entrants add entries without replacing earlier entries. A clear writes an Actor receipt and the empty activity selection in the same update. An empty selection alone is never proof that the module cleared it.
- Restore requires the matching receipt and an empty current selection. It restores only surviving action or feat IDs with the exploration trait, then removes the receipt in the same actor update. A separate encounter suppression flag prevents another cleanup after restore. Failed writes can be retried.
- A receipt from another encounter blocks cleanup. Restore that earlier encounter before clearing this actor again. Deleting an encounter before recovery can strand its receipt. An administrator must inspect any stranded flag before changing it manually.
- Foundry has no compare-and-swap guard on these document updates. A simultaneous player edit or active-GM handover can race a write already sent to the server. Fresh checks reduce this window but do not eliminate it. Avoid changing exploration selections while the GM clears or restores them.
- The module does not change initiative statistics, rolled totals, conditions, spell effects, or visibility. It does not automate Search, Avoid Notice, or other activity benefits. Review those effects before clearing.
- Opening a handoff before encounter start does not snapshot activities. Changes made before Begin Encounter remain eligible for the start snapshot. If another GM starts combat, the active GM captures through the broadcast update hook. Unknown integrations that clear selections before that fallback can affect what is captured.

## Verify in a disposable world

The Node tests use document fixtures. These live checks remain required before campaign use.

1. Load Foundry 14 with PF2e 8.6.1. Confirm the settings menu and tracker button open, and actor names with punctuation display as text.
2. Assign Scout, Defend, and multiple exploration activities. Roll zero initiative for one character and leave another unrolled. Begin Encounter and verify the saved labels. Clear and restore. Verify the unrolled character and any manually edited selections remain unchanged.
3. Add duplicate linked tokens and an unlinked synthetic token. Verify duplicates wait for every roll, while the synthetic token restores separately. Add a late entrant and verify the original snapshots persist.
4. Prepare scouting before initiative for explicit allies only. Verify +1, then Incredible Scout +2, on the native initiative breakdown. Confirm the canonical effect removes after the roll, duplicates are skipped, and already rolled encounters refuse preparation. Verify opponents receive nothing unless explicitly checked.
5. Enable Avoid Notice. Confirm automatic mode retains exploration selections, allows its normal Defend processing, and requires GM review. Resolve native shields manually when the integration is absent. Existing effects must remain intact.
6. Start combat from a second, nonactive GM. Switch active GM, refresh, and verify recovery receipts remain usable. Restore after removing a combatant if its actor still exists. Test deleting an activity item before restore.

## Source grounding

Reviewed installed Foundry client sources `client/documents/combat.mjs`, `client/applications/api/dialog.mjs`, and `client/helpers/client-settings.mjs`; installed PF2e `pf2e.mjs`; and Avoid Notice `esmodules/combat.js` and `esmodules/defender.js`. These files are not bundled.

Canonical effect identities are `Compendium.pf2e.other-effects.Item.EMqGwUi3VMhCjTlF` and `Compendium.pf2e.feat-effects.Item.la8rWwUtReElgTS6`. Local source inspection established the intended integration contract, not a live compatibility certification.

Project references are [Foundry API documentation](https://foundryvtt.com/api/) and [PF2e system source](https://github.com/foundryvtt/pf2e). Check the installed versions when comparing upstream sources.
