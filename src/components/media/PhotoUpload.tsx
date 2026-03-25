import { useState, useRef, useCallback } from 'react'

interface UploadingPhoto {
  id: string
  file: File
  preview: string
  progress: number
  phase: 'pending' | 'transfer' | 'upload' | 'complete' | 'error'
  error?: string
}

/** Generic upload service interface — inject your implementation as a prop */
export interface UploadService {
  getSignedUrl(file: File, contextId: string): Promise<{ uploadUrl: string; filePath: string }>
  confirmUpload(filePath: string, metadata: { filename: string; contentType: string; sizeBytes: number }): Promise<void>
}

interface PhotoUploadProps {
  contextId: string
  uploadService: UploadService
  onUploadComplete: () => void
  disabled?: boolean
  /** Allowed MIME types (default: image/jpeg, image/png) */
  allowedTypes?: string[]
  /** Max file size in bytes (default: 10MB) */
  maxFileSize?: number
}

const DEFAULT_ALLOWED_TYPES = ['image/jpeg', 'image/png']
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export function PhotoUpload({
  contextId,
  uploadService,
  onUploadComplete,
  disabled,
  allowedTypes = DEFAULT_ALLOWED_TYPES,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
}: PhotoUploadProps) {
  const [uploads, setUploads] = useState<UploadingPhoto[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return

      const newUploads: UploadingPhoto[] = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]

        // Validate type
        if (!allowedTypes.includes(file.type)) {
          newUploads.push({
            id: crypto.randomUUID(),
            file,
            preview: '',
            progress: 0,
            phase: 'error',
            error: `Invalid file type: ${file.type}. Allowed: ${allowedTypes.join(', ')}.`,
          })
          continue
        }

        // Validate size
        if (file.size > maxFileSize) {
          newUploads.push({
            id: crypto.randomUUID(),
            file,
            preview: '',
            progress: 0,
            phase: 'error',
            error: `File too large. Maximum size is ${Math.round(maxFileSize / (1024 * 1024))}MB.`,
          })
          continue
        }

        const preview = URL.createObjectURL(file)
        newUploads.push({
          id: crypto.randomUUID(),
          file,
          preview,
          progress: 0,
          phase: 'pending',
        })
      }

      setUploads((prev) => [...prev, ...newUploads])

      // Upload each valid file
      for (const upload of newUploads) {
        if (upload.phase === 'error') continue
        await uploadFile(upload)
      }
    },
    [contextId, allowedTypes, maxFileSize]
  )

  const uploadFile = async (upload: UploadingPhoto) => {
    try {
      // Step 1: Get signed upload URL from server
      setUploads((prev) =>
        prev.map((u) => (u.id === upload.id ? { ...u, phase: 'transfer', progress: 5 } : u))
      )

      const { uploadUrl, filePath } = await uploadService.getSignedUrl(upload.file, contextId)

      // Step 2: Upload directly to storage using signed URL with progress via XMLHttpRequest
      setUploads((prev) =>
        prev.map((u) => (u.id === upload.id ? { ...u, phase: 'upload', progress: 10 } : u))
      )

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            // Map upload progress to 10-90% range
            const pct = Math.round(10 + (e.loaded / e.total) * 80)
            setUploads((prev) =>
              prev.map((u) =>
                u.id === upload.id ? { ...u, progress: pct, phase: 'upload' } : u
              )
            )
          }
        })

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve()
          } else {
            reject(new Error(`Upload failed: ${xhr.status}`))
          }
        })

        xhr.addEventListener('error', () => reject(new Error('Upload failed')))
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')))

        xhr.open('PUT', uploadUrl)
        xhr.setRequestHeader('Content-Type', upload.file.type)
        xhr.send(upload.file)
      })

      // Step 3: Confirm upload with our server
      setUploads((prev) =>
        prev.map((u) => (u.id === upload.id ? { ...u, progress: 95 } : u))
      )

      await uploadService.confirmUpload(filePath, {
        filename: upload.file.name,
        contentType: upload.file.type,
        sizeBytes: upload.file.size,
      })

      // Success
      setUploads((prev) =>
        prev.map((u) =>
          u.id === upload.id ? { ...u, phase: 'complete', progress: 100 } : u
        )
      )

      onUploadComplete()
    } catch (err) {
      setUploads((prev) =>
        prev.map((u) =>
          u.id === upload.id
            ? {
                ...u,
                phase: 'error',
                error: err instanceof Error ? err.message : 'Upload failed',
              }
            : u
        )
      )
    }
  }

  const retryUpload = (uploadId: string) => {
    const upload = uploads.find((u) => u.id === uploadId)
    if (!upload) return

    setUploads((prev) =>
      prev.map((u) =>
        u.id === uploadId ? { ...u, phase: 'pending', progress: 0, error: undefined } : u
      )
    )

    uploadFile(upload)
  }

  const removeUpload = (uploadId: string) => {
    setUploads((prev) => {
      const upload = prev.find((u) => u.id === uploadId)
      if (upload?.preview) {
        URL.revokeObjectURL(upload.preview)
      }
      return prev.filter((u) => u.id !== uploadId)
    })
  }

  const activeUploads = uploads.filter((u) => u.phase !== 'complete')
  const isUploading = uploads.some(
    (u) => u.phase === 'transfer' || u.phase === 'upload' || u.phase === 'pending'
  )

  const acceptStr = allowedTypes.join(',')

  return (
    <div className="space-y-4">
      {/* Upload buttons */}
      <div className="flex gap-3">
        {/* Camera capture (mobile) */}
        <button
          type="button"
          onClick={() => cameraInputRef.current?.click()}
          disabled={disabled || isUploading}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-bg-card border border-border-default rounded-xl text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z"
            />
          </svg>
          <span className="text-sm font-medium">Take Photo</span>
        </button>
        <input
          ref={cameraInputRef}
          type="file"
          accept={acceptStr}
          capture="environment"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

        {/* File picker */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isUploading}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-bg-card border border-border-default rounded-xl text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          <span className="text-sm font-medium">Browse Files</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptStr}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* Upload previews & progress */}
      {activeUploads.length > 0 && (
        <div className="space-y-3">
          {activeUploads.map((upload) => (
            <div
              key={upload.id}
              className="flex items-center gap-3 bg-bg-card border border-border-default rounded-xl p-3"
            >
              {/* Thumbnail */}
              {upload.preview ? (
                <img
                  src={upload.preview}
                  alt={upload.file.name}
                  className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-14 h-14 rounded-lg bg-bg-elevated flex items-center justify-center flex-shrink-0">
                  <svg className="w-6 h-6 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                  </svg>
                </div>
              )}

              {/* Info & progress */}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary truncate">
                  {upload.file.name}
                </div>
                <div className="text-xs text-text-muted">
                  {formatBytes(upload.file.size)}
                </div>

                {upload.phase === 'error' ? (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-red-500">{upload.error}</span>
                    <button
                      type="button"
                      onClick={() => retryUpload(upload.id)}
                      className="text-xs text-primary hover:text-bridge font-medium"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="mt-1.5">
                    <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300 rounded-full"
                        style={{ width: `${upload.progress}%` }}
                      />
                    </div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {upload.progress}%
                      {upload.phase === 'transfer'
                        ? ' - Transferring...'
                        : upload.phase === 'upload'
                          ? ' - Uploading...'
                          : upload.phase === 'pending'
                            ? ' - Preparing...'
                            : ''}
                    </div>
                  </div>
                )}
              </div>

              {/* Remove button */}
              {(upload.phase === 'error' || upload.phase === 'complete') && (
                <button
                  type="button"
                  onClick={() => removeUpload(upload.id)}
                  className="p-1 text-text-muted hover:text-text-primary flex-shrink-0"
                  aria-label="Remove"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
