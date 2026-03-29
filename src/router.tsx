import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export const getRouter = () => {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 300_000, // 5 minutes — loader re-runs on router.invalidate() after mutations
  })
}
