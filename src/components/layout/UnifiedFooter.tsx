export const FOOTER_HEIGHT_CLASS = 'pb-24'

interface UnifiedFooterProps {
  children: React.ReactNode
}

export function UnifiedFooter({ children }: UnifiedFooterProps) {
  return (
    <footer
      className="fixed bottom-0 left-0 right-0 z-50 bg-bg-page border-t border-border-default px-4 py-4"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      {children}
    </footer>
  )
}
