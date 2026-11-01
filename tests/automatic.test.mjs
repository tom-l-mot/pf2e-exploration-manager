import test from "node:test";
import assert from "node:assert/strict";
import { ID, SCOUT, INCREDIBLE_SCOUT } from "../scripts/handoff.js";
import { startCombat, dispatchCombatStart, SHIELD, trackerInitiative } from "../scripts/automatic.js";
import * as automatic from "../scripts/automatic.js";

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
    async update(data) { calls.push(["clear"]); actor.system.exploration = data["system.exploration"]; actor.flags.clearReceipt = data[`flags.${ID}.clearReceipt`]; },
    async createEmbeddedDocuments(_type, data) { items.push(...data); }
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
  assert.deepEqual(calls.find(c=>c[0]==="stealth"),["stealth","stealth",true,false,[]]);
  assert.equal(actor.system.initiative.statistic,"perception");
  assert.deepEqual(actor.flags.clearReceipt,{combatUuid:"Combat.test",clearedIds:["scout","defend","avoid"]});
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

for(const failure of ["sync","async"]) test(`${failure} callback failure settles other readers before rejecting and preserves selections and round`,async()=>{
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
  assert.deepEqual(actor.system.exploration,["scout"]);
  assert.equal(actor.flags.clearReceipt,undefined);
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
  assert.deepEqual(actor.flags.clearReceipt,{combatUuid:combat.uuid,clearedIds:["scout"]});assert.equal(combat.started,false);
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
  assert.deepEqual(actor.system.exploration,["avoid"]);
  assert.equal(combat.started,false);
  assert.equal(calls.some(c=>c[0]==="clear"),false);
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

test("a failed automatic Stealth roll can be retried without clearing exploration",async()=>{
  const {actor,combat}=fixture({ids:["avoid"]});
  actor.initiative.constructor.prototype.roll=async()=>null;
  await assert.rejects(automatic.addedCombatant(combat.combatants[0]),/Initiative did not complete/);
  assert.deepEqual(actor.system.exploration,["avoid"]);
  actor.initiative.constructor.prototype.roll=async()=>({roll:{total:16}});
  await automatic.addedCombatant(combat.combatants[0]);
  assert.equal(combat.combatants[0].initiative,16);
});
