import { registerAutomatic, addedCombatant, recoverReplays } from "./automatic.js";
import { ID, participants, selection, snapshot, capture, clearEligible, restoreEligible, prepareScouting, expiredReceipt, reconcileMarker } from "./handoff.js";

export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reportError = error => { console.error(ID, error); ui.notifications.error(error.message); };
const notify = result => ui.notifications.info(`Changed ${result.changed.length} character(s). Skipped ${result.skipped.length}. Reopen the handoff to review.`);

export function reviewContent(combat) {
  if (!combat) return "<p>Select an encounter in the combat tracker first.</p>";
  const saved = snapshot(combat)?.entries ?? [];
  const rows = [...participants(combat).values()].map(({ actor, combatants }) => {
    const entry = saved.find(e => e.actorUuid === actor.uuid);
    const current = selection(actor).map(id => actor.items.get(id)?.name ?? `Missing activity (${id})`);
    const status = combatants.every(c => Number.isFinite(c.initiative)) ? "Rolled" : "Waiting for initiative";
    const owned = actor.getFlag(ID, "clearReceipt");
    const recovery = owned ? (expiredReceipt(owned) ? "Earlier encounter deleted; receipt expires on next eligible clear" : owned.combatUuid === combat.uuid ? "Clear receipt saved" : "Recovery belongs to another encounter") : "";
    return `<tr><th scope="row">${escapeHTML(actor.name)}</th><td>${escapeHTML(current.join(", ") || "None")}</td><td>${escapeHTML(entry ? entry.labels.join(", ") || "None" : "Not captured")}</td><td>${escapeHTML(status)}<br>${escapeHTML(recovery)}</td></tr>`;
  }).join("");
  return `<p>Cleanup mode: ${escapeHTML(game.settings.get(ID, "cleanup"))}. Recovery is stored with this encounter. Restore before ending or deleting it. An expired receipt can be replaced by the next eligible clear.</p>
    <p>Automatic mode clears all native selections and known exploration markers after initiative. Saved activities remain available to encounter callbacks and recovery.</p>
    <table><thead><tr><th>Character</th><th>Current activities</th><th>Saved activities</th><th>Initiative and recovery</th></tr></thead><tbody>${rows}</tbody></table>
    <p>Automatic Begin Encounter resolves selected Defend with a usable held shield until the character's first turn.</p>
    <p>Automatic mode rolls Stealth when Avoid Notice characters join the tracker. Begin Encounter repairs their non-Stealth initiative. Recorded Stealth is preserved unless explicitly rerolled. Scout is prepared before automatic rolls; later Scouts do not change existing totals. Manual preparation remains available for recovery.</p>`;
}

async function scoutDialog(combat) {
  const party = [...participants(combat).values()];
  const sources = party.filter(({ actor }) => selection(actor).some(id => actor.items.get(id)?.system.slug === "scout"));
  if (!sources.length) throw new Error("No participating character has Scout selected in the native activity picker.");
  await foundry.applications.api.DialogV2.wait({
    window: { title: "Prepare scouting before initiative" },
    content: `<label>Scout source <select name="source">${sources.map(({ actor }) => `<option value="${escapeHTML(actor.uuid)}">${escapeHTML(actor.name)}</option>`).join("")}</select></label><p>Select the characters this scout is scouting for.</p>${party.map(({ actor }) => `<label style="display:block"><input type="checkbox" name="recipient" value="${escapeHTML(actor.uuid)}"> ${escapeHTML(actor.name)}</label>`).join("")}`,
    buttons: [{ action: "prepare", label: "Apply scouting", callback: async (_event, button) => {
      await prepareScouting(combat, button.form.elements.source.value, [...button.form.querySelectorAll('input[name="recipient"]:checked')].map(input => input.value)).then(notify).catch(reportError);
    } }, { action: "cancel", label: "Cancel" }]
  });
}

function configuration(combat) {
  const buttons = combat && game.user.isActiveGM ? [
    { action: "scout", label: "Prepare scouting", disabled: !game.settings.get(ID, "scout"), callback: () => scoutDialog(combat).catch(reportError) },
    { action: "clear", label: "Clear eligible selections", callback: async () => {
      if (await foundry.applications.api.DialogV2.confirm({ window: { title: "Clear saved exploration selections?" }, content: "<p>I have resolved exploration benefits and all other encounter automation has finished. Only unchanged selections with rolled initiative will be cleared.</p>" })) await clearEligible(combat, { reviewed: true }).then(notify).catch(reportError);
    } },
    { action: "restore", label: "Restore cleared selections", callback: async () => {
      if (await foundry.applications.api.DialogV2.confirm({ window: { title: "Restore exploration selections?" }, content: "<p>Restore saved activities only where this encounter has a matching clear receipt and the current selection is empty. Missing activity items will be omitted.</p>" })) await restoreEligible(combat).then(notify).catch(reportError);
    } }
  ] : [];
  return { window: { title: "Exploration handoff" }, position: { width: 780 }, content: reviewContent(combat), buttons: [...buttons, { action: "close", label: "Close", default: true }] };
}

export async function openHandoff(combat = game.combat) {
  try {
    if (combat?.started && game.user.isActiveGM) await capture(combat);
    return await foundry.applications.api.DialogV2.wait(configuration(combat));
  } catch (error) { reportError(error); }
}

export function registerSettings() {
  class HandoffMenu extends foundry.applications.api.DialogV2 {
    constructor() { super(configuration(game.combat)); }
  }
  game.settings.registerMenu(ID, "handoff", { name: "Exploration handoff", label: "Open handoff", hint: "Review the selected encounter, prepare Scout, clear, or restore activities.", icon: "fas fa-person-hiking", type: HandoffMenu, restricted: true });
  game.settings.register(ID, "cleanup", { name: "Encounter cleanup", hint: "Automatic mode rolls Stealth for Avoid Notice on tracker entry and clears native selections and known markers after initiative. Begin Encounter preserves callback benefits and resolves Defend.", scope: "world", config: true, type: String, choices: { off: "Off", review: "Review", automatic: "Automatic" }, default: "automatic" });
  game.settings.register(ID, "scout", { name: "Enable pre-roll scouting preparation", hint: "Prepares canonical PF2e Scout effects before automatic tracker-entry rolls, Begin Encounter, or tracker initiative rolls. Later Scouts do not change existing totals.", scope: "world", config: true, type: Boolean, default: true });
}

export async function encounterChanged(combat, { prompt = false } = {}) {
  if (!game.user.isActiveGM || !combat.started || game.settings.get(ID, "cleanup") !== "review") return;
  await capture(combat);
  if (!game.user.isActiveGM) return;
  const mode = game.settings.get(ID, "cleanup");
  if (mode === "review" && prompt) await openHandoff(combat);
}

Hooks.once("init", registerSettings);
Hooks.once("ready", () => { registerAutomatic(); void recoverReplays().catch(reportError); });
Hooks.on("userConnected", () => recoverReplays().catch(reportError));
Hooks.on("updateUser", (_user, changes) => {
  if ("role" in changes) void recoverReplays().catch(reportError);
});
Hooks.on("createCombatant", combatant => { void addedCombatant(combatant).catch(reportError); });
Hooks.on("updateCombatant", (combatant, changes) => {
  if (Number.isFinite(changes.initiative)) void addedCombatant(combatant).catch(reportError);
});
Hooks.on("createItem", item => { void reconcileMarker(item).catch(reportError); });
Hooks.on("updateCombat", (combat, changes) => {
  void encounterChanged(combat, { prompt: changes.round === 1 && changes.turn === 0 }).catch(reportError);
});
Hooks.on("renderCombatTracker", (_app, element) => {
  if (!game.user.isActiveGM || element.querySelector(`[data-${ID}]`)) return;
  const header = element.querySelector(".combat-tracker-header");
  if (!header) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset["pf2eExplorationManager"] = "";
  button.textContent = "Exploration";
  button.addEventListener("click", () => { void openHandoff(); });
  header.append(button);
});
