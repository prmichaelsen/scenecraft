import { useToast } from './useToast'

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
      const requestId = `req_${Date.now().toString(36)}`
      const stack = err instanceof Error ? err.stack || err.message : String(err)
      error({
        title: options.error.title,
        message: `${options.error.message ?? (err instanceof Error ? err.message : 'Unknown error')} [${requestId}]`,
      })
      if (typeof window !== 'undefined') {
        ;(window as unknown as Record<string, unknown>).__lastError = { requestId, stack, message: options.error.message, timestamp: new Date().toISOString() }
      }
      return undefined
    }
  }

  return { withToast }
}
