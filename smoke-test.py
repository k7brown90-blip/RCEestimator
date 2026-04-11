#!/usr/bin/env python3
"""End-to-end atomic item smoke test."""
import json
import urllib.request
import urllib.error

BASE = "http://localhost:4000"

def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data,
                                  headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"ERROR {e.code} on POST {path}: {e.read().decode()}")
        raise

def get(path):
    with urllib.request.urlopen(f"{BASE}{path}") as r:
        return json.loads(r.read())

def patch(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data,
                                  headers={"Content-Type": "application/json"}, method="PATCH")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

print("=== Smoke Test: Atomic Item Flow ===\n")

# 1. Create customer
customer = post("/customers", {"name": "Smoke Test Customer", "email": "smoke@rc.test", "phone": "517-555-9999"})
cid = customer["id"]
print(f"✓ Customer: {cid}")

# 2. Create property
prop = post("/properties", {
    "customerId": cid, "name": "Smoke House",
    "addressLine1": "123 Main St", "city": "Lansing", "state": "MI", "postalCode": "48912"
})
pid = prop["id"]
print(f"✓ Property: {pid}")

# 3. Create visit
visit = post("/visits", {
    "customerId": cid, "propertyId": pid, "mode": "remodel", "purpose": "Smoke test"
})
vid = visit["id"]
print(f"✓ Visit: {vid}")

# 4. Create estimate
est = post("/estimates", {"visitId": vid, "propertyId": pid, "title": "Smoke Atomic Estimate"})
eid = est.get("estimate", {}).get("id") or est.get("id")
print(f"✓ Estimate: {eid}")

# 5. Create option
opt = post(f"/estimates/{eid}/options", {"optionLabel": "Option A"})
oid = opt.get("option", {}).get("id") or opt.get("id")
print(f"✓ Option: {oid}")

# 6. Add a 20A circuit (NM-B 12/2 should be resolved)
item_resp = post(f"/estimates/{eid}/options/{oid}/items", {
    "atomicUnitCode": "CIR-001",
    "quantity": 1,
    "circuitVoltage": 120,
    "circuitAmperage": 20,
    "environment": "interior",
    "exposure": "concealed",
    "cableLength": 24,
    "modifiers": [
        {"modifierType": "ACCESS", "modifierValue": "normal", "laborMultiplier": 1.0, "materialMult": 1.0},
        {"modifierType": "CONDITION", "modifierValue": "retrofit", "laborMultiplier": 1.0, "materialMult": 1.0}
    ]
})
print(f"\n✓ EstimateItem created:")
item = item_resp["item"]
print(f"  atomicUnit: {item.get('atomicUnitId','?')}")
print(f"  resolvedWiringMethod: {item.get('resolvedWiringMethod','?')}")
print(f"  resolvedCableCode: {item.get('resolvedCableCode','?')}")
print(f"  cableLaborHrs: {item.get('resolvedCableLaborHrs','?')}")
print(f"  laborCost: {item.get('laborCost','?')}")
print(f"  materialCost: {item.get('materialCost','?')}")
print(f"  totalCost: {item.get('totalCost','?')}")
print(f"  suggestEndpoint: {item_resp.get('suggestEndpoint','?')}")

# 7. Add a device (receptacle) — no cable
dev_resp = post(f"/estimates/{eid}/options/{oid}/items", {
    "atomicUnitCode": "DEV-001",
    "quantity": 2,
    "environment": "interior",
    "exposure": "concealed",
    "modifiers": []
})
print(f"\n✓ Device item:")
dev = dev_resp["item"]
print(f"  laborCost: {dev.get('laborCost','?')}")
print(f"  materialCost: {dev.get('materialCost','?')}")
print(f"  totalCost: {dev.get('totalCost','?')}")

# 8. Get all items
items = get(f"/estimates/{eid}/options/{oid}/items")
print(f"\n✓ Items count: {len(items)}")

# 9. Run NEC check
nec = post(f"/estimates/{eid}/nec-check", {})
print(f"\n✓ NEC check alerts: {len(nec.get('alerts', []))}")
for a in nec.get('alerts', []):
    print(f"  [{a['severity']}] {a['ruleCode']}: {a['promptText'][:60]}")

# 10. Generate support items
support = post(f"/estimates/{eid}/support-items/generate", {})
print(f"\n✓ Support items generated: {len(support.get('supportItems', []))}")
for s in support.get('supportItems', []):
    print(f"  {s['supportType']}: ${s['totalCost']:.2f}")

print("\n=== All checks passed ===")
