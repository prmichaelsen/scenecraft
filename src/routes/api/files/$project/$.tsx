import { createFileRoute } from '@tanstack/react-router'
import { createReadStream, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { Readable } from 'node:stream'

const BEATLAB_WORK_DIR = process.env.BEATLAB_WORK_DIR
  || join(process.env.HOME || '', '.acp/projects/davinci-beat-lab/.beatlab_work')

const MIME_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.md': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.txt': 'text/plain',
}

export const Route = createFileRoute('/api/files/$project/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const project = decodeURIComponent(params.project)
        const filePath = (params as Record<string, string>)['_splat'] || ''

        const resolved = join(BEATLAB_WORK_DIR, project, filePath)

        // Prevent path traversal
        if (!resolved.startsWith(BEATLAB_WORK_DIR)) {
          return new Response('Forbidden', { status: 403 })
        }

        let fileStat
        try {
          fileStat = statSync(resolved)
        } catch {
          return new Response('Not found', { status: 404 })
        }

        const ext = extname(resolved).toLowerCase()
        const contentType = MIME_TYPES[ext] || 'application/octet-stream'
        const fileSize = fileStat.size

        // Handle range requests for audio/video streaming
        const range = request.headers.get('range')
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-')
          const start = parseInt(parts[0], 10)
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
          const chunkSize = end - start + 1

          const stream = createReadStream(resolved, { start, end })
          const webStream = Readable.toWeb(stream) as ReadableStream

          return new Response(webStream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': contentType,
            },
          })
        }

        const stream = createReadStream(resolved)
        const webStream = Readable.toWeb(stream) as ReadableStream

        return new Response(webStream, {
          headers: {
            'Content-Length': String(fileSize),
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
          },
        })
      },
    },
  },
})
