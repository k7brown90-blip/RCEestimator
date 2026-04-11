import React, { useState } from "react";
import { api } from "../lib/api";

interface SpecificRequestFlowProps {
  optionId: string;
  onComplete: () => void;
  onCancel: () => void;
}

type RequestType = "appliance" | "equipment" | "outlet_switch" | "other";
type ApplianceType = "water_heater" | "range" | "dryer" | "heat_pump" | "ev_charger" | "generator" | "subpanel";

const APPLIANCE_OPTIONS: Record<ApplianceType, { label: string; assemblies: number[] }> = {
  water_heater: {
    label: "Water Heater",
    assemblies: [46, 47, 48], // 30A, 40A, 50A variants
  },
  range: {
    label: "Range/Oven",
    assemblies: [53, 54, 55],
  },
  dryer: {
    label: "Dryer",
    assemblies: [56, 57, 58],
  },
  heat_pump: {
    label: "Heat Pump/Mini-Split",
    assemblies: [59, 60, 61],
  },
  ev_charger: {
    label: "EV Charger",
    assemblies: [62, 63, 64],
  },
  generator: {
    label: "Portable Generator",
    assemblies: [65],
  },
  subpanel: {
    label: "Subpanel Upgrade",
    assemblies: [25, 26],
  },
};

const OUTLET_SWITCH_TYPES = [
  { label: "Standard Outlet Replacement", assemblyId: 1 },
  { label: "GFCI Outlet", assemblyId: 9 },
  { label: "Switch Installation", assemblyId: 3 },
  { label: "Specialty Switch (Dimmer, 3-way)", assemblyId: 86 },
];

export const SpecificRequestFlow: React.FC<SpecificRequestFlowProps> = ({
  optionId,
  onComplete,
  onCancel,
}) => {
  const [requestType, setRequestType] = useState<RequestType | null>(null);
  const [selectedAppliances, setSelectedAppliances] = useState<
    Array<{ type: ApplianceType; location: string; amperage?: string }>
  >([]);
  const [selectedOutlets, setSelectedOutlets] = useState<Array<{ type: string; location: string; quantity: number }>>([]);
  const [currentStep, setCurrentStep] = useState<"type" | "select" | "options" | "review">("type");
  const [loading, setLoading] = useState(false);
  const [showAmperageOptions, setShowAmperageOptions] = useState<ApplianceType | null>(null);

  const handleRequestTypeSelect = (type: RequestType) => {
    setRequestType(type);
    setCurrentStep("select");
  };

  const handleAddAppliance = (appliance: ApplianceType, amperage?: string) => {
    setSelectedAppliances((prev) => [
      ...prev,
      { type: appliance, location: "", amperage },
    ]);
    setShowAmperageOptions(null);
  };

  const handleAddOutlet = (outlet: (typeof OUTLET_SWITCH_TYPES)[0]) => {
    setSelectedOutlets((prev) => [
      ...prev,
      { type: outlet.label, location: "", quantity: 1 },
    ]);
  };

  const handleRemoveAppliance = (index: number) => {
    setSelectedAppliances((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRemoveOutlet = (index: number) => {
    setSelectedOutlets((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateApplianceLocation = (index: number, location: string) => {
    setSelectedAppliances((prev) => {
      const updated = [...prev];
      updated[index].location = location;
      return updated;
    });
  };

  const handleUpdateOutletLocation = (index: number, location: string, quantity: number) => {
    setSelectedOutlets((prev) => {
      const updated = [...prev];
      updated[index].location = location;
      updated[index].quantity = quantity;
      return updated;
    });
  };

  const handleSubmit = async () => {
    const totalItems = selectedAppliances.length + selectedOutlets.length;
    if (totalItems === 0) {
      alert("Please select at least one item");
      return;
    }

    setLoading(true);
    try {
      // Add appliances
      for (const item of selectedAppliances) {
        const assemblies = APPLIANCE_OPTIONS[item.type].assemblies;
        // For now, just add the first variant; real implementation would let user choose
        const notes = item.location
          ? `${item.amperage ? `${item.amperage}, ` : ""}Location: ${item.location}`
          : item.amperage || "";

        await api.addAssembly(optionId, {
          assemblyTemplateId: String(assemblies[0]),
          quantity: 1,
          assemblyNotes: notes,
        });
      }

      // Add outlets
      for (const item of selectedOutlets) {
        const outlet = OUTLET_SWITCH_TYPES.find((o) => o.label === item.type);
        if (outlet) {
          const notes = item.location ? `Qty: ${item.quantity}, Location: ${item.location}` : `Qty: ${item.quantity}`;
          await api.addAssembly(optionId, {
            assemblyTemplateId: String(outlet.assemblyId),
            quantity: item.quantity,
            assemblyNotes: notes,
          });
        }
      }

      onComplete();
    } catch (error) {
      console.error("Error adding items:", error);
      alert("Failed to add items");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
      <h3 className="text-lg font-bold mb-4">💡 Specific Request Workflow</h3>

      {currentStep === "type" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">What is the customer requesting?</p>
          <div className="space-y-2 mb-4">
            <button
              onClick={() => handleRequestTypeSelect("appliance")}
              className="w-full text-left px-3 py-2 bg-white border rounded hover:bg-blue-50"
            >
              <p className="font-semibold text-sm">🔥 Appliance Installation</p>
              <p className="text-xs text-gray-600">Water heater, range, dryer, heat pump, etc.</p>
            </button>
            <button
              onClick={() => handleRequestTypeSelect("equipment")}
              className="w-full text-left px-3 py-2 bg-white border rounded hover:bg-blue-50"
            >
              <p className="font-semibold text-sm">⚡ Equipment Installation</p>
              <p className="text-xs text-gray-600">EV charger, generator, subpanel, etc.</p>
            </button>
            <button
              onClick={() => handleRequestTypeSelect("outlet_switch")}
              className="w-full text-left px-3 py-2 bg-white border rounded hover:bg-blue-50"
            >
              <p className="font-semibold text-sm">🔌 Outlet or Switch</p>
              <p className="text-xs text-gray-600">New outlet, GFCI, specialty switch</p>
            </button>
            <button
              onClick={() => handleRequestTypeSelect("other")}
              className="w-full text-left px-3 py-2 bg-white border rounded hover:bg-blue-50"
            >
              <p className="font-semibold text-sm">📋 Other</p>
              <p className="text-xs text-gray-600">Browse full assembly catalog</p>
            </button>
          </div>
          <button onClick={onCancel} className="px-4 py-2 bg-gray-300 text-gray-700 rounded">
            Cancel
          </button>
        </div>
      )}

      {currentStep === "select" && requestType === "appliance" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">Which appliance does the customer need?</p>
          <div className="space-y-2 mb-4">
            {Object.entries(APPLIANCE_OPTIONS)
              .filter(([key]) => ["water_heater", "range", "dryer", "heat_pump"].includes(key))
            .map(([key, { label }]) => (
                <button
                  key={key}
                  onClick={() => {
                    if (key === "water_heater" || key === "range" || key === "dryer" || key === "heat_pump") {
                      setShowAmperageOptions(key as ApplianceType);
                    }
                  }}
                  className="w-full text-left px-3 py-2 bg-white border rounded hover:bg-blue-50"
                >
                  {label}
                  {showAmperageOptions === key && (
                    <div className="mt-2 space-y-1 ml-3">
                      {["30A", "40A", "50A"].map((amp) => (
                        <button
                          key={amp}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddAppliance(key as ApplianceType, amp);
                          }}
                          className="block text-sm text-blue-600 hover:text-blue-800 px-2 py-1 bg-blue-50 rounded w-full text-left"
                        >
                          + {amp}
                        </button>
                      ))}
                    </div>
                  )}
                </button>
              ))}
          </div>

          {selectedAppliances.length > 0 && (
            <div className="bg-white p-3 rounded border mb-4">
              <p className="text-sm font-semibold mb-2">Selected ({selectedAppliances.length}):</p>
              <div className="space-y-2">
                {selectedAppliances.map((item, idx) => (
                  <div key={idx} className="flex gap-2 items-center text-sm">
                    <input
                      type="text"
                      placeholder="Location"
                      value={item.location}
                      onChange={(e) => handleUpdateApplianceLocation(idx, e.target.value)}
                      className="flex-1 px-2 py-1 border rounded text-sm"
                    />
                    <span className="text-gray-600">
                      {APPLIANCE_OPTIONS[item.type].label}
                      {item.amperage && ` (${item.amperage})`}
                    </span>
                    <button
                      onClick={() => handleRemoveAppliance(idx)}
                      className="text-red-600 hover:text-red-800"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("review")}
              disabled={selectedAppliances.length === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
            >
              Next: Review
            </button>
            <button
              onClick={() => setCurrentStep("type")}
              className="px-4 py-2 bg-gray-400 text-white rounded"
            >
              Back
            </button>
            <button onClick={onCancel} className="px-4 py-2 bg-gray-300 text-gray-700 rounded">
              Cancel
            </button>
          </div>
        </div>
      )}

      {currentStep === "select" && requestType === "outlet_switch" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">What type of outlet or switch?</p>
          <div className="space-y-2 mb-4">
            {OUTLET_SWITCH_TYPES.map((item, idx) => (
              <button
                key={idx}
                onClick={() => handleAddOutlet(item)}
                className="w-full text-left px-3 py-2 bg-white border rounded hover:bg-blue-50 text-sm"
              >
                + {item.label}
              </button>
            ))}
          </div>

          {selectedOutlets.length > 0 && (
            <div className="bg-white p-3 rounded border mb-4">
              <p className="text-sm font-semibold mb-2">Selected ({selectedOutlets.length}):</p>
              <div className="space-y-2">
                {selectedOutlets.map((item, idx) => (
                  <div key={idx} className="flex gap-2 items-center text-sm">
                    <input
                      type="text"
                      placeholder="Location"
                      value={item.location}
                      onChange={(e) => handleUpdateOutletLocation(idx, e.target.value, item.quantity)}
                      className="flex-1 px-2 py-1 border rounded text-sm"
                    />
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) =>
                        handleUpdateOutletLocation(idx, item.location, parseInt(e.target.value) || 1)
                      }
                      className="w-16 px-2 py-1 border rounded text-sm"
                    />
                    <span className="text-gray-600">{item.type}</span>
                    <button
                      onClick={() => handleRemoveOutlet(idx)}
                      className="text-red-600 hover:text-red-800"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("review")}
              disabled={selectedOutlets.length === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
            >
              Next: Review
            </button>
            <button
              onClick={() => setCurrentStep("type")}
              className="px-4 py-2 bg-gray-400 text-white rounded"
            >
              Back
            </button>
            <button onClick={onCancel} className="px-4 py-2 bg-gray-300 text-gray-700 rounded">
              Cancel
            </button>
          </div>
        </div>
      )}

      {currentStep === "select" && (
        requestType === "equipment" ||
        (requestType === "other" && (
          <div>
            <p className="text-sm text-gray-700 mb-4">Equipment coming soon. Use AssemblyPicker or browse catalog.</p>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentStep("type")}
                className="px-4 py-2 bg-gray-400 text-white rounded"
              >
                Back
              </button>
              <button onClick={onCancel} className="px-4 py-2 bg-gray-300 text-gray-700 rounded">
                Cancel
              </button>
            </div>
          </div>
        ))
      )}

      {currentStep === "review" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">Review scope before adding to estimate:</p>
          <div className="bg-white p-3 rounded border mb-4 max-h-48 overflow-y-auto">
            {selectedAppliances.map((item, idx) => (
              <div key={`app-${idx}`} className="py-2 border-b text-sm">
                <span className="font-medium">{APPLIANCE_OPTIONS[item.type].label}</span>
                {item.amperage && <span className="text-gray-600 ml-2">({item.amperage})</span>}
                {item.location && <span className="text-gray-600 ml-2">→ {item.location}</span>}
              </div>
            ))}
            {selectedOutlets.map((item, idx) => (
              <div key={`outlet-${idx}`} className="py-2 border-b text-sm">
                <span className="font-medium">{item.type}</span>
                <span className="text-gray-600 ml-2">× {item.quantity}</span>
                {item.location && <span className="text-gray-600 ml-2">→ {item.location}</span>}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="px-4 py-2 bg-green-600 text-white rounded disabled:bg-gray-400"
            >
              {loading ? "Adding..." : "Add to Estimate"}
            </button>
            <button
              onClick={() => setCurrentStep("select")}
              className="px-4 py-2 bg-gray-400 text-white rounded"
            >
              Back
            </button>
            <button onClick={onCancel} className="px-4 py-2 bg-gray-300 text-gray-700 rounded">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
