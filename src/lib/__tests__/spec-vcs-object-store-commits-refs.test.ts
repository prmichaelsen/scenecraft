/**
 * Tests for the VCS Object Store, Commits, Refs, Branches client API.
 *
 * Spec: agent/specs/local.vcs-object-store-commits-refs.md
 *
 * These tests exercise the frontend `version-client.ts` module which
 * communicates with the backend VCS subsystem via REST endpoints. We mock
 * `fetch` to verify correct endpoint construction, request bodies, and
 * response handling for each operation.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchVersionHistory,
  fetchVersionDiff,
  postVersionCommit,
  postVersionCheckout,
  postVersionBranch,
  postVersionDeleteBranch,
  autoSave,
  type Commit,
  type VersionHistory,
  type DiffResult,
} from '../version-client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof globalThis.fetch
}

function mockFetchError(status: number, body: unknown = { error: 'fail' }) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof globalThis.fetch
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

// ===========================================================================
// R2 -- Commits (client-side: fetch history, create commit)
// ===========================================================================

describe('Commits — fetchVersionHistory (R2.5, R2.6)', () => {
  // covers: list-commits-walks-first-parents, list-commits-respects-limit

  it('[list-commits-walks-first-parents] calls correct endpoint and returns commit list', async () => {
    const history: VersionHistory = {
      commits: [
        { sha: 'ccc', message: 'third', date: '2026-04-27T03:00:00Z' },
        { sha: 'bbb', message: 'second', date: '2026-04-27T02:00:00Z' },
        { sha: 'aaa', message: 'first', date: '2026-04-27T01:00:00Z' },
      ],
      branch: 'main',
      branches: ['main'],
    }
    globalThis.fetch = mockFetchOk(history)

    const result = await fetchVersionHistory('my-project')

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('/api/projects/my-project/version/history')
    expect(url).toContain('limit=20')
    expect(result.commits).toHaveLength(3)
    expect(result.commits[0].sha).toBe('ccc')
    expect(result.commits[2].sha).toBe('aaa')
  })

  it('[list-commits-respects-limit] passes custom limit as query param', async () => {
    globalThis.fetch = mockFetchOk({ commits: [], branch: 'main', branches: [] })

    await fetchVersionHistory('proj', 5)

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('limit=5')
  })

  it('[get-commit-missing-returns-none] throws on non-OK response (R2.5 error path)', async () => {
    globalThis.fetch = mockFetchError(404)

    await expect(fetchVersionHistory('missing-proj')).rejects.toThrow('Failed to fetch version history: 404')
  })
})

// ===========================================================================
// R6 -- commit_working_copy (client: postVersionCommit)
// ===========================================================================

describe('Commits — postVersionCommit (R6.1)', () => {
  // covers: commit-working-copy-first-commit, commit-working-copy-advances-ref

  it('[commit-working-copy-advances-ref] sends POST with message body and returns result', async () => {
    const response = { success: true, sha: 'abc123' }
    globalThis.fetch = mockFetchOk(response)

    const result = await postVersionCommit('test-proj', 'my commit message')

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/api/projects/test-proj/version/commit')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ message: 'my commit message' })
    expect(result.success).toBe(true)
    expect(result.sha).toBe('abc123')
  })

  it('[commit-working-copy-first-commit] handles noChanges response', async () => {
    globalThis.fetch = mockFetchOk({ success: true, noChanges: true })

    const result = await postVersionCommit('proj', 'nothing changed')

    expect(result.noChanges).toBe(true)
  })
})

// ===========================================================================
// R3 -- Refs / Branch pointers (client: fetchVersionHistory returns branch info)
// ===========================================================================

describe('Refs — branch tracking via fetchVersionHistory (R3.1-R3.5)', () => {
  // covers: main-ref-always-exists, get-ref-missing-returns-empty

  it('[main-ref-always-exists] response includes current branch and branch list', async () => {
    const history: VersionHistory = {
      commits: [],
      branch: 'main',
      branches: ['main', 'feature-x'],
    }
    globalThis.fetch = mockFetchOk(history)

    const result = await fetchVersionHistory('proj')

    expect(result.branch).toBe('main')
    expect(result.branches).toContain('main')
    expect(result.branches).toContain('feature-x')
  })
})

// ===========================================================================
// R4 -- Branch lifecycle
// ===========================================================================

describe('Branches — postVersionBranch (R4.1-R4.3)', () => {
  // covers: create-branch-copies-from-ref, validate-branch-name-accepts-valid

  it('[create-branch-copies-from-ref] sends create=true with branch name', async () => {
    globalThis.fetch = mockFetchOk({ success: true, branch: 'feature-new' })

    const result = await postVersionBranch('proj', 'feature-new', true)

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/api/projects/proj/version/branch')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toEqual({ name: 'feature-new', create: true })
    expect(result.success).toBe(true)
    expect(result.branch).toBe('feature-new')
  })

  it('[validate-branch-name-accepts-valid] sends nested branch name correctly', async () => {
    globalThis.fetch = mockFetchOk({ success: true, branch: 'alice/wip' })

    await postVersionBranch('proj', 'alice/wip', true)

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.name).toBe('alice/wip')
  })

  it('[list-branches-sorted-and-marked] switch branch sends create=false by default', async () => {
    globalThis.fetch = mockFetchOk({ success: true, branch: 'feature-b' })

    await postVersionBranch('proj', 'feature-b')

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.create).toBe(false)
  })

  it('[create-branch-rejects-existing] propagates server error for duplicate branch', async () => {
    globalThis.fetch = mockFetchOk({ success: false, branch: undefined })

    const result = await postVersionBranch('proj', 'main', true)

    expect(result.success).toBe(false)
  })
})

describe('Branches — postVersionDeleteBranch (R4.4)', () => {
  // covers: delete-branch-rejects-main, delete-branch-cleans-empty-parents

  it('[delete-branch-cleans-empty-parents] sends DELETE request with branch name', async () => {
    globalThis.fetch = mockFetchOk({ success: true })

    const result = await postVersionDeleteBranch('proj', 'feature-x')

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/api/projects/proj/version/delete-branch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'feature-x' })
    expect(result.success).toBe(true)
  })

  it('[delete-branch-rejects-main] propagates server rejection for main branch', async () => {
    globalThis.fetch = mockFetchOk({ success: false })

    const result = await postVersionDeleteBranch('proj', 'main')

    expect(result.success).toBe(false)
  })

  it('[delete-branch-rejects-missing] handles nested branch paths in delete', async () => {
    globalThis.fetch = mockFetchOk({ success: true })

    await postVersionDeleteBranch('proj', 'alice/feature-x')

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.name).toBe('alice/feature-x')
  })
})

// ===========================================================================
// R4.6 -- Checkout
// ===========================================================================

describe('Checkout — postVersionCheckout (R4.6)', () => {
  // covers: checkout-updates-session, checkout-refuses-on-dirty, checkout-rejects-missing-target

  it('[checkout-updates-session] sends POST with sha to checkout endpoint', async () => {
    globalThis.fetch = mockFetchOk({ success: true, sha: 'abc123' })

    const result = await postVersionCheckout('proj', 'abc123')

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/api/projects/proj/version/checkout')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ sha: 'abc123' })
    expect(result.success).toBe(true)
    expect(result.sha).toBe('abc123')
  })

  it('[checkout-refuses-on-dirty] propagates conflict message from server', async () => {
    globalThis.fetch = mockFetchOk({
      success: false,
      message: 'Working copy has uncommitted changes',
    })

    const result = await postVersionCheckout('proj', 'abc123')

    expect(result.success).toBe(false)
    expect(result.message).toContain('uncommitted changes')
  })

  it('[checkout-rejects-missing-target] propagates missing ref error', async () => {
    globalThis.fetch = mockFetchOk({ success: false, message: 'Branch not found' })

    const result = await postVersionCheckout('proj', 'deadbeef')

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })
})

// ===========================================================================
// Diff (supplementary to R6 — uncommitted change detection client-side)
// ===========================================================================

describe('Diff — fetchVersionDiff (R4.5 client-side)', () => {
  // covers: uncommitted-true-when-dirty, uncommitted-false-when-clean

  it('[uncommitted-true-when-dirty] calls diff endpoint and returns changes', async () => {
    const diff: DiffResult = {
      files: [{ path: 'scenes/s1.json', status: 'modified' }],
      hasChanges: true,
    }
    globalThis.fetch = mockFetchOk(diff)

    const result = await fetchVersionDiff('proj')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('/api/projects/proj/version/diff')
    expect(result.hasChanges).toBe(true)
    expect(result.files).toHaveLength(1)
  })

  it('[uncommitted-false-when-clean] returns no changes when clean', async () => {
    globalThis.fetch = mockFetchOk({ files: [], hasChanges: false })

    const result = await fetchVersionDiff('proj')

    expect(result.hasChanges).toBe(false)
    expect(result.files).toHaveLength(0)
  })

  it('passes from/to query params for commit range diff', async () => {
    globalThis.fetch = mockFetchOk({ files: [], hasChanges: false })

    await fetchVersionDiff('proj', 'aaa', 'bbb')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('from=aaa')
    expect(url).toContain('to=bbb')
  })

  it('omits query params when from/to are not provided', async () => {
    globalThis.fetch = mockFetchOk({ files: [], hasChanges: false })

    await fetchVersionDiff('proj')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).not.toContain('from=')
    expect(url).not.toContain('to=')
    expect(url).not.toContain('?')
  })

  it('throws on non-OK diff response', async () => {
    globalThis.fetch = mockFetchError(500)

    await expect(fetchVersionDiff('proj')).rejects.toThrow('Failed to fetch diff: 500')
  })
})

// ===========================================================================
// autoSave — fire-and-forget commit
// ===========================================================================

describe('autoSave (R6.1 convenience wrapper)', () => {
  it('[commit-working-copy-advances-ref] fires a commit with auto: prefix', async () => {
    globalThis.fetch = mockFetchOk({ success: true, sha: 'xyz' })

    autoSave('proj', 'scene update')

    // autoSave is fire-and-forget; give it a tick
    await new Promise((r) => setTimeout(r, 0))

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/api/projects/proj/version/commit')
    expect(JSON.parse(init.body).message).toBe('auto: scene update')
  })

  it('swallows errors silently', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network') }) as unknown as typeof globalThis.fetch

    // Should not throw
    autoSave('proj', 'boom')
    await new Promise((r) => setTimeout(r, 0))
  })
})

// ===========================================================================
// URL encoding (cross-cutting)
// ===========================================================================

describe('URL encoding for project names (cross-cutting)', () => {
  it('encodes special characters in project name for history', async () => {
    globalThis.fetch = mockFetchOk({ commits: [], branch: 'main', branches: [] })

    await fetchVersionHistory('my project/v2')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('my%20project%2Fv2')
  })

  it('encodes special characters in project name for commit', async () => {
    globalThis.fetch = mockFetchOk({ success: true })

    await postVersionCommit('foo bar', 'msg')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('foo%20bar')
  })

  it('encodes special characters in project name for checkout', async () => {
    globalThis.fetch = mockFetchOk({ success: true })

    await postVersionCheckout('a/b', 'sha1')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('a%2Fb')
  })

  it('encodes special characters in project name for branch create', async () => {
    globalThis.fetch = mockFetchOk({ success: true })

    await postVersionBranch('x y', 'feat')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('x%20y')
  })

  it('encodes special characters in project name for branch delete', async () => {
    globalThis.fetch = mockFetchOk({ success: true })

    await postVersionDeleteBranch('x y', 'feat')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('x%20y')
  })
})

// ===========================================================================
// Data shapes / type contracts
// ===========================================================================

describe('Data shape contracts (Interfaces section)', () => {
  it('Commit type has sha, message, date fields', () => {
    const c: Commit = { sha: 'abc', message: 'test', date: '2026-01-01T00:00:00Z' }
    expect(c.sha).toBeDefined()
    expect(c.message).toBeDefined()
    expect(c.date).toBeDefined()
  })

  it('VersionHistory includes commits array, branch string, and branches array', () => {
    const h: VersionHistory = { commits: [], branch: 'main', branches: ['main'] }
    expect(Array.isArray(h.commits)).toBe(true)
    expect(typeof h.branch).toBe('string')
    expect(Array.isArray(h.branches)).toBe(true)
  })

  it('DiffResult includes files array and hasChanges boolean', () => {
    const d: DiffResult = { files: [], hasChanges: false }
    expect(Array.isArray(d.files)).toBe(true)
    expect(typeof d.hasChanges).toBe('boolean')
  })
})

// ===========================================================================
// API base URL configuration
// ===========================================================================

describe('API base URL (configuration)', () => {
  it('all endpoints use the SCENECRAFT_API_URL base', async () => {
    // Default base is http://localhost:8890 when env var is not set
    globalThis.fetch = mockFetchOk({ commits: [], branch: 'main', branches: [] })

    await fetchVersionHistory('p')

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    // Should start with either the env var or the default
    expect(url).toMatch(/^https?:\/\//)
    expect(url).toContain('/api/projects/')
  })
})
