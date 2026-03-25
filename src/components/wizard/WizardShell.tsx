import { ArrowLeft, ArrowRight } from 'lucide-react'
import { UnifiedFooter, FOOTER_HEIGHT_CLASS } from '../layout/UnifiedFooter'

interface WizardShellProps {
  title: string
  currentStep: number
  totalSteps: number
  onBack: () => void
  onNext: () => void
  canGoNext?: boolean
  isLastStep?: boolean
  children: React.ReactNode
}

export function WizardShell({
  title,
  currentStep,
  totalSteps,
  onBack,
  onNext,
  canGoNext = true,
  isLastStep = false,
  children,
}: WizardShellProps) {
  return (
    <div className={`min-h-screen bg-bg-page flex flex-col ${FOOTER_HEIGHT_CLASS}`}>
      {/* Progress bar */}
      <div className="w-full bg-border-default h-1">
        <div
          className="h-1 transition-all duration-300"
          style={{
            width: `${((currentStep + 1) / totalSteps) * 100}%`,
            background: 'linear-gradient(to right, var(--color-primary, {{PRIMARY_COLOR}}), var(--color-primary-alt, {{PRIMARY_COLOR}}))',
          }}
        />
      </div>

      {/* Header */}
      <div className="px-4 py-6 border-b border-border-default">
        <h1 className="text-2xl font-bold text-text-primary">{title}</h1>
        <p className="text-sm text-text-secondary mt-1">
          Step {currentStep + 1} of {totalSteps}
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 px-4 py-8 max-w-lg mx-auto w-full">
        {children}
      </div>

      {/* Step dots */}
      <div className="flex justify-center gap-2 py-4">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <div
            key={i}
            className={`w-2.5 h-2.5 rounded-full transition-colors ${
              i <= currentStep ? 'bg-primary' : 'bg-border-default'
            }`}
          />
        ))}
      </div>

      {/* Navigation buttons */}
      <UnifiedFooter>
        <div className="flex justify-between">
          <button
            onClick={onBack}
            disabled={currentStep === 0}
            className="flex items-center gap-2 px-4 py-2 text-text-secondary hover:text-text-primary disabled:opacity-30"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <button
            onClick={onNext}
            disabled={!canGoNext}
            className="flex items-center gap-2 px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            {isLastStep ? 'Complete' : 'Next'}
            {!isLastStep && <ArrowRight className="w-4 h-4" />}
          </button>
        </div>
      </UnifiedFooter>
    </div>
  )
}
