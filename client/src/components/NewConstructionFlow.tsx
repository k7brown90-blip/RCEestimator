import React, { useState } from "react";
import { api } from "../lib/api";

interface NewConstructionFlowProps {
  optionId: string;
  onComplete: () => void;
  onCancel: () => void;
}

type BuildingType = "one_story" | "two_story" | "addition" | "detached";

interface ConstructionScope {
  buildingType: BuildingType;
  squareFootage: number;
  bathrooms: number;
  specialRequests: {
    evCharger: boolean;
    generator: boolean;
    wholeHouseBackup: boolean;
  };
}

export const NewConstructionFlow: React.FC<NewConstructionFlowProps> = ({
  optionId,
  onComplete,
  onCancel,
}) => {
  const [scope, setScope] = useState<ConstructionScope>({
    buildingType: "one_story",
    squareFootage: 2000,
    bathrooms: 2,
    specialRequests: {
      evCharger: false,
      generator: false,
      wholeHouseBackup: false,
    },
  });

  const [currentStep, setCurrentStep] = useState<"template" | "details" | "special" | "review">("template");
  const [loading, setLoading] = useState(false);

  const calculateCodeMinimumCircuits = (): { lighting: number; receptacles: number; appliance: number } => {
    let lighting = 0;
    let receptacles = 0;
    let appliance = 3; // water heater, range, dryer base

    // Per NEC: 3 watts per sq ft for lighting
    lighting = Math.ceil(scope.squareFootage / 500) + scope.bathrooms;

    // Per NEC: 1 outlet every 6 feet of wall + island
    receptacles = Math.ceil((scope.squareFootage / 15) * 0.1) + 2;

    return { lighting, receptacles, appliance };
  };

  const circuits = calculateCodeMinimumCircuits();

  const handleSubmit = async () => {
    setLoading(true);
    try {
      // Add lighting circuits
      for (let i = 0; i < circuits.lighting; i++) {
        await api.addAssembly(optionId, {
          assemblyTemplateId: "10", // 15A lighting
          quantity: 1,
          assemblyNotes: `Lighting circuit ${i + 1}`,
        });
      }

      // Add receptacle circuits
      for (let i = 0; i < circuits.receptacles; i++) {
        await api.addAssembly(optionId, {
          assemblyTemplateId: "9", // 20A receptacle
          quantity: 1,
          assemblyNotes: `Receptacle circuit ${i + 1}`,
        });
      }

      // Add appliance circuits
      await api.addAssembly(optionId, {
        assemblyTemplateId: "46", // Water heater
        quantity: 1,
        assemblyNotes: "Water heater (40A 240V code minimum)",
      });

      await api.addAssembly(optionId, {
        assemblyTemplateId: "53", // Range
        quantity: 1,
        assemblyNotes: "Range/oven (50A 240V code minimum)",
      });

      await api.addAssembly(optionId, {
        assemblyTemplateId: "56", // Dryer
        quantity: 1,
        assemblyNotes: "Dryer (30A 240V code minimum)",
      });

      // Add special requests
      if (scope.specialRequests.evCharger) {
        await api.addAssembly(optionId, {
          assemblyTemplateId: "62", // EV Charger
          quantity: 1,
          assemblyNotes: "EV Charger (50A 240V, customer requested)",
        });
      }

      if (scope.specialRequests.generator) {
        await api.addAssembly(optionId, {
          assemblyTemplateId: "65",
          quantity: 1,
          assemblyNotes: "Portable generator transfer switch",
        });
      }

      if (scope.specialRequests.wholeHouseBackup) {
        await api.addAssembly(optionId, {
          assemblyTemplateId: "65",
          quantity: 1,
          assemblyNotes: "Whole-house backup system prep",
        });
      }

      onComplete();
    } catch (error) {
      console.error("Error adding scope:", error);
      alert("Failed to add construction scope");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 bg-green-50 rounded-lg border border-green-200">
      <h3 className="text-lg font-bold mb-4">🏗️ New Construction Workflow</h3>

      {currentStep === "template" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">What type of structure?</p>
          <div className="space-y-2 mb-4">
            {[
              { value: "one_story" as const, label: "One-Story House" },
              { value: "two_story" as const, label: "Two-Story House" },
              { value: "addition" as const, label: "Addition/Renovation" },
              { value: "detached" as const, label: "Detached Structure (Garage, ADU, etc)" },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  setScope((prev) => ({ ...prev, buildingType: option.value }));
                  setCurrentStep("details");
                }}
                className={`w-full text-left px-3 py-2 border rounded hover:bg-green-100 ${
                  scope.buildingType === option.value ? "bg-green-100 border-green-600" : "bg-white"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button onClick={onCancel} className="px-4 py-2 bg-gray-300 text-gray-700 rounded">
            Cancel
          </button>
        </div>
      )}

      {currentStep === "details" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">What are the building dimensions?</p>
          <div className="space-y-3 mb-4 bg-white p-3 rounded border">
            <div>
              <label className="block text-sm font-semibold mb-1">Square Footage</label>
              <input
                type="number"
                value={scope.squareFootage}
                onChange={(e) =>
                  setScope((prev) => ({
                    ...prev,
                    squareFootage: parseInt(e.target.value) || 2000,
                  }))
                }
                className="w-full px-3 py-2 border rounded"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Bathrooms</label>
              <input
                type="number"
                value={scope.bathrooms}
                onChange={(e) =>
                  setScope((prev) => ({
                    ...prev,
                    bathrooms: parseInt(e.target.value) || 1,
                  }))
                }
                className="w-full px-3 py-2 border rounded"
              />
            </div>

            {/* Code minimum preview */}
            <div className="bg-green-50 p-2 rounded mt-3 text-xs text-gray-700">
              <p className="font-semibold">Code Minimum Circuits</p>
              <p>Lighting: {circuits.lighting} circuits (per NEC Article 210)</p>
              <p>Receptacles: {circuits.receptacles} circuits (6-ft rule)</p>
              <p>Appliances: 3 circuits (water heater, range, dryer)</p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("special")}
              className="px-4 py-2 bg-green-600 text-white rounded"
            >
              Next: Special Requests
            </button>
            <button
              onClick={() => setCurrentStep("template")}
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

      {currentStep === "special" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">Any special customer requests?</p>
          <div className="space-y-2 mb-4 bg-white p-3 rounded border">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={scope.specialRequests.evCharger}
                onChange={(e) =>
                  setScope((prev) => ({
                    ...prev,
                    specialRequests: { ...prev.specialRequests, evCharger: e.target.checked },
                  }))
                }
                className="w-4 h-4 mr-2"
              />
              <span className="text-sm">EV Charger (50A 240V)</span>
            </label>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={scope.specialRequests.generator}
                onChange={(e) =>
                  setScope((prev) => ({
                    ...prev,
                    specialRequests: { ...prev.specialRequests, generator: e.target.checked },
                  }))
                }
                className="w-4 h-4 mr-2"
              />
              <span className="text-sm">Portable Generator Transfer Switch</span>
            </label>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={scope.specialRequests.wholeHouseBackup}
                onChange={(e) =>
                  setScope((prev) => ({
                    ...prev,
                    specialRequests: { ...prev.specialRequests, wholeHouseBackup: e.target.checked },
                  }))
                }
                className="w-4 h-4 mr-2"
              />
              <span className="text-sm">Whole-House Backup System Prep</span>
            </label>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("review")}
              className="px-4 py-2 bg-green-600 text-white rounded"
            >
              Next: Review
            </button>
            <button
              onClick={() => setCurrentStep("details")}
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

      {currentStep === "review" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">Review NEC code-minimum scope:</p>
          <div className="bg-white p-3 rounded border mb-4 max-h-48 overflow-y-auto text-sm space-y-2">
            <div>
              <p className="font-semibold">{scope.buildingType.replace("_", " ").toUpperCase()}</p>
              <p className="text-gray-600">
                {scope.squareFootage} sq ft, {scope.bathrooms} bath(s)
              </p>
            </div>

            <div className="border-t pt-2">
              <p className="font-semibold">Code Minimum Circuits</p>
              <p className="text-gray-600">
                • {circuits.lighting} lighting circuits<br />
                • {circuits.receptacles} receptacle circuits<br />
                • 3 appliance circuits (water heater, range, dryer)
              </p>
            </div>

            {Object.values(scope.specialRequests).some((v) => v) && (
              <div className="border-t pt-2">
                <p className="font-semibold">Special Requests</p>
                {scope.specialRequests.evCharger && <p className="text-gray-600">• EV Charger</p>}
                {scope.specialRequests.generator && <p className="text-gray-600">• Generator Transfer</p>}
                {scope.specialRequests.wholeHouseBackup && <p className="text-gray-600">• Whole-House Backup</p>}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="px-4 py-2 bg-green-600 text-white rounded disabled:bg-gray-400"
            >
              {loading ? "Building Estimate..." : "Generate Estimate"}
            </button>
            <button
              onClick={() => setCurrentStep("special")}
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
