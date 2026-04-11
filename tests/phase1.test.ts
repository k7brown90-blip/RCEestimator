import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { EstimateService } from "../src/services/estimateService";
import { seedAssemblyTemplates } from "../scripts/seedAssemblyTemplates";
import { PACKAGE_SUPPORT_ASSEMBLIES, PHASE_1_TARGETED_ASSEMBLIES } from "../scripts/assemblyPricingCatalog";
import {
  ASSEMBLY_ROLE_CATALOG,
  PARENT_CHILD_SELECTION_STANDARDS,
  getAssemblyRoleCatalogCoverage,
} from "../scripts/assemblyRoleCatalog";

const service = new EstimateService(prisma);

async function clearDb() {
  await prisma.assemblyComponent.deleteMany();
  await prisma.estimateAssembly.deleteMany();
  await prisma.changeOrder.deleteMany();
  await prisma.estimateOption.deleteMany();
  await prisma.proposalAcceptance.deleteMany();
  await prisma.signatureRecord.deleteMany();
  await prisma.proposalDelivery.deleteMany();
  await prisma.inspectionStatus.deleteMany();
  await prisma.permitStatus.deleteMany();
  await prisma.estimate.deleteMany();
  await prisma.recommendation.deleteMany();
  await prisma.limitation.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.observation.deleteMany();
  await prisma.customerRequest.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.systemSnapshot.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.assemblyTemplateChild.deleteMany();
  await prisma.assemblyTemplateComponent.deleteMany();
  await prisma.assemblyParameterDefinition.deleteMany();
  await prisma.assemblyTemplateVariant.deleteMany();
  await prisma.assemblyTemplate.deleteMany();
}

async function bootstrapVisit() {
  const customer = await prisma.customer.create({
    data: { name: "Kyle Homeowner", email: "kyle@example.com" },
  });

  const property = await prisma.property.create({
    data: {
      customerId: customer.id,
      name: "Main House",
      addressLine1: "123 Main St",
      city: "Vancouver",
      state: "WA",
      postalCode: "98660",
    },
  });

  await prisma.systemSnapshot.create({
    data: {
      propertyId: property.id,
      deficienciesJson: "[]",
      changeLogJson: "[]",
    },
  });

  const visit = await prisma.visit.create({
    data: {
      propertyId: property.id,
      customerId: customer.id,
      mode: "service_diagnostic",
      purpose: "Panel concerns",
    },
  });

  return { customer, property, visit };
}

async function seedHttpAtomicTemplate() {
  await prisma.assemblyTemplate.create({
    data: {
      id: "http-a1",
      assemblyNumber: 700,
      name: "HTTP Atomic",
      tier: "atomic",
      category: "devices",
    },
  });

  await prisma.assemblyTemplateComponent.createMany({
    data: [
      {
        templateId: "http-a1",
        componentType: "material",
        code: "HTTP-MAT",
        description: "Material",
        quantity: 1,
        unit: "ea",
        unitCost: 15,
      },
      {
        templateId: "http-a1",
        componentType: "labor",
        code: "HTTP-LAB",
        description: "Labor",
        quantity: 1,
        unit: "hr",
        laborHours: 0.5,
        laborRate: 100,
      },
    ],
  });
}

beforeEach(async () => {
  await clearDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phase 1 estimating core", () => {
  it("expands package assemblies with child quantity parameters", async () => {
    await prisma.assemblyTemplate.createMany({
      data: [
        { id: "child-atom", assemblyNumber: 900, name: "Child Atom", tier: "atomic", category: "devices" },
        { id: "pkg", assemblyNumber: 901, name: "Package", tier: "package", category: "package" },
      ],
    });

    await prisma.assemblyTemplateComponent.createMany({
      data: [
        {
          templateId: "child-atom",
          componentType: "material",
          code: "MAT-1",
          description: "Device",
          quantity: 1,
          unit: "ea",
          unitCost: 10,
          laborHours: 0,
          laborRate: 0,
        },
        {
          templateId: "child-atom",
          componentType: "labor",
          code: "LAB-1",
          description: "Install",
          quantity: 1,
          unit: "hr",
          unitCost: 0,
          laborHours: 0.5,
          laborRate: 100,
        },
      ],
    });

    await prisma.assemblyTemplateChild.create({
      data: {
        parentTemplateId: "pkg",
        childTemplateId: "child-atom",
        qtyParameterRef: "point_qty",
        required: true,
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Package Expansion" });
    const option = await service.addOption(estimate.id, "Base Option");

    const asm = await service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "pkg",
      parameters: { point_qty: 3 },
    });

    expect(asm?.totalCost).toBe(180);
    expect(asm?.components.find((c) => c.code === "MAT-1")?.quantity).toBe(3);
    expect(asm?.components.find((c) => c.code === "LAB-1")?.quantity).toBe(3);
  });

  it("calculates option totals from expanded assemblies", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "a1", assemblyNumber: 910, name: "Atomic 1", tier: "atomic", category: "devices" },
    });
    await prisma.assemblyTemplateComponent.createMany({
      data: [
        {
          templateId: "a1",
          componentType: "material",
          code: "M1",
          description: "Mat",
          quantity: 2,
          unitCost: 15,
          laborHours: 0,
          laborRate: 0,
        },
        {
          templateId: "a1",
          componentType: "labor",
          code: "L1",
          description: "Labor",
          quantity: 1,
          unitCost: 0,
          laborHours: 1,
          laborRate: 80,
        },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Totals" });
    await prisma.estimate.update({ where: { id: estimate.id }, data: { materialMarkupPct: 0 } });
    const option = await service.addOption(estimate.id, "Option 1");

    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "a1" });
    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "a1", quantity: 2 });

    const refreshed = await prisma.estimateOption.findUnique({ where: { id: option.id } });
    expect(refreshed?.subtotalMaterial).toBe(90);
    expect(refreshed?.subtotalLabor).toBe(240);
    expect(refreshed?.totalCost).toBe(330);
  });

  it("increments revision on revised transition and locks accepted estimates", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "a2", assemblyNumber: 920, name: "Atomic 2", tier: "atomic", category: "support" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "a2",
        componentType: "labor",
        code: "L2",
        description: "Labor",
        quantity: 1,
        laborHours: 1,
        laborRate: 100,
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Lifecycle" });
    const option = await service.addOption(estimate.id, "Primary");
    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "a2" });

    await service.changeEstimateStatus(estimate.id, "review");
    await service.changeEstimateStatus(estimate.id, "sent");
    const revised = await service.changeEstimateStatus(estimate.id, "revised");
    expect(revised.revision).toBe(2);

    await service.changeEstimateStatus(estimate.id, "draft");
    await service.changeEstimateStatus(estimate.id, "review");
    await service.changeEstimateStatus(estimate.id, "sent");

    const sig = await service.createSignaturePlaceholder(estimate.id);
    await service.acceptProposal({ estimateId: estimate.id, optionId: option.id, signatureId: sig.id });

    await expect(service.addOption(estimate.id, "Should Fail")).rejects.toThrow(/locked/i);
  });

  it("creates sequential change orders against accepted estimate", async () => {
    await seedHttpAtomicTemplate();
    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "CO Flow" });
    const option = await service.addOption(estimate.id, "Only Option");
    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "http-a1" });

    await service.changeEstimateStatus(estimate.id, "review");
    await service.changeEstimateStatus(estimate.id, "sent");
    const sig = await service.createSignaturePlaceholder(estimate.id);
    await service.acceptProposal({ estimateId: estimate.id, optionId: option.id, signatureId: sig.id });

    const co1 = await service.createChangeOrder({
      estimateId: estimate.id,
      parentOptionId: option.id,
      title: "Add exterior receptacle",
      reasonType: "customer_request",
      deltaLabor: 100,
      deltaMaterial: 85,
      deltaOther: 10,
    });
    const co2 = await service.createChangeOrder({
      estimateId: estimate.id,
      parentOptionId: option.id,
      title: "Upgrade breaker",
      reasonType: "scope_revision",
      deltaLabor: 80,
      deltaMaterial: 50,
    });

    expect(co1.sequenceNumber).toBe(1);
    expect(co2.sequenceNumber).toBe(2);
    expect(co1.deltaTotal).toBe(195);
  });

  it("persists permit and inspection statuses", async () => {
    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Permit/Inspection" });

    await service.upsertPermitStatus(estimate.id, {
      required: true,
      permitType: "electrical",
      status: "filed",
      permitNumber: "P-1001",
      cost: 250,
    });

    await service.upsertInspectionStatus(estimate.id, {
      inspectionType: "service_release",
      status: "scheduled",
      notes: "Await utility coordination",
      corrections: [],
    });

    const loaded = await service.getEstimateById(estimate.id);
    expect(loaded?.permitStatus?.status).toBe("filed");
    expect(loaded?.permitStatus?.cost).toBe(250);
    expect(loaded?.inspections[0]?.inspectionType).toBe("service_release");
    expect(loaded?.inspections[0]?.status).toBe("scheduled");
  });

  it("records proposal delivery and acceptance tied to estimate revision", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "a3", assemblyNumber: 930, name: "Atomic 3", tier: "atomic", category: "devices" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "a3",
        componentType: "material",
        code: "M3",
        description: "Material",
        quantity: 1,
        unitCost: 45,
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Proposal" });
    const option = await service.addOption(estimate.id, "Option A");
    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "a3" });

    const proposal = await service.generateProposalPdf(estimate.id);
    expect(fs.existsSync(proposal.filePath)).toBe(true);

    await service.changeEstimateStatus(estimate.id, "review");
    await service.changeEstimateStatus(estimate.id, "sent");
    const signature = await service.recordSignature({
      estimateId: estimate.id,
      signerName: "Kyle",
      signatureData: "base64-signature",
      consentText: "I approve this estimate option.",
    });

    const accepted = await service.acceptProposal({
      estimateId: estimate.id,
      optionId: option.id,
      signatureId: signature.id,
    });

    expect(accepted.acceptance.estimateRevision).toBe(1);
    expect(accepted.updatedEstimate.status).toBe("accepted");
    expect(accepted.updatedEstimate.lockedAt).not.toBeNull();
  });

  it("fails proposal acceptance unless estimate is in sent status", async () => {
    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Status Guard" });
    const option = await service.addOption(estimate.id, "Option A");
    const signature = await service.createSignaturePlaceholder(estimate.id);

    await expect(service.acceptProposal({
      estimateId: estimate.id,
      optionId: option.id,
      signatureId: signature.id,
    })).rejects.toThrow(/sent/i);
  });

  it("prevents duplicate acceptance", async () => {
    await seedHttpAtomicTemplate();
    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Duplicate Acceptance" });
    const option = await service.addOption(estimate.id, "Option A");
    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "http-a1" });
    const signature = await service.createSignaturePlaceholder(estimate.id);

    await service.changeEstimateStatus(estimate.id, "review");
    await service.changeEstimateStatus(estimate.id, "sent");
    await service.acceptProposal({ estimateId: estimate.id, optionId: option.id, signatureId: signature.id });

    await expect(service.acceptProposal({
      estimateId: estimate.id,
      optionId: option.id,
      signatureId: signature.id,
    })).rejects.toThrow(/already accepted/i);
  });

  it("supports lifecycle transitions draft-review-sent-accepted and declined-revised-draft", async () => {
    await seedHttpAtomicTemplate();
    const { property, visit } = await bootstrapVisit();

    const acceptedEstimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Lifecycle Accepted" });
    const acceptedOption = await service.addOption(acceptedEstimate.id, "Acceptable Option");
    await service.addAssemblyToOption({ optionId: acceptedOption.id, assemblyTemplateId: "http-a1" });
    const signature = await service.createSignaturePlaceholder(acceptedEstimate.id);

    await service.changeEstimateStatus(acceptedEstimate.id, "review");
    await service.changeEstimateStatus(acceptedEstimate.id, "sent");
    const accepted = await service.acceptProposal({
      estimateId: acceptedEstimate.id,
      optionId: acceptedOption.id,
      signatureId: signature.id,
    });
    expect(accepted.updatedEstimate.status).toBe("accepted");

    const declinedEstimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Lifecycle Declined" });
    const declinedOption = await service.addOption(declinedEstimate.id, "Decline Option");
    await service.addAssemblyToOption({ optionId: declinedOption.id, assemblyTemplateId: "http-a1" });

    await service.changeEstimateStatus(declinedEstimate.id, "review");
    await service.changeEstimateStatus(declinedEstimate.id, "sent");
    const declined = await service.acceptProposal({
      estimateId: declinedEstimate.id,
      optionId: declinedOption.id,
      status: "declined",
    });
    expect(declined.updatedEstimate.status).toBe("declined");

    const revised = await service.changeEstimateStatus(declinedEstimate.id, "revised");
    expect(revised.status).toBe("revised");
    expect(revised.revision).toBe(2);

    const backToDraft = await service.changeEstimateStatus(declinedEstimate.id, "draft");
    expect(backToDraft.status).toBe("draft");
  });

  it("expands corrected #32 package with all required child templates", async () => {
    const requiredChildNumbers = [27, 28, 29, 30, 33, 35, 36, 37, 81, 82, 72];
    await prisma.assemblyTemplate.create({
      data: { id: "asm-032-v1", assemblyNumber: 32, name: "Full Residential Service Upgrade Package", tier: "package", category: "package" },
    });

    for (const number of requiredChildNumbers) {
      const childId = `asm-${String(number).padStart(3, "0")}-v1`;
      await prisma.assemblyTemplate.create({
        data: { id: childId, assemblyNumber: number, name: `Assembly ${number}`, tier: "atomic", category: "service_entrance" },
      });
      await prisma.assemblyTemplateComponent.create({
        data: {
          templateId: childId,
          componentType: "material",
          code: `MAT-${number}`,
          description: `Component ${number}`,
          quantity: 1,
          unitCost: 10,
        },
      });
      await prisma.assemblyTemplateChild.create({
        data: {
          parentTemplateId: "asm-032-v1",
          childTemplateId: childId,
          quantity: 1,
          required: true,
        },
      });
    }

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "#32 Package" });
    const option = await service.addOption(estimate.id, "Package Option");

    const asm = await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "asm-032-v1" });
    expect(asm?.components.length).toBe(requiredChildNumbers.length);
    for (const number of requiredChildNumbers) {
      expect(asm?.components.some((c) => c.code === `MAT-${number}`)).toBe(true);
    }
  }, 30000);

  it("supports core workflow through HTTP routes", async () => {
    await seedHttpAtomicTemplate();

    const customerRes = await request(app).post("/customers").send({
      name: "Route Customer",
      email: "route@example.com",
    });
    expect(customerRes.status).toBe(201);

    const propertyRes = await request(app).post("/properties").send({
      customerId: customerRes.body.id,
      name: "Route Home",
      addressLine1: "321 Route St",
      city: "Vancouver",
      state: "WA",
      postalCode: "98660",
    });
    expect(propertyRes.status).toBe(201);

    const visitRes = await request(app).post("/visits").send({
      propertyId: propertyRes.body.id,
      customerId: customerRes.body.id,
      mode: "service_diagnostic",
      purpose: "Workflow test",
    });
    expect(visitRes.status).toBe(201);

    const estimateRes = await request(app).post("/estimates").send({
      visitId: visitRes.body.id,
      propertyId: propertyRes.body.id,
      title: "HTTP Workflow Estimate",
    });
    expect(estimateRes.status).toBe(201);

    const optionRes = await request(app)
      .post(`/estimates/${estimateRes.body.id}/options`)
      .send({ optionLabel: "Option A" });
    expect(optionRes.status).toBe(201);

    const addAssemblyRes = await request(app)
      .post(`/options/${optionRes.body.id}/assemblies`)
      .send({ assemblyTemplateId: "http-a1", quantity: 1 });
    expect(addAssemblyRes.status).toBe(201);

    const reviewRes = await request(app)
      .post(`/estimates/${estimateRes.body.id}/status`)
      .send({ status: "review" });
    expect(reviewRes.status).toBe(200);

    const sentRes = await request(app)
      .post(`/estimates/${estimateRes.body.id}/status`)
      .send({ status: "sent" });
    expect(sentRes.status).toBe(200);
    expect(sentRes.body.status).toBe("sent");
  });

  it("enforces #25/#70 mutual exclusion but allows same-number duplicates", async () => {
    await prisma.assemblyTemplate.createMany({
      data: [
        { id: "mx-25", assemblyNumber: 25, name: "Panel Circuit Rework / Cleanup", tier: "atomic", category: "panels" },
        { id: "mx-70", assemblyNumber: 70, name: "Rework Existing Panel Conductors", tier: "support", category: "support" },
      ],
    });
    await prisma.assemblyTemplateComponent.createMany({
      data: [
        { templateId: "mx-25", componentType: "material", code: "MX-25", description: "Panel rework material", quantity: 1, unitCost: 50 },
        { templateId: "mx-70", componentType: "labor", code: "MX-70", description: "Conductor rework labor", quantity: 1, laborHours: 1, laborRate: 100 },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Mutual exclusion" });
    const option = await service.addOption(estimate.id, "Option A");

    // Same-number duplicate should remain allowed.
    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "mx-25" });
    await expect(service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "mx-25",
    })).resolves.toBeTruthy();

    // Opposite pair should be blocked.
    await expect(service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "mx-70",
    })).rejects.toThrow(/mutually exclusive/i);

    const optionB = await service.addOption(estimate.id, "Option B");
    await service.addAssemblyToOption({ optionId: optionB.id, assemblyTemplateId: "mx-70" });
    await expect(service.addAssemblyToOption({
      optionId: optionB.id,
      assemblyTemplateId: "mx-70",
    })).resolves.toBeTruthy();

    await expect(service.addAssemblyToOption({
      optionId: optionB.id,
      assemblyTemplateId: "mx-25",
    })).rejects.toThrow(/mutually exclusive/i);
  });

  it("enforces mutual exclusion on update path when conflicting rows already exist", async () => {
    await prisma.assemblyTemplate.createMany({
      data: [
        { id: "mxu-25", assemblyNumber: 25, name: "Panel Circuit Rework / Cleanup", tier: "atomic", category: "panels" },
        { id: "mxu-70", assemblyNumber: 70, name: "Rework Existing Panel Conductors", tier: "support", category: "support" },
      ],
    });
    await prisma.assemblyTemplateComponent.createMany({
      data: [
        { templateId: "mxu-25", componentType: "material", code: "MXU-25", description: "Panel rework", quantity: 1, unitCost: 50 },
        { templateId: "mxu-70", componentType: "labor", code: "MXU-70", description: "Conductor rework", quantity: 1, laborHours: 1, laborRate: 100 },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Mutual exclusion update" });
    const option = await service.addOption(estimate.id, "Option A");
    const primary = await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "mxu-25" });

    await prisma.estimateAssembly.create({
      data: {
        optionId: option.id,
        assemblyTemplateId: "mxu-70",
        quantity: 1,
        parametersJson: JSON.stringify({}),
        modifiersJson: JSON.stringify([]),
        laborCost: 100,
        materialCost: 0,
        otherCost: 0,
        totalCost: 100,
      },
    });

    await expect(service.updateAssembly({
      assemblyId: primary!.id,
      quantity: 1,
    })).rejects.toThrow(/mutually exclusive/i);
  });

  it("normalizes parameter aliases and returns companion suggestions on add", async () => {
    await prisma.assemblyTemplate.createMany({
      data: [
        { id: "rule-017", assemblyNumber: 17, name: "Add Dedicated 120V Circuit", tier: "atomic", category: "circuits" },
        { id: "rule-023", assemblyNumber: 23, name: "Add Breaker to Existing Panel", tier: "atomic", category: "panels" },
        { id: "rule-081", assemblyNumber: 81, name: "Load Calculation / Panel Schedule Review", tier: "support", category: "support" },
      ],
    });

    await prisma.assemblyTemplateComponent.createMany({
      data: [
        { templateId: "rule-017", componentType: "material", code: "R17", description: "Circuit materials", quantity: 1, unitCost: 80 },
        { templateId: "rule-023", componentType: "material", code: "R23", description: "Breaker add material", quantity: 1, unitCost: 40 },
        { templateId: "rule-081", componentType: "labor", code: "R81", description: "Load review labor", quantity: 1, laborHours: 1, laborRate: 120 },
      ],
    });

    await prisma.assemblyParameterDefinition.createMany({
      data: [
        {
          templateId: "rule-017",
          key: "run_length",
          label: "Run Length",
          valueType: "number",
          required: true,
          minValue: 5,
          maxValue: 150,
        },
        {
          templateId: "rule-017",
          key: "breaker_pole_config",
          label: "Breaker Pole Configuration",
          valueType: "enum",
          required: true,
          enumOptionsJson: JSON.stringify(["1_pole", "2_pole"]),
          defaultValueJson: JSON.stringify("1_pole"),
        },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Alias normalization" });
    const option = await service.addOption(estimate.id, "Option A");

    const created = await service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "rule-017",
      parameters: {
        distance: 25,
        pole_count: 2,
      },
    });

    expect(created).toBeTruthy();
    expect(created?.parametersJson).toContain("run_length");
    expect(created?.parametersJson).toContain("2_pole");
    expect(created?.parametersJson).not.toContain("distance");
    expect(created?.companionSuggestions?.some((s: { assemblyNumber: number }) => s.assemblyNumber === 23)).toBe(true);
    expect(created?.companionSuggestions?.some((s: { assemblyNumber: number }) => s.assemblyNumber === 81)).toBe(true);

    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "rule-023" });
    const suggestionsAfterBreaker = await service.getAssemblyCompanionSuggestions({
      optionId: option.id,
      assemblyNumber: 17,
    });
    expect(suggestionsAfterBreaker.some((s) => s.assemblyNumber === 23)).toBe(false);
    expect(suggestionsAfterBreaker.some((s) => s.assemblyNumber === 81)).toBe(true);
  });

  it("returns companion suggestions over HTTP", async () => {
    await prisma.assemblyTemplate.createMany({
      data: [
        { id: "rule-059", assemblyNumber: 59, name: "EV Charger Circuit", tier: "atomic", category: "specialty" },
        { id: "rule2-023", assemblyNumber: 23, name: "Add Breaker to Existing Panel", tier: "atomic", category: "panels" },
        { id: "rule2-081", assemblyNumber: 81, name: "Load Calculation / Panel Schedule Review", tier: "support", category: "support" },
      ],
    });

    await prisma.assemblyTemplateComponent.createMany({
      data: [
        { templateId: "rule-059", componentType: "material", code: "E59", description: "EV material", quantity: 1, unitCost: 300 },
        { templateId: "rule2-023", componentType: "material", code: "E23", description: "Breaker material", quantity: 1, unitCost: 40 },
        { templateId: "rule2-081", componentType: "labor", code: "E81", description: "Calc labor", quantity: 1, laborHours: 1, laborRate: 120 },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "HTTP suggestions",
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const response = await request(app).get(`/options/${option.id}/assembly-suggestions?assemblyNumber=59`);

    expect(response.status).toBe(200);
    expect(response.body.suggestions.some((s: { assemblyNumber: number }) => s.assemblyNumber === 23)).toBe(true);
    expect(response.body.suggestions.some((s: { assemblyNumber: number }) => s.assemblyNumber === 81)).toBe(true);

    const missingParams = await request(app).get(`/options/${option.id}/assembly-suggestions`);
    expect(missingParams.status).toBe(400);

    const nonNumeric = await request(app).get(`/options/${option.id}/assembly-suggestions?assemblyNumber=abc`);
    expect(nonNumeric.status).toBe(400);

    const decimal = await request(app).get(`/options/${option.id}/assembly-suggestions?assemblyNumber=59.5`);
    expect(decimal.status).toBe(400);

    const nonPositive = await request(app).get(`/options/${option.id}/assembly-suggestions?assemblyNumber=0`);
    expect(nonPositive.status).toBe(400);
  });

  it("adds smoke/CO package suggestion for remodel/new-construction room package scope", async () => {
    await prisma.assemblyTemplate.createMany({
      data: [
        { id: "room-095", assemblyNumber: 95, name: "Bedroom Room Package", tier: "package", category: "package" },
        { id: "room-079", assemblyNumber: 79, name: "Smoke/CO Detector Package", tier: "package", category: "package" },
      ],
    });
    await prisma.assemblyTemplateComponent.createMany({
      data: [
        { templateId: "room-095", componentType: "material", code: "RM95", description: "Room package direct", quantity: 1, unitCost: 100 },
        { templateId: "room-079", componentType: "material", code: "RM79", description: "Smoke/CO package", quantity: 1, unitCost: 90 },
      ],
    });

    const customer = await prisma.customer.create({
      data: { name: "Room Customer", email: "room@example.com" },
    });
    const property = await prisma.property.create({
      data: {
        customerId: customer.id,
        name: "Room House",
        addressLine1: "55 Room St",
        city: "Vancouver",
        state: "WA",
        postalCode: "98660",
      },
    });
    await prisma.systemSnapshot.create({
      data: {
        propertyId: property.id,
        deficienciesJson: "[]",
        changeLogJson: "[]",
      },
    });
    const visit = await prisma.visit.create({
      data: {
        propertyId: property.id,
        customerId: customer.id,
        mode: "remodel",
        purpose: "Bedroom addition",
      },
    });
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Room suggestions" });
    const option = await service.addOption(estimate.id, "Option A");

    const beforeAdd = await service.getAssemblyCompanionSuggestions({
      optionId: option.id,
      assemblyNumber: 95,
    });
    expect(beforeAdd.some((s) => s.assemblyNumber === 79)).toBe(true);

    await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "room-079" });
    const afterAdd = await service.getAssemblyCompanionSuggestions({
      optionId: option.id,
      assemblyNumber: 95,
    });
    expect(afterAdd.some((s) => s.assemblyNumber === 79)).toBe(false);
  });

  it("normalizes aliases on updateAssembly path", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "upd-017", assemblyNumber: 17, name: "Update Alias Circuit", tier: "atomic", category: "circuits" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "upd-017",
        componentType: "material",
        code: "UPD-17",
        description: "Circuit material",
        quantity: 1,
        unitCost: 50,
      },
    });
    await prisma.assemblyParameterDefinition.createMany({
      data: [
        {
          templateId: "upd-017",
          key: "run_length",
          label: "Run Length",
          valueType: "number",
          required: true,
          minValue: 5,
          maxValue: 150,
          defaultValueJson: JSON.stringify(15),
        },
        {
          templateId: "upd-017",
          key: "breaker_pole_config",
          label: "Breaker Pole Configuration",
          valueType: "enum",
          required: true,
          enumOptionsJson: JSON.stringify(["1_pole", "2_pole"]),
          defaultValueJson: JSON.stringify("1_pole"),
        },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Update alias" });
    const option = await service.addOption(estimate.id, "Option A");
    const created = await service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "upd-017",
      parameters: { run_length: 15, breaker_pole_config: "1_pole" },
    });

    const updated = await service.updateAssembly({
      assemblyId: created!.id,
      parameters: { distance: 30, pole_count: 2 },
    });

    expect(updated?.parametersJson).toContain("run_length");
    expect(updated?.parametersJson).toContain("2_pole");
    expect(updated?.parametersJson).not.toContain("distance");
  });

  it("includes both package direct components and child components in totals", async () => {
    await prisma.assemblyTemplate.createMany({
      data: [
        { id: "pkg-direct", assemblyNumber: 1500, name: "Package Direct", tier: "package", category: "package" },
        { id: "pkg-child", assemblyNumber: 1501, name: "Package Child", tier: "atomic", category: "devices" },
      ],
    });
    await prisma.assemblyTemplateComponent.createMany({
      data: [
        { templateId: "pkg-direct", componentType: "material", code: "PKG-DIRECT", description: "Package direct allowance", quantity: 1, unitCost: 50 },
        { templateId: "pkg-child", componentType: "material", code: "PKG-CHILD", description: "Child material", quantity: 1, unitCost: 100 },
      ],
    });
    await prisma.assemblyTemplateChild.create({
      data: {
        parentTemplateId: "pkg-direct",
        childTemplateId: "pkg-child",
        quantity: 1,
        required: true,
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Package totals" });
    const option = await service.addOption(estimate.id, "Option A");

    const created = await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "pkg-direct" });
    expect(created?.components.some((c) => c.code === "PKG-DIRECT")).toBe(true);
    expect(created?.components.some((c) => c.code === "PKG-CHILD")).toBe(true);
    expect(created?.totalCost).toBe(150);
  });

  it("auto-seeds assembly catalog when /assemblies is requested and templates are missing", async () => {
    const beforeCount = await prisma.assemblyTemplate.count();
    expect(beforeCount).toBe(0);

    const response = await request(app).get("/assemblies");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    const afterCount = await prisma.assemblyTemplate.count();
    expect(afterCount).toBeGreaterThan(0);
  }, 30000);

  it("returns 400 for Zod validation failures", async () => {
    const response = await request(app).post("/customers").send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
  });

  it("rejects direct draft to sent transition through API", async () => {
    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Draft guard",
      },
    });

    const response = await request(app)
      .post(`/estimates/${estimate.id}/status`)
      .send({ status: "sent" });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Invalid transition/i);
  });

  it("rejects acceptance unless estimate is in sent status", async () => {
    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Acceptance guard",
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const response = await request(app)
      .post(`/estimates/${estimate.id}/acceptance`)
      .send({
        optionId: option.id,
        status: "accepted",
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/must be in 'sent' status/i);
  });

  it("generates and downloads proposal PDF over HTTP", async () => {
    await seedHttpAtomicTemplate();
    const { property, visit } = await bootstrapVisit();

    const estimateRes = await request(app).post("/estimates").send({
      visitId: visit.id,
      propertyId: property.id,
      title: "Proposal HTTP",
    });
    expect(estimateRes.status).toBe(201);

    const optionRes = await request(app)
      .post(`/estimates/${estimateRes.body.id}/options`)
      .send({ optionLabel: "Option A" });
    expect(optionRes.status).toBe(201);

    const addAssemblyRes = await request(app)
      .post(`/options/${optionRes.body.id}/assemblies`)
      .send({ assemblyTemplateId: "http-a1" });
    expect(addAssemblyRes.status).toBe(201);

    const proposalRes = await request(app)
      .post(`/estimates/${estimateRes.body.id}/proposals`)
      .send({});

    expect(proposalRes.status).toBe(201);
    expect(proposalRes.body.deliveryId).toBeTruthy();

    const downloadRes = await request(app).get(`/proposals/${proposalRes.body.deliveryId}/download`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers["content-type"]).toContain("application/pdf");
    expect(downloadRes.headers["content-disposition"]).toContain("attachment");
  }, 30000);

  it("validates change-order route payloads", async () => {
    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "CO validation",
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const response = await request(app)
      .post(`/estimates/${estimate.id}/change-orders`)
      .send({
        parentOptionId: option.id,
        title: "Invalid reason type",
        reasonType: "bad_value",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
  });

  it("seeds realistic first-pass pricing for targeted phase 1 assemblies", async () => {
    await seedAssemblyTemplates(prisma);

    const templates = await prisma.assemblyTemplate.findMany({
      where: {
        assemblyNumber: {
          in: [1, 6, 17, 27, 72, 82],
        },
      },
      include: { components: true },
    });

    const byNumber = new Map(templates.map((t) => [t.assemblyNumber, t]));

    expect(byNumber.get(1)?.components.some((c) => c.componentType === "labor" && c.laborHours === 1.5)).toBe(true);
    expect(
      byNumber
        .get(6)
        ?.components.some((c) => c.componentType === "material" && ["run_length_14_2", "run_length_12_2"].includes(c.quantityExpr ?? "") && c.unitCost > 0),
    ).toBe(true);
    expect(
      byNumber
        .get(17)
        ?.components.some((c) => c.componentType === "labor" && c.quantityExpr === "run_length" && c.laborHours > 0),
    ).toBe(true);
    expect(byNumber.get(27)?.components.some((c) => c.componentType === "material" && c.unitCost >= 1000)).toBe(true);
    expect(byNumber.get(72)?.components.some((c) => c.componentType === "other" && c.unitCost >= 300)).toBe(true);
    expect(byNumber.get(82)?.components.some((c) => c.componentType === "labor" && c.laborHours >= 1.5)).toBe(true);
  }, 30000);

  it("preserves estimate snapshot costs when template pricing changes", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "snapshot-a2", assemblyNumber: 991, name: "Snapshot Assembly", tier: "atomic", category: "devices" },
    });
    await prisma.assemblyTemplateComponent.createMany({
      data: [
        {
          templateId: "snapshot-a2",
          componentType: "material",
          code: "SNAP-MAT",
          description: "Snapshot material",
          quantity: 1,
          unitCost: 100,
        },
        {
          templateId: "snapshot-a2",
          componentType: "labor",
          code: "SNAP-LAB",
          description: "Snapshot labor",
          quantity: 1,
          laborHours: 1,
          laborRate: 100,
        },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Snapshot Check" });
    const option = await service.addOption(estimate.id, "Option A");

    const first = await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "snapshot-a2" });
    expect(first?.totalCost).toBe(200);

    await prisma.assemblyTemplateComponent.updateMany({
      where: { templateId: "snapshot-a2", code: "SNAP-MAT" },
      data: { unitCost: 250 },
    });
    await prisma.assemblyTemplateComponent.updateMany({
      where: { templateId: "snapshot-a2", code: "SNAP-LAB" },
      data: { laborRate: 200 },
    });

    const storedFirst = await prisma.estimateAssembly.findUnique({ where: { id: first!.id } });
    const storedFirstComponents = await prisma.assemblyComponent.findMany({ where: { estimateAssemblyId: first!.id } });
    expect(storedFirst?.totalCost).toBe(200);
    expect(storedFirstComponents.find((c) => c.code === "SNAP-MAT")?.unitCost).toBe(100);
    expect(storedFirstComponents.find((c) => c.code === "SNAP-LAB")?.laborRate).toBe(100);

    const second = await service.addAssemblyToOption({ optionId: option.id, assemblyTemplateId: "snapshot-a2" });
    expect(second?.totalCost).toBe(450);
  });

  it("rejects add-assembly when required parameters are missing", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "param-req", assemblyNumber: 992, name: "Param Required", tier: "atomic", category: "circuits" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "param-req",
        componentType: "material",
        code: "PR-MAT",
        description: "Material",
        quantity: 1,
        unitCost: 10,
      },
    });
    await prisma.assemblyParameterDefinition.create({
      data: {
        templateId: "param-req",
        key: "run_length",
        label: "Run Length",
        valueType: "number",
        required: true,
        minValue: 5,
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Required Params" });
    const option = await service.addOption(estimate.id, "Option A");

    await expect(service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "param-req",
      parameters: {},
    })).rejects.toThrow(/Missing required parameters: run_length/i);
  });

  it("rejects enum values outside allowed options", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "param-enum", assemblyNumber: 993, name: "Param Enum", tier: "atomic", category: "devices" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "param-enum",
        componentType: "material",
        code: "PE-MAT",
        description: "Material",
        quantity: 1,
        unitCost: 10,
      },
    });
    await prisma.assemblyParameterDefinition.create({
      data: {
        templateId: "param-enum",
        key: "wall_type",
        label: "Wall Type",
        valueType: "enum",
        required: true,
        enumOptionsJson: JSON.stringify(["open_framing", "finished_wall"]),
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Enum Params" });
    const option = await service.addOption(estimate.id, "Option A");

    await expect(service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "param-enum",
      parameters: { wall_type: "attic" },
    })).rejects.toThrow(/invalid value/i);
  });

  it("applies parameter defaults and rejects unknown keys", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "param-default", assemblyNumber: 994, name: "Param Defaults", tier: "atomic", category: "devices" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "param-default",
        componentType: "material",
        code: "PD-MAT",
        description: "Material",
        quantity: 1,
        unitCost: 10,
      },
    });
    await prisma.assemblyParameterDefinition.createMany({
      data: [
        {
          templateId: "param-default",
          key: "wall_type",
          label: "Wall Type",
          valueType: "enum",
          required: true,
          enumOptionsJson: JSON.stringify(["open_framing", "finished_wall"]),
          defaultValueJson: JSON.stringify("finished_wall"),
        },
        {
          templateId: "param-default",
          key: "neutral_present",
          label: "Neutral Present",
          valueType: "boolean",
          defaultValueJson: JSON.stringify(true),
        },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await service.createEstimate({ visitId: visit.id, propertyId: property.id, title: "Default Params" });
    const option = await service.addOption(estimate.id, "Option A");

    const created = await service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "param-default",
      parameters: {},
    });

    expect(created).toBeTruthy();
    const stored = await prisma.estimateAssembly.findUnique({ where: { id: created!.id } });
    expect(stored?.parametersJson).toContain("finished_wall");
    expect(stored?.parametersJson).toContain("neutral_present");

    await expect(service.addAssemblyToOption({
      optionId: option.id,
      assemblyTemplateId: "param-default",
      parameters: { unknown_key: 1 },
    })).rejects.toThrow(/Unknown parameters/i);
  });

  it("seeds parameter definitions and variants for A3 target assemblies", async () => {
    await seedAssemblyTemplates(prisma);

    const template = await prisma.assemblyTemplate.findUnique({
      where: { id: "asm-017-v1" },
      include: {
        parameterDefinitions: true,
        variants: true,
      },
    });

    expect(template).toBeTruthy();
    expect(template?.parameterDefinitions.some((d) => d.key === "run_length" && d.required)).toBe(true);
    expect(template?.parameterDefinitions.some((d) => d.key === "ampacity")).toBe(true);
    expect(template?.variants.some((v) => v.variantKey === "project_mode" && v.variantValue === "remodel")).toBe(true);
    expect(template?.variants.some((v) => v.variantKey === "project_mode" && v.variantValue === "new_construction")).toBe(true);
  }, 30000);

  it("seeds parameter and variant metadata for all targeted phase 1 assemblies", async () => {
    await seedAssemblyTemplates(prisma);

    const templates = await prisma.assemblyTemplate.findMany({
      where: { assemblyNumber: { in: [...PHASE_1_TARGETED_ASSEMBLIES] } },
      include: {
        parameterDefinitions: true,
        variants: true,
      },
    });

    expect(templates).toHaveLength(PHASE_1_TARGETED_ASSEMBLIES.length);

    const missingDefinitions = templates
      .filter((template) => template.parameterDefinitions.length === 0)
      .map((template) => template.assemblyNumber)
      .sort((a, b) => a - b);
    const missingVariants = templates
      .filter((template) => template.variants.length === 0)
      .map((template) => template.assemblyNumber)
      .sort((a, b) => a - b);

    expect(missingDefinitions).toEqual([]);
    expect(missingVariants).toEqual([]);
  }, 30000);

  it("defines parent-child-customizer standards for all phase 1 assemblies", () => {
    const expectedAssemblies = [...new Set([...PHASE_1_TARGETED_ASSEMBLIES, ...PACKAGE_SUPPORT_ASSEMBLIES])].sort((a, b) => a - b);
    const roleCatalogNumbers = Object.keys(ASSEMBLY_ROLE_CATALOG)
      .map(Number)
      .sort((a, b) => a - b);

    expect(roleCatalogNumbers).toEqual(expectedAssemblies);

    const coverage = getAssemblyRoleCatalogCoverage();
    expect(coverage.uncoveredNumbers).toEqual([]);
    expect(coverage.withCustomizerRole).toBe(expectedAssemblies.length);

    for (const parentNumber of Object.keys(PARENT_CHILD_SELECTION_STANDARDS).map(Number)) {
      const profile = ASSEMBLY_ROLE_CATALOG[parentNumber];
      expect(profile).toBeTruthy();
      expect(profile.roles).toContain("parent");
      expect(PARENT_CHILD_SELECTION_STANDARDS[parentNumber].childSelections.length).toBeGreaterThan(0);
    }

    expect(PARENT_CHILD_SELECTION_STANDARDS[27]?.optionPresetStrategy).toBe("good_better_best");
    expect(PARENT_CHILD_SELECTION_STANDARDS[32]?.optionPresetStrategy).toBe("good_better_best");
    expect(PARENT_CHILD_SELECTION_STANDARDS[89]?.optionPresetStrategy).toBe("good_better_best");
  });

  it("adds parameterized assembly through HTTP with valid payload", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "param-http-ok", assemblyNumber: 995, name: "HTTP Param OK", tier: "atomic", category: "circuits" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "param-http-ok",
        componentType: "material",
        code: "PHO-MAT",
        description: "Material",
        quantity: 1,
        unitCost: 10,
      },
    });
    await prisma.assemblyParameterDefinition.createMany({
      data: [
        {
          templateId: "param-http-ok",
          key: "run_length",
          label: "Run Length",
          valueType: "number",
          required: true,
          minValue: 5,
          maxValue: 100,
        },
        {
          templateId: "param-http-ok",
          key: "wall_type",
          label: "Wall Type",
          valueType: "enum",
          required: true,
          enumOptionsJson: JSON.stringify(["open_framing", "finished_wall"]),
          defaultValueJson: JSON.stringify("finished_wall"),
        },
      ],
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "HTTP parameter flow",
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const response = await request(app)
      .post(`/options/${option.id}/assemblies`)
      .send({
        assemblyTemplateId: "param-http-ok",
        quantity: 1,
        parameters: {
          run_length: 25,
          wall_type: "open_framing",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.parametersJson).toContain("run_length");
    expect(response.body.parametersJson).toContain("open_framing");
  });

  it("surfaces backend parameter validation errors over HTTP", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "param-http-error", assemblyNumber: 996, name: "HTTP Param Error", tier: "atomic", category: "circuits" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "param-http-error",
        componentType: "material",
        code: "PHE-MAT",
        description: "Material",
        quantity: 1,
        unitCost: 10,
      },
    });
    await prisma.assemblyParameterDefinition.create({
      data: {
        templateId: "param-http-error",
        key: "run_length",
        label: "Run Length",
        valueType: "number",
        required: true,
        minValue: 5,
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "HTTP parameter error",
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const response = await request(app)
      .post(`/options/${option.id}/assemblies`)
      .send({
        assemblyTemplateId: "param-http-error",
        quantity: 1,
        parameters: {},
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Missing required parameters/i);
  });

  it("preserves non-parameterized assembly add behavior over HTTP", async () => {
    await prisma.assemblyTemplate.create({
      data: { id: "param-http-none", assemblyNumber: 997, name: "HTTP Param None", tier: "atomic", category: "devices" },
    });
    await prisma.assemblyTemplateComponent.create({
      data: {
        templateId: "param-http-none",
        componentType: "material",
        code: "PHN-MAT",
        description: "Material",
        quantity: 1,
        unitCost: 10,
      },
    });

    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "HTTP no param flow",
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const response = await request(app)
      .post(`/options/${option.id}/assemblies`)
      .send({
        assemblyTemplateId: "param-http-none",
        quantity: 1,
      });

    expect(response.status).toBe(201);
    expect(response.body.assemblyTemplateId).toBe("param-http-none");
  });

  it("edits assessment entities over HTTP", async () => {
    const { visit } = await bootstrapVisit();

    const requestCreated = await request(app)
      .post(`/visits/${visit.id}/customer-request`)
      .send({ requestText: "Replace failed breaker", urgency: "high" });
    expect(requestCreated.status).toBe(201);

    const requestUpdated = await request(app)
      .patch(`/visits/${visit.id}/customer-request`)
      .send({ requestText: "Replace breaker and inspect panel", urgency: "medium" });
    expect(requestUpdated.status).toBe(200);
    expect(requestUpdated.body.requestText).toContain("inspect panel");

    const observation = await request(app)
      .post(`/visits/${visit.id}/observations`)
      .send({ observationText: "Panel has scorch marks", location: "garage" });
    expect(observation.status).toBe(201);

    const observationUpdated = await request(app)
      .patch(`/visits/${visit.id}/observations/${observation.body.id}`)
      .send({ observationText: "Panel has heat discoloration", location: "garage wall" });
    expect(observationUpdated.status).toBe(200);
    expect(observationUpdated.body.observationText).toContain("heat discoloration");

    const finding = await request(app)
      .post(`/visits/${visit.id}/findings`)
      .send({ findingText: "Double-tapped breaker", confidence: "medium" });
    expect(finding.status).toBe(201);

    const findingUpdated = await request(app)
      .patch(`/visits/${visit.id}/findings/${finding.body.id}`)
      .send({ findingText: "Double-tapped breaker confirmed", confidence: "high" });
    expect(findingUpdated.status).toBe(200);
    expect(findingUpdated.body.confidence).toBe("high");

    const limitation = await request(app)
      .post(`/visits/${visit.id}/limitations`)
      .send({ limitationText: "Attic inaccessible" });
    expect(limitation.status).toBe(201);

    const limitationUpdated = await request(app)
      .patch(`/visits/${visit.id}/limitations/${limitation.body.id}`)
      .send({ limitationText: "Attic partially inaccessible" });
    expect(limitationUpdated.status).toBe(200);

    const recommendation = await request(app)
      .post(`/visits/${visit.id}/recommendations`)
      .send({ recommendationText: "Replace main panel", priority: "Priority 1" });
    expect(recommendation.status).toBe(201);

    const recommendationUpdated = await request(app)
      .patch(`/visits/${visit.id}/recommendations/${recommendation.body.id}`)
      .send({ recommendationText: "Replace main panel with 200A unit", priority: "Priority 1" });
    expect(recommendationUpdated.status).toBe(200);
    expect(recommendationUpdated.body.recommendationText).toContain("200A");
  });

  it("deletes assessment entities over HTTP", async () => {
    const { visit } = await bootstrapVisit();

    const observation = await request(app)
      .post(`/visits/${visit.id}/observations`)
      .send({ observationText: "Existing splice", location: "attic" });
    const finding = await request(app)
      .post(`/visits/${visit.id}/findings`)
      .send({ findingText: "Open splice", confidence: "high" });
    const limitation = await request(app)
      .post(`/visits/${visit.id}/limitations`)
      .send({ limitationText: "No crawl access" });
    const recommendation = await request(app)
      .post(`/visits/${visit.id}/recommendations`)
      .send({ recommendationText: "Install junction box", priority: "Priority 2" });

    expect((await request(app).delete(`/visits/${visit.id}/observations/${observation.body.id}`)).status).toBe(204);
    expect((await request(app).delete(`/visits/${visit.id}/findings/${finding.body.id}`)).status).toBe(204);
    expect((await request(app).delete(`/visits/${visit.id}/limitations/${limitation.body.id}`)).status).toBe(204);
    expect((await request(app).delete(`/visits/${visit.id}/recommendations/${recommendation.body.id}`)).status).toBe(204);

    const refreshed = await request(app).get(`/visits/${visit.id}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.observations).toHaveLength(0);
    expect(refreshed.body.findings).toHaveLength(0);
    expect(refreshed.body.limitations).toHaveLength(0);
    expect(refreshed.body.recommendations).toHaveLength(0);
  });

  it("deletes estimate assemblies and recalculates option totals", async () => {
    await seedHttpAtomicTemplate();
    const { property, visit } = await bootstrapVisit();

    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Assembly Delete Recalc",
        materialMarkupPct: 0,
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const a1 = await request(app)
      .post(`/options/${option.id}/assemblies`)
      .send({ assemblyTemplateId: "http-a1", quantity: 1 });
    const a2 = await request(app)
      .post(`/options/${option.id}/assemblies`)
      .send({ assemblyTemplateId: "http-a1", quantity: 2 });

    expect(a1.status).toBe(201);
    expect(a2.status).toBe(201);

    const deleted = await request(app).delete(`/assemblies/${a2.body.id}`);
    expect(deleted.status).toBe(204);

    const updatedOption = await prisma.estimateOption.findUnique({ where: { id: option.id } });
    expect(updatedOption?.totalCost).toBe(a1.body.totalCost);
  });

  it("blocks option and assembly edits when estimate is accepted/locked", async () => {
    await seedHttpAtomicTemplate();
    const { property, visit } = await bootstrapVisit();

    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Lock Guard",
      },
    });
    const option = await prisma.estimateOption.create({
      data: {
        estimateId: estimate.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const assembly = await request(app)
      .post(`/options/${option.id}/assemblies`)
      .send({ assemblyTemplateId: "http-a1", quantity: 1 });
    expect(assembly.status).toBe(201);

    await request(app).post(`/estimates/${estimate.id}/status`).send({ status: "review" });
    await request(app).post(`/estimates/${estimate.id}/status`).send({ status: "sent" });
    const accepted = await request(app)
      .post(`/estimates/${estimate.id}/acceptance`)
      .send({ optionId: option.id, status: "accepted" });
    expect(accepted.status).toBe(201);

    const optionPatch = await request(app)
      .patch(`/options/${option.id}`)
      .send({ optionLabel: "Updated Label" });
    expect(optionPatch.status).toBe(409);

    const assemblyDelete = await request(app).delete(`/assemblies/${assembly.body.id}`);
    expect(assemblyDelete.status).toBe(409);
    expect(optionPatch.body.error).toMatch(/locked/i);
    expect(assemblyDelete.body.error).toMatch(/locked/i);
  });

  it("supports option edit/delete and allows clearing all options", async () => {
    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Option Edit Delete",
      },
    });

    const optionA = await request(app)
      .post(`/estimates/${estimate.id}/options`)
      .send({ optionLabel: "Option A", description: "Base" });
    const optionB = await request(app)
      .post(`/estimates/${estimate.id}/options`)
      .send({ optionLabel: "Option B", description: "Alt" });
    expect(optionA.status).toBe(201);
    expect(optionB.status).toBe(201);

    const updated = await request(app)
      .patch(`/options/${optionA.body.id}`)
      .send({ optionLabel: "Option A Updated", description: "Updated" });
    expect(updated.status).toBe(200);
    expect(updated.body.optionLabel).toContain("Updated");

    const deleted = await request(app).delete(`/options/${optionB.body.id}`);
    expect(deleted.status).toBe(204);

    const deleteLast = await request(app).delete(`/options/${optionA.body.id}`);
    expect(deleteLast.status).toBe(204);

    const estimateAfterDeletes = await request(app).get(`/estimates/${estimate.id}`);
    expect(estimateAfterDeletes.status).toBe(200);
    expect(Array.isArray(estimateAfterDeletes.body.options)).toBe(true);
    expect(estimateAfterDeletes.body.options).toHaveLength(0);

    const invalidAssemblyPatch = await request(app)
      .patch("/assemblies/does-not-matter")
      .send({ quantity: 0 });
    expect(invalidAssemblyPatch.status).toBe(400);
  });

  it("deletes non-accepted estimates, allows deleting malformed accepted estimates, and blocks deleting accepted estimates with options", async () => {
    const { property, visit } = await bootstrapVisit();

    const draftEstimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Draft To Delete",
        status: "draft",
      },
    });

    const deletedDraft = await request(app).delete(`/estimates/${draftEstimate.id}`);
    expect(deletedDraft.status).toBe(204);

    const deletedDraftCheck = await prisma.estimate.findUnique({ where: { id: draftEstimate.id } });
    expect(deletedDraftCheck).toBeNull();

    const reviewEstimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Review Estimate",
        status: "review",
      },
    });

    const deletedReview = await request(app).delete(`/estimates/${reviewEstimate.id}`);
    expect(deletedReview.status).toBe(204);

    const deletedReviewCheck = await prisma.estimate.findUnique({ where: { id: reviewEstimate.id } });
    expect(deletedReviewCheck).toBeNull();

    const acceptedEstimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Accepted Estimate",
        status: "accepted",
      },
    });

    const deletedMalformedAccepted = await request(app).delete(`/estimates/${acceptedEstimate.id}`);
    expect(deletedMalformedAccepted.status).toBe(204);

    const acceptedWithOption = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Accepted With Option",
        status: "accepted",
      },
    });
    await prisma.estimateOption.create({
      data: {
        estimateId: acceptedWithOption.id,
        optionLabel: "Option A",
        sortOrder: 0,
      },
    });

    const blockedDelete = await request(app).delete(`/estimates/${acceptedWithOption.id}`);
    expect(blockedDelete.status).toBe(409);
    expect(blockedDelete.body.error).toMatch(/accepted estimates cannot be deleted/i);

    const stillExists = await prisma.estimate.findUnique({ where: { id: acceptedWithOption.id } });
    expect(stillExists).not.toBeNull();
  });

  it("blocks direct status transition to accepted", async () => {
    const { property, visit } = await bootstrapVisit();
    const estimate = await prisma.estimate.create({
      data: {
        visitId: visit.id,
        propertyId: property.id,
        title: "Direct Accepted Block",
        status: "sent",
      },
    });

    const response = await request(app)
      .post(`/estimates/${estimate.id}/status`)
      .send({ status: "accepted" });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/use proposal acceptance flow/i);
  });
});
