import { useEffect, useMemo, useState } from 'react'
import { checklist, subPanelInstanceDef, subPanelSlug } from './data/checklist'
import { jurisdictions } from './data/jurisdictions'
import { saveDraft, type FindingRecord } from './db/database'
import { cachedMe, fetchPropertyFindings, propertyForAssignment, queueInspectionSync } from './lib/crmSync'
import { buildReport } from './domain/report'
import { summarizeFindings } from './domain/findings'
import type {
  ChecklistItemDef, CrmAssignment, CustomerAcknowledgment, Inspection, InspectionLoadCalc,
  ItemResult, Property, SectionNote,
} from './domain/types'
import { AssignmentScreen } from './ui/screens/AssignmentScreen'
import { CapacityCheckScreen } from './ui/screens/CapacityCheckScreen'
import { ChecklistScreen } from './ui/screens/ChecklistScreen'
import { ItemCardScreen } from './ui/screens/ItemCardScreen'
import { JurisdictionScreen } from './ui/screens/JurisdictionScreen'
import { OpenFindingsScreen } from './ui/screens/OpenFindingsScreen'
import { ReportScreen } from './ui/screens/ReportScreen'
import { ReviewScreen } from './ui/screens/ReviewScreen'
import { V2CaptureScreen } from './ui/screens/V2CaptureScreen'
import { JobSiteScreen } from './ui/screens/JobSiteScreen'
import { MyAccountsScreen } from './ui/screens/MyAccountsScreen'
import { emptyV2Capture, type V2Capture } from './domain/v2Types'
import { checkCapture } from './domain/v2Rules'

type Screen =
  | 'assignment' | 'jobsite' | 'jurisdiction' | 'checklist' | 'item' | 'review' | 'report'
  | 'findings' | 'capacity' | 'v2capture' | 'accounts'

interface Session {
  inspectionId: string
  property: Property
  technician: string
  results: Record<string, ItemResult>
  loadCalc?: InspectionLoadCalc
  v2?: V2Capture
  /** Per-section notes, keyed by group (2026-08-24). */
  sectionNotes?: Record<string, SectionNote>
  /**
   * Location labels of added sub-panels ("Garage", "Barn"), in the order added.
   * Each becomes a full Interior Panel / Sub-Panel row (Kyle, 2026-08-26).
   */
  subPanels?: string[]
}

function toInspection(
  session: Session,
  status: 'draft' | 'complete',
  contractorReviewed = false,
  visibleItems: ChecklistItemDef[] = [],
  ack?: { acknowledgment?: CustomerAcknowledgment; ackSkippedReason?: string },
): Inspection {
  const items = Object.values(session.results)
  const sectionNotes = Object.values(session.sectionNotes ?? {}).filter((n) => n.note.trim())
  const base: Inspection = {
    id: session.inspectionId,
    propertyId: session.property.id,
    jurisdictionId: session.property.jurisdictionId,
    technician: session.technician,
    date: new Date().toISOString(),
    items,
    scope: 'full',
    itemsAssessed: items.length,
    criticalFindings: [],
    contractorReviewed,
    status,
    loadCalc: session.loadCalc,
    v2: session.v2,
    ...(sectionNotes.length > 0 ? { sectionNotes } : {}),
    ...(ack?.acknowledgment ? { acknowledgment: ack.acknowledgment } : {}),
    ...(ack?.ackSkippedReason ? { ackSkippedReason: ack.ackSkippedReason } : {}),
  }
  const summary = summarizeFindings(base, visibleItems)
  return { ...base, itemsAssessed: summary.itemsAssessed, criticalFindings: summary.criticalFindings }
}

/**
 * Stamp a sub-panel instance result with its location label, so the office and
 * the customer report can say "Sub-panel — Garage" without the checklist def.
 */
function locateResult(result: ItemResult, subPanels: string[] | undefined): ItemResult {
  if (!result.itemId.startsWith('SUB:')) return result
  const slug = result.itemId.slice('SUB:'.length)
  const label = (subPanels ?? []).find((name) => subPanelSlug(name) === slug)
  return label ? { ...result, locationId: label } : result
}

function App({ justEnrolled = false }: { justEnrolled?: boolean }) {
  const [screen, setScreen] = useState<Screen>('assignment')
  const [session, setSession] = useState<Session | null>(null)
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const [completed, setCompleted] = useState<Inspection | null>(null)
  const [findings, setFindings] = useState<FindingRecord[]>([])
  const [capacityAssignment, setCapacityAssignment] = useState<CrmAssignment | null>(null)
  /** The visit whose job site is open (Phase 2). */
  const [activeAssignment, setActiveAssignment] = useState<CrmAssignment | null>(null)

  // Pull the ledger once when a job starts, so every item card can show what was
  // already documented here without another round trip on a phone.
  const propertyId = session?.property.crm.propertyId
  useEffect(() => {
    if (!propertyId) {
      setFindings([])
      return
    }
    let cancelled = false
    void fetchPropertyFindings(propertyId).then((result) => {
      if (!cancelled) setFindings(result.findings)
    })
    return () => { cancelled = true }
  }, [propertyId])

  const findingByItem = useMemo(() => {
    const map = new Map<string, FindingRecord>()
    for (const finding of findings) {
      // Live findings win over declined ones — if both exist for an item, what
      // is currently outstanding is the more useful thing to show.
      const existing = map.get(finding.itemId)
      if (!existing || (existing.status === 'declined' && finding.status !== 'declined')) {
        map.set(finding.itemId, finding)
      }
    }
    return map
  }, [findings])

  const profile = useMemo(
    () => jurisdictions.find((j) => j.id === session?.property.jurisdictionId),
    [session],
  )

  // The nine consolidated rows, with one extra Interior Panel / Sub-Panel row
  // per added location, inserted right after the base SUB row.
  const subPanels = session?.subPanels
  const visibleItems = useMemo(() => {
    const extras = (subPanels ?? []).map(subPanelInstanceDef)
    if (extras.length === 0) return checklist
    const items: ChecklistItemDef[] = []
    for (const item of checklist) {
      items.push(item)
      if (item.id === 'SUB') items.push(...extras)
    }
    return items
  }, [subPanels])

  // Before the !session guard on purpose: the capacity check is what a
  // technician runs on an ordinary service call, with no assessment open.
  if (screen === 'capacity') {
    return (
      <CapacityCheckScreen
        assignment={capacityAssignment ?? undefined}
        onBack={() => setScreen(activeAssignment ? 'jobsite' : session ? 'checklist' : 'assignment')}
      />
    )
  }

  // The job site (Phase 2): the day's verbs for one visit. Also before the
  // session guard — most of a job day never opens an assessment.
  if (screen === 'jobsite' && activeAssignment) {
    return (
      <JobSiteScreen
        assignment={activeAssignment}
        onBack={() => { setActiveAssignment(null); setScreen('assignment') }}
        onCapacityCheck={() => {
          setCapacityAssignment(activeAssignment)
          setScreen('capacity')
        }}
        onRunAssessment={() => {
          void (async () => {
            const property = await propertyForAssignment(activeAssignment)
            const me = await cachedMe()
            setSession({
              inspectionId: crypto.randomUUID(),
              property,
              technician: me?.name ?? 'Unknown technician',
              results: {},
            })
            setCompleted(null)
            setScreen('jurisdiction')
          })()
        }}
      />
    )
  }

  // My accounts (2026-09-01) — like the capacity check, this is an ordinary
  // tech verb that needs no assessment session open.
  if (screen === 'accounts') {
    return <MyAccountsScreen onBack={() => setScreen('assignment')} />
  }

  if (screen === 'assignment' || !session || !profile) {
    return (
      <AssignmentScreen
        justEnrolled={justEnrolled}
        onOpenVisit={(assignment) => {
          setActiveAssignment(assignment)
          setScreen('jobsite')
        }}
        onOpenAccounts={() => setScreen('accounts')}
      />
    )
  }

  if (screen === 'jurisdiction') {
    return (
      <JurisdictionScreen
        profile={profile}
        source={session.property.jurisdictionSource}
        address={session.property.address}
        onConfirm={() => setScreen('checklist')}
        onBack={() => setScreen('assignment')}
      />
    )
  }

  if (screen === 'findings') {
    return (
      <OpenFindingsScreen
        propertyId={session.property.crm.propertyId}
        addressLabel={session.property.address}
        visitId={session.property.crm.visitId}
        onBack={() => setScreen('checklist')}
      />
    )
  }

  if (screen === 'v2capture') {
    return (
      <V2CaptureScreen
        capture={session.v2 ?? emptyV2Capture()}
        onChange={(v2) => {
          const next: Session = { ...session, v2 }
          setSession(next)
          void saveDraft(toInspection(next, 'draft', false, visibleItems))
        }}
        onBack={() => setScreen('checklist')}
      />
    )
  }

  if (screen === 'item' && activeItemId) {
    const item = visibleItems.find((i) => i.id === activeItemId)
    if (item) {
      return (
        <ItemCardScreen
          item={item}
          existing={session.results[item.id]}
          // Lets a formula read a value already recorded on another item, so the
          // technician never types the same measurement twice.
          otherResults={session.results}
          openFinding={findingByItem.get(item.id)}
          existingLoadCalc={item.id === 'LOAD' ? session.loadCalc : undefined}
          // Persist the calc the moment Apply is tapped — waiting for the item
          // save silently lost the calculation when the tech backed out
          // (Kyle's Caysens record, 2026-08-29, synced with no load calc).
          onLoadCalcApplied={(record) => {
            const next: Session = { ...session, loadCalc: record }
            setSession(next)
            void saveDraft(toInspection(next, 'draft', false, visibleItems))
          }}
          onBack={() => setScreen('checklist')}
          onSave={(result, loadCalc) => {
            const withLocation = locateResult(result, session.subPanels)
            const next: Session = {
              ...session,
              results: { ...session.results, [withLocation.itemId]: withLocation },
              loadCalc: loadCalc ?? session.loadCalc,
            }
            setSession(next)
            void saveDraft(toInspection(next, 'draft', false, visibleItems))
            setScreen('checklist')
          }}
        />
      )
    }
  }

  if (screen === 'review') {
    const draft = toInspection(session, 'draft', false, visibleItems)
    return (
      <ReviewScreen
        results={session.results}
        summary={summarizeFindings(draft, visibleItems)}
        onBack={() => setScreen('checklist')}
        onComplete={(contractorReviewed, ack) => {
          // The server would 422 a v2 violation at sync time; catching it here
          // keeps the inspection out of a stuck offline queue (§12.3 mirror).
          const v2Violations = session.v2 ? checkCapture(session.v2) : []
          if (v2Violations.length > 0) {
            window.alert(
              `Panel & component capture has ${v2Violations.length} issue(s) that would block sync:\n\n` +
                v2Violations.map((v) => `• ${v.message}`).join('\n'),
            )
            setScreen('v2capture')
            return
          }
          const final = toInspection(session, 'complete', contractorReviewed, visibleItems, ack)
          void saveDraft(final) // transitions the draft to its immutable completed version
          void queueInspectionSync(final, session.property) // auto-push to the CRM (queued offline)
          setCompleted(final)
          setScreen('report')
        }}
      />
    )
  }

  if (screen === 'report' && completed) {
    return (
      <ReportScreen
        report={buildReport(completed, profile, visibleItems)}
        inspection={completed}
        property={session.property}
        onNewInspection={() => {
          setSession(null)
          setScreen('assignment')
        }}
      />
    )
  }

  return (
    <ChecklistScreen
      items={visibleItems}
      results={session.results}
      knownFindingCount={findings.filter((f) => f.status !== 'declined').length}
      declinedFindingCount={findings.filter((f) => f.status === 'declined').length}
      v2Summary={{ enclosures: session.v2?.enclosures.length ?? 0, items: session.v2?.items.length ?? 0 }}
      sectionNotes={session.sectionNotes}
      onSectionNote={(group, note, includeOnReport) => {
        const next: Session = {
          ...session,
          sectionNotes: { ...session.sectionNotes, [group]: { group, note, includeOnReport } },
        }
        setSession(next)
        void saveDraft(toInspection(next, 'draft', false, visibleItems))
      }}
      onOpenFindings={() => setScreen('findings')}
      onOpenV2={() => setScreen('v2capture')}
      onAddSubPanel={(label) => {
        const trimmed = label.trim()
        if (!trimmed) return
        // Same slug twice would collide on one results key — silently keep the first.
        const existing = session.subPanels ?? []
        if (existing.some((name) => subPanelSlug(name) === subPanelSlug(trimmed))) return
        const next: Session = { ...session, subPanels: [...existing, trimmed] }
        setSession(next)
        void saveDraft(toInspection(next, 'draft', false, visibleItems))
      }}
      onOpenItem={(itemId) => {
        setActiveItemId(itemId)
        setScreen('item')
      }}
      onQuickResult={(itemId, grade) => {
        // Tap-to-grade (Kyle, 2026-08-24). A grade over an item the card already
        // detailed changes only the verdict — measurements and photos survive.
        const results = { ...session.results }
        if (grade === null) {
          delete results[itemId]
        } else {
          const existing = results[itemId]
          results[itemId] = existing
            ? { ...existing, result: grade }
            : locateResult({ itemId, result: grade, measured: {}, photoIds: [] }, session.subPanels)
        }
        const next: Session = { ...session, results }
        setSession(next)
        void saveDraft(toInspection(next, 'draft', false, visibleItems))
      }}
      onReview={() => setScreen('review')}
    />
  )
}

export default App
