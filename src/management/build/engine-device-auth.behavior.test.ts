import assert from "node:assert/strict";
import { authorizeEngineDeviceRecord } from "../../lib/engine-device-auth";

const now=new Date("2026-09-20T12:00:00.000Z"),future=new Date(now.getTime()+120000),past=new Date(now.getTime()-1);
const record=(o:any={})=>({id:"dev-a",userId:"user-1",machineId:"pc-a",revokedAt:null,leaseUntil:future,user:{activeEngineMachineId:"pc-a",engineLeaseUntil:future},...o});
assert.deepEqual(authorizeEngineDeviceRecord(record(),now),{deviceId:"dev-a",userId:"user-1",machineId:"pc-a"});
assert.equal(authorizeEngineDeviceRecord(null,now),null);
assert.equal(authorizeEngineDeviceRecord(record({revokedAt:now}),now),null);
assert.equal(authorizeEngineDeviceRecord(record({leaseUntil:past}),now),null);
assert.equal(authorizeEngineDeviceRecord(record({leaseUntil:now}),now),null);
assert.equal(authorizeEngineDeviceRecord(record({user:{activeEngineMachineId:"pc-a",engineLeaseUntil:past}}),now),null);
assert.equal(authorizeEngineDeviceRecord(record({user:{activeEngineMachineId:"pc-a",engineLeaseUntil:now}}),now),null);
assert.equal(authorizeEngineDeviceRecord(record({user:{activeEngineMachineId:"pc-b",engineLeaseUntil:future}}),now),null);
const pcB=record({id:"dev-b",machineId:"pc-b",user:{activeEngineMachineId:"pc-b",engineLeaseUntil:future}});
assert.equal(authorizeEngineDeviceRecord(record({user:{activeEngineMachineId:"pc-b",engineLeaseUntil:future}}),now),null);
assert.deepEqual(authorizeEngineDeviceRecord(pcB,now),{deviceId:"dev-b",userId:"user-1",machineId:"pc-b"});
console.log("engine device lease authorization behavior: 10/10 checks PASS");
