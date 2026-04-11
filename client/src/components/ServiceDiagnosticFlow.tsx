import React, { useState } from "react";
import { api } from "../lib/api";

interface ServiceDiagnosticFlowProps {
  optionId: string;
  onComplete: () => void;
  onCancel: () => void;
}

type DiagnosticCategory = "devices" | "circuits" | "protection" | "grounding" | "detection";

const DIAGNOSTIC_CATEGORIES: Record<DiagnosticCategory, { label: string; assemblies: number[] }> = {
  devices: {
    label: "Device Replacement (outlets, switches, fixtures)",
    assemblies: [1, 2, 3, 4, 5, 6, 7],
  },
  circuits: {
    label: "Circuit Issues (dedicated, GFCI, AFCI)",
    assemblies: [9, 10, 11, 12, 13],
  },
  protection: {
    label: "Panel Protection (breakers, surge, bonding)",
    assemblies: [22, 23, 24],
  },
  grounding: {
    label: "Grounding & Bonding",
    assemblies: [27, 28, 29, 30, 32, 33, 35, 36, 37],
  },
  detection: {
    label: "Smoke & CO Detection",
    assemblies: [16, 71, 72, 75, 76, 77],
  },
};

export const ServiceDiagnosticFlow: React.FC<ServiceDiagnosticFlowProps> = ({
  optionId,
  onComplete,
  onCancel,
}) => {
  const [selectedCategories, setSelectedCategories] = useState<DiagnosticCategory[]>([]);
  const [selectedAssemblies, setSelectedAssemblies] = useState<Array<{ assemblyId: number; location: string }>>([]);
  const [currentStep, setCurrentStep] = useState<"categories" | "details" | "review">("categories");
  const [loading, setLoading] = useState(false);

  const handleToggleCategory = (category: DiagnosticCategory) => {
    setSelectedCategories((prev) => {
      if (prev.includes(category)) {
        return prev.filter((c) => c !== category);
      }
      return [...prev, category];
    });
  };

  const handleAddAssembly = (assemblyNum: number) => {
    setSelectedAssemblies((prev) => [
      ...prev,
      { assemblyId: assemblyNum, location: "" },
    ]);
  };

  const handleRemoveAssembly = (index: number) => {
    setSelectedAssemblies((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateLocation = (index: number, location: string) => {
    setSelectedAssemblies((prev) => {
      const updated = [...prev];
      updated[index].location = location;
      return updated;
    });
  };

  const handleSubmit = async () => {
    if (selectedAssemblies.length === 0) {
      alert("Please select at least one assembly");
      return;
    }

    setLoading(true);
    try {
      for (const item of selectedAssemblies) {
        // Simple submission; location will be in notes
        const notes = item.location ? `Location: ${item.location}` : "";
        await api.addAssembly(optionId, {
          assemblyTemplateId: String(item.assemblyId),
          quantity: 1,
          assemblyNotes: notes,
        });
      }
      onComplete();
    } catch (error) {
      console.error("Error adding assemblies:", error);
      alert("Failed to add assemblies");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
      <h3 className="text-lg font-bold mb-4">🔧 Service Diagnostic Workflow</h3>

      {currentStep === "categories" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">
            What are we diagnosing or fixing? Select one or more categories:
          </p>
          <div className="space-y-2 mb-4">
            {Object.entries(DIAGNOSTIC_CATEGORIES).map(([key, { label }]) => (
              <label key={key} className="flex items-center">
                <input
                  type="checkbox"
                  checked={selectedCategories.includes(key as DiagnosticCategory)}
                  onChange={() => handleToggleCategory(key as DiagnosticCategory)}
                  className="w-4 h-4 mr-2"
                />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("details")}
              disabled={selectedCategories.length === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
            >
              Next: Select Items
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-400 text-white rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {currentStep === "details" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">
            Select specific items and enter location (e.g., "kitchen", "master bath", "panel"):
          </p>
          <div className="mb-4 max-h-96 overflow-y-auto space-y-3">
            {selectedCategories.map((category) => (
              <div key={category} className="bg-white p-3 rounded border">
                <p className="text-sm font-semibold mb-2">{DIAGNOSTIC_CATEGORIES[category].label}</p>
                <div className="space-y-2 ml-3">
                  {DIAGNOSTIC_CATEGORIES[category].assemblies.map((assemblyNum) => (
                    <button
                      key={assemblyNum}
                      onClick={() => handleAddAssembly(assemblyNum)}
                      className="block text-sm text-blue-600 hover:text-blue-800 font-medium"
                    >
                      + Assembly {assemblyNum}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {selectedAssemblies.length > 0 && (
            <div className="bg-white p-3 rounded border mb-4">
              <p className="text-sm font-semibold mb-2">Selected Items ({selectedAssemblies.length}):</p>
              <div className="space-y-2">
                {selectedAssemblies.map((item, idx) => (
                  <div key={idx} className="flex gap-2 items-center">
                    <input
                      type="text"
                      placeholder="Location (e.g., kitchen)"
                      value={item.location}
                      onChange={(e) => handleUpdateLocation(idx, e.target.value)}
                      className="flex-1 px-2 py-1 border rounded text-sm"
                    />
                    <span className="text-sm text-gray-600">Assembly {item.assemblyId}</span>
                    <button
                      onClick={() => handleRemoveAssembly(idx)}
                      className="text-red-600 hover:text-red-800 text-sm"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("review")}
              disabled={selectedAssemblies.length === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
            >
              Next: Review
            </button>
            <button
              onClick={() => setCurrentStep("categories")}
              className="px-4 py-2 bg-gray-400 text-white rounded"
            >
              Back
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-300 text-gray-700 rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {currentStep === "review" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">
            Review your scope. These items will be added to the estimate:
          </p>
          <div className="bg-white p-3 rounded border mb-4 max-h-48 overflow-y-auto">
            {selectedAssemblies.map((item, idx) => (
              <div key={idx} className="py-2 border-b last:border-b-0 text-sm">
                <span className="font-medium">Assembly {item.assemblyId}</span>
                {item.location && <span className="text-gray-600 ml-2">({item.location})</span>}
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
              onClick={() => setCurrentStep("details")}
              className="px-4 py-2 bg-gray-400 text-white rounded"
            >
              Back
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-300 text-gray-700 rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
