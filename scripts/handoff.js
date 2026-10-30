export const ID = "pf2e-exploration-manager";
export const SCOUT = "Compendium.pf2e.other-effects.Item.EMqGwUi3VMhCjTlF";
export const INCREDIBLE_SCOUT = "Compendium.pf2e.feat-effects.Item.la8rWwUtReElgTS6";
let queue = Promise.resolve();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const selection = actor => [...actor.system.exploration];
export const avoidNotice = () => !!game.modules.get("pf2e-avoid-notice")?.active;
export const snapshot = combat => combat.getFlag(ID, "handoff");
const receipt = actor => actor.getFlag(ID, "clearReceipt");

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

function authority(combat) {
  if (!game.user.isActiveGM || game.system.id !== "pf2e" || game.combats.get(combat.id) !== combat) {
    throw new Error("Only the active GM can change a saved PF2e encounter.");
  }
  if (game.release.generation !== 14 || game.release.build < 361 || game.system.version !== "8.6.1") {
    throw new Error("This release requires Foundry 14.361 or later in generation 14 and PF2e 8.6.1.");
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

async function saveCapture(combat, entries) {
  const existing = snapshot(combat);
  if (existing && (existing.version !== 1 || !Array.isArray(existing.entries))) throw new Error("Unsupported exploration snapshot.");
  const merged = [...(existing?.entries ?? [])];
  for (const entry of entries) if (!merged.some(e => e.actorUuid === entry.actorUuid)) merged.push(entry);
  if (!existing || merged.length !== existing.entries.length) {
    authority(combat);
    await combat.setFlag(ID, "handoff", { version: 1, entries: merged });
  }
}

export function capture(combat) {
  const entries = captureEntries(combat);
  return queued(combat, () => saveCapture(combat, entries));
}

export function clearEligible(combat, { automatic = false, reviewed = false } = {}) {
  const entries = captureEntries(combat);
  return queued(combat, async () => {
    const result = { changed: [], skipped: [] };
    if (!combat.started || (!automatic && !reviewed)) return result;
    if (automatic && (avoidNotice() || combat.combatants.some(c => !Number.isFinite(c.initiative)))) return result;
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
      await actor.update({ "system.exploration": valid, [`flags.${ID}.-=clearReceipt`]: null });
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
    const strength = source === INCREDIBLE_SCOUT || item.system.slug === "effect-scout-incredible-scout" ? 2
      : source === SCOUT || item.system.slug === "effect-scout" ? 1 : 0;
    return strength >= value || item.system.rules?.some(rule => rule.key === "FlatModifier" && rule.slug === "scouting-bonus" && rule.type === "circumstance" && [rule.selector].flat().includes("initiative") && rule.value >= value);
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
