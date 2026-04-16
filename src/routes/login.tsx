import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/login')({
  component: LoginPage,
  head: () => ({ meta: [{ title: 'Login — SceneCraft' }] }),
})

function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 p-6">
      <div className="max-w-lg w-full bg-gray-900 border border-gray-800 rounded-lg p-8 shadow-xl">
        <h1 className="text-2xl font-semibold text-gray-100 mb-2">SceneCraft</h1>
        <p className="text-gray-400 text-sm mb-6">Sign in with your SSH identity.</p>

        <div className="bg-gray-950 border border-gray-800 rounded p-4 mb-4">
          <p className="text-gray-300 text-sm mb-3">SSH onto the scenecraft host and run:</p>
          <pre className="bg-black text-green-400 font-mono text-sm p-3 rounded overflow-x-auto">
            <code>scenecraft vcs token</code>
          </pre>
          <p className="text-gray-400 text-xs mt-3">
            The command prints a login URL. Open it in this browser to authenticate.
            The link is single-use and expires in 5 minutes.
          </p>
        </div>

        <div className="bg-gray-950 border border-gray-800 rounded p-4 mb-4">
          <p className="text-gray-300 text-sm font-semibold mb-2">Remote server?</p>
          <p className="text-gray-400 text-xs mb-2">
            Forward the scenecraft port through SSH, then re-run the command with your local tunnel address:
          </p>
          <pre className="bg-black text-green-400 font-mono text-xs p-3 rounded overflow-x-auto">
            <code>{'ssh -L 8890:localhost:8890 user@host\nscenecraft vcs token --host localhost:8890'}</code>
          </pre>
        </div>

        <div className="text-gray-500 text-xs">
          Not registered? Ask an admin to add your SSH public key:
          <code className="ml-1 font-mono text-gray-400">scenecraft vcs user add &lt;name&gt; --pubkey ~/.ssh/id_ed25519.pub</code>
        </div>

        <div className="mt-6 text-center">
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">← Back to home</Link>
        </div>
      </div>
    </div>
  )
}
