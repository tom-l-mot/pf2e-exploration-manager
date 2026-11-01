import { ID, authority, capture, snapshot, participants, selection, prepareAutomaticScouting, clearBeforeStart } from "./handoff.js";

const starts = new WeakMap();
const stealthRolls = new WeakMap();
export const SHIELD = "Compendium.pf2e.equipment-effects.Item.2YgXoHvJfrDHucMr";
const automatic = combat => !!combat && game.user.isActiveGM && game.system.id === "pf2e" && game.combats.get(combat.id) === combat && !combat.started && game.settings.get(ID, "cleanup") === "automatic";
const sneaking = c => c.actor?.type === "character" && selection(c.actor).some(id => c.actor.items.get(id)?.system.slug === "avoid-notice");
const recordedStealth = c => Number.isFinite(c.initiative) && c.flags?.pf2e?.initiativeStatistic === "stealth";

function ensureStealth(combat, c, options = {}, reroll = false) {
  const actor = c.actor;
  const eligible = () => automatic(combat) && combat.combatants.some(current => current === c) && c.actor === actor && sneaking(c);
  if (!eligible()) return Promise.resolve();
  if (stealthRolls.has(c)) return reroll ? stealthRolls.get(c).then(() => ensureStealth(combat, c, options, true)) : stealthRolls.get(c);
  if (!reroll && recordedStealth(c)) return Promise.resolve();
  const previous = c.initiative;
  const pending = (async () => {
    await prepareAutomaticScouting(combat, [c.id]);
    if (!eligible() || (!reroll && recordedStealth(c))) return;
    // PF2e accepts a transient initiative statistic without changing the saved preference.
    const initiative = new actor.initiative.constructor(actor, { statistic: "stealth", tiebreakPriority: actor.initiative.tiebreakPriority });
    const result = await initiative.roll({ ...options, combatant: c, updateTracker: false,
      extraRollOptions: [...(options.extraRollOptions ?? []), ...(options.secret ? ["secret"] : [])],
      messageMode: options.messageOptions?.messageMode ?? options.messageMode });
    if (!eligible() || (recordedStealth(c) && (!reroll || c.initiative !== previous))) return;
    if (!result && reroll) return;
    if (!result || !Number.isFinite(result.roll.total)) throw new Error(`Initiative did not complete for ${actor.name}.`);
    await combat.setInitiative(c.id, result.roll.total, "stealth");
  })().finally(() => stealthRolls.delete(c));
  stealthRolls.set(c, pending);
  return pending;
}

export function addedCombatant(combatant) {
  return ensureStealth(combatant.parent, combatant, { skipDialog: true });
}

export async function dispatchCombatStart(combat, updateData) {
  const pending = [];
  const errors = [];
  const entries = [...(Hooks.events.combatStart ?? [])].map(entry => {
    const original = entry.fn;
    const collector = function (...args) {
      if (args[0] !== combat) return original.apply(this, args);
      try {
        const result = original.apply(this, args);
        pending.push(Promise.resolve(result).catch(error => { errors.push(error); }));
        return result;
      } catch (error) {
        errors.push(error);
        throw error;
      }
    };
    entry.fn = collector;
    return { entry, original, collector };
  });
  try { Hooks.callAll("combatStart", combat, updateData); }
  finally {
    for (const { entry, original, collector } of entries) if (entry.fn === collector) entry.fn = original;
  }
  await Promise.allSettled(pending);
  if (errors.length) throw new AggregateError(errors, "Encounter automation failed. Exploration cleanup and round advancement stopped. Resolve the error before retrying Begin Encounter.");
}

export async function rollMissing(combat) {
  for (const c of [...combat.combatants]) {
    authority(combat);
    if (sneaking(c)) await ensureStealth(combat, c, { skipDialog: true });
  }
  authority(combat);
  const missing = combat.combatants.filter(c => !Number.isFinite(c.initiative)).map(c => c.id);
  if (missing.length) await combat.rollInitiative(missing, { skipDialog: true });
  if (combat.combatants.some(c => !Number.isFinite(c.initiative))) throw new Error("Some initiative rolls did not complete. Exploration selections were retained.");
}

export async function openingDefend(combat) {
  for (const entry of snapshot(combat)?.entries ?? []) {
    authority(combat);
    const current = participants(combat).get(entry.actorUuid);
    if (!current) continue;
    const { actor, combatants } = current;
    if (!entry.activityIds.some(id => actor.items.get(id)?.system.slug === "defend")) continue;
    if (combat.getFlag(ID, "restoredActorUuids")?.includes(actor.uuid)) continue;
    const shield = actor.heldShield;
    if (!shield || shield.isBroken || shield.isDestroyed) {
      ui.notifications.warn(`${actor.name} cannot Defend without a usable held shield.`);
      continue;
    }
    const raised = () => actor.items.find(item => item.type === "effect" && item.sourceId === SHIELD);
    if (!raised()) await game.pf2e.actions.raiseAShield({ actors: [actor] });
    authority(combat);
    const effect = raised();
    if (!effect) { ui.notifications.warn(`${actor.name} could not raise a shield for Defend.`); continue; }
    const first = combat.turns.find(c => combatants.some(own => own.id === c.id));
    await effect.update({ "system.duration.value": 0, "system.duration.unit": "rounds", "system.duration.expiry": "turn-start", "system.start.value": game.time.worldTime, "system.start.initiative": first.initiative });
  }
}

async function automaticStart(combat) {
  authority(combat);
  if (typeof combat._playCombatSound !== "function" || typeof combat.update !== "function" ||
      typeof combat.rollInitiative !== "function" || typeof combat.setInitiative !== "function" ||
      typeof globalThis.foundry?.documents?.ActiveEffect?.registry?.refresh !== "function" ||
      typeof Hooks.callAll !== "function" || !Hooks.events ||
      !Array.isArray(Hooks.events.combatStart ?? []) || (Hooks.events.combatStart ?? []).some(entry => typeof entry.fn !== "function")) {
    throw new Error("Automatic handoff requires the combat, Hooks, and ActiveEffect APIs. Exploration selections were retained.");
  }
  for (const { actor } of participants(combat).values()) {
    if (selection(actor).some(id => actor.items.get(id)?.system.slug === "defend") &&
        actor.heldShield && !actor.heldShield.isBroken && !actor.heldShield.isDestroyed &&
        !actor.items.find(item => item.type === "effect" && item.sourceId === SHIELD) &&
        typeof game.pf2e?.actions?.raiseAShield !== "function") {
      throw new Error("Automatic handoff requires the PF2e Raise a Shield API for Defend. Exploration selections were retained.");
    }
  }
  for (const [module, setting] of [["pf2e-automations", "deleteExploration"], ["pf2e-avoid-notice", "raiseShields"]]) {
    if (game.modules.get(module)?.active && game.settings.get(module, setting)) throw new Error(`Disable ${module}.${setting} before automatic exploration handoff.`);
  }
  await capture(combat);
  await prepareAutomaticScouting(combat, combat.combatants.filter(c => sneaking(c) && !recordedStealth(c)).map(c => c.id));
  await rollMissing(combat);
  if (!game.user.isActiveGM) throw new Error("The active GM changed during encounter preparation.");
  // Await returned hook work before clearing the exploration selections it reads.
  combat._playCombatSound("startEncounter");
  const updateData = { round: 1, turn: 0 };
  await dispatchCombatStart(combat, updateData);
  await clearBeforeStart(combat);
  await openingDefend(combat);
  if (!game.user.isActiveGM) throw new Error("The active GM changed during encounter preparation.");
  await combat.update(updateData);
  await foundry.documents.ActiveEffect.registry.refresh("combatStart", { combat });
  return combat;
}

export function startCombat(wrapped, ...args) {
  if (!game.user.isActiveGM || game.settings.get(ID, "cleanup") !== "automatic") return wrapped(...args);
  if (starts.has(this)) return starts.get(this);
  if (this.started) return wrapped(...args);
  const pending = automaticStart(this).finally(() => starts.delete(this));
  starts.set(this, pending);
  return pending;
}

export async function trackerInitiative(wrapped, ...args) {
  if (!automatic(this)) return wrapped(...args);
  const [ids = [], options = {}] = args;
  await prepareAutomaticScouting(this, ids);
  if (!automatic(this)) return this;
  const avoiders = this.combatants.filter(c => ids.includes(c.id) && sneaking(c));
  await Promise.all(avoiders.map(c => ensureStealth(this, c, options, true)));
  if (!automatic(this)) return this;
  const ordinary = ids.filter(id => !avoiders.some(c => c.id === id && sneaking(c)) && this.combatants.some(c => c.id === id));
  return ordinary.length || !ids.length ? wrapped(ordinary, ...args.slice(1)) : this;
}

export function registerAutomatic() {
  libWrapper.register(ID, "CONFIG.Combat.documentClass.prototype.startCombat", startCombat, "MIXED");
  libWrapper.register(ID, "CONFIG.Combat.documentClass.prototype.rollInitiative", trackerInitiative, "WRAPPER");
}
