import { useMemo, useState } from 'react'
import { checklist } from './data/checklist'
import { jurisdictions } from './data/jurisdictions'
import { saveDraft } from './db/database'
import { queueInspectionSync } from './lib/crmSync'
import { buildReport } from './domain/report'
import { scoreInspection } from './domain/scoring'
import type { Inspection, InspectionLoadCalc, ItemResult, Property } from './domain/types'
import { ChecklistScreen } from './ui/screens/ChecklistScreen'
import { ItemCardScreen } from './ui/screens/ItemCardScreen'
import { JurisdictionScreen } from './ui/screens/JurisdictionScreen'
import { PropertyScreen } from './ui/screens/PropertyScreen'
import { ReportScreen } from './ui/screens/ReportScreen'
import { ReviewScreen } from './ui/screens/ReviewScreen'

type Screen = 'property' | 'jurisdiction' | 'checklist' | 'item' | 'review' | 'report'

interface Session {
  inspectionId: string
  property: Property
  technician: string
  results: Record<string, ItemResult>
  loadCalc?: InspectionLoadCalc
}

function toInspection(session: Session, status: 'draft' | 'complete', contractorReviewed = false): Inspection {
  const items = Object.values(session.results)
  const score = scoreInspection({
    id: session.inspectionId,
    propertyId: session.property.id,
    jurisdictionId: session.property.jurisdictionId,
    technician: session.technician,
    date: new Date().toISOString(),
    items,
    score: 0,
    itemsAssessed: 0,
    criticalFindings: [],
    contractorReviewed,
    status,
  })
  return {
    id: session.inspectionId,
    propertyId: session.property.id,
    jurisdictionId: session.property.jurisdictionId,
    technician: session.technician,
    date: new Date().toISOString(),
    items,
    score: score.score,
    itemsAssessed: score.itemsAssessed,
    criticalFindings: score.criticalFindings,
    contractorReviewed,
    status,
    loadCalc: session.loadCalc,
  }
}

function App({ justEnrolled = false }: { justEnrolled?: boolean }) {
  const [screen, setScreen] = useState<Screen>('property')
  const [session, setSession] = useState<Session | null>(null)
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const [completed, setCompleted] = useState<Inspection | null>(null)

  const profile = useMemo(
    () => jurisdictions.find((j) => j.id === session?.property.jurisdictionId),
    [session],
  )

  const visibleItems = useMemo(
    () =>
      checklist.filter(
        (item) => item.id[0] !== 'I' || (profile?.metroAmendments ?? false),
      ),
    [profile],
  )

  if (screen === 'property' || !session || !profile) {
    return (
      <PropertyScreen
        justEnrolled={justEnrolled}
        onStart={(property, technician) => {
          setSession({
            inspectionId: crypto.randomUUID(),
            property,
            technician,
            results: {},
          })
          setCompleted(null)
          setScreen('jurisdiction')
        }}
      />
    )
  }

  if (screen === 'jurisdiction') {
    return (
      <JurisdictionScreen
        profile={profile}
        onConfirm={() => setScreen('checklist')}
        onBack={() => setScreen('property')}
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
          existingLoadCalc={item.id === 'A2' ? session.loadCalc : undefined}
          onBack={() => setScreen('checklist')}
          onSave={(result, loadCalc) => {
            const next: Session = {
              ...session,
              results: { ...session.results, [result.itemId]: result },
              loadCalc: loadCalc ?? session.loadCalc,
            }
            setSession(next)
            void saveDraft(toInspection(next, 'draft'))
            setScreen('checklist')
          }}
        />
      )
    }
  }

  if (screen === 'review') {
    const draft = toInspection(session, 'draft')
    return (
      <ReviewScreen
        results={session.results}
        score={scoreInspection(draft)}
        onBack={() => setScreen('checklist')}
        onComplete={(contractorReviewed) => {
          const final = toInspection(session, 'complete', contractorReviewed)
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
        report={buildReport(completed, profile)}
        inspection={completed}
        property={session.property}
        onNewInspection={() => {
          setSession(null)
          setScreen('property')
        }}
      />
    )
  }

  return (
    <ChecklistScreen
      items={visibleItems}
      results={session.results}
      onOpenItem={(itemId) => {
        setActiveItemId(itemId)
        setScreen('item')
      }}
      onReview={() => setScreen('review')}
    />
  )
}

export default App
