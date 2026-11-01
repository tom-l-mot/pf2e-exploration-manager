import test from "node:test";
import assert from "node:assert/strict";
import { ID, SCOUT, INCREDIBLE_SCOUT } from "../scripts/handoff.js";
import { startCombat, dispatchCombatStart, SHIELD, trackerInitiative } from "../scripts/automatic.js";
import * as automatic from "../scripts/automatic.js";
import * as handoff from "../scripts/handoff.js";

function fixture({ initiatives = [null], ids = ["scout", "defend", "avoid"], incredible = false } = {}) {
  const calls = [];
  const effects = [];
  const items = [
    ...["scout", "defend", "avoid"].map(id => ({ id, type: "action", name: id, system: { slug: id === "avoid" ? "avoid-notice" : id, traits: { value: ["exploration"] } } })),
    ...(incredible ? [{ type: "feat", system: { slug: "incredible-scout" } }] : [])
  ];
  items.get = id => items.find(i => i.id === id);
  class Initiative {
    constructor(actor, options) { this.actor = actor; this.options = options; this.tiebreakPriority = 2; }
    async roll(options) {
      this.actor.lastRollOptions = options;
      calls.push(["stealth", this.options.statistic, options.skipDialog, options.updateTracker, this.actor.items.filter(i => i.type === "effect").map(i => i.flags?.core?.sourceId)]);
      return { combatant: options.combatant, roll: { total: 14 } };
    }
  }
  const actor = { uuid: "Actor.hero", name: "Hero", type: "character", alliance: "party", flags: {}, items,
    system: { exploration: ids, initiative: { statistic: "perception" } }, heldShield: { isBroken: false, isDestroyed: false },
    getFlag: (_id, key) => actor.flags[key],
    async update(data, options) { calls.push(["clear", options]); actor.system.exploration = data["system.exploration"]; actor.flags.clearReceipt = data[`flags.${ID}.clearReceipt`]; },
    async createEmbeddedDocuments(_type, data) { items.push(...data.map(item => ({ ...item, id: `effect${items.length}` }))); },
    async deleteEmbeddedDocuments(_type, ids) { for (const id of ids) items.splice(items.findIndex(item => item.id === id), 1); }
  };
  actor.initiative = new Initiative(actor, { statistic: "perception" });
  const combatants = initiatives.map((initiative, index) => ({ id: `c${index}`, actor, initiative, flags: {pf2e:{initiativeStatistic:"perception"}} }));
  const combat = { id: "test", uuid: "Combat.test", started: false, flags: {}, combatants,
    get turns() { return [...combatants].sort((a,b) => b.initiative-a.initiative); },
    getFlag: (_id, key) => combat.flags[key],
    async setFlag(_id,key,data) { combat.flags[key] = structuredClone(data); },
    async setInitiative(id,total,statistic) { const c = combatants.find(c => c.id === id); c.initiative = total; c.flags.pf2e.initiativeStatistic = statistic; calls.push(["initiative",id,total,statistic]); },
    async rollInitiative(ids, options) { calls.push(["ordinary", ids, options]); for(const id of ids) combatants.find(c => c.id === id).initiative = 8; },
    _playCombatSound(sound) { calls.push(["sound",sound]); },
    async update(data) { calls.push(["round",structuredClone(data),[...actor.system.exploration]]); combat.started = true; return combat; }
  };
  for (const c of combatants) c.parent = combat;
  globalThis.game = { user: { isActiveGM:true }, release: { generation:14,build:369 }, system: {id:"pf2e",version:"8.6.1"}, time: {worldTime:123}, combats: new Map([[combat.id,combat]]), modules: new Map(),
    settings: { get: (module,key) => module===ID ? ({cleanup:"automatic",scout:true})[key] : false },
    pf2e: {actions: { async raiseAShield() { calls.push(["raise"]); const effect = {type:"effect",sourceId:SHIELD, async update(data) { effects.push(data); }}; items.push(effect); } }}
  };
  globalThis.ui = {notifications:{warn: message => calls.push(["warn",message])}};
  globalThis.foundry = {documents:{ActiveEffect:{registry:{async refresh(...args) { calls.push(["refresh",args[0]]); }}}}};
  globalThis.fromUuid = async sourceId => ({ type:"effect", toObject: () => ({type:"effect",system:{slug:sourceId===INCREDIBLE_SCOUT?"effect-scout-incredible-scout":"effect-scout",rules:[]}}) });
  const events = {combatStart:[]};
  let next = 0;
  const nativeErrors = [];
  globalThis.Hooks = { events,
    on(hook, fn, once=false) { const entry = {hook,fn,once,id:++next}; (events[hook]??=[]).push(entry); return entry; },
    callAll(hook,...args) { calls.push(["hooks",args[0].id]); for(const entry of [...(events[hook]??[])]) { if(entry.once) events[hook].splice(events[hook].indexOf(entry),1); try { entry.fn(...args); } catch(error) { nativeErrors.push(error); } } }
  };
  return {actor,combat,calls,effects,nativeErrors};
}
const deferred = () => { let release; const promise = new Promise(resolve => {release=resolve;}); return {promise,release}; };

const markerIds = ["N8vpuGy4TzU10y8E", "F6vJYLZTWDpnrnCZ", "GYOyFj4ziZX060rZ", "OjRHL0B4WAUUQc13", "V347nnVBGDrVWh7k", "vNUrKvoOSvEnqzhM", "tDsgl8YmhZbx2May", "kh1QdKkvbNZ0qBsQ", "mGFBHM1lvHNZ9BsH", "XiVLHjg5lQVMX8Fj", "OcCXjJab7rSR3mDf", "SggYzuL9NtYoktUR", "ThF8UIN5093xtCaq"];
function deletable(actor) {
  actor.deleteEmbeddedDocuments = async (_type, ids) => {
    for (const id of ids) actor.items.splice(actor.items.findIndex(item => item.id === id), 1);
  };
}

for (const marker of markerIds) test(`recorded initiative clears arbitrary native selection and exact marker ${marker}`, async () => {
  const { actor, combat } = fixture({ ids: ["etch-rune-custom"], initiatives: [0] });
  deletable(actor);
  const sourceId = `Compendium.pf2e-automations.effects.Item.${marker}`;
  const preserved = [SHIELD, "Compendium.pf2e.spell-effects.Item.rune", "Compendium.homebrew.effects.Item.same-name"];
  actor.items.push({ id: "marker", name: "Etch Rune", type: "effect", sourceId }, ...preserved.map((sourceId, i) => ({ id: `buff${i}`, name: "Etch Rune", type: "effect", sourceId })));
  await handoff.initiativeRecorded(combat);
  assert.deepEqual(actor.system.exploration, []);
  assert.deepEqual(actor.flags.clearReceipt.clearedIds, ["etch-rune-custom"]);
  assert.equal(actor.items.some(item => item.id === "marker"), false);
  assert.deepEqual(actor.items.filter(item => item.id?.startsWith("buff")).map(item => item.sourceId), preserved);
  assert.equal(combat.started, false);
});

test("ordinary tracker and direct initiative writes await cleanup, while cancelled writes preserve selection", async () => {
  const { actor, combat } = fixture({ ids: ["scout"] });
  assert.equal(await trackerInitiative.call(combat, async () => { combat.combatants[0].initiative = 0; return "native result"; }, ["c0"]), "native result");
  assert.deepEqual(actor.system.exploration, []);
  const next = fixture({ ids: ["defend"] });
  await assert.rejects(automatic.recordedInitiative.call(next.combat, async () => { throw Error("cancelled"); }, "c0", 8), /cancelled/);
  assert.deepEqual(next.actor.system.exploration, ["defend"]);
  assert.equal(await automatic.recordedInitiative.call(next.combat, async () => { next.combat.combatants[0].initiative = 0; return 17; }, "c0", 0), 17);
  assert.deepEqual(next.actor.system.exploration, []);
});

test("cleanup is per actor, waits for linked rolls, and completes for a late join in a started encounter", async () => {
  const { actor, combat } = fixture({ ids: ["custom"], initiatives: [0, null] });
  combat.combatants.push({ id: "npc", actor: { type: "npc" }, initiative: null });
  await handoff.initiativeRecorded(combat);
  assert.deepEqual(actor.system.exploration, ["custom"]);
  combat.combatants[1].initiative = -1;
  await handoff.initiativeRecorded(combat);
  assert.deepEqual(actor.system.exploration, []);
  assert.deepEqual(handoff.effectiveSelection(combat, actor), ["custom"]);
  const next = fixture({ ids: ["late-custom"], initiatives: [9] });
  next.combat.started = true;
  await automatic.addedCombatant(next.combat.combatants[0]);
  assert.deepEqual(next.actor.system.exploration, []);
});

test("automatic snapshot refreshes pre-roll edits, freezes after receipt, and respects explicit edits", async () => {
  const { actor, combat } = fixture({ ids: ["scout"] });
  await handoff.capture(combat);
  actor.system.exploration = ["defend", "arbitrary-custom-action"];
  combat.combatants[0].initiative = 8;
  await handoff.initiativeRecorded(combat);
  assert.deepEqual(handoff.snapshot(combat).entries[0].activityIds, ["defend", "arbitrary-custom-action"]);
  actor.system.exploration = ["scout"];
  await handoff.initiativeRecorded(combat);
  assert.deepEqual(actor.system.exploration, ["scout"]);
  assert.deepEqual(handoff.effectiveSelection(combat, actor), ["scout"]);
  assert.deepEqual(handoff.snapshot(combat).entries[0].activityIds, ["defend", "arbitrary-custom-action"]);
  actor.flags.clearReceipt.clearedIds = ["unmatched"];
  actor.system.exploration = [];
  assert.deepEqual(handoff.effectiveSelection(combat, actor), []);
});

test("only consumed canonical initiative effects and exploration markers end after initiative", async () => {
  const { actor, combat } = fixture({ ids: ["follow-expert"], initiatives: [0] });
  const consumed = [SCOUT, INCREDIBLE_SCOUT, handoff.SCOUT_DEDICATION, "Compendium.pf2e.other-effects.Item.VCSpuc3Tf3XWMkd3"];
  actor.items.push(...consumed.map((sourceId, i) => ({ id: `consumed${i}`, type: "effect", sourceId })));
  const buffs = [{ id: "shield", type: "effect", sourceId: SHIELD }, { id: "spell", type: "effect", sourceId: "Compendium.pf2e.spell-effects.Item.spell", system: { slug: "scout" } }, { id: "rune", type: "weapon", system: { runes: { property: ["flaming"] } } }, { id: "condition", type: "condition", sourceId: SCOUT }];
  actor.items.push(...buffs);
  await handoff.initiativeRecorded(combat);
  assert.equal(actor.items.some(item => item.id?.startsWith("consumed")), false);
  assert.ok(buffs.every(item => actor.items.includes(item)));
});

test("Scout remains available for an unrolled ally after its source rolls and clears", async () => {
  const source = fixture({ ids: ["scout"], initiatives: [0] });
  const ally = fixture({ ids: [], initiatives: [null] }).actor;
  ally.uuid = "Actor.ally";
  game.combats.set(source.combat.id, source.combat);
  source.combat.combatants.push({ id: "ally", actor: ally, initiative: null, parent: source.combat });
  await handoff.prepareAutomaticScouting(source.combat, ["c0", "ally"]);
  await handoff.initiativeRecorded(source.combat);
  assert.deepEqual(source.actor.system.exploration, []);
  assert.equal(source.actor.items.some(item => item.flags?.core?.sourceId === SCOUT), false);
  assert.equal(ally.items.some(item => item.flags?.core?.sourceId === SCOUT), true);
  await handoff.prepareAutomaticScouting(source.combat, ["ally"]);
  assert.equal(ally.items.filter(item => item.flags?.core?.sourceId === SCOUT).length, 1);
});

test("Scout Dedication supplies the stronger Scout benefit before the roll", async () => {
  const { actor, combat, calls } = fixture({ ids: ["scout", "avoid"] });
  actor.items.push({ type: "feat", system: { slug: "scout-dedication" } });
  await automatic.addedCombatant(combat.combatants[0]);
  assert.deepEqual(calls.find(call => call[0] === "stealth").at(-1), [INCREDIBLE_SCOUT]);
  assert.equal(actor.items.some(item => item.flags?.core?.sourceId === INCREDIBLE_SCOUT), false);
});

test("Begin replays receipt-owned native actions without pre-update hooks and clears replay after returned callbacks", async () => {
  const { actor, combat, calls } = fixture({ ids: ["defend", "custom"], initiatives: [0] });
  await handoff.initiativeRecorded(combat);
  assert.deepEqual(actor.system.exploration, []);
  Hooks.on("combatStart", async () => {
    await Promise.resolve();
    assert.deepEqual(actor.system.exploration, ["defend", "custom"]);
    assert.equal(actor.flags.clearReceipt.phase, "replaying");
  });
  await startCombat.call(combat, () => assert.fail());
  assert.deepEqual(actor.system.exploration, []);
  assert.equal(actor.flags.clearReceipt.phase, "cleared");
  assert.ok(calls.filter(call => call[0] === "clear").every(call => call[1].noHook === true));
});

test("stale replay recovers on the active GM and preserves user edits or mismatching receipts", async () => {
  const { actor, combat } = fixture({ ids: ["avoid"], initiatives: [0] });
  await handoff.initiativeRecorded(combat);
  await handoff.replaySelections(combat);
  game.user.isActiveGM = false;
  await handoff.recoverReplays();
  assert.deepEqual(actor.system.exploration, ["avoid"]);
  game.user.isActiveGM = true;
  await handoff.recoverReplays();
  assert.deepEqual(actor.system.exploration, []);
  await handoff.replaySelections(combat);
  actor.system.exploration = ["user-edit"];
  await handoff.recoverReplays();
  assert.deepEqual(actor.system.exploration, ["user-edit"]);
  actor.system.exploration = ["avoid"];
  actor.flags.clearReceipt.clearedIds = ["other"];
  await handoff.recoverReplays();
  assert.deepEqual(actor.system.exploration, ["avoid"]);
});

test("Begin finishes its owned replay even when an encounter callback removes the actor", async () => {
  const { actor, combat } = fixture({ ids: ["avoid"], initiatives: [0] });
  combat.combatants[0].flags.pf2e.initiativeStatistic = "stealth";
  const load = fromUuid;
  globalThis.fromUuid = uuid => uuid === actor.uuid ? actor : load(uuid);
  Hooks.on("combatStart", () => { combat.combatants.splice(0); });
  await startCombat.call(combat, () => assert.fail());
  assert.deepEqual(actor.system.exploration, []);
  assert.equal(actor.flags.clearReceipt.phase, "cleared");
});

test("delayed exact markers reconcile only against a matching clear receipt and empty native selection", async () => {
  const { actor, combat } = fixture({ ids: ["scout"], initiatives: [0] });
  await handoff.initiativeRecorded(combat);
  const marker = { id: "late", parent: actor, type: "effect", sourceId: `Compendium.pf2e-automations.effects.Item.${markerIds[0]}` };
  actor.items.push(marker);
  await handoff.reconcileMarker(marker);
  assert.equal(actor.items.includes(marker), false);
  const scout = { ...marker, id: "canonical", sourceId: SCOUT };
  actor.items.push(scout);
  await handoff.reconcileMarker(scout);
  assert.equal(actor.items.includes(scout), true);
  actor.items.push(marker);
  actor.system.exploration = ["user-edit"];
  await handoff.reconcileMarker(marker);
  assert.equal(actor.items.includes(marker), true);
  actor.system.exploration = [];
  actor.flags.clearReceipt.clearedIds = ["other"];
  await handoff.reconcileMarker(marker);
  assert.equal(actor.items.includes(marker), true);
});

for (const mode of ["off", "review"]) test(`${mode} preserves markers and native selections after a successful initiative write`, async () => {
  const { actor, combat } = fixture({ ids: ["custom"] });
  game.settings.get = () => mode;
  const marker = { id: "marker", type: "effect", sourceId: `Compendium.pf2e-automations.effects.Item.${markerIds[0]}` };
  actor.items.push(marker);
  await automatic.recordedInitiative.call(combat, async () => { combat.combatants[0].initiative = 9; });
  assert.deepEqual(actor.system.exploration, ["custom"]);
  assert.ok(actor.items.includes(marker));
  assert.equal(handoff.snapshot(combat), undefined);
});

test("failed capture and rejected actor writes cannot claim cleanup ownership; failed effect deletion retries", async () => {
  const { actor, combat } = fixture({ ids: ["custom"], initiatives: [0] });
  const save = combat.setFlag;
  combat.setFlag = async () => { throw Error("snapshot failed"); };
  await assert.rejects(handoff.initiativeRecorded(combat), /snapshot failed/);
  assert.deepEqual(actor.system.exploration, ["custom"]);
  combat.setFlag = save;
  const update = actor.update;
  actor.update = async () => { throw Error("actor failed"); };
  await assert.rejects(handoff.initiativeRecorded(combat), /actor failed/);
  assert.equal(actor.flags.clearReceipt, undefined);
  actor.update = update;
  actor.items.push({ id: "marker", type: "effect", sourceId: `Compendium.pf2e-automations.effects.Item.${markerIds[0]}` });
  const remove = actor.deleteEmbeddedDocuments;
  actor.deleteEmbeddedDocuments = async () => { throw Error("effect failed"); };
  await assert.rejects(handoff.initiativeRecorded(combat), /effect failed/);
  assert.deepEqual(actor.system.exploration, []);
  assert.deepEqual(actor.flags.clearReceipt.clearedIds, ["custom"]);
  actor.deleteEmbeddedDocuments = remove;
  await handoff.initiativeRecorded(combat);
  assert.equal(actor.items.some(item => item.id === "marker"), false);
});

test("cleanup stops after authority or participant changes while saving the snapshot", async () => {
  for (const change of ["gm", "participant", "initiative"]) {
    const { actor, combat } = fixture({ ids: ["custom"], initiatives: [0] });
    const save = combat.setFlag;
    combat.setFlag = async (...args) => {
      await save(...args);
      if (change === "gm") game.user.isActiveGM = false;
      if (change === "participant") combat.combatants.splice(0);
      if (change === "initiative") combat.combatants[0].initiative = null;
    };
    if (change === "gm") await assert.rejects(handoff.initiativeRecorded(combat), /active GM/);
    else await handoff.initiativeRecorded(combat);
    assert.deepEqual(actor.system.exploration, ["custom"]);
    assert.equal(actor.flags.clearReceipt, undefined);
  }
});

test("automatic wrappers register MIXED because they can resolve without calling native methods",()=>{
  const registrations=[];
  globalThis.libWrapper={register(...args){registrations.push(args);}};
  automatic.registerAutomatic();
  assert.deepEqual(registrations,[
    [ID,"CONFIG.Combat.documentClass.prototype.startCombat",startCombat,"MIXED"],
    [ID,"CONFIG.Combat.documentClass.prototype.rollInitiative",trackerInitiative,"MIXED"],
    [ID,"CONFIG.Combat.documentClass.prototype.setInitiative",automatic.recordedInitiative,"WRAPPER"]
  ]);
});

test("alternate version numbers allow automatic handoff", async () => {
  const { actor, combat } = fixture();
  game.release = { generation: 15, build: 1 };
  game.system.version = "9.0.0";
  assert.equal(await startCombat.call(combat, () => assert.fail("native fallback")), combat);
  assert.equal(combat.started, true);
  assert.deepEqual(actor.system.exploration, []);
  assert.deepEqual(actor.flags.clearReceipt.clearedIds, ["scout", "defend", "avoid"]);
});

test("another game system refuses automatic handoff before capture", async () => {
  const { actor, combat } = fixture();
  game.system.id = "other";
  await assert.rejects(startCombat.call(combat, () => assert.fail("native fallback")), /active GM/);
  assert.deepEqual(combat.flags, {});
  assert.deepEqual(actor.system.exploration, ["scout", "defend", "avoid"]);
});

for (const missing of ["refresh", "sound", "hooks", "shield"]) test(`missing ${missing} API refuses automatic handoff before capture`, async () => {
  const { actor, combat, calls } = fixture();
  if (missing === "refresh") delete foundry.documents.ActiveEffect.registry.refresh;
  if (missing === "sound") delete combat._playCombatSound;
  if (missing === "hooks") delete Hooks.events;
  if (missing === "shield") delete game.pf2e.actions.raiseAShield;
  await assert.rejects(startCombat.call(combat, () => assert.fail("native fallback")), /requires.*API/);
  assert.deepEqual(combat.flags, {});
  assert.deepEqual(actor.system.exploration, ["scout", "defend", "avoid"]);
  assert.equal(calls.length, 0);
});

test("Begin automatically prepares strongest Scout, preserves zero, rolls only missing with Stealth, clears then normalizes Defend", async () => {
  const {actor,combat,calls,effects} = fixture({initiatives:[0,null],incredible:true});
  combat.combatants[0].flags.pf2e.initiativeStatistic = "stealth";
  const result = await startCombat.call(combat, () => assert.fail("native fallback"));
  assert.equal(result,combat);
  assert.deepEqual(combat.combatants.map(c=>c.initiative),[0,14]);
  assert.deepEqual(calls.find(c=>c[0]==="stealth"),["stealth","stealth",true,false,[INCREDIBLE_SCOUT]]);
  assert.equal(actor.system.initiative.statistic,"perception");
  assert.deepEqual(actor.flags.clearReceipt,{combatUuid:"Combat.test",clearedIds:["scout","defend","avoid"],phase:"cleared"});
  assert.deepEqual(calls.find(c=>c[0]==="round"),["round",{round:1,turn:0},[]]);
  assert.deepEqual(effects,[{"system.duration.value":0,"system.duration.unit":"rounds","system.duration.expiry":"turn-start","system.start.value":123,"system.start.initiative":14}]);
  assert.ok(calls.findIndex(c=>c[0]==="clear") < calls.findIndex(c=>c[0]==="raise"));
});

test("ordinary initiative assigned while Stealth is pending is preserved", async () => {
  const {actor,combat,calls} = fixture({initiatives:[null,null,null],ids:["avoid"]});
  combat.combatants[0].actor = {type:"npc"};
  combat.combatants[2].actor = {type:"npc"};
  const gate=deferred(),entered=deferred();
  actor.initiative.constructor.prototype.roll=async()=>{entered.release();await gate.promise;return {roll:{total:14}};};
  const pending=startCombat.call(combat,()=>assert.fail("unexpected fallback"));
  await entered.promise;
  combat.combatants[0].initiative=99;
  gate.release();
  await pending;
  assert.deepEqual(combat.combatants.map(c=>c.initiative),[99,14,8]);
  assert.deepEqual(calls.find(c=>c[0]==="ordinary"),["ordinary",["c2"],{skipDialog:true}]);
});

for(const initiative of [0,99]) test(`Stealth initiative assigned to ${initiative} while its roll is pending is preserved`, async () => {
  const {actor,combat,calls} = fixture({ids:["avoid"]});
  const gate=deferred(),entered=deferred();
  actor.initiative.constructor.prototype.roll=async()=>{entered.release();await gate.promise;return {roll:{total:14}};};
  const pending=startCombat.call(combat,()=>assert.fail("unexpected fallback"));
  await entered.promise;
  combat.combatants[0].initiative=initiative;
  combat.combatants[0].flags.pf2e.initiativeStatistic="stealth";
  gate.release();
  await pending;
  assert.equal(combat.combatants[0].initiative,initiative);
  assert.equal(calls.some(c=>c[0]==="initiative"),false);
});

test("Scout prepares unrolled allies before native initiative and respects stronger existing effects and opponents", async () => {
  const {actor,combat,calls} = fixture({ids:["scout","avoid"],incredible:true});
  await startCombat.call(combat,()=>assert.fail());
  assert.deepEqual(calls.find(c=>c[0]==="stealth").at(-1),[INCREDIBLE_SCOUT]);
  const next=fixture({ids:["scout"]});
  next.actor.items.push({type:"effect",sourceId:INCREDIBLE_SCOUT,system:{slug:"effect-scout-incredible-scout"}});
  await trackerInitiative.call(next.combat,async()=>"rolled");
  assert.equal(next.actor.items.filter(i=>i.type==="effect").length,1);
  next.actor.alliance="opposition";
  next.actor.items.pop();
  assert.equal(await trackerInitiative.call(next.combat,async()=>"rolled"),"rolled");
  assert.equal(next.actor.items.filter(i=>i.type==="effect").length,0);
});

test("native Hooks ignores promises but Begin waits for late readers, dispatches once, restores identity and deduplicates starts", async () => {
  const {actor,combat,calls} = fixture({ids:["defend"],initiatives:[0]});
  const gate=deferred(), entered=deferred();
  const order=[];
  const original=async(c,data)=>{order.push("reader"); data.turn=2; entered.release(); await gate.promise; order.push([...actor.system.exploration]);};
  const entry=Hooks.on("combatStart",original,true);
  Hooks.on("combatStart",()=>order.push("second"));
  const first=startCombat.call(combat,()=>assert.fail());
  const duplicate=startCombat.call(combat,()=>assert.fail());
  assert.equal(first,duplicate);
  await entered.promise;
  assert.deepEqual(actor.system.exploration,["defend"]);
  assert.equal(combat.started,false);
  assert.equal(entry.fn,original);
  assert.equal(Hooks.events.combatStart.length,1);
  gate.release();
  await first;
  assert.deepEqual(order,["reader","second",["defend"]]);
  assert.equal(calls.filter(c=>c[0]==="hooks").length,1);
  assert.deepEqual(calls.find(c=>c[0]==="round"),["round",{round:1,turn:2},[]]);
});

for(const failure of ["sync","async"]) test(`${failure} callback failure settles readers, clears replay and preserves recovery and round`,async()=>{
  const {actor,combat,nativeErrors}=fixture({initiatives:[0],ids:["scout"]});
  const gate=deferred(),entered=deferred();let late;
  Hooks.on("combatStart",()=>{if(failure==="sync")throw Error("reader failed");return Promise.reject(Error("reader failed"));});
  Hooks.on("combatStart",async()=>{entered.release();await gate.promise;late=[...actor.system.exploration];});
  const pending=startCombat.call(combat,()=>assert.fail());
  const rejected=assert.rejects(pending,/Encounter automation failed/);
  await entered.promise;
  assert.equal(combat.started,false);
  gate.release();await rejected;
  assert.deepEqual(late,["scout"]);
  assert.deepEqual(actor.system.exploration,[]);
  assert.deepEqual(actor.flags.clearReceipt.clearedIds,["scout"]);
  assert.equal(nativeErrors.length,failure==="sync"?1:0);
});

test("collector preserves native return and receiver, ignores another combat, and does not overwrite replacement functions",async()=>{
  const {combat}=fixture();const other={id:"other"};let receiver;const returns=[];
  const original=function(c){receiver=this;if(c===combat){Hooks.callAll("combatStart",other);return 17;}return 23;};
  const entry=Hooks.on("combatStart",original);
  const observer=Hooks.on("combatStart",()=>{});
  const replacement=()=>{};
  observer.fn=()=>{observer.fn=replacement;returns.push(entry.fn(other));};
  await dispatchCombatStart(combat,{});
  assert.equal(entry.fn,original);assert.equal(observer.fn,replacement);assert.equal(receiver,entry);assert.deepEqual(returns,[23]);
});

test("native fallbacks and ownership conflicts preserve documents",async()=>{
  const {combat,actor}=fixture();game.user.isActiveGM=false;
  assert.equal(startCombat.call(combat,()=>"native"),"native");
  game.user.isActiveGM=true;game.modules.set("pf2e-avoid-notice",{active:true});game.settings.get=(module,key)=>module===ID?"automatic":true;
  await assert.rejects(startCombat.call(combat,()=>assert.fail()),/raiseShields/);
  assert.deepEqual(actor.system.exploration,["scout","defend","avoid"]);assert.deepEqual(combat.flags,{});
});

test("existing raised shield is normalized without toggling; invalid shield warns; changed selections and NPCs are retained",async()=>{
  const {actor,combat,calls,effects}=fixture({initiatives:[2],ids:["defend"]});
  actor.items.push({type:"effect",sourceId:SHIELD,async update(data){effects.push(data);}});
  combat.combatants.push({id:"npc",initiative:null,actor:{type:"npc"}});
  Hooks.on("combatStart",()=>{actor.system.exploration=["scout"];});
  await startCombat.call(combat,()=>assert.fail());
  assert.deepEqual(actor.system.exploration,["scout"]);assert.equal(calls.some(c=>c[0]==="raise"),false);assert.equal(effects[0]["system.duration.value"],0);
  assert.equal(combat.combatants[1].actor.type,"npc");
  const next=fixture({initiatives:[1],ids:["defend"]});next.actor.heldShield.isBroken=true;
  await startCombat.call(next.combat,()=>assert.fail());
  assert.equal(next.calls.find(c=>c[0]==="warn")[1],"Hero cannot Defend without a usable held shield.");
});

test("native round update failure propagates with recoverable receipt",async()=>{
  const {actor,combat}=fixture({initiatives:[0],ids:["scout"]});combat.update=async()=>{throw Error("disk failed");};
  await assert.rejects(startCombat.call(combat,()=>assert.fail()),/disk failed/);
  assert.deepEqual(actor.flags.clearReceipt,{combatUuid:combat.uuid,clearedIds:["scout"],phase:"cleared"});assert.equal(combat.started,false);
});

test("duplicate Begin during the final native refresh shares the pending start",async()=>{
  const {combat,calls}=fixture({initiatives:[0],ids:[]});
  const gate=deferred(),entered=deferred();
  foundry.documents.ActiveEffect.registry.refresh=async()=>{entered.release();await gate.promise;};
  const first=startCombat.call(combat,()=>assert.fail("unexpected fallback"));
  await entered.promise;
  assert.equal(combat.started,true);
  const duplicate=startCombat.call(combat,()=>assert.fail("duplicate fallback"));
  assert.equal(duplicate,first);
  gate.release();
  assert.equal(await duplicate,combat);
  assert.equal(calls.filter(c=>c[0]==="hooks").length,1);
});

test("adding an Avoid Notice combatant automatically records Stealth without changing its saved default",async()=>{
  const {actor,combat,calls}=fixture({ids:["avoid"]});
  await automatic.addedCombatant(combat.combatants[0]);
  assert.equal(combat.combatants[0].initiative,14);
  assert.equal(combat.combatants[0].flags.pf2e.initiativeStatistic,"stealth");
  assert.equal(actor.system.initiative.statistic,"perception");
  assert.deepEqual(actor.system.exploration,[]);
  assert.equal(combat.started,false);
  assert.equal(calls.some(c=>c[0]==="clear"),true);
});

test("Begin replaces an existing Perception roll with Scout-prepared Stealth",async()=>{
  const {combat,calls}=fixture({initiatives:[22],ids:["scout","avoid"]});
  await startCombat.call(combat,()=>assert.fail());
  assert.equal(combat.combatants[0].initiative,14);
  assert.equal(combat.combatants[0].flags.pf2e.initiativeStatistic,"stealth");
  assert.deepEqual(calls.find(c=>c[0]==="stealth").at(-1),[SCOUT]);
});

test("tracker roll routes requested Avoid Notice combatants through Stealth and leaves ordinary IDs native",async()=>{
  const {actor,combat,calls}=fixture({initiatives:[20,null],ids:["avoid"]});
  combat.combatants[1].actor={type:"npc"};
  const options={skipDialog:false,secret:true,extraRollOptions:["custom"],messageOptions:{messageMode:"blindroll"}};
  const native=[];
  const result=await trackerInitiative.call(combat,async(...args)=>{native.push(args);return combat;},["c0","c1"],options);
  assert.equal(result,combat);
  assert.deepEqual(native,[[["c1"],options]]);
  assert.equal(combat.combatants[0].flags.pf2e.initiativeStatistic,"stealth");
  assert.equal(calls.find(c=>c[0]==="stealth")[2],false);
  assert.deepEqual(actor.lastRollOptions.extraRollOptions,["custom","secret"]);
  assert.equal(actor.lastRollOptions.messageMode,"blindroll");
  assert.equal(actor.lastRollOptions.updateTracker,false);
  assert.deepEqual(options.extraRollOptions,["custom"]);
});

test("explicit tracker reroll replaces recorded Stealth zero and native cancellation preserves it",async()=>{
  const {actor,combat,calls}=fixture({initiatives:[0],ids:["avoid"]});
  combat.combatants[0].flags.pf2e.initiativeStatistic="stealth";
  assert.equal(await trackerInitiative.call(combat,()=>assert.fail(),["c0"],{skipDialog:true}),combat);
  assert.equal(combat.combatants[0].initiative,14);
  actor.initiative.constructor.prototype.roll=async()=>null;
  await trackerInitiative.call(combat,()=>assert.fail(),["c0"]);
  assert.equal(combat.combatants[0].initiative,14);
  assert.equal(calls.filter(c=>c[0]==="initiative").length,1);
});

test("overlapping add and Begin share one Stealth roll and await its recorded result",async()=>{
  const {actor,combat,calls}=fixture({ids:["avoid"]});
  const gate=deferred(),entered=deferred();let rolls=0;
  actor.initiative.constructor.prototype.roll=async()=>{rolls++;entered.release();await gate.promise;return {roll:{total:17}};};
  const add=automatic.addedCombatant(combat.combatants[0]);
  await entered.promise;
  const begin=startCombat.call(combat,()=>assert.fail());
  await Promise.resolve();
  assert.equal(combat.started,false);
  gate.release();
  await Promise.all([add,begin]);
  assert.equal(rolls,1);
  assert.equal(combat.combatants[0].initiative,17);
  assert.equal(calls.filter(c=>c[0]==="initiative").length,1);
  assert.equal(combat.started,true);
});

for(const change of ["removed","activity","actor","started","GM","mode","deleted"]) test(`add discards pending Stealth after ${change} changes`,async()=>{
  const {actor,combat,calls}=fixture({ids:["avoid"]});
  const c=combat.combatants[0],gate=deferred(),entered=deferred();
  actor.initiative.constructor.prototype.roll=async()=>{entered.release();await gate.promise;return {roll:{total:19}};};
  const pending=automatic.addedCombatant(c);
  await entered.promise;
  if(change==="removed")combat.combatants.splice(0,1);
  if(change==="activity")actor.system.exploration=[];
  if(change==="actor")c.actor={...actor};
  if(change==="started")combat.started=true;
  if(change==="GM")game.user.isActiveGM=false;
  if(change==="mode")game.settings.get=()=>"off";
  if(change==="deleted")game.combats.delete(combat.id);
  gate.release();
  await pending;
  assert.equal(c.initiative,null);
  assert.equal(calls.some(c=>c[0]==="initiative"),false);
});

for(const mode of ["off","review","nonGM","started"]) test(`${mode} leaves added combatants and tracker rolls native`,async()=>{
  const {combat,calls}=fixture({ids:["avoid"]});
  if(mode==="nonGM")game.user.isActiveGM=false;
  else if(mode==="started")combat.started=true;
  else game.settings.get=()=>mode;
  await automatic.addedCombatant(combat.combatants[0]);
  const options={skipDialog:false};let native;
  assert.equal(await trackerInitiative.call(combat,(...args)=>{native=args;return "native";},["c0"],options),"native");
  assert.deepEqual(native,[["c0"],options]);
  assert.equal(calls.length,0);
  assert.equal(combat.combatants[0].initiative,null);
});

test("a Scout selected after automatic Stealth does not retroactively reroll its recorded result",async()=>{
  const {actor,combat,calls}=fixture({ids:["avoid"]});
  await automatic.addedCombatant(combat.combatants[0]);
  actor.system.exploration=["scout","avoid"];
  await startCombat.call(combat,()=>assert.fail());
  assert.equal(calls.filter(c=>c[0]==="stealth").length,1);
  assert.equal(actor.items.filter(i=>i.type==="effect").length,0);
  assert.equal(combat.combatants[0].initiative,14);
});

test("Begin prepares Scout before replacing all linked non-Stealth combatants",async()=>{
  const {combat,calls}=fixture({initiatives:[22,10],ids:["scout","avoid"]});
  await startCombat.call(combat,()=>assert.fail());
  assert.deepEqual(combat.combatants.map(c=>c.flags.pf2e.initiativeStatistic),["stealth","stealth"]);
  assert.deepEqual(calls.filter(c=>c[0]==="stealth").map(c=>c.at(-1)),[[SCOUT],[SCOUT]]);
});

test("an explicit tracker request waits for an automatic add then performs its requested reroll",async()=>{
  const {actor,combat}=fixture({ids:["avoid"]});
  const gate=deferred(),entered=deferred(),options=[];
  actor.initiative.constructor.prototype.roll=async rollOptions=>{
    options.push(rollOptions);
    if(options.length===1){entered.release();await gate.promise;}
    return {roll:{total:options.length===1?14:18}};
  };
  const add=automatic.addedCombatant(combat.combatants[0]);
  await entered.promise;
  const reroll=trackerInitiative.call(combat,()=>assert.fail(),["c0"],{skipDialog:false,secret:true});
  gate.release();
  await Promise.all([add,reroll]);
  assert.equal(options.length,2);
  assert.equal(options[1].skipDialog,false);
  assert.deepEqual(options[1].extraRollOptions,["secret"]);
  assert.equal(combat.combatants[0].initiative,18);
});

test("Begin waits for a tracker reroll queued behind the automatic add before clearing selections",async()=>{
  const {actor,combat}=fixture({ids:["avoid"]});
  const addGate=deferred(),addEntered=deferred(),rerollGate=deferred(),rerollEntered=deferred();let rolls=0;
  actor.initiative.constructor.prototype.roll=async()=>{
    const current=++rolls;
    if(current===1){addEntered.release();await addGate.promise;}
    else{rerollEntered.release();await rerollGate.promise;}
    return {roll:{total:current===1?14:18}};
  };
  const add=automatic.addedCombatant(combat.combatants[0]);
  await addEntered.promise;
  const begin=startCombat.call(combat,()=>assert.fail());
  await new Promise(resolve=>setImmediate(resolve));
  const reroll=trackerInitiative.call(combat,()=>assert.fail(),["c0"],{skipDialog:false});
  await new Promise(resolve=>setImmediate(resolve));
  addGate.release();
  await rerollEntered.promise;
  await new Promise(resolve=>setImmediate(resolve));
  const startedWhileRerollPending=combat.started;
  const selectionWhileRerollPending=[...actor.system.exploration];
  rerollGate.release();
  await Promise.all([add,begin,reroll]);
  assert.equal(startedWhileRerollPending,false);
  assert.deepEqual(selectionWhileRerollPending,[]);
  assert.equal(combat.combatants[0].initiative,18);
  assert.equal(rolls,2);
  assert.equal(combat.started,true);
});

for(const failure of [false,true]) test(`tracker rolls are rejected during encounter callbacks and unlocked after ${failure?"failure":"success"}`,async()=>{
  const {actor,combat,calls}=fixture({ids:["avoid"]});
  const gate=deferred(),entered=deferred();let detected;
  Hooks.on("combatStart",async()=>{
    detected=combat.combatants[0].initiative;
    entered.release();await gate.promise;
    if(failure)throw Error("reader failed");
  });
  const begin=startCombat.call(combat,()=>assert.fail());
  const completed=begin.then(()=>null,error=>error);
  await entered.promise;
  actor.initiative.constructor.prototype.roll=async()=>({roll:{total:18}});
  const rejected=await trackerInitiative.call(combat,()=>assert.fail(),["c0"],{skipDialog:false})
    .then(()=>false,error=>/Begin Encounter.*resolving/.test(error.message));
  const late={id:"late",actor,initiative:null,parent:combat};
  combat.combatants.push(late);
  await automatic.addedCombatant(late);
  assert.equal(late.initiative,null);
  combat.combatants.pop();
  const during={initiative:combat.combatants[0].initiative,selection:[...actor.system.exploration]};
  gate.release();
  const error=await completed;
  assert.equal(rejected,true);
  assert.deepEqual(during,{initiative:14,selection:["avoid"]});
  assert.equal(detected,14);
  assert.equal(calls.filter(c=>c[0]==="initiative").length,1);
  if(failure){
    assert.match(error.message,/Encounter automation failed/);
    await trackerInitiative.call(combat,()=>assert.fail(),["c0"]);
    assert.equal(combat.combatants[0].initiative,18);
  }else{
    assert.equal(error,null);
    assert.equal(await trackerInitiative.call(combat,()=>"native",["c0"]),"native");
  }
});

test("a failed automatic Stealth roll can be retried without clearing exploration",async()=>{
  const {actor,combat}=fixture({ids:["avoid"]});
  actor.initiative.constructor.prototype.roll=async()=>null;
  await assert.rejects(automatic.addedCombatant(combat.combatants[0]),/Initiative did not complete/);
  assert.deepEqual(actor.system.exploration,["avoid"]);
  actor.initiative.constructor.prototype.roll=async()=>({roll:{total:16}});
  await automatic.addedCombatant(combat.combatants[0]);
  assert.equal(combat.combatants[0].initiative,16);
});
