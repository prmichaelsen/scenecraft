import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/demos/')({
  component: DemosIndex,
})

const demos = [
  { path: '/demos/panels', title: 'Panel Layout', description: 'Split-tree panel layout with tabs, drag-and-drop, collapse, and resize' },
]

function DemosIndex() {
  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <h1 className="text-2xl font-bold mb-2">Component Demos</h1>
      <p className="text-gray-500 text-sm mb-8">Isolated testbeds for building and iterating on components.</p>
      <div className="flex flex-col gap-3">
        {demos.map((d) => (
          <Link
            key={d.path}
            to={d.path}
            className="block p-4 bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-600 transition-colors"
          >
            <div className="text-sm font-medium text-gray-200">{d.title}</div>
            <div className="text-xs text-gray-500 mt-1">{d.description}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
