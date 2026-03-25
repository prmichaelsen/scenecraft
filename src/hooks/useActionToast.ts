import { useToast } from '@prmichaelsen/pretty-toasts/standalone'

interface ToastConfig {
  title: string
  message?: string
}

interface WithToastOptions {
  success: ToastConfig
  error: ToastConfig
}

export function useActionToast() {
  const { success, error } = useToast()

  async function withToast<T>(
    action: () => Promise<T>,
    options: WithToastOptions,
  ): Promise<T | undefined> {
    try {
      const result = await action()
      success({ title: options.success.title, message: options.success.message })
      return result
    } catch (err) {
      error({
        title: options.error.title,
        message: options.error.message ?? (err instanceof Error ? err.message : 'Unknown error'),
      })
      return undefined
    }
  }

  return { withToast }
}
