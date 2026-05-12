# Red Cedar Electric — Catalog Pricing Worksheet

_Auto-generated 2026-05-12 by `scripts/buildPricingWorksheet.ts`. 120 row(s) need landed costs._

## How to use

1. Fill the **Landed Cost (USD)** column with your real contractor-cost numbers (per-unit, contractor pack basis where applicable).
2. Propagate the values back into the source CSV in `app/<catalog>_catalog.csv` — column 6 (`materialCost`).
3. Remove the trailing `PRICE TBD.` token from the description column.
4. Re-run the seed: `cd app && npx tsx scripts/seedAtomicUnits.ts`. The seed will refuse to complete while any `PRICE TBD` row remains active.
5. After seeding, run `scripts/refreshDraftItemSnapshots.ts` to backfill `EstimateItem.materialCost` on any draft/review estimates that already reference these codes.

Notes:
- TRIM-D## and TRIM-T## entries duplicate across `new_work` and `old_work`. Price both rows with the same per-unit cost — labor differs, material does not.
- TRIM-ASD## fixtures are contractor-provided by ASD Lighting. Use the per-unit cost out of the carton (case price ÷ qty).
- DIAG-001 is the diagnostic hourly billable rate — enter the full billable rate (not landed cost).

## new_work

### TRIM

| Code | Name | Unit | Labor (hrs) | Landed Cost (USD) | Source / Reference |
|------|------|------|-------------|-------------------|---------------------|
| `TRIM-018` | Standard Light Fixture — Hang + Connect (Client-Supplied) | EA | 0.30 | _$ TBD_ | Hang homeowner/client-supplied light fixture and make wire connections. Fixture material not included. |
| `TRIM-019` | Ceiling Fan — Assemble + Hang + Connect (Client-Supplied) | EA | 0.75 | _$ TBD_ | Assemble and hang homeowner/client-supplied ceiling fan. Fan material not included. |
| `TRIM-022` | Vanity / Wall Sconce — Hang + Connect (Client-Supplied) | EA | 0.25 | _$ TBD_ | Hang homeowner/client-supplied vanity or sconce and connect. Fixture not included. |
| `TRIM-023` | Exterior Light Fixture — Mount + Connect (Client-Supplied) | EA | 0.30 | _$ TBD_ | Mount homeowner/client-supplied exterior fixture and connect. Fixture not included. |
| `TRIM-024` | Under-Cabinet Light — Mount + Connect (Client-Supplied) | EA | 0.20 | _$ TBD_ | Mount homeowner/client-supplied under-cabinet light and connect. |
| `TRIM-025` | Bathroom Exhaust Fan — Mount + Connect (Client-Supplied) | EA | 0.50 | _$ TBD_ | Mount homeowner/client-supplied exhaust fan and connect. Duct not included. |
| `TRIM-026` | Chandelier — Assemble + Hang + Connect (Client-Supplied) | EA | 1.00 | _$ TBD_ | Assemble and hang homeowner/client-supplied chandelier. Fixture not included. |
| `TRIM-028` | Thermostat — Install + Connect | EA | 0.25 | _$ TBD_ | Mount and connect customer-supplied thermostat. |
| `TRIM-029` | EV Charger (EVSE) — Mount + Connect | EA | 1.00 | _$ TBD_ | Mount and connect customer-supplied EV charger. Unit not included. |
| `TRIM-034` | Baseboard Heater — Mount + Connect | EA | 0.40 | _$ TBD_ | Mount and connect customer-supplied baseboard heater. Heater not included. |
| `TRIM-D01` | 15A Decora Receptacle (TR) + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A tamper-resistant Decora receptacle and Decora wall plate. Ref: Leviton T5325-WMP (10-pk). |
| `TRIM-D02` | 20A Decora Receptacle (TR) + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 20A tamper-resistant Decora receptacle and Decora wall plate. Ref: Leviton T5820-WMP (10-pk). |
| `TRIM-D03` | 15A GFCI Decora Receptacle + Decora Plate — Install | EA | 0.20 | _$ TBD_ | Install 15A GFCI Decora receptacle and plate. Wire and test. Ref: Leviton GFNT1-W or 3-pack GFNT1-3W. |
| `TRIM-D04` | 20A GFCI Decora Receptacle + Decora Plate — Install | EA | 0.20 | _$ TBD_ | Install 20A GFCI Decora receptacle and plate. Wire and test. Ref: Leviton GFNT2-W. |
| `TRIM-D05` | 15A Single-Pole Decora Switch + Decora Plate — Install | EA | 0.12 | _$ TBD_ | Install 15A single-pole Decora rocker switch and plate. Ref: Leviton 5601-2WM (10-pk). |
| `TRIM-D06` | 15A 3-Way Decora Switch + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 3-way Decora rocker switch and plate. Ref: Leviton 5603-2WM (10-pk). |
| `TRIM-D07` | 15A 4-Way Decora Switch + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 4-way Decora rocker switch and plate. |
| `TRIM-D08` | 20A Single-Pole Decora Switch + Decora Plate — Install | EA | 0.12 | _$ TBD_ | Install 20A single-pole Decora rocker switch and plate. Ref: Leviton 5621-2W. |
| `TRIM-T01` | 15A Standard Duplex Receptacle (TR) + Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A tamper-resistant standard duplex receptacle and plate. Ref: Leviton 5320-WCP (10-pk) / Eaton TR270W-10P (10-pk). |
| `TRIM-T02` | 20A Standard Duplex Receptacle (TR) + Plate — Install | EA | 0.15 | _$ TBD_ | Install 20A tamper-resistant standard duplex receptacle and plate. Ref: Leviton T5820-WMP (10-pk). |
| `TRIM-T03` | 15A GFCI Receptacle (Standard) + Plate — Install | EA | 0.20 | _$ TBD_ | Install 15A GFCI receptacle (standard body) and plate. Wire and test. |
| `TRIM-T04` | 20A GFCI Receptacle (Standard) + Plate — Install | EA | 0.20 | _$ TBD_ | Install 20A GFCI receptacle (standard body) and plate. Wire and test. |
| `TRIM-T05` | 15A Single-Pole Toggle Switch + Plate — Install | EA | 0.12 | _$ TBD_ | Install 15A single-pole toggle switch and plate. Ref: Leviton 1451-2WM (10-pk) / Eaton 1301-7W-10P (10-pk). |
| `TRIM-T06` | 15A 3-Way Toggle Switch + Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 3-way toggle switch and plate. Ref: Leviton 1453-2WM (10-pk) / Eaton 1303-7W-10P (10-pk). |
| `TRIM-T07` | 15A 4-Way Toggle Switch + Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 4-way toggle switch and plate. |
| `TRIM-T08` | 20A Single-Pole Toggle Switch + Plate — Install | EA | 0.12 | _$ TBD_ | Install 20A single-pole toggle switch and plate. Ref: Leviton 1221-2W. |

### TRIM-ASD

| Code | Name | Unit | Labor (hrs) | Landed Cost (USD) | Source / Reference |
|------|------|------|-------------|-------------------|---------------------|
| `TRIM-ASD01` | ASD 4 in Recessed LED Wafer 9W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 4 in 9W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-4D9WH-12P. Contractor provided (ASD). |
| `TRIM-ASD02` | ASD 4 in Recessed LED Wafer 12W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 4 in 12W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-4D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD03` | ASD 6 in Recessed LED Wafer 12W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 6 in 12W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-6D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD04` | ASD 6 in Recessed LED Wafer 15W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 6 in 15W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-6D15WH-12P. Contractor provided (ASD). |
| `TRIM-ASD05` | ASD 4 in Baffle Wafer 9W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBRB 4 in 9W baffle trim canless LED. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBRB-4D9WH-12P. Contractor provided (ASD). |
| `TRIM-ASD06` | ASD 6 in Baffle Wafer 12W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBRB 6 in 12W baffle trim canless LED. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBRB-6D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD07` | ASD 4 in Square Wafer 10W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBS 4 in 10W square canless LED. 5CCT selectable. CRI 90+. Contractor provided (ASD). |
| `TRIM-ASD08` | ASD 6 in Square Wafer 15W (New Work) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBS 6 in 15W square canless LED. 5CCT selectable. CRI 90+. Contractor provided (ASD). |
| `TRIM-ASD09` | ASD 4 in Retrofit Downlight 10W (Retrofit) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LRKR 4 in 10W retrofit kit into existing 4 in can. 5CCT. CRI 90+. E26+TP24 connectors. 12-pk: ASD-LRKR-M4D10WH-12P. Contractor provided (ASD). |
| `TRIM-ASD10` | ASD 6 in Retrofit Downlight 12W (Retrofit) — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LRKR 6 in 12W retrofit kit into existing 5/6 in can. 5CCT. CRI 90+. E26+TP24 connectors. 12-pk: ASD-LRKR-M6D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD11` | ASD 4 in LED Disk Light 10W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LDS 4 in 10W surface mount disk light. 5CCT. CRI 90+. Wet rated. 12-pk: ASD-LDS-4D10AC-WH-12PACK. Contractor provided (ASD). |
| `TRIM-ASD12` | ASD 6 in LED Disk Light 15W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LDS 6 in 15W surface mount disk light. 5CCT. CRI 90+. Wet rated. 12-pk: ASD-LDS-6D15AC-WH-12PACK. Contractor provided (ASD). |
| `TRIM-ASD13` | ASD 10 in LED Flush Mount (Dbl Ring) 16W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 10 in 16W flush mount ceiling light. 3CCT. Damp rated. ASD-LFMDR-10D16CC-NK. Contractor provided (ASD). |
| `TRIM-ASD14` | ASD 12 in LED Flush Mount (Dbl Ring) 20W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 12 in 20W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-12D20CC-NK. Contractor provided (ASD). |
| `TRIM-ASD15` | ASD 14 in LED Flush Mount (Dbl Ring) 21W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 14 in 21W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-14D21CC-NK. Contractor provided (ASD). |
| `TRIM-ASD16` | ASD 16 in LED Flush Mount (Dbl Ring) 24W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 16 in 24W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-16D24CC-NK. Contractor provided (ASD). |
| `TRIM-ASD17` | ASD 18 in LED Flush Mount (Dbl Ring) 28W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 18 in 28W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-18D28CC-NK. Contractor provided (ASD). |
| `TRIM-ASD18` | ASD 13 in Exterior Sconce 12W (Black) — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 13 in 12W outdoor wall sconce. Seeded glass. 3CCT. IP44 wet rated. ASD-LWS26S-13D12BK. Contractor provided (ASD). |
| `TRIM-ASD19` | ASD 18 in Exterior Sconce 12W (Black) — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 18 in 12W outdoor wall sconce. Seeded glass. 3CCT. IP44 wet rated. ASD-LWS26S-18D12BK. Contractor provided (ASD). |
| `TRIM-ASD20` | ASD 24 in Exterior Sconce 20W (Black) — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 24 in 20W outdoor wall sconce. Seeded glass. 3CCT. Multi-volt. ASD-LWS26S-MV-24D20CC-BK. Contractor provided (ASD). |
| `TRIM-ASD21` | ASD 24 in Exterior Sconce w/ Photocell 12W — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 24 in 12W outdoor sconce with photocell (dusk-to-dawn). ASD-LWS26S-24N12BK-PC. Contractor provided (ASD). |
| `TRIM-ASD22` | ASD Small Wallpack 28W (Bronze) — Mount + Connect | EA | 0.35 | _$ TBD_ | Mount ASD SWP 28W residential wallpack. 3CCT. IP65. 120V. ASD-SWP-28BR-PC. Contractor provided (ASD). |
| `TRIM-ASD23` | ASD Small Wallpack Multi-Volt 28W (Bronze) — Mount + Connect | EA | 0.35 | _$ TBD_ | Mount ASD SWP multi-volt 20/24/28W selectable residential wallpack. 3CCT. IP65. 120-277V. 0-10V dim. ASD-SWP-MV-A28BR-PC. Contractor provided (ASD). |
| `TRIM-ASD24` | ASD LED Flood Light 60W (Black) — Mount + Connect | EA | 0.50 | _$ TBD_ | Mount ASD FL2 15/30/60W selectable flood light. 3CCT. IP65. Photocell. 120-277V. ASD-FL2-60BK-PC-AM or -FL. Contractor provided (ASD). |
| `TRIM-ASD25` | ASD 18 in Vanity Light 20W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 18 in 20W vanity bar light. 3CCT. Damp rated. ASD-LVF21-18D20CC-NK. Contractor provided (ASD). |
| `TRIM-ASD26` | ASD 24 in Vanity Light 25W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 24 in 25W vanity bar light. 3CCT. Damp rated. ASD-LVF21-24D25CC-NK. Contractor provided (ASD). |
| `TRIM-ASD27` | ASD 36 in Vanity Light 30W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 36 in 30W vanity bar light. 3CCT. Damp rated. ASD-LVF21-36D30CC-NK. Contractor provided (ASD). |
| `TRIM-ASD28` | ASD 48 in Vanity Light 35W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 48 in 35W vanity bar light. 3CCT. Damp rated. ASD-LVF21-48D35CC-NK. Contractor provided (ASD). |
| `TRIM-ASD29` | ASD 18 in Under-Cabinet LED 8W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 18 in 8W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-18D8CC-WH. Contractor provided (ASD). |
| `TRIM-ASD30` | ASD 24 in Under-Cabinet LED 12W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 24 in 12W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-24D12CC-WH. Contractor provided (ASD). |
| `TRIM-ASD31` | ASD 32 in Under-Cabinet LED 16W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 32 in 16W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-32D16CC-WH. Contractor provided (ASD). |
| `TRIM-ASD32` | ASD 40 in Under-Cabinet LED 20W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 40 in 20W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-40D20CC-WH. Contractor provided (ASD). |
| `TRIM-ASD33` | ASD 48 in Under-Cabinet LED 24W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 48 in 24W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-48D24CC-WH. Contractor provided (ASD). |

## old_work

### TRIM

| Code | Name | Unit | Labor (hrs) | Landed Cost (USD) | Source / Reference |
|------|------|------|-------------|-------------------|---------------------|
| `TRIM-018` | Standard Light Fixture — Hang + Connect (Client-Supplied) | EA | 0.30 | _$ TBD_ | Hang homeowner/client-supplied light fixture and make wire connections. Fixture material not included. |
| `TRIM-019` | Ceiling Fan — Assemble + Hang + Connect (Client-Supplied) | EA | 0.75 | _$ TBD_ | Assemble and hang homeowner/client-supplied ceiling fan. Fan material not included. |
| `TRIM-022` | Vanity / Wall Sconce — Hang + Connect (Client-Supplied) | EA | 0.25 | _$ TBD_ | Hang homeowner/client-supplied vanity or sconce and connect. Fixture not included. |
| `TRIM-023` | Exterior Light Fixture — Mount + Connect (Client-Supplied) | EA | 0.30 | _$ TBD_ | Mount homeowner/client-supplied exterior fixture and connect. Fixture not included. |
| `TRIM-024` | Under-Cabinet Light — Mount + Connect (Client-Supplied) | EA | 0.20 | _$ TBD_ | Mount homeowner/client-supplied under-cabinet light and connect. |
| `TRIM-025` | Bathroom Exhaust Fan — Mount + Connect (Client-Supplied) | EA | 0.50 | _$ TBD_ | Mount homeowner/client-supplied exhaust fan and connect. Duct not included. |
| `TRIM-026` | Chandelier — Assemble + Hang + Connect (Client-Supplied) | EA | 1.00 | _$ TBD_ | Assemble and hang homeowner/client-supplied chandelier. Fixture not included. |
| `TRIM-028` | Thermostat — Install + Connect | EA | 0.25 | _$ TBD_ | Mount and connect customer-supplied thermostat. |
| `TRIM-029` | EV Charger (EVSE) — Mount + Connect | EA | 1.00 | _$ TBD_ | Mount and connect customer-supplied EV charger. Unit not included. |
| `TRIM-034` | Baseboard Heater — Mount + Connect | EA | 0.40 | _$ TBD_ | Mount and connect customer-supplied baseboard heater. Heater not included. |
| `TRIM-D01` | 15A Decora Receptacle (TR) + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A tamper-resistant Decora receptacle and Decora wall plate. Ref: Leviton T5325-WMP (10-pk). |
| `TRIM-D02` | 20A Decora Receptacle (TR) + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 20A tamper-resistant Decora receptacle and Decora wall plate. Ref: Leviton T5820-WMP (10-pk). |
| `TRIM-D03` | 15A GFCI Decora Receptacle + Decora Plate — Install | EA | 0.20 | _$ TBD_ | Install 15A GFCI Decora receptacle and plate. Wire and test. Ref: Leviton GFNT1-W or 3-pack GFNT1-3W. |
| `TRIM-D04` | 20A GFCI Decora Receptacle + Decora Plate — Install | EA | 0.20 | _$ TBD_ | Install 20A GFCI Decora receptacle and plate. Wire and test. Ref: Leviton GFNT2-W. |
| `TRIM-D05` | 15A Single-Pole Decora Switch + Decora Plate — Install | EA | 0.12 | _$ TBD_ | Install 15A single-pole Decora rocker switch and plate. Ref: Leviton 5601-2WM (10-pk). |
| `TRIM-D06` | 15A 3-Way Decora Switch + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 3-way Decora rocker switch and plate. Ref: Leviton 5603-2WM (10-pk). |
| `TRIM-D07` | 15A 4-Way Decora Switch + Decora Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 4-way Decora rocker switch and plate. |
| `TRIM-D08` | 20A Single-Pole Decora Switch + Decora Plate — Install | EA | 0.12 | _$ TBD_ | Install 20A single-pole Decora rocker switch and plate. Ref: Leviton 5621-2W. |
| `TRIM-T01` | 15A Standard Duplex Receptacle (TR) + Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A tamper-resistant standard duplex receptacle and plate. Ref: Leviton 5320-WCP (10-pk) / Eaton TR270W-10P (10-pk). |
| `TRIM-T02` | 20A Standard Duplex Receptacle (TR) + Plate — Install | EA | 0.15 | _$ TBD_ | Install 20A tamper-resistant standard duplex receptacle and plate. Ref: Leviton T5820-WMP (10-pk). |
| `TRIM-T03` | 15A GFCI Receptacle (Standard) + Plate — Install | EA | 0.20 | _$ TBD_ | Install 15A GFCI receptacle (standard body) and plate. Wire and test. |
| `TRIM-T04` | 20A GFCI Receptacle (Standard) + Plate — Install | EA | 0.20 | _$ TBD_ | Install 20A GFCI receptacle (standard body) and plate. Wire and test. |
| `TRIM-T05` | 15A Single-Pole Toggle Switch + Plate — Install | EA | 0.12 | _$ TBD_ | Install 15A single-pole toggle switch and plate. Ref: Leviton 1451-2WM (10-pk) / Eaton 1301-7W-10P (10-pk). |
| `TRIM-T06` | 15A 3-Way Toggle Switch + Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 3-way toggle switch and plate. Ref: Leviton 1453-2WM (10-pk) / Eaton 1303-7W-10P (10-pk). |
| `TRIM-T07` | 15A 4-Way Toggle Switch + Plate — Install | EA | 0.15 | _$ TBD_ | Install 15A 4-way toggle switch and plate. |
| `TRIM-T08` | 20A Single-Pole Toggle Switch + Plate — Install | EA | 0.12 | _$ TBD_ | Install 20A single-pole toggle switch and plate. Ref: Leviton 1221-2W. |

### TRIM-ASD

| Code | Name | Unit | Labor (hrs) | Landed Cost (USD) | Source / Reference |
|------|------|------|-------------|-------------------|---------------------|
| `TRIM-ASD01` | ASD 4 in Recessed LED Wafer 9W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 4 in 9W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-4D9WH-12P. Contractor provided (ASD). |
| `TRIM-ASD02` | ASD 4 in Recessed LED Wafer 12W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 4 in 12W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-4D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD03` | ASD 6 in Recessed LED Wafer 12W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 6 in 12W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-6D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD04` | ASD 6 in Recessed LED Wafer 15W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBR 6 in 15W canless LED wafer light. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBR-6D15WH-12P. Contractor provided (ASD). |
| `TRIM-ASD05` | ASD 4 in Baffle Wafer 9W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBRB 4 in 9W baffle trim canless LED. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBRB-4D9WH-12P. Contractor provided (ASD). |
| `TRIM-ASD06` | ASD 6 in Baffle Wafer 12W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBRB 6 in 12W baffle trim canless LED. 5CCT selectable. CRI 90+. Wet rated. 12-pk: ASD-JBRB-6D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD07` | ASD 4 in Square Wafer 10W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBS 4 in 10W square canless LED. 5CCT selectable. CRI 90+. Contractor provided (ASD). |
| `TRIM-ASD08` | ASD 6 in Square Wafer 15W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD JBS 6 in 15W square canless LED. 5CCT selectable. CRI 90+. Contractor provided (ASD). |
| `TRIM-ASD09` | ASD 4 in Retrofit Downlight 10W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LRKR 4 in 10W retrofit kit into existing 4 in can. 5CCT. CRI 90+. E26+TP24 connectors. 12-pk: ASD-LRKR-M4D10WH-12P. Contractor provided (ASD). |
| `TRIM-ASD10` | ASD 6 in Retrofit Downlight 12W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LRKR 6 in 12W retrofit kit into existing 5/6 in can. 5CCT. CRI 90+. E26+TP24 connectors. 12-pk: ASD-LRKR-M6D12WH-12P. Contractor provided (ASD). |
| `TRIM-ASD11` | ASD 4 in LED Disk Light 10W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LDS 4 in 10W surface mount disk light. 5CCT. CRI 90+. Wet rated. 12-pk: ASD-LDS-4D10AC-WH-12PACK. Contractor provided (ASD). |
| `TRIM-ASD12` | ASD 6 in LED Disk Light 15W — Install + Connect | EA | 0.20 | _$ TBD_ | Install ASD LDS 6 in 15W surface mount disk light. 5CCT. CRI 90+. Wet rated. 12-pk: ASD-LDS-6D15AC-WH-12PACK. Contractor provided (ASD). |
| `TRIM-ASD13` | ASD 10 in LED Flush Mount (Dbl Ring) 16W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 10 in 16W flush mount ceiling light. 3CCT. Damp rated. ASD-LFMDR-10D16CC-NK. Contractor provided (ASD). |
| `TRIM-ASD14` | ASD 12 in LED Flush Mount (Dbl Ring) 20W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 12 in 20W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-12D20CC-NK. Contractor provided (ASD). |
| `TRIM-ASD15` | ASD 14 in LED Flush Mount (Dbl Ring) 21W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 14 in 21W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-14D21CC-NK. Contractor provided (ASD). |
| `TRIM-ASD16` | ASD 16 in LED Flush Mount (Dbl Ring) 24W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 16 in 24W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-16D24CC-NK. Contractor provided (ASD). |
| `TRIM-ASD17` | ASD 18 in LED Flush Mount (Dbl Ring) 28W — Install + Connect | EA | 0.30 | _$ TBD_ | Install ASD LFMDR 18 in 28W flush mount ceiling light. 5CCT. Damp rated. ASD-LFMDR-18D28CC-NK. Contractor provided (ASD). |
| `TRIM-ASD18` | ASD 13 in Exterior Sconce 12W (Black) — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 13 in 12W outdoor wall sconce. Seeded glass. 3CCT. IP44 wet rated. ASD-LWS26S-13D12BK. Contractor provided (ASD). |
| `TRIM-ASD19` | ASD 18 in Exterior Sconce 12W (Black) — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 18 in 12W outdoor wall sconce. Seeded glass. 3CCT. IP44 wet rated. ASD-LWS26S-18D12BK. Contractor provided (ASD). |
| `TRIM-ASD20` | ASD 24 in Exterior Sconce 20W (Black) — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 24 in 20W outdoor wall sconce. Seeded glass. 3CCT. Multi-volt. ASD-LWS26S-MV-24D20CC-BK. Contractor provided (ASD). |
| `TRIM-ASD21` | ASD 24 in Exterior Sconce w/ Photocell 12W — Mount + Connect | EA | 0.30 | _$ TBD_ | Mount ASD LWS26 24 in 12W outdoor sconce with photocell (dusk-to-dawn). ASD-LWS26S-24N12BK-PC. Contractor provided (ASD). |
| `TRIM-ASD22` | ASD Small Wallpack 28W (Bronze) — Mount + Connect | EA | 0.35 | _$ TBD_ | Mount ASD SWP 28W residential wallpack. 3CCT. IP65. 120V. ASD-SWP-28BR-PC. Contractor provided (ASD). |
| `TRIM-ASD23` | ASD Small Wallpack Multi-Volt 28W (Bronze) — Mount + Connect | EA | 0.35 | _$ TBD_ | Mount ASD SWP multi-volt 20/24/28W selectable residential wallpack. 3CCT. IP65. 120-277V. 0-10V dim. ASD-SWP-MV-A28BR-PC. Contractor provided (ASD). |
| `TRIM-ASD24` | ASD LED Flood Light 60W (Black) — Mount + Connect | EA | 0.50 | _$ TBD_ | Mount ASD FL2 15/30/60W selectable flood light. 3CCT. IP65. Photocell. 120-277V. ASD-FL2-60BK-PC-AM or -FL. Contractor provided (ASD). |
| `TRIM-ASD25` | ASD 18 in Vanity Light 20W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 18 in 20W vanity bar light. 3CCT. Damp rated. ASD-LVF21-18D20CC-NK. Contractor provided (ASD). |
| `TRIM-ASD26` | ASD 24 in Vanity Light 25W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 24 in 25W vanity bar light. 3CCT. Damp rated. ASD-LVF21-24D25CC-NK. Contractor provided (ASD). |
| `TRIM-ASD27` | ASD 36 in Vanity Light 30W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 36 in 30W vanity bar light. 3CCT. Damp rated. ASD-LVF21-36D30CC-NK. Contractor provided (ASD). |
| `TRIM-ASD28` | ASD 48 in Vanity Light 35W (Nickel) — Mount + Connect | EA | 0.25 | _$ TBD_ | Mount ASD LVF21 48 in 35W vanity bar light. 3CCT. Damp rated. ASD-LVF21-48D35CC-NK. Contractor provided (ASD). |
| `TRIM-ASD29` | ASD 18 in Under-Cabinet LED 8W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 18 in 8W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-18D8CC-WH. Contractor provided (ASD). |
| `TRIM-ASD30` | ASD 24 in Under-Cabinet LED 12W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 24 in 12W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-24D12CC-WH. Contractor provided (ASD). |
| `TRIM-ASD31` | ASD 32 in Under-Cabinet LED 16W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 32 in 16W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-32D16CC-WH. Contractor provided (ASD). |
| `TRIM-ASD32` | ASD 40 in Under-Cabinet LED 20W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 40 in 20W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-40D20CC-WH. Contractor provided (ASD). |
| `TRIM-ASD33` | ASD 48 in Under-Cabinet LED 24W — Mount + Connect | EA | 0.20 | _$ TBD_ | Mount ASD UCL 48 in 24W hardwire under-cabinet light. 3CCT. Linkable. CRI 90+. ASD-UCL-48D24CC-WH. Contractor provided (ASD). |

## service

### DIAG

| Code | Name | Unit | Labor (hrs) | Landed Cost (USD) | Source / Reference |
|------|------|------|-------------|-------------------|---------------------|
| `DIAG-001` | Diagnostic / Troubleshooting — Hourly Rate | HR | 1.00 | _$ TBD_ | Hourly diagnostic rate for electrical troubleshooting and problem identification. 1-hour minimum. RATE TBD. |
| `DIAG-002` | Circuit Tracing — Single Circuit | EA | 0.25 | _$ TBD_ | Trace one circuit from breaker to all endpoints using toner/tracer or breaker-off method. Identify and document what is on the circuit. |
