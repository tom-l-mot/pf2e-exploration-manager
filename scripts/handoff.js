export const ID = "pf2e-exploration-manager";
export const SCOUT = "Compendium.pf2e.other-effects.Item.EMqGwUi3VMhCjTlF";
export const INCREDIBLE_SCOUT = "Compendium.pf2e.feat-effects.Item.la8rWwUtReElgTS6";
export const SCOUT_DEDICATION = "Compendium.pf2e-automations.effects.Item.U7tuKcRePhSu2C2P";
const MARKERS = new Set(["N8vpuGy4TzU10y8E", "F6vJYLZTWDpnrnCZ", "GYOyFj4ziZX060rZ", "OjRHL0B4WAUUQc13", "V347nnVBGDrVWh7k", "vNUrKvoOSvEnqzhM", "tDsgl8YmhZbx2May", "kh1QdKkvbNZ0qBsQ", "mGFBHM1lvHNZ9BsH", "XiVLHjg5lQVMX8Fj", "OcCXjJab7rSR3mDf", "SggYzuL9NtYoktUR", "ThF8UIN5093xtCaq"].map(id => `Compendium.pf2e-automations.effects.Item.${id}`));
const CONSUMED = new Set([SCOUT, INCREDIBLE_SCOUT, SCOUT_DEDICATION, "Compendium.pf2e.other-effects.Item.VCSpuc3Tf3XWMkd3"]);
let queue = Promise.resolve();
const rollingBoundaries = new WeakMap();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const selection = actor => [...actor.system.exploration];
export const avoidNotice = () => !!game.modules.get("pf2e-avoid-notice")?.active;
export const snapshot = combat => combat.getFlag(ID, "handoff");
const receipt = actor => actor.getFlag(ID, "clearReceipt");
const matchingEntry = (combat, actor) => {
  const owned = receipt(actor);
  return !combat.getFlag(ID, "restoredActorUuids")?.includes(actor.uuid) && owned?.combatUuid === combat.uuid && snapshot(combat)?.entries.find(entry => entry.actorUuid === actor.uuid && equal(entry.activityIds, owned.clearedIds));
};
export const effectiveSelection = (combat, actor) => selection(actor).length ? selection(actor) : matchingEntry(combat, actor)?.activityIds ?? [];

export function expiredReceipt(owned) {
  const id = /^Combat\.([^.]+)$/.exec(owned?.combatUuid)?.[1];
  return !!id && Array.isArray(owned.clearedIds) && owned.clearedIds.length > 0 && owned.clearedIds.every(id => typeof id === "string") && !game.combats.get(id);
}

export function participants(combat) {
  const actors = new Map();
  for (const c of combat.combatants) {
    if (c.actor?.type !== "character") continue;
    const entry = actors.get(c.actor.uuid) ?? { actor: c.actor, combatants: [] };
    entry.combatants.push(c);
    actors.set(c.actor.uuid, entry);
  }
  return actors;
}

export function authority(combat) {
  if (!game.user.isActiveGM || game.system.id !== "pf2e" || game.combats.get(combat.id) !== combat) {
    throw new Error("Only the active GM can change a saved PF2e encounter.");
  }
}

function queued(combat, operation) {
  const next = queue.then(() => { authority(combat); return operation(); });
  queue = next.catch(() => {});
  return next;
}

function captureEntries(combat) {
  return [...participants(combat).values()].map(({ actor, combatants }) => ({
    actorUuid: actor.uuid,
    name: actor.name,
    activityIds: selection(actor),
    labels: selection(actor).map(id => actor.items.get(id)?.name ?? `Missing activity (${id})`),
    combatantIds: combatants.map(c => c.id)
  }));
}

export function initiativeBoundary(combat, combatantIds) {
  return captureEntries(combat).filter(entry => entry.combatantIds.some(id => combatantIds.includes(id)))
    .map(entry => rollingBoundaries.get(combat)?.get(entry.actorUuid)?.entry ?? entry);
}

export async function duringInitiative(combat, combatantIds, operation) {
  // Nested native writes and hooks must keep the selection captured before the roll.
  const boundary = initiativeBoundary(combat, combatantIds);
  const pending = rollingBoundaries.get(combat) ?? new Map();
  rollingBoundaries.set(combat, pending);
  for (const entry of boundary) {
    const held = pending.get(entry.actorUuid) ?? { entry, count: 0 };
    held.count++;
    pending.set(entry.actorUuid, held);
  }
  try { return await operation(boundary); }
  finally {
    for (const entry of boundary) {
      const held = pending.get(entry.actorUuid);
      if (--held.count === 0) pending.delete(entry.actorUuid);
    }
    if (!pending.size) rollingBoundaries.delete(combat);
  }
}

async function saveCapture(combat, entries, refresh = false, replaceOwned = false) {
  const existing = snapshot(combat);
  if (existing && (existing.version !== 1 || !Array.isArray(existing.entries))) throw new Error("Unsupported exploration snapshot.");
  const merged = [...(existing?.entries ?? [])];
  for (const entry of entries) {
    const index = merged.findIndex(e => e.actorUuid === entry.actorUuid);
    if (index < 0) merged.push(entry);
    else if (refresh) {
      const owned = receipt(participants(combat).get(entry.actorUuid).actor);
      if (!owned || expiredReceipt(owned) || (replaceOwned && entry.activityIds.length)) merged[index] = entry;
    }
  }
  if (!existing || !equal(merged, existing.entries)) {
    authority(combat);
    await combat.setFlag(ID, "handoff", { version: 1, entries: merged });
  }
}

async function removeExplorationEffects(combat, actor) {
  const ids = actor.items.filter(item => item.type === "effect" && (MARKERS.has(item.sourceId ?? item.flags?.core?.sourceId) || CONSUMED.has(item.sourceId ?? item.flags?.core?.sourceId))).map(item => item.id);
  if (ids.length) {
    authority(combat);
    await actor.deleteEmbeddedDocuments("Item", ids);
  }
}

export function initiativeRecorded(combat, boundary) {
  if (!combat || !game.user.isActiveGM || game.system.id !== "pf2e" || game.combats.get(combat.id) !== combat || game.settings.get(ID, "cleanup") !== "automatic") return Promise.resolve();
  const entries = boundary ?? captureEntries(combat);
  return queued(combat, async () => {
    if (game.settings.get(ID, "cleanup") !== "automatic") return;
    const eligible = [...participants(combat).values()].filter(({ actor, combatants }) => receipt(actor)?.phase !== "replaying" && entries.some(entry => entry.actorUuid === actor.uuid && equal(selection(actor), entry.activityIds)) && combatants.every(c => Number.isFinite(c.initiative)));
    const fresh = boundary ? entries.filter(entry => entry.activityIds.length && eligible.some(({ actor }) => actor.uuid === entry.actorUuid)) : [];
    await saveCapture(combat, entries.filter(entry => eligible.some(({ actor }) => actor.uuid === entry.actorUuid)), true, !!boundary);
    for (const { actor, combatants } of eligible) {
      authority(combat);
      const current = participants(combat).get(actor.uuid);
      if (!current || current.actor !== actor || current.combatants.some(c => !Number.isFinite(c.initiative)) || combatants.some(c => !Number.isFinite(c.initiative))) continue;
      const owned = receipt(actor);
      if (owned?.phase === "replaying") continue;
      const renewed = fresh.some(entry => entry.actorUuid === actor.uuid && equal(selection(actor), entry.activityIds));
      if (!renewed && combat.getFlag(ID, "restoredActorUuids")?.includes(actor.uuid)) continue;
      if (!renewed && owned && !expiredReceipt(owned)) {
        if (matchingEntry(combat, actor) && !selection(actor).length) await removeExplorationEffects(combat, actor);
        continue;
      }
      const entry = snapshot(combat).entries.find(entry => entry.actorUuid === actor.uuid);
      if (!entry.activityIds.length) {
        if (!selection(actor).length) await removeExplorationEffects(combat, actor);
        continue;
      }
      if (!equal(selection(actor), entry.activityIds)) continue;
      if (renewed && combat.getFlag(ID, "restoredActorUuids")?.includes(actor.uuid)) {
        await combat.setFlag(ID, "restoredActorUuids", combat.getFlag(ID, "restoredActorUuids").filter(uuid => uuid !== actor.uuid));
        authority(combat);
        const latest = participants(combat).get(actor.uuid);
        if (!latest || latest.actor !== actor || !equal(selection(actor), entry.activityIds) || latest.combatants.some(c => !Number.isFinite(c.initiative))) continue;
      }
      await actor.update({ "system.exploration": [], [`flags.${ID}.clearReceipt`]: { combatUuid: combat.uuid, clearedIds: entry.activityIds, phase: "cleared" } }, { noHook: true });
      authority(combat);
      if (matchingEntry(combat, actor) && !selection(actor).length) await removeExplorationEffects(combat, actor);
    }
  });
}

export function replaySelections(combat) {
  return queued(combat, async () => {
    for (const { actor } of participants(combat).values()) {
      const entry = matchingEntry(combat, actor);
      if (!entry || selection(actor).length || combat.getFlag(ID, "restoredActorUuids")?.includes(actor.uuid)) continue;
      authority(combat);
      await actor.update({ "system.exploration": entry.activityIds, [`flags.${ID}.clearReceipt`]: { combatUuid: combat.uuid, clearedIds: entry.activityIds, phase: "replaying" } }, { noHook: true });
    }
  });
}

export function finishReplay(combat) {
  return queued(combat, async () => {
    for (const saved of snapshot(combat)?.entries ?? []) {
      const actor = participants(combat).get(saved.actorUuid)?.actor ?? await fromUuid(saved.actorUuid);
      authority(combat);
      if (!actor) continue;
      const entry = matchingEntry(combat, actor);
      if (!entry || receipt(actor)?.phase !== "replaying") continue;
      authority(combat);
      const update = { [`flags.${ID}.clearReceipt`]: { combatUuid: combat.uuid, clearedIds: entry.activityIds, phase: "cleared" } };
      if (equal(selection(actor), entry.activityIds)) update["system.exploration"] = [];
      await actor.update(update, { noHook: true });
      authority(combat);
      if (matchingEntry(combat, actor) && !selection(actor).length) await removeExplorationEffects(combat, actor);
    }
  });
}

export function reconcileMarker(item) {
  const actor = item.parent;
  if (!game.user.isActiveGM || game.system.id !== "pf2e" || game.settings.get(ID, "cleanup") !== "automatic" || actor?.type !== "character" || item.type !== "effect" || !MARKERS.has(item.sourceId ?? item.flags?.core?.sourceId)) return Promise.resolve();
  const combat = game.combats.get(/^Combat\.([^.]+)$/.exec(receipt(actor)?.combatUuid)?.[1]);
  if (!combat) return Promise.resolve();
  return queued(combat, async () => {
    if (!matchingEntry(combat, actor) || selection(actor).length || !actor.items.get(item.id)) return;
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
  });
}

export function capture(combat) {
  const entries = captureEntries(combat);
  return queued(combat, () => saveCapture(combat, entries));
}

export function clearEligible(combat, { automatic = false, reviewed = false } = {}) {
  return clearSelections(combat, { automatic, reviewed });
}

export function clearBeforeStart(combat) {
  return clearSelections(combat, { automatic: true, beforeStart: true });
}

function clearSelections(combat, { automatic = false, reviewed = false, beforeStart = false }) {
  const entries = captureEntries(combat);
  return queued(combat, async () => {
    const result = { changed: [], skipped: [] };
    if ((!combat.started && !beforeStart) || (!automatic && !reviewed)) return result;
    if (automatic && ((!beforeStart && avoidNotice()) || combat.combatants.some(c => !Number.isFinite(c.initiative)))) return result;
    await saveCapture(combat, entries);
    authority(combat);
    for (const entry of snapshot(combat).entries) {
      const current = participants(combat).get(entry.actorUuid);
      if (!current) continue;
      const { actor, combatants } = current;
      const owned = receipt(actor);
      if (!entry.activityIds.length || (owned && !expiredReceipt(owned)) || combat.getFlag(ID, "restoredActorUuids")?.includes(actor.uuid) || !equal(selection(actor), entry.activityIds) || combatants.some(c => !Number.isFinite(c.initiative))) {
        result.skipped.push(actor.name);
        continue;
      }
      authority(combat);
      await actor.update({ "system.exploration": [], [`flags.${ID}.clearReceipt`]: { combatUuid: combat.uuid, clearedIds: entry.activityIds } });
      authority(combat);
      result.changed.push(actor.name);
    }
    return result;
  });
}

export function restoreEligible(combat) {
  return queued(combat, async () => {
    const result = { changed: [], skipped: [] };
    for (const entry of snapshot(combat)?.entries ?? []) {
      const actor = participants(combat).get(entry.actorUuid)?.actor ?? await fromUuid(entry.actorUuid);
      authority(combat);
      const owned = actor && receipt(actor);
      if (!actor || owned?.combatUuid !== combat.uuid || !equal(owned.clearedIds, entry.activityIds) || selection(actor).length) {
        result.skipped.push(entry.name);
        continue;
      }
      const restored = combat.getFlag(ID, "restoredActorUuids") ?? [];
      if (!restored.includes(actor.uuid)) {
        await combat.setFlag(ID, "restoredActorUuids", [...restored, actor.uuid]);
        authority(combat);
      }
      if (selection(actor).length || receipt(actor)?.combatUuid !== combat.uuid || !equal(receipt(actor)?.clearedIds, entry.activityIds)) {
        result.skipped.push(actor.name);
        continue;
      }
      const valid = entry.activityIds.filter(id => {
        const item = actor.items.get(id);
        return ["action", "feat"].includes(item?.type) && item.system.traits?.value?.includes("exploration");
      });
      await actor.update({ "system.exploration": valid, [`flags.${ID}.clearReceipt`]: new foundry.data.operators.ForcedDeletion() });
      authority(combat);
      result.changed.push(actor.name);
    }
    return result;
  });
}

function hasScoutingEffect(actor, incredible) {
  const value = incredible ? 2 : 1;
  return actor.items.some(item => {
    if (item.type !== "effect") return false;
    const source = item.sourceId ?? item.flags?.core?.sourceId;
    const strength = source === INCREDIBLE_SCOUT || source === SCOUT_DEDICATION || item.system.slug === "effect-scout-incredible-scout" ? 2
      : source === SCOUT || item.system.slug === "effect-scout" ? 1 : 0;
    return strength >= value || item.system.rules?.some(rule => rule.key === "FlatModifier" && rule.slug === "scouting-bonus" && rule.type === "circumstance" && [rule.selector].flat().includes("initiative") && rule.value >= value);
  });
}

export function prepareAutomaticScouting(combat, rollingIds = []) {
  return queued(combat, async () => {
    if (!game.settings.get(ID, "scout") || combat.started) return;
    const party = [...participants(combat).values()];
    const allies = party.filter(({ actor }) => actor.alliance === "party");
    const scouts = allies.filter(({ actor }) => effectiveSelection(combat, actor).some(id => actor.items.get(id)?.system.slug === "scout"));
    if (!scouts.length) return;
    const incredible = scouts.some(({ actor }) => actor.items.some(item => item.type === "feat" && ["incredible-scout", "scout-dedication"].includes(item.system.slug)));
    const sourceId = incredible ? INCREDIBLE_SCOUT : SCOUT;
    const effect = await fromUuid(sourceId);
    authority(combat);
    if (!effect || effect.type !== "effect") throw new Error("The canonical PF2e scouting effect could not be loaded.");
    for (const { actor, combatants } of allies) {
      authority(combat);
      if (combat.started) throw new Error("The encounter started during Scout preparation.");
      if ((combatants.some(c => Number.isFinite(c.initiative)) && !combatants.some(c => rollingIds.includes(c.id))) || hasScoutingEffect(actor, incredible)) continue;
      const data = effect.toObject();
      delete data._id;
      data.flags ??= {};
      data.flags.core = { ...data.flags.core, sourceId };
      await actor.createEmbeddedDocuments("Item", [data]);
    }
  });
}

export function prepareScouting(combat, sourceUuid, recipientUuids) {
  return queued(combat, async () => {
    if (!game.settings.get(ID, "scout")) throw new Error("Scouting preparation is disabled.");
    const party = participants(combat);
    const source = party.get(sourceUuid)?.actor;
    if (combat.started || combat.combatants.some(c => Number.isFinite(c.initiative))) throw new Error("Prepare scouting before anyone rolls initiative or starts the encounter.");
    if (!source || !selection(source).some(id => source.items.get(id)?.system.slug === "scout")) throw new Error("Choose a participating character with Scout selected.");
    const recipients = [...new Set(recipientUuids)];
    if (!recipients.length || recipients.some(uuid => !party.has(uuid))) throw new Error("Select participating recipients explicitly.");
    const incredible = source.items.some(item => item.type === "feat" && item.system.slug === "incredible-scout");
    const effect = await fromUuid(incredible ? INCREDIBLE_SCOUT : SCOUT);
    authority(combat);
    if (!effect || effect.type !== "effect") throw new Error("The canonical PF2e scouting effect could not be loaded.");
    const result = { changed: [], skipped: [] };
    for (const uuid of recipients) {
      const current = participants(combat);
      const actor = current.get(uuid)?.actor;
      authority(combat);
      if (combat.started || combat.combatants.some(c => Number.isFinite(c.initiative))) throw new Error("Initiative changed. Scouting preparation stopped.");
      if (!actor || !current.has(sourceUuid) || !selection(source).some(id => source.items.get(id)?.system.slug === "scout")) throw new Error("Participants or Scout selection changed. Reopen the handoff.");
      if (hasScoutingEffect(actor, incredible)) { result.skipped.push(actor.name); continue; }
      const data = effect.toObject();
      delete data._id;
      data.flags ??= {};
      data.flags.core = { ...data.flags.core, sourceId: incredible ? INCREDIBLE_SCOUT : SCOUT };
      await actor.createEmbeddedDocuments("Item", [data]);
      authority(combat);
      result.changed.push(actor.name);
    }
    return result;
  });
}
