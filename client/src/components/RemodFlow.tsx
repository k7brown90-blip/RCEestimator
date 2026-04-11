import React, { useState } from "react";
import { api } from "../lib/api";

interface RemodFlowProps {
  optionId: string;
  onComplete: () => void;
  onCancel: () => void;
}

type RoomType = "kitchen" | "master_bath" | "guest_bath" | "laundry" | "bedroom" | "living" | "garage" | "other";

interface RoomScope {
  room: RoomType;
  label: string;
  items: { key: string; label: string; assemblyId: number; selected: boolean }[];
}

const ROOM_SCOPES: RoomScope[] = [
  {
    room: "kitchen",
    label: "Kitchen",
    items: [
      { key: "range", label: "Range/Oven Circuit (50A 240V)", assemblyId: 53, selected: false },
      { key: "dw", label: "Dishwasher Circuit (20A)", assemblyId: 9, selected: false },
      { key: "disposal", label: "Disposal (20A)", assemblyId: 9, selected: false },
      { key: "microwave", label: "Microwave Circuit (20A)", assemblyId: 9, selected: false },
      { key: "circuits", label: "Counter Outlets (GFCI, 20A)", assemblyId: 9, selected: false },
      { key: "lighting", label: "Lighting Circuits (15A)", assemblyId: 10, selected: false },
    ],
  },
  {
    room: "master_bath",
    label: "Master Bathroom",
    items: [
      { key: "gfci", label: "GFCI Outlets", assemblyId: 9, selected: false },
      { key: "vent", label: "Vent Fan Circuit (20A)", assemblyId: 10, selected: false },
      { key: "heated_mirror", label: "Heated Mirror Circuit (20A)", assemblyId: 9, selected: false },
      { key: "lighting", label: "Lighting Circuits (15A)", assemblyId: 10, selected: false },
    ],
  },
  {
    room: "guest_bath",
    label: "Guest Bathroom",
    items: [
      { key: "gfci", label: "GFCI Outlets", assemblyId: 9, selected: false },
      { key: "vent", label: "Vent Fan Circuit (20A)", assemblyId: 10, selected: false },
      { key: "lighting", label: "Lighting Circuits (15A)", assemblyId: 10, selected: false },
    ],
  },
  {
    room: "laundry",
    label: "Laundry Room",
    items: [
      { key: "washer", label: "Washer Circuit (20A 240V)", assemblyId: 9, selected: false },
      { key: "dryer", label: "Dryer Circuit (30A 240V)", assemblyId: 56, selected: false },
      { key: "lighting", label: "Lighting Circuit (15A)", assemblyId: 10, selected: false },
    ],
  },
  {
    room: "bedroom",
    label: "Bedroom (per room)",
    items: [
      { key: "outlets", label: "Outlets (2-3 per wall)", assemblyId: 1, selected: false },
      { key: "circuit", label: "Dedicated Circuit (20A)", assemblyId: 9, selected: false },
      { key: "lighting", label: "Lighting (15A)", assemblyId: 10, selected: false },
    ],
  },
  {
    room: "living",
    label: "Living/Dining Areas",
    items: [
      { key: "outlets", label: "Outlets (20A)", assemblyId: 1, selected: false },
      { key: "fan", label: "Ceiling Fan Circuit (15A)", assemblyId: 10, selected: false },
    ],
  },
  {
    room: "garage",
    label: "Garage",
    items: [
      { key: "gfci", label: "GFCI Outlets", assemblyId: 9, selected: false },
      { key: "ev", label: "EV Charger (50A 240V)", assemblyId: 62, selected: false },
      { key: "equipment", label: "Workshop Equipment (220V)", assemblyId: 56, selected: false },
      { key: "lighting", label: "Lighting Circuits (15A)", assemblyId: 10, selected: false },
    ],
  },
];

export const RemodFlow: React.FC<RemodFlowProps> = ({
  optionId,
  onComplete,
  onCancel,
}) => {
  const [selectedRooms, setSelectedRooms] = useState<RoomScope[]>([]);
  const [currentStep, setCurrentStep] = useState<"select_rooms" | "scope_rooms" | "review">("select_rooms");
  const [loading, setLoading] = useState(false);

  const handleToggleRoom = (room: RoomType) => {
    setSelectedRooms((prev) => {
      const existing = prev.find((r) => r.room === room);
      if (existing) {
        return prev.filter((r) => r.room !== room);
      }
      const roomScope = ROOM_SCOPES.find((r) => r.room === room);
      return roomScope ? [...prev, { ...roomScope }] : prev;
    });
  };

  const handleToggleItem = (roomIdx: number, itemIdx: number) => {
    setSelectedRooms((prev) => {
      const updated = [...prev];
      updated[roomIdx].items[itemIdx].selected = !updated[roomIdx].items[itemIdx].selected;
      return updated;
    });
  };

  const handleSubmit = async () => {
    const totalItems = selectedRooms.reduce((sum, room) => {
      return sum + room.items.filter((item) => item.selected).length;
    }, 0);

    if (totalItems === 0) {
      alert("Please select at least one scope item");
      return;
    }

    setLoading(true);
    try {
      for (const room of selectedRooms) {
        for (const item of room.items) {
          if (item.selected) {
            const notes = `Room: ${room.label}, Type: ${item.label}`;
            await api.addAssembly(optionId, {
              assemblyTemplateId: String(item.assemblyId),
              quantity: 1,
              assemblyNotes: notes,
            });
          }
        }
      }
      onComplete();
    } catch (error) {
      console.error("Error adding rooms:", error);
      alert("Failed to add remodel scope");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 bg-orange-50 rounded-lg border border-orange-200">
      <h3 className="text-lg font-bold mb-4">🔨 Remodel Workflow</h3>

      {currentStep === "select_rooms" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">Which rooms are being remodeled?</p>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {ROOM_SCOPES.map((room) => (
              <label key={room.room} className="flex items-center">
                <input
                  type="checkbox"
                  checked={selectedRooms.some((r) => r.room === room.room)}
                  onChange={() => handleToggleRoom(room.room)}
                  className="w-4 h-4 mr-2"
                />
                <span className="text-sm">{room.label}</span>
              </label>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("scope_rooms")}
              disabled={selectedRooms.length === 0}
              className="px-4 py-2 bg-orange-600 text-white rounded disabled:bg-gray-400"
            >
              Next: Scope Each Room
            </button>
            <button onClick={onCancel} className="px-4 py-2 bg-gray-300 text-gray-700 rounded">
              Cancel
            </button>
          </div>
        </div>
      )}

      {currentStep === "scope_rooms" && (
        <div>
          <p className="text-sm text-gray-700 mb-4">What work is needed in each room?</p>
          <div className="space-y-4 mb-4 max-h-96 overflow-y-auto">
            {selectedRooms.map((room, roomIdx) => (
              <div key={`${room.room}-${roomIdx}`} className="bg-white p-3 rounded border">
                <p className="font-semibold text-sm mb-2">{room.label}</p>
                <div className="ml-3 space-y-1">
                  {room.items.map((item, itemIdx) => (
                    <label key={`${item.key}-${itemIdx}`} className="flex items-center text-sm">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={() => handleToggleItem(roomIdx, itemIdx)}
                        className="w-4 h-4 mr-2"
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentStep("review")}
              className="px-4 py-2 bg-orange-600 text-white rounded"
            >
              Next: Review
            </button>
            <button
              onClick={() => setCurrentStep("select_rooms")}
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
          <p className="text-sm text-gray-700 mb-4">Review remodel scope:</p>
          <div className="bg-white p-3 rounded border mb-4 max-h-48 overflow-y-auto">
            {selectedRooms.map((room, roomIdx) => {
              const selectedItems = room.items.filter((i) => i.selected);
              if (selectedItems.length === 0) return null;

              return (
                <div key={`${room.room}-${roomIdx}`} className="py-2 border-b">
                  <p className="font-semibold text-sm">{room.label}</p>
                  <ul className="ml-3 text-xs text-gray-600">
                    {selectedItems.map((item, itemIdx) => (
                      <li key={`${item.key}-${itemIdx}`}>• {item.label}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
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
              onClick={() => setCurrentStep("scope_rooms")}
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
