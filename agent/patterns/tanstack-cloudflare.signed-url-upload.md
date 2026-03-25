# Signed URL Upload

**Category**: Architecture
**Applicable To**: File uploads (photos, documents, media) where the client uploads directly to cloud storage via a pre-signed URL, bypassing the application server for large payloads
**Status**: Stable

---

## Overview

The Signed URL Upload pattern implements a two-phase upload flow: (1) the client requests a signed upload URL from the API, (2) the client uploads the file directly to storage using that URL with XHR progress tracking, and (3) the client confirms the upload by sending metadata back to the API. This avoids streaming large files through the application server, enables real-time progress bars, and supports retry logic for unreliable connections. For large files, a Durable Object can manage chunked uploads with resumability.

---

## When to Use This Pattern

| Scenario | Use Signed URL? |
|---|---|
| User-uploaded photos/media (> 1 MB) | Yes |
| Profile avatar upload with progress bar | Yes |
| Bulk file uploads with retry needs | Yes |
| Small JSON payloads or text form data | No — POST directly to API |
| Server-generated files (exports, reports) | No — server writes directly to storage |

---

## Core Principles

1. **Two-Phase Flow**: Request signed URL -> upload to storage -> confirm metadata. The API never handles the file bytes.
2. **Progress Tracking**: XHR `upload.onprogress` provides real-time byte-level progress for UI feedback
3. **Retry Logic**: Failed uploads can retry using the same signed URL (within its expiry window) without re-requesting
4. **Camera Capture Support**: On mobile, `accept="image/*"` with `capture="environment"` enables direct camera capture
5. **Configurable MIME Types**: The signed URL request specifies allowed content types; storage rejects mismatched uploads

---

## Implementation

### Structure

```
components/media/
└── PhotoUpload.tsx           # Upload UI with preview, progress bar, retry
routes/api/
└── upload/
    ├── request-url.tsx       # GET: generate signed upload URL
    └── confirm.tsx           # POST: store metadata after successful upload
durable-objects/
└── upload-manager.ts         # (Optional) chunked upload coordination
```

### Phase 1: Request Signed URL

**File**: `routes/api/upload/request-url.tsx`

```typescript
// API route handler
export async function loader({ request, context }: LoaderFunctionArgs) {
  const user = await requireAuth(request, context)
  const url = new URL(request.url)
  const contentType = url.searchParams.get('contentType') || 'image/jpeg'
  const filename = url.searchParams.get('filename') || `${crypto.randomUUID()}.jpg`

  // Generate signed URL (R2, GCS, or S3)
  const bucket = context.cloudflare.env.MEDIA_BUCKET
  const key = `uploads/${user.uid}/${Date.now()}-${filename}`

  // R2 example: generate presigned PUT URL
  const signedUrl = await generatePresignedUrl(bucket, key, {
    contentType,
    expiresIn: 3600, // 1 hour
  })

  return json({
    signedUrl,
    key,
    expiresAt: Date.now() + 3600_000,
  })
}
```

### Phase 2: Client Upload with Progress

**File**: `components/media/PhotoUpload.tsx`

```typescript
interface PhotoUploadProps {
  onUploadComplete: (result: { key: string; url: string }) => void
  accept?: string           // default: 'image/*'
  maxSizeMB?: number        // default: 10
  enableCamera?: boolean    // default: true on mobile
}

interface UploadState {
  status: 'idle' | 'requesting' | 'uploading' | 'confirming' | 'complete' | 'error'
  progress: number         // 0-100
  error?: string
  previewUrl?: string
}
```

**XHR Upload with Progress**:

```typescript
function uploadToSignedUrl(
  signedUrl: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', signedUrl)
    xhr.setRequestHeader('Content-Type', file.type)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed: ${xhr.status}`))
    }

    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.send(file)
  })
}
```

**Full Upload Flow**:

```typescript
const handleFileSelect = async (file: File) => {
  if (file.size > maxSizeMB * 1024 * 1024) {
    setState({ status: 'error', progress: 0, error: `File exceeds ${maxSizeMB}MB limit` })
    return
  }

  // Preview
  setState({ status: 'requesting', progress: 0, previewUrl: URL.createObjectURL(file) })

  try {
    // Phase 1: Get signed URL
    const { signedUrl, key } = await fetch(
      `/api/upload/request-url?contentType=${file.type}&filename=${file.name}`
    ).then(r => r.json())

    // Phase 2: Upload to storage
    setState(prev => ({ ...prev, status: 'uploading' }))
    await uploadToSignedUrl(signedUrl, file, (progress) => {
      setState(prev => ({ ...prev, progress }))
    })

    // Phase 3: Confirm metadata
    setState(prev => ({ ...prev, status: 'confirming', progress: 100 }))
    const result = await fetch('/api/upload/confirm', {
      method: 'POST',
      body: JSON.stringify({ key, contentType: file.type, size: file.size }),
    }).then(r => r.json())

    setState({ status: 'complete', progress: 100, previewUrl: result.url })
    onUploadComplete(result)
  } catch (err) {
    setState(prev => ({
      ...prev,
      status: 'error',
      error: err instanceof Error ? err.message : 'Upload failed',
    }))
  }
}
```

### Phase 3: Confirm Metadata

**File**: `routes/api/upload/confirm.tsx`

```typescript
export async function action({ request, context }: ActionFunctionArgs) {
  const user = await requireAuth(request, context)
  const { key, contentType, size } = await request.json()

  // Verify the object exists in storage
  const bucket = context.cloudflare.env.MEDIA_BUCKET
  const head = await bucket.head(key)
  if (!head) {
    return json({ error: 'Upload not found' }, { status: 404 })
  }

  // Store metadata in D1
  await context.cloudflare.env.DB.prepare(
    'INSERT INTO uploads (user_id, storage_key, content_type, size, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(user.uid, key, contentType, size, Date.now()).run()

  const publicUrl = `${context.cloudflare.env.CDN_BASE}/${key}`
  return json({ key, url: publicUrl })
}
```

---

### Retry Logic

```typescript
const MAX_RETRIES = 3

async function uploadWithRetry(signedUrl: string, file: File, onProgress: (n: number) => void) {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await uploadToSignedUrl(signedUrl, file, onProgress)
      return // Success
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Unknown error')
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))) // Backoff
      }
    }
  }

  throw lastError
}
```

---

### Chunked Upload via Durable Object (Large Files)

**File**: `durable-objects/upload-manager.ts`

For files > 50 MB, the Durable Object coordinates chunked uploads:

```typescript
export class UploadManager implements DurableObject {
  private chunks: Map<number, boolean> = new Map()
  private totalChunks: number = 0

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/init') {
      const { totalChunks, fileKey } = await request.json()
      this.totalChunks = totalChunks
      // Generate signed URLs for each chunk
      const urls = await Promise.all(
        Array.from({ length: totalChunks }, (_, i) =>
          generatePresignedUrl(bucket, `${fileKey}/chunk-${i}`)
        )
      )
      return json({ chunkUrls: urls })
    }

    if (url.pathname === '/complete-chunk') {
      const { chunkIndex } = await request.json()
      this.chunks.set(chunkIndex, true)
      const allComplete = this.chunks.size === this.totalChunks
      return json({ allComplete, completed: this.chunks.size, total: this.totalChunks })
    }

    return new Response('Not found', { status: 404 })
  }
}
```

---

### Camera Capture (Mobile)

```typescript
<input
  type="file"
  accept={accept}
  capture={enableCamera ? 'environment' : undefined}
  onChange={(e) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
  }}
  className="hidden"
  ref={fileInputRef}
/>

<button onClick={() => fileInputRef.current?.click()}>
  <Camera className="w-5 h-5" />
  Upload Photo
</button>
```

---

## Anti-Patterns

### Streaming File Through the Application Server

```typescript
// Bad: App server buffers entire file — memory pressure, slow
export async function action({ request }) {
  const formData = await request.formData()
  const file = formData.get('file') as File
  const buffer = await file.arrayBuffer()
  await bucket.put(key, buffer)  // Server handles all bytes
}

// Good: Client uploads directly to storage via signed URL
const { signedUrl } = await fetch('/api/upload/request-url').then(r => r.json())
await uploadToSignedUrl(signedUrl, file, onProgress)
```

### Using fetch() Instead of XHR for Uploads

```typescript
// Bad: fetch() does not support upload progress events
await fetch(signedUrl, { method: 'PUT', body: file })
// No way to track upload progress!

// Good: XHR provides upload.onprogress
const xhr = new XMLHttpRequest()
xhr.upload.onprogress = (e) => { /* progress tracking */ }
```

### Not Validating File Size Before Upload

```typescript
// Bad: User selects 500MB file, gets signed URL, upload fails at storage limit
const { signedUrl } = await requestSignedUrl(file)
await upload(signedUrl, file)

// Good: Check size client-side before requesting signed URL
if (file.size > maxSizeMB * 1024 * 1024) {
  setError(`File exceeds ${maxSizeMB}MB limit`)
  return
}
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Upload method | XHR (not fetch) | Only XHR supports `upload.onprogress` for progress bars |
| Signed URL expiry | 1 hour | Long enough for retries on slow connections |
| Confirmation step | Separate POST after upload | Ensures metadata is only stored for successfully uploaded files |
| Retry strategy | Exponential backoff, 3 attempts | Handles transient network failures without overwhelming storage |
| Large file handling | Durable Object chunked upload | DO maintains chunk completion state across requests |
| File validation | Client-side size + type check | Fail fast before network requests |

---

## Checklist

- [ ] Signed URL generated server-side with appropriate expiry and content type
- [ ] Client validates file size and MIME type before requesting signed URL
- [ ] Upload uses XHR with `upload.onprogress` for progress tracking
- [ ] Retry logic with backoff for failed uploads
- [ ] Confirmation endpoint verifies object exists in storage before storing metadata
- [ ] Preview URL created via `URL.createObjectURL` for instant feedback
- [ ] Camera capture supported on mobile via `capture="environment"`
- [ ] Error states displayed with retry option in the UI
- [ ] Large files (> 50 MB) use chunked upload via Durable Object

---

## Related Patterns

- **[Firebase Storage](./tanstack-cloudflare.firebase-storage.md)**: Alternative storage backend; same signed-URL concept applies
- **[Durable Objects WebSocket](./tanstack-cloudflare.durable-objects-websocket.md)**: DO pattern used for chunked upload coordination

---

**Status**: Stable
**Last Updated**: 2026-03-15
**Contributors**: Community
