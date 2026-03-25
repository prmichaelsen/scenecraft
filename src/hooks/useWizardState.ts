import { useState, useEffect, useCallback, useRef } from 'react'

interface UseWizardStateOptions<
  TSteps extends readonly string[],
  TFormData extends Record<string, unknown>,
> {
  storageKey: string
  steps: TSteps
  defaultFormData: TFormData
  searchStep: string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigate: (opts: any) => any
}

export function useWizardState<
  TSteps extends readonly string[],
  TFormData extends Record<string, unknown>,
>({
  storageKey,
  steps,
  defaultFormData,
  searchStep,
  navigate,
}: UseWizardStateOptions<TSteps, TFormData>) {
  const stepsRef = useRef(steps)

  // Resolve initial step index from URL
  const resolveStepIndex = useCallback(
    (stepName: string | undefined): number => {
      if (!stepName) return 0
      const idx = stepsRef.current.indexOf(stepName)
      return idx >= 0 ? idx : 0
    },
    [],
  )

  const [currentStep, setCurrentStep] = useState(() => resolveStepIndex(searchStep))
  const [formData, setFormDataState] = useState<TFormData>(() => ({ ...defaultFormData }))
  const hydratedRef = useRef(false)

  // Rehydrate form data from sessionStorage on client mount
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        const persisted = (parsed.data ?? {}) as Partial<TFormData>
        if (Object.keys(persisted).length > 0) {
          setFormDataState((prev) => ({ ...prev, ...persisted }))
        }
      }
    } catch {
      // sessionStorage unavailable or corrupt
    }
  }, [storageKey])

  // Sync URL on mount if step param is missing or invalid
  useEffect(() => {
    const idx = resolveStepIndex(searchStep)
    const expectedName = stepsRef.current[idx]
    if (searchStep !== expectedName) {
      navigate({
        search: (prev: Record<string, unknown>) => ({ ...prev, step: expectedName }),
        replace: true,
      })
    }
    setCurrentStep(idx)
  }, [searchStep, resolveStepIndex, navigate])

  // Persist form data to sessionStorage
  const persistData = useCallback(
    (data: TFormData, stepName: string) => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ step: stepName, data }),
        )
      } catch {
        // storage full — ignore
      }
    },
    [storageKey],
  )

  const setFormData = useCallback(
    (partial: Partial<TFormData>) => {
      setFormDataState((prev) => {
        const next = { ...prev, ...partial }
        persistData(next, stepsRef.current[currentStep])
        return next
      })
    },
    [currentStep, persistData],
  )

  const goToStep = useCallback(
    (stepName: TSteps[number]) => {
      const idx = stepsRef.current.indexOf(stepName)
      if (idx < 0) return
      setCurrentStep(idx)
      persistData(formData, stepName)
      navigate({
        search: (prev: Record<string, unknown>) => ({ ...prev, step: stepName }),
        replace: true,
      })
    },
    [formData, navigate, persistData],
  )

  const goNext = useCallback(() => {
    if (currentStep < stepsRef.current.length - 1) {
      goToStep(stepsRef.current[currentStep + 1])
    }
  }, [currentStep, goToStep])

  const goBack = useCallback(() => {
    if (currentStep > 0) {
      goToStep(stepsRef.current[currentStep - 1])
    }
  }, [currentStep, goToStep])

  const clearPersistedData = useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      // ignore
    }
  }, [storageKey])

  return {
    currentStep,
    currentStepName: steps[currentStep] as TSteps[number],
    totalSteps: steps.length,
    goNext,
    goBack,
    goToStep,
    formData,
    setFormData,
    clearPersistedData,
    isFirstStep: currentStep === 0,
    isLastStep: currentStep === steps.length - 1,
  }
}
