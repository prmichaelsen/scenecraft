import { useToast as useToastBase } from '@prmichaelsen/pretty-toasts/standalone'

const SUCCESS_DURATION = 2000

export function useToast() {
  const toast = useToastBase()
  return {
    ...toast,
    success: (opts: Parameters<typeof toast.success>[0]) =>
      toast.success({ duration: SUCCESS_DURATION, ...opts }),
  }
}
