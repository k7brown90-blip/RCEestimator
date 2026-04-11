import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { AssemblyPicker } from "../components/AssemblyPicker";
import { AtomicItemsSection } from "../components/AtomicItemsSection";
import { ServiceDiagnosticFlow } from "../components/ServiceDiagnosticFlow";
import { SpecificRequestFlow } from "../components/SpecificRequestFlow";
import { RemodFlow } from "../components/RemodFlow";
import { NewConstructionFlow } from "../components/NewConstructionFlow";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import type { CompanionSuggestion, EstimateStatus } from "../lib/types";
import {
  getEnumOptions,
  getEstimatorParameterDefinitions,
  getInitialParameterFormValues,
  serializeParameterPayload,
  validateParameterForm,
  type ParameterFormValues,
} from "../lib/assemblyParameters";
import { money, parseJsonArray, shortDate } from "../lib/utils";
import { EstimateIntake } from "../components/EstimateIntake";

type TabKey = "assessment" | "findings" | "estimate" | "proposal" | "ai";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "assessment", label: "Assessment" },
  { key: "findings", label: "Findings" },
  { key: "estimate", label: "Estimate" },
  { key: "proposal", label: "Proposal" },
  { key: "ai", label: "AI Estimate" },
];

const STATUS_ACTIONS: Record<EstimateStatus, Array<{ status: EstimateStatus; label: string }>> = {
  draft: [
    { status: "review", label: "Mark Ready for Review" },
  ],
  review: [
    { status: "draft", label: "Back to Draft" },
    { status: "sent", label: "Send to Customer" },
  ],
  sent: [
    { status: "revised", label: "Revise" },
    { status: "expired", label: "Mark Expired" },
  ],
  accepted: [],
  declined: [{ status: "revised", label: "Mark Revised" }],
  expired: [{ status: "revised", label: "Mark Revised" }],
  revised: [{ status: "draft", label: "Return to Draft" }],
};

const CHANGE_ORDER_TYPES = [
  "customer_request",
  "hidden_condition",
  "utility_requirement",
  "ahj_requirement",
  "damage_discovered",
  "scope_revision",
];

export function VisitWorkspacePage() {
  const { visitId = "" } = useParams();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>("assessment");
  const [showPicker, setShowPicker] = useState(false);
  const [showWorkflowSelector, setShowWorkflowSelector] = useState(false);
  const [activeWorkflow, setActiveWorkflow] = useState<"none" | "service" | "specific_request" | "remodel" | "new_construction">("none");
  const [showMaterialList, setShowMaterialList] = useState(false);
  const [isBuildingOptionScope, setIsBuildingOptionScope] = useState(false);

  const { data: visit, isLoading } = useQuery({ queryKey: ["visit", visitId], queryFn: () => api.visit(visitId), enabled: Boolean(visitId) });
  const estimateId = visit?.estimates?.[0]?.id;
  const { data: estimate } = useQuery({ queryKey: ["estimate", estimateId], queryFn: () => api.estimate(String(estimateId)), enabled: Boolean(estimateId) });
  const [manualOptionId, setManualOptionId] = useState<string>("");

  const selectedOptionId = useMemo(() => {
    if (!estimate?.options?.length) return "";
    if (manualOptionId && estimate.options.some((option) => option.id === manualOptionId)) {
      return manualOptionId;
    }
    return estimate.options[0].id;
  }, [estimate?.options, manualOptionId]);

  const selectedOption = useMemo(() => estimate?.options.find((option) => option.id === selectedOptionId) ?? null, [estimate?.options, selectedOptionId]);

  const { data: materialListData, isLoading: materialListLoading } = useQuery({
    queryKey: ["materialList", selectedOptionId],
    queryFn: () => api.materialList(selectedOptionId),
    enabled: showMaterialList && Boolean(selectedOptionId),
  });

  const totalLaborHours = useMemo(() => {
    if (!selectedOption?.assemblies) return 0;
    return selectedOption.assemblies.reduce((acc, assembly) => {
      const hours = (assembly.components ?? [])
        .filter((c) => c.componentType === "labor")
        .reduce((sum, c) => sum + c.laborHours * c.quantity, 0);
      return acc + hours;
    }, 0);
  }, [selectedOption?.assemblies]);

  useEffect(() => {
    if (activeTab !== "estimate" && showPicker) {
      setShowPicker(false);
      setIsBuildingOptionScope(false);
    }
  }, [activeTab, showPicker]);

  useEffect(() => {
    if (!selectedOptionId && showPicker && !isBuildingOptionScope) {
      setShowPicker(false);
    }
  }, [selectedOptionId, showPicker, isBuildingOptionScope]);

  useEffect(() => {
    setLatestCompanionSuggestions([]);
  }, [selectedOptionId]);

  const [requestText, setRequestText] = useState("");
  const [urgency, setUrgency] = useState("");
  useEffect(() => {
    setRequestText(visit?.customerRequest?.requestText ?? "");
    setUrgency(visit?.customerRequest?.urgency ?? "");
  }, [visit?.customerRequest?.requestText, visit?.customerRequest?.urgency]);

  useEffect(() => {
    setServiceSummary(visit?.property?.systemSnapshot?.serviceSummary ?? "");
    setPanelSummary(visit?.property?.systemSnapshot?.panelSummary ?? "");
    setGroundingSummary(visit?.property?.systemSnapshot?.groundingSummary ?? "");
    setWiringMethodSummary(visit?.property?.systemSnapshot?.wiringMethodSummary ?? "");
    setDeficienciesText(parseJsonArray(visit?.property?.systemSnapshot?.deficienciesJson).join("\n"));
  }, [visit?.property?.systemSnapshot?.deficienciesJson, visit?.property?.systemSnapshot?.groundingSummary, visit?.property?.systemSnapshot?.panelSummary, visit?.property?.systemSnapshot?.serviceSummary, visit?.property?.systemSnapshot?.wiringMethodSummary]);

  const [observationText, setObservationText] = useState("");
  const [observationLocation, setObservationLocation] = useState("");
  const [editingObservationId, setEditingObservationId] = useState<string | null>(null);
  const [editingObservationText, setEditingObservationText] = useState("");
  const [editingObservationLocation, setEditingObservationLocation] = useState("");
  const [findingText, setFindingText] = useState("");
  const [findingConfidence, setFindingConfidence] = useState("medium");
  const [editingFindingId, setEditingFindingId] = useState<string | null>(null);
  const [editingFindingText, setEditingFindingText] = useState("");
  const [editingFindingConfidence, setEditingFindingConfidence] = useState("medium");
  const [limitationText, setLimitationText] = useState("");
  const [editingLimitationId, setEditingLimitationId] = useState<string | null>(null);
  const [editingLimitationText, setEditingLimitationText] = useState("");
  const [recommendationText, setRecommendationText] = useState("");
  const [recommendationPriority, setRecommendationPriority] = useState("Priority 2");
  const [editingRecommendationId, setEditingRecommendationId] = useState<string | null>(null);
  const [editingRecommendationText, setEditingRecommendationText] = useState("");
  const [editingRecommendationPriority, setEditingRecommendationPriority] = useState("Priority 2");

  const [serviceSummary, setServiceSummary] = useState("");
  const [panelSummary, setPanelSummary] = useState("");
  const [groundingSummary, setGroundingSummary] = useState("");
  const [wiringMethodSummary, setWiringMethodSummary] = useState("");
  const [deficienciesText, setDeficienciesText] = useState("");

  const [estimateTitle, setEstimateTitle] = useState("Service Estimate");
  const [optionLabel, setOptionLabel] = useState("Option A");
  const [optionDescription, setOptionDescription] = useState("");
  const [optionBuildError, setOptionBuildError] = useState("");
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [editingOptionLabel, setEditingOptionLabel] = useState("");
  const [editingOptionDescription, setEditingOptionDescription] = useState("");

  const [editingAssemblyId, setEditingAssemblyId] = useState<string | null>(null);
  const [editingAssemblyLocation, setEditingAssemblyLocation] = useState("");
  const [editingAssemblyQuantity, setEditingAssemblyQuantity] = useState(1);
  const [editingAssemblyParameters, setEditingAssemblyParameters] = useState<ParameterFormValues>({});
  const [editingAssemblyParamErrors, setEditingAssemblyParamErrors] = useState<Record<string, string>>({});
  const [latestCompanionSuggestions, setLatestCompanionSuggestions] = useState<CompanionSuggestion[]>([]);

  const [materialMarkupPct, setMaterialMarkupPct] = useState(estimate?.materialMarkupPct ?? 0);
  const [laborMarkupPct, setLaborMarkupPct] = useState(estimate?.laborMarkupPct ?? 0);


  const [permitType, setPermitType] = useState(estimate?.permitStatus?.permitType ?? "electrical");
  const [permitStatus, setPermitStatus] = useState(estimate?.permitStatus?.status ?? "not_required");
  const [permitRequired, setPermitRequired] = useState(Boolean(estimate?.permitStatus?.required));
  const [permitCost, setPermitCost] = useState<number>(estimate?.permitStatus?.cost ?? 0);

  const [inspectionType, setInspectionType] = useState("final");
  const [inspectionStatus, setInspectionStatus] = useState("not_scheduled");
  const [inspectionNotes, setInspectionNotes] = useState("");

  const [signatureName, setSignatureName] = useState("");
  const [signatureEmail, setSignatureEmail] = useState("");
  const [acceptOptionId, setAcceptOptionId] = useState("");

  const [changeOrderTitle, setChangeOrderTitle] = useState("");
  const [changeOrderReasonType, setChangeOrderReasonType] = useState("customer_request");
  const [changeOrderReason, setChangeOrderReason] = useState("");
  const [deltaLabor, setDeltaLabor] = useState(0);
  const [deltaMaterial, setDeltaMaterial] = useState(0);

  useEffect(() => {
    if (estimate?.options?.length) {
      const accepted = estimate.options.find((option) => option.accepted) ?? estimate.options[0];
      setAcceptOptionId(accepted.id);
    }
  }, [estimate?.options]);

  useEffect(() => {
    setPermitType(estimate?.permitStatus?.permitType ?? "electrical");
    setPermitStatus(estimate?.permitStatus?.status ?? "not_required");
    setPermitRequired(Boolean(estimate?.permitStatus?.required));
    setPermitCost(estimate?.permitStatus?.cost ?? 0);
  }, [estimate?.permitStatus]);

  useEffect(() => {
    setMaterialMarkupPct(estimate?.materialMarkupPct ?? 0);
    setLaborMarkupPct(estimate?.laborMarkupPct ?? 0);
  }, [estimate?.materialMarkupPct, estimate?.laborMarkupPct]);

  const refreshVisit = () => {
    queryClient.invalidateQueries({ queryKey: ["visit", visitId] });
    if (estimateId) {
      queryClient.invalidateQueries({ queryKey: ["estimate", estimateId] });
    }
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const customerRequestMutation = useMutation({
    mutationFn: () => {
      const input = { requestText, urgency: urgency || undefined };
      if (visit?.customerRequest) {
        return api.updateCustomerRequest(visitId, input);
      }
      return api.upsertCustomerRequest(visitId, input);
    },
    onSuccess: refreshVisit,
  });
  const snapshotMutation = useMutation({
    mutationFn: () => {
      if (!visit?.propertyId) throw new Error("Visit property not found");
      const deficiencies = deficienciesText.split("\n").map((line) => line.trim()).filter(Boolean);
      return api.updateSnapshot(visit.propertyId, {
        serviceSummary: serviceSummary || undefined,
        panelSummary: panelSummary || undefined,
        groundingSummary: groundingSummary || undefined,
        wiringMethodSummary: wiringMethodSummary || undefined,
        deficiencies,
      });
    },
    onSuccess: refreshVisit,
  });
  const observationMutation = useMutation({ mutationFn: () => api.addObservation(visitId, { observationText, location: observationLocation || undefined }), onSuccess: () => { setObservationText(""); setObservationLocation(""); refreshVisit(); } });
  const updateObservationMutation = useMutation({ mutationFn: (input: { id: string; observationText: string; location?: string }) => api.updateObservation(visitId, input.id, { observationText: input.observationText, location: input.location }), onSuccess: () => { setEditingObservationId(null); refreshVisit(); } });
  const deleteObservationMutation = useMutation({ mutationFn: (observationId: string) => api.deleteObservation(visitId, observationId), onSuccess: refreshVisit });
  const findingMutation = useMutation({ mutationFn: () => api.addFinding(visitId, { findingText, confidence: findingConfidence }), onSuccess: () => { setFindingText(""); refreshVisit(); } });
  const updateFindingMutation = useMutation({ mutationFn: (input: { id: string; findingText: string; confidence?: string }) => api.updateFinding(visitId, input.id, { findingText: input.findingText, confidence: input.confidence }), onSuccess: () => { setEditingFindingId(null); refreshVisit(); } });
  const deleteFindingMutation = useMutation({ mutationFn: (findingId: string) => api.deleteFinding(visitId, findingId), onSuccess: refreshVisit });
  const limitationMutation = useMutation({ mutationFn: () => api.addLimitation(visitId, { limitationText }), onSuccess: () => { setLimitationText(""); refreshVisit(); } });
  const updateLimitationMutation = useMutation({ mutationFn: (input: { id: string; limitationText: string }) => api.updateLimitation(visitId, input.id, { limitationText: input.limitationText }), onSuccess: () => { setEditingLimitationId(null); refreshVisit(); } });
  const deleteLimitationMutation = useMutation({ mutationFn: (limitationId: string) => api.deleteLimitation(visitId, limitationId), onSuccess: refreshVisit });
  const recommendationMutation = useMutation({ mutationFn: () => api.addRecommendation(visitId, { recommendationText, priority: recommendationPriority }), onSuccess: () => { setRecommendationText(""); refreshVisit(); } });
  const updateRecommendationMutation = useMutation({ mutationFn: (input: { id: string; recommendationText: string; priority?: string }) => api.updateRecommendation(visitId, input.id, { recommendationText: input.recommendationText, priority: input.priority }), onSuccess: () => { setEditingRecommendationId(null); refreshVisit(); } });
  const deleteRecommendationMutation = useMutation({ mutationFn: (recommendationId: string) => api.deleteRecommendation(visitId, recommendationId), onSuccess: refreshVisit });

  const createEstimateMutation = useMutation({
    mutationFn: () => {
      if (!visit?.propertyId) throw new Error("Visit property not found");
      return api.createEstimate({ visitId, propertyId: visit.propertyId, title: estimateTitle });
    },
    onSuccess: refreshVisit,
  });

  const updateOptionMutation = useMutation({ mutationFn: (input: { optionId: string; optionLabel?: string; description?: string | null }) => api.updateOption(input.optionId, { optionLabel: input.optionLabel, description: input.description }), onSuccess: () => { setEditingOptionId(null); refreshVisit(); } });
  const deleteOptionMutation = useMutation({ mutationFn: (optionId: string) => api.deleteOption(optionId), onSuccess: refreshVisit });
  const addAssemblyMutation = useMutation({
    mutationFn: (input: { assemblyTemplateId: string; location?: string; quantity: number; assemblyNotes?: string; parameters?: Record<string, unknown> }) => {
      if (!selectedOptionId) {
        throw new Error("Select an option before adding assemblies.");
      }

      return api.addAssembly(selectedOptionId, {
        assemblyTemplateId: input.assemblyTemplateId,
        location: input.location,
        quantity: input.quantity,
        parameters: input.parameters,
        assemblyNotes: input.assemblyNotes,
      });
    },
    onSuccess: (createdAssembly) => {
      setLatestCompanionSuggestions(createdAssembly.companionSuggestions ?? []);
      refreshVisit();
    },
  });
  const updateAssemblyMutation = useMutation({
    mutationFn: (input: { assemblyId: string; location?: string; quantity?: number; parameters?: Record<string, unknown> }) =>
      api.updateAssembly(input.assemblyId, { location: input.location, quantity: input.quantity, parameters: input.parameters }),
    onSuccess: (updatedAssembly) => {
      setEditingAssemblyId(null);
      setEditingAssemblyParameters({});
      setEditingAssemblyParamErrors({});
      setLatestCompanionSuggestions(updatedAssembly.companionSuggestions ?? []);
      refreshVisit();
    },
  });
  const deleteAssemblyMutation = useMutation({
    mutationFn: (assemblyId: string) => api.deleteAssembly(assemblyId),
    onSuccess: () => {
      setLatestCompanionSuggestions([]);
      refreshVisit();
    },
  });

  const changeStatusMutation = useMutation({ mutationFn: (status: EstimateStatus) => api.changeEstimateStatus(String(estimateId), status), onSuccess: refreshVisit });
    const markupMutation = useMutation({ mutationFn: () => api.updateEstimateMarkup(String(estimateId), { materialMarkupPct, laborMarkupPct }), onSuccess: refreshVisit });
  const permitMutation = useMutation({ mutationFn: () => api.upsertPermitStatus(String(estimateId), { required: permitRequired, permitType, status: permitStatus, cost: permitCost }), onSuccess: refreshVisit });
  const inspectionMutation = useMutation({ mutationFn: () => api.upsertInspectionStatus(String(estimateId), { inspectionType, status: inspectionStatus, notes: inspectionNotes || undefined }), onSuccess: refreshVisit });

  const generateProposalMutation = useMutation({ mutationFn: () => api.generateProposal(String(estimateId)), onSuccess: refreshVisit });
  const deleteEstimateMutation = useMutation({
    mutationFn: () => api.deleteEstimate(String(estimateId)),
    onSuccess: () => {
      refreshVisit();
      window.location.assign("/jobs");
    },
  });

  const acceptMutation = useMutation({
    mutationFn: async (status: "accepted" | "declined") => {
      const optionId = acceptOptionId || estimate?.options[0]?.id;
      if (!optionId) throw new Error("No option selected");
      if (status === "declined") {
        return api.acceptProposal(String(estimateId), { optionId, status: "declined" });
      }
      const signature = await api.recordSignature(String(estimateId), {
        signerName: signatureName,
        signerEmail: signatureEmail || undefined,
        signatureData: `sig:${Date.now()}:${signatureName}`,
        consentText: "I authorize Red Cedar Electric to proceed with the selected option as priced above.",
      });
      return api.acceptProposal(String(estimateId), { optionId, signatureId: signature.id, status: "accepted" });
    },
    onSuccess: refreshVisit,
  });

  const changeOrderMutation = useMutation({
    mutationFn: () =>
      api.createChangeOrder(String(estimateId), {
        parentOptionId: acceptOptionId,
        title: changeOrderTitle,
        reasonType: changeOrderReasonType,
        reason: changeOrderReason || undefined,
        deltaLabor,
        deltaMaterial,
      }),
    onSuccess: () => {
      setChangeOrderTitle("");
      setChangeOrderReason("");
      setDeltaLabor(0);
      setDeltaMaterial(0);
      refreshVisit();
    },
  });

  if (isLoading || !visit) {
    return <p className="text-sm text-rce-muted">Loading visit...</p>;
  }

  const deficiencies = parseJsonArray(visit.property?.systemSnapshot?.deficienciesJson);
  const estimateLocked = estimate?.status === "accepted";
  const acceptedWithoutOptions = (estimate?.status === "accepted") && ((estimate?.options.length ?? 0) === 0);
  const status = estimate?.status;
  const latestDelivery = estimate?.proposalDeliveries?.[0] ?? null;
  const downloadUrl = latestDelivery ? `/api/proposals/${latestDelivery.id}/download` : null;

  const startOptionBuild = () => {
    if (!estimateId) {
      return;
    }

    if (!optionLabel.trim()) {
      setOptionBuildError("Option label is required before selecting scope.");
      return;
    }

    setOptionBuildError("");
    setIsBuildingOptionScope(true);
    setShowPicker(true);
  };

  return (
    <div className="relative">
      <PageHeader
        title={visit.property?.addressLine1 ?? "Visit"}
        subtitle={`${shortDate(visit.visitDate)} | ${visit.mode.replaceAll("_", " ")} | ${visit.customer?.name ?? ""}`}
        actions={status ? <StatusBadge status={status} /> : <span className="text-xs text-rce-soft">No estimate</span>}
      />

      <div className="mb-5 flex flex-wrap gap-2 rounded-2xl border border-rce-border/70 bg-rce-surface/85 p-2 shadow-card backdrop-blur-sm">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`min-h-11 rounded-xl border px-4 text-sm font-semibold transition ${
              activeTab === tab.key
                ? "border-rce-accent bg-rce-accent text-white shadow-sm"
                : "border-rce-border bg-white text-rce-muted hover:border-rce-accent/50 hover:bg-rce-accentBg/40 hover:text-rce-text"
            }`}
            onClick={() => setActiveTab(tab.key)}
            disabled={tab.key === "proposal" && !estimate}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "assessment" ? (
        <section className="space-y-4">
          <article className="card p-4">
            <h2 className="mb-2 text-lg font-semibold">Customer Request</h2>
            <form className="grid gap-3 md:grid-cols-2" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); customerRequestMutation.mutate(); }}>
              <label className="text-sm font-medium md:col-span-2">
                Request
                <textarea className="field mt-1 min-h-24" value={requestText} onChange={(event) => setRequestText(event.target.value)} />
              </label>
              <label className="text-sm font-medium">
                Urgency
                <input className="field mt-1" value={urgency} onChange={(event) => setUrgency(event.target.value)} />
              </label>
              <div className="flex items-end">
                <button className="btn btn-primary" type="submit" disabled={customerRequestMutation.isPending}>Save Request</button>
              </div>
            </form>
          </article>

          <article className="card p-4">
            <h2 className="mb-2 text-lg font-semibold">Observations</h2>
            <form className="mb-3 grid gap-3 md:grid-cols-3" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); observationMutation.mutate(); }}>
              <label className="text-sm font-medium md:col-span-2">
                Observation
                <input className="field mt-1" value={observationText} onChange={(event) => setObservationText(event.target.value)} required />
              </label>
              <label className="text-sm font-medium">
                Location
                <input className="field mt-1" value={observationLocation} onChange={(event) => setObservationLocation(event.target.value)} />
              </label>
              <div className="md:col-span-3">
                <button className="btn btn-secondary" type="submit" disabled={observationMutation.isPending}>+ Add Observation</button>
              </div>
            </form>
            <div className="space-y-2">
              {visit.observations?.map((item) => (
                <div key={item.id} className="rounded-lg border border-rce-border p-3 text-sm">
                  {editingObservationId === item.id ? (
                    <form
                      className="space-y-2"
                      onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        updateObservationMutation.mutate({
                          id: item.id,
                          observationText: editingObservationText,
                          location: editingObservationLocation || undefined,
                        });
                      }}
                    >
                      <input className="field" value={editingObservationText} onChange={(event) => setEditingObservationText(event.target.value)} required />
                      <input className="field" value={editingObservationLocation} onChange={(event) => setEditingObservationLocation(event.target.value)} placeholder="Location" />
                      <div className="flex gap-2">
                        <button className="btn btn-secondary" type="submit" disabled={updateObservationMutation.isPending}>Save</button>
                        <button className="btn btn-secondary" type="button" onClick={() => setEditingObservationId(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p>{item.observationText}</p>
                      <p className="text-xs text-rce-soft">{item.location || "No location"}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            setEditingObservationId(item.id);
                            setEditingObservationText(item.observationText);
                            setEditingObservationLocation(item.location ?? "");
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            if (window.confirm("Delete this observation?")) {
                              deleteObservationMutation.mutate(item.id);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </article>

          <article className="card p-4">
            <h2 className="mb-2 text-lg font-semibold">Existing System Snapshot</h2>
            <form className="grid gap-3 md:grid-cols-2" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); snapshotMutation.mutate(); }}>
              <label className="text-sm font-medium">
                Service
                <input className="field mt-1" value={serviceSummary} onChange={(event) => setServiceSummary(event.target.value)} placeholder="Not recorded" />
              </label>
              <label className="text-sm font-medium">
                Panel
                <input className="field mt-1" value={panelSummary} onChange={(event) => setPanelSummary(event.target.value)} placeholder="Not recorded" />
              </label>
              <label className="text-sm font-medium">
                Grounding
                <input className="field mt-1" value={groundingSummary} onChange={(event) => setGroundingSummary(event.target.value)} placeholder="Not recorded" />
              </label>
              <label className="text-sm font-medium">
                Wiring
                <input className="field mt-1" value={wiringMethodSummary} onChange={(event) => setWiringMethodSummary(event.target.value)} placeholder="Not recorded" />
              </label>
              <label className="text-sm font-medium md:col-span-2">
                Deficiencies (one per line)
                <textarea className="field mt-1 min-h-24" value={deficienciesText} onChange={(event) => setDeficienciesText(event.target.value)} />
              </label>
              <div className="md:col-span-2">
                <button className="btn btn-secondary" type="submit" disabled={snapshotMutation.isPending}>Save Snapshot</button>
              </div>
            </form>
            {deficiencies.length ? <p className="mt-2 text-xs text-rce-soft">Current recorded deficiencies: {deficiencies.length}</p> : null}
          </article>
        </section>
      ) : null}

      {activeTab === "findings" ? (
        <section className="space-y-4">
          <article className="card p-4">
            <h2 className="mb-2 text-lg font-semibold">Findings</h2>
            <form className="mb-3 grid gap-3 md:grid-cols-3" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); findingMutation.mutate(); }}>
              <label className="text-sm font-medium md:col-span-2">
                Finding
                <input className="field mt-1" value={findingText} onChange={(event) => setFindingText(event.target.value)} required />
              </label>
              <label className="text-sm font-medium">
                Confidence
                <div className="mt-2 flex flex-wrap gap-2">
                  {(["low", "medium", "high"] as const).map((value) => (
                    <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-rce-border px-3 text-sm capitalize">
                      <input
                        type="radio"
                        name="findingConfidence"
                        value={value}
                        checked={findingConfidence === value}
                        onChange={(event) => setFindingConfidence(event.target.value)}
                      />
                      {value}
                    </label>
                  ))}
                </div>
              </label>
              <div className="md:col-span-3">
                <button className="btn btn-secondary" type="submit" disabled={findingMutation.isPending}>+ Add Finding</button>
              </div>
            </form>
            <div className="space-y-2">
              {visit.findings?.map((item) => (
                <div key={item.id} className="rounded-lg border border-rce-border p-3 text-sm">
                  {editingFindingId === item.id ? (
                    <form
                      className="space-y-2"
                      onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        updateFindingMutation.mutate({
                          id: item.id,
                          findingText: editingFindingText,
                          confidence: editingFindingConfidence || undefined,
                        });
                      }}
                    >
                      <input className="field" value={editingFindingText} onChange={(event) => setEditingFindingText(event.target.value)} required />
                      <select className="field" value={editingFindingConfidence} onChange={(event) => setEditingFindingConfidence(event.target.value)}>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                      <div className="flex gap-2">
                        <button className="btn btn-secondary" type="submit" disabled={updateFindingMutation.isPending}>Save</button>
                        <button className="btn btn-secondary" type="button" onClick={() => setEditingFindingId(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p>{item.findingText}</p>
                      <p className="text-xs text-rce-soft">Confidence: {item.confidence || "n/a"}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            setEditingFindingId(item.id);
                            setEditingFindingText(item.findingText);
                            setEditingFindingConfidence(item.confidence ?? "medium");
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            if (window.confirm("Delete this finding?")) {
                              deleteFindingMutation.mutate(item.id);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </article>

          <article className="card p-4">
            <h2 className="mb-2 text-lg font-semibold">Limitations</h2>
            <form className="mb-3" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); limitationMutation.mutate(); }}>
              <input className="field" value={limitationText} onChange={(event) => setLimitationText(event.target.value)} placeholder="Enter limitation" required />
              <button className="btn btn-secondary mt-3" type="submit" disabled={limitationMutation.isPending}>+ Add Limitation</button>
            </form>
            <div className="space-y-2">
              {visit.limitations?.map((item) => (
                <div key={item.id} className="rounded-lg border border-rce-border p-3 text-sm">
                  {editingLimitationId === item.id ? (
                    <form
                      className="space-y-2"
                      onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        updateLimitationMutation.mutate({ id: item.id, limitationText: editingLimitationText });
                      }}
                    >
                      <input className="field" value={editingLimitationText} onChange={(event) => setEditingLimitationText(event.target.value)} required />
                      <div className="flex gap-2">
                        <button className="btn btn-secondary" type="submit" disabled={updateLimitationMutation.isPending}>Save</button>
                        <button className="btn btn-secondary" type="button" onClick={() => setEditingLimitationId(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p>{item.limitationText}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            setEditingLimitationId(item.id);
                            setEditingLimitationText(item.limitationText);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            if (window.confirm("Delete this limitation?")) {
                              deleteLimitationMutation.mutate(item.id);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </article>

          <article className="card p-4">
            <h2 className="mb-2 text-lg font-semibold">Recommendations</h2>
            <form className="mb-3 grid gap-3 md:grid-cols-3" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); recommendationMutation.mutate(); }}>
              <label className="text-sm font-medium md:col-span-2">
                Recommendation
                <input className="field mt-1" value={recommendationText} onChange={(event) => setRecommendationText(event.target.value)} required />
              </label>
              <label className="text-sm font-medium">
                Priority
                <input className="field mt-1" value={recommendationPriority} onChange={(event) => setRecommendationPriority(event.target.value)} />
              </label>
              <div className="md:col-span-3">
                <button className="btn btn-secondary" type="submit" disabled={recommendationMutation.isPending}>+ Add Recommendation</button>
              </div>
            </form>
            <div className="space-y-2">
              {visit.recommendations?.map((item) => (
                <div key={item.id} className="rounded-lg border border-rce-border p-3 text-sm">
                  {editingRecommendationId === item.id ? (
                    <form
                      className="space-y-2"
                      onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        updateRecommendationMutation.mutate({
                          id: item.id,
                          recommendationText: editingRecommendationText,
                          priority: editingRecommendationPriority || undefined,
                        });
                      }}
                    >
                      <input className="field" value={editingRecommendationText} onChange={(event) => setEditingRecommendationText(event.target.value)} required />
                      <input className="field" value={editingRecommendationPriority} onChange={(event) => setEditingRecommendationPriority(event.target.value)} placeholder="Priority" />
                      <div className="flex gap-2">
                        <button className="btn btn-secondary" type="submit" disabled={updateRecommendationMutation.isPending}>Save</button>
                        <button className="btn btn-secondary" type="button" onClick={() => setEditingRecommendationId(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p>{item.recommendationText}</p>
                      <p className="text-xs text-rce-soft">{item.priority || "No priority"}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            setEditingRecommendationId(item.id);
                            setEditingRecommendationText(item.recommendationText);
                            setEditingRecommendationPriority(item.priority ?? "Priority 2");
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            if (window.confirm("Delete this recommendation?")) {
                              deleteRecommendationMutation.mutate(item.id);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </article>
        </section>
      ) : null}

      {activeTab === "estimate" ? (
        <section className="space-y-5 pb-24">
          {!estimate ? (
            <article className="card rounded-2xl border border-rce-border/70 p-5">
              <h2 className="text-lg font-semibold">Create Estimate</h2>
              <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); createEstimateMutation.mutate(); }}>
                <label className="text-sm font-medium">
                  Estimate Title
                  <input className="field mt-1 min-w-72" value={estimateTitle} onChange={(event) => setEstimateTitle(event.target.value)} required />
                </label>
                <button className="btn btn-primary" type="submit" disabled={createEstimateMutation.isPending}>Create Estimate</button>
              </form>
            </article>
          ) : (
            <>
              <article className="card overflow-hidden rounded-2xl border border-rce-border/70 p-0">
                <div className="border-b border-rce-border bg-[linear-gradient(120deg,rgba(254,243,199,0.6),rgba(255,255,255,0.95))] px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-lg font-semibold tracking-tight">{estimate.title}</h2>
                    <StatusBadge status={estimate.status} />
                  </div>
                  <p className="mt-1 text-sm text-rce-muted">Revision {estimate.revision}</p>
                  {estimateLocked ? <p className="mt-1 text-xs text-rce-warning">Estimate is locked after acceptance. Use change orders for scope changes.</p> : null}
                  {acceptedWithoutOptions ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="text-xs text-rce-danger">This accepted estimate has no options/assemblies and cannot be changed by change order.</p>
                      <button
                        className="btn btn-danger"
                        type="button"
                        disabled={deleteEstimateMutation.isPending}
                        onClick={() => {
                          if (window.confirm("Delete this invalid accepted estimate? This cannot be undone.")) {
                            deleteEstimateMutation.mutate();
                          }
                        }}
                      >
                        Delete Invalid Estimate
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-rce-soft">Options</h3>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {estimate.options.map((option) => (
                    <button key={option.id} className={`btn ${selectedOptionId === option.id ? "btn-primary" : "btn-secondary"}`} type="button" onClick={() => setManualOptionId(option.id)}>
                      {option.optionLabel} - {money(option.totalCost)}
                    </button>
                  ))}
                </div>
                {!selectedOption ? <p className="mt-2 text-xs text-rce-soft">Select an option above or create a new one to begin adding assemblies.</p> : null}

                {selectedOption ? (
                  <div className="mt-4 rounded-lg border border-rce-border p-3">
                    {editingOptionId === selectedOption.id ? (
                      <form
                        className="grid gap-3 md:grid-cols-2"
                        onSubmit={(event: FormEvent<HTMLFormElement>) => {
                          event.preventDefault();
                          updateOptionMutation.mutate({
                            optionId: selectedOption.id,
                            optionLabel: editingOptionLabel,
                            description: editingOptionDescription || null,
                          });
                        }}
                      >
                        <label className="text-sm font-medium">
                          Option Label
                          <input className="field mt-1" value={editingOptionLabel} onChange={(event) => setEditingOptionLabel(event.target.value)} required />
                        </label>
                        <label className="text-sm font-medium">
                          Description
                          <input className="field mt-1" value={editingOptionDescription} onChange={(event) => setEditingOptionDescription(event.target.value)} />
                        </label>
                        <div className="md:col-span-2 flex gap-2">
                          <button className="btn btn-secondary" type="submit" disabled={updateOptionMutation.isPending}>Save Option</button>
                          <button className="btn btn-secondary" type="button" onClick={() => setEditingOptionId(null)}>Cancel</button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">Selected: {selectedOption.optionLabel}</p>
                          <p className="text-xs text-rce-soft">{selectedOption.description || "No description"}</p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="btn btn-secondary"
                            type="button"
                            disabled={estimateLocked}
                            onClick={() => {
                              setEditingOptionId(selectedOption.id);
                              setEditingOptionLabel(selectedOption.optionLabel);
                              setEditingOptionDescription(selectedOption.description || "");
                            }}
                          >
                            Edit Option
                          </button>
                          <button
                            className={`btn btn-secondary ${estimateLocked ? "cursor-not-allowed opacity-60" : ""}`}
                            type="button"
                            disabled={estimateLocked}
                            onClick={() => {
                              if (window.confirm(`Delete ${selectedOption.optionLabel}?`)) {
                                deleteOptionMutation.mutate(selectedOption.id);
                              }
                            }}
                          >
                            Delete Option
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                <form
                  className="mt-4 grid gap-3 md:grid-cols-3"
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    startOptionBuild();
                  }}
                >
                  <label className="text-sm font-medium">
                    Option Label
                    <input className="field mt-1" value={optionLabel} onChange={(event) => setOptionLabel(event.target.value)} required />
                  </label>
                  <label className="text-sm font-medium md:col-span-2">
                    Description
                    <input className="field mt-1" value={optionDescription} onChange={(event) => setOptionDescription(event.target.value)} />
                  </label>
                  <div className="md:col-span-3">
                    <button className="btn btn-secondary" type="submit" disabled={estimateLocked}>Build Option</button>
                  </div>
                  {optionBuildError ? <p className="md:col-span-3 text-xs text-rce-danger">{optionBuildError}</p> : null}
                </form>
                </div>
              </article>

              {estimate.options.length > 1 ? (
                <article className="card p-4">
                  <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">Compare Options</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {estimate.options.map((option) => (
                      <div key={option.id} className="rounded-lg border border-rce-border p-3">
                        <p className="font-semibold">{option.optionLabel}</p>
                        <p className="text-sm text-rce-muted">Labor {money(option.subtotalLabor)} | Material {money(option.subtotalMaterial)}</p>
                        <p className="mt-1 font-semibold">Total {money(option.totalCost)}</p>
                      </div>
                    ))}
                  </div>
                </article>
              ) : null}

              {selectedOption ? (
              <article className="card rounded-2xl border border-rce-primary/30 p-5">
                <AtomicItemsSection
                  estimateId={String(estimateId)}
                  optionId={selectedOption.id}
                  locked={estimateLocked}
                />
              </article>
              ) : null}

              {selectedOption ? (
              <article className="card rounded-2xl border border-rce-border/70 p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Assemblies <span className="text-sm font-normal text-rce-soft">(legacy)</span></h3>
                  <div className="flex gap-2">
                    {selectedOptionId && !estimateLocked && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => { setIsBuildingOptionScope(false); setShowPicker(true); }}
                      >
                        + Add Assembly
                      </button>
                    )}
                    {(selectedOption?.assemblies?.length ?? 0) > 0 && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setShowMaterialList(true)}
                      >
                        Material List
                      </button>
                    )}
                  </div>
                </div>
                <p className="mb-3 text-xs text-rce-soft">Select an option tab above to view its assemblies, or build a new option to add scope.</p>
                {latestCompanionSuggestions.length > 0 ? (
                  <div className="mb-4 rounded-xl border border-rce-warning/30 bg-rce-accentBg p-3">
                    <p className="text-sm font-semibold text-rce-warning">Companion scope suggestions</p>
                    <p className="mt-1 text-xs text-rce-soft">Based on your most recent assembly change.</p>
                    <div className="mt-3 space-y-2">
                      {latestCompanionSuggestions.map((suggestion) => (
                        <div key={suggestion.templateId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rce-border/70 bg-white p-2">
                          <div>
                            <p className="text-sm font-medium">#{suggestion.assemblyNumber} {suggestion.name}</p>
                            <p className="text-xs text-rce-soft">{suggestion.reason}</p>
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={estimateLocked || addAssemblyMutation.isPending}
                            onClick={() => {
                              addAssemblyMutation.mutate({
                                assemblyTemplateId: suggestion.templateId,
                                quantity: 1,
                              });
                            }}
                          >
                            Add Suggested
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="space-y-3">
                  {selectedOption?.assemblies?.map((assembly) => (
                    <div key={assembly.id} className="rounded-xl border border-rce-border/80 bg-white p-3 shadow-sm">
                      {editingAssemblyId === assembly.id ? (
                        <form
                          className="space-y-2"
                          onSubmit={(event: FormEvent<HTMLFormElement>) => {
                            event.preventDefault();
                            const paramDefs = assembly.assemblyTemplate?.parameterDefinitions;
                            const formErrors = validateParameterForm(paramDefs, editingAssemblyParameters);
                            if (Object.values(formErrors).some(Boolean)) {
                              setEditingAssemblyParamErrors(formErrors);
                              return;
                            }
                            updateAssemblyMutation.mutate({
                              assemblyId: assembly.id,
                              location: editingAssemblyLocation || undefined,
                              quantity: editingAssemblyQuantity,
                              parameters: serializeParameterPayload(paramDefs, editingAssemblyParameters),
                            });
                          }}
                        >
                          <p className="font-medium">{assembly.assemblyTemplate?.name || assembly.assemblyTemplateId}</p>
                          <label className="text-xs text-rce-soft">
                            Location
                            <input className="field mt-1" value={editingAssemblyLocation} onChange={(event) => setEditingAssemblyLocation(event.target.value)} />
                          </label>
                          <label className="text-xs text-rce-soft">
                            Quantity
                            <input type="number" min={1} className="field mt-1" value={editingAssemblyQuantity} onChange={(event) => setEditingAssemblyQuantity(Math.max(1, Number(event.target.value) || 1))} />
                          </label>
                          {getEstimatorParameterDefinitions(assembly.assemblyTemplate?.parameterDefinitions).map((definition) => {
                            const currentValue = editingAssemblyParameters[definition.key];
                            const error = editingAssemblyParamErrors[definition.key];
                            const enumOptions = getEnumOptions(definition);
                            return (
                              <label key={definition.key} className="block text-xs text-rce-soft">
                                {definition.label}{definition.required ? " *" : ""}
                                {definition.valueType === "enum" ? (
                                  <select className="field mt-1" value={typeof currentValue === "string" ? currentValue : ""} onChange={(event) => { setEditingAssemblyParameters((prev) => ({ ...prev, [definition.key]: event.target.value })); setEditingAssemblyParamErrors((prev) => ({ ...prev, [definition.key]: "" })); }}>
                                    <option value="">Select...</option>
                                    {enumOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                                  </select>
                                ) : definition.valueType === "boolean" ? (
                                  <div className="mt-1 flex items-center gap-2">
                                    <input type="checkbox" checked={Boolean(currentValue)} onChange={(event) => setEditingAssemblyParameters((prev) => ({ ...prev, [definition.key]: event.target.checked }))} />
                                    <span>Enabled</span>
                                  </div>
                                ) : (
                                  <input type={definition.valueType === "string" ? "text" : "number"} step={definition.valueType === "integer" ? 1 : "any"} min={definition.minValue ?? undefined} max={definition.maxValue ?? undefined} className="field mt-1" value={typeof currentValue === "string" ? currentValue : ""} onChange={(event) => { setEditingAssemblyParameters((prev) => ({ ...prev, [definition.key]: event.target.value })); setEditingAssemblyParamErrors((prev) => ({ ...prev, [definition.key]: "" })); }} />
                                )}
                                {definition.helpText || definition.unit ? <p className="mt-0.5 text-xs text-rce-soft">{[definition.helpText, definition.unit ? `Unit: ${definition.unit}` : ""].filter(Boolean).join(" | ")}</p> : null}
                                {error ? <p className="mt-0.5 text-xs text-rce-danger">{error}</p> : null}
                              </label>
                            );
                          })}
                          <div className="flex gap-2">
                            <button className="btn btn-secondary" type="submit" disabled={updateAssemblyMutation.isPending}>Save</button>
                            <button className="btn btn-secondary" type="button" onClick={() => { setEditingAssemblyId(null); setEditingAssemblyParameters({}); setEditingAssemblyParamErrors({}); }}>Cancel</button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <p className="font-medium">{assembly.assemblyTemplate?.name || assembly.assemblyTemplateId}</p>
                            <p className="mono text-sm font-semibold">{money(assembly.totalCost)}</p>
                          </div>
                          <p className="text-xs text-rce-muted">Qty {assembly.quantity} | {assembly.location || "No location"}</p>
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={estimateLocked}
                              onClick={() => {
                                setEditingAssemblyId(assembly.id);
                                setEditingAssemblyLocation(assembly.location || "");
                                setEditingAssemblyQuantity(assembly.quantity);
                                const paramDefs = assembly.assemblyTemplate?.parameterDefinitions;
                                const initial = getInitialParameterFormValues(paramDefs);
                                const existing = assembly.parameters as Record<string, string | boolean | number> | undefined;
                                if (existing) {
                                  for (const key of Object.keys(initial)) {
                                    if (existing[key] !== undefined) {
                                      const raw = existing[key];
                                      initial[key] = typeof raw === "boolean" ? raw : String(raw);
                                    }
                                  }
                                }
                                setEditingAssemblyParameters(initial);
                                setEditingAssemblyParamErrors({});
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={estimateLocked}
                              onClick={() => {
                                if (window.confirm("Delete this assembly?")) {
                                  deleteAssemblyMutation.mutate(assembly.id);
                                }
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {estimateId && !estimateLocked ? (
                  <form
                    className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-rce-border/60 bg-rce-surface p-3"
                    onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); markupMutation.mutate(); }}
                  >
                    <label className="text-xs text-rce-soft">
                      Labor Markup %
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        className="field mt-1 w-24"
                        value={laborMarkupPct}
                        onChange={(event) => setLaborMarkupPct(Number(event.target.value) || 0)}
                      />
                    </label>
                    <label className="text-xs text-rce-soft">
                      Material Markup %
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        className="field mt-1 w-24"
                        value={materialMarkupPct}
                        onChange={(event) => setMaterialMarkupPct(Number(event.target.value) || 0)}
                      />
                    </label>
                    <button className="btn btn-secondary" type="submit" disabled={markupMutation.isPending}>Apply Markup</button>
                  </form>
                ) : null}
                <div className="mt-4 rounded-lg bg-rce-accentBg p-3 text-sm text-rce-warning">
                  Labor {money(selectedOption?.subtotalLabor)} | Material {money(selectedOption?.subtotalMaterial)}
                  {(selectedOption?.subtotalOther ?? 0) > 0 ? ` | Other ${money(selectedOption?.subtotalOther)}` : ""}
                  {" | "}<span className="font-bold">Total {money(selectedOption?.totalCost)}</span>
                </div>
                {totalLaborHours > 0 ? (
                  <p className="mt-1 text-xs text-rce-soft">{totalLaborHours.toFixed(2)} estimated labor hours</p>
                ) : null}
              </article>
              ) : null}

              <article className="card p-4">
                <h3 className="mb-3 text-lg font-semibold">Permit and Inspection</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  <form className="space-y-2" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); permitMutation.mutate(); }}>
                    <p className="text-sm font-medium">Permit Status</p>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={permitRequired} onChange={(event) => setPermitRequired(event.target.checked)} /> Permit required
                    </label>
                    <input className="field" value={permitType} onChange={(event) => setPermitType(event.target.value)} placeholder="Permit type" />
                    <select className="field" value={permitStatus} onChange={(event) => setPermitStatus(event.target.value)}>
                      <option value="not_required">Not required</option>
                      <option value="not_filed">Not filed</option>
                      <option value="filed">Filed</option>
                      <option value="issued">Issued</option>
                      <option value="expired">Expired</option>
                    </select>
                    <input type="number" min={0} className="field" value={permitCost} onChange={(event) => setPermitCost(Number(event.target.value) || 0)} placeholder="Cost" />
                    <button className="btn btn-secondary" type="submit" disabled={permitMutation.isPending}>Save Permit</button>
                  </form>

                  <form className="space-y-2" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); inspectionMutation.mutate(); }}>
                    <p className="text-sm font-medium">Inspection Status</p>
                    <select className="field" value={inspectionType} onChange={(event) => setInspectionType(event.target.value)}>
                      <option value="rough_in">Rough In</option>
                      <option value="underground">Underground</option>
                      <option value="final">Final</option>
                      <option value="re_inspection">Re Inspection</option>
                      <option value="service_release">Service Release</option>
                      <option value="temporary_power">Temporary Power</option>
                    </select>
                    <select className="field" value={inspectionStatus} onChange={(event) => setInspectionStatus(event.target.value)}>
                      <option value="not_scheduled">Not Scheduled</option>
                      <option value="scheduled">Scheduled</option>
                      <option value="passed">Passed</option>
                      <option value="failed">Failed</option>
                      <option value="corrections_required">Corrections Required</option>
                    </select>
                    <textarea className="field min-h-24" value={inspectionNotes} onChange={(event) => setInspectionNotes(event.target.value)} placeholder="Notes" />
                    <button className="btn btn-secondary" type="submit" disabled={inspectionMutation.isPending}>Save Inspection</button>
                  </form>
                </div>
              </article>

              <div className="fixed bottom-14 left-0 right-0 border-t border-rce-border bg-white p-3 md:bottom-0 md:left-[220px]">
                <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-rce-muted">Status: {estimate.status.toUpperCase()} | Rev {estimate.revision}</div>
                  <div className="flex flex-wrap gap-2">
                    {STATUS_ACTIONS[estimate.status].map((action) => (
                      <button key={action.status} className="btn btn-secondary" type="button" onClick={() => changeStatusMutation.mutate(action.status)} disabled={changeStatusMutation.isPending}>
                        {action.label}
                      </button>
                    ))}
                    {estimate.status === "draft" ? (
                      <button
                        className="btn btn-danger"
                        type="button"
                        disabled={deleteEstimateMutation.isPending}
                        onClick={() => {
                          if (window.confirm("Delete this draft estimate? This cannot be undone.")) {
                            deleteEstimateMutation.mutate();
                          }
                        }}
                      >
                        Delete Draft
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}

      {activeTab === "proposal" ? (
        <section className="space-y-4">
          {!estimate ? (
            <div className="card p-4 text-sm text-rce-muted">Create an estimate first before proposal actions.</div>
          ) : (
            <>
              <article className="card p-4">
                <h2 className="mb-2 text-lg font-semibold">Proposal Preview</h2>
                <p className="text-sm text-rce-muted">{visit.customer?.name} | {visit.property?.addressLine1}</p>
                <div className="mt-3 space-y-3">
                  {estimate.options.map((option) => (
                    <div key={option.id} className="rounded-lg border border-rce-border p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-semibold">{option.optionLabel}</p>
                        <p className="mono font-semibold">{money(option.totalCost)}</p>
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-rce-muted">
                        {option.assemblies?.map((assembly) => (
                          <p key={assembly.id}>- {assembly.assemblyTemplate?.name || assembly.assemblyTemplateId} ({money(assembly.totalCost)})</p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-lg border border-rce-border bg-rce-bg p-3 text-sm text-rce-muted">
                  NEC 2017 reference note: This estimate is prepared for pricing purposes only and is not a code compliance determination.
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className="btn btn-secondary" type="button" onClick={() => generateProposalMutation.mutate()} disabled={generateProposalMutation.isPending}>Generate PDF</button>
                  {downloadUrl ? (
                    <a className="btn btn-secondary inline-flex items-center" href={downloadUrl}>
                      Download PDF
                    </a>
                  ) : null}
                  {estimate.status === "review" ? (
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={estimate.proposalDeliveries.length === 0}
                      onClick={() => changeStatusMutation.mutate("sent")}
                    >
                      Send to Customer (Email stub)
                    </button>
                  ) : null}
                </div>
                {estimate.proposalDeliveries[0] ? <p className="mt-2 text-xs text-rce-soft">Last generated: {shortDate(estimate.proposalDeliveries[0].deliveredAt)} | {estimate.proposalDeliveries[0].method}</p> : null}
              </article>

              {estimate.status === "sent" ? (
                <article className="card p-4">
                  <h3 className="mb-3 text-lg font-semibold">Record Signature and Acceptance</h3>
                  <form
                    className="grid gap-3 md:grid-cols-2"
                    onSubmit={(event: FormEvent<HTMLFormElement>) => {
                      event.preventDefault();
                      acceptMutation.mutate("accepted");
                    }}
                  >
                    <label className="text-sm font-medium md:col-span-2">
                      Accepted Option
                      <select className="field mt-1" value={acceptOptionId} onChange={(event) => setAcceptOptionId(event.target.value)}>
                        {estimate.options.map((option) => (
                          <option key={option.id} value={option.id}>{option.optionLabel} - {money(option.totalCost)}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm font-medium">
                      Customer Name
                      <input className="field mt-1" value={signatureName} onChange={(event) => setSignatureName(event.target.value)} required />
                    </label>
                    <label className="text-sm font-medium">
                      Customer Email
                      <input className="field mt-1" value={signatureEmail} onChange={(event) => setSignatureEmail(event.target.value)} />
                    </label>
                    <label className="text-sm font-medium md:col-span-2">
                      Signature
                      <textarea className="field mt-1 min-h-24" value={signatureName ? `Signed by ${signatureName}` : ""} readOnly />
                    </label>
                    <div className="md:col-span-2 flex gap-2">
                      <button className="btn btn-primary" type="submit" disabled={acceptMutation.isPending}>Confirm Acceptance</button>
                      <button className="btn btn-danger" type="button" onClick={() => acceptMutation.mutate("declined")} disabled={acceptMutation.isPending}>Mark Declined</button>
                    </div>
                  </form>
                </article>
              ) : null}

              {estimate.status === "accepted" ? (
                <article className="card p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-lg font-semibold">Create Change Order</h3>
                    <a
                      className="btn btn-secondary inline-flex items-center"
                      href={downloadUrl ?? "#"}
                      onClick={(event) => {
                        if (!downloadUrl) {
                          event.preventDefault();
                        }
                      }}
                    >
                      Download Signed Proposal
                    </a>
                  </div>
                  {estimate.options.length === 0 ? (
                    <div className="rounded-lg border border-rce-danger/30 bg-red-50 p-3 text-sm text-rce-danger">
                      No accepted option is available, so a change order cannot be created for this estimate.
                    </div>
                  ) : (
                    <form
                      className="grid gap-3 md:grid-cols-2"
                      onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        changeOrderMutation.mutate();
                      }}
                    >
                      <label className="text-sm font-medium md:col-span-2">
                        Title
                        <input className="field mt-1" value={changeOrderTitle} onChange={(event) => setChangeOrderTitle(event.target.value)} required />
                      </label>
                      <label className="text-sm font-medium">
                        Reason Type
                        <select className="field mt-1" value={changeOrderReasonType} onChange={(event) => setChangeOrderReasonType(event.target.value)}>
                          {CHANGE_ORDER_TYPES.map((value) => (
                            <option key={value} value={value}>{value}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-sm font-medium">
                        Parent Option
                        <select className="field mt-1" value={acceptOptionId} onChange={(event) => setAcceptOptionId(event.target.value)}>
                          {estimate.options.map((option) => (
                            <option key={option.id} value={option.id}>{option.optionLabel}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-sm font-medium md:col-span-2">
                        Notes
                        <textarea className="field mt-1 min-h-24" value={changeOrderReason} onChange={(event) => setChangeOrderReason(event.target.value)} />
                      </label>
                      <label className="text-sm font-medium">
                        Delta Labor
                        <input type="number" className="field mt-1" value={deltaLabor} onChange={(event) => setDeltaLabor(Number(event.target.value) || 0)} />
                      </label>
                      <label className="text-sm font-medium">
                        Delta Material
                        <input type="number" className="field mt-1" value={deltaMaterial} onChange={(event) => setDeltaMaterial(Number(event.target.value) || 0)} />
                      </label>
                      <div className="md:col-span-2">
                        <button className="btn btn-secondary" type="submit" disabled={changeOrderMutation.isPending}>Create Change Order</button>
                      </div>
                    </form>
                  )}
                  <div className="mt-3 space-y-2">
                    {estimate.changeOrders.map((changeOrder) => (
                      <div key={changeOrder.id} className="rounded-lg border border-rce-border p-3 text-sm">
                        <p className="font-medium">CO #{changeOrder.sequenceNumber} - {changeOrder.title}</p>
                        <p className="text-rce-muted">{changeOrder.reasonType || "n/a"} | {money(changeOrder.deltaTotal)}</p>
                      </div>
                    ))}
                  </div>
                </article>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {/* Workflow Selector Modal */}
      {showWorkflowSelector && selectedOptionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-lg">
            <h2 className="mb-4 text-xl font-bold">How would you like to add assemblies?</h2>
            <div className="space-y-3 mb-6">
              {visit?.mode === "service_diagnostic" && (
                <button
                  onClick={() => setActiveWorkflow("service")}
                  className="w-full text-left px-4 py-3 border rounded-lg hover:bg-blue-50 transition"
                >
                  <p className="font-semibold">🔧 Service Diagnostic Workflow</p>
                  <p className="text-xs text-gray-600">Guided workflow for service calls and troubleshooting</p>
                </button>
              )}
              {visit?.mode === "specific_request" && (
                <button
                  onClick={() => setActiveWorkflow("specific_request")}
                  className="w-full text-left px-4 py-3 border rounded-lg hover:bg-amber-50 transition"
                >
                  <p className="font-semibold">💡 Specific Request Workflow</p>
                  <p className="text-xs text-gray-600">Guided workflow for appliance and equipment requests</p>
                </button>
              )}
              {visit?.mode === "remodel" && (
                <button
                  onClick={() => setActiveWorkflow("remodel")}
                  className="w-full text-left px-4 py-3 border rounded-lg hover:bg-orange-50 transition"
                >
                  <p className="font-semibold">🔨 Remodel Workflow</p>
                  <p className="text-xs text-gray-600">Guided workflow for remodel projects, room-by-room scope</p>
                </button>
              )}
              {visit?.mode === "new_construction" && (
                <button
                  onClick={() => setActiveWorkflow("new_construction")}
                  className="w-full text-left px-4 py-3 border rounded-lg hover:bg-green-50 transition"
                >
                  <p className="font-semibold">🏗️ New Construction Workflow</p>
                  <p className="text-xs text-gray-600">Guided workflow for code-minimum scope calculation</p>
                </button>
              )}
              <button
                onClick={() => {
                  setShowWorkflowSelector(false);
                  setShowPicker(true);
                }}
                className="w-full text-left px-4 py-3 border rounded-lg hover:bg-gray-50 transition"
              >
                <p className="font-semibold">🔍 Manual Assembly Picker</p>
                <p className="text-xs text-gray-600">Search assemblies manually from the full catalog</p>
              </button>
            </div>
            <button
              onClick={() => setShowWorkflowSelector(false)}
              className="px-4 py-2 bg-gray-300 text-gray-700 rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Workflow Flow Components */}
      {activeWorkflow === "service" && selectedOptionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto">
          <div className="w-full max-w-2xl m-4 bg-white rounded-lg shadow-lg">
            <ServiceDiagnosticFlow
              optionId={selectedOptionId}
              onComplete={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(false);
              }}
              onCancel={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(true);
              }}
            />
          </div>
        </div>
      )}

      {activeWorkflow === "specific_request" && selectedOptionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto">
          <div className="w-full max-w-2xl m-4 bg-white rounded-lg shadow-lg">
            <SpecificRequestFlow
              optionId={selectedOptionId}
              onComplete={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(false);
              }}
              onCancel={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(true);
              }}
            />
          </div>
        </div>
      )}

      {activeWorkflow === "remodel" && selectedOptionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto">
          <div className="w-full max-w-2xl m-4 bg-white rounded-lg shadow-lg">
            <RemodFlow
              optionId={selectedOptionId}
              onComplete={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(false);
              }}
              onCancel={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(true);
              }}
            />
          </div>
        </div>
      )}

      {activeWorkflow === "new_construction" && selectedOptionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto">
          <div className="w-full max-w-2xl m-4 bg-white rounded-lg shadow-lg">
            <NewConstructionFlow
              optionId={selectedOptionId}
              onComplete={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(false);
              }}
              onCancel={() => {
                setActiveWorkflow("none");
                setShowWorkflowSelector(true);
              }}
            />
          </div>
        </div>
      )}

      {/* Material List Modal */}
      {showMaterialList && selectedOptionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex w-full max-w-2xl flex-col rounded-lg bg-white shadow-lg" style={{ maxHeight: "90vh" }}>
            <div className="flex items-center justify-between border-b border-rce-border p-5">
              <div>
                <h2 className="text-xl font-bold">Material List</h2>
                <p className="text-sm text-rce-soft">{materialListData?.optionLabel ?? "..."}</p>
              </div>
              <div className="flex gap-2">
                <button className="btn btn-secondary" type="button" onClick={() => window.print()}>Print</button>
                <button className="btn btn-secondary" type="button" onClick={() => setShowMaterialList(false)}>Close</button>
              </div>
            </div>
            <div className="overflow-y-auto p-5">
              {materialListLoading ? (
                <p className="text-sm text-rce-soft">Loading materials...</p>
              ) : (materialListData?.items.length ?? 0) === 0 ? (
                <p className="text-sm text-rce-soft">No materials found for this option.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-rce-border text-left text-xs font-semibold text-rce-muted">
                      <th className="pb-2 pr-4">Code</th>
                      <th className="pb-2 pr-4">Description</th>
                      <th className="pb-2 pr-4 text-right">Qty</th>
                      <th className="pb-2">Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {materialListData?.items.map((item) => (
                      <tr key={item.code} className="border-b border-rce-border/50">
                        <td className="py-2 pr-4 font-mono text-xs text-rce-soft">{item.code}</td>
                        <td className="py-2 pr-4 font-medium">{item.description}</td>
                        <td className="py-2 pr-4 text-right font-semibold">{item.quantity % 1 === 0 ? item.quantity : item.quantity.toFixed(1)}</td>
                        <td className="py-2 text-rce-soft">{item.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "ai" ? (
        <EstimateIntake visitId={visitId} propertyId={visit.propertyId ?? undefined} />
      ) : null}

      <AssemblyPicker
        open={showPicker && activeTab === "estimate" && activeWorkflow === "none"}
        mode={visit.mode}
        title={isBuildingOptionScope ? "Build Option Scope" : "Add Assembly"}
        submitLabel={isBuildingOptionScope ? "Create Option" : "Add to Option"}
        onClose={() => {
          setShowPicker(false);
          setIsBuildingOptionScope(false);
        }}
        onSubmit={async (input) => {
          if (isBuildingOptionScope) {
            if (!estimateId) {
              setOptionBuildError("Estimate not found. Refresh or create a new estimate first.");
              refreshVisit();
              throw new Error("Estimate not found");
            }
            try {
              const createdOption = await api.createOption(String(estimateId), {
                optionLabel: optionLabel.trim(),
                description: optionDescription.trim() || undefined,
              }) as { id: string };

              const createdAssembly = await api.addAssembly(createdOption.id, {
                assemblyTemplateId: input.assemblyTemplateId,
                location: input.location,
                quantity: input.quantity,
                parameters: input.parameters,
                assemblyNotes: input.notes,
              });

              setManualOptionId(createdOption.id);
              setLatestCompanionSuggestions(createdAssembly.companionSuggestions ?? []);
              setOptionLabel(`Option ${String.fromCharCode(65 + (estimate?.options.length ?? 0))}`);
              setOptionDescription("");
              setOptionBuildError("");
              setIsBuildingOptionScope(false);
              setShowWorkflowSelector(false);
              refreshVisit();
              return;
            } catch (error) {
              const message = error instanceof Error ? error.message : "Failed to build option";
              if (message.toLowerCase().includes("estimate not found")) {
                setOptionBuildError("Estimate no longer exists. Refresh and create/select an estimate before adding assemblies.");
                setIsBuildingOptionScope(false);
                refreshVisit();
              }
              throw error;
            }
          }

          await addAssemblyMutation.mutateAsync({
            assemblyTemplateId: input.assemblyTemplateId,
            location: input.location,
            quantity: input.quantity,
            parameters: input.parameters,
            assemblyNotes: input.notes,
          });
          setShowWorkflowSelector(false);
        }}
      />
    </div>
  );
}
