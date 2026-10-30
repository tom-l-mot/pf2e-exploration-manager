import test from "node:test";
import assert from "node:assert/strict";
import { ID, SCOUT, capture, clearEligible, restoreEligible, prepareScouting, snapshot, participants } from "../scripts/handoff.js";

const hooks = new Map();
globalThis.Hooks = { once: (name, fn) => hooks.set(name, fn), on: (name, fn) => hooks.set(name, fn) };
const { reviewContent, registerSettings, encounterChanged } = await import("../scripts/main.js");

function fixture({ ids = ["scout"], initiative = 0, uuid = "Actor.hero" } = {}) {
  const items = [{ id: "scout", name: "Scout", type: "action", system: { slug: "scout", traits: { value: ["exploration"] } } }, { id: "defend", name: "Defend", type: "action", system: { slug: "defend", traits: { value: ["exploration"] } } }];
  items.get = id => items.find(item => item.id === id);
  const actor = { uuid, name: "Hero", type: "character", system: { exploration: [...ids] }, items, flags: {}, writes: [],
    getFlag: (_module, key) => actor.flags[key],
    async update(data) {
      if (actor.beforeWrite) await actor.beforeWrite(data);
      actor.writes.push(structuredClone(data));
      actor.system.exploration = [...data["system.exploration"]];
      if (data[`flags.${ID}.clearReceipt`]) actor.flags.clearReceipt = structuredClone(data[`flags.${ID}.clearReceipt`]);
      if (`flags.${ID}.-=clearReceipt` in data) delete actor.flags.clearReceipt;
      if (actor.afterWrite) await actor.afterWrite(data);
    },
    async createEmbeddedDocuments(_type, data) { actor.items.push(...data); }
  };
  const combat = { id: crypto.randomUUID(), started: true, combatants: [{ id: "c1", actor, initiative }], flags: {},
    getFlag: (_module, key) => combat.flags[key],
    async setFlag(_module, key, data) { if (combat.beforeWrite) await combat.beforeWrite(); combat.flags[key] = structuredClone(data); }
  };
  combat.uuid = `Combat.${combat.id}`;
  for (const c of combat.combatants) c.parent = combat;
  const settings = new Map([["cleanup", "review"], ["scout", true]]);
  globalThis.game = { user: { isActiveGM: true }, release: { generation: 14, build: 361 }, system: { id: "pf2e", version: "8.6.1" }, modules: new Map(), combats: new Map([[combat.id, combat]]), combat,
    settings: { get: (_module, key) => settings.get(key) } };
  globalThis.fromUuid = async id => id === actor.uuid ? actor : { type: "effect", toObject: () => ({ _id: "canonical", name: "Scouting", type: "effect", system: { slug: "effect-scouting", rules: [] } }) };
  return { actor, combat, settings };
}

test("clear stores receipt in the same write, restores valid activities, and is repeatable", async () => {
  const { actor, combat } = fixture();
  await capture(combat);
  assert.deepEqual((await clearEligible(combat, { reviewed: true })).changed, ["Hero"]);
  assert.deepEqual(actor.writes[0], { "system.exploration": [], [`flags.${ID}.clearReceipt`]: { combatUuid: combat.uuid, clearedIds: ["scout"] } });
  await clearEligible(combat, { reviewed: true });
  assert.equal(actor.writes.length, 1);
  await restoreEligible(combat);
  assert.deepEqual(actor.system.exploration, ["scout"]);
  assert.equal(actor.flags.clearReceipt, undefined);
  assert.equal(actor.writes[1][`flags.${ID}.-=clearReceipt`], null);
  await restoreEligible(combat);
  assert.equal(actor.writes.length, 2);
  await clearEligible(combat, { automatic: true });
  await clearEligible(combat, { reviewed: true });
  assert.deepEqual(actor.system.exploration, ["scout"]);
  assert.equal(actor.writes.length, 2);
});

test("snapshot remains immutable through repeated hooks, edits, and late entrants", async () => {
  const { actor, combat } = fixture();
  await Promise.all([capture(combat), capture(combat)]);
  actor.system.exploration = ["defend"];
  await encounterChanged(combat);
  assert.deepEqual(snapshot(combat).entries[0].activityIds, ["scout"]);
  assert.deepEqual((await clearEligible(combat, { reviewed: true })).changed, []);
  const synthetic = fixture({ uuid: "Scene.scene.Token.token.Actor.hero" }).actor;
  game.combats.set(combat.id, combat);
  combat.combatants.push({ id: "late", actor: synthetic, initiative: null });
  await capture(combat);
  assert.equal(snapshot(combat).entries.length, 2);
  assert.deepEqual(snapshot(combat).entries[0].activityIds, ["scout"]);
});

test("linked duplicates require all initiative rolls, synthetic actor stays separate, NPC excluded", async () => {
  const { actor, combat } = fixture();
  combat.combatants.push({ id: "c2", actor, initiative: null }, { id: "npc", actor: { type: "npc" }, initiative: 5 });
  assert.equal(participants(combat).size, 1);
  await clearEligible(combat, { reviewed: true });
  assert.deepEqual(actor.system.exploration, ["scout"]);
  combat.combatants[1].initiative = -1;
  await clearEligible(combat, { reviewed: true });
  assert.deepEqual(actor.system.exploration, []);
});

test("automatic cleanup blocks Avoid Notice and any unrolled participant; manual clears only eligible", async () => {
  const { actor, combat } = fixture();
  game.modules.set("pf2e-avoid-notice", { active: true });
  await clearEligible(combat, { automatic: true });
  assert.deepEqual(actor.system.exploration, ["scout"]);
  game.modules.clear();
  const other = { ...actor, uuid: "Actor.other", name: "Other" };
  combat.combatants.push({ id: "other", actor: other, initiative: null });
  await clearEligible(combat, { automatic: true });
  assert.deepEqual(actor.system.exploration, ["scout"]);
  await clearEligible(combat, { reviewed: true });
  assert.deepEqual(actor.system.exploration, []);
});

test("empty selection is never inferred to be owned, and pending receipt blocks another combat", async () => {
  const { actor, combat } = fixture();
  await capture(combat);
  actor.system.exploration = [];
  await restoreEligible(combat);
  assert.deepEqual(actor.system.exploration, []);
  actor.system.exploration = ["scout"];
  actor.flags.clearReceipt = { combatUuid: "Combat.previous", clearedIds: ["scout"] };
  await clearEligible(combat, { reviewed: true });
  assert.equal(actor.writes.length, 0);
  await restoreEligible(combat);
  assert.equal(actor.writes.length, 0);
});

test("restore preserves user edits and filters missing or non-exploration items", async () => {
  const { actor, combat } = fixture({ ids: ["scout", "missing", "defend"] });
  await clearEligible(combat, { reviewed: true });
  actor.system.exploration = ["defend"];
  await restoreEligible(combat);
  assert.deepEqual(actor.system.exploration, ["defend"]);
  actor.system.exploration = [];
  actor.items.get("defend").system.traits.value = [];
  await restoreEligible(combat);
  assert.deepEqual(actor.system.exploration, ["scout"]);
});

test("failed capture cannot clear actors; rejected actor writes leave no inferred ownership", async () => {
  const { actor, combat } = fixture();
  combat.beforeWrite = () => { throw new Error("disk"); };
  await assert.rejects(clearEligible(combat, { reviewed: true }), /disk/);
  assert.equal(actor.writes.length, 0);
  delete combat.beforeWrite;
  actor.beforeWrite = () => { throw new Error("permission"); };
  await assert.rejects(clearEligible(combat, { reviewed: true }), /permission/);
  assert.deepEqual(actor.system.exploration, ["scout"]);
  assert.equal(actor.flags.clearReceipt, undefined);
});

test("write committed before an error still has a receipt and can recover", async () => {
  const { actor, combat } = fixture();
  actor.afterWrite = () => { throw new Error("lost response"); };
  await assert.rejects(clearEligible(combat, { reviewed: true }), /lost response/);
  assert.deepEqual(actor.system.exploration, []);
  assert.equal(actor.flags.clearReceipt.combatUuid, combat.uuid);
  delete actor.afterWrite;
  await restoreEligible(combat);
  assert.deepEqual(actor.system.exploration, ["scout"]);
});

test("failed restore preserves receipt and suppression, and retry succeeds", async () => {
  const { actor, combat } = fixture();
  await clearEligible(combat, { reviewed: true });
  actor.beforeWrite = () => { throw new Error("restore rejected"); };
  await assert.rejects(restoreEligible(combat), /restore rejected/);
  assert.equal(actor.flags.clearReceipt.combatUuid, combat.uuid);
  assert.deepEqual(combat.getFlag(ID, "restoredActorUuids"), [actor.uuid]);
  assert.deepEqual(actor.system.exploration, []);
  delete actor.beforeWrite;
  await restoreEligible(combat);
  await clearEligible(combat, { automatic: true });
  assert.deepEqual(actor.system.exploration, ["scout"]);
});

test("start capture is synchronous, prestart scouting does not capture, active GM fallback captures", async () => {
  const { actor, combat } = fixture({ initiative: null });
  combat.started = false;
  await prepareScouting(combat, actor.uuid, [actor.uuid]);
  assert.equal(snapshot(combat), undefined);
  actor.system.exploration = ["defend"];
  combat.started = true;
  await encounterChanged(combat);
  assert.deepEqual(snapshot(combat).entries[0].activityIds, ["defend"]);
  const next = fixture();
  const pending = capture(next.combat);
  next.actor.system.exploration = ["defend"];
  await pending;
  assert.deepEqual(snapshot(next.combat).entries[0].activityIds, ["scout"]);
});

test("automatic cleanup blocks unrolled NPC too, but manual review can clear rolled character", async () => {
  const { actor, combat } = fixture();
  combat.combatants.push({ id: "npc", actor: { type: "npc" }, initiative: null });
  await clearEligible(combat, { automatic: true });
  assert.deepEqual(actor.system.exploration, ["scout"]);
  await clearEligible(combat, { reviewed: true });
  assert.deepEqual(actor.system.exploration, []);
});

test("concurrent cleanup clicks produce one actor write", async () => {
  const { actor, combat } = fixture();
  await Promise.all([clearEligible(combat, { reviewed: true }), clearEligible(combat, { reviewed: true })]);
  assert.equal(actor.writes.length, 1);
});

test("Incredible Scout uses its canonical effect and disabled Scout refuses", async () => {
  const { actor, combat, settings } = fixture({ initiative: null });
  combat.started = false;
  settings.set("scout", false);
  await assert.rejects(prepareScouting(combat, actor.uuid, [actor.uuid]), /disabled/);
  settings.set("scout", true);
  actor.items.push({ type: "feat", system: { slug: "incredible-scout" } });
  await prepareScouting(combat, actor.uuid, [actor.uuid]);
  assert.equal(actor.items.at(-1).flags.core.sourceId, "Compendium.pf2e.feat-effects.Item.la8rWwUtReElgTS6");
});

test("nonGM rejected and GM handover after capture await stops actor mutation", async () => {
  const { actor, combat } = fixture();
  game.user.isActiveGM = false;
  await assert.rejects(capture(combat), /active GM/);
  await assert.rejects(restoreEligible(combat), /active GM/);
  game.user.isActiveGM = true;
  combat.beforeWrite = () => { game.user.isActiveGM = false; };
  await assert.rejects(clearEligible(combat, { reviewed: true }), /active GM/);
  assert.equal(actor.writes.length, 0);
});

test("unsupported runtime versions refuse document writes", async () => {
  const { actor, combat } = fixture();
  game.system.version = "8.7.0";
  await assert.rejects(clearEligible(combat, { reviewed: true }), /requires Foundry/);
  assert.equal(actor.writes.length, 0);
  game.system.version = "8.6.1";
  game.release.generation = 15;
  await assert.rejects(capture(combat), /requires Foundry/);
});

test("synthetic token actor clears independently of its linked actor", async () => {
  const linked = fixture({ uuid: "Actor.hero" });
  const synthetic = fixture({ uuid: "Scene.scene.Token.token.Actor.hero", ids: ["defend"] }).actor;
  game.combats.set(linked.combat.id, linked.combat);
  linked.combat.combatants.push({ id: "synthetic", actor: synthetic, initiative: 2 });
  await clearEligible(linked.combat, { reviewed: true });
  assert.deepEqual(linked.actor.system.exploration, []);
  assert.deepEqual(synthetic.system.exploration, []);
  assert.equal(linked.actor.flags.clearReceipt.combatUuid, linked.combat.uuid);
  assert.deepEqual(synthetic.flags.clearReceipt.clearedIds, ["defend"]);
  await restoreEligible(linked.combat);
  assert.deepEqual(linked.actor.system.exploration, ["scout"]);
  assert.deepEqual(synthetic.system.exploration, ["defend"]);
});

test("Scout requires pre-roll explicit recipients, canonical effect, and prevents equivalent duplicates", async () => {
  const { actor, combat } = fixture({ initiative: null });
  combat.started = false;
  await assert.rejects(prepareScouting(combat, actor.uuid, []), /explicitly/);
  await assert.rejects(prepareScouting(combat, "Actor.wrong", [actor.uuid]), /Scout selected/);
  await prepareScouting(combat, actor.uuid, [actor.uuid]);
  assert.equal(actor.items.length, 3);
  assert.equal(actor.items[2].flags.core.sourceId, SCOUT);
  assert.equal(actor.items[2]._id, undefined);
  await prepareScouting(combat, actor.uuid, [actor.uuid]);
  assert.equal(actor.items.length, 3);
  actor.items.pop();
  actor.items.push({ type: "effect", system: { rules: [{ key: "FlatModifier", type: "circumstance", selector: "initiative" }] } });
  await prepareScouting(combat, actor.uuid, [actor.uuid]);
  assert.equal(actor.items.length, 3);
  combat.combatants[0].initiative = 0;
  await assert.rejects(prepareScouting(combat, actor.uuid, [actor.uuid]), /before anyone/);
});

test("Scout rechecks initiative and authority after loading canonical document", async () => {
  const { actor, combat } = fixture({ initiative: null });
  combat.started = false;
  const load = fromUuid;
  globalThis.fromUuid = async uuid => { combat.combatants[0].initiative = 10; return load(uuid); };
  await assert.rejects(prepareScouting(combat, actor.uuid, [actor.uuid]), /Initiative changed/);
  assert.equal(actor.items.length, 2);
});

test("native settings default to review and escape names and activity labels", () => {
  const { actor, combat } = fixture();
  actor.name = '<img src=x onerror="bad()">';
  actor.items[0].name = "<script>bad()</script>";
  const html = reviewContent(combat);
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  const registered = new Map();
  globalThis.foundry = { applications: { api: { DialogV2: class {} } } };
  game.settings.registerMenu = (_module, key, data) => registered.set(key, data);
  game.settings.register = (_module, key, data) => registered.set(key, data);
  registerSettings();
  assert.equal(registered.get("cleanup").default, "review");
  assert.equal(registered.get("handoff").restricted, true);
  assert.equal(registered.get("scout").default, true);
  assert.equal(hooks.has("updateCombat"), true);
});
