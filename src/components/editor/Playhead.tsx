type PlayheadProps = {
  currentTime: number
  pxPerSec: number
}

export function Playhead({ currentTime, pxPerSec }: PlayheadProps) {
  const x = currentTime * pxPerSec

  return (
    <div
      className="absolute top-0 h-full w-px bg-red-500 pointer-events-none z-10"
      style={{ left: x }}
    >
      {/* Playhead cap */}
      <div className="absolute -top-0 -left-1.5 w-3 h-3 bg-red-500 rounded-full" />
    </div>
  )
}
