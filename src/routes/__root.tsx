import { HeadContent, Scripts, createRootRoute, Outlet } from '@tanstack/react-router'
import { ToastProvider, StandaloneToastContainer } from '@prmichaelsen/pretty-toasts/standalone'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  component: RootLayout,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'SceneCraft' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/site.webmanifest' },
    ],
  }),
})

function RootLayout() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <ToastProvider>
          {children}
          <div className="relative z-[60]">
            <StandaloneToastContainer />
          </div>
        </ToastProvider>
        <Scripts />
      </body>
    </html>
  )
}
