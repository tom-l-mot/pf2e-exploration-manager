# PF2e Exploration Manager

Automatic mode clears every native exploration selection after the character's initiative is recorded, including installed and custom activities. It also removes the exact PF2e Automations exploration marker effects and consumed Scout and Follow the Expert initiative effects. Unrelated conditions, spells, runes, and raised shields remain. Avoid Notice rolls Stealth on tracker entry. Scout is prepared before automatic rolls, and saved selections preserve encounter callbacks and opening Defend. Use the native character-sheet activity picker. No module confirmation or handoff dialog is required in Automatic mode.

Version 0.2.4 is a local test candidate using the inspected Foundry VTT 14.369 and PF2e 8.6.1 lifecycle and requires Pathfinder Second Edition and libWrapper. The manifest records Foundry VTT 14.369 as verified. The manifest and runtime set no minimum or maximum Foundry or PF2e version limits. Verification applies to the inspected build. Other versions are untested and may have incompatible APIs. Node fixture checks are separate from live Foundry verification.

## Install from GitHub

In Foundry's Install Module dialog, paste this manifest URL:

https://github.com/tom-l-mot/pf2e-exploration-manager/releases/latest/download/module.json

Release assets are available on the [GitHub releases page](https://github.com/tom-l-mot/pf2e-exploration-manager/releases). Enable Pathfinder Second Edition and libWrapper, then configure the ownership settings below.

## Install locally

Packaging requires Node.js and Windows `tar.exe`.

1. Run `npm test`, `npm run check`, and `npm run package` in this directory.
2. Close Foundry and extract `build/pf2e-exploration-manager-0.2.4.zip` into the Foundry user data `Data/modules` folder.
3. Enable libWrapper and PF2e Exploration Manager in the PF2e world.
4. Set **Encounter cleanup** to **Automatic** if upgrading a world that saved Review or Off.
5. When those modules are active, disable `pf2e-automations.deleteExploration` and `pf2e-avoid-notice.raiseShields`. Automatic start checks these ownership conflicts before changing documents.

## Run an encounter

Select activities on the native sheets, add tokens to the combat tracker, and click **Begin Encounter** as the active GM.

Automatic Scout uses the strongest participating allied character with Scout selected or saved in this encounter's matching cleanup receipt. It prepares canonical +1 Scout or +2 Incredible Scout for Incredible Scout or Scout Dedication, for participating characters whose PF2e alliance is party. It skips preserved totals and equal or stronger existing Scout effects. A corrected or explicitly rerolled combatant can receive Scout before its replacement roll. Clearing the Scout's selection does not remove unrolled allies' bonuses. Tracker initiative rolls also prepare Scout. Direct sheet rolls retain native roll preparation; cleanup follows their recorded initiative.

Adding an Avoid Notice character to an unstarted tracker automatically rolls native Stealth initiative with `skipDialog` on the active GM client. Begin Encounter also replaces missing or non-Stealth Avoid Notice initiative, including an existing Perception total. A finite initiative recorded by PF2e as Stealth, including zero, is preserved. Tracker roll and reroll controls use Stealth for requested Avoid Notice characters and preserve native roll options. These rolls use a separate native initiative statistic without changing the actor's saved default preference. Other characters keep their existing finite totals and roll missing initiative normally.

Scout must already be participating and selected when a roll occurs. Adding or selecting a Scout later does not retroactively change recorded Stealth or ordinary initiative. Explicitly reroll from the tracker to include the newly available Scout. This avoids silently changing a completed Stealth roll when Begin Encounter is clicked.

Each character's snapshot refreshes until its first eligible cleanup and then remains fixed with a matching receipt. Every linked combatant must have finite initiative before that actor clears. Other actors and unrolled NPCs do not delay it. Direct initiative writes, sheet rolls, tracker rolls, and late joins use the same cleanup path.

Begin Encounter repairs non-Stealth Avoid Notice initiative and rolls missing initiative using saved activities. Immediately before native `combatStart` callbacks, the module temporarily replays receipt-owned native selections. These updates use Foundry's `noHook` option to avoid PF2e Automations pre-update marker and party-bonus side effects while retaining native prepared actor data. Native dispatch runs once with normal callback order, once-listener behavior, and mutable update data. The module waits for every returned promise and clears its replay in `finally`, including callback failures. A callback error stops round advancement and leaves recovery receipts. A saved replay phase allows recovery after reload or active-GM change. Changed selections and mismatching receipts are preserved. Detached work that a callback does not return cannot be awaited. Other modules own their own dialogs.

After eligible cleanup, selected Defend uses native Raise a Shield only when a usable held shield exists and no canonical raised-shield effect exists. The canonical effect is normalized immediately before the first round to expire at the actor's first turn. Duplicate linked combatants use the earliest participating turn. Existing shields are never blindly toggled. Invalid shields produce a warning without stopping the encounter. Unrelated effects are preserved.

## Recovery and settings

**Encounter cleanup** defaults to **Automatic**. **Review** retains the optional handoff prompt and manual controls. **Off** keeps the native start behavior. **Enable pre-roll scouting preparation** defaults to enabled.

The combat tracker's **Exploration** button and Configure Settings' **Exploration handoff** menu provide optional manual Scout, clear, and restore controls. Manual clear requires confirmation that other automation has finished. Manual Scout retains explicit source and recipient selection.

- Only the active GM writes saved PF2e documents. Snapshot, Scout, and recovery operations are serialized on that client. Concurrent Begin clicks for the same encounter share one pending start. Overlapping tracker entry and Begin preparation share one pending Stealth roll per combatant. Removed combatants, changed activities, started encounters, and lost GM authority are rechecked before recording an awaited roll.
- The Combat snapshot preserves activity IDs and labels. Linked combatants share one Actor entry; synthetic token actors keep their own UUID. NPC exploration selections are excluded.
- Cleanup requires unchanged selections and finite initiative for every linked combatant. An Actor receipt and empty selection are written in the same update. An empty selection alone never proves ownership. Exact marker effects created late by PF2e Automations are reconciled only against a matching receipt and an empty selection.
- Restore requires a matching receipt and empty current selection. It restores surviving exploration action or feat IDs and deletes the receipt with Foundry 14 ForcedDeletion. A Combat suppression flag prevents another cleanup after restore.
- Restore before ending or deleting the encounter. A well-formed receipt whose encounter was deleted expires and can be replaced by a later eligible clear. A receipt for another live encounter or malformed recovery data remains untouched.
- A failed operation may already have committed writes. Receipts preserve recovery for completed clears. Retry after resolving the error.
- Foundry has no compare-and-swap guard for these updates. A player edit or GM handover can race a write already sent to the server. Fresh checks reduce that window but cannot eliminate it.
- Nonactive-GM callers, started encounters, Review, and Off use the wrapped native start. Automatic execution checks the required combat, Hooks, ActiveEffect, and needed Raise a Shield APIs before capture or mutation. Missing APIs stop the operation and preserve exploration selections. API presence does not certify behavior on untested versions.

## Verify in a disposable world

Node tests use source-shaped document and Hooks fixtures. Live verification must also check immediate native selection and marker cleanup before Begin, arbitrary installed activities, direct sheet and tracker rolls, tracker-entry Stealth, existing Perception correction, preserved Stealth zero, tracker rerolls, the actual Begin button, native Scout +1 and +2 roll modifiers, and the absence of a module handoff dialog. Use equipped shields to check AC before and after the defender's first turn, including first, later, and tied initiative. Check an existing raised shield, delayed encounter readers, replay recovery, and changed selections. Preserve campaign actors and world time, and remove only test fixtures.

## Source grounding

The implementation was checked against installed Foundry `client/documents/combat.mjs`, `client/helpers/hooks.mjs`, and document exports; PF2e `ActorInitiative`, `Encounter.rollInitiative`, Raise a Shield, and effect creation code; and Avoid Notice's encounter and Defend callbacks. Those sources are not bundled. The owned start method preserves the inspected six-line native lifecycle and adds the awaited callback boundary.

Canonical effects are Scout `Compendium.pf2e.other-effects.Item.EMqGwUi3VMhCjTlF`, Incredible Scout `Compendium.pf2e.feat-effects.Item.la8rWwUtReElgTS6`, and Raise a Shield `Compendium.pf2e.equipment-effects.Item.2YgXoHvJfrDHucMr`. Source inspection and fixtures do not certify live integration behavior.
